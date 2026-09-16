require("dotenv").config();

// TERMINAL_MESSAGE_ONLY_PATCH
const ORIGINAL_CONSOLE_LOG = console.log.bind(console);
const ORIGINAL_CONSOLE_ERROR = console.error.bind(console);
console.log = () => {};
console.warn = () => {};

function getTerminalMessageId(msg) {
  return msg?.id?._serialized || msg?.id?.$1 || msg?.id?.toString?.() || "unknown";
}

function terminalMessage(msg, replyText) {
  ORIGINAL_CONSOLE_LOG(
    `[MSG] ${getTerminalMessageId(msg)} | Message: ${msg?.body || ""} | Reply: ${replyText || ""}`
  );
}

const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const Groq = require("groq-sdk");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = "127.0.0.1";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA = path.join(__dirname, "data");
const SETTINGS = path.join(DATA, "settings.json");
const CHATS = path.join(DATA, "chats.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(CHATS)) fs.writeFileSync(CHATS, "{}");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const DEFAULT_SETTINGS = {
  enabled: false,
  mode: "everyone",
  provider: "groq",
  groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  maxTokens: 180,
  mood: "casual",
  dailyQuota: 100,
  systemPrompt: "Reply naturally and casually like me. Keep replies concise unless more detail is necessary.",
  usage: { date: "", replies: 0, incoming: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
};

const MOODS = {
  casual: "Casual: relaxed, friendly, natural WhatsApp language. Use contractions and light humor when appropriate.",
  formal: "Formal: polite, professional, clear, and composed. Avoid slang and excessive emojis.",
  sad: "Sad: subdued, emotionally low, quiet, and slightly melancholic. Do not overdo it or sound dramatic.",
  romantic: "Romantic: warm, affectionate, playful, and caring. Keep it natural and avoid being overly dramatic.",
  vulgar: "Vulgar: use strong casual slang and profanity when it fits the conversation. Do not use hateful slurs, threats, or abusive harassment.",
  angry: "Angry: irritated, blunt, and firm. Express frustration naturally without threats, hate, or harassment.",
};

const GROQ_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3-32b"];

function settings() {
  const stored = readJson(SETTINGS, {});
  const merged = { ...DEFAULT_SETTINGS, ...stored, usage: { ...DEFAULT_SETTINGS.usage, ...(stored.usage || {}) } };
  const today = new Date().toISOString().slice(0, 10);
  if (merged.usage.date !== today) {
    merged.usage = { date: today, replies: 0, incoming: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    writeJson(SETTINGS, merged);
  }
  return merged;
}

function chats() { return readJson(CHATS, {}); }
function recordIncoming() { const s = settings(); s.usage.incoming += 1; writeJson(SETTINGS, s); }
function recordReply() { const s = settings(); s.usage.replies += 1; writeJson(SETTINGS, s); }
function recordUsage(u) {
  const s = settings();
  s.usage.inputTokens += Number(u.inputTokens || 0);
  s.usage.outputTokens += Number(u.outputTokens || 0);
  s.usage.totalTokens += Number(u.totalTokens || 0);
  writeJson(SETTINGS, s);
}
function quotaRemaining(s = settings()) {
  return Math.max(0, Number(s.dailyQuota || 0) - Number(s.usage.replies || 0));
}

const gemini = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

const READY_GRACE_MS = 60000;
const READY_RECOVERY_MS = 120000;
const READY_MAX_WAIT_MS = 240000;
const READY_WATCH_INTERVAL_MS = 15000;

let clientReady = false;
let readyViaWatchdog = false;
let recoveryAttempts = 0;
let readyDeadline = 0;
let readinessWatchdogTimer = null;
let qrVisible = false;
let clientState = "starting";
let lastError = "";
let waDiagnostics = {
  checkedAt: null,
  label: "not_checked",
  url: null,
  title: null,
  readyState: null,
  wwebjs: null,
  store: null,
  webpackChunk: null,
  bodyText: null,
  error: null,
};
let diagnosticTimer = null;
const startedAt = Date.now();
const pending = new Set();

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const executablePath = chromeCandidates.find(fs.existsSync);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, ".wwebjs_auth") }),
  puppeteer: {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
});

