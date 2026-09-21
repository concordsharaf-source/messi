import { supabase } from "./supabaseClient.js";
import { signUp, signIn, signOut, getCurrentProfile } from "./auth.js";
import { applyLanguage } from "./i18n.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import {
  cacheMessages,
  deleteCachedMessage,
  getCachedMessages,
  cacheContacts,
  getCachedContacts,
  queueOutboxMessage,
  getOutbox,
  removeFromOutbox,
} from "./db.js";
import {
  enablePushNotifications,
  registerFcmToken,
  removeFcmToken,
  listenForForegroundMessages,
} from "./push.js";

const state = {
  me: null,
  t: null,
  lang: localStorage.getItem("wa_lang") || "ar",
  theme: localStorage.getItem("wa_theme") || "dark",

  contacts: [],
  contactRowsByConversation: {},

  // =============================================================
  // LIVE UI INDEX
  // conversationId -> HTMLElement
  // =============================================================
  contactElements: {},

  activeConversation: null,
  messages: [],
  reactions: {},
  replyingTo: null,

  msgChannel: null,
  typingChannel: null,
  reactionsChannel: null,
  presenceChannel: null,
  inboxChannel: null,
  globalMsgChannel: null,

  typingTimeout: null,
  onlineMap: {},
  heartbeatInterval: null,

  recording: null,

  isOnline: navigator.onLine,
  // هذا التطبيق نسخة PWA وليست React Native؛ document.visibilityState هو
  // المكافئ المباشر لـ AppState.active/background في المتصفح.
  appState: document.visibilityState === "visible" ? "active" : "background",

  clickedWelcomeButtons: new Set(),

  deferredInstallPrompt: null,
  installButton: null,

  mediaUploading: false,
  mediaUploadStatusElement: null,

  foregroundMessagesUnsub: null,
  realtimeReconnectTimer: null,
};

const $ = (sel) => document.querySelector(sel);

// ===============================================================
// BOOT
// ===============================================================

async function boot() {
  document.body.setAttribute("data-theme", state.theme);

  // حجم الخط المختار يُطبَّق قبل ظهور أي شيء
  applyFontScale();

  // المظهر: يدوي / حسب الوقت / حسب الجهاز
  applyThemeMode();

  setupPWAInstallPrompt();

  await loadChatPanelPartial();

  state.t = applyLanguage(state.lang);

  const {
    data: { session },
  } = await supabase.auth.getSession();

  // ننسخ الجلسة لمُشغِّل الخدمة (للرد من الإشعار بلا فتح التطبيق)
  mirrorSession(session);

  // تحديث النسخة دورياً حتى لا تنتهي صلاحية الرد السريع
  setInterval(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => mirrorSession(data?.session))
      .catch(() => {});
  }, 5 * 60 * 1000);

  wireAuthForms();
  wireChrome();

  $("#boot-loading")?.classList.add("hidden");

  if (session) {
    await enterApp();

    // إن جاء المستخدم من زر «رد سريع» في الإشعار: نُرسل الرد فوراً
    await handleUrlQuickReply();
  } else {
    showAuthScreen();
  }

  // دورة FCM مرتبطة بمصدر الحقيقة الوحيد للمصادقة. نستخدم setTimeout حتى
  // لا ننفذ طلبات Supabase متداخلة داخل قفل onAuthStateChange الداخلي.
  supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      if (session) mirrorSession(session);

      if (
        (event === "SIGNED_IN" || event === "INITIAL_SESSION") &&
        session?.user
      ) {
        await autoEnableNotifications(session.user.id);
        return;
      }

      if (event === "SIGNED_OUT") {
        await removeFcmToken();
        state.me = null;
        showAuthScreen();
      }
    }, 0);
  });

  window.addEventListener("beforeunload", () => {
    if (state.me) {
      navigator.sendBeacon &&
        navigator.sendBeacon("about:blank");
    }
  });

  document.addEventListener("visibilitychange", async () => {
    state.appState = document.visibilityState === "visible" ? "active" : "background";

    if (!state.me) return;

    if (state.appState === "background") {
      await touchLastSeen(false);
    } else {
      await touchLastSeen(true);
      resubscribeRealtime();
    }
  });

  window.addEventListener("online", () => {
    state.isOnline = true;
    updateOfflineBanner();
    flushOutbox();
    resubscribeRealtime();
  });

  window.addEventListener("offline", () => {
    state.isOnline = false;
    updateOfflineBanner();
  });

  updateOfflineBanner();

  navigator.serviceWorker?.addEventListener("message", async (event) => {
    if (event.data?.type === "OPEN_CONVERSATION" && state.me) {
      await openConversationById(event.data.conversationId);
    }
  });

  window.addEventListener("popstate", (event) => {
    if (!event.state || !event.state.waChat) {
      closeChatView();
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#back-to-list, .js-back")) {
      if (history.state && history.state.waChat) {
        history.back();
      } else {
        closeChatView();
      }
    }
  });

  refreshPWAInstallButton();
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted && supabase) {
    supabase.realtime.connect();
  }
});

window.addEventListener("pagehide", () => {
  if (supabase?.realtime) {
    supabase.realtime.disconnect();
  }
});

// ===============================================================
// CHAT VIEW
// ===============================================================

function openConversationUIState(conversationId) {
  document.body.classList.add("viewing-chat");

  const historyState = {
    waChat: true,
    conversationId,
  };

  if (history.state && history.state.waChat) {
    history.replaceState(
      historyState,
      "",
      "#chat"
    );
  } else {
    history.pushState(
      historyState,
      "",
      "#chat"
    );
  }
}

function closeChatView() {
  document.body.classList.remove("viewing-chat");
  closeMediaViewer();
  state.activeConversation = null;
  $("#chat-options-menu")?.classList.add("hidden");
  $("#chat-options-toggle")?.setAttribute("aria-expanded", "false");

  $("#chat-panel")?.classList.remove("mobile-visible");
  $("#sidebar")?.classList.remove("mobile-hidden");
}

// ===============================================================
// OFFLINE
// ===============================================================

function updateOfflineBanner() {
  const banner = $("#offline-banner");
  if (!banner) return;

  banner.classList.toggle("hidden", state.isOnline);
}

// ===============================================================
// CHAT PARTIAL
// ===============================================================

async function loadChatPanelPartial() {
  const res = await fetch("./partials/chat-panel.html");
  const html = await res.text();

  const container = $("#chat-panel-container");

  if (container) {
    container.innerHTML = html;
  }
}

// ===============================================================
// AUTH SCREEN
// ===============================================================

function showAuthScreen() {
  $("#auth-screen")?.classList.remove("hidden");
  $("#app-shell")?.classList.add("hidden");

  refreshPWAInstallButton();
}

// ===============================================================
// ENTER APP
// ===============================================================

async function enterApp() {
  state.me = await getCurrentProfile();

  if (!state.me) {
    showAuthScreen();
    return;
  }

  $("#auth-screen")?.classList.add("hidden");
  $("#app-shell")?.classList.remove("hidden");

  const moderationRoles = await getModerationRoles(state.me.id);
  state.me.chat_roles = moderationRoles;
  state.me.can_moderate = Boolean(
    state.me.is_admin ||
    moderationRoles.some((role) => ["admin", "moderator"].includes(role))
  );

  $("#my-name").textContent = state.me.display_name;

  if (state.me.avatar_url) {
    $("#my-avatar").src = state.me.avatar_url;
  }

  applyThemeVars();

  // بعد الدخول نعرف الخلفية المرفوعة للمستخدم فنُحدِّث اللوحة
  renderWallpaperGrid();
  renderToneList();

  await touchLastSeen(true);
  startHeartbeat();

  await loadContacts();

  subscribeGlobalPresence();
  subscribeInboxUpdates();
  subscribeGlobalMessageWatch();

  if (!state.foregroundMessagesUnsub) {
    try {
      state.foregroundMessagesUnsub =
        listenForForegroundMessages({
          soundUrl: toneUrl(),
          onNotification: handleForegroundNotification,
        });
    } catch (err) {
      console.error(
        "تعذّر تفعيل استماع رسائل FCM الأمامية:",
        err
      );
    }
  }

  if (state.isOnline) {
    flushOutbox();
  }

  await openConversationFromNotificationRoute();
}

// ===============================================================
// LIVE FOREGROUND NOTIFICATION
// ===============================================================

function extractNotificationMessage(payload) {
  if (!payload) return null;

  const candidates = [
    payload?.message,
    payload?.new,
    payload?.data,
    payload,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    if (
      candidate.conversation_id ||
      candidate.conversationId
    ) {
      return {
        ...candidate,
        conversation_id:
          candidate.conversation_id ||
          candidate.conversationId,
      };
    }
  }

  return null;
}

function showInAppNotification({ title, body, conversationId }) {
  let banner = $("#in-app-notification");
  if (!banner) {
    banner = document.createElement("button");
    banner.id = "in-app-notification";
    banner.type = "button";
    banner.className = "in-app-notification hidden";
    document.body.appendChild(banner);
  }

  banner.innerHTML = `
    <strong>${escapeHtml(title || "رسالة جديدة")}</strong>
    <span>${escapeHtml(body || "لديك رسالة جديدة")}</span>
  `;
  banner.classList.remove("hidden");
  clearTimeout(banner._hideTimeout);
  banner._hideTimeout = setTimeout(() => banner.classList.add("hidden"), 6500);

  banner.onclick = async () => {
    banner.classList.add("hidden");
    if (conversationId) await openConversationById(conversationId);
  };
}

async function handleForegroundNotification(notification) {
  if (state.appState !== "active") return;

  const payload = notification?.payload || notification;
  const data = notification?.data || payload?.data || {};
  const conversationId = data.conversation_id || data.conversationId || payload?.conversation_id || payload?.conversationId;
  const message = extractNotificationMessage(payload);

  showInAppNotification({
    title: notification?.title || data.title || "رسالة جديدة",
    body: notification?.body || data.body || message?.content || "لديك رسالة جديدة",
    conversationId,
  });

  if (message?.conversation_id) {
    await patchContactUIOnNewMessage(message);
  } else {
    // إذا لم يرسل FCM بيانات الرسالة نفسها، نعيد مزامنة البيانات
    // بدون إعادة تحميل الصفحة.
    await loadContacts();
  }
}

// ===============================================================
// LAST SEEN
// ===============================================================

async function touchLastSeen(online) {
  if (!state.me) return;

  try {
    await supabase
      .from("profiles")
      .update({
        is_online: online,
        last_seen: new Date().toISOString(),
      })
      .eq("id", state.me.id);
  } catch (err) {
    console.error("touchLastSeen failed:", err);
  }
}

function startHeartbeat() {
  clearInterval(state.heartbeatInterval);

  state.heartbeatInterval = setInterval(() => {
    if (document.visibilityState === "visible") {
      touchLastSeen(true);
    }
  }, 25000);
}

// ===============================================================
// AUTH FORMS
// ===============================================================

function wireAuthForms() {
  $("#tab-login")?.addEventListener("click", () => {
    switchAuthTab("login");
  });

  $("#tab-signup")?.addEventListener("click", () => {
    switchAuthTab("signup");
  });

  $("#login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;

    try {
      await signIn({ email, password });
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    }
  });

  $("#signup-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = $("#signup-email").value.trim();
    const password = $("#signup-password").value;
    const displayName = $("#signup-name").value.trim();
    const phone = $("#signup-phone").value.trim();

    try {
      await signUp({
        email,
        password,
        displayName,
        phone,
      });

      await signIn({
        email,
        password,
      });

      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    }
  });
}

function switchAuthTab(which) {
  $("#tab-login")?.classList.toggle(
    "active",
    which === "login"
  );

  $("#tab-signup")?.classList.toggle(
    "active",
    which === "signup"
  );

  $("#login-form")?.classList.toggle(
    "hidden",
    which !== "login"
  );

  $("#signup-form")?.classList.toggle(
    "hidden",
    which !== "signup"
  );
}

function showAuthError(msg) {
  const text =
    msg ||
    state.t?.error_generic ||
    "حدث خطأ ما";

  const authScreenVisible =
    !$("#auth-screen")?.classList.contains("hidden");

  if (authScreenVisible) {
    const el = $("#auth-error");

    if (el) {
      el.textContent = text;
      el.classList.remove("hidden");

      setTimeout(() => {
        el.classList.add("hidden");
      }, 4000);
    }

    return;
  }

  const toast = $("#global-toast");

  if (!toast) return;

  toast.textContent = text;
  toast.classList.remove("hidden");

  clearTimeout(toast._hideTimeout);

  toast._hideTimeout = setTimeout(() => {
    toast.classList.add("hidden");
  }, 5000);
}

// =================================================================
// لوحة المشرف — إعدادات إدارية داخل لوحة الإعدادات
// -----------------------------------------------------------------
//  · الرد التلقائي (نص الترحيب + الأزرار) ← للمشرفين
//  · إدارة المشرفين وترقيتهم             ← للمشرف العام فقط
//  · إحصائيات سريعة                      ← للمشرف العام فقط
//
//  كل الكتابة تمرّ عبر دوال SQL محمية (security definer) تتحقق من
//  هوية المنادي داخل القاعدة، فلا يمكن تجاوزها من الواجهة ولا من الـ API.
// =================================================================

const MAX_REPLY_BUTTONS = 6;

function setAdminStatusText(el, msg, kind = "") {
  if (!el) return;
  el.textContent = msg || "";
  el.className = "admin-hint" + (kind ? " " + kind : "");
}

function addReplyButtonRow(label = "", value = "", reply = "") {
  const wrap = $("#auto-reply-buttons");
  if (!wrap) return;

  if (wrap.children.length >= MAX_REPLY_BUTTONS) {
    setAdminStatusText($("#auto-reply-status"), `الحد الأقصى ${MAX_REPLY_BUTTONS} أزرار`, "err");
    return;
  }

  const row = document.createElement("div");
  row.className = "reply-btn-row";
  row.innerHTML = `
    <input class="rb-label" type="text" maxlength="40" placeholder="نص الزر" />
    <input class="rb-value" type="text" maxlength="200" placeholder="ما يُرسل عند الضغط" />
    <input class="rb-reply" type="text" maxlength="400" placeholder="↩ الردّ التلقائي عند اختياره" />
    <button class="rb-remove" type="button" title="حذف الزر">✕</button>
  `;
  row.querySelector(".rb-label").value = label;
  row.querySelector(".rb-value").value = value;
  row.querySelector(".rb-reply").value = reply;
  wrap.appendChild(row);
}

function collectReplyButtons() {
  const rows = $("#auto-reply-buttons")?.children || [];
  const out = [];
  for (const row of rows) {
    const label = row.querySelector(".rb-label")?.value.trim() || "";
    const value = row.querySelector(".rb-value")?.value.trim() || "";
    const reply = row.querySelector(".rb-reply")?.value.trim() || "";
    if (!label && !value) continue;   // صف فارغ يُتجاهل
    out.push({ label, value, reply });  // التحقق النهائي يتم في قاعدة البيانات
  }
  return out;
}

function renderReplyPreview() {
  const box = $("#auto-reply-preview");
  if (!box) return;

  const greeting = $("#auto-reply-greeting")?.value.trim() || "(لا يوجد نص)";
  const buttons = collectReplyButtons();

  box.innerHTML =
    `<div>${escapeHtml(greeting)}</div>` +
    buttons
      .map(
        (b) =>
          `<div class="pv-btn">${escapeHtml(b.label || b.value)}` +
          (b.reply ? `<span class="pv-reply">↩ ${escapeHtml(b.reply)}</span>` : "") +
          `</div>`
      )
      .join("");
  box.classList.remove("hidden");
}

async function loadAutoReplySettings() {
  const { data, error } = await supabase
    .from("auto_reply_settings")
    .select("greeting, buttons, is_enabled")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const wrap = $("#auto-reply-buttons");
  if (wrap) wrap.innerHTML = "";

  if (error) {
    setAdminStatusText($("#auto-reply-status"), "تعذّر تحميل الإعدادات: " + error.message, "err");
    return;
  }

  if (!data) {
    addReplyButtonRow(
      "🛠️ طلب دعم فني",
      "طلب دعم فني",
      "تم استلام طلبك للدعم الفني ✅ سيتواصل معك أحد أعضاء الفريق قريباً."
    );
    setAdminStatusText($("#auto-reply-status"), "لا توجد إعدادات محفوظة بعد");
    return;
  }

  const greetingEl = $("#auto-reply-greeting");
  if (greetingEl) greetingEl.value = data.greeting || "";

  const enabledEl = $("#auto-reply-enabled");
  if (enabledEl) enabledEl.checked = Boolean(data.is_enabled);

  const list = Array.isArray(data.buttons) ? data.buttons : [];
  list.forEach((b) =>
    addReplyButtonRow(b?.label || "", b?.value || "", b?.reply || "")
  );

  setAdminStatusText($("#auto-reply-status"), "");
}

async function saveAutoReplySettings() {
  const btn = $("#btn-save-auto-reply");
  const greeting = $("#auto-reply-greeting")?.value.trim() || "";
  const buttons = collectReplyButtons();
  const enabled = Boolean($("#auto-reply-enabled")?.checked);

  if (!greeting) {
    setAdminStatusText($("#auto-reply-status"), "نص الترحيب لا يمكن أن يكون فارغاً", "err");
    $("#auto-reply-greeting")?.focus();
    return;
  }

  if (btn) btn.disabled = true;
  setAdminStatusText($("#auto-reply-status"), "جارٍ الحفظ…");

  const { error } = await supabase.rpc("update_auto_reply", {
    p_greeting: greeting,
    p_buttons: buttons,
    p_enabled: enabled,
  });

  if (btn) btn.disabled = false;

  if (error) {
    setAdminStatusText($("#auto-reply-status"), "تعذّر الحفظ: " + error.message, "err");
    return;
  }

  setAdminStatusText(
    $("#auto-reply-status"),
    enabled ? "تم الحفظ ✅ الرد التلقائي مُفعَّل" : "تم الحفظ ✅ الرد التلقائي مُوقَف",
    "ok"
  );
  renderReplyPreview();
}

