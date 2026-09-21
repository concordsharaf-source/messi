#!/usr/bin/env bash
# ============================================================================
#  local_pg_up.sh — يشغّل PostgreSQL محلياً بمحاكاة بيئة Supabase
#  الاستخدام:  bash /home/user/sql_test/local_pg_up.sh
#  ثم:         bash /home/user/sql_test/run_schema_test.sh
#  ملاحظة: مجلد البيانات في /tmp (غير محفوظ) — يُعاد بناؤه في كل جلسة.
# ============================================================================
set -uo pipefail

PGBIN=/usr/lib/postgresql/17/bin
PGDATA=/tmp/pgdata
PGLOG=/tmp/pg.log
PORT=5433
PSQL="/usr/bin/psql -h 127.0.0.1 -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -X"
STUB="$(cd "$(dirname "$0")" && pwd)/00_supabase_stub.sql"

echo "── [1/4] التأكد من وجود PostgreSQL ──"
if ! [ -x "$PGBIN/postgres" ]; then
  echo "   غير مثبّت → أثبّته الآن…"
  sudo -n apt-get update -qq >/dev/null 2>&1
  sudo -n apt-get install -y -qq --no-install-recommends --fix-missing \
       postgresql-17 postgresql-client-17 postgresql-contrib >/dev/null 2>&1
fi
if ! [ -x "$PGBIN/postgres" ]; then echo "✖ فشل تثبيت PostgreSQL"; exit 1; fi
echo "   ✔ $($PGBIN/postgres --version)"

echo "── [2/4] تهيئة/تشغيل العنقود ──"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "   إنشاء عنقود جديد في $PGDATA …"
  rm -rf "$PGDATA"
  "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 --locale=C >/dev/null 2>&1 || {
    echo "✖ فشل initdb"; exit 1; }
fi

if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGLOG" \
    -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1 -c fsync=off" \
    -w -t 30 start >/dev/null 2>&1 || {
      echo "✖ فشل تشغيل PostgreSQL:"; tail -20 "$PGLOG"; exit 1; }
fi
pg_isready -h 127.0.0.1 -p $PORT >/dev/null 2>&1 || { echo "✖ السيرفر لا يستجيب"; exit 1; }
echo "   ✔ يعمل على 127.0.0.1:$PORT"

echo "── [3/4] تصفير قاعدة الاختبار ──"
$PSQL -q -c "drop schema if exists public cascade;" \
          -c "create schema public;" \
          -c "drop schema if exists auth cascade;" \
          -c "drop schema if exists storage cascade;" \
          -c "drop publication if exists supabase_realtime;" >/dev/null 2>&1
echo "   ✔ نظيفة"

echo "── [4/4] تثبيت محاكاة Supabase ──"
$PSQL -f "$STUB" -q && echo "   ✔ الكائنات الوهمية جاهزة (auth.users / storage / الأدوار / النشر)"
echo
echo "الآن:  bash $(dirname "$0")/run_schema_test.sh"