process.on("unhandledRejection", (reason) => {
  ORIGINAL_CONSOLE_ERROR("Unhandled promise rejection (likely whatsapp-web.js internal):", reason?.stack || reason?.message || reason);
});

async function runWhatsAppDiagnostic(label = "probe") {
  try {
    const page = client.pupPage;
    if (!page) throw new Error("client.pupPage is not available yet");

    const pageInfo = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      wwebjs: typeof window.WWebJS,
      store: typeof window.Store,
      webpackChunk: typeof window.webpackChunkwhatsapp_web_client,
      bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
    }));

    waDiagnostics = {
      checkedAt: new Date().toISOString(),
      label,
      ...pageInfo,
      error: null,
    };
  } catch (error) {
    waDiagnostics = {
      ...waDiagnostics,
      checkedAt: new Date().toISOString(),
      label,
      error: error.message || String(error),
    };
    ORIGINAL_CONSOLE_ERROR(`WhatsApp diagnostic [${label}] failed:`, error.message || error);
  }
}

function startWhatsAppDiagnostics() {
  if (diagnosticTimer) clearInterval(diagnosticTimer);
  runWhatsAppDiagnostic("authenticated");
  diagnosticTimer = setInterval(() => {
    if (clientReady) {
      clearInterval(diagnosticTimer);
      diagnosticTimer = null;
      return;
    }
    runWhatsAppDiagnostic("waiting_for_ready");
  }, 10000);
}

async function probeReadiness() {
  const page = client.pupPage;
  if (!page) return null;
  try {
    return await page.evaluate(() => {
      const socket = window.require?.("WAWebSocketModel")?.Socket;
      return {
        url: window.location.href,
        wwebjs: typeof window.WWebJS,
        hasSynced: socket ? !!socket.hasSynced : null,
        socketState: socket ? String(socket.state || "") : null,
        onAddMessageEvent: typeof window.onAddMessageEvent,
        onMessageAckEvent: typeof window.onMessageAckEvent,
        onAppStateHasSyncedEvent: typeof window.onAppStateHasSyncedEvent,
        inputVisible: !!document.querySelector('div[contenteditable="true"], textarea, input[type="text"]'),
      };
    });
  } catch {
    return null;
  }
}

function markReady(source) {
  if (clientReady) return;
  clientReady = true;
  readyViaWatchdog = source === "watchdog";
  qrVisible = false;
  clientState = "ready";
  if (diagnosticTimer) { clearInterval(diagnosticTimer); diagnosticTimer = null; }
  if (readinessWatchdogTimer) { clearInterval(readinessWatchdogTimer); readinessWatchdogTimer = null; }
}

async function runReadinessWatchdog() {
  if (!client.pupPage || clientReady) return;
  const elapsed = Date.now() - startedAt;
  const p = await probeReadiness();
  if (!p) return;

  const pipelineWired =
    p.wwebjs === "object" &&
    p.onAddMessageEvent === "function" &&
    p.socketState === "CONNECTED" &&
    p.hasSynced === true;

  if (pipelineWired) {
    if (Date.now() >= readyDeadline) {
      runWhatsAppDiagnostic("watchdog_ready");
      markReady("watchdog");
    }
    return;
  }

  if (elapsed >= READY_MAX_WAIT_MS) {
    lastError = `WhatsApp client did not reach a verified ready state in ${Math.floor(elapsed / 1000)}s (WWebJS=${p.wwebjs}, socket=${p.socketState}, hasSynced=${p.hasSynced}). WhatsApp Web may have shipped an incompatible update.`;
    if (diagnosticTimer) { clearInterval(diagnosticTimer); diagnosticTimer = null; }
    if (readinessWatchdogTimer) { clearInterval(readinessWatchdogTimer); readinessWatchdogTimer = null; }
    ORIGINAL_CONSOLE_ERROR(lastError);
    return;
  }

  if (recoveryAttempts === 0 && elapsed >= READY_RECOVERY_MS) {
    recoveryAttempts++;
    await client.pupPage.reload({ waitUntil: "load", timeout: 30000 }).catch(() => {});
    readyDeadline = Date.now() + READY_GRACE_MS;
  }
}

