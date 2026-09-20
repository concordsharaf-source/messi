// ============================================================
// إعدادات الاتصال — عدّل القيم التالية بمعلومات مشروعك في Supabase
// ============================================================
export const SUPABASE_URL = "https://jjamwoidjxrdovsoftbq.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_q_XwYPM5rgWw6c8t6BlEGg_jj2oApZY";

export const VAPID_PUBLIC_KEY = "BAxTu3HSXPEgeTyTRPoXvpkLQWu8llJQfsPEoUr0MDjHKRJ0VSzPFcJw5RFv-s6BTnZYeWEHW8NSQzAjfOxoJfo";

// ⚠️ أُزيلت قائمة ADMINS الثابتة (كانت تحمل إيميلات المالك السابق).
//    السبب أمني: أي إيميل مكتوب في الواجهة كان يمنح صاحبه واجهة المشرف.
//    السلطة الآن في قاعدة البيانات وحدها: profiles.is_admin / is_super_admin،
//    ويُضبط المشرفون في دالتي is_admin_email و is_super_admin_email داخل schema.sql.
//    واجهة المشرفين تُجلب بقراءة profiles حيث is_admin = true (js/app.js).