async function loadAdminStats() {
  const box = $("#admin-stats");
  if (!box || !state.me?.is_super_admin) return;

  const { data, error } = await supabase.rpc("admin_stats");
  if (error || !data) {
    box.classList.add("hidden");
    return;
  }

  const items = [
    ["المستخدمون", data.users],
    ["المشرفون", data.admins],
    ["المحادثات", data.conversations],
    ["الرسائل", data.messages],
    ["رسائل اليوم", data.today_messages],
    ["أجهزة الإشعارات", data.devices],
  ];

  box.innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="admin-stat"><b>${Number(value) || 0}</b><span>${escapeHtml(label)}</span></div>`
    )
    .join("");
  box.classList.remove("hidden");
}

async function loadAdminUsers() {
  const list = $("#admin-users-list");
  const block = $("#admin-manage-block");
  if (!list || !state.me?.is_super_admin) return;

  block?.classList.remove("hidden");

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, display_name, is_admin, is_super_admin, avatar_url")
    .order("is_super_admin", { ascending: false })
    .order("is_admin", { ascending: false })
    .order("email", { ascending: true });

  if (error) {
    list.innerHTML =
      `<div class="admin-hint err">تعذّر تحميل القائمة: ${escapeHtml(error.message)}</div>`;
    return;
  }

  list.innerHTML = "";

  (data || []).forEach((p) => {
    const isSelf = p.id === state.me.id;
    const row = document.createElement("div");
    row.className = "admin-user";

    const initial = (p.display_name || p.email || "?").trim().charAt(0);

    row.innerHTML = `
      <div class="admin-user-head">
        <div class="admin-user-avatar" id="avatar-thumb-${p.id}">
          ${p.avatar_url ? `<img src="${escapeHtml(p.avatar_url)}" alt="">` : escapeHtml(initial)}
        </div>

        <div class="admin-user-info">
          <b>${escapeHtml(p.display_name || "بدون اسم")}</b>
          <span>${escapeHtml(p.email || "بدون بريد")}</span>
        </div>

        ${p.is_super_admin ? '<span class="admin-crown" title="مشرف عام">👑</span>' : ""}
      </div>

      <div class="admin-rename hidden">
        <input class="admin-rename-input" type="text" maxlength="40"
               value="${escapeHtml(p.display_name || "")}" placeholder="الاسم الجديد" />
        <button class="admin-key ok" data-act="rename-save" type="button">✔ حفظ</button>
        <button class="admin-key" data-act="rename-cancel" type="button">✕</button>
      </div>

      <div class="admin-user-actions">
        <button class="admin-flag ${p.is_admin ? "on" : ""}" data-act="admin" type="button"
                title="تبديل صفة المشرف">${p.is_admin ? "✔ مشرف" : "مشرف"}</button>
        <button class="admin-flag ${p.is_super_admin ? "on" : ""}" data-act="super" type="button"
                title="تبديل صفة المشرف العام">${p.is_super_admin ? "✔ مشرف عام" : "مشرف عام"}</button>

        <button class="admin-key" data-act="rename" type="button"
                title="إعادة تسمية المستخدم">✏️ الاسم</button>

        <button class="admin-key actor-avatar" data-act="avatar" type="button"
                title="تغيير الصورة الشخصية">📷 تغيير الصورة</button>

        ${p.avatar_url
          ? `<button class="admin-key danger" data-act="avatar-del" type="button"
                    title="حذف الصورة الشخصية">🚫 حذف الصورة</button>`
          : ""}

        ${isSelf ? '<span class="admin-self-hint">هذا حسابك</span>' : `
          <button class="admin-key" data-act="pass" type="button" title="تعيين كلمة مرور جديدة">🔑 كلمة المرور</button>
          <button class="admin-key" data-act="reset-link" type="button" title="إرسال رابط استعادة بالبريد">✉️ رابط استعادة</button>
        `}
      </div>
    `;

    const renameBox = row.querySelector(".admin-rename");
    const renameInput = row.querySelector(".admin-rename-input");
    const saveRename = () => renameUser(p, renameInput?.value, renameBox);

    row.querySelector('[data-act="rename"]')?.addEventListener("click", () => {
      renameBox?.classList.toggle("hidden");

      if (renameBox && !renameBox.classList.contains("hidden")) {
        renameInput.focus();
        renameInput.select();
      }
    });

    row.querySelector('[data-act="rename-cancel"]')?.addEventListener("click", () => {
      renameBox?.classList.add("hidden");
      if (renameInput) renameInput.value = p.display_name || "";
    });

    row.querySelector('[data-act="rename-save"]')?.addEventListener("click", saveRename);

    renameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        saveRename();
      }

      if (event.key === "Escape") renameBox?.classList.add("hidden");
    });

    row.querySelector('[data-act="pass"]')?.addEventListener("click", () => setUserPassword(p));
    row.querySelector('[data-act="reset-link"]')?.addEventListener("click", () => sendUserResetLink(p));
    row.querySelector('[data-act="avatar"]')?.addEventListener("click", (event) => {
      event.stopPropagation();
      pickUserAvatar(p);
    });
    row.querySelector('[data-act="avatar-del"]')?.addEventListener("click", (event) => {
      event.stopPropagation();
      removeUserAvatar(p);
    });

    row.querySelectorAll(".admin-flag").forEach((b) => {
      if (isSelf) {
        b.disabled = true;
        b.title = "لا يمكنك تغيير صلاحيات حسابك";
      } else {
        b.addEventListener("click", () => toggleAdminFlag(p, b.dataset.act, row));
      }
    });

    list.appendChild(row);
  });
}

async function renameUser(profile, rawName, box) {
  const status = $("#admin-manage-status");
  const who = profile.display_name || profile.email || "المستخدم";
  const name = String(rawName || "").trim();

  if (!name) {
    setAdminStatusText(status, "اكتب الاسم الجديد أولاً.", "err");
    return;
  }

  if (name.length > 40) {
    setAdminStatusText(status, "الاسم يجب أن يكون 40 حرفاً أو أقل.", "err");
    return;
  }

  if (name === (profile.display_name || "")) {
    box?.classList.add("hidden");
    return;
  }

  setAdminStatusText(status, `جارٍ إعادة تسمية «${who}»…`);

  const { data, error } = await supabase.rpc("admin_rename_user", {
    p_user: profile.id,
    p_new_name: name,
  });

  if (error) {
    setAdminStatusText(status, "تعذّرت إعادة التسمية: " + error.message, "err");
    return;
  }

  profile.display_name = data || name;

  box?.classList.add("hidden");

  setAdminStatusText(status, `✔ صار الاسم الجديد «${profile.display_name}».`);

  await loadAdminUsers();
  await loadContacts();
}

async function toggleAdminFlag(profile, act, row) {
  const status = $("#admin-manage-status");
  const flagButtons = row.querySelectorAll(".admin-flag");

  const nextAdmin =
    act === "admin" ? !profile.is_admin : true;   // منح «عام» يمنح «مشرف» تلقائياً
  const nextSuper =
    act === "super" ? !profile.is_super_admin : Boolean(profile.is_super_admin);

  const what =
    act === "super"
      ? (nextSuper ? "تعيين مشرفاً عاماً" : "إزالة صفة المشرف العام")
      : (nextAdmin ? "ترقية إلى مشرف" : "إزالة الإشراف");

  if (!window.confirm(`${what}: ${profile.display_name || profile.email}؟`)) return;

  flagButtons.forEach((b) => (b.disabled = true));
  setAdminStatusText(status, "جارٍ التنفيذ…");

  const { error } = await supabase.rpc("set_admin_status", {
    p_user_id: profile.id,
    p_is_admin: nextAdmin,
    p_is_super_admin: nextSuper,
  });

  if (error) {
    setAdminStatusText(status, "تعذّر: " + error.message, "err");
    flagButtons.forEach((b) => (b.disabled = false));
    return;
  }

  setAdminStatusText(status, `تم: ${what} ✅`, "ok");
  await Promise.all([loadAdminUsers(), loadAdminStats()]);
}

async function renderAdminTools() {
  const box = $("#admin-tools");
  if (!box) return;

  // المشرف فقط يرى اللوحة — وإلا تبقى مخفية تماماً
  if (!state.me?.is_admin) {
    box.classList.add("hidden");
    return;
  }

  box.classList.remove("hidden");
  await loadAutoReplySettings();
  renderReplyPreview();

  // التوقيع التلقائي: للمشرفين فقط
  ["#signature-label", "#signature-input", "#btn-save-signature"].forEach((sel) =>
    $(sel)?.classList.remove("hidden")
  );

  const signatureInput = $("#signature-input");
  if (signatureInput && signatureInput.dataset.filled !== "1") {
    signatureInput.dataset.filled = "1";
    signatureInput.value = state.me.signature || "";
  }

  // ملخص اليوم: لكل مشرف
  $("#summary-block")?.classList.remove("hidden");
  renderDailySummary();

  if (state.me.is_super_admin) {
    $("#activity-block")?.classList.remove("hidden");
    await Promise.all([loadAdminStats(), loadAdminUsers(), renderActivityFeed()]);
  } else {
    $("#admin-stats")?.classList.add("hidden");
    $("#admin-manage-block")?.classList.add("hidden");
    $("#activity-block")?.classList.add("hidden");
  }
}

function wireAdminTools() {
  $("#btn-add-reply-button")?.addEventListener("click", () => addReplyButtonRow());
  $("#btn-save-auto-reply")?.addEventListener("click", saveAutoReplySettings);
  $("#btn-preview-auto-reply")?.addEventListener("click", renderReplyPreview);

  // حذف زر من المحرّر — تفويض الحدث لأن الصفوف تُضاف ديناميكياً
  $("#auto-reply-buttons")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".rb-remove");
    if (btn) btn.closest(".reply-btn-row")?.remove();
  });

  // تحديث المعاينة أثناء الكتابة
  $("#auto-reply-greeting")?.addEventListener("input", () => {
    const pv = $("#auto-reply-preview");
    if (pv && !pv.classList.contains("hidden")) renderReplyPreview();
  });
}

// ===============================================================
// CHROME
// ===============================================================

// ===============================================================
// تفضيلات المستخدم: حجم الخط · خلفية الدردشة · نغمة الإشعارات
// ===============================================================

const FONT_SIZES = [
  { value: "0.88", label: "صغير" },
  { value: "1", label: "عادي" },
  { value: "1.15", label: "كبير" },
  { value: "1.3", label: "كبير جداً" },
];

// خلفيات جاهزة: نُبقي نقشة واتساب ونغيّر لونها فقط.
const CHAT_WALLPAPERS = [
  { id: "default", label: "افتراضي", color: "" },
  { id: "mint", label: "نعناعي", color: "#d8f0e6" },
  { id: "sky", label: "سماوي", color: "#cfe4f5" },
  { id: "rose", label: "وردي", color: "#f7dde1" },
  { id: "sand", label: "رملي", color: "#efe3cf" },
  { id: "grape", label: "بنفسجي", color: "#e2dbf2" },
  { id: "graphite", label: "رمادي", color: "#222e35" },
  { id: "night", label: "ليلي", color: "#0d1f26" },
];

const NOTIF_TONES = [
  { id: "default", label: "الافتراضية", url: "./icons/notify.mp3" },
  { id: "bell", label: "جرس", url: "./sounds/bell.wav" },
  { id: "chime", label: "نغمة هادئة", url: "./sounds/chime.wav" },
  { id: "pop", label: "نبضة", url: "./sounds/pop.wav" },
  { id: "knock", label: "دقّة", url: "./sounds/knock.wav" },
  { id: "silent", label: "صامت (بدون صوت)", url: "" },
];

const prefs = {
  fontSize: localStorage.getItem("wa_fontscale") || "1",
  chatBg: localStorage.getItem("wa_chatbg") || "default",
  tone: localStorage.getItem("wa_tone") || "default",
};

function currentTone() {
  return NOTIF_TONES.find((t) => t.id === prefs.tone) || NOTIF_TONES[0];
}

function toneUrl() {
  return currentTone().url;
}

// ---------------------------------------------------------------
// حجم الخط
// ---------------------------------------------------------------

function applyFontScale() {
  document.documentElement.style.setProperty("--wa-font-scale", prefs.fontSize);
}

function renderFontSizeChoices() {
  const box = $("#font-size-choices");
  if (!box) return;

  box.innerHTML = "";

  FONT_SIZES.forEach((f) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-choice" + (prefs.fontSize === f.value ? " active" : "");
    btn.textContent = f.label;
    btn.style.fontSize = `${13 * Number(f.value)}px`;

    btn.addEventListener("click", () => {
      prefs.fontSize = f.value;
      localStorage.setItem("wa_fontscale", f.value);
      applyFontScale();
      renderFontSizeChoices();
    });

    box.appendChild(btn);
  });
}

// ---------------------------------------------------------------
// خلفية الدردشة
// ---------------------------------------------------------------

function applyChatBackground() {
  const box = $("#chat-messages");
  if (!box) return;

  // الخلفية المرفوعة من المستخدم لها الأولوية
  if (state.me?.wallpaper_url) {
    box.style.backgroundImage = `url("${state.me.wallpaper_url}")`;
    box.style.backgroundSize = "cover";
    box.style.backgroundPosition = "center";
    box.style.backgroundRepeat = "no-repeat";
    box.style.backgroundColor = "";
    return;
  }

  const preset =
    CHAT_WALLPAPERS.find((w) => w.id === prefs.chatBg) || CHAT_WALLPAPERS[0];

  // نُفرِّغ التنسيقات السطرية ليعود النمط الافتراضي من CSS (النقشة)
  box.style.backgroundImage = "";
  box.style.backgroundSize = "";
  box.style.backgroundPosition = "";
  box.style.backgroundRepeat = "";
  box.style.backgroundColor = preset.color || "";
}

function renderWallpaperGrid() {
  const grid = $("#wallpaper-grid");
  if (!grid) return;

  grid.innerHTML = "";

  const active = state.me?.wallpaper_url ? "custom" : prefs.chatBg;

  CHAT_WALLPAPERS.forEach((w) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wallpaper-swatch" + (active === w.id ? " active" : "");
    btn.title = w.label;
    btn.dataset.wp = w.id;

    if (w.color) {
      btn.style.backgroundColor = w.color;
    } else {
      btn.classList.add("wp-default");
    }

    btn.addEventListener("click", async () => {
      // اختيار خلفية جاهزة يُلغي الخلفية المرفوعة
      if (state.me?.wallpaper_url) {
        const previous = state.me.wallpaper_url;

        const { error } = await supabase
          .from("profiles")
          .update({ wallpaper_url: null })
          .eq("id", state.me.id);

        if (!error) {
          state.me.wallpaper_url = null;
          await removeStorageFile("wallpapers", previous);
        }
      }

      prefs.chatBg = w.id;
      localStorage.setItem("wa_chatbg", w.id);
      applyChatBackground();
      renderWallpaperGrid();
    });

    const label = document.createElement("span");
    label.textContent = w.label;
    btn.appendChild(label);

    grid.appendChild(btn);
  });
}

// ---------------------------------------------------------------
// نغمة الإشعارات
// ---------------------------------------------------------------

function playTone(tone) {
  if (!tone?.url) return;

  const audio = new Audio(tone.url);
  audio.volume = 1;
  audio.play().catch(() => {
    showAuthError("تعذّر تشغيل النغمة — اسمح بالصوت في المتصفح.");
  });
}

function renderToneList() {
  const box = $("#tone-list");
  if (!box) return;

  box.innerHTML = "";

  NOTIF_TONES.forEach((t) => {
    const row = document.createElement("div");
    row.className = "tone-row" + (prefs.tone === t.id ? " active" : "");

    row.innerHTML = `
      <span class="tone-name">${t.label}</span>
      <button type="button" class="tone-play" ${t.url ? "" : "disabled"} title="تجربة النغمة">▶</button>
      <span class="tone-check">${prefs.tone === t.id ? "✓" : ""}</span>
    `;

    row.querySelector(".tone-play").addEventListener("click", (event) => {
      event.stopPropagation();
      playTone(t);
    });

    row.addEventListener("click", () => {
      prefs.tone = t.id;
      localStorage.setItem("wa_tone", t.id);
      renderToneList();
      if (t.url) playTone(t);
    });

    box.appendChild(row);
  });
}

// ---------------------------------------------------------------
// كلمة المرور (للمستخدم نفسه)
// ---------------------------------------------------------------

async function changeMyPassword() {
  const first = $("#new-password");
  const second = $("#new-password-confirm");
  const status = $("#password-status");

  const p1 = first?.value || "";
  const p2 = second?.value || "";

  if (p1.length < 6) {
    setAdminStatusText(status, "كلمة المرور قصيرة — 6 أحرف على الأقل.", "err");
    return;
  }

  if (p1 !== p2) {
    setAdminStatusText(status, "الكلمتان غير متطابقتين.", "err");
    return;
  }

  setAdminStatusText(status, "جارٍ تحديث كلمة المرور…");

  const { error } = await supabase.auth.updateUser({ password: p1 });

  if (error) {
    setAdminStatusText(status, "تعذّر التحديث: " + error.message, "err");
    return;
  }

  if (first) first.value = "";
  if (second) second.value = "";

  setAdminStatusText(status, "✔ تم تغيير كلمة المرور بنجاح.");
}

// ---------------------------------------------------------------
// كلمة مرور المستخدمين (المشرف العام فقط)
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// صور المستخدمين (المشرف العام فقط)
// ---------------------------------------------------------------

// تصغير الصورة داخل المتصفح قبل إرسالها: 512 بكسل كحد أقصى و JPEG مضغوط.
// هذا يحفظ سرعة الإرسال ويُبقي الصور خفيفة على القاعدة.
function fileToResizedDataUrl(file, max = 512, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("الملف المختار ليس صورة"));
      return;
    }

    const reader = new FileReader();

    reader.onerror = () => reject(new Error("تعذّر قراءة الملف"));

    reader.onload = () => {
      const img = new Image();

      img.onerror = () => reject(new Error("تعذّر فتح الصورة — جرّب صورة أخرى"));

      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);

        resolve(canvas.toDataURL("image/jpeg", quality));
      };

      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

function pickUserAvatar(profile) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    await changeUserAvatar(profile, file);
  });

  document.body.appendChild(input);
  input.click();
}

async function changeUserAvatar(profile, file) {
  const status = $("#admin-manage-status");
  const who = profile.display_name || profile.email || "المستخدم";

  try {
    setAdminStatusText(status, `جارٍ تجهيز صورة «${who}»…`);

    const dataUrl = await fileToResizedDataUrl(file);

    setAdminStatusText(status, "جارٍ الرفع…");

    const { data, error } = await supabase.functions.invoke("admin-set-avatar", {
      body: { userId: profile.id, dataUrl },
    });

    if (error || data?.error) {
      throw new Error(data?.error || error?.message || "خطأ غير معروف");
    }

    profile.avatar_url = data.url;

    setAdminStatusText(status, `✔ تم تحديث صورة «${who}».`);

    await loadAdminUsers();

    // تحديث قائمة المحادثات وصورة المستخدم في الواجهة فوراً
    await loadContacts();
  } catch (error) {
    setAdminStatusText(status, "تعذّر تحديث الصورة: " + (error?.message || "خطأ غير معروف"), "err");
  }
}

async function removeUserAvatar(profile) {
  const status = $("#admin-manage-status");
  const who = profile.display_name || profile.email || "المستخدم";

  if (!window.confirm(`حذف الصورة الشخصية لـ «${who}»؟`)) return;

  setAdminStatusText(status, "جارٍ الحذف…");

  const { data, error } = await supabase.functions.invoke("admin-set-avatar", {
    body: { userId: profile.id, remove: true },
  });

  if (error || data?.error) {
    setAdminStatusText(status, "تعذّر الحذف: " + (data?.error || error?.message || ""), "err");
    return;
  }

  profile.avatar_url = null;

  setAdminStatusText(status, `✔ تم حذف صورة «${who}».`);

  await loadAdminUsers();
  await loadContacts();
}

async function setUserPassword(profile) {
  const status = $("#admin-manage-status");
  const who = profile.display_name || profile.email || "المستخدم";

  const password = window.prompt(
    `كلمة مرور جديدة لـ «${who}»\n(6 أحرف على الأقل، اتركها فارغة للإلغاء)`
  );

  if (!password) return;

  if (password.length < 6) {
    setAdminStatusText(status, "كلمة المرور قصيرة — 6 أحرف على الأقل.", "err");
    return;
  }

  setAdminStatusText(status, "جارٍ التعيين…");

  const { data, error } = await supabase.functions.invoke("admin-set-password", {
    body: { userId: profile.id, password },
  });

  if (error || data?.error) {
    setAdminStatusText(status, "تعذّر: " + (data?.error || error?.message || ""), "err");
    return;
  }

  setAdminStatusText(status, `✔ تم تعيين كلمة مرور جديدة لـ «${who}».`);
}

async function sendUserResetLink(profile) {
  const status = $("#admin-manage-status");
  const who = profile.display_name || profile.email || "المستخدم";

  setAdminStatusText(status, "جارٍ الإرسال…");

  const { data, error } = await supabase.functions.invoke("admin-set-password", {
    body: { userId: profile.id, action: "reset-link" },
  });

  if (error || data?.error) {
    setAdminStatusText(status, "تعذّر: " + (data?.error || error?.message || ""), "err");
    return;
  }

  setAdminStatusText(status, `✔ ${data?.message || "أُرسل رابط الاستعادة"} لـ «${who}».`);
}

// ---------------------------------------------------------------
// الربط
// ---------------------------------------------------------------

function wirePreferences() {
  renderFontSizeChoices();
  renderWallpaperGrid();
  renderToneList();

  if ($("#btn-change-password")?.dataset.wired !== "1") {
    $("#btn-change-password").dataset.wired = "1";
    $("#btn-change-password").addEventListener("click", changeMyPassword);
  }

  if ($("#btn-close-settings")?.dataset.wired !== "1") {
    $("#btn-close-settings").dataset.wired = "1";
    $("#btn-close-settings").addEventListener("click", () => {
      $("#settings-panel")?.classList.add("hidden");
      $("#settings-backdrop")?.classList.add("hidden");
    });

    $("#settings-backdrop")?.addEventListener("click", () => {
      $("#settings-panel")?.classList.add("hidden");
      $("#settings-backdrop")?.classList.add("hidden");
    });
  }
}

// ===============================================================
// الدخول بواسطة جوجل + الدخول السريع
// ===============================================================

// فحص سريع قبل تحويل الصفحة: هل مزوّد جوجل مهيّأ في المشروع؟
// (يمنع ظهور صفحة خطأ JSON خام للمستخدم)
async function isGoogleProviderReady() {
  try {
    const url =
      `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=` +
      encodeURIComponent(`${window.location.origin}${window.location.pathname}`);

    const response = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY },
      redirect: "follow",
    });

    if (response.status === 400) {
      const data = await response.json().catch(() => null);

      if (data && String(data.error_code || "").includes("validation_failed")) {
        return false;
      }
    }

    return true;
  } catch (error) {
    // التوجيه إلى صفحة جوجل يمنع قراءة الرد (CORS) => المزوّد يعمل
    return true;
  }
}

async function signInWithGoogle() {
  const btn = $("#btn-google");
  if (btn) btn.disabled = true;

  let bridge = null;

  try {
    // الطريق الأول: مزوّد جوجل الأصلي في Supabase
    // (يُستخدم تلقائياً متى أُضيف مفتاح جوجل في إعدادات المشروع)
    if (await isGoogleProviderReady()) {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}${window.location.pathname}`,
          queryParams: { prompt: "select_account" },
        },
      });

      if (!error) return;
    }

    // الطريق الثاني: الجسر عبر Firebase — يعمل بلا أي مفتاح في Supabase
    try {
      bridge = await import("./google-signin.js");
    } catch (loadError) {
      if (btn) btn.disabled = false;

      showAuthError(
        "تعذّر تحميل مكوّن الدخول بجوجل — تحقّق من الاتصال بالإنترنت ثم أعد المحاولة."
      );

      return;
    }

    const done = await bridge.signInWithGoogleBridge();

    // إن جرى التوجيه الكامل إلى جوجل فالصفحة تغادر الآن — لا إعادة تحميل
    if (!done || !done.redirected) window.location.reload();
  } catch (error) {
    if (btn) btn.disabled = false;

    const message = bridge && bridge.googleErrorMessage
      ? bridge.googleErrorMessage(error)
      : "تعذّر الدخول بجوجل — أعد المحاولة.";

    showAuthError(message);
  }
}

async function signInAsGuest() {
  const btn = $("#btn-guest");
  if (btn) btn.disabled = true;

  const { error } = await supabase.auth.signInAnonymously({
    options: { data: { display_name: `زائر ${Math.floor(1000 + Math.random() * 8999)}` } },
  });

  if (error) {
    if (btn) btn.disabled = false;

    const message = /anonymous/i.test(error.message)
      ? "الدخول السريع غير مُفعَّل — فعّله من إعدادات المشروع."
      : "تعذّر الدخول السريع: " + error.message;

    showAuthError(message);
    return;
  }

  window.location.reload();
}

// إكمال الدخول بجوجل عند العودة من صفحة جوجل (المسار البديل للتوجيه الكامل)
async function completeGoogleRedirectIfPending() {
  // نفس العلامة المستخدمة في js/google-signin.js — الفحص قبل الاستيراد
  if (localStorage.getItem("wa_google_redirect") !== "1") return;

  try {
    const bridge = await import("./google-signin.js");

    if (await bridge.completeGoogleRedirect()) window.location.reload();
  } catch (error) {
    // تجاهل — يمكن للمستخدم المتابعة بالبريد أو إعادة المحاولة
  }
}

function wireQuickAuth() {
  $("#btn-google")?.addEventListener("click", signInWithGoogle);
  // زر «الدخول كزائر» أُزيل بطلب من المالك.
  // لدالة signInAsGuest() بقيت في الكود — لإرجاع الزر يكفي سطر واحد في index.html.

  completeGoogleRedirectIfPending();

  // فتح قفل الصوت عند أول لمسة حتى يعمل صوت الرسائل فوراً
  document.addEventListener("pointerdown", unlockAudio, { once: true, capture: true });
  document.addEventListener("keydown", unlockAudio, { once: true, capture: true });
}