const SYNC_READY_MAX_WAIT_MS = 150000;
const SEND_TIMEOUT_MS = 30000;
const SEND_RETRY_DELAY_MS = 8000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageSyncProbe() {
  const page = client.pupPage;
  if (!page) return null;
  try {
    return await page.evaluate(() => {
      const socket = window.require?.("WAWebSocketModel")?.Socket;
      const body = (document.body?.innerText || "").replace(/\s+/g, " ").toLowerCase();
      return {
        downloading: body.includes("messages are downloading") || body.includes("your messages are downloading") || body.includes("don't close this window"),
        wwebjs: typeof window.WWebJS,
        socketState: socket ? String(socket.state || "") : null,
        hasSynced: socket ? !!socket.hasSynced : null,
      };
    });
  } catch {
    return null;
  }
}

async function waitForSendReady() {
  const deadline = Date.now() + SYNC_READY_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const p = await pageSyncProbe();
    if (p && p.wwebjs === "object" && p.socketState === "CONNECTED" && p.hasSynced === true && !p.downloading) {
      return true;
    }
    await sleep(5000);
  }
  return false;
}

async function timed(promise, ms, tag) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendReplyWithRetry(msg, replyText) {
  const chatId = msg.from;
  const attempts = [
    { name: "msg.reply", fn: () => msg.reply(replyText) },
    { name: "sendMessage(sendSeen:false)", fn: () => client.sendMessage(chatId, replyText, { sendSeen: false }) },
    { name: "sendMessage(quoted)", fn: () => client.sendMessage(chatId, replyText, { sendSeen: false, quotedMessageId: msg.id?._serialized }) },
  ];

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      await timed(attempt.fn(), SEND_TIMEOUT_MS, attempt.name);
      terminalMessage(msg, replyText);
      return { ok: true, method: attempt.name };
    } catch (e) {
      lastError = `Reply send attempt ${i + 1} (${attempt.name}) failed: ${e.message}`;
      ORIGINAL_CONSOLE_ERROR(lastError);
      if (i < attempts.length - 1) await sleep(SEND_RETRY_DELAY_MS);
    }
  }
  return { ok: false };
}

client.on("loading_screen", (percent, message) => {
  clientState = `loading:${percent}`;
});

client.on("change_state", (state) => {
  clientState = String(state).toLowerCase();
});

client.on("qr", (qr) => {
  qrVisible = true; clientState = "scan_required";
  ORIGINAL_CONSOLE_LOG("Scan this QR code with WhatsApp > Linked devices > Link a device:");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  qrVisible = false;
  clientState = "authenticated";
  startWhatsAppDiagnostics();
  readyDeadline = Date.now() + READY_GRACE_MS;
  if (readinessWatchdogTimer) clearInterval(readinessWatchdogTimer);
  readinessWatchdogTimer = setInterval(() => { runReadinessWatchdog(); }, READY_WATCH_INTERVAL_MS);
});

client.on("ready", async () => {
  if (diagnosticTimer) clearInterval(diagnosticTimer);
  diagnosticTimer = null;
  if (readinessWatchdogTimer) clearInterval(readinessWatchdogTimer);
  readinessWatchdogTimer = null;
  await runWhatsAppDiagnostic("ready");
  markReady("library");
});

client.on("auth_failure", (msg) => {
  clientReady = false;
  clientState = "auth_failure";
  lastError = msg;
  ORIGINAL_CONSOLE_ERROR("WhatsApp authentication failed:", msg);
});

client.on("disconnected", (reason) => {
  clientReady = false;
  readyViaWatchdog = false;
  clientState = "disconnected";
  recoveryAttempts = 0;
  lastError = String(reason);
  if (diagnosticTimer) clearInterval(diagnosticTimer);
  diagnosticTimer = null;
  if (readinessWatchdogTimer) clearInterval(readinessWatchdogTimer);
  readinessWatchdogTimer = null;
});

client.on("remote_session_saved", () => {});

