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
        try { return value ? Object.keys(value).slice(0, 40) : []; } catch { return []; }
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
        WAWebConnModel: safeType(window.WAWebConnModel),
        WAWebUserPrefsMeUser: safeType(window.WAWebUserPrefsMeUser),
        require: safeType(window.require),
      };

      for (const key of ["WAWebConnModel", "WAWebUserPrefsMeUser"]) {
        const value = window[key];
        if (value != null) {
          info[key + "Keys"] = safeKeys(value);
          info[key + "String"] = safeString(value).slice(0, 200);
        }
      }

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
