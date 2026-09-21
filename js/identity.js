// =============================================================
// الهوية: قائمة الدول + أدوات أرقام الهاتف
// الدخول صار: رقم الهاتف + كلمة مرور (بلا بصمة جهاز)
// فيعمل الحساب من أي جهاز بنفس الرقم وكلمة المرور.
// =============================================================

const INTERNAL_DOMAIN = "wa-walid.app"; // نطاق داخلي لحساب المُشغِّل (لا يظهر للمستخدم)

// ---------------- قائمة الدول ----------------
// اليمن أولاً (الافتراضي) ثم بقية الدول العربية ثم الأكثر شيوعاً
export const COUNTRIES = [
  { code: "YE", dial: "967", flag: "🇾🇪", name: "اليمن" },
  { code: "SA", dial: "966", flag: "🇸🇦", name: "السعودية" },
  { code: "AE", dial: "971", flag: "🇦🇪", name: "الإمارات" },
  { code: "OM", dial: "968", flag: "🇴🇲", name: "عُمان" },
  { code: "QA", dial: "974", flag: "🇶🇦", name: "قطر" },
  { code: "KW", dial: "965", flag: "🇰🇼", name: "الكويت" },
  { code: "BH", dial: "973", flag: "🇧🇭", name: "البحرين" },
  { code: "EG", dial: "20", flag: "🇪🇬", name: "مصر" },
  { code: "JO", dial: "962", flag: "🇯🇴", name: "الأردن" },
  { code: "LB", dial: "961", flag: "🇱🇧", name: "لبنان" },
  { code: "SY", dial: "963", flag: "🇸🇾", name: "سوريا" },
  { code: "IQ", dial: "964", flag: "🇮🇶", name: "العراق" },
  { code: "PS", dial: "970", flag: "🇵🇸", name: "فلسطين" },
  { code: "SD", dial: "249", flag: "🇸🇩", name: "السودان" },
  { code: "LY", dial: "218", flag: "🇱🇾", name: "ليبيا" },
  { code: "TN", dial: "216", flag: "🇹🇳", name: "تونس" },
  { code: "DZ", dial: "213", flag: "🇩🇿", name: "الجزائر" },
  { code: "MA", dial: "212", flag: "🇲🇦", name: "المغرب" },
  { code: "MR", dial: "222", flag: "🇲🇷", name: "موريتانيا" },
  { code: "SO", dial: "252", flag: "🇸🇴", name: "الصومال" },
  { code: "DJ", dial: "253", flag: "🇩🇯", name: "جيبوتي" },
  { code: "KM", dial: "269", flag: "🇰🇲", name: "جزر القمر" },
  { code: "TR", dial: "90", flag: "🇹🇷", name: "تركيا" },
  { code: "IR", dial: "98", flag: "🇮🇷", name: "إيران" },
  { code: "PK", dial: "92", flag: "🇵🇰", name: "باكستان" },
  { code: "IN", dial: "91", flag: "🇮🇳", name: "الهند" },
  { code: "BD", dial: "880", flag: "🇧🇩", name: "بنغلاديش" },
  { code: "ID", dial: "62", flag: "🇮🇩", name: "إندونيسيا" },
  { code: "MY", dial: "60", flag: "🇲🇾", name: "ماليزيا" },
  { code: "PH", dial: "63", flag: "🇵🇭", name: "الفلبين" },
  { code: "ET", dial: "251", flag: "🇪🇹", name: "إثيوبيا" },
  { code: "KE", dial: "254", flag: "🇰🇪", name: "كينيا" },
  { code: "NG", dial: "234", flag: "🇳🇬", name: "نيجيريا" },
  { code: "ZA", dial: "27", flag: "🇿🇦", name: "جنوب أفريقيا" },
  { code: "GB", dial: "44", flag: "🇬🇧", name: "بريطانيا" },
  { code: "DE", dial: "49", flag: "🇩🇪", name: "ألمانيا" },
  { code: "FR", dial: "33", flag: "🇫🇷", name: "فرنسا" },
  { code: "NL", dial: "31", flag: "🇳🇱", name: "هولندا" },
  { code: "SE", dial: "46", flag: "🇸🇪", name: "السويد" },
  { code: "IT", dial: "39", flag: "🇮🇹", name: "إيطاليا" },
  { code: "ES", dial: "34", flag: "🇪🇸", name: "إسبانيا" },
  { code: "RU", dial: "7", flag: "🇷🇺", name: "روسيا" },
  { code: "CN", dial: "86", flag: "🇨🇳", name: "الصين" },
  { code: "US", dial: "1", flag: "🇺🇸", name: "أمريكا" },
  { code: "CA", dial: "1", flag: "🇨🇦", name: "كندا" },
  { code: "AU", dial: "61", flag: "🇦🇺", name: "أستراليا" },
];

