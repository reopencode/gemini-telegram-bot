#!/usr/bin/env node
/**
 * Export Google/Gemini cookies (including rotating __Secure-1PSIDTS) from the
 * box Chrome cookie jars via the platform cdp-cookies helper (Network.getAllCookies).
 *
 * Why: sand-cookie-persist intentionally omits rotating auth cookies from
 * chrome-cookie-seed.json, but gemini_webapi needs __Secure-1PSID + __Secure-1PSIDTS
 * for AVAILABLE (non-guest) sessions.
 *
 * Prefer the Chrome instance that currently has gemini.google.com open.
 * Does not drive the page (no clicks); cookie jar read only.
 *
 * Run with: /exec-daemon/node scripts/export_live_cookies.mjs
 * (system node lacks global WebSocket used by cdp-cookies)
 */
import { writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectBrowser,
  discoverChromeDebugPorts,
  discoverMonitorPorts,
  listPageTargets,
  readCookies,
} from "/usr/local/bin/cdp-cookies.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.GEMINI_COOKIES_PATH || join(ROOT, ".cookies.json");
const OUT_FULL = join(ROOT, ".cookies.full.json");

const KEEP = new Set([
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-3PSID",
  "__Secure-3PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "NID",
  "SIDCC",
  "COMPASS",
  "ACCOUNT_CHOOSER",
  "LSID",
  "__Host-GAPS",
  "__Host-1PLSID",
  "__Host-3PLSID",
  "OTZ",
]);

function isGoogleish(domain = "") {
  return /google|gemini/.test(domain) && !/youtube/.test(domain);
}

function preferDomain(prev, next) {
  if (!prev) return true;
  const score = (d) =>
    (d === ".google.com" ? 3 : 0) +
    (/accounts\.google\.com/.test(d) ? 2 : 0) +
    (/gemini/.test(d) ? 2 : 0);
  return score(next) >= score(prev);
}

async function main() {
  if (typeof WebSocket === "undefined") {
    console.error("WebSocket missing — run with /exec-daemon/node");
    process.exit(1);
  }
  const ports = [...new Set([...discoverMonitorPorts(), ...discoverChromeDebugPorts()])].sort(
    (a, b) => a - b,
  );
  let best = null;
  for (const port of ports) {
    let browser;
    try {
      browser = await connectBrowser(port);
      const targets = await listPageTargets(browser);
      const hasGemini = targets.some((t) => /gemini\.google\.com/.test(t.url || ""));
      const jar = await readCookies(browser);
      const google = [...jar.values()].filter((c) => isGoogleish(c.domain));
      const names = new Set(google.map((c) => c.name));
      const score =
        (hasGemini ? 1000 : 0) +
        (names.has("__Secure-1PSIDTS") ? 100 : 0) +
        (names.has("__Secure-1PSID") ? 50 : 0) +
        google.length;
      console.log(
        `port ${port}: google=${google.length} geminiTab=${hasGemini} 1PSIDTS=${names.has("__Secure-1PSIDTS")}`,
      );
      if (!best || score > best.score) {
        if (best?.browser) best.browser.close();
        best = { port, browser, google, score, hasGemini };
      } else {
        browser.close();
      }
    } catch (e) {
      if (browser) try { browser.close(); } catch {}
      console.log(`port ${port} failed: ${e.message || e}`);
    }
  }
  if (!best || !best.google.some((c) => c.name === "__Secure-1PSID")) {
    console.error("Could not find __Secure-1PSID in any Chrome jar");
    process.exit(1);
  }

  writeFileSync(OUT_FULL, JSON.stringify(best.google, null, 2));
  chmodSync(OUT_FULL, 0o600);

  const flat = {};
  const dom = {};
  for (const c of best.google) {
    if (!KEEP.has(c.name) && !c.name.includes("PSID")) continue;
    if (!preferDomain(dom[c.name], c.domain || "")) continue;
    flat[c.name] = c.value;
    dom[c.name] = c.domain;
  }
  writeFileSync(OUT, JSON.stringify(flat, null, 2));
  chmodSync(OUT, 0o600);

  console.log(`Wrote ${OUT} (${Object.keys(flat).length} cookies) from port ${best.port}`);
  console.log(
    `Has __Secure-1PSID=${Boolean(flat["__Secure-1PSID"])} __Secure-1PSIDTS=${Boolean(flat["__Secure-1PSIDTS"])}`,
  );
  console.log(`gemini_tab=${best.hasGemini}`);
  best.browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
