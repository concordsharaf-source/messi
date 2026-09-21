// =============================================================
// هوية المستخدم (بصمة مستخدم):
// يربط التطبيق «رقم الهاتف + الاسم + معلومات الجهاز» ويُنتج:
//   1) بصمة مستخدم ثابتة (fingerprint) تُخزَّن في المتصفح وفي الملف الشخصي
//   2) بيانات اعتماد تُشتق تلقائياً — بلا كلمة مرور يكتبها المستخدم
// =============================================================

const CC_DEFAULT = "967"; // اليمن
const INTERNAL_DOMAIN = "wa-walid.app"; // نطاق داخلي لحساب المشغّل (لا يظهر للمستخدم)
const SALT = "walid-identity-v1";

const DEVICE_KEY = "wa_device_id";
const IDENTITY_KEY = "wa_identity";

// ---------------------- أدوات مساعدة ----------------------

function toAsciiDigits(str) {
  return String(str)
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // ٠١٢٣
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)); // ۰۱۲۳
}

/** يُنظّف الرقم: يحذف الرموز، ويضيف مفتاح الدولة الافتراضي عند الحاجة */
export function normalizePhone(raw) {
  if (!raw) return "";

  let s = toAsciiDigits(raw).trim().replace(/[^\d+]/g, "");

  if (s.startsWith("+")) s = s.slice(1);

  if (s.startsWith("00")) s = s.slice(2);

  if (s.startsWith("0")) s = CC_DEFAULT + s.slice(1);

  if (s.length === 9 && s.startsWith("7")) s = CC_DEFAULT + s; // 7XXXXXXXX → 9677XXXXXXXX

  return s;
}

export function isValidPhone(raw) {
  const p = normalizePhone(raw);

  return /^\d{8,15}$/.test(p);
}

export function prettyPhone(raw) {
  const p = normalizePhone(raw);

  return p ? "+" + p : "";
}

function uuid() {
  try {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  } catch (e) {}

  const bytes = new Uint8Array(16);

  try {
    (globalThis.crypto || {}).getRandomValues?.(bytes);
  } catch (e) {}

  bytes.forEach((b, i) => {
    if (!b) bytes[i] = Math.floor(Math.random() * 256);
  });

  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------- SHA-256 (مع بديل عند عدم توفر crypto.subtle) ----------------------

function sha256Fallback(text) {
  // تنفيذ مختصر لـ SHA-256 (يُستخدم فقط عند فتح الموقع بلا HTTPS)
  function rr(n, x) {
    return (x >>> n) | (x << (32 - n));
  }

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  const bytes = new TextEncoder().encode(text);

  const l = bytes.length;

  const withOne = new Uint8Array(((l + 9 + 63) >> 6) << 6);

  withOne.set(bytes);

  withOne[l] = 0x80;

  const bitLen = l * 8;

  new DataView(withOne.buffer).setUint32(withOne.length - 4, bitLen >>> 0);

  new DataView(withOne.buffer).setUint32(withOne.length - 8, Math.floor(bitLen / 4294967296));

  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  const w = new Array(64);

  const dv = new DataView(withOne.buffer);

  for (let i = 0; i < withOne.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);

    for (let t = 16; t < 64; t++) {
      const s0 = rr(7, w[t - 15]) ^ rr(18, w[t - 15]) ^ (w[t - 15] >>> 3);

      const s1 = rr(17, w[t - 2]) ^ rr(19, w[t - 2]) ^ (w[t - 2] >>> 10);

      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let t = 0; t < 64; t++) {
      const S1 = rr(6, e) ^ rr(11, e) ^ rr(25, e);

      const ch = (e & f) ^ (~e & g);

      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;

      const S0 = rr(2, a) ^ rr(13, a) ^ rr(22, a);

      const mj = (a & b) ^ (a & c) ^ (b & c);

      const t2 = (S0 + mj) >>> 0;

      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }

    H = [ (H[0]+a)>>>0, (H[1]+b)>>>0, (H[2]+c)>>>0, (H[3]+d)>>>0, (H[4]+e)>>>0, (H[5]+f)>>>0, (H[6]+g)>>>0, (H[7]+h)>>>0 ];
  }

  return H.map((x) => x.toString(16).padStart(8, "0")).join("");
}

