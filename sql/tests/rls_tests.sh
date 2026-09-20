#!/usr/bin/env bash
# ============================================================================
#  rls_tests.sh — اختبارات سلوكية لسياسات RLS على القاعدة المحلية
#  يحاكي مستخدماً عادياً + مشرفاً + غريباً ويتأكد أن كل سياسة تحمي فعلاً.
#  التشغيل:  bash /home/user/sql_test/rls_tests.sh
#  (يشترط تشغيل local_pg_up.sh ثم run_schema_test.sh أولاً)
# ============================================================================
PORT=5433
PSQL="/usr/bin/psql -h 127.0.0.1 -p $PORT -U postgres -d postgres -X -q -t -A"

# ── تصفير تلقائي: هذه الاختبارات تفترض قاعدة نظيفة. وفّر SKIP_RESET=1 للتخطي ──
if [ "${SKIP_RESET:-0}" != "1" ]; then
  HERE="$(cd "$(dirname "$0")" && pwd)"
  echo "↻ تصفير القاعدة المحلية وإعادة تثبيت المخطط…"
  bash "$HERE/local_pg_up.sh" >/dev/null 2>&1
  if ! bash "$HERE/run_schema_test.sh" 2>&1 | grep -q "schema.sql=0 fcm_and_rls.sql=0"; then
    echo "✖ فشل تثبيت المخطط — راجع run_schema_test.sh أولاً"; exit 2
  fi
fi
BASE="begin; set local role authenticated; set local search_path = public, storage, auth;"

U="${U:-11111111-1111-1111-1111-111111111111}"   # مستخدم عادي
A="${A:-22222222-2222-2222-2222-222222222222}"   # مشرف
O="${O:-33333333-3333-3333-3333-333333333333}"   # غريب (خارج المحادثة)
S="${S:-44444444-4444-4444-4444-444444444444}"   # مشرف عام (البريد الحقيقي)

