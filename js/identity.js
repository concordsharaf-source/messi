// =============================================================
// الهوية: قائمة الدول + أدوات أرقام الهاتف
// الدخول صار: رقم الهاتف + كلمة مرور (بلا بصمة جهاز)
// فيعمل الحساب من أي جهاز بنفس الرقم وكلمة المرور.
// =============================================================

const INTERNAL_DOMAIN = "wa-walid.app"; // نطاق داخلي لحساب المُشغِّل (لا يظهر للمستخدم)

// ---------------- قائمة الدول ----------------
// 186 دولة — مرتّبة أبجدياً حسب الاسم العربي (مع الاسم الإنجليزي للبحث)
// بلا دولة افتراضية: المستخدم يختار دولته بنفسه.
export const COUNTRIES = [
  { code: "ET", dial: "251", flag: "🇪🇹", name: "إثيوبيا", en: "Ethiopia" },
  { code: "AZ", dial: "994", flag: "🇦🇿", name: "أذربيجان", en: "Azerbaijan" },
  { code: "AM", dial: "374", flag: "🇦🇲", name: "أرمينيا", en: "Armenia" },
  { code: "ER", dial: "291", flag: "🇪🇷", name: "إريتريا", en: "Eritrea" },
  { code: "ES", dial: "34", flag: "🇪🇸", name: "إسبانيا", en: "Spain" },
  { code: "AU", dial: "61", flag: "🇦🇺", name: "أستراليا", en: "Australia" },
  { code: "EE", dial: "372", flag: "🇪🇪", name: "إستونيا", en: "Estonia" },
  { code: "SZ", dial: "268", flag: "🇸🇿", name: "إسواتيني", en: "Eswatini" },
  { code: "CF", dial: "236", flag: "🇨🇫", name: "أفريقيا الوسطى", en: "Central African Republic" },
  { code: "AF", dial: "93", flag: "🇦🇫", name: "أفغانستان", en: "Afghanistan" },
  { code: "AR", dial: "54", flag: "🇦🇷", name: "الأرجنتين", en: "Argentina" },
  { code: "JO", dial: "962", flag: "🇯🇴", name: "الأردن", en: "Jordan" },
  { code: "EC", dial: "593", flag: "🇪🇨", name: "الإكوادور", en: "Ecuador" },
  { code: "AE", dial: "971", flag: "🇦🇪", name: "الإمارات", en: "United Arab Emirates" },
  { code: "AL", dial: "355", flag: "🇦🇱", name: "ألبانيا", en: "Albania" },
  { code: "BS", dial: "1242", flag: "🇧🇸", name: "الباهاما", en: "Bahamas" },
  { code: "BH", dial: "973", flag: "🇧🇭", name: "البحرين", en: "Bahrain" },
  { code: "BR", dial: "55", flag: "🇧🇷", name: "البرازيل", en: "Brazil" },
  { code: "PT", dial: "351", flag: "🇵🇹", name: "البرتغال", en: "Portugal" },
  { code: "BA", dial: "387", flag: "🇧🇦", name: "البوسنة والهرسك", en: "Bosnia and Herzegovina" },
  { code: "CZ", dial: "420", flag: "🇨🇿", name: "التشيك", en: "Czechia" },
  { code: "ME", dial: "382", flag: "🇲🇪", name: "الجبل الأسود", en: "Montenegro" },
  { code: "DZ", dial: "213", flag: "🇩🇿", name: "الجزائر", en: "Algeria" },
  { code: "DK", dial: "45", flag: "🇩🇰", name: "الدنمارك", en: "Denmark" },
  { code: "DO", dial: "1809", flag: "🇩🇴", name: "الدومينيكان", en: "Dominican Republic" },
  { code: "CV", dial: "238", flag: "🇨🇻", name: "الرأس الأخضر", en: "Cape Verde" },
  { code: "SA", dial: "966", flag: "🇸🇦", name: "السعودية", en: "Saudi Arabia" },
  { code: "SV", dial: "503", flag: "🇸🇻", name: "السلفادور", en: "El Salvador" },
  { code: "SN", dial: "221", flag: "🇸🇳", name: "السنغال", en: "Senegal" },
  { code: "SD", dial: "249", flag: "🇸🇩", name: "السودان", en: "Sudan" },
  { code: "SE", dial: "46", flag: "🇸🇪", name: "السويد", en: "Sweden" },
  { code: "SO", dial: "252", flag: "🇸🇴", name: "الصومال", en: "Somalia" },
  { code: "CN", dial: "86", flag: "🇨🇳", name: "الصين", en: "China" },
  { code: "IQ", dial: "964", flag: "🇮🇶", name: "العراق", en: "Iraq" },
  { code: "GA", dial: "241", flag: "🇬🇦", name: "الغابون", en: "Gabon" },
  { code: "PH", dial: "63", flag: "🇵🇭", name: "الفلبين", en: "Philippines" },
  { code: "CM", dial: "237", flag: "🇨🇲", name: "الكاميرون", en: "Cameroon" },
  { code: "CG", dial: "242", flag: "🇨🇬", name: "الكونغو", en: "Congo" },
  { code: "CD", dial: "243", flag: "🇨🇩", name: "الكونغو الديمقراطية", en: "DR Congo" },
  { code: "KW", dial: "965", flag: "🇰🇼", name: "الكويت", en: "Kuwait" },
  { code: "MV", dial: "960", flag: "🇲🇻", name: "المالديف", en: "Maldives" },
  { code: "DE", dial: "49", flag: "🇩🇪", name: "ألمانيا", en: "Germany" },
  { code: "HU", dial: "36", flag: "🇭🇺", name: "المجر", en: "Hungary" },
  { code: "MA", dial: "212", flag: "🇲🇦", name: "المغرب", en: "Morocco" },
  { code: "MX", dial: "52", flag: "🇲🇽", name: "المكسيك", en: "Mexico" },
  { code: "NO", dial: "47", flag: "🇳🇴", name: "النرويج", en: "Norway" },
  { code: "AT", dial: "43", flag: "🇦🇹", name: "النمسا", en: "Austria" },
  { code: "NE", dial: "227", flag: "🇳🇪", name: "النيجر", en: "Niger" },
  { code: "IN", dial: "91", flag: "🇮🇳", name: "الهند", en: "India" },
  { code: "JP", dial: "81", flag: "🇯🇵", name: "اليابان", en: "Japan" },
  { code: "YE", dial: "967", flag: "🇾🇪", name: "اليمن", en: "Yemen" },
  { code: "GR", dial: "30", flag: "🇬🇷", name: "اليونان", en: "Greece" },
  { code: "US", dial: "1", flag: "🇺🇸", name: "أمريكا", en: "United States" },
  { code: "ID", dial: "62", flag: "🇮🇩", name: "إندونيسيا", en: "Indonesia" },
  { code: "AO", dial: "244", flag: "🇦🇴", name: "أنغولا", en: "Angola" },
  { code: "UY", dial: "598", flag: "🇺🇾", name: "أوروغواي", en: "Uruguay" },
  { code: "UZ", dial: "998", flag: "🇺🇿", name: "أوزبكستان", en: "Uzbekistan" },
  { code: "UG", dial: "256", flag: "🇺🇬", name: "أوغندا", en: "Uganda" },
  { code: "UA", dial: "380", flag: "🇺🇦", name: "أوكرانيا", en: "Ukraine" },
  { code: "IR", dial: "98", flag: "🇮🇷", name: "إيران", en: "Iran" },
  { code: "IE", dial: "353", flag: "🇮🇪", name: "أيرلندا", en: "Ireland" },
  { code: "IS", dial: "354", flag: "🇮🇸", name: "أيسلندا", en: "Iceland" },
  { code: "IT", dial: "39", flag: "🇮🇹", name: "إيطاليا", en: "Italy" },
  { code: "PG", dial: "675", flag: "🇵🇬", name: "بابوا غينيا الجديدة", en: "Papua New Guinea" },
  { code: "PY", dial: "595", flag: "🇵🇾", name: "باراغواي", en: "Paraguay" },
  { code: "BB", dial: "1246", flag: "🇧🇧", name: "باربادوس", en: "Barbados" },
  { code: "PK", dial: "92", flag: "🇵🇰", name: "باكستان", en: "Pakistan" },
  { code: "PW", dial: "680", flag: "🇵🇼", name: "بالاو", en: "Palau" },
  { code: "BN", dial: "673", flag: "🇧🇳", name: "بروناي", en: "Brunei" },
  { code: "GB", dial: "44", flag: "🇬🇧", name: "بريطانيا", en: "United Kingdom" },
  { code: "BE", dial: "32", flag: "🇧🇪", name: "بلجيكا", en: "Belgium" },
  { code: "BG", dial: "359", flag: "🇧🇬", name: "بلغاريا", en: "Bulgaria" },
  { code: "BZ", dial: "501", flag: "🇧🇿", name: "بليز", en: "Belize" },
  { code: "BD", dial: "880", flag: "🇧🇩", name: "بنغلاديش", en: "Bangladesh" },
  { code: "PA", dial: "507", flag: "🇵🇦", name: "بنما", en: "Panama" },
  { code: "BJ", dial: "229", flag: "🇧🇯", name: "بنين", en: "Benin" },
  { code: "BT", dial: "975", flag: "🇧🇹", name: "بوتان", en: "Bhutan" },
  { code: "BW", dial: "267", flag: "🇧🇼", name: "بوتسوانا", en: "Botswana" },
  { code: "PR", dial: "1787", flag: "🇵🇷", name: "بورتوريكو", en: "Puerto Rico" },
  { code: "BF", dial: "226", flag: "🇧🇫", name: "بوركينا فاسو", en: "Burkina Faso" },
  { code: "BI", dial: "257", flag: "🇧🇮", name: "بوروندي", en: "Burundi" },
  { code: "PL", dial: "48", flag: "🇵🇱", name: "بولندا", en: "Poland" },
  { code: "BO", dial: "591", flag: "🇧🇴", name: "بوليفيا", en: "Bolivia" },
  { code: "PE", dial: "51", flag: "🇵🇪", name: "بيرو", en: "Peru" },
  { code: "BY", dial: "375", flag: "🇧🇾", name: "بيلاروسيا", en: "Belarus" },
  { code: "TH", dial: "66", flag: "🇹🇭", name: "تايلاند", en: "Thailand" },
  { code: "TW", dial: "886", flag: "🇹🇼", name: "تايوان", en: "Taiwan" },
  { code: "TM", dial: "993", flag: "🇹🇲", name: "تركمانستان", en: "Turkmenistan" },
  { code: "TR", dial: "90", flag: "🇹🇷", name: "تركيا", en: "Turkey" },
  { code: "TT", dial: "1868", flag: "🇹🇹", name: "ترينيداد وتوباغو", en: "Trinidad and Tobago" },
  { code: "TD", dial: "235", flag: "🇹🇩", name: "تشاد", en: "Chad" },
  { code: "CL", dial: "56", flag: "🇨🇱", name: "تشيلي", en: "Chile" },
  { code: "TZ", dial: "255", flag: "🇹🇿", name: "تنزانيا", en: "Tanzania" },
  { code: "TG", dial: "228", flag: "🇹🇬", name: "توغو", en: "Togo" },
  { code: "TV", dial: "688", flag: "🇹🇻", name: "توفالو", en: "Tuvalu" },
  { code: "TN", dial: "216", flag: "🇹🇳", name: "تونس", en: "Tunisia" },
  { code: "TO", dial: "676", flag: "🇹🇴", name: "تونغا", en: "Tonga" },
  { code: "TL", dial: "670", flag: "🇹🇱", name: "تيمور الشرقية", en: "Timor-Leste" },
  { code: "JM", dial: "1876", flag: "🇯🇲", name: "جامايكا", en: "Jamaica" },
  { code: "KM", dial: "269", flag: "🇰🇲", name: "جزر القمر", en: "Comoros" },
  { code: "SB", dial: "677", flag: "🇸🇧", name: "جزر سليمان", en: "Solomon Islands" },
  { code: "MH", dial: "692", flag: "🇲🇭", name: "جزر مارشال", en: "Marshall Islands" },
  { code: "ZA", dial: "27", flag: "🇿🇦", name: "جنوب أفريقيا", en: "South Africa" },
  { code: "SS", dial: "211", flag: "🇸🇸", name: "جنوب السودان", en: "South Sudan" },
  { code: "GE", dial: "995", flag: "🇬🇪", name: "جورجيا", en: "Georgia" },
  { code: "DJ", dial: "253", flag: "🇩🇯", name: "جيبوتي", en: "Djibouti" },
  { code: "RW", dial: "250", flag: "🇷🇼", name: "رواندا", en: "Rwanda" },
  { code: "RU", dial: "7", flag: "🇷🇺", name: "روسيا", en: "Russia" },
  { code: "RO", dial: "40", flag: "🇷🇴", name: "رومانيا", en: "Romania" },
  { code: "ZM", dial: "260", flag: "🇿🇲", name: "زامبيا", en: "Zambia" },
  { code: "ZW", dial: "263", flag: "🇿🇼", name: "زيمبابوي", en: "Zimbabwe" },
  { code: "CI", dial: "225", flag: "🇨🇮", name: "ساحل العاج", en: "Ivory Coast" },
  { code: "WS", dial: "685", flag: "🇼🇸", name: "ساموا", en: "Samoa" },
  { code: "LK", dial: "94", flag: "🇱🇰", name: "سريلانكا", en: "Sri Lanka" },
  { code: "SK", dial: "421", flag: "🇸🇰", name: "سلوفاكيا", en: "Slovakia" },
  { code: "SI", dial: "386", flag: "🇸🇮", name: "سلوفينيا", en: "Slovenia" },
  { code: "SG", dial: "65", flag: "🇸🇬", name: "سنغافورة", en: "Singapore" },
  { code: "SY", dial: "963", flag: "🇸🇾", name: "سوريا", en: "Syria" },
  { code: "SR", dial: "597", flag: "🇸🇷", name: "سورينام", en: "Suriname" },
  { code: "CH", dial: "41", flag: "🇨🇭", name: "سويسرا", en: "Switzerland" },
  { code: "SL", dial: "232", flag: "🇸🇱", name: "سيراليون", en: "Sierra Leone" },
  { code: "SC", dial: "248", flag: "🇸🇨", name: "سيشل", en: "Seychelles" },
  { code: "RS", dial: "381", flag: "🇷🇸", name: "صربيا", en: "Serbia" },
  { code: "TJ", dial: "992", flag: "🇹🇯", name: "طاجيكستان", en: "Tajikistan" },
  { code: "OM", dial: "968", flag: "🇴🇲", name: "عمان", en: "Oman" },
  { code: "GM", dial: "220", flag: "🇬🇲", name: "غامبيا", en: "Gambia" },
  { code: "GH", dial: "233", flag: "🇬🇭", name: "غانا", en: "Ghana" },
  { code: "GT", dial: "502", flag: "🇬🇹", name: "غواتيمالا", en: "Guatemala" },
  { code: "GY", dial: "592", flag: "🇬🇾", name: "غيانا", en: "Guyana" },
  { code: "GN", dial: "224", flag: "🇬🇳", name: "غينيا", en: "Guinea" },
  { code: "GQ", dial: "240", flag: "🇬🇶", name: "غينيا الاستوائية", en: "Equatorial Guinea" },
  { code: "GW", dial: "245", flag: "🇬🇼", name: "غينيا بيساو", en: "Guinea-Bissau" },
  { code: "VU", dial: "678", flag: "🇻🇺", name: "فانواتو", en: "Vanuatu" },
  { code: "FR", dial: "33", flag: "🇫🇷", name: "فرنسا", en: "France" },
  { code: "PS", dial: "970", flag: "🇵🇸", name: "فلسطين", en: "Palestine" },
  { code: "VE", dial: "58", flag: "🇻🇪", name: "فنزويلا", en: "Venezuela" },
  { code: "FI", dial: "358", flag: "🇫🇮", name: "فنلندا", en: "Finland" },
  { code: "VN", dial: "84", flag: "🇻🇳", name: "فيتنام", en: "Vietnam" },
  { code: "FJ", dial: "679", flag: "🇫🇯", name: "فيجي", en: "Fiji" },
  { code: "CY", dial: "357", flag: "🇨🇾", name: "قبرص", en: "Cyprus" },
  { code: "QA", dial: "974", flag: "🇶🇦", name: "قطر", en: "Qatar" },
  { code: "KG", dial: "996", flag: "🇰🇬", name: "قيرغيزستان", en: "Kyrgyzstan" },
  { code: "KZ", dial: "7", flag: "🇰🇿", name: "كازاخستان", en: "Kazakhstan" },
  { code: "HR", dial: "385", flag: "🇭🇷", name: "كرواتيا", en: "Croatia" },
  { code: "KH", dial: "855", flag: "🇰🇭", name: "كمبوديا", en: "Cambodia" },
  { code: "CA", dial: "1", flag: "🇨🇦", name: "كندا", en: "Canada" },
  { code: "CU", dial: "53", flag: "🇨🇺", name: "كوبا", en: "Cuba" },
  { code: "KR", dial: "82", flag: "🇰🇷", name: "كوريا الجنوبية", en: "South Korea" },
  { code: "KP", dial: "850", flag: "🇰🇵", name: "كوريا الشمالية", en: "North Korea" },
  { code: "CR", dial: "506", flag: "🇨🇷", name: "كوستاريكا", en: "Costa Rica" },
  { code: "CO", dial: "57", flag: "🇨🇴", name: "كولومبيا", en: "Colombia" },
  { code: "KI", dial: "686", flag: "🇰🇮", name: "كيريباتي", en: "Kiribati" },
  { code: "KE", dial: "254", flag: "🇰🇪", name: "كينيا", en: "Kenya" },
  { code: "LV", dial: "371", flag: "🇱🇻", name: "لاتفيا", en: "Latvia" },
  { code: "LA", dial: "856", flag: "🇱🇦", name: "لاوس", en: "Laos" },
  { code: "LB", dial: "961", flag: "🇱🇧", name: "لبنان", en: "Lebanon" },
  { code: "LU", dial: "352", flag: "🇱🇺", name: "لوكسمبورغ", en: "Luxembourg" },
  { code: "LY", dial: "218", flag: "🇱🇾", name: "ليبيا", en: "Libya" },
  { code: "LR", dial: "231", flag: "🇱🇷", name: "ليبيريا", en: "Liberia" },
  { code: "LT", dial: "370", flag: "🇱🇹", name: "ليتوانيا", en: "Lithuania" },
  { code: "LS", dial: "266", flag: "🇱🇸", name: "ليسوتو", en: "Lesotho" },
  { code: "MO", dial: "853", flag: "🇲🇴", name: "ماكاو", en: "Macau" },
  { code: "MW", dial: "265", flag: "🇲🇼", name: "مالاوي", en: "Malawi" },
  { code: "MT", dial: "356", flag: "🇲🇹", name: "مالطا", en: "Malta" },
  { code: "ML", dial: "223", flag: "🇲🇱", name: "مالي", en: "Mali" },
  { code: "MY", dial: "60", flag: "🇲🇾", name: "ماليزيا", en: "Malaysia" },
  { code: "MG", dial: "261", flag: "🇲🇬", name: "مدغشقر", en: "Madagascar" },
  { code: "EG", dial: "20", flag: "🇪🇬", name: "مصر", en: "Egypt" },
  { code: "MK", dial: "389", flag: "🇲🇰", name: "مقدونيا الشمالية", en: "North Macedonia" },
  { code: "MN", dial: "976", flag: "🇲🇳", name: "منغوليا", en: "Mongolia" },
  { code: "MR", dial: "222", flag: "🇲🇷", name: "موريتانيا", en: "Mauritania" },
  { code: "MU", dial: "230", flag: "🇲🇺", name: "موريشيوس", en: "Mauritius" },
  { code: "MZ", dial: "258", flag: "🇲🇿", name: "موزمبيق", en: "Mozambique" },
  { code: "MD", dial: "373", flag: "🇲🇩", name: "مولدوفا", en: "Moldova" },
  { code: "MM", dial: "95", flag: "🇲🇲", name: "ميانمار", en: "Myanmar" },
  { code: "FM", dial: "691", flag: "🇫🇲", name: "ميكرونيزيا", en: "Micronesia" },
  { code: "NA", dial: "264", flag: "🇳🇦", name: "ناميبيا", en: "Namibia" },
  { code: "NR", dial: "674", flag: "🇳🇷", name: "ناورو", en: "Nauru" },
  { code: "NP", dial: "977", flag: "🇳🇵", name: "نيبال", en: "Nepal" },
  { code: "NG", dial: "234", flag: "🇳🇬", name: "نيجيريا", en: "Nigeria" },
  { code: "NI", dial: "505", flag: "🇳🇮", name: "نيكاراغوا", en: "Nicaragua" },
  { code: "NZ", dial: "64", flag: "🇳🇿", name: "نيوزيلندا", en: "New Zealand" },
  { code: "HT", dial: "509", flag: "🇭🇹", name: "هايتي", en: "Haiti" },
  { code: "HN", dial: "504", flag: "🇭🇳", name: "هندوراس", en: "Honduras" },
  { code: "NL", dial: "31", flag: "🇳🇱", name: "هولندا", en: "Netherlands" },
  { code: "HK", dial: "852", flag: "🇭🇰", name: "هونغ كونغ", en: "Hong Kong" },
];

const DEFAULT_COUNTRY = "";

/** نص البحث لكل دولة (عربي + إنجليزي + مفتاح + رمز) */
function haystack(c) {
  return `${c.name} ${c.en} ${c.dial} ${c.code}`.toLowerCase();
}

/**
 * بحث الدول بالحروف: يطابق بداية الاسم العربي/الإنجليزي أو مفتاح الدولة.
 * النتائج مرتّبة أبجدياً (وهذا هو ترتيب القائمة أصلاً).
 */
export function searchCountries(query, limit = 400) {
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
  const wanted = String(code || "").trim().toUpperCase();

  if (!wanted) return undefined;

  return COUNTRIES.find((c) => c.code === wanted);
}

/** دولة العرض المؤقت حين لم يختر المستخدم شيئاً بعد */
export const NO_COUNTRY = { code: "", dial: "", flag: "🌍", name: "اختر الدولة", en: "" };

export function defaultCountryCode() {
  // لا دولة افتراضية (بطلب المستخدم): لا تظهر اليمن تلقائياً،
  // والمستخدم يختار دولته من القائمة المرتّبة أبجدياً.
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
