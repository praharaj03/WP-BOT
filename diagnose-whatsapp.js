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

      // These are the exact operations used by whatsapp-web.js during ready().
      out.checks.connModule = safe(() => {
        const mod = window.require("WAWebConnModel");
        return {
          type: type(mod),
          keys: keys(mod),
          connType: type(mod?.Conn),
          connKeys: keys(mod?.Conn),
          serializeType: type(mod?.Conn?.serialize),
        };
      });

      out.checks.connSerialize = safe(() => {
        const mod = window.require("WAWebConnModel");
        if (type(mod?.Conn?.serialize) !== "function") {
          throw new Error("WAWebConnModel.Conn.serialize is not a function");
        }
        const value = mod.Conn.serialize();
        return {
          type: type(value),
          keys: keys(value),
          value: value == null ? value : String(value).slice(0, 500),
        };
      });

      out.checks.meUserModule = safe(() => {
        const mod = window.require("WAWebUserPrefsMeUser");
        return {
          type: type(mod),
          keys: keys(mod),
          pnGetter: type(mod?.getMaybeMePnUser),
          lidGetter: type(mod?.getMaybeMeLidUser),
        };
      });

      out.checks.pnUser = safe(() => {
        const mod = window.require("WAWebUserPrefsMeUser");
        const value = mod.getMaybeMePnUser();
        return {
          type: type(value),
          value: value == null ? null : String(value).slice(0, 300),
          keys: keys(value),
        };
      });

      out.checks.lidUser = safe(() => {
        const mod = window.require("WAWebUserPrefsMeUser");
        const value = mod.getMaybeMeLidUser();
        return {
          type: type(value),
          value: value == null ? null : String(value).slice(0, 300),
          keys: keys(value),
        };
      });

      out.checks.wwebjsVersion = safe(() => ({
        type: type(window.WWebJS?.compareWwebVersions),
        version: safe(() => window.WWebJS?.compareWwebVersions?.("2.3000.0", ">=")),
      }));

      return out;
    });

    print(label, result);
  } catch (error) {
    print(`${label} ERROR`, { error: error.stack || error.message || String(error) });
  }
}

async function runClientStateCheck() {
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), 5000)
  );
  try {
    const result = await Promise.race([
      client.getState().then((state) => ({ state })).catch((error) => ({ error: error.stack || error.message || String(error) })),
      timeout,
    ]);
    print("client.getState()", result);
  } catch (error) {
    print("client.getState() ERROR", { error: error.stack || error.message || String(error) });
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
  if (pollCount === 2) await runClientStateCheck();
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