export async function sha256hex(text) {
  try {
    if (globalThis.crypto?.subtle && globalThis.isSecureContext) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (e) {}

  return sha256Fallback(text);
}

// ---------------------- معلومات الجهاز ----------------------

export function getDeviceId() {
  let id = "";

  try {
    id = localStorage.getItem(DEVICE_KEY) || "";
  } catch (e) {}

  if (!id) {
    id = uuid();

    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch (e) {}
  }

  return id;
}

function detectOS(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";

  return "نظام غير معروف";
}

function detectBrowser(ua) {
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/SamsungBrowser/i.test(ua)) return "Samsung";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua)) return "Safari";

  return "متصفح";
}

/** معلومات الجهاز التي تدخل في البصمة */
export function deviceInfo() {
  const ua = navigator.userAgent || "";

  return {
    id: getDeviceId(),
    os: detectOS(ua),
    browser: detectBrowser(ua),
    platform: navigator.userAgentData?.platform || navigator.platform || "",
    screen: `${screen?.width || 0}x${screen?.height || 0}@${window.devicePixelRatio || 1}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    lang: navigator.language || "",
    cores: navigator.hardwareConcurrency || 0,
    touch: "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0,
    installed:
      window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
      navigator.standalone === true,
  };
}

/** وصف قصير للجهاز يُعرض للمستخدم/المشرف */
export function deviceStamp() {
  const d = deviceInfo();

  return `${d.os} · ${d.browser} · ${d.installed ? "تطبيق مثبّت" : "متصفح"}`;
}

// ---------------------- البصمة وبيانات الاعتماد ----------------------

function nameKey(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** بصمة المستخدم: الرقم + الاسم + معلومات الجهاز */
export async function buildFingerprint({ name, phone }) {
  const d = deviceInfo();

  const phoneN = normalizePhone(phone);

  const nk = nameKey(name);

  const fingerprint = await sha256hex(
    [
      SALT,
      phoneN,
      nk,
      d.id,
      d.platform,
      d.os,
      d.browser,
      d.screen,
      d.tz,
      d.lang,
      String(d.cores),
    ].join("|")
  );

  return {
    phone: phoneN,
    phonePretty: prettyPhone(phoneN),
    name: nk,
    device_id: d.id,
    device: d,
    device_label: `${d.os} · ${d.browser}`,
    fingerprint,
    short: fingerprint.slice(0, 10).toUpperCase(),
    created_at: new Date().toISOString(),
  };
}

/**
 * بيانات الاعتماد المشتقّة: لا يكتب المستخدم كلمة مرور أبداً.
 * الاشتقاق يعتمد على (الرقم + الاسم) حتى يبقى الحساب قابلاً للدخول من أي جهاز،
 * أما بصمة الجهاز فتُسجَّل كمعرّف إضافي للمستخدم وتُربط بحسابه.
 */
export async function deriveCredentials({ name, phone }) {
  const phoneN = normalizePhone(phone);

  const nk = nameKey(name);

  const digest = await sha256hex([SALT, phoneN, nk].join("|"));

  return {
    phone: phoneN,
    phonePretty: prettyPhone(phoneN),
    name: nk,
    email: `u${phoneN}@${INTERNAL_DOMAIN}`,
    password: digest.slice(0, 40),
  };
}

// ---------------------- التخزين المحلي ----------------------

export function saveLocalIdentity(identity) {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch (e) {}
}

export function getLocalIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);

    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function clearLocalIdentity() {
  try {
    localStorage.removeItem(IDENTITY_KEY);
  } catch (e) {}
}
