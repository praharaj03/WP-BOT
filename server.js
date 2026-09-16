require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const Groq = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   FILE PATHS
========================================================= */

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const CHATS_FILE = path.join(DATA_DIR, "chats.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* =========================================================
   DEFAULT SETTINGS
========================================================= */

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "everyone",
  provider: "groq",
  groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  maxTokens: 180,
  mood: "normal",
  dailyQuota: 100,
  systemPrompt:
    "You are my personal WhatsApp assistant. Reply naturally as me. Keep replies concise and conversational. Do not claim to be me if directly asked. Do not invent facts. Match the language and tone of the incoming message. Avoid overly formal or robotic wording. If the message needs a personal decision you cannot know, ask a short clarifying question instead of guessing.",
  usage: {
    date: new Date().toISOString().slice(0, 10),
    replies: 0,
    incoming: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  },
};

/* =========================================================
   JSON HELPERS
========================================================= */

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error(`Failed reading ${file}:`, error.message);
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Failed writing ${file}:`, error.message);
  }
}

/* =========================================================
   SETTINGS
========================================================= */

function settings() {
  const data = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);

  const today = new Date().toISOString().slice(0, 10);

  if (!data.usage) {
    data.usage = {
      date: today,
      replies: 0,
      incoming: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }

  if (data.usage.date !== today) {
    data.usage = {
      date: today,
      replies: 0,
      incoming: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    writeJson(SETTINGS_FILE, data);
  }

  return {
    ...DEFAULT_SETTINGS,
    ...data,
    usage: {
      ...DEFAULT_SETTINGS.usage,
      ...data.usage,
    },
  };
}

function saveSettings(next) {
  const current = settings();

  const merged = {
    ...current,
    ...next,
    usage: {
      ...current.usage,
      ...(next.usage || {}),
    },
  };

  writeJson(SETTINGS_FILE, merged);

  return merged;
}

/* =========================================================
   CHATS
========================================================= */

function chats() {
  return readJson(CHATS_FILE, {});
}

/* =========================================================
   USAGE
========================================================= */

function recordIncoming() {
  const s = settings();

  s.usage.incoming++;

  writeJson(SETTINGS_FILE, s);
}

function recordReply() {
  const s = settings();

  s.usage.replies++;

  writeJson(SETTINGS_FILE, s);
}

function recordUsage(usage) {
  if (!usage) return;

  const s = settings();

  const inputTokens = Number(
    usage.prompt_tokens ??
      usage.input_tokens ??
      usage.promptTokens ??
      0
  );

  const outputTokens = Number(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.completionTokens ??
      0
  );

  const totalTokens = Number(
    usage.total_tokens ??
      usage.totalTokens ??
      inputTokens + outputTokens
  );

  s.usage.inputTokens += inputTokens;
  s.usage.outputTokens += outputTokens;
  s.usage.totalTokens += totalTokens;

  writeJson(SETTINGS_FILE, s);
}

function quotaRemaining(s = settings()) {
  const quota = Number(s.dailyQuota || 0);

  if (quota <= 0) {
    return Infinity;
  }

  return Math.max(0, quota - Number(s.usage.replies || 0));
}

/* =========================================================
   GLOBAL STATE
========================================================= */

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

/* =========================================================
   TIMING
========================================================= */

const READY_GRACE_MS = 60000;
const READY_RECOVERY_MS = 120000;
const READY_MAX_WAIT_MS = 240000;
const READY_WATCH_INTERVAL_MS = 15000;

const SYNC_READY_MAX_WAIT_MS = 150000;

const SEND_TIMEOUT_MS = 30000;
const SEND_RETRY_DELAY_MS = 8000;

const AI_TIMEOUT_MS = 45000;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/* =========================================================
   AI CLIENTS
========================================================= */

const groq =
  process.env.GROQ_API_KEY &&
  process.env.GROQ_API_KEY !== "YOUR_GROQ_API_KEY"
    ? new Groq({
        apiKey: process.env.GROQ_API_KEY,
      })
    : null;

const gemini =
  process.env.GEMINI_API_KEY &&
  process.env.GEMINI_API_KEY !== "YOUR_GEMINI_API_KEY"
    ? new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
      })
    : null;

console.log("AI providers:");
console.log(`  Groq configured: ${!!groq}`);
console.log(`  Gemini configured: ${!!gemini}`);

/* =========================================================
   MOOD
========================================================= */

function moodInstruction(mood) {
  switch (String(mood || "").toLowerCase()) {
    case "friendly":
      return "Be friendly, warm and casual.";

    case "professional":
      return "Be professional, concise and polite.";

    case "funny":
      return "Use light humor when appropriate.";

    case "vulgar":
      return "Use casual slang and mild vulgar language when it naturally matches the incoming message. Do not overdo it.";

    case "sarcastic":
      return "Use light sarcasm when appropriate.";

    case "romantic":
      return "Use a warm and slightly romantic tone only when appropriate to the conversation.";

    case "normal":
    default:
      return "Use a natural casual conversational tone.";
  }
}

/* =========================================================
   AI REPLY - GROQ
========================================================= */

async function generateGroqReply(chatId, message) {
  if (!groq) {
    throw new Error("Groq API key is not configured.");
  }

  const s = settings();

  const chatData = chats()[chatId];

  const history = Array.isArray(chatData?.messages)
    ? chatData.messages.slice(-10)
    : [];

  const messages = [
    {
      role: "system",
      content: `${s.systemPrompt}