// ===============================================================
// CHROME
// ===============================================================

// ===============================================================
// الرد السريع من الإشعار
//   • ننسخ جلسة الدخول إلى IndexedDB حتى يستطيع مُشغِّل الخدمة
//     (Service Worker) إرسال الرد بلا فتح التطبيق.
//   • وإن تعذّر ذلك (جلسة منتهية) نُرسل الرد بعد فتح التطبيق فوراً.
// ===============================================================

const QUICK_REPLIES = {
  "reply-done": "✅ تمّت معالجة طلبك، شكراً لتواصلك معنا.",
  "reply-ack": "👋 وصلنا رسالتك، وسيتم الرد عليك في أقرب وقت.",
};

function mirrorSession(session) {
  try {
    if (!session?.access_token) return;

    const request = indexedDB.open("messi-auth", 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("session")) {
        db.createObjectStore("session", { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("session")) return;

      const tx = db.transaction("session", "readwrite");
      tx.objectStore("session").put({
        key: "current",
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user_id: session.user?.id || null,
      });

      // اسم المشرف الحالي (لعرضه في الإشعار لاحقاً عند الحاجة)
      tx.objectStore("session").put({
        key: "user",
        user_id: session.user?.id || null,
      });
    };
  } catch (err) {
    console.warn("mirrorSession failed:", err);
  }
}

async function handleUrlQuickReply() {
  const params = new URLSearchParams(window.location.search);
  const action = params.get("quickreply");
  const conversationId = params.get("conversation");

  if (!action || !conversationId) return;

  const text = QUICK_REPLIES[action];
  if (!text) return;

  // قد يكون مسار الإشعار فتح المحادثة أصلاً
  if (String(state.activeConversation?.id) !== String(conversationId)) {
    const contact = (state.contacts || []).find(
      (c) => String(c._conversationId) === String(conversationId)
    );

    if (contact) {
      await openConversation(contact);
    } else {
      await openConversationById(conversationId);
    }
  }

  if (String(state.activeConversation?.id) !== String(conversationId)) {
    showAuthError("تعذّر فتح المحادثة لإرسال الرد السريع.");
    return;
  }

  await sendMessage({ content: text });

  window.history.replaceState({}, "", window.location.pathname);
}

// ===============================================================
// مزايا الإدارة الموسّعة
//   1) البحث في المحادثات وفي داخل الرسائل
//   2) تصنيف المحادثات + فلتر سريع
//   3) الوسوم والملاحظات الداخلية
//   4) الكتم والأرشفة
//   5) سجل نشاط المشرفين
//   6) التوقيع التلقائي
//   7) تصدير المحادثات (Excel / PDF)
//   8) الملخص اليومي
// ===============================================================

const STATUS_LABELS = { new: "جديد", pending: "بانتظار رد", done: "تمّت المعالجة" };
const STATUS_ICONS = { new: "🆕", pending: "⏳", done: "✅" };
const QUICK_TAGS = ["عميل مهم", "عاجل", "شكوى", "استفسار", "متابعة", "مغلق"];

const FILTER_LABELS = {
  all: "الكل",
  unread: "غير مقروء",
  new: "جديد",
  pending: "بانتظار رد",
  done: "تمّت",
  archived: "المؤرشفة",
};

state.adminMeta = state.adminMeta || {};
state.contactFilter = state.contactFilter || "all";
state.searchQuery = state.searchQuery || "";
state.msgSearch = state.msgSearch || { query: "", hits: [], index: -1 };

// ---------------------------------------------------------------
// 1) بيانات الإدارة لكل محادثة
// ---------------------------------------------------------------

async function loadAdminMeta() {
  if (!state.me?.is_admin) return;

  try {
    const { data, error } = await supabase.rpc("admin_conversations_overview");
    if (error) throw error;

    const map = {};

    (Array.isArray(data) ? data : []).forEach((row) => {
      map[row.conversation_id] = {
        status: row.status || "new",
        tags: Array.isArray(row.tags) ? row.tags : [],
        note: row.note || "",
        muted: Boolean(row.muted),
        archived: Boolean(row.archived),
      };
    });

    state.adminMeta = map;

    Object.keys(map).forEach(paintContactMeta);
    applyContactFilters();
  } catch (err) {
    console.warn("loadAdminMeta failed:", err);
  }
}

function metaFor(conversationId) {
  return (
    state.adminMeta[conversationId] || {
      status: "new",
      tags: [],
      note: "",
      muted: false,
      archived: false,
    }
  );
}

// يرسم شارات الحالة والوسوم والكتم على صف المحادثة
function paintContactMeta(conversationId) {
  const row = state.contactElements?.[conversationId];
  if (!row) return;

  const meta = metaFor(conversationId);

  let box = row.querySelector(".contact-badges");

  if (!meta.tags.length && meta.status === "new" && !meta.muted) {
    box?.remove();
    return;
  }

  if (!box) {
    box = document.createElement("div");
    box.className = "contact-badges";
    row.appendChild(box);
  }

  box.innerHTML = `
    ${meta.muted ? '<span class="mini-icon" title="مكتومة">🔇</span>' : ""}
    ${
      meta.status !== "new"
        ? `<span class="status-chip st-${meta.status}" title="حالة المحادثة">${STATUS_ICONS[meta.status]} ${STATUS_LABELS[meta.status]}</span>`
        : ""
    }
    ${meta.tags
      .slice(0, 3)
      .map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`)
      .join("")}
  `;
}

// ---------------------------------------------------------------
// 2) البحث + الفلتر السريع
// ---------------------------------------------------------------

function applyContactFilters() {
  const indexes = state.contactElements || {};
  const query = state.searchQuery.trim().toLowerCase();
  const filter = state.contactFilter;

  Object.entries(indexes).forEach(([conversationId, row]) => {
    const meta = metaFor(conversationId);

    const text = row.textContent.toLowerCase();
    const matchesText = !query || text.includes(query);

    let matchesFilter = true;

    if (filter === "unread") matchesFilter = Number(row.dataset.unread || 0) > 0;
    else if (filter === "archived") matchesFilter = meta.archived;
    else if (filter === "all") matchesFilter = !meta.archived;
    else matchesFilter = meta.status === filter && !meta.archived;

    row.classList.toggle("filtered-out", !(matchesText && matchesFilter));
  });

  const visible = Object.values(indexes).filter(
    (row) => !row.classList.contains("filtered-out")
  ).length;

  const empty = $("#contact-empty-filter");

  if (empty) {
    empty.classList.toggle("hidden", visible > 0 || (!query && filter === "all"));
  }
}

function wireContactFilters() {
  const bar = $("#chat-filters");
  if (bar && bar.dataset.wired !== "1") {
    bar.dataset.wired = "1";

    bar.innerHTML = Object.entries(FILTER_LABELS)
      .map(
        ([key, label]) =>
          `<button type="button" data-filter="${key}" class="${key === state.contactFilter ? "active" : ""}">${label}</button>`
      )
      .join("");

    bar.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-filter]");
      if (!btn) return;

      state.contactFilter = btn.dataset.filter;
      bar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      applyContactFilters();
    });
  }

  const search = $("#contact-search");
  if (search && search.dataset.wired !== "1") {
    search.dataset.wired = "1";
    search.addEventListener("input", () => {
      state.searchQuery = search.value;
      applyContactFilters();
    });
  }

  // فلتر الحالة يظهر للمشرفين فقط
  bar?.classList.toggle("hidden", !state.me?.is_admin);
  if (bar && state.me?.is_admin) {
    bar.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.filter === state.contactFilter)
    );
  }
}

// ---------------------------------------------------------------
// 3) البحث داخل الرسائل
// ---------------------------------------------------------------

function toggleMessageSearch(force) {
  const bar = $("#chat-search-bar");
  if (!bar) return;

  const show = force ?? bar.classList.contains("hidden");

  bar.classList.toggle("hidden", !show);

  if (show) {
    $("#chat-search-input")?.focus();
  } else {
    clearMessageSearch();
  }
}

function clearMessageSearch() {
  state.msgSearch = { query: "", hits: [], index: -1 };

  document.querySelectorAll(".bubble-row.search-hit, .bubble-row.search-current").forEach((row) => {
    row.classList.remove("search-hit", "search-current");
  });

  const input = $("#chat-search-input");
  if (input) input.value = "";

  const count = $("#chat-search-count");
  if (count) count.textContent = "";

  refreshSearchHighlights();
}

function runMessageSearch(query) {
  const clean = (query || "").trim().toLowerCase();

  state.msgSearch = { query: clean, hits: [], index: -1 };

  document.querySelectorAll(".bubble-row.search-hit, .bubble-row.search-current").forEach((row) => {
    row.classList.remove("search-hit", "search-current");
  });

  if (!clean) {
    refreshSearchHighlights();
    if ($("#chat-search-count")) $("#chat-search-count").textContent = "";
    return;
  }

  state.messages.forEach((m) => {
    const content = (m.content || "").toLowerCase();
    if (content.includes(clean)) state.msgSearch.hits.push(m.id);
  });

  const count = $("#chat-search-count");

  if (count) {
    count.textContent = state.msgSearch.hits.length
      ? `0 / ${state.msgSearch.hits.length}`
      : "لا نتائج";
  }

  refreshSearchHighlights();

  if (state.msgSearch.hits.length) goToSearchHit(0);
}

function goToSearchHit(index) {
  const hits = state.msgSearch.hits;
  if (!hits.length) return;

  const next = (index + hits.length) % hits.length;
  state.msgSearch.index = next;

  document.querySelectorAll(".bubble-row.search-current").forEach((row) => {
    row.classList.remove("search-current");
  });

  const box = $("#chat-messages");
  const row = box?.querySelector(`[data-message-id="${hits[next]}"]`);

  if (row) {
    row.classList.add("search-hit", "search-current");
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  const count = $("#chat-search-count");
  if (count) count.textContent = `${next + 1} / ${hits.length}`;
}

// تلوين الكلمات المطابقة داخل نص الرسائل
function refreshSearchHighlights() {
  const query = state.msgSearch?.query || "";

  document.querySelectorAll("#chat-messages .bubble-text").forEach((el) => {
    const original = el.dataset.rawText;

    if (original === undefined) return;

    if (!query) {
      if (el.dataset.marked === "1") {
        el.textContent = original;
        el.dataset.marked = "0";
      }
      return;
    }

    const lower = original.toLowerCase();
    let html = "";
    let cursor = 0;
    let found = false;

    while (true) {
      const at = lower.indexOf(query, cursor);
      if (at === -1) break;

      found = true;
      html += escapeHtml(original.slice(cursor, at));
      html += `<mark>${escapeHtml(original.slice(at, at + query.length))}</mark>`;
      cursor = at + query.length;
    }

    if (!found) {
      if (el.dataset.marked === "1") {
        el.textContent = original;
        el.dataset.marked = "0";
      }
      return;
    }

    html += escapeHtml(original.slice(cursor));
    el.innerHTML = html;
    el.dataset.marked = "1";
  });
}

function wireMessageSearch() {
  $("#chat-search-toggle")?.addEventListener("click", () => toggleMessageSearch());
  $("#chat-search-close")?.addEventListener("click", () => toggleMessageSearch(false));
  $("#chat-search-prev")?.addEventListener("click", () => goToSearchHit(state.msgSearch.index - 1));
  $("#chat-search-next")?.addEventListener("click", () => goToSearchHit(state.msgSearch.index + 1));

  $("#chat-search-input")?.addEventListener("input", (event) => {
    runMessageSearch(event.target.value);
  });

  $("#chat-search-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      goToSearchHit(state.msgSearch.index + 1);
    }
    if (event.key === "Escape") toggleMessageSearch(false);
  });
}

// ---------------------------------------------------------------
// 4) الحالة والوسوم والملاحظات والكتم/الأرشفة
// ---------------------------------------------------------------

async function setConversationStatus(conversationId, status) {
  if (!state.me?.is_admin || !conversationId) return;

  const { error } = await supabase.rpc("set_conversation_status", {
    p_conversation_id: conversationId,
    p_status: status,
  });

  if (error) {
    showAuthError("تعذّر تغيير الحالة: " + error.message);
    return;
  }

  state.adminMeta[conversationId] = { ...metaFor(conversationId), status };

  paintContactMeta(conversationId);
  applyContactFilters();
  renderNotesPanel();
  updateChatStatusChip();

  showAuthError(`تم تعيين الحالة: ${STATUS_LABELS[status]}`);
}

async function toggleConversationMute(conversationId) {
  const meta = metaFor(conversationId);
  const next = !meta.muted;

  const { error } = await supabase.rpc("set_conversation_prefs", {
    p_conversation_id: conversationId,
    p_muted: next,
    p_archived: meta.archived,
  });

  if (error) {
    showAuthError("تعذّر التغيير: " + error.message);
    return;
  }

  state.adminMeta[conversationId] = { ...meta, muted: next };
  paintContactMeta(conversationId);
  updateAdminConversationOptions();
  showAuthError(next ? "🔇 تم كتم المحادثة." : "🔔 تم إلغاء الكتم.");
}

async function toggleConversationArchive(conversationId) {
  const meta = metaFor(conversationId);
  const next = !meta.archived;

  const { error } = await supabase.rpc("set_conversation_prefs", {
    p_conversation_id: conversationId,
    p_muted: meta.muted,
    p_archived: next,
  });

  if (error) {
    showAuthError("تعذّر التغيير: " + error.message);
    return;
  }

  state.adminMeta[conversationId] = { ...meta, archived: next };
  paintContactMeta(conversationId);
  applyContactFilters();
  updateAdminConversationOptions();
  showAuthError(next ? "📦 تم أرشفة المحادثة." : "تم إرجاع المحادثة من الأرشيف.");
}

async function logConversationView(conversationId) {
  if (!state.me?.is_admin || !conversationId) return;
  try {
    await supabase.rpc("log_conversation_view", { p_conversation_id: conversationId });
  } catch (_) {}
}

// ---------------------------------------------------------------
// لوحة الملاحظات الداخلية
// ---------------------------------------------------------------

function openNotesPanel() {
  const panel = $("#notes-panel");
  if (!panel || !state.me?.is_admin || !state.activeConversation) return;

  renderNotesPanel();
  panel.classList.remove("hidden");
}

function closeNotesPanel() {
  $("#notes-panel")?.classList.add("hidden");
}

function renderNotesPanel() {
  const conv = state.activeConversation;
  if (!conv) return;

  const meta = metaFor(conv.id);

  const statusBox = $("#notes-status");
  if (statusBox) {
    statusBox.innerHTML = Object.entries(STATUS_LABELS)
      .map(
        ([key, label]) =>
          `<button type="button" data-status="${key}" class="${meta.status === key ? "active" : ""}">${STATUS_ICONS[key]} ${label}</button>`
      )
      .join("");
  }

  const tags = $("#notes-tags");
  if (tags && tags.dataset.filled !== conv.id) {
    tags.value = meta.tags.join("، ");
    tags.dataset.filled = conv.id;
  }

  const text = $("#notes-text");
  if (text && text.dataset.filled !== conv.id) {
    text.value = meta.note || "";
    text.dataset.filled = conv.id;
  }

  const suggestions = $("#notes-tag-suggestions");
  if (suggestions) {
    suggestions.innerHTML = QUICK_TAGS.map(
      (t) => `<button type="button" class="tag-suggestion">${t}</button>`
    ).join("");
  }
}

async function saveNotesPanel() {
  const conv = state.activeConversation;
  const status = $("#notes-status-text");

  if (!conv) return;

  const rawTags = $("#notes-tags")?.value || "";
  const note = $("#notes-text")?.value || "";

  const tags = rawTags
    .split(/[،,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

  setAdminStatusText(status, "جارٍ الحفظ…");

  const { error } = await supabase.rpc("save_conversation_internal", {
    p_conversation_id: conv.id,
    p_tags: tags,
    p_note: note,
  });

  if (error) {
    setAdminStatusText(status, "تعذّر الحفظ: " + error.message, "err");
    return;
  }

  state.adminMeta[conv.id] = { ...metaFor(conv.id), tags, note };

  paintContactMeta(conv.id);
  setAdminStatusText(status, "✔ تم حفظ الملاحظات الداخلية.");
}

function wireNotesPanel() {
  $("#chat-notes-toggle")?.addEventListener("click", openNotesPanel);
  $("#notes-close")?.addEventListener("click", closeNotesPanel);
  $("#notes-save")?.addEventListener("click", saveNotesPanel);

  $("#notes-panel")?.addEventListener("click", (event) => {
    if (event.target.id === "notes-panel") closeNotesPanel();

    const statusBtn = event.target.closest("button[data-status]");
    if (statusBtn) {
      setConversationStatus(state.activeConversation?.id, statusBtn.dataset.status);
    }

    const tagBtn = event.target.closest(".tag-suggestion");
    if (tagBtn) {
      const field = $("#notes-tags");
      if (!field) return;

      const current = field.value.split(/[،,\n]/).map((t) => t.trim()).filter(Boolean);
      if (!current.includes(tagBtn.textContent)) current.push(tagBtn.textContent);

      field.value = current.join("، ");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNotesPanel();
  });
}

// شارة الحالة في رأس المحادثة
function updateChatStatusChip() {
  const chip = $("#chat-status-chip");
  const conv = state.activeConversation;

  if (!chip || !conv || !state.me?.is_admin) return;

  const meta = metaFor(conv.id);

  chip.className = `status-chip st-${meta.status}`;
  chip.textContent = `${STATUS_ICONS[meta.status]} ${STATUS_LABELS[meta.status]}`;
  chip.classList.toggle("hidden", meta.status === "new");
}

// ---------------------------------------------------------------
// 5) التوقيع التلقائي
// ---------------------------------------------------------------

function applySignatureToContent(content) {
  const signature = state.me?.signature;

  if (!content || !signature || !state.me?.is_admin) return content;
  if (content.includes(signature)) return content;

  return `${content}\n\n—\n${signature}`;
}

async function saveMySignature() {
  const input = $("#signature-input");
  const status = $("#signature-status");
  const value = input?.value || "";

  setAdminStatusText(status, "جارٍ الحفظ…");

  const { data, error } = await supabase.rpc("set_my_signature", {
    p_signature: value,
  });

  if (error) {
    setAdminStatusText(status, "تعذّر الحفظ: " + error.message, "err");
    return;
  }

  state.me.signature = data?.signature || null;
  if (input) {
    input.value = state.me.signature || "";
    input.dataset.filled = "1";
  }

  setAdminStatusText(status, "✔ تم حفظ التوقيع — سيظهر أسفل ردودك.");
}

// ---------------------------------------------------------------
// 6) تصدير المحادثة (Excel / PDF)
// ---------------------------------------------------------------

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function conversationFileBase() {
  const conv = state.activeConversation;
  const name = conv?.otherProfile?.display_name || "محادثة";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `${name}-${stamp}`;
}

function exportConversationCSV() {
  const rows = [
    ["التاريخ والوقت", "المرسل", "النص", "النوع", "رابط المرفق"],
  ];

  state.messages.forEach((m) => {
    rows.push([
      new Date(m.created_at).toLocaleString("ar-SA"),
      isMessageMine(m) ? "أنا" : state.me?.is_admin ? "المستخدم" : "المشرف",
      (m.content || "").replace(/[\r\n]+/g, " "),
      m.attachment_type || "نص",
      m.attachment_url || "",
    ]);
  });

  const csv =
    "\uFEFF" +
    rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

  downloadTextFile(`${conversationFileBase()}.csv`, csv, "text/csv;charset=utf-8;");
  showAuthError("✔ تم تصدير المحادثة (ملف CSV يفتح في Excel).");
}

function printConversation() {
  const conv = state.activeConversation;
  if (!conv) return;

  const name = conv.otherProfile?.display_name || "محادثة";

  const body = state.messages
    .map((m) => {
      const mine = isMessageMine(m);
      const who = mine ? "أنا" : name;
      const when = new Date(m.created_at).toLocaleString("ar-SA");
      const text = escapeHtml(m.content || (m.attachment_type ? `[${m.attachment_type}]` : ""));
      return `
        <div class="m ${mine ? "mine" : "theirs"}">
          <div class="head"><b>${escapeHtml(who)}</b><span>${when}</span></div>
          <div class="txt">${text}</div>
        </div>`;
    })
    .join("");

  const win = window.open("", "_blank");
  if (!win) {
    showAuthError("اسمح بالنوافذ المنبثقة للطباعة أو الحفظ PDF.");
    return;
  }

  win.document.write(`<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<title>محادثة ${escapeHtml(name)}</title>
