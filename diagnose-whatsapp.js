require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const executablePath = chromeCandidates.find(fs.existsSync);

console.log("=== WhatsApp Web readiness diagnostic ===");
console.log(`Chrome: ${executablePath || "Puppeteer's bundled Chromium"}`);
console.log(`whatsapp-web.js: ${require("whatsapp-web.js/package.json").version}`);
console.log(`Puppeteer: ${require("puppeteer/package.json").version}`);
console.log(`Session path: ${path.join(__dirname, ".wwebjs_auth")}`);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, ".wwebjs_auth") }),
  puppeteer: {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
});

function print(label, value) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(value, null, 2));
}

async function inspect(label) {
  try {
    const page = client.pupPage;
    if (!page) throw new Error("client.pupPage is unavailable");

    const result = await page.evaluate(() => {
      const safe = (fn) => {
        try { return fn(); }
        catch (error) { return { error: String(error?.stack || error?.message || error) }; }
      };
      const type = (v) => {
        try { return typeof v; } catch { return "error"; }
      };
      const keys = (v) => {
        try { return v ? Object.keys(v).slice(0, 80) : []; } catch { return []; }
      };

      const out = {
        page: safe(() => ({
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          body: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 350),
        })),
        WWebJS: { type: type(window.WWebJS), keys: keys(window.WWebJS) },
        Store: type(window.Store),
        require: type(window.require),
        checks: {},
      };

      out.checks.connSerialize = safe(() => {
        const mod = window.require("WAWebConnModel");
        const value = mod.Conn.serialize();
        return { type: type(value), keys: keys(value), hasWid: !!value?.wid, connected: value?.connected };
      });

      out.checks.pnUser = safe(() => {
        const value = window.require("WAWebUserPrefsMeUser").getMaybeMePnUser();
        return { type: type(value), value: value == null ? null : String(value) };
      });

      out.checks.lidUser = safe(() => {
        const value = window.require("WAWebUserPrefsMeUser").getMaybeMeLidUser();
        return { type: type(value), value: value == null ? null : String(value) };
      });

      // Inspect the exact objects used by attachEventListeners().
      out.checks.pageBindings = safe(() => ({
        onAddMessageEvent: type(window.onAddMessageEvent),
        onChangeMessageTypeEvent: type(window.onChangeMessageTypeEvent),
        onAddMessageEventKeys: keys(window.onAddMessageEvent),
        onChangeMessageTypeEventKeys: keys(window.onChangeMessageTypeEvent),
      }));

      out.checks.eventTargets = safe(() => ({
        WWebJSKeys: keys(window.WWebJS),
        cmdType: type(window.require("WAWebCmd")?.Cmd),
        socketType: type(window.require("WAWebSocketModel")?.Socket),
      }));

      return out;
    });

    print(label, result);
  } catch (error) {
    print(`${label} ERROR`, { error: error.stack || error.message || String(error) });
  }
}

function attachBrowserErrorLogging() {
  const page = client.pupPage;
  if (!page) return;

  page.on("pageerror", (error) => {
    console.error("PAGE ERROR:", error.stack || error.message || String(error));
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error("BROWSER CONSOLE ERROR:", message.text());
    }
  });
}

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function runClientStateCheck() {
  try {
    const state = await withTimeout(client.getState(), 5000);
    print("client.getState()", { state });
  } catch (error) {
    print("client.getState() ERROR", { error: error.stack || error.message || String(error) });
  }
}

async function runAttachEventListenersProbe() {
  console.log("\n=== attachEventListeners probe ===");
  try {
    const method = client.attachEventListeners;
    console.log(`attachEventListeners type: ${typeof method}`);
    if (typeof method !== "function") {
      throw new Error("client.attachEventListeners is not a function");
    }

    console.log("Calling client.attachEventListeners() with a 10s timeout...");
    await withTimeout(method.call(client), 10000);
    console.log("ATTACH_EVENT_LISTENERS COMPLETED");
  } catch (error) {
    console.error("ATTACH_EVENT_LISTENERS ERROR:");
    console.error(error.stack || error.message || String(error));
  }
}

client.on("loading_screen", (percent, message) => {
  console.log(`loading: ${percent}% - ${message}`);
});

client.on("authenticated", async () => {
  console.log("authenticated");
  attachBrowserErrorLogging();
  await inspect("authenticated");
});

client.on("ready", async () => {
  console.log("READY EVENT FIRED");
  await inspect("ready");
  await runClientStateCheck();
  await client.destroy();
  process.exit(0);
});

client.on("auth_failure", (message) => {
  console.error("AUTH FAILURE:", message);
  process.exit(1);
});

client.on("disconnected", (reason) => {
  console.error("DISCONNECTED:", reason);
});

let pollCount = 0;
const pollTimer = setInterval(async () => {
  if (!client.pupPage) return;
  pollCount++;
  await inspect(`poll ${pollCount}`);
  if (pollCount === 2) {
    await runClientStateCheck();
    await runAttachEventListenersProbe();
  }
}, 10000);

setTimeout(() => {
  clearInterval(pollTimer);
  console.error("\nTIMEOUT: ready event did not fire within 120 seconds.");
  process.exit(2);
}, 120000);

client.initialize().catch((error) => {
  console.error("INITIALIZE ERROR:", error.stack || error.message || error);
  process.exit(1);
});