${moodInstruction(s.mood)}

Keep the response short enough for WhatsApp.`,
    },
  ];

  for (const item of history) {
    if (!item?.content) continue;

    messages.push({
      role: item.role === "assistant" ? "assistant" : "user",
      content: String(item.content),
    });
  }

  messages.push({
    role: "user",
    content: message,
  });

  console.log(
    `[AI/GROQ] Requesting reply using model: ${
      s.groqModel || process.env.GROQ_MODEL
    }`
  );

  const response = await groq.chat.completions.create({
    model: s.groqModel || process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    messages,
    max_tokens: Number(s.maxTokens || 180),
    temperature: 0.7,
  });

  const text =
    response?.choices?.[0]?.message?.content?.trim() || "";

  console.log(
    `[AI/GROQ] Response received. Length=${text.length}`
  );

  return {
    text,
    usage: response?.usage || null,
  };
}

/* =========================================================
   AI REPLY - GEMINI
========================================================= */

async function generateGeminiReply(chatId, message) {
  if (!gemini) {
    throw new Error("Gemini API key is not configured.");
  }

  const s = settings();

  const chatData = chats()[chatId];

  const history = Array.isArray(chatData?.messages)
    ? chatData.messages.slice(-10)
    : [];

  let conversation = "";

  for (const item of history) {
    if (!item?.content) continue;

    const role =
      item.role === "assistant"
        ? "Assistant"
        : "User";

    conversation += `${role}: ${item.content}\n`;
  }

  conversation += `User: ${message}\nAssistant:`;

  const prompt = `${s.systemPrompt}

${moodInstruction(s.mood)}

Keep the response short enough for WhatsApp.