PASS=0; FAIL=0
ok()  { printf "  \033[32m✔\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad() { printf "  \033[31m✖\033[0m %s\n" "$1"; [ -n "${2:-}" ] && printf "      ↳ %s\n" "$(echo "$2" | head -2 | tr '\n' ' ')"; FAIL=$((FAIL+1)); }
hdr() { printf "\n\033[1m══ %s\033[0m\n" "$1"; }

# ينفّذ استعلاماً بدور مستخدم مصادَق عليه
as_user() {
  $PSQL -c "$BASE set local request.jwt.claims = '{\"sub\":\"$1\",\"role\":\"authenticated\"}'; $2; rollback;" 2>&1 | grep -vE "^\s*$"
}
# ينفّذ بـ claims كاملة مخصّصة (لاختبار البريد داخل التوكن)
as_user_json() {
  $PSQL -c "begin; set local role authenticated; set local search_path = public, storage, auth; set local request.jwt.claims = '$1'; $2; commit;" 2>&1 | grep -vE "^\s*$"
}
# ينفّذ عملية بدور مستخدم مصادَق عليه وتُحفظ فعلاً (commit لا rollback)
as_user_do() {
  $PSQL -c "$BASE set local request.jwt.claims = '{\"sub\":\"$1\",\"role\":\"authenticated\"}'; $2; commit;" 2>&1 | grep -vE "^\s*$"
}
# ينفّذ بدور anon (زائر بلا تسجيل)
as_anon() {
  $PSQL -c "begin; set local role anon; set local request.jwt.claims = '{\"role\":\"anon\"}'; set local search_path = public, storage, auth; $1; rollback;" 2>&1 | grep -vE "^\s*$"
}
# ينفّذ بدور postgres (مالك القاعدة — يتجاوز RLS)
as_root() { $PSQL -c "$1" 2>&1 | grep -vE "^\s*$"; }

# توقّع النجاح: النتيجة يجب أن تساوي القيمة المتوقعة
expect() { # expect "وصف" "القيمة المتوقعة" "الناتج الفعلي"
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "المتوقع: «$2» — الحاصل: «$3»"; fi
}
# توقّع الفشل: يجب أن يظهر ERROR
expect_fail() { # expect_fail "وصف" "الناتج"
  if echo "$2" | grep -q "^ERROR"; then ok "$1"; else bad "$1" "كان يجب أن يُرفض! الحاصل: «$2»"; fi
}
expect_ok() { # توقّع النجاح: ألا يظهر ERROR
  if echo "$2" | grep -q "^ERROR"; then bad "$1" "$2"; else ok "$1"; fi
}

echo "════════════════════════════════════════════════════════════"
echo " اختبارات RLS — $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "════════════════════════════════════════════════════════════"

# ---------------------------------------------------------------- التجهيز ----
hdr "0) التجهيز: تهيئة قوائم المشرفين للاختبار"
as_root "create or replace function public.is_admin_email(p_email text)
  returns boolean language sql immutable as \$\$
    select lower(coalesce(p_email,'')) in ('admin.two@test.local','super.admin@test.local');
  \$\$;
  create or replace function public.is_super_admin_email(p_email text)
  returns boolean language sql immutable as \$\$
    select lower(coalesce(p_email,'')) = 'super.admin@test.local';
  \$\$;" >/dev/null
expect "دالة المشرفين تعمل" "t" "$(as_root "select public.is_admin_email('admin.two@test.local');")"

hdr "0) إنشاء 3 حسابات عبر auth.users (يختبر الـ Trigger)"
as_root "insert into auth.users (id,email,raw_user_meta_data) values
  ('$U','user.one@test.local','{\"display_name\":\"المستخدم الأول\"}'),
  ('$A','admin.two@test.local','{\"display_name\":\"المشرف الثاني\"}'),
  ('$O','outsider.three@test.local','{\"display_name\":\"الغريب الثالث\"}')
  on conflict (id) do nothing;" >/dev/null
expect "Trigger أنشأ 3 صفوف في profiles" "3" "$(as_root "select count(*) from public.profiles;")"
expect "display_name مأخوذ من raw_user_meta_data" "المستخدم الأول" \
       "$(as_root "select display_name from public.profiles where id='$U';")"
expect "غير المشرف لا يُرقّى تلقائياً" "f" "$(as_root "select is_admin from public.profiles where id='$U';")"

hdr "0.b) ترقية المشرف يدوياً (نفس خطوة لوحة التحكم)"
as_root "update public.profiles set is_admin=true where id='$A';" >/dev/null
expect "المشرف صار is_admin=true" "t" "$(as_root "select is_admin from public.profiles where id='$A';")"

# ------------------------------------------------------------ رؤية الملفات ----
hdr "1) رؤية جدول profiles"
expect "المستخدم العادي يرى نفسه + حساب المشرف فقط" "2" \
       "$(as_user "$U" "select count(*) from public.profiles;")"
expect "المستخدم العادي لا يرى الغريب" "0" \
       "$(as_user "$U" "select count(*) from public.profiles where id='$O';")"
expect "الزائر anon لا يرى أي ملف شخصي" "0" "$(as_anon "select count(*) from public.profiles;")"

hdr "2) حماية تصعيد الصلاحيات (أهم اختبار أمني)"
expect_ok   "المستخدم يعدّل اسمه الظاهر في ملفه" \
            "$(as_user_do "$U" "update public.profiles set display_name='اسم جديد' where id='$U';")"
expect_fail "المستخدم يمنع من ترقية نفسه إلى مشرف" \
            "$(as_user "$U" "update public.profiles set is_admin=true where id='$U';")"
expect_fail "المستخدم يمنع من ترقية نفسه إلى مشرف عام" \
            "$(as_user "$U" "update public.profiles set is_super_admin=true where id='$U';")"
expect "المستخدم لا يعدّل ملف غيره (0 صفوف متأثرة)" "0" \
       "$(as_user "$U" "with x as (update public.profiles set display_name='اختراق' where id='$O' returning 1) select count(*) from x;")"
expect "اسم الغريب لم يتغيّر فعلاً" "الغريب الثالث" \
       "$(as_root "select display_name from public.profiles where id='$O';")"

hdr "3) المحادثات والانتماء"
CONV="aaaaaaaa-0000-0000-0000-000000000001"
expect_ok "المستخدم ينشئ محادثة مع المشرف" \
          "$(as_user_do "$U" "insert into public.conversations (id,user_id,admin_id) values ('$CONV','$U','$A');")"
expect "الـ Trigger أضاف عضويّتين في chat_members" "2" \
       "$(as_root "select count(*) from public.chat_members where conversation_id='$CONV';")"
expect "المستخدم (طرف) يرى المحادثة" "1" "$(as_user "$U" "select count(*) from public.conversations where id='$CONV';")"
expect "المشرف (طرف) يرى المحادثة" "1" "$(as_user "$A" "select count(*) from public.conversations where id='$CONV';")"
expect "الغريب لا يرى المحادثة" "0" "$(as_user "$O" "select count(*) from public.conversations where id='$CONV';")"
expect_fail "الغريب لا يستطيع إنشاء محادثة منتحلاً المستخدم" \
            "$(as_user "$O" "insert into public.conversations (id,user_id,admin_id) values ('bbbbbbbb-0000-0000-0000-000000000002','$U','$A');")"

hdr "3.b) منع الترقية الذاتية في chat_members (ثغرة مؤكدة)"
expect_fail "الغريب لا ينضم لمحادثة ليست له بدور member" \
            "$(as_user "$O" "insert into public.chat_members (conversation_id,user_id,role) values ('$CONV','$O','member');")"
expect_fail "الغريب لا ينضم إليها بدور admin" \
            "$(as_user "$O" "insert into public.chat_members (conversation_id,user_id,role) values ('$CONV','$O','admin');")"
as_root "delete from public.chat_members where conversation_id='$CONV' and user_id='$U';" >/dev/null
expect_fail "الطرف لا يرقّي نفسه إلى admin (حتى لو كانت عضويته محذوفة)" \
            "$(as_user "$U" "insert into public.chat_members (conversation_id,user_id,role) values ('$CONV','$U','admin');")"
expect_ok   "الطرف يعيد إدخال عضويته بدور member فقط" \
            "$(as_user_do "$U" "insert into public.chat_members (conversation_id,user_id,role) values ('$CONV','$U','member');")"
expect "دور العضو بعد المحاولات لم يصر admin" "member" \
       "$(as_root "select role from public.chat_members where conversation_id='$CONV' and user_id='$U';")"

hdr "4) الرسائل"
MSG="cccccccc-0000-0000-0000-000000000001"
expect_ok "المستخدم يرسل رسالة في محادثته" \
          "$(as_user_do "$U" "insert into public.messages (id,conversation_id,sender_id,content) values ('$MSG','$CONV','$U','مرحبا');")"
expect "المشرف يرى الرسالة" "1" "$(as_user "$A" "select count(*) from public.messages where conversation_id='$CONV';")"
expect "الغريب لا يرى الرسالة" "0" "$(as_user "$O" "select count(*) from public.messages where conversation_id='$CONV';")"
expect "الزائر anon لا يرى الرسالة" "0" "$(as_anon "select count(*) from public.messages;")"
expect_fail "الغريب لا يرسل رسالة في محادثة ليست له" \
            "$(as_user "$O" "insert into public.messages (conversation_id,sender_id,content) values ('$CONV','$O','اقتحام');")"
expect_fail "الغريب لا ينتحل هوية المستخدم في sender_id" \
            "$(as_user "$O" "insert into public.messages (conversation_id,sender_id,content) values ('$CONV','$U','انتحال');")"

hdr "5) حالة الكتابة typing_status"
expect_ok "المستخدم يعلن أنه يكتب في محادثته" \
          "$(as_user_do "$U" "insert into public.typing_status (conversation_id,user_id,is_typing) values ('$CONV','$U',true);")"
expect "المشرف يرى حالة الكتابة" "1" \
       "$(as_user "$A" "select count(*) from public.typing_status where conversation_id='$CONV';")"
expect_fail "الغريب يعلن الكتابة في محادثة ليست له" \
            "$(as_user "$O" "insert into public.typing_status (conversation_id,user_id,is_typing) values ('$CONV','$O',true);")"
expect "الغريب لا يرى حالة الكتابة" "0" \
       "$(as_user "$O" "select count(*) from public.typing_status where conversation_id='$CONV';")"

hdr "6) رموز الإشعارات FCM"
expect_ok "المستخدم يسجّل رمز جهازه عبر claim_fcm_token" \
          "$(as_user_do "$U" "select public.claim_fcm_token('$U','tok-device-1','web');")"
expect_fail "المستخدم لا يسجّل رمزاً لحساب غيره" \
            "$(as_user "$U" "select public.claim_fcm_token('$O','tok-stolen','web');")"
expect "المستخدم يرى رمزه فقط" "1" "$(as_user "$U" "select count(*) from public.fcm_tokens;")"
expect "المشرف لا يرى رموز غيره" "0" "$(as_user "$A" "select count(*) from public.fcm_tokens;")"

hdr "7) التخزين (Storage) — كل مستخدم داخل مجلده"
expect_ok "المستخدم يرفع في مجلده" \
          "$(as_user_do "$U" "insert into storage.objects (bucket_id,name,owner) values ('avatars','$U/avatar.png','$U');")"
expect_fail "المستخدم لا يرفع في مجلد غيره" \
            "$(as_user "$U" "insert into storage.objects (bucket_id,name,owner) values ('avatars','$O/avatar.png','$O');")"
expect_fail "المستخدم لا يرفع إلى bucket غير مسموح" \
            "$(as_user "$U" "insert into storage.objects (bucket_id,name,owner) values ('fcm_tokens','$U/x.png','$U');")"
expect "الزائر anon يقرأ الصور العامة" "1" "$(as_anon "select count(*) from storage.objects where bucket_id='avatars';")"

hdr "8) الحذف والصلاحيات الإدارية"
expect "المستخدم العادي لا يحذف رسالة (المشرفون فقط) → 0 صفوف" "0" \
       "$(as_user "$U" "with x as (delete from public.messages where id='$MSG' returning 1) select count(*) from x;")"
expect "المستخدم العادي لا يحذف ملفاً شخصياً → 0 صفوف" "0" \
       "$(as_user "$U" "with x as (delete from public.profiles where id='$O' returning 1) select count(*) from x;")"
expect_ok   "المشرف يحذف ملف مستخدم عادي" \
            "$(as_user "$A" "delete from public.profiles where id='$O';")"
as_root "insert into auth.users (id,email,raw_user_meta_data) values ('$O','outsider.three@test.local','{}'::jsonb) on conflict (id) do nothing;" >/dev/null

hdr "9) بريد المشرف لا يمنح صلاحيات تلقائياً (إصلاح أمني)"
as_root "insert into auth.users (id,email,raw_user_meta_data) values ('$S','super.admin@test.local','{}'::jsonb) on conflict (id) do update set email=excluded.email;" >/dev/null
expect "التسجيل ببريد المشرف العام لا يمنح is_super_admin" "f" \
       "$(as_root "select is_super_admin from public.profiles where id='$S';")"
expect "ولا يمنح is_admin" "f" \
       "$(as_root "select is_admin from public.profiles where id='$S';")"
expect "لكن الحساب أُنشئ في profiles طبيعياً" "1" \
       "$(as_root "select count(*) from public.profiles where id='$S';")"

hdr "9.b) الترقية اليدوية (الطريقة الصحيحة) تعمل"
as_root "update public.profiles set is_admin = public.is_admin_email(email), is_super_admin = public.is_super_admin_email(email) where id in ('$S','$A');" >/dev/null
expect "المشرف العام صار is_super_admin=true" "t" \
       "$(as_root "select is_super_admin from public.profiles where id='$S';")"
expect "ويأخذ is_admin=true" "t" \
       "$(as_root "select is_admin from public.profiles where id='$S';")"
expect "المستخدم العادي لم يتغيّر" "f" \
       "$(as_root "select is_admin from public.profiles where id='$U';")"

hdr "9.c) المشرف العام يرى محادثات الجميع"
expect "المشرف العام يرى المحادثة" "1" \
       "$(as_user "$S" "select count(*) from public.conversations where id='$CONV';")"

hdr "10) منحة RPC الحسّاسة لا تُنفَّذ لغير صاحبها"
expect_fail "delete_message_as_moderator ترفض غير المشرف" \
            "$(as_user "$U" "select public.delete_message_as_moderator('$MSG');")"

hdr "11) منع ادّعاء الصلاحيات عند إنشاء الصف الشخصي"
as_root "delete from public.profiles where id='$O';" >/dev/null
expect_fail "لا يستطيع إدخال صفّه مع is_admin=true" \
  "$(as_user "$O" "insert into public.profiles (id,email,is_admin) values ('$O','outsider.three@test.local',true);")"
expect_fail "ولا مع is_super_admin=true" \
  "$(as_user "$O" "insert into public.profiles (id,email,is_super_admin) values ('$O','outsider.three@test.local',true);")"
expect_ok   "يستطيع إدخال صفّه الطبيعي (بلا صلاحيات)" \
  "$(as_user_do "$O" "insert into public.profiles (id,email) values ('$O','outsider.three@test.local');")"
expect "صلاحياته بقيت false/false" "false|false" \
  "$(as_root "select is_admin::text||'|'||is_super_admin::text from public.profiles where id='$O';")"
expect_fail "ولا يستطيع إدخال صفٍّ لمستخدم آخر" \
  "$(as_user "$O" "insert into public.profiles (id,email) values ('$U','x@test.local');")"

hdr "11.b) المسار المسموح: بريد مُعلَن في دالة المشرفين"
as_root "delete from public.profiles where id='$S';" >/dev/null
expect_ok "المشرف المُعلَن يستطيع إدخال صفّه مع is_admin=true" \
  "$(as_user_json '{"sub":"'"$S"'","role":"authenticated","email":"super.admin@test.local"}' \
     "insert into public.profiles (id,email,is_admin) values ('$S','super.admin@test.local',true);")"

echo
echo "════════════════════════════════════════════════════════════"
printf " النتيجة: \033[32m%d ناجح\033[0m / \033[31m%d فاشل\033[0m\n" "$PASS" "$FAIL"
echo "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
