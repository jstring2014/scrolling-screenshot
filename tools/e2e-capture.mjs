// End-to-end check: load the extension in a real Chromium, capture a fixture
// page with known colour bands, and verify the stitched result pixel by pixel.
// Also reports how long a full run takes, which is what decides whether
// MAX_SCREENS can be raised (MV3 terminates a service worker event at 5 min).
//
// The shipped manifest deliberately has no host_permissions: it relies on
// activeTab, which is only granted when a human clicks the toolbar button.
// Automation can't produce that gesture, so the test runs against a throwaway
// copy of the extension with <all_urls> added. Everything else is the real code.
//
// Needs a Chromium build. Set CHROME_BIN, or let it use the Playwright cache.
// Skips (exit 0) when neither playwright-core nor a browser binary is present,
// so `npm test` stays green on machines without them.

import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const SCREENS = Number(process.env.E2E_SCREENS || 6);
const FIXTURE_URL = "https://fixture.localtest/tall.html";
const require = createRequire(import.meta.url);

function skip(reason) {
  console.log(`e2e capture test skipped: ${reason}`);
  process.exit(0);
}

let chromium;
for (const id of ["playwright", "playwright-core", "/usr/local/lib/node_modules/@playwright/cli/node_modules/playwright-core"]) {
  try {
    ({ chromium } = require(id));
    break;
  } catch { /* try the next candidate */ }
}
if (!chromium) skip("playwright-core not installed");

async function findBrowser() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const candidates = [];
  try {
    candidates.push(chromium.executablePath());
  } catch { /* playwright-core without a matching download */ }

  // playwright-core's pinned revision is often absent while some other revision
  // is downloaded, so check whatever is actually in the cache.
  const cache = process.platform === "darwin"
    ? join(homedir(), "Library/Caches/ms-playwright")
    : join(homedir(), ".cache/ms-playwright");
  const suffixes = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux/chrome",
    "chrome-win/chrome.exe",
  ];
  try {
    for (const entry of (await readdir(cache)).filter((name) => name.startsWith("chromium-")).sort().reverse()) {
      for (const suffix of suffixes) candidates.push(join(cache, entry, suffix));
    }
  } catch { /* no cache directory */ }

  candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

const executablePath = await findBrowser();
if (!executablePath) skip("no Chromium binary found (set CHROME_BIN)");

// Never let a stuck browser hang the whole test run.
const watchdog = setTimeout(() => {
  console.error("e2e capture test timed out");
  process.exit(1);
}, Number(process.env.E2E_TIMEOUT_MS || 180000));

const extDir = await mkdtemp(join(tmpdir(), "fps-ext-"));
const userDataDir = await mkdtemp(join(tmpdir(), "fps-e2e-"));
const downloadsPath = await mkdtemp(join(tmpdir(), "fps-dl-"));
const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };

await cp(ROOT, extDir, {
  recursive: true,
  filter: (src) => !/\/(node_modules|dist|store-assets|\.git|\.claude)$/.test(src) && !src.endsWith(".bak"),
});
const testManifest = JSON.parse(await readFile(join(extDir, "manifest.json"), "utf8"));
testManifest.host_permissions = ["<all_urls>"];
await writeFile(join(extDir, "manifest.json"), JSON.stringify(testManifest, null, 2));

const fixtureHtml = await readFile(join(ROOT, "tools/e2e-fixtures/tall.html"), "utf8");

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: false,
  viewport: null,
  downloadsPath,
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--no-first-run",
    "--window-size=1000,700",
  ],
});

