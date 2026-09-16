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

async function inspect(label) {
  try {
    const page = client.pupPage;
    if (!page) throw new Error("client.pupPage is unavailable");

    const result = await page.evaluate(async () => {
      const safeType = (value) => {
        try { return typeof value; } catch { return "error"; }
      };
      const safeString = (value) => {
        try { return value == null ? null : String(value); } catch { return "error"; }
      };
      const safeKeys = (value) => {
        try { return value ? Object.keys(value).slice(0, 60) : []; } catch { return []; }
      };
      const safeRequire = (name) => {
        try {
          const value = window.require(name);
          return {
            found: true,
            type: safeType(value),
            keys: safeKeys(value),
            string: safeString(value).slice(0, 200),
          };
        } catch (error) {
          return { found: false, error: String(error?.message || error) };
        }
      };

      const info = {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        body: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 500),
        WWebJS: safeType(window.WWebJS),
        WWebJSKeys: safeKeys(window.WWebJS),
        Store: safeType(window.Store),
        webpackChunk: safeType(window.webpackChunkwhatsapp_web_client),
        webpackChunkKeys: safeKeys(window.webpackChunkwhatsapp_web_client),
        require: safeType(window.require),
        requireKeys: safeKeys(window.require),
        requireModuleCount: safeType(window.require?.m) === "object" ? Object.keys(window.require.m).length : null,
        knownModules: {},
      };

      const knownNames = [
        "WAWebConnModel",
        "WAWebUserPrefsMeUser",
        "WAWebSocketModel",
        "WAWebCmd",
        "WAWebUserPrefsMultiDevice",
        "WAWebContactModel",
        "WAWebChatModel",
        "WAWebMsgModel",
        "WAWebWidFactory",
      ];
      for (const name of knownNames) info.knownModules[name] = safeRequire(name);

      const matches = [];
      const modules = window.require?.m;
      if (modules && typeof modules === "object") {
        for (const id of Object.keys(modules)) {
          let source = "";
          try { source = String(modules[id]); } catch { continue; }
          if (
            source.includes("getMaybeMePnUser") ||
            source.includes("getMaybeMeLidUser") ||
            source.includes("Conn.serialize") ||
            source.includes("WAWebConnModel")
          ) {
            matches.push({
              id,
              hasPnUser: source.includes("getMaybeMePnUser"),
              hasLidUser: source.includes("getMaybeMeLidUser"),
              hasConnSerialize: source.includes("Conn.serialize"),
              hasConnModelName: source.includes("WAWebConnModel"),
              source: source.slice(0, 500),
            });
            if (matches.length >= 20) break;
          }
        }
      }
      info.moduleSourceMatches = matches;

      return info;
    });

    console.log(`\n--- ${label} ---`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`\n--- ${label} ERROR ---`);
    console.error(error.stack || error.message || error);
  }
}

client.on("loading_screen", (percent, message) => {
  console.log(`loading: ${percent}% - ${message}`);
});

client.on("authenticated", async () => {
  console.log("authenticated");
  await inspect("authenticated");
});

client.on("ready", async () => {
  console.log("READY EVENT FIRED");
  await inspect("ready");
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

setInterval(async () => {
  if (!client.pupPage) return;
  await inspect("poll");
}, 10000);

setTimeout(() => {
  console.error("\nTIMEOUT: ready event did not fire within 120 seconds.");
  process.exit(2);
}, 120000);

client.initialize().catch((error) => {
  console.error("INITIALIZE ERROR:", error.stack || error.message || error);
  process.exit(1);
});