function shouldReply(msg, s) {
  if (!s.enabled || !msg.body?.trim() || msg.fromMe || msg.from.endsWith("@g.us") || msg.isStatus) return false;
  return s.mode === "selected" ? !!chats()[msg.from]?.enabled : true;
}

function buildConversation(history, incoming) {
  let conversation = "";
  for (const message of history.slice(-12)) conversation += `${message.role === "user" ? "User" : "Assistant"}: ${message.content}\n`;
  return conversation + `User: ${incoming}\n`;
}

function buildPrompt(s, conversation) {
  const moodInstruction = MOODS[s.mood] || MOODS.casual;
  return `${s.systemPrompt}\n\nMood: ${s.mood}\nMood instructions: ${moodInstruction}\n\nImportant instructions:\n- You are replying to a WhatsApp conversation.\n- Sound natural and human.\n- Do not mention that you are an AI unless explicitly asked.\n- Keep replies reasonably short.\n- Understand the previous conversation before replying.\n- Do not repeat information unnecessarily.\n- Do not use markdown unless necessary.\n- Reply with ONLY the message that should be sent.\n\nConversation:\n${conversation}\n\nGenerate ONLY the reply.`;
}

async function generateGroqReply(prompt, model, maxTokens) {
  if (!groq) throw new Error("GROQ_API_KEY is missing in .env");
  const response = await groq.chat.completions.create({ model, messages: [{ role: "user", content: prompt }], max_completion_tokens: maxTokens, temperature: 0.7 });
  const usage = response.usage || {};
  return { text: response.choices?.[0]?.message?.content?.trim() || "", usage: { inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0, totalTokens: usage.total_tokens || 0 } };
}

async function generateGeminiReply(prompt, model, maxTokens) {
  if (!gemini) throw new Error("GEMINI_API_KEY is missing in .env");
  const response = await gemini.models.generateContent({ model, contents: prompt, config: { maxOutputTokens: maxTokens } });
  const usage = response.usageMetadata || {};
  return { text: response.text?.trim() || "", usage: { inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0, totalTokens: usage.totalTokenCount || 0 } };
}

async function generateReply(chatId, incoming) {
  const s = settings();
  const history = chats()[chatId]?.messages || [];
  const prompt = buildPrompt(s, buildConversation(history, incoming));
  if (s.provider === "gemini") return generateGeminiReply(prompt, s.geminiModel, Number(s.maxTokens) || 180);
  return generateGroqReply(prompt, s.groqModel, Number(s.maxTokens) || 180);
}

