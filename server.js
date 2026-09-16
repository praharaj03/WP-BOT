require("dotenv").config();

const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { GoogleGenAI } = require("@google/genai");
const Groq = require("groq-sdk");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA = path.join(__dirname, "data");
const SETTINGS = path.join(DATA, "settings.json");
const CHATS = path.join(DATA, "chats.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(CHATS)) fs.writeFileSync(CHATS, "{}");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const DEFAULT_SETTINGS = {
  enabled: false,
  mode: "everyone",
  provider: "groq",
  groqModel: "openai/gpt-oss-20b",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  maxTokens: 180,
  mood: "casual",
  dailyQuota: 100,
  systemPrompt:
    "Reply naturally and casually like me. Keep replies concise unless more detail is necessary.",
  usage: {
    date: "",
    replies: 0,
    incoming: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  },
};

const MOODS = {
  casual: "Casual: relaxed, friendly, natural WhatsApp language. Use contractions and light humor when appropriate.",
  formal: "Formal: polite, professional, clear, and composed. Avoid slang and excessive emojis.",
  sad: "Sad: subdued, emotionally low, quiet, and slightly melancholic. Do not overdo it or sound dramatic.",
  romantic: "Romantic: warm, affectionate, playful, and caring. Keep it natural and avoid being overly dramatic.",
  vulgar: "Vulgar: use strong casual slang and profanity when it fits the conversation. Do not use hateful slurs, threats, or abusive harassment.",
  angry: "Angry: irritated, blunt, and firm. Express frustration naturally without threats, hate, or harassment.",
};

const GROQ_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3-32b",
];

function settings() {
  const stored = readJson(SETTINGS, {});
  const merged = {
    ...DEFAULT_SETTINGS,
    ...stored,
    usage: { ...DEFAULT_SETTINGS.usage, ...(stored.usage || {}) },
  };

  const today = new Date().toISOString().slice(0, 10);
  if (merged.usage.date !== today) {
    merged.usage = { date: today, replies: 0, incoming: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    writeJson(SETTINGS, merged);
  }

  return merged;
}

function chats() {
  return readJson(CHATS, {});
}

function recordIncoming() {
  const s = settings();
  s.usage.incoming += 1;
  writeJson(SETTINGS, s);
}

function recordUsage(usage) {
  const s = settings();
  s.usage.inputTokens += Number(usage.inputTokens || 0);
  s.usage.outputTokens += Number(usage.outputTokens || 0);
  s.usage.totalTokens += Number(usage.totalTokens || 0);
  writeJson(SETTINGS, s);
}

function recordReply() {
  const s = settings();
  s.usage.replies += 1;
  writeJson(SETTINGS, s);
}

function quotaRemaining(s = settings()) {
  const quota = Number(s.dailyQuota);
  if (quota <= 0) return 0;
  return Math.max(0, quota - Number(s.usage.replies || 0));
}

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

let clientReady = false;
let qrVisible = false;
let clientState = "starting";
let lastError = "";
const startedAt = Date.now();
const pending = new Set();

const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";

function authorized(req, res, next) {
  if (!CONTROL_TOKEN) {
    return res.status(503).json({ error: "CONTROL_TOKEN is not configured on the Windows backend." });
  }

  const supplied = req.get("x-control-token");
  if (!supplied || supplied.length !== CONTROL_TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(CONTROL_TOKEN))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

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

client.on("qr", (qr) => {
  qrVisible = true;
  clientState = "scan_required";
  console.log("\nScan this QR code with WhatsApp > Linked devices > Link a device:\n");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  qrVisible = false;
  clientState = "authenticated";
  console.log("WhatsApp authenticated.");
});

client.on("ready", () => {
  clientReady = true;
  qrVisible = false;
  clientState = "ready";
  console.log("WhatsApp AI Agent ready.");
});

client.on("auth_failure", (msg) => {
  clientReady = false;
  clientState = "auth_failure";
  lastError = msg;
  console.error("WhatsApp authentication failed:", msg);
});

client.on("disconnected", (reason) => {
  clientReady = false;
  clientState = "disconnected";
  lastError = String(reason);
  console.log("Disconnected:", reason);
});

function shouldReply(msg, s) {
  if (!s.enabled) return false;
  if (!msg.body?.trim()) return false;
  if (msg.fromMe) return false;
  if (msg.from.endsWith("@g.us")) return false;
  if (msg.isStatus) return false;
  if (s.mode === "selected") return !!chats()[msg.from]?.enabled;
  return true;
}

function buildConversation(history, incoming) {
  let conversation = "";
  for (const message of history.slice(-12)) {
    conversation += `${message.role === "user" ? "User" : "Assistant"}: ${message.content}\n`;
  }
  conversation += `User: ${incoming}\n`;
  return conversation;
}

function buildPrompt(s, conversation) {
  const moodInstruction = MOODS[s.mood] || MOODS.casual;
  return `${s.systemPrompt}\n\nMood: ${s.mood}\nMood instructions: ${moodInstruction}\n\nImportant instructions:\n- You are replying to a WhatsApp conversation.\n- Sound natural and human.\n- Do not mention that you are an AI unless explicitly asked.\n- Do not use unnecessary formal language unless the selected mood is formal.\n- Keep replies reasonably short.\n- Understand the previous conversation before replying.\n- Do not repeat information unnecessarily.\n- Do not use markdown unless necessary.\n- Reply with ONLY the message that should be sent.\n\nConversation:\n${conversation}\n\nGenerate ONLY the reply.`;
}

async function generateGroqReply(prompt, model, maxTokens) {
  if (!groq) throw new Error("GROQ_API_KEY is missing in .env");

  const response = await groq.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: maxTokens,
    temperature: 0.7,
  });

  const usage = response.usage || {};
  return {
    text: response.choices?.[0]?.message?.content?.trim() || "",
    usage: {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    },
  };
}