Conversation:
${conversation}`;

  console.log(
    `[AI/GEMINI] Requesting reply using model: ${
      s.geminiModel || process.env.GEMINI_MODEL
    }`
  );

  const response = await gemini.models.generateContent({
    model:
      s.geminiModel ||
      process.env.GEMINI_MODEL ||
      "gemini-3.6-flash",
    contents: prompt,
    config: {
      maxOutputTokens: Number(s.maxTokens || 180),
    },
  });

  const text =
    response?.text?.trim() ||
    response?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim() ||
    "";

  console.log(
    `[AI/GEMINI] Response received. Length=${text.length}`
  );

  return {
    text,
    usage: response?.usageMetadata
      ? {
          promptTokenCount:
            response.usageMetadata.promptTokenCount || 0,
          candidatesTokenCount:
            response.usageMetadata.candidatesTokenCount || 0,
          totalTokenCount:
            response.usageMetadata.totalTokenCount || 0,
        }
      : null,
  };
}

/* =========================================================
   AI GENERATOR
========================================================= */

async function generateReply(chatId, message) {
  const s = settings();

  console.log(
    `[AI] Provider selected: ${s.provider}`
  );

  if (s.provider === "gemini") {
    return generateGeminiReply(chatId, message);
  }

  return generateGroqReply(chatId, message);
}

/* =========================================================
   TIMED PROMISE
========================================================= */

async function timed(promise, ms, tag) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${tag} timed out after ${ms}ms`
        )
      );
    }, ms);
  });

  try {
    return await Promise.race([
      promise,
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   WHATSAPP CLIENT
========================================================= */

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const executablePath =
  chromeCandidates.find(fs.existsSync);

console.log(
  `Chrome executable: ${
    executablePath || "default Puppeteer Chromium"
  }`
);

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(
      __dirname,
      ".wwebjs_auth"
    ),
  }),

  puppeteer: {
    headless: true,

    ...(executablePath
      ? { executablePath }
      : {}),

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

/* =========================================================
   WHATSAPP DIAGNOSTIC
========================================================= */

async function runWhatsAppDiagnostic(label) {
  const page = client.pupPage;

  if (!page) {
    console.log(
      `WhatsApp diagnostic [${label}]: no Puppeteer page`
    );

    return;
  }

  try {
    const result = await page.evaluate(() => {
      const body =
        document.body?.innerText || "";

      let wwebjs = null;
      let store = null;
      let webpackChunk = null;

      try {
        wwebjs = typeof window.WWebJS;
      } catch {}

      try {
        store = typeof window.Store;
      } catch {}

      try {
        webpackChunk =
          typeof window.webpackChunkwhatsapp_web_client;
      } catch {}

      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        wwebjs,
        store,
        webpackChunk,
        bodyText: body
          .replace(/\s+/g, " ")
          .slice(0, 1000),
      };
    });

    waDiagnostics = {
      checkedAt: new Date().toISOString(),
      label,
      ...result,
      error: null,
    };

    console.log(
      `WhatsApp diagnostic [${label}]: readyState=${result.readyState}, WWebJS=${result.wwebjs}, Store=${result.store}, webpackChunk=${result.webpackChunk}, url=${result.url}`
    );

    console.log(
      `WhatsApp diagnostic title: ${result.title}`
    );

    console.log(
      `WhatsApp diagnostic body: ${result.bodyText}`
    );
  } catch (error) {
    waDiagnostics = {
      ...waDiagnostics,
      checkedAt: new Date().toISOString(),
      label,
      error: error.message,
    };

    console.error(
      `WhatsApp diagnostic [${label}] failed:`,
      error.message
    );
  }
}

/* =========================================================
   READINESS PROBE
========================================================= */

async function probeReadiness() {
  const page = client.pupPage;

  if (!page) {
    return null;
  }

  try {
    return await page.evaluate(() => {
      const socket =
        window.require?.(
          "WAWebSocketModel"
        )?.Socket;

      return {
        url: window.location.href,

        wwebjs:
          typeof window.WWebJS,

        hasSynced:
          socket
            ? !!socket.hasSynced
            : null,

        socketState:
          socket
            ? String(socket.state || "")
            : null,

        onAddMessageEvent:
          typeof window.onAddMessageEvent,

        onMessageAckEvent:
          typeof window.onMessageAckEvent,

        onAppStateHasSyncedEvent:
          typeof window
            .onAppStateHasSyncedEvent,

        inputVisible:
          !!document.querySelector(
            'div[contenteditable="true"], textarea, input[type="text"]'
          ),
      };
    });
  } catch {
    return null;
  }
}

/* =========================================================
   MARK READY
========================================================= */

function markReady(source) {
  if (clientReady) {
    return;
  }

  clientReady = true;
  readyViaWatchdog =
    source === "watchdog";

  qrVisible = false;
  clientState = "ready";

  if (diagnosticTimer) {
    clearInterval(diagnosticTimer);
    diagnosticTimer = null;
  }

  if (readinessWatchdogTimer) {
    clearInterval(
      readinessWatchdogTimer
    );

    readinessWatchdogTimer = null;
  }

  console.log(
    `WhatsApp AI Agent ready. (${source})`
  );
}

/* =========================================================
   READINESS WATCHDOG
========================================================= */

async function runReadinessWatchdog() {
  if (
    !client.pupPage ||
    clientReady
  ) {
    return;
  }

  const elapsed =
    Date.now() - startedAt;

  const p =
    await probeReadiness();

  if (!p) {
    return;
  }

  const pipelineWired =
    p.wwebjs === "object" &&
    p.onAddMessageEvent === "function" &&
    p.socketState === "CONNECTED" &&
    p.hasSynced === true;

  if (pipelineWired) {
    if (
      Date.now() >= readyDeadline
    ) {
      await runWhatsAppDiagnostic(
        "watchdog_ready"
      );

      markReady("watchdog");
    }

    return;
  }

  if (
    elapsed >= READY_MAX_WAIT_MS
  ) {
    lastError =
      `WhatsApp client did not reach a verified ready state in ${Math.floor(
        elapsed / 1000
      )}s (WWebJS=${p.wwebjs}, socket=${p.socketState}, hasSynced=${p.hasSynced}).`;

    if (diagnosticTimer) {
      clearInterval(
        diagnosticTimer
      );

      diagnosticTimer = null;
    }

    if (readinessWatchdogTimer) {
      clearInterval(
        readinessWatchdogTimer
      );

      readinessWatchdogTimer = null;
    }

    console.error(lastError);

    return;
  }

  if (
    recoveryAttempts === 0 &&
    elapsed >= READY_RECOVERY_MS
  ) {
    recoveryAttempts++;

    console.log(
      "Ready watchdog: message pipeline is not fully wired yet. Reloading WhatsApp Web once..."
    );

    await client.pupPage
      .reload({
        waitUntil: "load",
        timeout: 30000,
      })
      .catch(() => {});

    readyDeadline =
      Date.now() +
      READY_GRACE_MS;
  }
}

/* =========================================================
   PAGE SYNC PROBE
========================================================= */

async function pageSyncProbe() {
  const page = client.pupPage;

  if (!page) {
    return null;
  }

  try {
    return await page.evaluate(() => {
      const socket =
        window.require?.(
          "WAWebSocketModel"
        )?.Socket;

      const body =
        (
          document.body?.innerText ||
          ""
        )
          .replace(/\s+/g, " ")
          .toLowerCase();

      return {
        downloading:
          body.includes(
            "messages are downloading"
          ) ||
          body.includes(
            "your messages are downloading"
          ) ||
          body.includes(
            "don't close this window"
          ),

        wwebjs:
          typeof window.WWebJS,

        socketState:
          socket
            ? String(socket.state || "")
            : null,

        hasSynced:
          socket
            ? !!socket.hasSynced
            : null,
      };
    });
  } catch {
    return null;
  }
}

/* =========================================================
   WAIT FOR WHATSAPP SYNC
========================================================= */

async function waitForSendReady() {
  const deadline =
    Date.now() +
    SYNC_READY_MAX_WAIT_MS;

  while (
    Date.now() < deadline
  ) {
    const p =
      await pageSyncProbe();

    if (
      p &&
      p.wwebjs === "object" &&
      p.socketState === "CONNECTED" &&
      p.hasSynced === true &&
      !p.downloading
    ) {
      console.log(
        "[SEND] WhatsApp sync is ready."
      );

      return true;
    }

    console.log(
      `[SEND] Waiting for WhatsApp message sync... ${
        p
          ? `${p.socketState}, downloading=${p.downloading}, hasSynced=${p.hasSynced}`
          : "page unavailable"
      }`
    );

    await sleep(5000);
  }

  return false;
}

/* =========================================================
   SEND REPLY
========================================================= */

async function sendReplyWithRetry(
  msg,
  replyText
) {
  const chatId = msg.from;

  console.log(
    `[SEND] Preparing to send reply to ${chatId}`
  );

  const attempts = [
    {
      name: "msg.reply",
      fn: () =>
        msg.reply(replyText),
    },

    {
      name: "sendMessage(sendSeen:false)",
      fn: () =>
        client.sendMessage(
          chatId,
          replyText,
          {
            sendSeen: false,
          }
        ),
    },

    {
      name: "sendMessage(quoted)",
      fn: () =>
        client.sendMessage(
          chatId,
          replyText,
          {
            sendSeen: false,
            quotedMessageId:
              msg.id?._serialized,
          }
        ),
    },
  ];

  for (
    let i = 0;
    i < attempts.length;
    i++
  ) {
    const attempt =
      attempts[i];

    console.log(
      `[SEND] Attempt ${i + 1}/${attempts.length}: ${attempt.name}`
    );

    try {
      const sent =
        await timed(
          attempt.fn(),
          SEND_TIMEOUT_MS,
          attempt.name
        );

      if (
        sent &&
        sent.id
      ) {
        console.log(
          `[SEND] SUCCESS using ${attempt.name}`
        );

        return {
          ok: true,
          method: attempt.name,
        };
      }

      console.warn(
        `[SEND] ${attempt.name} resolved without a message object.`
      );

      return {
        ok: true,
        method:
          `${attempt.name}:no-object`,
      };
    } catch (error) {
      lastError =
        `Reply send attempt ${
          i + 1
        } (${attempt.name}) failed: ${
          error.message
        }`;

      console.error(
        `[SEND] ${lastError}`
      );

      if (
        i <
        attempts.length - 1
      ) {
        console.log(
          `[SEND] Waiting ${SEND_RETRY_DELAY_MS}ms before next attempt...`
        );

        await sleep(
          SEND_RETRY_DELAY_MS
        );
      }
    }
  }

  return {
    ok: false,
  };
}

/* =========================================================
   MESSAGE FILTER
========================================================= */

function shouldReply(
  msg,
  s
) {
  if (!s.enabled) {
    console.log(
      "[AUTO] Auto-reply disabled."
    );

    return false;
  }

  if (!msg) {
    return false;
  }

  if (msg.fromMe) {
    console.log(
      "[AUTO] Ignoring own message."
    );

    return false;
  }

  if (
    s.mode === "contacts"
  ) {
    if (
      msg.from?.endsWith(
        "@g.us"
      )
    ) {
      return false;
    }
  }

  if (
    s.mode === "private" &&
    msg.from?.endsWith(
      "@g.us"
    )
  ) {
    return false;
  }

  return true;
}

/* =========================================================
   WHATSAPP EVENTS
========================================================= */

client.on(
  "loading_screen",
  (percent, message) => {
    clientState =
      "loading";

    console.log(
      `WhatsApp loading: ${percent}% - ${message}`
    );
  }
);

client.on(
  "change_state",
  (state) => {
    clientState =
      String(state || "");

    console.log(
      `WhatsApp state changed: ${state}`
    );
  }
);

client.on(
  "qr",
  (qr) => {
    qrVisible = true;
    clientState = "qr";

    console.log(
      "WhatsApp QR received. Scan it if required."
    );

    qrcode.generate(
      qr,
      {
        small: true,
      }
    );
  }
);

client.on(
  "authenticated",
  () => {
    qrVisible = false;
    clientState =
      "authenticated";

    console.log(
      "WhatsApp authenticated. Waiting for WhatsApp Web to finish loading..."
    );

    startWhatsAppDiagnostics();

    readyDeadline =
      Date.now() +
      READY_GRACE_MS;

    if (
      readinessWatchdogTimer
    ) {
      clearInterval(
        readinessWatchdogTimer
      );
    }

    readinessWatchdogTimer =
      setInterval(
        () => {
          runReadinessWatchdog();
        },
        READY_WATCH_INTERVAL_MS
      );
  }
);

client.on(
  "ready",
  async () => {
    console.log(
      "WhatsApp READY event received."
    );

    if (diagnosticTimer) {
      clearInterval(
        diagnosticTimer
      );

      diagnosticTimer = null;
    }

    if (
      readinessWatchdogTimer
    ) {
      clearInterval(
        readinessWatchdogTimer
      );

      readinessWatchdogTimer = null;
    }

    await runWhatsAppDiagnostic(
      "ready"
    );

    markReady("library");
  }
);

client.on(
  "auth_failure",
  (message) => {
    clientState =
      "auth_failure";

    lastError =
      message ||
      "WhatsApp authentication failed.";

    console.error(
      "WhatsApp authentication failure:",
      lastError
    );
  }
);

client.on(
  "disconnected",
  (reason) => {
    clientReady = false;
    clientState =
      "disconnected";

    lastError =
      String(reason || "Unknown disconnect");

    console.error(
      "WhatsApp disconnected:",
      reason
    );
  }
);

/* =========================================================
   DIAGNOSTICS LOOP
========================================================= */

function startWhatsAppDiagnostics() {
  if (diagnosticTimer) {
    clearInterval(
      diagnosticTimer
    );
  }

  runWhatsAppDiagnostic(
    "authenticated"
  );

  diagnosticTimer =
    setInterval(
      () => {
        if (!clientReady) {
          runWhatsAppDiagnostic(
            "poll"
          );
        }
      },
      10000
    );
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

client.on(
  "message",
  async (msg) => {
    const chatId =
      msg.from;

    console.log(
      `\n[AUTO] Incoming message event received.`
    );

    console.log(
      `[AUTO] Chat ID: ${chatId}`
    );

    console.log(
      `[AUTO] Message: ${msg.body}`
    );

    try {
      const currentSettings =
        settings();

      console.log(
        `[AUTO] Settings: enabled=${currentSettings.enabled}, provider=${currentSettings.provider}, quotaRemaining=${quotaRemaining(
          currentSettings
        )}`
      );

      /* ---------------------------------------------------
         BASIC FILTER
      --------------------------------------------------- */

      if (
        !shouldReply(
          msg,
          currentSettings
        )
      ) {
        console.log(
          "[AUTO] Message filtered/skipped."
        );

        return;
      }

      recordIncoming();

      /* ---------------------------------------------------
         TEMPORARY DIRECT SEND TEST
         
         Send "sendtest" from WhatsApp to test the
         WhatsApp sending pipeline without AI.
      --------------------------------------------------- */

      if (
        String(msg.body || "")
          .trim()
          .toLowerCase() ===
        "sendtest"
      ) {
        console.log(
          "[TEST] Direct WhatsApp send test started."
        );

        try {
          const result =
            await timed(
              msg.reply(
                "BOT SEND TEST OK"
              ),
              SEND_TIMEOUT_MS,
              "direct send test"
            );

          console.log(
            "[TEST] Direct send test SUCCESS:",
            result?.id?._serialized ||
              "no message object"
          );
        } catch (error) {
          console.error(
            "[TEST] Direct send test FAILED:",
            error.message
          );

          lastError =
            `[TEST] Direct send test failed: ${error.message}`;
        }

        return;
      }

      /* ---------------------------------------------------
         DUPLICATE / CONCURRENT CHAT CHECK
      --------------------------------------------------- */

      if (
        pending.has(chatId)
      ) {
        console.log(
          "[AUTO] Another reply is already pending for this chat. Skipping."
        );

        return;
      }

      /* ---------------------------------------------------
         DAILY QUOTA
      --------------------------------------------------- */

      if (
        quotaRemaining(
          currentSettings
        ) <= 0
      ) {
        console.log(
          "[AUTO] Daily AI reply quota reached. Reply skipped."
        );

        return;
      }

      pending.add(chatId);

      console.log(
        `[AUTO] Pending lock added for ${chatId}`
      );

      /* ---------------------------------------------------
         AI GENERATION
      --------------------------------------------------- */

      console.log(
        "[AUTO] STEP 1 -> Starting AI generation..."
      );

      const aiStart =
        Date.now();

      const result =
        await timed(
          generateReply(
            chatId,
            msg.body
          ),
          AI_TIMEOUT_MS,
          "AI generation"
        );

      console.log(
        `[AUTO] STEP 2 -> AI generation completed in ${
          Date.now() - aiStart
        }ms`
      );

      console.log(
        "[AUTO] AI result:",
        {
          text: result?.text,
          textLength:
            result?.text?.length || 0,
          usage:
            result?.usage || null,
        }
      );

      recordUsage(
        result?.usage
      );

      const reply =
        String(
          result?.text || ""
        ).trim();

      /* ---------------------------------------------------
         STORE INCOMING MESSAGE
      --------------------------------------------------- */

      const all =
        chats();

      const chat =
        all[chatId] || {
          enabled: true,
          messages: [],
          lastMessageAt: null,
          lastReplyAt: null,
        };

      chat.messages =
        chat.messages || [];

      chat.messages.push({
        role: "user",
        content:
          msg.body,
        timestamp:
          Date.now(),
      });

      chat.lastMessageAt =
        Date.now();

      all[chatId] =
        chat;

      writeJson(
        CHATS_FILE,
        all
      );

      /* ---------------------------------------------------
         EMPTY AI RESPONSE
      --------------------------------------------------- */

      if (!reply) {
        lastError =
          "AI returned an empty reply.";

        console.error(
          "[AUTO] STEP 3 -> AI returned EMPTY reply. Nothing will be sent."
        );

        return;
      }

      console.log(
        `[AUTO] STEP 3 -> Generated reply: ${reply}`
      );

      /* ---------------------------------------------------
         REPLY DELAY
      --------------------------------------------------- */

      const delay =
        Number(
          process.env.REPLY_DELAY_MS ||
            4000
        );

      console.log(
        `[AUTO] STEP 4 -> Waiting ${delay}ms before sending...`
      );

      await sleep(delay);

      /* ---------------------------------------------------
         RE-CHECK SETTINGS / QUOTA
      --------------------------------------------------- */

      const latestSettings =
        settings();

      console.log(
        `[AUTO] STEP 5 -> Rechecking settings: enabled=${latestSettings.enabled}, quotaRemaining=${quotaRemaining(
          latestSettings
        )}`
      );

      if (
        !latestSettings.enabled
      ) {
        console.log(
          "[AUTO] Auto-reply was disabled while waiting. Reply cancelled."
        );

        return;
      }

      if (
        quotaRemaining(
          latestSettings
        ) <= 0
      ) {
        console.log(
          "[AUTO] Daily quota reached while waiting. Reply cancelled."
        );

        return;
      }

      /* ---------------------------------------------------
         WAIT FOR WHATSAPP SYNC
      --------------------------------------------------- */

      console.log(
        "[AUTO] STEP 6 -> Checking WhatsApp sync before sending..."
      );

      const syncReady =
        await waitForSendReady();

      if (!syncReady) {
        lastError =
          "Timed out waiting for WhatsApp message sync; reply skipped.";

        console.error(
          `[AUTO] STEP 6 FAILED -> ${lastError}`
        );

        return;
      }

      /* ---------------------------------------------------
         SEND
      --------------------------------------------------- */

      console.log(
        `[AUTO] STEP 7 -> Sending reply to ${chatId}...`
      );

      const sendResult =
        await sendReplyWithRetry(
          msg,
          reply
        );

      if (
        !sendResult.ok
      ) {
        lastError =
          "Reply send failed after retries; reply was not delivered.";

        console.error(
          `[AUTO] STEP 7 FAILED -> ${lastError}`
        );

        return;
      }

      /* ---------------------------------------------------
         RECORD SUCCESS
      --------------------------------------------------- */

      recordReply();

      const latest =
        chats();

      latest[chatId] =
        latest[chatId] || {
          enabled: true,
          messages: [],
        };

      latest[chatId].messages =
        latest[chatId].messages ||
        [];

      latest[chatId].messages.push(
        {
          role: "assistant",
          content: reply,
          timestamp:
            Date.now(),
        }
      );

      latest[chatId].lastReplyAt =
        Date.now();

      writeJson(
        CHATS_FILE,
        latest
      );

      console.log(
        `[AUTO] STEP 8 -> Reply recorded successfully.`
      );

      console.log(
        `Reply sent successfully. (${sendResult.method})`
      );
    } catch (error) {
      lastError =
        error?.message ||
        String(error);

      console.error(
        "[AUTO] Auto-reply error:",
        lastError
      );

      if (
        error?.stack
      ) {
        console.error(
          error.stack
        );
      }
    } finally {
      pending.delete(
        chatId
      );

      console.log(
        `[AUTO] Pending lock released for ${chatId}`
      );
    }
  }
);

/* =========================================================
   STATUS API
========================================================= */

app.get(
  "/api/status",
  (req, res) => {
    const s =
      settings();

    res.json({
      clientReady,
      clientState,
      readyViaWatchdog,
      recoveryAttempts,
      qrVisible,
      lastError,
      diagnostics:
        waDiagnostics,
      settings: s,
      groqConfigured:
        !!groq,
      geminiConfigured:
        !!gemini,
      uptimeSeconds:
        Math.floor(
          (Date.now() -
            startedAt) /
            1000
        ),
      quotaRemaining:
        quotaRemaining(s),
      pendingChats:
        pending.size,
    });
  }
);

/* =========================================================
   SETTINGS API
========================================================= */

app.get(
  "/api/settings",
  (req, res) => {
    res.json(
      settings()
    );
  }
);

app.post(
  "/api/settings",
  (req, res) => {
    try {
      const current =
        settings();

      const incoming =
        req.body || {};

      const allowed = [
        "enabled",
        "mode",
        "provider",
        "groqModel",
        "geminiModel",
        "maxTokens",
        "mood",
        "dailyQuota",
        "systemPrompt",
      ];

      const next = {
        ...current,
      };

      for (
        const key of allowed
      ) {
        if (
          Object.prototype.hasOwnProperty.call(
            incoming,
            key
          )
        ) {
          next[key] =
            incoming[key];
        }
      }

      const saved =
        saveSettings(
          next
        );

      res.json({
        ok: true,
        settings: saved,
      });
    } catch (error) {
      console.error(
        "Settings update failed:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   CHAT API
========================================================= */

app.get(
  "/api/chats",
  (req, res) => {
    res.json(
      chats()
    );
  }
);

app.get(
  "/api/chats/:chatId",
  (req, res) => {
    const all =
      chats();

    const chat =
      all[req.params.chatId];

    if (!chat) {
      return res
        .status(404)
        .json({
          error:
            "Chat not found",
        });
    }

    res.json(chat);
  }
);

/* =========================================================
   HEALTH API
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      whatsapp:
        clientReady,
      state:
        clientState,
      uptimeSeconds:
        Math.floor(
          (Date.now() -
            startedAt) /
            1000
        ),
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `Dashboard: http://${HOST}:${PORT}`
    );
  }
);

/* =========================================================
   INITIALIZE WHATSAPP
========================================================= */

console.log(
  "Starting WhatsApp client initialization..."
);

const initializationTimeout =
  setTimeout(
    () => {
      if (!clientReady) {
        lastError =
          `WhatsApp client has not reached ready state after ${Math.floor(
            (Date.now() -
              startedAt) /
              1000
          )} seconds (state: ${clientState}). Check the terminal for loading/state diagnostics.`;

        console.error(
          lastError
        );
      }
    },
    90000
  );

client
  .initialize()
  .then(() => {
    clearTimeout(
      initializationTimeout
    );

    console.log(
      "WhatsApp client initialize() completed."
    );
  })
  .catch((error) => {
    clearTimeout(
      initializationTimeout
    );

    lastError =
      error?.message ||
      String(error);

    clientState =
      "initialization_failed";

    console.error(
      "WhatsApp initialization failed:",
      lastError
    );

    if (
      error?.stack
    ) {
      console.error(
        error.stack
      );
    }
  });

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(
  signal
) {
  console.log(
    `\nReceived ${signal}. Shutting down...`
  );

  try {
    if (
      readinessWatchdogTimer
    ) {
      clearInterval(
        readinessWatchdogTimer
      );
    }

    if (
      diagnosticTimer
    ) {
      clearInterval(
        diagnosticTimer
      );
    }

    await client.destroy();

    console.log(
      "WhatsApp client destroyed."
    );
  } catch (error) {
    console.error(
      "Shutdown error:",
      error.message
    );
  }

  process.exit(0);
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);