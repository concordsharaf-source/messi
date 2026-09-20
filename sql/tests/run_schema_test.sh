#!/usr/bin/env bash
# ============================================================================
#  run_schema_test.sh — يشغّل schema.sql ثم fcm_and_rls.sql على القاعدة المحلية
#  ويطبع كل خطأ برقم السطر حتى نصلحه قبل التنفيذ على Supabase.
# ============================================================================
PORT=5433
PSQL="/usr/bin/psql -h 127.0.0.1 -p $PORT -U postgres -d postgres -X"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

run_file() {
  local label="$1" file="$2"
  echo "──────────── $label ────────────"
  local out
  out=$($PSQL -v ON_ERROR_STOP=1 -q -f "$file" 2>&1)
  if [ -z "$out" ]; then
    echo "  ✔ نجح بلا أخطاء ولا تحذيرات"
    return 0
  fi
  # كل سطر خطأ في psql يبدأ بـ psql:file:line:
  if echo "$out" | grep -qE "^psql:.*: (ERROR|FATAL|PANIC)"; then
    echo "$out" | grep -E "^psql:|^LINE [0-9]+:|^\s+\^|^HINT:|^DETAIL:|^CONTEXT:" | head -30
    echo "  ✖ فشل"
    return 1
  else
    echo "$out" | sed 's/^/  /' | head -10
    echo "  ✔ نجح (مع تحذيرات أعلاه)"
    return 0
  fi
}

run_file "1) schema.sql"      "$REPO/sql/schema.sql";      S=$?
run_file "2) fcm_and_rls.sql" "$REPO/sql/fcm_and_rls.sql"; F=$?

echo
echo "──────────── الحالة النهائية ────────────"
$PSQL -q -c "
select table_name as \"الجدول\",
       (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=t.table_name) as \"عدد_السياسات\",
       t.rowsecurity as \"RLS\"
  from information_schema.tables t
 where t.table_schema='public' and t.table_type='BASE TABLE'
 order by 1;"

$PSQL -q -c "select id as \"bucket\", public as \"عام\", file_size_limit as \"حد_الحجم_بايت\" from storage.buckets order by 1;"

$PSQL -q -c "
select p.polname as \"سياسة_storage\", p.cmd as \"نوع\"
  from pg_policy p join pg_class c on c.oid=p.polrelid
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='storage' and c.relname='objects' order by 1;"

$PSQL -q -c "
select tgname as \"Trigger\", c.relnamespace::regnamespace::text as \"المخطط\"
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='users' and c.relnamespace::regnamespace::text='auth';"

$PSQL -q -c "
select count(*) as \"جداول_في_النشر\"
  from pg_publication_tables where pubname='supabase_realtime' and schemaname='public';"

echo "schema.sql=${S} fcm_and_rls.sql=${F}"