<style>
  body { font-family: "Segoe UI", Tahoma, sans-serif; padding: 24px; color: #111b21; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #667781; font-size: 12px; margin-bottom: 18px; }
  .m { border: 1px solid #e9edef; border-radius: 8px; padding: 8px 12px; margin: 8px 0; page-break-inside: avoid; }
  .m.mine { background: #d9fdd3; }
  .head { display: flex; justify-content: space-between; font-size: 12px; color: #54656f; }
  .txt { white-space: pre-wrap; font-size: 14px; margin-top: 4px; }
  @media print { .m { border-color: #ddd; } }
</style>
</head>
<body>
  <h1>محادثة: ${escapeHtml(name)}</h1>
  <div class="meta">
    عدد الرسائل: ${state.messages.length} ·
    تاريخ الطباعة: ${new Date().toLocaleString("ar-SA")}
  </div>
  ${body}
  <script>setTimeout(function(){ window.print(); }, 350);<\/script>
</body>
</html>`);

  win.document.close();
}

// ---------------------------------------------------------------
// 7) سجل النشاط + الملخص اليومي
// ---------------------------------------------------------------

const ACTIVITY_LABELS = {
  replied: { icon: "💬", label: "ردّ على" },
  viewed: { icon: "👁️", label: "فتح" },
  status: { icon: "🏷️", label: "غيّر حالة" },
  note: { icon: "📝", label: "كتب ملاحظة على" },
};

async function renderActivityFeed() {
  const box = $("#activity-list");
  if (!box || !state.me?.is_admin) return;

  box.innerHTML = `<div class="admin-hint">جارٍ التحميل…</div>`;

  const { data, error } = await supabase.rpc("admin_activity_feed", { p_limit: 60 });

  if (error) {
    box.innerHTML = `<div class="admin-hint err">تعذّر التحميل: ${escapeHtml(error.message)}</div>`;
    return;
  }

  const items = Array.isArray(data) ? data : [];

  if (!items.length) {
    box.innerHTML = `<div class="admin-hint">لا يوجد نشاط مسجَّل بعد.</div>`;
    return;
  }

  box.innerHTML = items
    .map((a) => {
      const info = ACTIVITY_LABELS[a.action] || { icon: "•", label: a.action };
      const when = new Date(a.created_at).toLocaleString("ar-SA", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      return `
        <div class="activity-row">
          <span class="activity-icon">${info.icon}</span>
          <div class="activity-body">
            <div class="activity-line">
              <b>${escapeHtml(a.admin_name || "مشرف")}</b>
              ${info.label}
              <b>${escapeHtml(a.user_name || "")}</b>
            </div>
            ${a.detail ? `<div class="activity-detail">${escapeHtml(a.detail)}</div>` : ""}
            <div class="activity-time">${when}</div>
          </div>
        </div>`;
    })
    .join("");
}

async function renderDailySummary() {
  const box = $("#summary-body");
  if (!box || !state.me?.is_admin) return;

  box.innerHTML = `<div class="admin-hint">جارٍ التحميل…</div>`;

  const { data, error } = await supabase.rpc("daily_summary");

  if (error) {
    box.innerHTML = `<div class="admin-hint err">تعذّر التحميل: ${escapeHtml(error.message)}</div>`;
    return;
  }

  const s = data || {};

  const tile = (label, value) =>
    `<div class="admin-stat"><b>${value ?? 0}</b><span>${label}</span></div>`;

  const top = Array.isArray(s.top_admins) && s.top_admins.length
    ? `<div class="summary-top">
         ${s.top_admins
           .map(
             (t) =>
               `<div class="summary-top-row"><span>${escapeHtml(t.name)}</span><b>${t.replies}</b></div>`
           )
           .join("")}
       </div>`
    : `<div class="admin-hint">لا ردود مسجَّلة اليوم بعد.</div>`;

  box.innerHTML = `
    <div class="admin-stats">
      ${tile("محادثات جديدة", s.new_conversations)}
      ${tile("رسائل واردة", s.messages_received)}
      ${tile("ردود مرسلة", s.messages_sent)}
      ${tile("بانتظار رد", s.waiting_reply)}
      ${tile("غير محسومة", s.unresolved)}
      ${tile("إجمالي المحادثات", s.total_conversations)}
    </div>
    <div class="summary-title">أكثر المشرفين ردّاً اليوم</div>
    ${top}
    <div class="admin-hint">أُعدّ في ${new Date(s.generated_at || Date.now()).toLocaleString("ar-SA")}</div>
  `;
}

// ---------------------------------------------------------------
// 8) الوضع الليلي التلقائي
// ---------------------------------------------------------------

function applyThemeMode() {
  const mode = localStorage.getItem("wa_theme_mode") || "manual";

  let theme = state.theme;

  if (mode === "system") {
    theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } else if (mode === "time") {
    const hour = new Date().getHours();
    theme = hour >= 18 || hour < 6 ? "dark" : "light";
  }

  document.body.setAttribute("data-theme", theme);
  applyChatBackground();
}

function wireThemeMode() {
  const select = $("#theme-mode");
  if (!select || select.dataset.wired === "1") return;

  select.dataset.wired = "1";
  select.value = localStorage.getItem("wa_theme_mode") || "manual";

  select.addEventListener("change", () => {
    localStorage.setItem("wa_theme_mode", select.value);
    applyThemeMode();
  });

  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if ((localStorage.getItem("wa_theme_mode") || "manual") === "system") applyThemeMode();
  });

  // إعادة التقييم كل 10 دقائق في الوضع الزمني
  setInterval(() => {
    if ((localStorage.getItem("wa_theme_mode") || "manual") !== "manual") applyThemeMode();
  }, 10 * 60 * 1000);
}

// ---------------------------------------------------------------
// قائمة خيارات المحادثة: عناصر الإدارة
// ---------------------------------------------------------------

function updateAdminConversationOptions() {
  const conv = state.activeConversation;
  const box = $("#chat-options-menu");
  const existing = $("#chat-admin-options");

  existing?.remove();

  if (!box || !conv || !state.me?.is_admin) return;

  const meta = metaFor(conv.id);

  const wrap = document.createElement("div");
  wrap.id = "chat-admin-options";

  wrap.innerHTML = `
    <button type="button" class="chat-option" data-admin-act="pending">⏳ بانتظار رد</button>
    <button type="button" class="chat-option" data-admin-act="done">✅ تمّت المعالجة</button>
    <button type="button" class="chat-option" data-admin-act="notes">📝 ملاحظات ووسوم</button>
    <button type="button" class="chat-option" data-admin-act="mute">${meta.muted ? "🔔 إلغاء الكتم" : "🔇 كتم المحادثة"}</button>
    <button type="button" class="chat-option" data-admin-act="archive">${meta.archived ? "📤 إخراج من الأرشيف" : "📦 أرشفة المحادثة"}</button>
    <button type="button" class="chat-option" data-admin-act="csv">📊 تصدير Excel (CSV)</button>
    <button type="button" class="chat-option" data-admin-act="print">🖨️ طباعة / حفظ PDF</button>
  `;

  box.appendChild(wrap);

  wrap.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-admin-act]");
    if (!btn) return;

    box.classList.add("hidden");

    const act = btn.dataset.adminAct;

    if (act === "pending" || act === "done") setConversationStatus(conv.id, act);
    else if (act === "notes") openNotesPanel();
    else if (act === "mute") toggleConversationMute(conv.id);
    else if (act === "archive") toggleConversationArchive(conv.id);
    else if (act === "csv") exportConversationCSV();
    else if (act === "print") printConversation();
  });
}

// ---------------------------------------------------------------
// الربط الشامل
// ---------------------------------------------------------------

function wireAdminFeatures() {
  wireContactFilters();
  wireMessageSearch();
  wireNotesPanel();
  wireThemeMode();

  // أي نقرة على عنصر في قائمة الثلاث نقاط تُغلق القائمة
  $("#chat-options-menu")?.addEventListener("click", (event) => {
    if (event.target.closest("button")) {
      $("#chat-options-menu")?.classList.add("hidden");
    }
  });

  $("#btn-refresh-activity")?.addEventListener("click", renderActivityFeed);
  $("#btn-refresh-summary")?.addEventListener("click", renderDailySummary);
  $("#btn-save-signature")?.addEventListener("click", saveMySignature);

  const themeToggle = $("#auth-theme-toggle");
  themeToggle?.addEventListener("click", () => {
    // أي نقرة على زر المظهر تُلغي الوضع التلقائي
    localStorage.setItem("wa_theme_mode", "manual");
    const select = $("#theme-mode");
    if (select) select.value = "manual";
  });
}

function wireChrome() {
  $("#btn-settings")?.addEventListener("click", () => {
    const panel = $("#settings-panel");
    if (!panel) return;

    const opening = panel.classList.contains("hidden");

    panel.classList.toggle("hidden", !opening);
    $("#settings-backdrop")?.classList.toggle("hidden", !opening);

    // نُحمّل بيانات اللوحة عند كل فتح (لتكون طازجة دائماً)
    if (opening) {
      renderAdminTools();
      syncSettingsValues();
    }
  });

  wireAdminTools();
  wirePreferences();
  wireQuickAuth();
  wireAdminFeatures();

  $("#btn-logout")?.addEventListener("click", async () => {
    $("#settings-panel")?.classList.add("hidden");
    $("#settings-backdrop")?.classList.add("hidden");
    await signOut(state.me?.id);
    location.reload();
  });

  $("#auth-lang-toggle")?.addEventListener(
    "click",
    toggleLanguage
  );

  $("#auth-theme-toggle")?.addEventListener(
    "click",
    toggleTheme
  );

  $("#avatar-input")?.addEventListener(
    "change",
    handleAvatarUpload
  );

  $("#btn-remove-avatar")?.addEventListener("click", removeAvatar);
  $("#btn-remove-wallpaper")?.addEventListener("click", removeWallpaper);

  document.addEventListener("click", (event) => {
    const panel = $("#settings-panel");
    const trigger = $("#btn-settings");
    if (panel && !panel.classList.contains("hidden") &&
        !panel.contains(event.target) && event.target !== trigger) {
      panel.classList.add("hidden");
      $("#settings-backdrop")?.classList.add("hidden");
    }
  });

  $("#wallpaper-input")?.addEventListener(
    "change",
    handleWallpaperUpload
  );

  // سطر حالة الإشعارات أسفل زر التفعيل
  if ($("#btn-enable-push") && !$("#push-status")) {
    const status = document.createElement("div");
    status.id = "push-status";
    status.className = "settings-hint";
    status.textContent = pushPermissionLabel();
    $("#btn-enable-push").insertAdjacentElement("afterend", status);
  }

  $("#btn-enable-push")?.addEventListener(
    "click",
    async () => {
      if (!state.me) return;

      const ok = await enablePushNotifications(
        state.me.id
      );

      renderPushStatus(ok ? "الإشعارات مُشغَّلة ✔" : pushPermissionLabel());

      showAuthError(
        ok
          ? "تم تفعيل الإشعارات ✅"
          : "تعذّر التفعيل — تحقق من إذن المتصفح أو مفتاح VAPID"
      );
    }
  );

  // أزرار قسم التثبيت واللغة في الإعدادات
  $("#btn-install-settings")?.addEventListener("click", () => installPWA());
  $("#btn-install-guide")?.addEventListener("click", () => openInstallGuide());

  $("#lang-ar")?.addEventListener("click", () => setLanguage("ar"));
  $("#lang-en")?.addEventListener("click", () => setLanguage("en"));

  // أي تفاعل داخل الإعدادات يُحدّث القيم المعروضة بجانب العناوين
  $("#settings-panel")?.addEventListener("click", () => setTimeout(syncSettingsValues, 80));
  $("#settings-panel")?.addEventListener("change", () => setTimeout(syncSettingsValues, 80));

  wireChatPanel();
  wireConversationOptions();
  wireMediaViewer();
  wireEmojiPicker();
}

// ===============================================================
// LANGUAGE
// ===============================================================

function setLanguage(lang) {
  if (lang !== "ar" && lang !== "en") return;

  state.lang = lang;

  localStorage.setItem("wa_lang", lang);

  state.t = applyLanguage(state.lang);

  syncSettingsValues();
}

function toggleLanguage() {
  setLanguage(state.lang === "ar" ? "en" : "ar");
}

// ===============================================================
// ملخّصات أقسام الإعدادات (القيمة الحالية بجانب كل عنوان)
// ===============================================================

function syncSettingsValues() {
  const put = (sel, text) => {
    const el = $(sel);
    if (el) el.textContent = text || "";
  };

  put("#value-profile", state.me?.display_name || state.me?.email || "");

  const modeEl = $("#theme-mode");
  const mode = (modeEl && modeEl.value) || localStorage.getItem("wa_theme_mode") || "manual";
  const modeLabel =
    mode === "time" ? "تلقائي (وقت)" : mode === "system" ? "تلقائي (جهاز)" : state.theme === "dark" ? "داكن" : "فاتح";
  const font = FONT_SIZES.find((f) => String(f.value) === String(prefs.fontSize));
  put("#value-theme", font ? `${modeLabel} · ${font.label}` : modeLabel);

  put(
    "#value-wallpaper",
    state.me?.wallpaper_url
      ? "مخصّصة"
      : prefs.chatBg === "default"
      ? "افتراضية"
      : CHAT_WALLPAPERS.find((w) => w.id === prefs.chatBg)?.label || "جاهزة"
  );

  const tone = NOTIF_TONES.find((t) => t.id === prefs.tone);
  put("#value-tone", tone ? tone.label : "الافتراضية");

  put(
    "#value-push",
    "Notification" in window && Notification.permission === "granted" ? "مُفعّلة ✔" : "غير مُفعّلة"
  );

  put("#value-install", isPWAInstalled() ? "مثبَّت ✔" : "غير مثبَّت");
  put("#value-lang", state.lang === "en" ? "English" : "العربية");

  $("#lang-ar")?.classList.toggle("active", state.lang !== "en");
  $("#lang-en")?.classList.toggle("active", state.lang === "en");
}

// ===============================================================
// THEME
// ===============================================================

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";

  localStorage.setItem("wa_theme", state.theme);

  document.body.setAttribute(
    "data-theme",
    state.theme
  );

  applyThemeVars();
}

// ===============================================================
// CHAT PANEL
// ===============================================================

function wireReactionChips() {
  const box = $("#chat-messages");
  if (!box || box.dataset.reactWired === "1") return;

  box.dataset.reactWired = "1";

  // نقر على شريحة تفاعل (مُفوَّض ⇒ يعمل بعد أي إعادة رسم)
  box.addEventListener("click", (event) => {
    const chip = event.target.closest(".reaction-chip");
    if (!chip) return;

    const messageId = chip.closest(".bubble-row")?.dataset.messageId;
    const emoji = chip.dataset.emoji;

    if (messageId && emoji) toggleReaction(messageId, emoji);
  });

  // التمرير يُغلق لوحة التفاعلات
  box.addEventListener("scroll", closeQuickReact, { passive: true });
}

function wireChatPanel() {
  wireReactionChips();

  $("#composer-form")?.addEventListener(
    "submit",
    async (e) => {
      e.preventDefault();

      if (state.mediaUploading) return;

      const input = $("#composer-input");
      const text = input.value.trim();

      if (!text) return;

      input.value = "";

      autoGrowComposer();
      updateComposerButtons();

      await sendMessage({
        content: text,
      });
    }
  );

  $("#composer-input")?.addEventListener("input", () => {
    handleTypingInput();
    autoGrowComposer();
    updateComposerButtons();
  });

  // كما في واتساب: Enter يُنزل سطراً جديداً، والإرسال بزر الإرسال
  // (Ctrl+Enter أو ⌘+Enter إرسال سريع لمن يحب)
  $("#composer-input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      submitComposer();
      return;
    }

    // السطر الجديد سلوك textarea الافتراضي — نُحدّث الارتفاع بعده
    setTimeout(autoGrowComposer, 0);
  });

  $("#attach-input")?.addEventListener(
    "change",
    handleAttachmentUpload
  );

  $("#reply-preview-cancel")?.addEventListener(
    "click",
    clearReply
  );

  $("#mic-btn")?.addEventListener(
    "click",
    toggleRecording
  );

  $("#recording-cancel")?.addEventListener(
    "click",
    cancelRecording
  );

  autoGrowComposer();
  updateComposerButtons();
}

function submitComposer() {
  const form = $("#composer-form");
  if (!form) return;

  if (typeof form.requestSubmit === "function") form.requestSubmit();
  else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

// توسيع حقل الكتابة تلقائياً مع كل سطر جديد — حتى حدّ أقصى ثم تمرير داخلي
function autoGrowComposer() {
  const box = $("#composer-input");
  if (!box || box.tagName !== "TEXTAREA") return;

  const MAX_HEIGHT = 132;

  box.style.height = "auto";

  box.style.height = Math.min(box.scrollHeight, MAX_HEIGHT) + "px";
  box.classList.toggle("composer-grown", box.scrollHeight > MAX_HEIGHT);
}

// مثل واتساب: 🎤 والحقل فارغ، و➤ عند الكتابة
function updateComposerButtons() {
  const box = $("#composer-input");
  const send = $("#send-btn");
  const mic = $("#mic-btn");

  if (!box || !send || !mic) return;

  // أثناء التسجيل الصوتي لا نلمس الأزرار (الحقل مخفي والمايك صار زر إيقاف)
  if (box.classList.contains("hidden")) return;

  const hasText = box.value.trim().length > 0;

  mic.classList.toggle("hidden", hasText);
  send.classList.toggle("hidden", !hasText);
}

function wireConversationOptions() {
  $("#chat-options-toggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#chat-options-menu");
    if (!menu) return;
    const willOpen = menu.classList.contains("hidden");
    updateConversationOptions();
    menu.classList.toggle("hidden", !willOpen);
    $("#chat-options-toggle")?.setAttribute("aria-expanded", String(willOpen));
  });

  $("#chat-remove-member")?.addEventListener("click", async () => {
    $("#chat-options-menu")?.classList.add("hidden");
    await removeActiveChatMember();
  });

  document.addEventListener("click", (event) => {
    const menu = $("#chat-options-menu");
    const trigger = $("#chat-options-toggle");
    if (menu && !menu.contains(event.target) && event.target !== trigger) {
      menu.classList.add("hidden");
      trigger?.setAttribute("aria-expanded", "false");
    }
  });
}

function wireMediaViewer() {
  $("#media-viewer-close")?.addEventListener("click", closeMediaViewer);
  $("#media-viewer-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeMediaViewer();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMediaViewer();
  });
}

// ===============================================================
// THEME VARIABLES
// ===============================================================

function applyThemeVars() {
  // الخلفية تتبع تفضيل المستخدم (جاهزة أو مرفوعة) — التفاصيل في applyChatBackground
  applyChatBackground();
}

// ===============================================================
// CONTACT INDEX
// ===============================================================

function resetContactIndex() {
  state.contactRowsByConversation = {};
  state.contactElements = {};
}

function indexContactElement(conversationId, element) {
  if (!conversationId || !element) return;

  state.contactElements[conversationId] = element;
  state.contactRowsByConversation[conversationId] = element;

  element.dataset.conversationId = conversationId;
}

// ===============================================================
// CONTACTS
// ===============================================================

async function loadContacts() {
  if (!state.me) return;

  if (!state.isOnline) {
    const cached = await getCachedContacts();
    renderContactsFromCache(cached);
    return;
  }

  try {
    if (!$("#contact-list")?.children.length &&
        !$("#users-section")?.children.length) {
      renderContactsFromCache(await getCachedContacts());
    }

    await loadContactsFromNetwork();
  } catch (err) {
    console.error("loadContacts failed:", err);

    const cached = await getCachedContacts();
    renderContactsFromCache(cached);
  }

  // بعد رسم القائمة: نجلب حالة/وسوم/كتم كل محادثة ونطبّق الفلتر
  await loadAdminMeta();
}

function renderContactsFromCache(cached) {
  resetContactIndex();

  $("#contact-list").innerHTML = "";

  $("#admins-heading")?.classList.add("hidden");
  $("#admins-section")?.classList.add("hidden");

  $("#users-heading")?.classList.add("hidden");
  $("#users-section")?.classList.add("hidden");

  [...(cached || [])]
    .sort(compareContactsByActivity)
    .forEach((c) => {
      $("#contact-list").appendChild(
        buildContactRow(c, {
          withUnread: !!c._unread,
        })
      );
    });
}

function compareContactsByActivity(first, second) {
  const firstTime = Date.parse(
    first?._lastMessageAt || first?.last_message_at || ""
  ) || 0;
  const secondTime = Date.parse(
    second?._lastMessageAt || second?.last_message_at || ""
  ) || 0;

  return secondTime - firstTime;
}

async function getConversationUnreadCounts(conversationIds) {
  const counts = {};

  if (!state.me || !conversationIds.length) return counts;

  try {
    const { data, error } = await supabase
      .from("messages")
      .select("conversation_id")
      .in("conversation_id", conversationIds)
      .neq("sender_id", state.me.id)
      .or("status.is.null,status.neq.read");

    if (error) {
      console.warn("Unread count query failed:", error?.message || error);
      return counts;
    }

    for (const message of data || []) {
      counts[message.conversation_id] =
        (counts[message.conversation_id] || 0) + 1;
    }

    return counts;
  } catch (error) {
    console.warn("Unread count fetch failed:", error?.message || error);
    return counts;
  }
}

async function loadContactsFromNetwork() {
  resetContactIndex();

  if (!state.me.can_moderate) {
    const [profilesResult, conversationsResult] = await Promise.all([
      supabase
        .from("profiles")
        .select("*")
        .eq("is_admin", true),
      supabase
        .from("conversations")
        .select("*")
        .eq("user_id", state.me.id)
        .order("last_message_at", {
          ascending: false,
        }),
    ]);

    const adminProfiles = profilesResult.data;
    const userConversations = conversationsResult.data;

    const unreadCounts = await getConversationUnreadCounts(
      (userConversations || []).map((conversation) => conversation.id)
    );

    const rows = (adminProfiles || []).map((profile) => {
        const conversation =
          userConversations?.find(
            (c) => c.admin_id === profile.id
          ) || null;

        return {
          ...profile,
          _conversationId: conversation?.id || null,
          _unread: conversation
            ? unreadCounts[conversation.id] || 0
            : 0,
          _lastMessage: conversation?.last_message || null,
          _lastMessageAt: conversation?.last_message_at || null,
          _lastSenderId: conversation?.last_sender_id || null,
          _lastMessageStatus: conversation?.last_message_status || null,
        };
      });

    state.contacts = rows.sort(compareContactsByActivity);

    $("#contact-list").innerHTML = "";

    $("#admins-heading")?.classList.add("hidden");
    $("#admins-section")?.classList.add("hidden");

    $("#users-heading")?.classList.add("hidden");
    $("#users-section")?.classList.add("hidden");

    state.contacts.forEach((c) => {
      $("#contact-list").appendChild(
        buildContactRow(c, {
          withUnread: true,
        })
      );
    });

    await cacheContacts(state.contacts);
    return;
  }

  $("#contact-list").innerHTML = "";

  $("#admins-heading")?.classList.remove("hidden");
  $("#admins-section")?.classList.remove("hidden");

  $("#users-heading")?.classList.remove("hidden");
  $("#users-section")?.classList.remove("hidden");

  const [otherAdminsResult, conversationsResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("*")
      .eq("is_admin", true)
      .neq("id", state.me.id),
    supabase
      .from("conversations")
      .select(
        state.me.is_super_admin
          ? "*, user:profiles!conversations_user_id_fkey(*), owner_admin:profiles!conversations_admin_id_fkey(*)"
          : "*, user:profiles!conversations_user_id_fkey(*)"
      )
      .order("last_message_at", {
        ascending: false,
      }),
  ]);

  const otherAdmins = otherAdminsResult.data;

  const convs = state.me.is_super_admin
    ? conversationsResult.data
    : state.me.is_admin
    ? (conversationsResult.data || []).filter(
        (conversation) => conversation.admin_id === state.me.id
      )
    : (conversationsResult.data || []);
  const convsError = conversationsResult.error;

  if (convsError) {
    console.error(
      "تعذّر جلب المحادثات:",
      convsError
    );
  }

  const userContacts = [];
  const unreadCounts = await getConversationUnreadCounts(
    (convs || []).map((conversation) => conversation.id)
  );

  for (const c of convs || []) {
    userContacts.push({
      ...c.user,
      _conversationId: c.id,
      _adminId: c.admin_id,
      _unread: unreadCounts[c.id] || 0,
      _lastMessage: c.last_message,
      _lastMessageAt: c.last_message_at || null,
      _lastSenderId: c.last_sender_id || null,
      _lastMessageStatus: c.last_message_status || null,
      _ownerAdminName:
        state.me.is_super_admin &&
        c.owner_admin?.id !== state.me.id
          ? c.owner_admin?.display_name
          : null,
    });
  }

  $("#admins-section").innerHTML = "";

  (otherAdmins || []).forEach((c) => {
    $("#admins-section").appendChild(
      buildContactRow(c, {
        withUnread: false,
      })
    );
  });

  $("#users-section").innerHTML = "";

  userContacts.sort(compareContactsByActivity).forEach((c) => {
    $("#users-section").appendChild(
      buildContactRow(c, {
        withUnread: true,
      })
    );
  });

  await cacheContacts([
    ...(otherAdmins || []),
    ...userContacts,
  ]);
}

// ===============================================================
// CONTACT ROW
// ===============================================================

// وقت آخر رسالة كما في واتساب: اليوم = ساعة، أمس = «أمس»،
// خلال الأسبوع = اسم اليوم، وإلا = تاريخ مختصر.
function formatContactTime(iso) {
  if (!iso) return "";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffDays = Math.round((startOfToday - startOfDate) / 86400000);

  const locale = state.lang === "ar" ? "ar-SA" : "en-US";

  if (diffDays <= 0) {
    return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }

  if (diffDays === 1) return "أمس";

  if (diffDays < 7) return date.toLocaleDateString(locale, { weekday: "long" });

  return date.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function buildContactRow(c, opts = {}) {
  const row = document.createElement("div");

  row.className = "contact-row";

  const initials =
    (c.display_name || "?")
      .trim()
      .charAt(0);

  const online =
    c.id &&
    state.onlineMap[c.id];

  const lastAt = c._lastMessageAt;

  const lastMine =
    c._lastSenderId && String(c._lastSenderId) === String(state.me?.id);

  const lastStatus = c._lastMessageStatus || "";

  const ticks =
    lastMine
      ? lastStatus === "read"
        ? '<span class="contact-ticks read">✓✓</span>'
        : lastStatus === "delivered"
        ? '<span class="contact-ticks">✓✓</span>'
        : '<span class="contact-ticks">✓</span>'
      : "";

  row.innerHTML = `
    <div class="avatar">
      ${
        c.avatar_url
          ? `<img src="${escapeHtml(c.avatar_url)}" alt="">`
          : initials
      }

      ${
        online
          ? '<span class="dot-online"></span>'
          : ""
      }
    </div>

    <div class="contact-info">
      <div class="contact-name">
        ${escapeHtml(c.display_name)}
        ${
          c._ownerAdminName
            ? `<span class="owner-admin-badge">${escapeHtml(
                c._ownerAdminName
              )}</span>`
            : ""
        }
      </div>

      <div class="contact-sub">
        ${ticks}
        <span class="contact-preview">${escapeHtml(c._lastMessage || "")}</span>
      </div>
    </div>

    <div class="contact-meta">
      <span class="contact-time">${formatContactTime(lastAt)}</span>

      ${
        opts.withUnread && c._unread
          ? `<div class="unread-badge">${c._unread}</div>`
          : ""
      }
    </div>
  `;


  row.addEventListener("click", () => {
    openConversation(c);
  });

  if (state.me?.is_admin && !c.is_admin && c.id) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "contact-delete-btn";
    deleteButton.title = "حذف المستخدم";
    deleteButton.textContent = "🗑️";
    deleteButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteUser(c);
    });
    row.appendChild(deleteButton);
  }

  if (c._conversationId) {
    indexContactElement(
      c._conversationId,
      row
    );

    row.dataset.unread =
      String(c._unread || 0);
  }

  return row;
}

// ===============================================================
// LIVE CONTACT DOM PATCHING
// ===============================================================

/**
 * تحديث صف المحادثة مباشرة بدون إعادة بناء القائمة كاملة.
 *
 * يقوم بـ:
 * 1. تحديث آخر رسالة.
 * 2. زيادة/تصفير unread.
 * 3. تحريك المحادثة إلى أعلى قسمها.
 * 4. إبقاء مرجع العنصر في state.contactElements.
 */
async function patchContactUIOnNewMessage(
  message,
  options = {}
) {
  if (!message || !message.conversation_id) {
    return;
  }

  const conversationId =
    message.conversation_id;

  const isMine =
    message.sender_id === state.me?.id;

  const isActive =
    state.activeConversation?.id ===
    conversationId;

  const preview =
    messagePreviewText(message);

  let row =
    state.contactElements[
      conversationId
    ];

  // -------------------------------------------------------------
  // إذا كان الصف موجوداً، نعمل DOM patch مباشرة.
  // -------------------------------------------------------------

  if (row) {
    const previewEl =
      row.querySelector(".contact-preview");

    if (previewEl) {
      previewEl.textContent = preview;
    }

    // التكات كما في واتساب (للرسائل الصادرة فقط)
    const ticksEl =
      row.querySelector(".contact-ticks");

    if (ticksEl) {
      const status = message.status || "sent";

      ticksEl.classList.toggle("hidden", !isMine);
      ticksEl.classList.toggle("read", status === "read");

      ticksEl.textContent =
        status === "sent" ? "✓" : "✓✓";
    }

    const timeEl =
      row.querySelector(".contact-time");

    if (timeEl) {
      timeEl.textContent =
        formatContactTime(message.created_at);
    }

    row.dataset.lastMessageAt =
      message.created_at || new Date().toISOString();

    let unread =
      parseInt(
        row.dataset.unread || "0",
        10
      );

    if (
      !isMine &&
      !isActive &&
      options.incrementUnread !== false
    ) {
      unread += 1;
    }

    if (isActive || isMine) {
      unread = 0;
    }

    row.dataset.unread =
      String(unread);

    let badge =
      row.querySelector(".unread-badge");

    if (unread > 0) {
      if (!badge) {
        badge =
          document.createElement("div");

        badge.className =
          "unread-badge";

        const meta = row.querySelector(".contact-meta");

        if (meta) meta.appendChild(badge);
        else row.appendChild(badge);
      }

      badge.textContent =
        String(unread);
    } else {
      badge?.remove();
    }

    moveContactRowToTop(row);

    return;
  }

  // -------------------------------------------------------------
  // إذا لم يكن الصف مفهرساً بعد، نحاول تحديث القائمة من الشبكة.
  // هذا fallback وليس المسار الطبيعي للـ Live UI.
  // -------------------------------------------------------------

  await loadContacts();
}

/**
 * نقل صف المحادثة إلى أعلى القسم الذي يحتويه.
 */
function moveContactRowToTop(row) {
  if (!row || !row.parentElement) return;

  const parent = row.parentElement;

  if (parent.firstElementChild !== row) {
    parent.prepend(row);
  }
}

/**
 * تحديث صف موجود عند وصول تحديث conversations.
 */
function patchContactUIOnConversationUpdate(
  conversation
) {
  if (!conversation?.id) return;

  const row =
    state.contactElements[
      conversation.id
    ];

  if (!row) {
    loadContacts();
    return;
  }

  const sub =
    row.querySelector(".contact-sub");

  if (sub && conversation.last_message !== undefined) {
    sub.textContent =
      conversation.last_message || "";
  }

  if (conversation.last_message_at) {
    row.dataset.lastMessageAt =
      conversation.last_message_at;
  }

  moveContactRowToTop(row);
}

// ===============================================================
// UNREAD BADGES
// ===============================================================

function bumpUnreadBadge(conversationId) {
  const row =
    state.contactElements[
      conversationId
    ];

  if (!row) {
    loadContacts();
    return;
  }

  const current =
    parseInt(
      row.dataset.unread || "0",
      10
    ) + 1;

  row.dataset.unread =
    String(current);

  let badge =
    row.querySelector(".unread-badge");

  if (!badge) {
    badge =
      document.createElement("div");

    badge.className =
      "unread-badge";

    row.appendChild(badge);
  }

  badge.textContent =
    String(current);

  moveContactRowToTop(row);
}

function clearUnreadBadge(conversationId) {
  const row =
    state.contactElements[
      conversationId
    ];

  if (!row) return;

  row.dataset.unread = "0";

  row.querySelector(
    ".unread-badge"
  )?.remove();
}

// ===============================================================
// HTML ESCAPE
// ===============================================================

function escapeHtml(str) {
  const d = document.createElement("div");

  d.textContent = str || "";

  return d.innerHTML;
}

async function openConversationFromNotificationRoute() {
  const conversationId = new URLSearchParams(location.search).get("conversation");
  if (conversationId) await openConversationById(conversationId);
}

async function openConversationById(conversationId) {
  if (!conversationId || !state.me) return;
  const { data: conversation, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !conversation) return;
  const otherId = state.me.can_moderate
    ? conversation.user_id
    : conversation.admin_id;
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", otherId).maybeSingle();
  if (profile) await openConversation({ ...profile, _conversationId: conversationId });
}

// ===============================================================
// CONVERSATION
// ===============================================================

function isActiveChatModerator() {
  return ["admin", "moderator"].includes(
    state.activeConversation?.memberRole
  );
}

function getActiveChatTargetId() {
  const conversation = state.activeConversation;
  if (!conversation || !state.me?.id) return null;
  return String(state.me.id) === String(conversation.userId)
    ? conversation.adminId
    : conversation.userId;
}

function updateConversationOptions() {
  const removeButton = $("#chat-remove-member");
  if (!removeButton) return;

  const canRemove = Boolean(
    isActiveChatModerator() &&
    getActiveChatTargetId() &&
    String(getActiveChatTargetId()) !== String(state.me?.id)
  );

  removeButton.classList.toggle("hidden", !canRemove);

  // خيارات الإدارة (حالة/ملاحظات/كتم/أرشفة/تصدير)
  updateAdminConversationOptions();
}

async function getModerationRoles(userId) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from("chat_members")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "moderator"]);
  if (error) {
    console.warn("تعذّر قراءة أدوار المستخدم:", error.message);
    return [];
  }
  return [...new Set((data || []).map((item) => item.role))];
}

async function getChatMemberRole(conversationId, userId) {
  if (!conversationId || !userId) return null;
  const { data, error } = await supabase
    .from("chat_members")
    .select("role")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn("تعذّر قراءة دور عضو المحادثة:", error.message);
    return null;
  }

  return data?.role || null;
}

async function removeActiveChatMember() {
  const conversation = state.activeConversation;
  const targetUserId = getActiveChatTargetId();

  if (!conversation?.id || !isActiveChatModerator() || !targetUserId) return;
  if (!window.confirm("حذف المستخدم من هذه المحادثة؟")) return;

  const { error } = await supabase.rpc("remove_chat_member", {
    p_conversation_id: conversation.id,
    p_user_id: targetUserId,
  });

  if (error) {
    showAuthError("تعذّر حذف المستخدم من المحادثة: " + error.message);
    return;
  }

  closeChatView();
  await loadContacts();
  showAuthError("تم حذف المستخدم من المحادثة.");
}

async function openConversation(otherProfile) {
  if (!otherProfile.id) {
    showAuthError(
      "هذا المشرف لم يُنشئ حسابه في التطبيق بعد، لا يمكن بدء محادثة معه حالياً."
    );

    return;
  }

  try {
    $("#chat-empty-state")?.classList.add(
      "hidden"
    );

    $("#chat-active")?.classList.remove(
      "hidden"
    );

    clearReply();

    const isStaffOpeningUserChat = Boolean(
      state.me.can_moderate && otherProfile._conversationId
    );
    const userId = isStaffOpeningUserChat || state.me.is_admin
      ? otherProfile.id
      : state.me.id;
    const adminId = isStaffOpeningUserChat
      ? otherProfile._adminId || state.me.id
      : state.me.is_admin
      ? state.me.id
      : otherProfile.id;

    let conversationId =
      otherProfile._conversationId;

    if (!conversationId) {
      const {
        data: existing,
        error: selectErr,
      } = await supabase
        .from("conversations")
        .select("*")
        .eq("user_id", userId)
        .eq("admin_id", adminId)
        .maybeSingle();

      if (selectErr) {
        throw selectErr;
      }

      if (existing) {
        conversationId =
          existing.id;
      } else {
        const {
          data: created,
          error,
        } = await supabase
          .from("conversations")
          .insert({
            user_id: userId,
            admin_id: adminId,
          })
          .select()
          .single();

        if (error) {
          throw error;
        }

        conversationId =
          created.id;
      }
    }

    const memberRole = await getChatMemberRole(conversationId, state.me.id);

    state.activeConversation = {
      id: conversationId,
      userId,
      adminId,
      otherProfile,
      memberRole,
    };

    updateConversationOptions();

    logConversationView(conversationId);
    updateChatStatusChip();
    clearMessageSearch();

    openConversationUIState(
      conversationId
    );

    $("#chat-header-name").textContent =
      otherProfile.display_name;

    $("#chat-header-avatar").src =
      otherProfile.avatar_url || "";

    await refreshPresenceLabel(
      otherProfile.id
    );

    await loadMessages(
      conversationId
    );

    await loadReactionsForConversation();

    subscribeToConversation(
      conversationId
    );

    // ===========================================================
    // LIVE: تصفير العداد فور فتح المحادثة
    // ===========================================================
    clearUnreadBadge(
      conversationId
    );

    await markConversationRead(
      conversationId
    );
  } catch (err) {
    console.error(
      "openConversation failed:",
      err
    );

    showAuthError(
      "تعذّر فتح المحادثة: " +
        (err?.message ||
          "خطأ غير معروف") +
        " — تأكد من تشغيل sql/schema.sql بالكامل ومن صحة SUPABASE_URL/ANON_KEY في js/config.js"
    );

    closeChatView();
  }
}

// ===============================================================
// LOAD MESSAGES
// ===============================================================

async function loadMessages(conversationId) {
  const cached =
    await getCachedMessages(
      conversationId
    );

  if (cached.length) {
    state.messages = cached;
    renderMessages();
  }

  if (!state.isOnline) return;

  const {
    data,
    error,
  } = await supabase
    .from("messages")
    .select("*")
    .eq(
      "conversation_id",
      conversationId
    )
    .order("created_at", {
      ascending: true,
    });

  if (error) {
    console.error(
      "loadMessages failed:",
      error
    );
    return;
  }

  state.messages = data || [];

  renderMessages();

  await cacheMessages(
    conversationId,
    state.messages
  );
}

// ===============================================================
// REACTIONS
// ===============================================================

async function loadReactionsForConversation() {
  state.reactions = {};

  const ids =
    state.messages.map(
      (m) => m.id
    );

  if (!ids.length) return;

  const { data } = await supabase
    .from("message_reactions")
    .select("*")
    .in("message_id", ids);

  (data || []).forEach((r) => {
    if (!state.reactions[r.message_id]) {
      state.reactions[r.message_id] = [];
    }

    state.reactions[
      r.message_id
    ].push(r);
  });

  renderMessages();
}

// ===============================================================
// RENDER MESSAGES
// ===============================================================

function renderMessages() {
  const box =
    $("#chat-messages");

  if (!box) return;

  // ---------------------------------------------------------------
  // رسم تزايدي (Reconciling render)
  //
  // سابقاً كانت القائمة تُفرَّغ بالكامل ثم تُبنى من جديد عند كل تحديث،
  // وهذا كان يسبب "وميض/غمزة" في النصوص والصور: كل فقاعة كانت تعيد
  // تشغيل حركة الدخول، والصور تُحمَّل من جديد، والتمرير يقفز للأسفل.
  // الآن نبني الفقاعة مرة واحدة ونُحدِّث ما تغيّر فقط.
  // ---------------------------------------------------------------

  if (!state.messages.length) {
    if (box.dataset.mode !== "empty") {
      box.innerHTML =
        `<div class="empty-chat">${state.t.no_messages}</div>`;

      box.dataset.mode = "empty";
    }

    return;
  }

  if (box.dataset.mode === "empty") {
    box.innerHTML = "";
  }

  box.dataset.mode = "list";

  // لا نقفز للأسفل إلا إذا كان المستخدم عند آخر الرسائل فعلاً.
  const nearBottom =
    box.scrollHeight - box.scrollTop - box.clientHeight < 140;

  let prev = null;
  const seen = new Set();

  state.messages.forEach((m) => {
    const sig = messageSignature(m);
    seen.add(m.id);

    let el =
      box.querySelector(`[data-message-id="${m.id}"]`);

    if (el) {
      if (el.dataset.sig !== sig) {
        refreshMessageBubble(el, m);
        el.dataset.sig = sig;
      }
    } else {
      el = buildMessageBubble(m);
      el.dataset.sig = sig;

      // الحركة للرسائل الجديدة الواردة فقط، لا لكل الرسائل.
      if (state.animateId === m.id) {
        el.classList.add("is-new");
      }

      if (prev) {
        box.insertBefore(el, prev.nextSibling);
      } else {
        box.insertBefore(el, box.firstChild);
      }
    }

    prev = el;
  });

  // إزالة ما لم يعد موجوداً (رسالة محذوفة).
  Array.from(box.children).forEach((child) => {
    const id = child.dataset?.messageId;
    if (id && !seen.has(id)) {
      child.remove();
    }
  });

  // ذيل الفقاعة لآخر رسالة في كل مجموعة (مثل واتساب)
  const rows = Array.from(box.querySelectorAll(".bubble-row"));

  rows.forEach((row, i) => {
    const side = row.classList.contains("admin-side") ? "admin" : "user";
    const next = rows[i + 1];
    const prev = rows[i - 1];

    const nextSide = next ? (next.classList.contains("admin-side") ? "admin" : "user") : null;
    const prevSide = prev ? (prev.classList.contains("admin-side") ? "admin" : "user") : null;

    row.classList.toggle("tail", nextSide !== side);
    row.classList.toggle("first-of-group", prevSide !== side);
  });

  state.animateId = null;

  if (nearBottom) {
    box.scrollTop = box.scrollHeight;
  }

  // إعادة تلوين نتائج البحث بعد أي إعادة رسم
  refreshSearchHighlights();
}

function messageSignature(m) {
  const reactions =
    state.reactions[m.id] || [];

  const grouped = {};

  reactions.forEach((r) => {
    grouped[r.emoji] =
      (grouped[r.emoji] || 0) + 1;
  });

  return [
    m.status || "",
    m._pending ? "1" : "0",
    state.clickedWelcomeButtons.has(m.id) ? "1" : "0",
    Object.keys(grouped).sort().join(","),
  ].join("|");
}

function formatBubbleTime(m) {
  return new Date(m.created_at).toLocaleTimeString(
    state.lang === "ar" ? "ar-SA" : "en-US",
    { hour: "2-digit", minute: "2-digit" }
  );
}

function buildTicksHtml(m) {
  if (!isMessageMine(m)) return "";

  if (m._pending) {
    return '<span class="ticks">🕓</span>';
  }

  return renderTicks(m.status);
}

function buildReactionsHtml(m) {
  const reactions =
    state.reactions[m.id] || [];

  const grouped = {};

  reactions.forEach((r) => {
    grouped[r.emoji] =
      grouped[r.emoji] || { count: 0, mine: false };

    grouped[r.emoji].count += 1;

    if (r.user_id === state.me.id) {
      grouped[r.emoji].mine = true;
    }
  });

  if (!Object.keys(grouped).length) return "";

  return `
    <div class="reaction-bar">
      ${Object.entries(grouped)
        .map(
          ([emoji, g]) => `
            <span class="reaction-chip ${g.mine ? "mine" : ""}" data-emoji="${escapeHtml(emoji)}" title="اضغط للتفاعل أو الإزالة">
              ${emoji}${g.count > 1 ? ` ${g.count}` : ""}
            </span>
          `
        )
        .join("")}
    </div>
  `;
}

// تحديث موضعي لمحتوى فقاعة قائمة: يمسّ ما تغيّر فقط،
// فلا تُفقد الصور والفيديو ولا يومض النص.
function refreshMessageBubble(el, m) {
  const bubble =
    el.querySelector(".bubble");

  if (!bubble) return;

  const meta =
    bubble.querySelector(".bubble-meta");

  if (meta) {
    meta.innerHTML =
      `<span class="bubble-time">${formatBubbleTime(m)}</span>${buildTicksHtml(m)}`;
  }

  const reactionsHtml =
    buildReactionsHtml(m);

  const current =
    bubble.querySelector(".reaction-bar");

  if (reactionsHtml) {
    if (current) {
      current.outerHTML = reactionsHtml;
    } else {
      bubble.insertAdjacentHTML("beforeend", reactionsHtml);
    }
  } else if (current) {
    current.remove();
  }

  const used =
    state.clickedWelcomeButtons.has(m.id);

  bubble.querySelectorAll(".msg-btn").forEach((btn) => {
    btn.disabled = used || btn.disabled;
  });
}

function findMessageById(id) {
  return state.messages.find(
    (m) => m.id === id
  );
}

function messagePreviewText(m) {
  if (!m) return "";

  if (m.content) {
    return m.content;
  }

  if (m.attachment_type === "image") {
    return "📷 صورة";
  }

  if (m.attachment_type === "audio") {
    return "🎤 رسالة صوتية";
  }

  if (m.attachment_type === "video") {
    return "🎬 فيديو";
  }

  if (m.attachment_type === "file") {
    return "📎 ملف";
  }

  return "";
}

function isMessageMine(message) {
  if (!message || !state.me?.id) {
    return false;
  }

  return String(message.sender_id) === String(state.me.id);
}

function isMessageFromUser(message) {
  if (!message?.sender_id || !state.activeConversation) return false;
  const ordinaryUserId = state.me?.can_moderate
    ? state.activeConversation.userId
    : state.me.id;
  return String(message.sender_id) === String(ordinaryUserId);
}

// ===============================================================
// MESSAGE BUBBLE
// ===============================================================

function buildMessageBubble(m) {
  const mine = isMessageMine(m);
  const userSide = isMessageFromUser(m);

  const div =
    document.createElement("div");

  div.className =
    `bubble-row ${userSide ? "user-side" : "admin-side"} ${
      mine ? "mine" : "theirs"
    }`;

  div.dataset.messageId =
    m.id;

  const time =
    formatBubbleTime(m);

  const ticks =
    buildTicksHtml(m);

  const quoted =
    m.reply_to_id
      ? findMessageById(
          m.reply_to_id
        )
      : null;

  const quotedHtml =
    quoted
      ? `<div class="quoted-reply">${escapeHtml(
          messagePreviewText(quoted)
        )}</div>`
      : "";

  let attach = "";
  let mediaHint = "";

  if (m.attachment_url) {
    if (m.attachment_type === "image") {
      attach = `
        <img
          class="msg-attachment msg-image"
          src="${escapeHtml(m.attachment_url)}"
          alt="صورة مرفقة"
          loading="lazy"
          decoding="async"
          data-media-url="${escapeHtml(m.attachment_url)}"
          data-media-type="image"
        >
      `;
      mediaHint = `<div class="media-save-hint">اضغط مطولا لحفظ الصورة</div>`;
    } else if (m.attachment_type === "video") {
      attach = `
        <video
          class="msg-video"
          controls
          playsinline
          preload="metadata"
          src="${escapeHtml(m.attachment_url)}"
          data-media-url="${escapeHtml(m.attachment_url)}"
          data-media-type="video"
        ></video>
      `;
      mediaHint = `<div class="media-save-hint">اضغط مطولا لحفظ الفيديو</div>`;
    } else if (m.attachment_type === "audio") {
      attach = `
        <audio
          class="msg-audio"
          controls
          preload="metadata"
          src="${escapeHtml(m.attachment_url)}"
        ></audio>
      `;
    } else {
      attach = `
        <a
          class="msg-file"
          href="${escapeHtml(m.attachment_url)}"
          target="_blank"
          rel="noopener noreferrer"
        >
          📎 ${state.t.attach}
        </a>
      `;
    }
  }

  const reactionsHtml =
    buildReactionsHtml(m);

  let buttonsHtml = "";
  const canDeleteMessage = Boolean(isActiveChatModerator() && !m._pending);

  if (
    !mine &&
    Array.isArray(m.buttons) &&
    m.buttons.length
  ) {
    const used =
      state.clickedWelcomeButtons.has(
        m.id
      );

    buttonsHtml = `
      <div class="msg-buttons">
        ${m.buttons
          .map(
            (b) =>
              `
              <button
                type="button"
                class="msg-btn"
                data-value="${escapeHtml(
                  b.value
                )}"
                ${used ? "disabled" : ""}
              >
                ${escapeHtml(b.label)}
              </button>
            `
          )
          .join("")}
      </div>
    `;
  }

  div.innerHTML = `
    <div class="bubble">

      <div class="bubble-actions">
        <button
          class="bubble-action-reply"
          title="${state.t.reply}"
          type="button"
        >
          ↩
        </button>

        <button
          class="bubble-action-react"
          title="React"
          type="button"
        >
          😊
        </button>
        ${canDeleteMessage ? `<button class="bubble-action-delete" title="حذف الرسالة" type="button">🗑️</button>` : ""}
      </div>

      ${quotedHtml}
      ${attach}
      ${mediaHint}

      ${
        m.content
          ? `<div class="bubble-text">${escapeHtml(
              m.content
            )}</div>`
          : ""
      }

      <div class="bubble-meta">
        <span class="bubble-time">
          ${time}
        </span>
        ${ticks}
      </div>

      ${reactionsHtml}
      ${buttonsHtml}

    </div>
  `;

  // نحفظ النص الأصلي لتلوين نتائج البحث لاحقاً بلا فقدان النص
  const bubbleTextEl = div.querySelector(".bubble-text");
  if (bubbleTextEl) bubbleTextEl.dataset.rawText = m.content || "";

  div
    .querySelectorAll(".msg-btn")
    .forEach((btn) => {
      btn.addEventListener(
        "click",
        async () => {
          if (btn.disabled) return;

          state.clickedWelcomeButtons.add(
            m.id
          );

          div
            .querySelectorAll(".msg-btn")
            .forEach(
              (b) =>
                (b.disabled = true)
            );

          await sendMessage({
            content:
              btn.dataset.value,
          });
        }
      );
    });

  div
    .querySelector(
      ".bubble-action-reply"
    )
    ?.addEventListener(
      "click",
      () => setReplyTarget(m)
    );

  div.querySelector(".bubble-action-delete")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await deleteMessage(m);
  });

  const mediaElement = div.querySelector("[data-media-url]");
  if (mediaElement) {
    if (mediaElement.dataset.mediaType === "image") {
      mediaElement.addEventListener("click", () => {
        openMediaViewer(mediaElement.dataset.mediaUrl, "image");
      });
    }
    wireMediaLongPress(mediaElement, m);
  }

  wireMessageLongPress(div, m, canDeleteMessage);

  const reactBtn =
    div.querySelector(
      ".bubble-action-react"
    );

  reactBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    openQuickReact(div, m);
  });

  // النقر على شريحة تفاعل يتم عبر تفويض واحد على قائمة الرسائل (wireReactionChips)
  // حتى يبقى يعمل بعد أي إعادة رسم — لا نربط كل شريحة يدوياً.

  wireSwipeToReply(div, m);

  return div;
}

function openMediaViewer(url, type) {
  const modal = $("#media-viewer-modal");
  const image = $("#media-viewer-image");
  const video = $("#media-viewer-video");
  if (!modal || !url) return;

  image?.classList.toggle("hidden", type !== "image");
  video?.classList.toggle("hidden", type !== "video");

  if (type === "image" && image) {
    image.src = url;
  }

  if (type === "video" && video) {
    video.src = url;
    video.currentTime = 0;
  }

  modal.classList.remove("hidden");
  document.body.classList.add("media-viewer-open");
}

function closeMediaViewer() {
  const modal = $("#media-viewer-modal");
  const image = $("#media-viewer-image");
  const video = $("#media-viewer-video");
  if (!modal) return;

  modal.classList.add("hidden");
  document.body.classList.remove("media-viewer-open");
  if (image) image.removeAttribute("src");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

async function saveMediaAttachment(message) {
  const url = message?.attachment_url;
  if (!url) return;

  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error("تعذّر تنزيل الوسائط");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `whatsapp-${message.id || Date.now()}.${message.attachment_type === "video" ? "mp4" : "jpg"}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    showAuthError("تم حفظ الوسائط على جهازك.");
  } catch (error) {
    // روابط Storage العامة قد تمنع fetch عبر CORS؛ نترك للمتصفح تنزيل الرابط مباشرة.
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "";
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    console.warn("تعذّر تنزيل الوسائط، وتم فتح الرابط:", error);
  }
}

function wireMediaLongPress(mediaElement, message) {
  let timer = null;
  const start = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      event.preventDefault();
      saveMediaAttachment(message);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 650);
  };
  const cancel = () => clearTimeout(timer);

  mediaElement.addEventListener("pointerdown", start);
  mediaElement.addEventListener("pointerup", cancel);
  mediaElement.addEventListener("pointercancel", cancel);
  mediaElement.addEventListener("pointerleave", cancel);
  mediaElement.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    saveMediaAttachment(message);
  });
}