const DEFAULT_COUNTRY = "YE";
const PHONE_KEY = "wa_saved_phone";

export function countryByCode(code) {
  return COUNTRIES.find((c) => c.code === code) || COUNTRIES[0];
}

export function defaultCountryCode() {
  // التطبيق موجَّه للسوق اليمني/الخليجي: اليمن افتراضية دائماً،
  // وإن كان هناك رقم محفوظ على الجهاز فقائمته تُحدَّد من الرقم نفسه.
  return DEFAULT_COUNTRY;
}

/** يحوّل الأرقام العربية إلى إنجليزية ويُبقي الأرقام فقط */
export function digitsOnly(raw) {
  return String(raw || "")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[^\d]/g, "");
}

/**
 * يبني الرقم الكامل (بلا +) من الرقم المحلي + مفتاح الدولة.
 * يقبل أيضاً أن يكتب المستخدم المفتاح نفسه فيتجنّب تكراره.
 */
export function buildFullPhone(localNumber, dialCode) {
  let n = digitsOnly(localNumber);
  const dial = digitsOnly(dialCode);

  if (!n) return "";

  // كتب المستخدم الرقم بصيغة دولية: +967... أو 00967...
  if (n.startsWith("00")) n = n.slice(2);

  if (dial && n.startsWith(dial) && n.length > dial.length + 4) {
    return n;
  }

  n = n.replace(/^0+/, ""); // صفر البداية لا يُستخدم مع مفتاح الدولة

  return dial ? dial + n : n;
}

export function isValidPhone(localNumber, dialCode) {
  const full = buildFullPhone(localNumber, dialCode);

  return full.length >= 8 && full.length <= 15;
}

/** عرض مقروء: +967 771 234 567 */
export function prettyPhone(fullPhone, dialCode) {
  const n = digitsOnly(fullPhone);

  if (!n) return "";

  let dial = digitsOnly(dialCode || "");

  if (!dial) {
    const match = COUNTRIES.filter((c) => n.startsWith(c.dial)).sort(
      (a, b) => b.dial.length - a.dial.length
    )[0];

    dial = match ? match.dial : n.slice(0, 3);
  }

  const rest = n.startsWith(dial) ? n.slice(dial.length) : n;
  const grouped = rest.replace(/^(\d{3})(\d{3})(\d{0,4})$/, "$1 $2 $3").trim();

  return `+${dial} ${grouped}`.trim();
}

/** بريد داخلي ثابت مشتق من الرقم — لا يظهر للمستخدم إطلاقاً */
export function internalEmail(fullPhone) {
  return `u${digitsOnly(fullPhone)}@${INTERNAL_DOMAIN}`;
}

export function isInternalEmail(email) {
  return String(email || "").toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`);
}

// ---------------- تذكّر آخر رقم على الجهاز (للتعبئة فقط، بلا دخول تلقائي) ----------------

export function saveSavedPhone({ full, country }) {
  try {
    localStorage.setItem(PHONE_KEY, JSON.stringify({ full, country, at: Date.now() }));
  } catch (e) {}
}

export function getSavedPhone() {
  try {
    const raw = localStorage.getItem(PHONE_KEY);

    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function clearSavedPhone() {
  try {
    localStorage.removeItem(PHONE_KEY);
  } catch (e) {}
}
