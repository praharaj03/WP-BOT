require("dotenv").config();

const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const { GoogleGenAI } = require("@google/genai");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA = path.join(__dirname, "data");
const SETTINGS = path.join(DATA, "settings.json");
const CHATS = path.join(DATA, "chats.json");

if (!fs.existsSync(DATA)) {
  fs.mkdirSync(DATA, { recursive: true });
}

if (!fs.existsSync(CHATS)) {
  fs.writeFileSync(CHATS, "{}");
}

// ===============================
// JSON HELPERS
// ===============================

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

function settings() {
  return readJson(SETTINGS, {
    enabled: false,
    mode: "everyone",
    systemPrompt:
      "You are my personal WhatsApp assistant. Reply naturally and casually like me. Keep replies concise unless more detail is necessary.",
  });
}

function chats() {
  return readJson(CHATS, {});
}

// ===============================
// GEMINI
// ===============================

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    })
  : null;

// ===============================
// WHATSAPP STATE
// ===============================

let clientReady = false;
let qrVisible = false;
let clientState = "starting";
let lastError = "";

const pending = new Set();

// ===============================
// WHATSAPP CLIENT
// ===============================

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, ".wwebjs_auth"),
  }),

  puppeteer: {
    headless: true,

    // You skipped Puppeteer's Chrome download,
    // so use the Chrome already installed on Windows.
    executablePath:
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

// ===============================
// WHATSAPP EVENTS
// ===============================

client.on("qr", (qr) => {
  qrVisible = true;
  clientState = "scan_required";

  console.log(
    "\nScan this QR code with WhatsApp > Linked devices > Link a device:\n",
  );

  qrcode.generate(qr, {
    small: true,
  });
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

// ===============================
// SHOULD BOT REPLY?
// ===============================

function shouldReply(msg, s) {
  // AI disabled
  if (!s.enabled) {
    return false;
  }

  // Ignore own messages
  if (msg.fromMe) {
    return false;
  }

  // Ignore groups
  if (msg.from.endsWith("@g.us")) {
    return false;
  }

  // Ignore status
  if (msg.isStatus) {
    return false;
  }

  // Selected contacts only
  if (s.mode === "selected") {
    const c = chats();

    return !!c[msg.from]?.enabled;
  }

  // Everyone
  return true;
}

// ===============================
// GENERATE GEMINI REPLY
// ===============================

async function generateReply(chatId, incoming) {
  if (!gemini) {
    throw new Error("GEMINI_API_KEY is missing in .env");
  }

  const all = chats();

  const history = all[chatId]?.messages || [];

  const s = settings();

  // Last 12 messages
  const recentHistory = history.slice(-12);

  let conversation = "";

  for (const message of recentHistory) {
    if (message.role === "user") {
      conversation += `User: ${message.content}\n`;
    }

    if (message.role === "assistant") {
      conversation += `Assistant: ${message.content}\n`;
    }
  }

  // Add current incoming message
  conversation += `User: ${incoming}\n`;

  const prompt = `
${s.systemPrompt}

Important instructions:

- You are replying to a WhatsApp conversation.
- Sound natural and human.
- Do not mention that you are an AI unless explicitly asked.
- Do not use unnecessary formal language.
- Keep replies reasonably short.
- Understand the previous conversation before replying.
- Do not repeat information unnecessarily.
- Do not use markdown unless necessary.
- Reply with ONLY the message that should be sent.

Conversation:

${conversation}

Generate ONLY the reply.
`;

  const response = await gemini.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    contents: prompt,
  });

  return response.text?.trim() || "";
}

// ===============================
// INCOMING MESSAGE
// ===============================

client.on("message", async (msg) => {
  const chatId = msg.from;

  try {
    const s = settings();

    // Check if bot should reply
    if (!shouldReply(msg, s)) {
      return;
    }

    // Prevent multiple replies for same chat
    if (pending.has(chatId)) {
      console.log(`Already processing ${chatId}`);
      return;
    }

    pending.add(chatId);

    console.log(`\nIncoming message from ${chatId}`);
    console.log(`Message: ${msg.body}`);

    // ============================
    // GENERATE AI REPLY
    // ============================

    const reply = await generateReply(chatId, msg.body);

    console.log(`Gemini reply: ${reply}`);

    // ============================
    // SAVE USER MESSAGE
    // ============================

    const all = chats();

    const chat = all[chatId] || {
      enabled: true,
      messages: [],
      lastMessageAt: null,
      lastReplyAt: null,
    };

    chat.messages.push({
      role: "user",
      content: msg.body,
      timestamp: Date.now(),
    });

    chat.lastMessageAt = Date.now();

    all[chatId] = chat;

    writeJson(CHATS, all);

    // ============================
    // DELAY
    // ============================

    const delay = Number(process.env.REPLY_DELAY_MS || 4000);

    console.log(`Waiting ${delay}ms before replying...`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    // ============================
    // CHECK BOT STILL ENABLED
    // ============================

    const latestSettings = settings();

    if (!latestSettings.enabled) {
      console.log("AI disabled while waiting. Reply cancelled.");
      return;
    }

    // ============================
    // SEND REPLY
    // ============================

    if (reply) {
      await msg.reply(reply);

      console.log("Reply sent successfully.");

      const latest = chats();

      latest[chatId] = latest[chatId] || {
        enabled: true,
        messages: [],
        lastMessageAt: null,
        lastReplyAt: null,
      };

      latest[chatId].messages.push({
        role: "assistant",
        content: reply,
        timestamp: Date.now(),
      });

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

// ===============================
// API - STATUS
// ===============================

app.get("/api/status", (req, res) => {
  res.json({
    clientReady,
    clientState,
    qrVisible,
    lastError,
    settings: settings(),
    geminiConfigured: !!gemini,
  });
});

// ===============================
// API - SETTINGS
// ===============================

app.get("/api/settings", (req, res) => {
  res.json(settings());
});

app.post("/api/settings", (req, res) => {
  const current = settings();

  const next = {
    ...current,
    ...req.body,
  };

  next.enabled = !!next.enabled;

  next.mode = ["everyone", "selected"].includes(next.mode)
    ? next.mode
    : "everyone";

  writeJson(SETTINGS, next);

  res.json(next);
});

// ===============================
// API - CHATS
// ===============================

app.get("/api/chats", (req, res) => {
  const c = chats();

  const list = Object.entries(c)
    .map(([id, v]) => ({
      id,
      enabled: v.enabled !== false,
      lastMessageAt: v.lastMessageAt || 0,
      lastReplyAt: v.lastReplyAt || 0,
      messageCount: (v.messages || []).length,
    }))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  res.json(list);
});

// ===============================
// API - CHAT TOGGLE
// ===============================

app.post("/api/chats/:id/toggle", (req, res) => {
  const c = chats();

  c[req.params.id] = c[req.params.id] || {
    messages: [],
  };

  c[req.params.id].enabled = req.body.enabled !== false;

  writeJson(CHATS, c);

  res.json(c[req.params.id]);
});

// ===============================
// API - CHAT MESSAGES
// ===============================

app.get("/api/chats/:id/messages", (req, res) => {
  res.json(chats()[req.params.id]?.messages || []);
});

// ===============================
// API - TEST
// ===============================

app.post("/api/test", (req, res) => {
  res.json({
    ok: true,
    message: "Use WhatsApp itself to test after linking the account.",
  });
});

// ===============================
// SERVER
// ===============================

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Dashboard: http://localhost:${port}`);
});

// ===============================
// START WHATSAPP
// ===============================

console.log("Starting WhatsApp client...");

client.initialize();