// ===============================================================
// الضغط المطول على رسالة ⇒ لوحة التفاعلات (👍 ❤️ 😂 😮 😢 🙏)
// ---------------------------------------------------------------
//  سلوك واتساب: ضغطة مطوّلة (أو زر الفأرة الأيمن على الحاسوب) تُظهر شريط
//  التفاعلات فوق الرسالة مع تعتيم خفيف، وتُغلق عند اللمس خارجها.
// ===============================================================

let longPressTimer = null;
let longPressStart = null;

// الإيموجيات الستة كما في واتساب (الأول 👍)
const QUICK_REACT_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

let quickReactTarget = null;

// ---------------------------------------------------------------
// التعتيم: يُضاف داخل منطقة المحادثة فقط حتى تبقى الرسالة المضغوطة
// عليها ظاهرة فوقه (z-index أعلى)، وتُغلق اللوحة باللمس عليه.
// ---------------------------------------------------------------
function getReactBackdrop() {
  let backdrop = $("#react-backdrop");

  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "react-backdrop";
    backdrop.className = "react-backdrop hidden";
    backdrop.addEventListener("click", closeQuickReact);
    backdrop.addEventListener("contextmenu", (event) => event.preventDefault());

    (document.querySelector(".chat-panel") || document.body).appendChild(backdrop);
  }

  return backdrop;
}