async function generateGeminiReply(prompt, model, maxTokens) {
  if (!gemini) throw new Error("GEMINI_API_KEY is missing in .env");

  const response = await gemini.models.generateContent({
    model,
    contents: prompt,
    config: { maxOutputTokens: maxTokens },
  });

  const usage = response.usageMetadata || {};
  return {
    text: response.text?.trim() || "",
    usage: {
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      totalTokens: usage.totalTokenCount || 0,
    },
  };
}

async function generateReply(chatId, incoming) {
  const history = chats()[chatId]?.messages || [];
  const s = settings();
  const prompt = buildPrompt(s, buildConversation(history, incoming));

  if (s.provider === "gemini") {
    return generateGeminiReply(prompt, s.geminiModel || process.env.GEMINI_MODEL || "gemini-3.6-flash", Number(s.maxTokens) || 180);
  }

  return generateGroqReply(prompt, s.groqModel || "openai/gpt-oss-20b", Number(s.maxTokens) || 180);
}

client.on("message", async (msg) => {
  const chatId = msg.from;

  try {
    const currentSettings = settings();
    if (!shouldReply(msg, currentSettings)) return;

    recordIncoming();

    if (pending.has(chatId)) {
      console.log(`Already processing ${chatId}`);
      return;
    }

    if (quotaRemaining() <= 0) {
      console.log("Daily AI reply quota reached. Reply skipped.");
      return;
    }

    pending.add(chatId);
    console.log(`\nIncoming message from ${chatId}`);
    console.log(`Message: ${msg.body}`);

    const result = await generateReply(chatId, msg.body);
    const reply = result.text;
    recordUsage(result.usage);
    console.log(`${currentSettings.provider} reply: ${reply}`);
    console.log(`Tokens: ${result.usage.totalTokens}`);

    const all = chats();
    const chat = all[chatId] || { enabled: true, messages: [], lastMessageAt: null, lastReplyAt: null };
    chat.messages.push({ role: "user", content: msg.body, timestamp: Date.now() });
    chat.lastMessageAt = Date.now();
    all[chatId] = chat;
    writeJson(CHATS, all);

    const delay = Number(process.env.REPLY_DELAY_MS || 4000);
    await new Promise((resolve) => setTimeout(resolve, delay));

    const latestSettings = settings();
    if (!latestSettings.enabled) {
      console.log("AI disabled while waiting. Reply cancelled.");
      return;
    }

    if (quotaRemaining(latestSettings) <= 0) {
      console.log("Daily AI reply quota reached while waiting. Reply cancelled.");
      return;
    }

    if (reply) {
      await msg.reply(reply);
      recordReply();
      console.log("Reply sent successfully.");

      const latest = chats();
      latest[chatId] = latest[chatId] || { enabled: true, messages: [] };
      latest[chatId].messages = latest[chatId].messages || [];
      latest[chatId].messages.push({ role: "assistant", content: reply, timestamp: Date.now() });
      latest[chatId].lastReplyAt = Date.now();
      writeJson(CHATS, latest);
    }
  } catch (e) {
    lastError = e.message || String(e);
    console.error("Auto-reply error:", lastError);
  } finally {
    pending.delete(chatId);
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "whatsapp-ai-agent" });
});

