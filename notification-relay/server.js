const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    console.error("[Relay Config] Error loading config.json:", err.message);
    return {
      port: 3001,
      apiKey: "",
      adminPasswordHash: "",
      sessionSecret: "relay-secret-session",
      telegram: { botToken: "", chatId: "" },
      rateLimit: { windowMs: 60000, maxRequests: 60 }
    };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

let config = loadConfig();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Express Session Middleware
app.use(session({
  secret: config.sessionSecret || "notification-relay-fallback-secret-2026",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: "lax"
  }
}));

// Metrics and recent events ring buffer
const startTime = Date.now();
const stats = {
  totalReceived: 0,
  totalSent: 0,
  totalFailed: 0,
  lastSentAt: null
};
const recentEvents = [];
const MAX_EVENTS = 50;

function logEvent(type, title, status, details = null) {
  const event = {
    id: Date.now() + "-" + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    type,
    title,
    status,
    details
  };
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_EVENTS) {
    recentEvents.pop();
  }
}

// In-memory rate limiter per IP
const rateLimitMap = new Map();
function rateLimiter(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = config.rateLimit?.windowMs || 60000;
  const maxRequests = config.rateLimit?.maxRequests || 60;

  let record = rateLimitMap.get(ip);
  if (!record || now - record.startTime > windowMs) {
    record = { startTime: now, count: 1 };
    rateLimitMap.set(ip, record);
  } else {
    record.count++;
  }

  if (record.count > maxRequests) {
    return res.status(429).json({
      error: "Too many requests. Rate limit exceeded. Please retry later."
    });
  }
  next();
}

// Authentication middleware: accepts either an active session OR a valid API Key
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }

  const authHeader = req.headers["authorization"];
  let providedKey = req.headers["x-api-key"] || req.query.key;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.substring(7).trim();
  }

  if (providedKey && config.apiKey && providedKey === config.apiKey) {
    return next();
  }

  return res.status(401).json({ error: "Unauthorized: Please log in or provide a valid API key." });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Telegram messaging core
async function sendTelegramMessage(text, targetChatId = null, silent = false) {
  const botToken = config.telegram?.botToken;
  const chatId = targetChatId || config.telegram?.chatId;

  if (!botToken || !chatId) {
    throw new Error("Telegram botToken or chatId is not configured in notification relay");
  }

  // Telegram limits text to 4096 chars. Split if needed.
  const chunks = [];
  let remaining = text;
  while (remaining.length > 4000) {
    let splitIdx = remaining.lastIndexOf("\n", 4000);
    if (splitIdx < 1000) splitIdx = 4000;
    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);

  const results = [];
  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: Boolean(silent)
      })
    });

    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Telegram API Error: ${data.description || "Unknown error"} (code ${data.error_code})`);
    }
    results.push(data.result);
  }

  stats.totalSent++;
  stats.lastSentAt = new Date().toISOString();
  return results;
}

// Auth API Routes
app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "Password is required" });
  }

  if (!config.adminPasswordHash) {
    return res.status(500).json({ error: "Admin password hash not configured" });
  }

  const matches = bcrypt.compareSync(password, config.adminPasswordHash);
  if (matches) {
    req.session.authenticated = true;
    req.session.user = "admin";
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Failed to save session" });
      return res.json({ success: true, user: "admin" });
    });
  } else {
    return res.status(401).json({ error: "Invalid password" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get("/api/auth/check", (req, res) => {
  res.json({ authenticated: !!req.session?.authenticated });
});

// Health check (Public)
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "RustMinus Notification Relay",
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString()
  });
});

// Status check (Hides bot token / secrets unless authenticated)
app.get("/api/status", async (req, res) => {
  const isAuth = !!req.session?.authenticated || req.headers["x-api-key"] === config.apiKey;
  const hasToken = !!config.telegram?.botToken;
  const hasChat = !!config.telegram?.chatId;
  let botInfo = null;

  if (hasToken) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getMe`);
      const data = await resp.json();
      if (data.ok) {
        botInfo = {
          id: data.result.id,
          username: data.result.username,
          firstName: data.result.first_name
        };
      }
    } catch (e) {}
  }

  res.json({
    service: "RustMinus Telegram Notification Relay",
    domain: "notificationsrelay.trylocalhost.com",
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    authenticated: isAuth,
    telegram: {
      configured: hasToken && hasChat,
      hasBotToken: hasToken,
      hasChatId: hasChat,
      botInfo: botInfo,
      chatIdMasked: hasChat ? String(config.telegram.chatId).replace(/.(?=.{3})/g, "*") : null
    },
    stats: {
      totalReceived: stats.totalReceived,
      totalSent: stats.totalSent,
      totalFailed: stats.totalFailed,
      lastSentAt: stats.lastSentAt
    },
    recentEvents: isAuth ? recentEvents.slice(0, 10) : []
  });
});