// ---------------------------------------------------------------
// اللوحة: عنصر واحد ثابت في الصفحة يُوضع فوق الرسالة المضغوطة
// (خارج صندوق التمرير ⇒ لا تُقتطع ولا تتحرك مع التمرير).
// ---------------------------------------------------------------
function getQuickReactPanel() {
  let panel = $("#quick-react-panel-global");

  if (!panel) {
    panel = document.createElement("div");
    panel.id = "quick-react-panel-global";
    panel.className = "quick-react-panel hidden";
    panel.setAttribute("role", "menu");
    panel.innerHTML = QUICK_REACT_EMOJIS.map(
      (emoji) =>
        `<button type="button" class="quick-react-opt" role="menuitem" data-emoji="${emoji}">${emoji}</button>`
    ).join("");

    panel.addEventListener("click", (event) => {
      const emoji = event.target.closest(".quick-react-opt")?.dataset.emoji;
      if (!emoji) return;

      event.stopPropagation();

      const messageId = quickReactTarget?.id;
      closeQuickReact();
      if (messageId) toggleReaction(messageId, emoji);
    });

    document.body.appendChild(panel);
  }

  return panel;
}

function closeQuickReact() {
  document
    .querySelectorAll(".bubble-row.react-open, .bubble-row.long-pressed")
    .forEach((row) => row.classList.remove("react-open", "long-pressed"));

  $("#quick-react-panel-global")?.classList.add("hidden");
  $("#react-backdrop")?.classList.add("hidden");

  quickReactTarget = null;
}

function openQuickReact(row, m) {
  if (!row || !m || m._pending) return;

  const wasOpen = row.classList.contains("react-open");
  closeQuickReact();
  if (wasOpen) return; // الضغط مرة أخرى على نفس الرسالة يُغلق اللوحة

  const bubble = row.querySelector(".bubble") || row;
  const panel = getQuickReactPanel();

  row.classList.add("react-open");

  panel.classList.remove("hidden");
  panel.style.visibility = "hidden";
  panel.style.top = "0px";
  panel.style.left = "0px";

  // الموضع: فوق الرسالة ومحاذاة منتصفها، وإن لم يتّسع نعرضها تحتها
  const rect = bubble.getBoundingClientRect();
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  const margin = 8;
  const gap = 10;

  let top = rect.top - ph - gap;
  if (top < margin) top = Math.min(rect.bottom + gap, window.innerHeight - ph - margin);
  let left = rect.left + rect.width / 2 - pw / 2;

  left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - ph - margin));

  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.visibility = "visible";

  getReactBackdrop().classList.remove("hidden");

  quickReactTarget = m;

  if (navigator.vibrate) {
    try {
      navigator.vibrate(12);
    } catch (_) {
      /* تجاهل */
    }
  }
}

function wireMessageLongPress(row, m, canDelete) {
  const cancel = () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  };

  row.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;

    // الأزرار والوسائط والروابط تعمل طبيعياً
    if (event.target.closest("button, a, input, textarea, audio, video")) return;

    longPressStart = { x: event.clientX, y: event.clientY };
    cancel();

    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (canDelete) row.classList.add("long-pressed");
      openQuickReact(row, m);
    }, 450);
  });

  row.addEventListener("pointermove", (event) => {
    if (!longPressTimer || !longPressStart) return;
    const moved =
      Math.abs(event.clientX - longPressStart.x) +
      Math.abs(event.clientY - longPressStart.y);
    if (moved > 12) cancel(); // تمرير/سحب ⇒ ليس ضغطاً مطوّلاً
  });

  ["pointerup", "pointercancel", "pointerleave"].forEach((name) =>
    row.addEventListener(name, cancel)
  );

  // على الحاسوب: زر الفأرة الأيمن يفتح اللوحة أيضاً
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (canDelete) row.classList.add("long-pressed");
    openQuickReact(row, m);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeQuickReact();
});

window.addEventListener("resize", closeQuickReact);
window.addEventListener("orientationchange", closeQuickReact);

async function deleteMessage(message) {
  if (!isActiveChatModerator() || !message?.id || message._pending) return;
  if (!window.confirm("هل تريد حذف هذه الرسالة؟")) return;

  const { error } = await supabase.rpc("delete_message_as_moderator", {
    p_message_id: message.id,
  });
  if (error) {
    showAuthError("تعذّر حذف الرسالة: " + error.message);
    return;
  }

  state.messages = state.messages.filter((item) => item.id !== message.id);
  await deleteCachedMessage(message.id);
  delete state.reactions[message.id];
  renderMessages();
  await cacheMessages(state.activeConversation.id, state.messages);
}

async function deleteUser(profile) {
  if (!state.me?.is_admin || !profile?.id) return;
  if (!window.confirm(`حذف المستخدم ${profile.display_name || ""}؟ سيتم حذف محادثاته ورسائله.`)) return;
  const { error } = await supabase.functions.invoke("admin-delete-user", { body: { userId: profile.id } });
  if (error) { showAuthError("تعذّر حذف المستخدم: " + error.message); return; }
  if (state.activeConversation?.userId === profile.id) closeChatView();
  await loadContacts();
  showAuthError("تم حذف المستخدم.");
}

async function getConversationRecipientId(conversationId, senderId) {
  const { data: conversation, error } = await supabase
    .from("conversations")
    .select("user_id, admin_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !conversation) return null;
  return String(senderId) === String(conversation.user_id)
    ? conversation.admin_id
    : conversation.user_id;
}

async function sendPushForMessage(message, receiverId) {
  try {
    const { error } = await supabase.functions.invoke("send-push", {
      body: { record: { ...message, receiver_id: receiverId } },
    });
    if (error) console.warn("Push invoke failed:", error.message);
  } catch (error) {
    console.warn("Push invoke failed:", error);
  }
}

// ===============================================================
// SWIPE TO REPLY
// ===============================================================

function wireSwipeToReply(row, message) {
  const bubble =
    row.querySelector(".bubble");

  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;
  let horizontalLock = false;

  const THRESHOLD = 60;

  row.addEventListener(
    "touchstart",
    (e) => {
      startX =
        e.touches[0].clientX;

      startY =
        e.touches[0].clientY;

      dx = 0;
      dragging = true;
      horizontalLock = false;
    },
    { passive: true }
  );

  row.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;

      // لا سحب للإرجاع أثناء فتح لوحة التفاعلات
      if (row.classList.contains("react-open")) return;

      const touch =
        e.touches[0];

      const deltaX =
        touch.clientX -
        startX;

      const deltaY =
        touch.clientY -
        startY;

      if (!horizontalLock) {
        if (
          Math.abs(deltaX) > 10 ||
          Math.abs(deltaY) > 10
        ) {
          horizontalLock =
            Math.abs(deltaX) >
            Math.abs(deltaY);
        }

        if (!horizontalLock) return;
      }

      e.preventDefault();

      dx = Math.max(
        -90,
        Math.min(90, deltaX)
      );

      bubble.style.transform =
        `translateX(${dx}px)`;

      bubble.style.transition =
        "none";

      row.classList.toggle(
        "swipe-armed",
        Math.abs(dx) > THRESHOLD
      );
    },
    { passive: false }
  );

  row.addEventListener(
    "touchend",
    () => {
      if (!dragging) return;

      dragging = false;

      bubble.style.transition =
        "transform .2s ease";

      bubble.style.transform =
        "translateX(0)";

      row.classList.remove(
        "swipe-armed"
      );

      if (
        horizontalLock &&
        Math.abs(dx) > THRESHOLD
      ) {
        setReplyTarget(message);

        if (navigator.vibrate) {
          navigator.vibrate(15);
        }
      }

      dx = 0;
    }
  );
}

// ===============================================================
// TICKS
// ===============================================================

function renderTicks(status) {
  if (status === "read") {
    return `
      <span class="ticks ticks-read">
        ✓✓
      </span>
    `;
  }

  if (status === "delivered") {
    return `
      <span class="ticks">
        ✓✓
      </span>
    `;
  }

  return `
    <span class="ticks">
      ✓
    </span>
  `;
}

// ===============================================================
// REPLY
// ===============================================================

function setReplyTarget(m) {
  state.replyingTo = m;

  $("#reply-preview-text").textContent =
    messagePreviewText(m);

  $("#reply-preview-bar")?.classList.remove(
    "hidden"
  );

  $("#composer-input")?.focus();
}

function clearReply() {
  state.replyingTo = null;

  $("#reply-preview-bar")?.classList.add(
    "hidden"
  );
}

// ===============================================================
// REACTIONS
// ===============================================================

async function toggleReaction(messageId, emoji) {
  if (!messageId || !emoji || !state.me?.id) return;

  const list = state.reactions[messageId] || (state.reactions[messageId] = []);
  const existing = list.find((r) => r.user_id === state.me.id && r.emoji === emoji);

  // ---------------------------------------------------------------
  // تحديث فوري في الواجهة (Optimistic) ثم المزامنة مع القاعدة.
  // واتساب يسمح بتفاعل واحد لكل مستخدم على الرسالة نفسها.
  // ---------------------------------------------------------------
  if (existing) {
    state.reactions[messageId] = list.filter((r) => r !== existing);
  } else {
    state.reactions[messageId] = list.filter(
      (r) => r.user_id !== state.me.id || r.emoji === emoji
    );
    state.reactions[messageId].push({
      id: `tmp-${Date.now()}`,
      message_id: messageId,
      user_id: state.me.id,
      emoji,
    });
  }

  renderMessages();

  try {
    if (existing) {
      if (!String(existing.id).startsWith("tmp-")) {
        await supabase.from("message_reactions").delete().eq("id", existing.id);
      }
    } else {
      const { error } = await supabase.from("message_reactions").insert({
        message_id: messageId,
        user_id: state.me.id,
        emoji,
      });

      if (error) console.error("تعذّر حفظ التفاعل:", error.message);

      // تفاعل واحد فقط لكل مستخدم على الرسالة: نُزيل أي تفاعل آخر لنفس
      // المستخدم على نفس الرسالة (يشمل ما أُضيف في نافذة تحديث سابقة).
      await supabase
        .from("message_reactions")
        .delete()
        .eq("message_id", messageId)
        .eq("user_id", state.me.id)
        .neq("emoji", emoji);
    }
  } catch (error) {
    console.error("خطأ في التفاعل:", error?.message || error);
  }
  await loadReactionsForConversation();
}

// ===============================================================
// MEDIA
// ===============================================================

function getSafeFileExtension(
  file,
  forcedExtension = null
) {
  if (forcedExtension) {
    return forcedExtension
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase();
  }

  const mime =
    (file?.type || "").toLowerCase();

  const mimeMap = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
  };

  if (mimeMap[mime]) {
    return mimeMap[mime];
  }

  const match =
    (file?.name || "").match(
      /\.([a-zA-Z0-9]+)$/
    );

  if (match) {
    const ext =
      match[1]
        .toLowerCase()
        .replace(
          /[^a-z0-9]/g,
          ""
        );

    if (ext) return ext;
  }

  return "bin";
}

function createUploadUUID() {
  if (
    window.crypto &&
    typeof window.crypto.randomUUID ===
      "function"
  ) {
    return window.crypto.randomUUID();
  }

  return (
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
  ).replace(
    /[xy]/g,
    (c) => {
      const r =
        (Math.random() * 16) | 0;

      const v =
        c === "x"
          ? r
          : (r & 0x3) | 0x8;

      return v.toString(16);
    }
  );
}

async function uploadMediaToSupabase(
  file,
  options = {}
) {
  if (!file) {
    throw new Error("لم يتم اختيار ملف");
  }

  if (!state.me) {
    throw new Error(
      "يجب تسجيل الدخول أولاً"
    );
  }

  if (!state.isOnline) {
    throw new Error(
      "لا يمكن رفع الوسائط أثناء عدم الاتصال بالإنترنت"
    );
  }

  const bucket =
    options.bucket || "attachments";

  const folder =
    options.folder || state.me.id;

  const extension =
    getSafeFileExtension(
      file,
      options.extension
    );

  const uuid =
    createUploadUUID();

  const storagePath =
    `${folder}/${uuid}.${extension}`;

  const contentType =
    file.type ||
    options.contentType ||
    "application/octet-stream";

  const { error } =
    await supabase
      .storage
      .from(bucket)
      .upload(
        storagePath,
        file,
        {
          cacheControl: "3600",
          contentType,
          upsert: false,
        }
      );

  if (error) throw error;

  const {
    data: publicData,
  } =
    supabase
      .storage
      .from(bucket)
      .getPublicUrl(
        storagePath
      );

  const publicUrl =
    publicData?.publicUrl;

  if (!publicUrl) {
    throw new Error(
      "تم رفع الملف ولكن تعذّر الحصول على الرابط العام"
    );
  }

  return {
    path: storagePath,
    publicUrl,
    contentType,
    extension,
  };
}

