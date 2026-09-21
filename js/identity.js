// =============================================================
// الهوية: قائمة الدول + أدوات أرقام الهاتف
// الدخول صار: رقم الهاتف + كلمة مرور (بلا بصمة جهاز)
// فيعمل الحساب من أي جهاز بنفس الرقم وكلمة المرور.
// =============================================================

const INTERNAL_DOMAIN = "wa-walid.app"; // نطاق داخلي لحساب المُشغِّل (لا يظهر للمستخدم)

// ---------------- قائمة الدول ----------------
// اليمن أولاً (الافتراضي) ثم بقية الدول العربية ثم الأكثر شيوعاً
// ٤٦ دولة — مرتّبة أبجدياً حسب الاسم العربي (مع الاسم الإنجليزي للبحث)
export const COUNTRIES = [
  { code: "AU", dial: "61", flag: "🇦🇺", name: "أستراليا", en: "Australia" },
  { code: "DE", dial: "49", flag: "🇩🇪", name: "ألمانيا", en: "Germany" },
  { code: "US", dial: "1", flag: "🇺🇸", name: "أمريكا", en: "United States" },
  { code: "ET", dial: "251", flag: "🇪🇹", name: "إثيوبيا", en: "Ethiopia" },
  { code: "ES", dial: "34", flag: "🇪🇸", name: "إسبانيا", en: "Spain" },
  { code: "ID", dial: "62", flag: "🇮🇩", name: "إندونيسيا", en: "Indonesia" },
  { code: "IR", dial: "98", flag: "🇮🇷", name: "إيران", en: "Iran" },
  { code: "IT", dial: "39", flag: "🇮🇹", name: "إيطاليا", en: "Italy" },
  { code: "JO", dial: "962", flag: "🇯🇴", name: "الأردن", en: "Jordan" },
  { code: "AE", dial: "971", flag: "🇦🇪", name: "الإمارات", en: "United Arab Emirates" },
  { code: "BH", dial: "973", flag: "🇧🇭", name: "البحرين", en: "Bahrain" },
  { code: "DZ", dial: "213", flag: "🇩🇿", name: "الجزائر", en: "Algeria" },
  { code: "SA", dial: "966", flag: "🇸🇦", name: "السعودية", en: "Saudi Arabia" },
  { code: "SD", dial: "249", flag: "🇸🇩", name: "السودان", en: "Sudan" },
  { code: "SE", dial: "46", flag: "🇸🇪", name: "السويد", en: "Sweden" },
  { code: "SO", dial: "252", flag: "🇸🇴", name: "الصومال", en: "Somalia" },
  { code: "CN", dial: "86", flag: "🇨🇳", name: "الصين", en: "China" },
  { code: "IQ", dial: "964", flag: "🇮🇶", name: "العراق", en: "Iraq" },
  { code: "PH", dial: "63", flag: "🇵🇭", name: "الفلبين", en: "Philippines" },
  { code: "KW", dial: "965", flag: "🇰🇼", name: "الكويت", en: "Kuwait" },
  { code: "MA", dial: "212", flag: "🇲🇦", name: "المغرب", en: "Morocco" },
  { code: "IN", dial: "91", flag: "🇮🇳", name: "الهند", en: "India" },
  { code: "YE", dial: "967", flag: "🇾🇪", name: "اليمن", en: "Yemen" },
  { code: "PK", dial: "92", flag: "🇵🇰", name: "باكستان", en: "Pakistan" },
  { code: "GB", dial: "44", flag: "🇬🇧", name: "بريطانيا", en: "United Kingdom" },
  { code: "BD", dial: "880", flag: "🇧🇩", name: "بنغلاديش", en: "Bangladesh" },
  { code: "TR", dial: "90", flag: "🇹🇷", name: "تركيا", en: "Turkey" },
  { code: "TN", dial: "216", flag: "🇹🇳", name: "تونس", en: "Tunisia" },
  { code: "KM", dial: "269", flag: "🇰🇲", name: "جزر القمر", en: "Comoros" },
  { code: "ZA", dial: "27", flag: "🇿🇦", name: "جنوب أفريقيا", en: "South Africa" },
  { code: "DJ", dial: "253", flag: "🇩🇯", name: "جيبوتي", en: "Djibouti" },
  { code: "RU", dial: "7", flag: "🇷🇺", name: "روسيا", en: "Russia" },
  { code: "SY", dial: "963", flag: "🇸🇾", name: "سوريا", en: "Syria" },
  { code: "OM", dial: "968", flag: "🇴🇲", name: "عُمان", en: "Oman" },
  { code: "FR", dial: "33", flag: "🇫🇷", name: "فرنسا", en: "France" },
  { code: "PS", dial: "970", flag: "🇵🇸", name: "فلسطين", en: "Palestine" },
  { code: "QA", dial: "974", flag: "🇶🇦", name: "قطر", en: "Qatar" },
  { code: "CA", dial: "1", flag: "🇨🇦", name: "كندا", en: "Canada" },
  { code: "KE", dial: "254", flag: "🇰🇪", name: "كينيا", en: "Kenya" },
  { code: "LB", dial: "961", flag: "🇱🇧", name: "لبنان", en: "Lebanon" },
  { code: "LY", dial: "218", flag: "🇱🇾", name: "ليبيا", en: "Libya" },
  { code: "MY", dial: "60", flag: "🇲🇾", name: "ماليزيا", en: "Malaysia" },
  { code: "EG", dial: "20", flag: "🇪🇬", name: "مصر", en: "Egypt" },
  { code: "MR", dial: "222", flag: "🇲🇷", name: "موريتانيا", en: "Mauritania" },
  { code: "NG", dial: "234", flag: "🇳🇬", name: "نيجيريا", en: "Nigeria" },
  { code: "NL", dial: "31", flag: "🇳🇱", name: "هولندا", en: "Netherlands" },
];

const DEFAULT_COUNTRY = "YE";

/** نص البحث لكل دولة (عربي + إنجليزي + مفتاح + رمز) */
function haystack(c) {
  return `${c.name} ${c.en} ${c.dial} ${c.code} ${c.flag}`.toLowerCase();
}

/**
 * بحث الدول بالحروف: يطابق بداية الاسم العربي/الإنجليزي أو مفتاح الدولة.
 * النتائج مرتّبة أبجدياً (وهذا هو ترتيب القائمة أصلاً).
 */
export function searchCountries(query, limit = 60) {
  const q = String(query || "").trim().toLowerCase();

  if (!q) return COUNTRIES.slice(0, limit);

  const norm = q.replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, "");

  const score = (c) => {
    const name = c.name.toLowerCase();
    const nameNorm = name.replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
    const en = c.en.toLowerCase();

    if (name.startsWith(q) || nameNorm.startsWith(norm)) return 0;      // اسم عربي
    if (name.includes(q) || nameNorm.includes(norm)) return 1;          // داخل الاسم
    if (en.startsWith(q)) return 2;                                     // اسم إنجليزي
    if (en.includes(q)) return 3;
    if (c.dial.startsWith(q.replace(/^\+/, ""))) return 4;             // مفتاح الدولة
    if (c.code.toLowerCase().startsWith(q)) return 5;
    if (haystack(c).includes(q)) return 6;

    return -1;
  };

  return COUNTRIES.map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name, "ar"))
    .slice(0, limit)
    .map((x) => x.c);
}
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