// Notification Relay Handler
async function handleRelayRequest(req, res) {
  stats.totalReceived++;
  const {
    type = "alert", // "alert", "raid", "teamchat", "death", "custom"
    title = "Notification",
    message = "",
    details = {},
    chatId = null,
    level = "info"
  } = req.body;

  const timeStr = new Date().toLocaleTimeString();
  let telegramHtml = "";

  if (type === "raid" || level === "critical") {
    telegramHtml = `🚨 <b>[RAID ALERT]</b> <b>${escapeHtml(title)}</b>\n`;
    if (message) {
      telegramHtml += `\n${escapeHtml(message)}\n`;
    }
    const entries = Object.entries(details || {});
    if (entries.length > 0) {
      telegramHtml += `\n<b>Details:</b>\n`;
      for (const [k, v] of entries) {
        telegramHtml += `• <b>${escapeHtml(k)}:</b> <code>${escapeHtml(String(v))}</code>\n`;
      }
    }
    telegramHtml += `\n⚠️ <i>Defend immediately! Check smart alarms & switches.</i>\n`;
    telegramHtml += `⏱ <i>${timeStr} | rustminus</i>`;
  } else if (type === "death") {
    telegramHtml = `💀 <b>[Teammate Death]</b> <b>${escapeHtml(title)}</b>\n`;
    if (message) telegramHtml += `${escapeHtml(message)}\n`;
    const entries = Object.entries(details || {});
    if (entries.length > 0) {
      for (const [k, v] of entries) {
        telegramHtml += `• <b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}\n`;
      }
    }
    telegramHtml += `⏱ <i>${timeStr}</i>`;
  } else if (type === "teamchat") {
    telegramHtml = `💬 <b>[Team Chat]</b>\n<b>${escapeHtml(title)}:</b> ${escapeHtml(message)}\n⏱ <i>${timeStr}</i>`;
  } else {
    const icon = level === "warning" ? "⚠️" : "🔔";
    telegramHtml = `${icon} <b>[Rust+ Event] ${escapeHtml(title)}</b>\n`;
    if (message) telegramHtml += `\n${escapeHtml(message)}\n`;
    const entries = Object.entries(details || {});
    if (entries.length > 0) {
      telegramHtml += `\n`;
      for (const [k, v] of entries) {
        telegramHtml += `• <b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}\n`;
      }
    }
    telegramHtml += `\n⏱ <i>${timeStr} | rustminus</i>`;
  }

  // Only alarms/raid alerts trigger audible notifications; all other messages are delivered silently
  const isAlarm = (type === "raid" || level === "critical" || type === "alarm");
  const silent = typeof req.body.silent === "boolean" ? req.body.silent : !isAlarm;

  try {
    const result = await sendTelegramMessage(telegramHtml, chatId, silent);
    logEvent(type, title, "delivered", {
      ...details,
      deliveryMode: silent ? "silent (no sound)" : "loud (alarm sound)"
    });
    return res.json({
      success: true,
      delivered: true,
      silent: silent,
      isAlarm: isAlarm,
      messageCount: result.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    stats.totalFailed++;
    logEvent(type, title, "failed", { error: err.message });
    console.error("[Relay Send Error]:", err.message);
    return res.status(502).json({
      success: false,
      error: err.message,
      note: !config.telegram?.botToken || !config.telegram?.chatId
        ? "Telegram botToken or chatId is not yet configured. Please configure them in the relay dashboard or config.json."
        : undefined
    });
  }
}

// Protected Notification Endpoints (Auth via API Key or active Session)
app.post("/api/send", rateLimiter, requireAuth, handleRelayRequest);
app.post("/api/relay/send", rateLimiter, requireAuth, handleRelayRequest);

// Test alert endpoint
app.post("/api/test", rateLimiter, requireAuth, async (req, res) => {
  const testPayload = {
    type: "alert",
    title: "Relay Test Verification",
    message: "This is a test notification dispatched from notificationsrelay.trylocalhost.com to verify your Telegram integration.",
    details: {
      "Relay Domain": "notificationsrelay.trylocalhost.com",
      "Sender App": "rust.trylocalhost.com (rustminus)",
      "Status": "Operational 🚀"
    }
  };
  req.body = testPayload;
  return handleRelayRequest(req, res);
});

// Update Telegram credentials
app.post("/api/config", requireAuth, async (req, res) => {
  const { botToken, chatId } = req.body;

  if (botToken !== undefined) config.telegram.botToken = String(botToken).trim();
  if (chatId !== undefined) config.telegram.chatId = String(chatId).trim();

  let botTestResult = null;
  if (config.telegram.botToken) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getMe`);
      const data = await resp.json();
      if (!data.ok) {
        return res.status(400).json({ error: `Invalid Telegram Bot Token: ${data.description}` });
      }
      botTestResult = data.result;
    } catch (e) {
      return res.status(400).json({ error: `Cannot reach Telegram API: ${e.message}` });
    }
  }

  saveConfig(config);
  logEvent("config", "Telegram Settings Updated", "success", {
    botUsername: botTestResult?.username || null
  });

  return res.json({
    success: true,
    message: "Telegram configuration updated successfully",
    bot: botTestResult
      ? { id: botTestResult.id, username: botTestResult.username, name: botTestResult.first_name }
      : null
  });
});

// Render Login Page (When Unauthenticated)
function renderLoginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Required | Notification Relay</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #0b0f19; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .card { background-color: #151c2c; border: 1px solid #232f45; border-radius: 0.75rem; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4); }
  </style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">
  <div class="max-w-md w-full">
    <!-- Brand / Header -->
    <div class="text-center mb-8">
      <div class="w-16 h-16 rounded-2xl bg-orange-600 mx-auto flex items-center justify-center text-white text-3xl shadow-2xl mb-4 border border-orange-500">
        <i class="fa-solid fa-shield-halved"></i>
      </div>
      <h1 class="text-2xl font-black text-white tracking-tight">Notification Relay</h1>
      <p class="text-sm text-gray-400 mt-1">Security Verification • notificationsrelay.trylocalhost.com</p>
    </div>

    <!-- Login Card -->
    <div class="card p-6 md:p-8">
      <h2 class="text-lg font-bold text-white mb-2 flex items-center gap-2">
        <i class="fa-solid fa-lock text-orange-500"></i> Admin Access
      </h2>
      <p class="text-xs text-gray-400 mb-6">
        Please enter the administrative password to access the Telegram relay control center and live metrics.
      </p>

      <form id="loginForm" class="space-y-5">
        <div>
          <label class="block text-xs font-semibold uppercase text-gray-400 mb-1.5">Master Password</label>
          <div class="relative">
            <input type="password" id="loginPassword" autofocus required
                   placeholder="Enter admin password..."
                   class="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-orange-500 pr-10 font-mono" />
            <button type="button" id="togglePasswordBtn" class="absolute right-3 top-3 text-gray-400 hover:text-white">
              <i class="fa-solid fa-eye" id="toggleIcon"></i>
            </button>
          </div>
        </div>

        <button type="submit" id="submitBtn"
                class="w-full py-3 bg-orange-600 hover:bg-orange-500 text-white font-bold rounded-lg text-sm transition shadow-lg flex items-center justify-center gap-2">
          <i class="fa-solid fa-right-to-bracket"></i> Unlock Relay Dashboard
        </button>

        <div id="errorBox" class="hidden p-3 rounded-lg bg-red-900 bg-opacity-40 border border-red-700 text-red-300 text-xs font-mono"></div>
      </form>

      <div class="mt-6 pt-5 border-t border-gray-800 text-center">
        <span class="text-xs text-gray-500">
          <i class="fa-solid fa-lock text-emerald-400 mr-1"></i> End-to-End TLS Encrypted (HSTS)
        </span>
      </div>
    </div>

    <!-- Companion Link -->
    <div class="text-center mt-6">
      <a href="https://rust.trylocalhost.com" target="_blank" class="text-xs text-gray-400 hover:text-orange-400 transition">
        ← Return to rustminus Companion Dashboard
      </a>
    </div>
  </div>

  <script>
    const form = document.getElementById("loginForm");
    const pwdInput = document.getElementById("loginPassword");
    const errBox = document.getElementById("errorBox");
    const submitBtn = document.getElementById("submitBtn");

    document.getElementById("togglePasswordBtn").addEventListener("click", () => {
      const isPwd = pwdInput.type === "password";
      pwdInput.type = isPwd ? "text" : "password";
      document.getElementById("toggleIcon").className = isPwd ? "fa-solid fa-eye-slash" : "fa-solid fa-eye";
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errBox.classList.add("hidden");
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...';

      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwdInput.value })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> Verified! Redirecting...';
          submitBtn.className = "w-full py-3 bg-emerald-600 text-white font-bold rounded-lg text-sm flex items-center justify-center gap-2";
          setTimeout(() => location.reload(), 400);
        } else {
          errBox.textContent = data.error || "Authentication failed. Invalid password.";
          errBox.classList.remove("hidden");
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Unlock Relay Dashboard';
          pwdInput.select();
        }
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove("hidden");
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Unlock Relay Dashboard';
      }
    });
  </script>
</body>
</html>`;
}

// Render Dashboard (When Authenticated)
function renderDashboard() {
  const hasToken = !!config.telegram?.botToken;
  const hasChat = !!config.telegram?.chatId;
  const isConfigured = hasToken && hasChat;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Notification Relay | rustminus</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #0b0f19; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .card { background-color: #151c2c; border: 1px solid #232f45; border-radius: 0.75rem; }
    .card-header { border-bottom: 1px solid #232f45; }
    .badge-green { background-color: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-yellow { background-color: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-red { background-color: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    pre { background-color: #0f1422; border: 1px solid #1e293b; }
  </style>
</head>
<body class="min-h-screen p-4 md:p-8">
  <div class="max-w-6xl mx-auto space-y-6">

    <!-- Header -->
    <header class="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-gray-800 gap-4">
      <div>
        <div class="flex items-center space-x-3">
          <div class="w-10 h-10 rounded-lg bg-orange-600 flex items-center justify-center text-white font-bold text-xl shadow-lg">
            <i class="fa-solid fa-paper-plane"></i>
          </div>
          <div>
            <h1 class="text-2xl font-black tracking-tight text-white flex items-center gap-2">
              Telegram Notification Relay
              <span class="text-xs font-mono py-0.5 px-2 rounded-full ${isConfigured ? "badge-green" : "badge-yellow"}">
                ${isConfigured ? '<i class="fa-solid fa-check-circle"></i> Operational' : '<i class="fa-solid fa-triangle-exclamation"></i> Needs Telegram Setup'}
              </span>
            </h1>
            <p class="text-sm text-gray-400">Secure Webhook & Alert Bridge for 
              <a href="https://rust.trylocalhost.com" target="_blank" class="text-orange-400 hover:underline">rust.trylocalhost.com</a>
            </p>
          </div>
        </div>
      </div>
      <div class="flex items-center space-x-3 text-sm">
        <span class="px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 font-mono text-xs border border-gray-700">
          <i class="fa-solid fa-lock text-green-400 mr-1"></i> HTTPS / TLS Active
        </span>
        <button id="logoutBtn" class="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-red-900 hover:text-red-300 text-gray-300 font-mono text-xs border border-gray-700 transition flex items-center gap-1.5">
          <i class="fa-solid fa-right-from-bracket"></i> Log Out
        </button>
      </div>
    </header>

    <!-- Metrics Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card p-5">
        <div class="text-gray-400 text-xs font-medium uppercase tracking-wider">Telegram Status</div>
        <div class="mt-2 text-xl font-bold flex items-center space-x-2">
          ${isConfigured ? '<span class="text-green-400"><i class="fa-brands fa-telegram"></i> Connected</span>' : '<span class="text-yellow-400"><i class="fa-solid fa-clock"></i> Pending Bot Token</span>'}
        </div>
        <div class="text-xs text-gray-500 mt-1">${hasChat ? "Target Chat configured" : "No Chat ID set"}</div>
      </div>

      <div class="card p-5">
        <div class="text-gray-400 text-xs font-medium uppercase tracking-wider">Total Received</div>
        <div class="mt-2 text-2xl font-bold text-white font-mono" id="statReceived">${stats.totalReceived}</div>
        <div class="text-xs text-gray-500 mt-1">Dispatches from rustminus</div>
      </div>

      <div class="card p-5">
        <div class="text-gray-400 text-xs font-medium uppercase tracking-wider">Delivered to Telegram</div>
        <div class="mt-2 text-2xl font-bold text-green-400 font-mono" id="statSent">${stats.totalSent}</div>
        <div class="text-xs text-gray-500 mt-1">Confirmed successful</div>
      </div>

      <div class="card p-5">
        <div class="text-gray-400 text-xs font-medium uppercase tracking-wider">Relay Failures</div>
        <div class="mt-2 text-2xl font-bold text-red-400 font-mono" id="statFailed">${stats.totalFailed}</div>
        <div class="text-xs text-gray-500 mt-1">Delivery errors</div>
      </div>
    </div>

    <!-- Main Section: Configuration & Test -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

      <!-- Telegram Setup Card -->
      <div class="card">
        <div class="card-header p-4 flex items-center justify-between">
          <h2 class="font-bold text-white flex items-center gap-2">
            <i class="fa-brands fa-telegram text-blue-400"></i> Telegram Credentials
          </h2>
          <span class="text-xs text-gray-400 font-mono">Authenticated Session</span>
        </div>
        <div class="p-5 space-y-4">
          <p class="text-sm text-gray-300">
            Create a Telegram bot using <a href="https://t.me/BotFather" target="_blank" class="text-orange-400 hover:underline">@BotFather</a> on Telegram, then add your bot to your group/chat and obtain the Chat ID.
          </p>

          <form id="configForm" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold text-gray-400 uppercase mb-1">Telegram Bot Token</label>
              <input type="password" id="inputBotToken" placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ" 
                     value="${config.telegram?.botToken || ""}"
                     class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-orange-500 font-mono" required />
              <p class="text-xs text-gray-500 mt-1">Obtained from Telegram @BotFather</p>
            </div>

            <div>
              <label class="block text-xs font-semibold text-gray-400 uppercase mb-1">Telegram Chat ID</label>
              <input type="text" id="inputChatId" placeholder="e.g. -100123456789 or 987654321" 
                     value="${config.telegram?.chatId || ""}"
                     class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-orange-500 font-mono" required />
              <p class="text-xs text-gray-500 mt-1">Target chat, channel, or personal user ID</p>
            </div>

            <div class="pt-2 flex items-center justify-between">
              <button type="submit" class="px-5 py-2.5 bg-orange-600 hover:bg-orange-500 text-white font-semibold rounded-lg text-sm transition flex items-center gap-2 shadow-lg">
                <i class="fa-solid fa-save"></i> Save Telegram Config
              </button>
              <span id="configFeedback" class="text-xs font-mono"></span>
            </div>
          </form>
        </div>
      </div>

      <!-- Test Dispatch Card -->
      <div class="card">
        <div class="card-header p-4 flex items-center justify-between">
          <h2 class="font-bold text-white flex items-center gap-2">
            <i class="fa-solid fa-bolt text-yellow-400"></i> Dispatch Test Notification
          </h2>
          <span class="text-xs text-gray-400 font-mono">Instant Verification</span>
        </div>
        <div class="p-5 space-y-4">
          <p class="text-sm text-gray-300">
            Verify that your Telegram bot is actively relaying Rust+ notifications to your specified chat.
          </p>

          <form id="testForm" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold text-gray-400 uppercase mb-1">Notification Type</label>
              <select id="testType" class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-orange-500">
                <option value="alert">🔕 Standard Alert (Delivered Silently)</option>
                <option value="raid">🚨 Raid Alert (Audible Alarm 🔊)</option>
                <option value="teamchat">🔕 Squad TeamChat (Delivered Silently)</option>
                <option value="death">🔕 Teammate Death Alert (Delivered Silently)</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-semibold text-gray-400 uppercase mb-1">Alert Title</label>
              <input type="text" id="testTitle" value="Core TC Raid Alarm"
                     class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-orange-500" />
            </div>

            <div>
              <label class="block text-xs font-semibold text-gray-400 uppercase mb-1">Alert Message</label>
              <input type="text" id="testMessage" value="Smart alarm triggered at Main Base! Defend now!"
                     class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-orange-500" />
            </div>

            <div class="pt-2 flex items-center justify-between">
              <button type="submit" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-sm transition flex items-center gap-2 shadow-lg">
                <i class="fa-solid fa-paper-plane"></i> Send Test Alert to Telegram
              </button>
              <span id="testFeedback" class="text-xs font-mono"></span>
            </div>
          </form>
        </div>
      </div>

    </div>

    <!-- Integration Guide & API Documentation -->
    <div class="card p-6 space-y-4">
      <h2 class="text-lg font-bold text-white flex items-center gap-2">
        <i class="fa-solid fa-code text-orange-400"></i> Relay API & Integration Guide
      </h2>
      <p class="text-sm text-gray-300">
        Applications (including <code class="text-orange-400 font-mono">rustminus</code>) send notifications to this relay via HTTPS:
      </p>

      <div class="space-y-2">
        <div class="text-xs font-mono text-gray-400 uppercase font-semibold">1. HTTP POST Payload Structure</div>
        <pre class="p-4 rounded-lg text-xs font-mono text-gray-300 overflow-x-auto">curl -X POST https://notificationsrelay.trylocalhost.com/api/send \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${config.apiKey}" \\
  -d '{
    "type": "raid",
    "title": "Smart Alarm 20001 Triggered",
    "message": "Base perimeter breach detected!",
    "details": {
      "Server": "Rust Official Vanilla",
      "Entity ID": "20001",
      "Sector": "G14"
    }
  }'</pre>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
        <div>
          <div class="text-xs font-mono text-gray-400 uppercase font-semibold mb-1">Relay API Key</div>
          <div class="p-3 bg-gray-900 border border-gray-800 rounded-lg flex items-center justify-between">
            <span class="text-xs font-mono text-orange-400 truncate select-all">${config.apiKey}</span>
          </div>
        </div>
        <div>
          <div class="text-xs font-mono text-gray-400 uppercase font-semibold mb-1">Target Endpoint</div>
          <div class="p-3 bg-gray-900 border border-gray-800 rounded-lg flex items-center justify-between">
            <span class="text-xs font-mono text-blue-400 select-all">https://notificationsrelay.trylocalhost.com/api/send</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Recent Events Log -->
    <div class="card">
      <div class="card-header p-4 flex items-center justify-between">
        <h2 class="font-bold text-white flex items-center gap-2">
          <i class="fa-solid fa-history text-gray-400"></i> Recent Relayed Notifications Log
        </h2>
        <span class="text-xs text-gray-500 font-mono">Real-Time In-Memory Buffer</span>
      </div>
      <div class="p-4 overflow-x-auto">
        <table class="w-full text-left text-xs font-mono">
          <thead>
            <tr class="text-gray-400 border-b border-gray-800">
              <th class="pb-2">Time</th>
              <th class="pb-2">Type</th>
              <th class="pb-2">Title</th>
              <th class="pb-2">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-800" id="eventsTableBody">
            ${recentEvents.length === 0 ? '<tr><td colspan="4" class="py-4 text-center text-gray-600 italic">No notifications relayed yet. Send a test to see it here!</td></tr>' : ""}
            ${recentEvents.map(e => `
              <tr>
                <td class="py-2.5 text-gray-400">${new Date(e.timestamp).toLocaleTimeString()}</td>
                <td class="py-2.5"><span class="px-2 py-0.5 rounded ${e.type === "raid" ? "badge-red" : e.type === "death" ? "badge-yellow" : "badge-green"}">${e.type}</span></td>
                <td class="py-2.5 text-gray-200">${escapeHtml(e.title)}</td>
                <td class="py-2.5 font-bold ${e.status === "delivered" ? "text-green-400" : "text-red-400"}">${e.status}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <script>
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      location.reload();
    });

    document.getElementById("configForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fb = document.getElementById("configFeedback");
      fb.className = "text-xs font-mono text-yellow-400";
      fb.innerText = "Validating with Telegram...";

      try {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            botToken: document.getElementById("inputBotToken").value,
            chatId: document.getElementById("inputChatId").value
          })
        });
        const data = await res.json();
        if (res.ok) {
          fb.className = "text-xs font-mono text-green-400";
          fb.innerText = "Saved! Bot @" + (data.bot?.username || "connected");
          setTimeout(() => location.reload(), 1200);
        } else {
          fb.className = "text-xs font-mono text-red-400";
          fb.innerText = data.error || "Failed to update configuration";
        }
      } catch (err) {
        fb.className = "text-xs font-mono text-red-400";
        fb.innerText = err.message;
      }
    });

    document.getElementById("testForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fb = document.getElementById("testFeedback");
      fb.className = "text-xs font-mono text-yellow-400";
      fb.innerText = "Dispatching...";

      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: document.getElementById("testType").value,
            title: document.getElementById("testTitle").value,
            message: document.getElementById("testMessage").value,
            details: { "Source": "Relay WebUI Test", "Timestamp": new Date().toISOString() }
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          fb.className = "text-xs font-mono text-green-400";
          fb.innerText = "Delivered to Telegram! ✅";
          setTimeout(() => location.reload(), 1500);
        } else {
          fb.className = "text-xs font-mono text-red-400";
          fb.innerText = data.error || "Delivery failed";
        }
      } catch (err) {
        fb.className = "text-xs font-mono text-red-400";
        fb.innerText = err.message;
      }
    });
  </script>
</body>
</html>`;
}

// Root Route: Protected with Login Screen
app.get("/", (req, res) => {
  if (!req.session || !req.session.authenticated) {
    return res.send(renderLoginPage());
  }
  return res.send(renderDashboard());
});

const PORT = config.port || 3001;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[Notification Relay] Server running on 127.0.0.1:${PORT}`);
  console.log(`[Notification Relay] Domain: notificationsrelay.trylocalhost.com`);
  console.log(`[Notification Relay] Auth Protection: Enabled`);
});