// ===============================================================
// MEDIA UI
// ===============================================================

function getMediaUploadStatusElement() {
  if (
    state.mediaUploadStatusElement &&
    document.body.contains(
      state.mediaUploadStatusElement
    )
  ) {
    return state.mediaUploadStatusElement;
  }

  let el =
    document.querySelector(
      "#media-upload-status"
    );

  if (!el) {
    el =
      document.createElement("div");

    el.id =
      "media-upload-status";

    el.className =
      "media-upload-status hidden";

    el.setAttribute(
      "role",
      "status"
    );

    el.setAttribute(
      "aria-live",
      "polite"
    );

    const composer =
      document.querySelector(
        "#composer-form"
      );

    if (composer) {
      composer.appendChild(el);
    } else {
      document.body.appendChild(el);
    }
  }

  state.mediaUploadStatusElement =
    el;

  return el;
}

function setMediaUploadingState(
  active,
  message = ""
) {
  state.mediaUploading =
    active;

  const status =
    getMediaUploadStatusElement();

  status.textContent =
    message ||
    "جارٍ رفع الوسائط…";

  status.classList.toggle(
    "hidden",
    !active
  );

  const attachInput =
    $("#attach-input");

  if (attachInput) {
    attachInput.disabled =
      active;
  }

  const micBtn =
    $("#mic-btn");

  if (micBtn) {
    micBtn.disabled =
      active;
  }

  const submitBtn =
    $("#composer-form button[type='submit']");

  if (submitBtn) {
    submitBtn.disabled =
      active;
  }

  document.body.classList.toggle(
    "media-uploading",
    active
  );
}

// ===============================================================
// SEND MESSAGE
// ===============================================================

async function sendMessage({
  content,
  attachmentFile = null,
  attachmentType = null,
  attachmentUrl = null,
  attachmentExtension = null,
}) {
  const conv =
    state.activeConversation;

  if (!conv || state.mediaUploading) {
    return;
  }

  // التوقيع التلقائي للمشرف
  content = applySignatureToContent(content);

  const replyToId =
    state.replyingTo?.id || null;

  if (
    !state.isOnline &&
    !attachmentFile &&
    !attachmentUrl
  ) {
    const optimistic = {
      id: `local-${Date.now()}`,
      conversation_id: conv.id,
      sender_id: state.me.id,
      content: content || null,
      attachment_url: null,
      attachment_type: null,
      reply_to_id: replyToId,
      status: "pending",
      created_at:
        new Date().toISOString(),
      _pending: true,
    };

    state.messages.push(optimistic);

    renderMessages();

    await queueOutboxMessage({
      conversation_id: conv.id,
      sender_id: state.me.id,
      content: content || null,
      attachment_url: null,
      attachment_type: null,
      reply_to_id: replyToId,
    });

    clearReply();
    return;
  }

  if (!state.isOnline && attachmentFile) {
    showAuthError(
      "لا يمكن رفع الصورة أو الوسائط بدون اتصال بالإنترنت. أعد المحاولة بعد عودة الاتصال."
    );

    return;
  }

  let finalAttachmentUrl =
    attachmentUrl;

  let finalAttachmentType =
    attachmentType;

  if (attachmentFile) {
    try {
      setMediaUploadingState(
        true,
        attachmentType === "image"
          ? "جارٍ رفع الصورة…"
          : attachmentType === "video"
          ? "جارٍ رفع الفيديو…"
          : attachmentType === "audio"
          ? "جارٍ رفع الرسالة الصوتية…"
          : "جارٍ رفع الملف…"
      );

      const uploaded =
        await uploadMediaToSupabase(
          attachmentFile,
          {
            bucket: "attachments",
            folder: state.me.id,
            extension:
              attachmentExtension,
            contentType:
              attachmentFile.type,
          }
        );

      finalAttachmentUrl =
        uploaded.publicUrl;

      finalAttachmentType =
        attachmentType ||
        (
          attachmentFile.type.startsWith(
            "image/"
          )
            ? "image"
            : attachmentFile.type.startsWith(
                "audio/"
              )
            ? "audio"
            : "file"
        );
    } catch (error) {
      console.error(
        "Media upload failed:",
        error
      );

      showAuthError(
        "تعذّر رفع الوسائط: " +
          (
            error?.message ||
            "خطأ غير معروف"
          )
      );

      return;
    } finally {
      setMediaUploadingState(false);
    }
  }

  if (
    attachmentFile &&
    !finalAttachmentUrl
  ) {
    showAuthError(
      "لم يكتمل رفع الوسائط، لذلك لم يتم إرسال الرسالة."
    );

    return;
  }

  const {
    data: insertedMessage,
    error,
  } = await supabase
    .from("messages")
    .insert({
      conversation_id: conv.id,
      sender_id: state.me.id,
      content: content || null,
      attachment_url:
        finalAttachmentUrl || null,
      attachment_type:
        finalAttachmentType || null,
      reply_to_id: replyToId,
      status: "sent",
    })
    .select()
    .single();

  if (error) {
    showAuthError(error.message);
    return;
  }

  // =============================================================
  // LIVE: تحديث الرسالة في القائمة فور نجاح INSERT
  // =============================================================

  if (insertedMessage) {
    const recipientId = await getConversationRecipientId(conv.id, state.me.id);
    if (recipientId && recipientId !== state.me.id) {
      await sendPushForMessage(insertedMessage, recipientId);
    }

    const exists =
      state.messages.some(
        (m) =>
          m.id === insertedMessage.id
      );

    if (!exists && state.activeConversation?.id === conv.id) {
      state.messages.push(
        insertedMessage
      );

      renderMessages();

      await cacheMessages(
        conv.id,
        [insertedMessage]
      );
    }

    await patchContactUIOnNewMessage(
      insertedMessage,
      {
        incrementUnread: false,
      }
    );
  }

  // ملخّص المحادثة يُحدَّث تلقائياً من تريغر القاعدة bump_conversation_summary

  clearReply();

  await setTyping(false);
}

// ===============================================================
// ATTACHMENT
// ===============================================================

async function handleAttachmentUpload(e) {
  const file =
    e.target.files?.[0];

  const resetInput = () => {
    e.target.value = "";
  };

  if (
    !file ||
    !state.activeConversation
  ) {
    resetInput();
    return;
  }

  if (state.mediaUploading) {
    resetInput();
    return;
  }

  let type = "file";

  if (
    file.type &&
    file.type.startsWith("image/")
  ) {
    type = "image";
  } else if (
    file.type &&
    file.type.startsWith("video/")
  ) {
    type = "video";
  } else if (
    file.type &&
    file.type.startsWith("audio/")
  ) {
    type = "audio";
  }

  await sendMessage({
    content: null,
    attachmentFile: file,
    attachmentType: type,
  });

  resetInput();
}

// ===============================================================
// AVATAR
// ===============================================================

function getStoragePath(bucket, publicUrl) {
  if (!publicUrl) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const index = publicUrl.indexOf(marker);
  return index === -1 ? null : decodeURIComponent(publicUrl.slice(index + marker.length));
}

async function removeStorageFile(bucket, publicUrl) {
  const path = getStoragePath(bucket, publicUrl);
  if (!path) return;
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) console.warn(`تعذّر حذف ملف ${bucket} من Storage:`, error.message);
}

async function removeAvatar() {
  if (!state.me?.id) return;
  const previousUrl = state.me.avatar_url;
  try {
    const { error } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", state.me.id);
    if (error) throw error;
    state.me.avatar_url = null;
    await removeStorageFile("avatars", previousUrl);
    $("#my-avatar")?.removeAttribute("src");
    showAuthError("تم حذف الصورة الشخصية.");
  } catch (error) {
    showAuthError("تعذّر حذف الصورة الشخصية: " + (error?.message || "خطأ غير معروف"));
  }
}

async function removeWallpaper() {
  if (!state.me?.id) return;
  const previousUrl = state.me.wallpaper_url;
  try {
    const { error } = await supabase.from("profiles").update({ wallpaper_url: null }).eq("id", state.me.id);
    if (error) throw error;
    state.me.wallpaper_url = null;
    await removeStorageFile("wallpapers", previousUrl);
    applyThemeVars();
    showAuthError("تم حذف خلفية الدردشة.");
  } catch (error) {
    showAuthError("تعذّر حذف خلفية الدردشة: " + (error?.message || "خطأ غير معروف"));
  }
}

async function handleAvatarUpload(e) {
  const file =
    e.target.files?.[0];

  if (!file) return;

  try {
    setMediaUploadingState(
      true,
      "جارٍ رفع الصورة الشخصية…"
    );

    const uploaded =
      await uploadMediaToSupabase(
        file,
        {
          bucket: "avatars",
          folder: state.me.id,
        }
      );

    await supabase
      .from("profiles")
      .update({
        avatar_url:
          uploaded.publicUrl,
      })
      .eq(
        "id",
        state.me.id
      );

    state.me.avatar_url =
      uploaded.publicUrl;

    if ($("#my-avatar")) {
      $("#my-avatar").src =
        uploaded.publicUrl;
    }
  } catch (error) {
    console.error(
      "Avatar upload failed:",
      error
    );

    showAuthError(
      "تعذّر رفع الصورة الشخصية: " +
        (
          error?.message ||
          "خطأ غير معروف"
        )
    );
  } finally {
    setMediaUploadingState(false);
    e.target.value = "";
  }
}

// ===============================================================
// WALLPAPER
// ===============================================================

async function handleWallpaperUpload(e) {
  const file =
    e.target.files?.[0];

  if (!file) return;

  try {
    setMediaUploadingState(
      true,
      "جارٍ رفع خلفية المحادثة…"
    );

    const uploaded =
      await uploadMediaToSupabase(
        file,
        {
          bucket: "wallpapers",
          folder: state.me.id,
        }
      );

    await supabase
      .from("profiles")
      .update({
        wallpaper_url:
          uploaded.publicUrl,
      })
      .eq(
        "id",
        state.me.id
      );

    state.me.wallpaper_url =
      uploaded.publicUrl;

    applyThemeVars();
  } catch (error) {
    console.error(
      "Wallpaper upload failed:",
      error
    );

    showAuthError(
      "تعذّر رفع خلفية المحادثة: " +
        (
          error?.message ||
          "خطأ غير معروف"
        )
    );
  } finally {
    setMediaUploadingState(false);
    e.target.value = "";
  }
}

// ===============================================================
// VOICE
// ===============================================================

async function toggleRecording() {
  if (state.recording) {
    await stopAndSendRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  if (!state.activeConversation) return;

  if (
    !navigator.mediaDevices ||
    !window.MediaRecorder
  ) {
    showAuthError(
      "التسجيل الصوتي غير مدعوم في هذا المتصفح"
    );

    return;
  }

  if (!state.isOnline) {
    showAuthError(
      "لا يمكن رفع الرسالة الصوتية بدون اتصال بالإنترنت."
    );

    return;
  }

  try {
    const stream =
      await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

    const mediaRecorder =
      new MediaRecorder(stream);

    const chunks = [];

    mediaRecorder.ondataavailable =
      (e) => {
        if (e.data?.size) {
          chunks.push(e.data);
        }
      };

    mediaRecorder.start();

    state.recording = {
      mediaRecorder,
      chunks,
      stream,
      seconds: 0,
      timerInterval: null,
    };

    $("#recording-bar")?.classList.remove(
      "hidden"
    );

    $("#composer-input")?.classList.add(
      "hidden"
    );

    $("#mic-btn").textContent =
      "✅";

    $("#mic-btn")?.classList.add(
      "recording-active"
    );

    state.recording.timerInterval =
      setInterval(() => {
        if (!state.recording) return;

        state.recording.seconds += 1;

        const mm =
          String(
            Math.floor(
              state.recording.seconds /
                60
            )
          ).padStart(2, "0");

        const ss =
          String(
            state.recording.seconds %
              60
          ).padStart(2, "0");

        $("#recording-timer").textContent =
          `${mm}:${ss}`;
      }, 1000);
  } catch (err) {
    console.error(
      "Microphone error:",
      err
    );

    showAuthError(
      "لم يتم منح إذن الوصول للميكروفون"
    );
  }
}

async function stopAndSendRecording() {
  const rec =
    state.recording;

  if (!rec) return;

  const blob =
    await finalizeRecording(rec);

  resetRecordingUI();

  if (!blob) return;

  await sendMessage({
    content: null,
    attachmentFile: blob,
    attachmentType: "audio",
    attachmentExtension: "webm",
  });
}

function cancelRecording() {
  const rec =
    state.recording;

  if (!rec) return;

  finalizeRecording(rec, true);
  resetRecordingUI();
}

function finalizeRecording(
  rec,
  discard = false
) {
  return new Promise((resolve) => {
    clearInterval(
      rec.timerInterval
    );

    rec.mediaRecorder.onstop =
      () => {
        rec.stream
          .getTracks()
          .forEach((t) => t.stop());

        if (discard) {
          resolve(null);
          return;
        }

        const mime =
          rec.mediaRecorder.mimeType ||
          "audio/webm";

        resolve(
          new Blob(
            rec.chunks,
            { type: mime }
          )
        );
      };

    if (
      rec.mediaRecorder.state !==
      "inactive"
    ) {
      rec.mediaRecorder.stop();
    } else {
      resolve(null);
    }
  });
}

function resetRecordingUI() {
  state.recording = null;

  $("#recording-bar")?.classList.add(
    "hidden"
  );

  if ($("#recording-timer")) {
    $("#recording-timer").textContent =
      "00:00";
  }

  $("#composer-input")?.classList.remove(
    "hidden"
  );

  if ($("#mic-btn")) {
    $("#mic-btn").textContent =
      "🎤";

    $("#mic-btn").classList.remove(
      "recording-active"
    );
  }
}

// ===============================================================
// OUTBOX
// ===============================================================

async function flushOutbox() {
  const pending =
    await getOutbox();

  if (!pending.length) return;

  for (const item of pending) {
    const {
      local_id,
      queued_at,
      ...msg
    } = item;

    const {
      data: inserted,
      error,
    } = await supabase
      .from("messages")
      .insert({
        ...msg,
        status: "sent",
      })
      .select()
      .single();

    if (!error) {
      await removeFromOutbox(local_id);

      // ملخّص المحادثة يُحدَّث من تريغر القاعدة bump_conversation_summary
      // (مصدر واحد للحقيقة) — لا نكتبه من التطبيق.
      const outboxConvUpdate = null;
      void outboxConvUpdate;

      if (inserted) {
        const recipientId = await getConversationRecipientId(msg.conversation_id, msg.sender_id);
        if (recipientId && recipientId !== state.me?.id) {
          await sendPushForMessage(inserted, recipientId);
        }
        await patchContactUIOnNewMessage(
          inserted,
          {
            incrementUnread: false,
          }
        );
      }
    }
  }

  if (state.activeConversation) {
    state.messages =
      state.messages.filter(
        (m) => !m._pending
      );

    await loadMessages(
      state.activeConversation.id
    );
  }
}

// ===============================================================
// REALTIME RESUBSCRIBE
// ===============================================================

function scheduleRealtimeReconnect(status) {
  if (!state.me || state.realtimeReconnectTimer) return;

  if (!state.isOnline ||
      (status !== "CHANNEL_ERROR" &&
       status !== "TIMED_OUT")) {
    return;
  }

  console.warn("Realtime channel lost:", status);

  state.realtimeReconnectTimer = setTimeout(() => {
    state.realtimeReconnectTimer = null;
    resubscribeRealtime();
    loadContacts();
  }, 1500);
}

function removeRealtimeChannel(channel) {
  if (!channel) return;

  try {
    supabase.removeChannel(channel);
  } catch (err) {
    console.error(
      "removeRealtimeChannel failed:",
      err
    );
  }
}

function resubscribeRealtime() {
  if (!state.me) return;

  removeRealtimeChannel(
    state.presenceChannel
  );

  state.presenceChannel = null;
  subscribeGlobalPresence();

  removeRealtimeChannel(
    state.inboxChannel
  );

  state.inboxChannel = null;
  subscribeInboxUpdates();

  removeRealtimeChannel(
    state.globalMsgChannel
  );

  state.globalMsgChannel = null;
  subscribeGlobalMessageWatch();

  if (state.activeConversation) {
    subscribeToConversation(
      state.activeConversation.id
    );

    loadMessages(
      state.activeConversation.id
    );
  }
}

// ===============================================================
// REALTIME CONVERSATION
// ===============================================================

function subscribeToConversation(
  conversationId
) {
  removeRealtimeChannel(
    state.msgChannel
  );

  removeRealtimeChannel(
    state.typingChannel
  );

  removeRealtimeChannel(
    state.reactionsChannel
  );

  state.msgChannel =
    supabase
      .channel(
        `messages:${conversationId}`
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          const message = payload.new;
          const isIncoming = String(message.sender_id) !== String(state.me.id);
          const receivedMessage = isIncoming && message.status === "sent"
            ? { ...message, status: "delivered" }
            : message;

          if (isIncoming && message.status === "sent") {
            persistDeliveredStatus(message.id);
          }

          // =======================================================
          // LIVE CHAT APPEND
          // =======================================================

          const exists =
            state.messages.some(
              (m) =>
                m.id === receivedMessage.id
            );

          if (!exists) {
            state.messages.push(receivedMessage);

            state.animateId = receivedMessage.id;

            renderMessages();

            await cacheMessages(
              conversationId,
              [receivedMessage]
            );
          }

          // =======================================================
          // LIVE CONTACT PATCH
          // =======================================================

          await patchContactUIOnNewMessage(
            message,
            {
              incrementUnread:
                message.sender_id !==
                state.me.id,
            }
          );

          if (isIncoming) {
            playNotificationSound();

            // المحادثة مفتوحة، لذلك لا نزيد العداد.
            clearUnreadBadge(
              conversationId
            );

            await markConversationRead(
              conversationId
            );
          }
        }
      )
        .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          state.messages = state.messages.filter((item) => item.id !== payload.old.id);
          await deleteCachedMessage(payload.old.id);
          renderMessages();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const idx =
            state.messages.findIndex(
              (m) =>
                m.id ===
                payload.new.id
            );

          if (idx > -1) {
            state.messages[idx] =
              payload.new;
          }

          renderMessages();
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });

  // =============================================================
  // TYPING
  // =============================================================

  state.typingChannel =
    supabase
      .channel(
        `typing:${conversationId}`
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "typing_status",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row =
            payload.new;

          if (
            row &&
            row.user_id !==
              state.me.id
          ) {
            $("#typing-indicator")?.classList.toggle(
              "hidden",
              !row.is_typing
            );
          }
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });

  // =============================================================
  // REACTIONS
  // =============================================================

  state.reactionsChannel =
    supabase
      .channel(
        `reactions:${conversationId}`
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "message_reactions",
        },
        (payload) => {
          const row =
            payload.new ||
            payload.old;

          if (
            row &&
            state.messages.some(
              (m) =>
                m.id ===
                row.message_id
            )
          ) {
            loadReactionsForConversation();
          }
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });
}

// ===============================================================
// MESSAGE DELIVERY / READ STATUS
// ===============================================================

async function persistDeliveredStatus(messageId) {
  if (!state.me || !messageId) return;

  const { error } = await supabase
    .from("messages")
    .update({ status: "delivered" })
    .eq("id", messageId)
    .neq("sender_id", state.me.id)
    .eq("status", "sent");

  if (error) {
    console.warn("persistDeliveredStatus failed:", error.message);
  }
}

// ===============================================================
// MARK READ
// ===============================================================

async function markConversationRead(
  conversationId
) {
  if (!state.me || !conversationId) {
    return;
  }

  try {
    const { error } =
      await supabase
        .from("messages")
        .update({
          status: "read",
        })
        .eq(
          "conversation_id",
          conversationId
        )
        .neq(
          "sender_id",
          state.me.id
        )
        .neq(
          "status",
          "read"
        );

    if (error) {
      console.error(
        "markConversationRead failed:",
        error
      );
    }
  } catch (err) {
    console.error(
      "markConversationRead network error:",
      err
    );
  }

  // =============================================================
  // LIVE: تصفير الشارة حتى لو لم يكن هناك صف في DOM سابقاً
  // =============================================================

  clearUnreadBadge(
    conversationId
  );

    // تحديث تكات آخر رسالة في صف المحادثة (مثل واتساب)
    try {
      const conv = state.activeConversation;

      const otherId =
        conv && String(conv.user_id) === String(state.me.id)
          ? conv.admin_id
          : conv?.user_id;

      if (otherId && conv?.id === conversationId) {
        await supabase
          .from("conversations")
          .update({ last_message_status: "read" })
          .eq("id", conversationId)
          .eq("last_sender_id", otherId);
      }
    } catch (_) {
      // لا نُفشل القراءة بسبب التكات
    }
}

// ===============================================================
// TYPING
// ===============================================================

function handleTypingInput() {
  if (!state.isOnline || !state.activeConversation?.id) return;

  setTyping(true);

  clearTimeout(
    state.typingTimeout
  );

  state.typingTimeout =
    setTimeout(
      () => setTyping(false),
      2000
    );
}

async function setTyping(isTyping) {
  const conv =
    state.activeConversation;

  if (!conv?.id || !state.me || !state.isOnline) return;

  try {
    const { error } = await supabase
      .from("typing_status")
      .upsert(
        {
          conversation_id:
            conv.id,
          user_id:
            state.me.id,
          is_typing:
            isTyping,
          updated_at:
            new Date().toISOString(),
        },
        {
          onConflict:
            "conversation_id,user_id",
        }
      );

    if (error) {
      console.warn(
        "Typing status skipped due to Supabase permissions/network:",
        error?.message || error
      );
    }
  } catch (err) {
    console.warn(
      "setTyping failed (non-fatal):",
      err?.message || err
    );
  }
}

// ===============================================================
// GLOBAL PRESENCE
// ===============================================================