try {
  await context.route(`${FIXTURE_URL}*`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixtureHtml })
  );

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(`${FIXTURE_URL}?screens=${SCREENS}`);
  await page.bringToFront();

  const fixtureInfo = await page.evaluate(() => ({
    bandHeight: Number(document.body.dataset.bandHeight),
    screens: Number(document.body.dataset.screens),
    dpr: window.devicePixelRatio,
  }));

  // Drive run() straight from the worker with a stub port, so the test exercises
  // the real pipeline (scroll → capture → stitch → download → IndexedDB) without
  // needing to click through the popup.
  const result = await worker.evaluate(async () => {
    const messages = [];
    const port = { postMessage: (m) => messages.push(m) };
    const startedAt = Date.now();
    let error = null;
    try {
      await run(port, { format: "png", hideFixedElements: true });
    } catch (err) {
      error = { code: err && err.code, message: String((err && err.message) || err) };
    }
    const elapsedMs = Date.now() - startedAt;

    // Read back exactly what the viewer would read.
    const images = await new Promise((res, rej) => {
      const open = indexedDB.open("fullPageScreenshot", 1);
      open.onerror = () => rej(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("results", "readonly");
        const req = tx.objectStore("results").get("latest");
        req.onsuccess = () => res((req.result && req.result.images) || []);
        req.onerror = () => rej(req.error);
        tx.oncomplete = () => db.close();
      };
    });

    // Sample the red channel down the middle of the stitched image: band i was
    // painted rgb(i*7+3, 40, 90), so a sample identifies which band landed there.
    const probes = [];
    const parts = []; // one entry per stitched part, in order
    const blobTypes = [];
    for (const image of images) {
      blobTypes.push(image instanceof Blob ? image.type : typeof image);
      if (!(image instanceof Blob)) continue;
      const bmp = await createImageBitmap(image);
      parts.push({ width: bmp.width, height: bmp.height });
      const canvas = new OffscreenCanvas(1, bmp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, -Math.floor(bmp.width / 2), 0);
      const data = ctx.getImageData(0, 0, 1, bmp.height).data;
      for (let y = 0; y < bmp.height; y++) probes.push(data[y * 4]);
      bmp.close();
    }

    return { error, elapsedMs, messages, imageCount: images.length, blobTypes, parts, probes };
  });

  const { bandHeight, screens, dpr } = fixtureInfo;
  console.log(`fixture: ${screens} screens x ${bandHeight}px @ dpr ${dpr}`);

  check(!result.error, `run() threw: ${result.error && (result.error.code || result.error.message)}`);
  check(result.imageCount >= 1, "no image was cached for the viewer");
  check(
    result.blobTypes.length > 0 && result.blobTypes.every((type) => type === "image/png"),
    `cached values must be image/png Blobs, got [${result.blobTypes.join(", ")}]`
  );

  const done = result.messages.find((m) => m.type === "done");
  check(Boolean(done), "no done message");
  check(done ? done.viewerReady === true : false, "viewerReady should be true");
  check(done ? !done.stoppedEarly : false, "stoppedEarly should be false on a normally scrolling page");
  check(done ? !done.truncated : false, "truncated should be false");

  const progress = result.messages.filter((m) => m.type === "progress");
  check(progress.length === screens, `expected ${screens} progress messages, got ${progress.length}`);

  // Every status/error message must carry a message key, never literal text.
  const literals = result.messages.filter((m) => (m.type === "status" && !m.code) || (m.type === "error" && !m.code));
  check(literals.length === 0, `messages carrying literal text instead of a key: ${JSON.stringify(literals)}`);

  const shotH = Math.round(bandHeight * dpr);
  const parts = result.parts || [];
  const stitchedHeight = parts.reduce((sum, p) => sum + p.height, 0);
  const width = parts.length ? parts[0].width : 0;
  console.log(`stitched: ${parts.length} part(s), ${width}px wide, ${stitchedHeight}px tall total`);

  check(parts.length === result.imageCount, "every cached image should decode");
  check(done ? done.count === result.imageCount : false, "done.count should match the number of cached images");

  const expectedHeight = shotH * screens;
  check(
    Math.abs(stitchedHeight - expectedHeight) <= screens, // one rounded pixel per screen
    `stitched height ${stitchedHeight} != expected ~${expectedHeight}`
  );

  // Segmentation must respect both the per-side and the total-area canvas limit.
  const MAX_CANVAS_DIM = 32000;
  const MAX_CANVAS_AREA = 1e8;
  const maxSegHeight = Math.max(1, Math.min(MAX_CANVAS_DIM, Math.floor(MAX_CANVAS_AREA / Math.max(1, width))));
  check(
    parts.every((p) => p.height <= maxSegHeight && p.width * p.height <= MAX_CANVAS_AREA),
    `a part exceeded the canvas budget (max ${maxSegHeight}px tall): ${JSON.stringify(parts)}`
  );
  check(
    parts.length === Math.max(1, Math.ceil(stitchedHeight / maxSegHeight)),
    `expected ${Math.max(1, Math.ceil(stitchedHeight / maxSegHeight))} parts, got ${parts.length}`
  );

  // Each band must appear at its own offset, in order, with no duplicates or gaps.
  if (result.probes.length) {
    let misplaced = 0;
    const sampled = [];
    for (let band = 0; band < screens; band++) {
      const y = band * shotH + Math.floor(shotH / 2); // middle of the band, away from seams
      const expected = band * 3 + 3;
      const actual = result.probes[y];
      sampled.push(actual);
      if (actual === undefined || Math.abs(actual - expected) > 1) {
        misplaced += 1;
        if (misplaced <= 3) console.log(`  band ${band} at y=${y}: expected r≈${expected}, got ${actual}`);
      }
    }
    check(misplaced === 0, `${misplaced}/${screens} bands landed at the wrong offset`);
    check(new Set(sampled).size === screens, "stitched image repeats the same screen");

    // The fixed header is black; it must appear once at the top, not once per screen.
    const blackRows = result.probes.filter((r) => r === 0).length;
    check(blackRows <= Math.round(48 * dpr) + 4, `fixed header repeated down the image (${blackRows} black rows)`);
  }

  // The extension pages must render localized text, not fall back to the raw key.
  // Which language that is depends on the browser's UI locale, so compare against
  // what the worker itself resolves rather than assuming English.
  const expectedLang = await worker.evaluate(() => chrome.i18n.getMessage("localeCode"));
  const uiLanguage = await worker.evaluate(() => chrome.i18n.getUILanguage());
  console.log(`browser UI language: ${uiLanguage} → localeCode "${expectedLang}"`);
  check(Boolean(expectedLang), "localeCode did not resolve — _locales is not being read");

  for (const pageName of ["popup.html", "viewer.html"]) {
    const extPage = await context.newPage();
    await extPage.goto(worker.url().replace("background.js", pageName));
    const rendered = await extPage.evaluate(() => ({
      lang: document.documentElement.lang,
      // t() returns the key itself when getMessage finds nothing.
      unresolved: [...document.querySelectorAll("[data-i18n]")]
        .filter((el) => el.textContent.trim() === el.dataset.i18n)
        .map((el) => el.dataset.i18n),
      sample: document.querySelector("[data-i18n]")?.textContent,
    }));
    check(rendered.lang === expectedLang, `${pageName}: <html lang> should be "${expectedLang}", got "${rendered.lang}"`);
    check(rendered.unresolved.length === 0, `${pageName}: untranslated keys rendered as text: ${rendered.unresolved.join(", ")}`);
    check(Boolean(rendered.sample && rendered.sample.trim()), `${pageName}: first localized node is empty`);
    await extPage.close();
  }

  const perScreenMs = result.elapsedMs / Math.max(1, screens);
  console.log(`elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s for ${screens} screens (${Math.round(perScreenMs)}ms/screen)`);
  console.log(`extrapolated to 80 screens: ${((perScreenMs * 80) / 1000).toFixed(0)}s (MV3 kills a worker event at 300s)`);
} finally {
  await context.close().catch(() => {});
  await Promise.all([extDir, userDataDir, downloadsPath].map((d) => rm(d, { recursive: true, force: true })));
  clearTimeout(watchdog);
}

if (failures.length) {
  console.error(failures.map((f) => `- ${f}`).join("\n"));
  process.exit(1);
}
console.log("e2e capture test passed");
