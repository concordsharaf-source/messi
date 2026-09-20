#!/usr/bin/env bash
# ============================================================================
#  run_schema_test.sh — ينفّذ schema.sql ثم fcm_and_rls.sql على القاعدة المحلية
#  ويطبع أي خطأ برقم السطر + تقرير الحالة النهائية.
# ============================================================================
PORT=5433
PSQL="/usr/bin/psql -h 127.0.0.1 -p $PORT -U postgres -d postgres -X"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

run_file() {
  local label="$1" file="$2"
  echo "──────────── $label ────────────"
  local out
  out=$($PSQL -v ON_ERROR_STOP=1 -q -f "$file" 2>&1)
  local errs
  errs=$(printf '%s\n' "$out" | grep -E "^psql:.*: (ERROR|FATAL|PANIC)")
  if [ -n "$errs" ]; then
    printf '%s\n' "$errs" | head -10
    echo "  ✖ فشل"
    return 1
  fi
  echo "  ✔ نجح"
  return 0
}

run_file "1) schema.sql"      "$REPO/sql/schema.sql";      S=$?
run_file "2) fcm_and_rls.sql" "$REPO/sql/fcm_and_rls.sql"; F=$?
run_file "3) auto_reply.sql"  "$REPO/sql/auto_reply.sql";  A=$?
run_file "4) admin_tools.sql" "$REPO/sql/admin_tools.sql"; T=$?
run_file "5) google_login.sql" "$REPO/sql/google_login.sql"; G=$?

echo
echo "──────────── الحالة النهائية ────────────"

$PSQL -q -c "
select c.relname as \"الجدول\",
       (select count(*) from pg_policies p
         where p.schemaname='public' and p.tablename=c.relname) as \"سياسات\",
       case when c.relrowsecurity then 'مفعّل' else '✖ معطّل' end as \"RLS\"
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r'
 order by 1;"

$PSQL -q -c "select id as \"bucket\", public as \"عام\", file_size_limit as \"حد_الحجم\" from storage.buckets order by 1;"

$PSQL -q -c "
select p.polname as \"سياسة storage\", case p.polcmd
         when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
         when 'd' then 'DELETE' else p.polcmd::text end as \"نوع\",
       array_to_string(p.polroles::regrole[], ',') as \"أدوار\"
  from pg_policy p join pg_class c on c.oid=p.polrelid
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='storage' and c.relname='objects' order by 1;"

$PSQL -q -c "
select t.tgname as \"Trigger على auth.users\"
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relnamespace::regnamespace::text='auth';"

$PSQL -q -t -c "select count(*)||' جدول في بث Realtime' from pg_publication_tables where pubname='supabase_realtime' and schemaname='public';"

$PSQL -q -c "select is_enabled as \"الرد التلقائي مُفعَّل\",
       jsonb_array_length(buttons) as \"عدد الأزرار\",
       greeting as \"نص الترحيب\"
  from public.auto_reply_settings;"

echo "schema.sql=$S fcm_and_rls.sql=$F auto_reply.sql=$A admin_tools.sql=$T"