function subscribeGlobalPresence() {
  if (!state.me) return;

  state.presenceChannel =
    supabase.channel(
      "presence:global",
      {
        config: {
          presence: {
            key: state.me.id,
          },
        },
      }
    );

  state.presenceChannel
    .on(
      "presence",
      {
        event: "sync",
      },
      () => {
        const presState =
          state.presenceChannel.presenceState();

        state.onlineMap = {};

        Object.keys(
          presState
        ).forEach(
          (id) =>
            (state.onlineMap[id] =
              true)
        );

        if (
          state.activeConversation
        ) {
          refreshPresenceLabel(
            state.activeConversation
              .otherProfile.id
          );
        }
      }
    )
    .on(
      "presence",
      {
        event: "leave",
      },
      async ({
        leftPresences,
      }) => {
        if (
          state.activeConversation
        ) {
          const leftIds =
            leftPresences
              .map(
                (p) =>
                  p.presence_ref &&
                  p.key
              )
              .filter(Boolean);

          if (
            leftIds.includes(
              state.activeConversation
                .otherProfile.id
            )
          ) {
            await refreshPresenceLabel(
              state.activeConversation
                .otherProfile.id
            );
          }
        }
      }
    )
    .subscribe(
      async (status) => {
      scheduleRealtimeReconnect(status);

        if (
          status ===
          "SUBSCRIBED"
        ) {
          await state.presenceChannel.track(
            {
              online_at:
                new Date().toISOString(),
            }
          );
        }
      }
    );
}

// ===============================================================
// PRESENCE LABEL
// ===============================================================

async function refreshPresenceLabel(
  otherId
) {
  const label =
    $("#chat-header-status");

  if (!label) return;

  if (
    state.onlineMap[otherId]
  ) {
    label.textContent =
      state.t.online;

    return;
  }

  let profile = null;

  try {
    const {
      data,
      error,
    } = await supabase
      .from("profiles")
      .select("last_seen")
      .eq("id", otherId)
      .single();

    if (error) {
      console.error(
        "refreshPresenceLabel failed:",
        error
      );
    } else {
      profile = data;
    }
  } catch (err) {
    console.error(
      "refreshPresenceLabel network error:",
      err
    );
  }

  if (profile?.last_seen) {
    const d =
      new Date(
        profile.last_seen
      );

    const time =
      d.toLocaleTimeString(
        state.lang === "ar"
          ? "ar-SA"
          : "en-US",
        {
          hour: "2-digit",
          minute: "2-digit",
        }
      );

    const dateLabel =
      d.toDateString() ===
      new Date().toDateString()
        ? time
        : d.toLocaleDateString(
            state.lang === "ar"
              ? "ar-SA"
              : "en-US"
          ) +
          " " +
          time;

    label.textContent =
      `${state.t.last_seen} ${dateLabel}`;
  } else {
    label.textContent = "";
  }
}

// ===============================================================
// INBOX REALTIME
// ===============================================================

function subscribeInboxUpdates() {
  if (!state.me) return;

  state.inboxChannel =
    supabase
      .channel("inbox-updates")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
        },
        (payload) => {
          const row =
            payload.new;

          if (!row) return;

          if (
            row.user_id ===
              state.me.id ||
            row.admin_id ===
              state.me.id
          ) {
            // =====================================================
            // LIVE: تحديث صف المحادثة بدلاً من إعادة تحميل القائمة
            // =====================================================

            if (
              payload.eventType ===
                "UPDATE" ||
              payload.eventType ===
                "INSERT"
            ) {
              patchContactUIOnConversationUpdate(
                row
              );
            }
          }
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });
}

// ===============================================================
// GLOBAL MESSAGE WATCH
// ===============================================================

function subscribeGlobalMessageWatch() {
  if (!state.me) {
    return;
  }

  state.globalMsgChannel =
    supabase
      .channel(
        "global-messages-watch"
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        async (payload) => {
          const msg =
            payload.new;

          if (
            msg.sender_id ===
            state.me.id
          ) {
            // حتى الرسالة الخاصة بنا يجب أن تحدّث preview
            await patchContactUIOnNewMessage(
              msg,
              {
                incrementUnread: false,
              }
            );

            return;
          }

          const isActive =
            state.activeConversation &&
            msg.conversation_id ===
              state.activeConversation.id;

          // ========================================================
          // LIVE UI PATCH
          // ========================================================

          await patchContactUIOnNewMessage(
            msg,
            {
              incrementUnread:
                !isActive,
            }
          );

          // ========================================================
          // إذا كانت المحادثة مفتوحة، تتم إضافتها داخل الشات
          // من subscribeToConversation، لذلك لا نكررها هنا.
          // ========================================================

          if (isActive) {
            clearUnreadBadge(msg.conversation_id);
            if (msg.status === "sent") persistDeliveredStatus(msg.id);
            return;
          }

          if (msg.status === "sent") {
            persistDeliveredStatus(msg.id);
          }

          playNotificationSound();
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });
}

// ===============================================================
// NOTIFICATION SOUND
// ===============================================================

// ===============================================================
// الصوت الداخلي
// -----------------------------------------------------------------
//  • يُشغَّل عند وصول أي رسالة ليست منك (في أي محادثة)
//  • نفتح «قفل الصوت» عند أول لمسة، لأن المتصفحات تمنع التشغيل قبلها
//  • وإن تعذّر تشغيل الملف (لم يُحمّل بعد، أو مُنع) نُولّد نغمة
//    داخل المتصفح نفسها — فيسمع المستخدم تنبيهاً في كل الأحوال
//  • اهتزاز خفيف على الجوال مثل واتساب
// ===============================================================

let audioContext = null;
let audioUnlocked = false;

function getAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;

  if (!Ctx) return null;

  if (!audioContext) {
    try {
      audioContext = new Ctx();
    } catch (_) {
      return null;
    }
  }

  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }

  return audioContext;
}

// نغمة مُولَّدة (لا تحتاج أي ملف) — تعمل دائماً
function playSyntheticTone() {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;

  const blip = (startAt, freq, peak) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, startAt);

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.26);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startAt);
    osc.stop(startAt + 0.28);
  };

  blip(now, 830, 0.30);
  blip(now + 0.12, 1245, 0.22);
}

// نفتح قفل الصوت عند أول تفاعل من المستخدم
function unlockAudio() {
  if (audioUnlocked) return;

  audioUnlocked = true;

  const audio = $("#notification-sound");

  if (audio) {
    audio.volume = 0;

    audio
      .play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
      })
      .catch(() => {})
      .finally(() => {
        audio.volume = 1;
      });
  }

  getAudioContext();
}

function playNotificationSound() {
  const url = toneUrl();

  // النغمة «صامتة» — المستخدم اختار عدم الصوت
  if (!url) return;

  // اهتزاز خفيف على الجوال (مثل واتساب)
  try {
    navigator.vibrate?.([80, 40, 80]);
  } catch (_) {}

  const audio = $("#notification-sound");

  if (!audio) {
    playSyntheticTone();
    return;
  }

  if (audio.dataset.tone !== url) {
    audio.dataset.tone = url;
    audio.src = url;
  }

  try {
    audio.currentTime = 0;
  } catch (_) {}

  audio.play().catch(() => {
    // الملف لم يجهز أو مُنع التشغيل → نغمة مُولَّدة
    playSyntheticTone();
  });
}

// ===============================================================
// EMOJI PICKER
// ===============================================================

function wireEmojiPicker() {
  const btn =
    $("#emoji-toggle");

  const panel =
    $("#emoji-panel");

  if (!btn || !panel) return;

  if (panel.dataset.wired === "1") {
    return;
  }

  panel.dataset.wired = "1";

  const emojis = [
    "😀","😃","😄","😁","😆","😅","😂","🤣","🥲","🥹",
    "☺️","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘",
    "😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐",
    "🤓","😎","🥸","🤩","🥳","😏","😒","😞","😔","😟",
    "😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭",
    "😮‍💨","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱",
    "😨","😰","😥","😓","🫣","🤗","🫡","🤔","🤫","🫠",
    "🤥","😶","😶‍🌫️","😐","😑","😬","🫨","😯","😦","😧",
    "😮","😲","🥱","😴","🤤","😪","😵","😵‍💫","🤐","🥴",
    "🤢","🤮","🤧","😷","🤒",
    "👍","👎","👏","🙌","🫶","👐","🤲","🤝","🙏","✍️",
    "💅","🤳","💪","🦾","🖐️","✋","🤚","👋","🤙","🤌",
    "🤏","👌","🫰","✌️","🤞","🤟","🤘","👈","👉","👆",
    "🖕","👇","☝️","🫵","🤜","🤛",
    "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔",
    "❤️‍🔥","❤️‍🩹","❣️","💕","💞","💓","💗","💖","💘","💝",
    "🫀","✨","💥","🔥",
    "🎉","🎊","🎈","🎂","🎁","⭐","🌟","💫","💯","✅",
    "❌","⚠️","☕","🍕","🍔","🍟","⚽","🏀","🚀","📱",
    "💻","📸","🎵","🎧",
  ];

  panel.innerHTML =
    emojis
      .map(
        (e) =>
          `<span class="emoji-opt">${e}</span>`
      )
      .join("");

  btn.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();

      panel.classList.toggle(
        "hidden"
      );
    }
  );

  panel.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();

      if (
        e.target.classList.contains(
          "emoji-opt"
        )
      ) {
        $("#composer-input").value +=
          e.target.textContent;

        autoGrowComposer();
        updateComposerButtons();

        panel.classList.add(
          "hidden"
        );

        $("#composer-input")?.focus();
      }
    }
  );

  document.addEventListener(
    "click",
    (e) => {
      if (
        !panel.classList.contains(
          "hidden"
        ) &&
        !panel.contains(e.target) &&
        e.target !== btn
      ) {
        panel.classList.add(
          "hidden"
        );
      }
    }
  );
}

// ===============================================================
// PWA INSTALL
// ===============================================================

function setupPWAInstallPrompt() {
  window.addEventListener(
    "beforeinstallprompt",
    (event) => {
      event.preventDefault();

      state.deferredInstallPrompt =
        event;

      refreshPWAInstallButton();
    }
  );

  window.addEventListener(
    "appinstalled",
    () => {
      state.deferredInstallPrompt =
        null;

      hidePWAInstallButton();
    }
  );

  window.addEventListener(
    "DOMContentLoaded",
    () => {
      refreshPWAInstallButton();
    }
  );
}

function getOrCreatePWAInstallButton() {
  let button =
    document.querySelector(
      "#install-app-btn"
    );

  if (!button) {
    button =
      document.querySelector(
        "#pwa-install-btn"
      );
  }

  if (!button) {
    const authScreen =
      $("#auth-screen");

    if (!authScreen) return null;

    const wrapper =
      document.createElement(
        "div"
      );

    wrapper.className =
      "pwa-install-wrapper";

    wrapper.innerHTML = `
      <button
        type="button"
        id="install-app-btn"
        class="pwa-install-btn hidden"
      >
        <span class="pwa-install-icon">📲</span>
        <span class="pwa-install-text">
          <b>ثبّت واتساب الوليد</b>
          <small>افتحه كتطبيق مستقل على جهازك</small>
        </span>
        <span class="pwa-install-arrow">⤓</span>
      </button>
    `;

    authScreen.appendChild(
      wrapper
    );

    button =
      wrapper.querySelector(
        "#install-app-btn"
      );
  }

  if (
    button &&
    !button.dataset.wired
  ) {
    button.dataset.wired =
      "1";

    button.addEventListener(
      "click",
      installPWA
    );
  }

  state.installButton =
    button;

  return button;
}

function refreshPWAInstallButton() {
  const button =
    getOrCreatePWAInstallButton();

  if (!button) return;

  const installed =
    isPWAInstalled();

  // نُظهر البطاقة دائماً قبل التثبيت: إن توفّرت نافذة المتصفح نستخدمها،
  // وإلا نعرض إرشادات التثبيت اليدوية (سفاري مثلاً).
  const canInstall = !installed;

  const authVisible =
    !$("#auth-screen")?.classList.contains(
      "hidden"
    );

  if (
    canInstall &&
    !installed &&
    authVisible
  ) {
    button.classList.remove(
      "hidden"
    );

    button.disabled = false;

    const subtitle = button.querySelector("small");
    if (subtitle) subtitle.textContent = "افتحه كتطبيق مستقل على جهازك";

    button.setAttribute(
      "aria-label",
      "تثبيت التطبيق"
    );
  } else {
    button.classList.add(
      "hidden"
    );
  }
}

function isPWAInstalled() {
  const standalone =
    window.matchMedia &&
    window.matchMedia(
      "(display-mode: standalone)"
    ).matches;

  const fullscreen =
    window.matchMedia &&
    window.matchMedia(
      "(display-mode: fullscreen)"
    ).matches;

  const minimalUi =
    window.matchMedia &&
    window.matchMedia(
      "(display-mode: minimal-ui)"
    ).matches;

  const iosStandalone =
    window.navigator.standalone ===
    true;

  return (
    standalone ||
    fullscreen ||
    minimalUi ||
    iosStandalone
  );
}

// =================================================================
// إرشادات إضافة التطبيق إلى الشاشة الرئيسية
// -----------------------------------------------------------------
//  الآيفون لا يدعم نافذة التثبيت التلقائية إطلاقاً، ولا يُثبَّت التطبيق
//  إلا يدوياً: «إضافة إلى الشاشة الرئيسية» من سفاري. لذلك نعرض خطوات
//  بأيقونات حقيقية بدل رسالة عابرة. وعلى الآيفون لا تعمل إشعارات الويب
//  إلا بعد التثبيت — فالإرشاد هو الطريق إلى الإشعارات أيضاً.
// =================================================================

function isIOSDevice() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isSafariBrowser() {
  const ua = navigator.userAgent;

  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|DuckDuckGo/.test(ua);
}

const IOS_SHARE_ICON =
  '<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 15.5V3.5"/><path d="M8 7.2l4-3.7 4 3.7"/>' +
  '<path d="M5 12.5v6.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5"/></svg>';

function installGuideContent() {
  if (isIOSDevice()) {
    if (!isSafariBrowser()) {
      return {
        title: "ثبّت التطبيق على الآيفون",
        note:
          "متصفحك الحالي لا يدعم التثبيت على الآيفون — <b>افتح الموقع في سفاري</b> ثم اضغط زر التثبيت مرة أخرى.",
        accent: "warn",
        steps: [
          { icon: "🧭", text: "انسخ رابط الموقع من شريط العنوان" },
          { icon: "🧭", text: "افتح تطبيق <b>سفاري</b> والصق الرابط فيه" },
          { icon: "📲", text: "ثم اضغط <b>زر التثبيت</b> وستظهر لك الخطوات" },
        ],
      };
    }

    return {
      title: "أضف واتساب الوليد إلى شاشة الآيفون",
      note: "أربع لمسات من سفاري — <b>وبعد الإضافة تعمل الإشعارات أيضاً</b>.",
      accent: "ok",
      steps: [
        { icon: "__SHARE__", text: "اضغط زر <b>المشاركة</b> في شريط سفاري السفلي" },
        { icon: "➕", text: "اسحب القائمة واختر <b>«إضافة إلى الشاشة الرئيسية»</b>" },
        { icon: "✔", text: "اضغط <b>«إضافة»</b> في أعلى الشاشة" },
        { icon: "📱", text: "افتح التطبيق من آيقونته الجديدة" },
      ],
    };
  }

  if (/Android/i.test(navigator.userAgent)) {
    return {
      title: "أضف واتساب الوليد إلى شاشتك",
      note: "ثلاث لمسات من متصفح الجهاز.",
      accent: "ok",
      steps: [
        { icon: "⋮", text: "اضغط قائمة المتصفح في أعلى الشاشة" },
        { icon: "➕", text: "اختر <b>«تثبيت التطبيق»</b> أو <b>«إضافة إلى الشاشة الرئيسية»</b>" },
        { icon: "✔", text: "أكّد بالضغط على <b>«تثبيت»</b>" },
      ],
    };
  }

  return {
    title: "ثبّت واتساب الوليد على جهازك",
    note: "يعمل كبرنامج مستقل وله أيقونة خاصة.",
    accent: "ok",
    steps: [
      { icon: "⧉", text: "ابحث عن أيقونة <b>التثبيت</b> في شريط العنوان" },
      { icon: "⋮", text: "أو من قائمة المتصفح اختر <b>«تثبيت التطبيق»</b>" },
      { icon: "✔", text: "أكّد بالضغط على <b>«تثبيت»</b>" },
    ],
  };
}

function openInstallGuide() {
  let guide = $("#install-guide");

  if (!guide) {
    guide = document.createElement("div");
    guide.id = "install-guide";
    guide.className = "install-guide hidden";
    guide.innerHTML = `
      <div class="install-guide-backdrop" data-close="1"></div>

      <div class="install-guide-card" role="dialog" aria-modal="true" aria-labelledby="install-guide-title">
        <button class="install-guide-close" type="button" data-close="1" aria-label="إغلاق">✕</button>

        <div class="install-guide-badge">📲</div>
        <h2 id="install-guide-title"></h2>
        <p id="install-guide-note" class="install-guide-note"></p>
        <ol id="install-guide-steps" class="install-guide-steps"></ol>

        <button class="install-guide-ok" type="button" data-close="1">فهمت ✔</button>
      </div>
    `;

    document.body.appendChild(guide);

    guide.addEventListener("click", (event) => {
      if (event.target.closest("[data-close]")) closeInstallGuide();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeInstallGuide();
    });
  }

  const content = installGuideContent();

  $("#install-guide-title").textContent = content.title;
  $("#install-guide-note").innerHTML = content.note;

  const list = $("#install-guide-steps");
  list.innerHTML = "";

  content.steps.forEach((step) => {
    const item = document.createElement("li");

    const badge = document.createElement("span");
    badge.className = "install-guide-step-icon";
    badge.innerHTML =
      step.icon === "__SHARE__" ? IOS_SHARE_ICON : escapeHtml(step.icon);

    const text = document.createElement("span");
    text.className = "install-guide-step-text";
    text.innerHTML = step.text;

    item.appendChild(badge);
    item.appendChild(text);
    list.appendChild(item);
  });

  guide
    .querySelector(".install-guide-card")
    .classList.toggle("warn", content.accent === "warn");

  guide.classList.remove("hidden");
}

function closeInstallGuide() {
  $("#install-guide")?.classList.add("hidden");
}

// =================================================================
// الإشعارات مُشغَّلة افتراضياً
// -----------------------------------------------------------------
//  لا نُجبر المستخدم على البحث عن زر التفعيل:
//   • الإذن ممنوح سابقاً → نُسجّل رمز الجهاز بصمت مع كل دخول
//   • لم يُطلب بعد        → نطلبه عند أول لمسة/نقرة (شرط في سفاري)
//   • محجوب               → لا نُزعج المستخدم برسائل متكررة
// =================================================================

function pushPermissionLabel() {
  if (!("Notification" in window)) return "الإشعارات غير مدعومة في هذا المتصفح";

  if (Notification.permission === "granted") return "الإشعارات مُشغَّلة ✔";

  if (Notification.permission === "denied") {
    return "الإشعارات محجوبة — اسمح بها من إعدادات المتصفح لهذا الموقع";
  }

  return "لم يُطلب إذن الإشعارات بعد";
}

function renderPushStatus(message) {
  const el = $("#push-status");
  if (el) el.textContent = message || pushPermissionLabel();
}

let pushAutoAsked = false;

async function autoEnableNotifications(userId = null) {
  const uid = userId || state.me?.id;

  if (!uid) return false;
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return false;

  if (Notification.permission === "granted") {
    const ok = await registerFcmToken(uid);
    renderPushStatus();
    return ok;
  }

  if (Notification.permission === "denied") {
    renderPushStatus();
    return false;
  }

  if (pushAutoAsked) return false;

  pushAutoAsked = true;

  const ask = async () => {
    document.removeEventListener("pointerdown", ask, true);
    document.removeEventListener("keydown", ask, true);

    try {
      const permission = await Notification.requestPermission();

      if (permission === "granted") {
        const ok = await registerFcmToken(uid);
        renderPushStatus(ok ? "الإشعارات مُشغَّلة ✔" : pushPermissionLabel());
      } else {
        renderPushStatus();
      }
    } catch (error) {
      console.warn("[FCM] auto permission request failed:", error);
    }
  };

  document.addEventListener("pointerdown", ask, true);
  document.addEventListener("keydown", ask, true);

  return false;
}

async function installPWA() {
  const prompt =
    state.deferredInstallPrompt;

  const button =
    state.installButton ||
    getOrCreatePWAInstallButton();

  // لا تتوفر نافذة التثبيت التلقائية (سفاري/آيفون أو متصفح لم يوفّرها بعد)
  // فنعرض إرشادات خطوة بخطوة بدل رسالة عابرة تختفي بسرعة.
  if (!prompt) {
    openInstallGuide();
    return;
  }

  if (button) {
    button.disabled = true;

    const subtitle = button.querySelector("small");

    if (subtitle) subtitle.textContent = "جارٍ فتح نافذة التثبيت…";
    else button.textContent = "جارٍ فتح نافذة التثبيت…";
  }

  try {
    await prompt.prompt();

    const result =
      await prompt.userChoice;

    state.deferredInstallPrompt =
      null;

    if (
      result?.outcome ===
      "accepted"
    ) {
      hidePWAInstallButton();
    } else {
      hidePWAInstallButton();
    }
  } catch (error) {
    console.error(
      "PWA install failed:",
      error
    );

    state.deferredInstallPrompt =
      null;

    hidePWAInstallButton();
  }
}

function hidePWAInstallButton() {
  const button =
    state.installButton ||
    document.querySelector(
      "#install-app-btn, #pwa-install-btn"
    );

  if (!button) return;

  button.classList.add(
    "hidden"
  );
}

// ===============================================================
// SERVICE WORKER
// ===============================================================

if ("serviceWorker" in navigator) {
  window.addEventListener(
    "load",
    () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch(() => {});
    }
  );
}

// ===============================================================
// START
// ===============================================================

document.addEventListener(
  "DOMContentLoaded",
  boot
);