client.on("message", async (msg) => {
  const chatId = msg.from;
  try {
    const currentSettings = settings();
    if (!shouldReply(msg, currentSettings)) return;
    recordIncoming();
    if (pending.has(chatId)) return;
    if (quotaRemaining() <= 0) return;
    pending.add(chatId);
    const result = await generateReply(chatId, msg.body);
    recordUsage(result.usage);
    const reply = result.text;
    const all = chats();
    const chat = all[chatId] || { enabled: true, messages: [], lastMessageAt: null, lastReplyAt: null };
    chat.messages.push({ role: "user", content: msg.body, timestamp: Date.now() });
    chat.lastMessageAt = Date.now();
    all[chatId] = chat;
    writeJson(CHATS, all);
    const delay = Number(process.env.REPLY_DELAY_MS || 4000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    const latestSettings = settings();
    if (!latestSettings.enabled || quotaRemaining(latestSettings) <= 0) return;
    if (reply) {
      const syncReady = await waitForSendReady();
      if (!syncReady) {
        lastError = "Timed out waiting for WhatsApp message sync; reply skipped.";
        ORIGINAL_CONSOLE_ERROR(lastError);
        return;
      }
      const sendResult = await sendReplyWithRetry(msg, reply);
      if (!sendResult.ok) {
        lastError = "Reply send failed after retries; reply was not delivered.";
        ORIGINAL_CONSOLE_ERROR(lastError);
        return;
      }
      recordReply();
      const latest = chats();
      latest[chatId] = latest[chatId] || { enabled: true, messages: [] };
      latest[chatId].messages = latest[chatId].messages || [];
      latest[chatId].messages.push({ role: "assistant", content: reply, timestamp: Date.now() });
      latest[chatId].lastReplyAt = Date.now();
      writeJson(CHATS, latest);
    }
  } catch (e) {
    lastError = e.message || String(e);
    ORIGINAL_CONSOLE_ERROR("Auto-reply error:", lastError);
  } finally {
    pending.delete(chatId);
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, service: "whatsapp-ai-agent", localOnly: true }));
app.get("/api/status", (req, res) => {
  const s = settings();
  res.json({ clientReady, clientState, readyViaWatchdog, recoveryAttempts, qrVisible, lastError, diagnostics: waDiagnostics, settings: s, groqConfigured: !!groq, geminiConfigured: !!gemini, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), quotaRemaining: quotaRemaining(s) });
});
app.get("/api/stats", (req, res) => {
  const s = settings(); const all = chats(); const list = Object.values(all);
  res.json({ today: { incoming: Number(s.usage.incoming || 0), replies: Number(s.usage.replies || 0), quota: Number(s.dailyQuota || 0), remaining: quotaRemaining(s), inputTokens: Number(s.usage.inputTokens || 0), outputTokens: Number(s.usage.outputTokens || 0), totalTokens: Number(s.usage.totalTokens || 0) }, allTime: { chats: list.length, activeChats: list.filter(c => c.enabled !== false).length, storedMessages: list.reduce((sum, c) => sum + (c.messages || []).length, 0) }, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
});
app.get("/api/settings", (req, res) => res.json(settings()));
app.post("/api/settings", (req, res) => {
  const current = settings();
  const quota = Number(req.body.dailyQuota); const maxTokens = Number(req.body.maxTokens);
  const next = {
    ...current, ...req.body,
    enabled: !!req.body.enabled,
    provider: ["groq", "gemini"].includes(req.body.provider) ? req.body.provider : current.provider,
    groqModel: GROQ_MODELS.includes(req.body.groqModel) ? req.body.groqModel : current.groqModel,
    geminiModel: typeof req.body.geminiModel === "string" && req.body.geminiModel.trim() ? req.body.geminiModel.trim() : current.geminiModel,
    maxTokens: Number.isFinite(maxTokens) && maxTokens >= 50 ? Math.min(Math.floor(maxTokens), 1000) : current.maxTokens,
    mode: ["everyone", "selected"].includes(req.body.mode) ? req.body.mode : current.mode,
    mood: Object.keys(MOODS).includes(req.body.mood) ? req.body.mood : current.mood,
    dailyQuota: Number.isFinite(quota) && quota >= 1 ? Math.min(Math.floor(quota), 10000) : current.dailyQuota,
    systemPrompt: typeof req.body.systemPrompt === "string" ? req.body.systemPrompt.slice(0, 4000) : current.systemPrompt,
    usage: current.usage,
  };
  writeJson(SETTINGS, next);
  res.json(next);
});
app.get("/api/chats", (req, res) => {
  const all = chats();
  res.json(Object.entries(all).map(([id, c]) => ({ id, enabled: c.enabled !== false, messageCount: (c.messages || []).length, lastMessageAt: c.lastMessageAt, lastReplyAt: c.lastReplyAt })));
});
app.post("/api/chats/:id/toggle", (req, res) => {
  const id = decodeURIComponent(req.params.id); const all = chats();
  all[id] = all[id] || { enabled: true, messages: [] };
  all[id].enabled = !!req.body.enabled;
  writeJson(CHATS, all);
  res.json({ ok: true, id, enabled: all[id].enabled });
});

app.listen(PORT, HOST, () => {});

const initializationTimeout = setTimeout(() => {
  if (!clientReady) {
    lastError = `WhatsApp client has not reached ready state after ${Math.floor((Date.now() - startedAt) / 1000)} seconds (state: ${clientState}). Check the dashboard status.`;
    ORIGINAL_CONSOLE_ERROR(lastError);
  }
}, 90000);

client.initialize()
  .then(() => {})
  .catch((error) => {
    clearTimeout(initializationTimeout);
    lastError = error.message || String(error);
    clientState = "initialization_failed";
    ORIGINAL_CONSOLE_ERROR("WhatsApp initialization failed:", lastError);
  });