app.use("/api", authorized);

app.get("/api/status", (req, res) => {
  const s = settings();
  res.json({
    clientReady,
    clientState,
    qrVisible,
    lastError,
    settings: s,
    groqConfigured: !!groq,
    geminiConfigured: !!gemini,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    quotaRemaining: quotaRemaining(s),
  });
});

app.get("/api/stats", (req, res) => {
  const s = settings();
  const all = chats();
  const chatList = Object.values(all);
  const totalMessages = chatList.reduce((sum, c) => sum + (c.messages || []).length, 0);
  const totalChats = chatList.length;
  const activeChats = chatList.filter((c) => c.enabled !== false).length;

  res.json({
    today: {
      incoming: Number(s.usage.incoming || 0),
      replies: Number(s.usage.replies || 0),
      quota: Number(s.dailyQuota || 0),
      remaining: quotaRemaining(s),
      inputTokens: Number(s.usage.inputTokens || 0),
      outputTokens: Number(s.usage.outputTokens || 0),
      totalTokens: Number(s.usage.totalTokens || 0),
    },
    allTime: { chats: totalChats, activeChats, storedMessages: totalMessages },
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

app.get("/api/settings", (req, res) => res.json(settings()));

app.post("/api/settings", (req, res) => {
  const current = settings();
  const allowedMoods = Object.keys(MOODS);
  const requestedQuota = Number(req.body.dailyQuota);
  const requestedMaxTokens = Number(req.body.maxTokens);
  const provider = ["groq", "gemini"].includes(req.body.provider) ? req.body.provider : current.provider;
  const groqModel = GROQ_MODELS.includes(req.body.groqModel) ? req.body.groqModel : current.groqModel;

  const next = {
    ...current,
    ...req.body,
    enabled: !!req.body.enabled,
    provider,
    groqModel,
    geminiModel: typeof req.body.geminiModel === "string" && req.body.geminiModel.trim()
      ? req.body.geminiModel.trim()
      : current.geminiModel,
    maxTokens: Number.isFinite(requestedMaxTokens) && requestedMaxTokens >= 50
      ? Math.min(Math.floor(requestedMaxTokens), 1000)
      : current.maxTokens,
    mode: ["everyone", "selected"].includes(req.body.mode) ? req.body.mode : current.mode,
    mood: allowedMoods.includes(req.body.mood) ? req.body.mood : current.mood,
    dailyQuota: Number.isFinite(requestedQuota) && requestedQuota >= 1
      ? Math.min(Math.floor(requestedQuota), 10000)
      : current.dailyQuota,
  };

  delete next.usage;
  next.usage = current.usage;
  writeJson(SETTINGS, next);
  res.json(next);
});

app.get("/api/chats", (req, res) => {
  const list = Object.entries(chats())
    .map(([id, v]) => ({ id, enabled: v.enabled !== false, lastMessageAt: v.lastMessageAt || 0, lastReplyAt: v.lastReplyAt || 0, messageCount: (v.messages || []).length }))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  res.json(list);
});

app.post("/api/chats/:id/toggle", (req, res) => {
  const c = chats();
  c[req.params.id] = c[req.params.id] || { messages: [] };
  c[req.params.id].enabled = req.body.enabled !== false;
  writeJson(CHATS, c);
  res.json(c[req.params.id]);
});

app.get("/api/chats/:id/messages", (req, res) => {
  res.json(chats()[req.params.id]?.messages || []);
});

app.post("/api/test", (req, res) => {
  res.json({ ok: true, message: "Use WhatsApp itself to test after linking the account." });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Dashboard: http://localhost:${port}`));

console.log("Starting WhatsApp client...");
client.initialize().catch((error) => {
  lastError = error.message || String(error);
  console.error("WhatsApp initialization error:", lastError);
});

process.on("unhandledRejection", (error) => {
  lastError = error?.message || String(error);
  console.error("Unhandled rejection:", lastError);
});
