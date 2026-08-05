// Shared helpers for driving the extension in a real Chromium: locating a
// browser binary, and loading the extension with host permissions granted.
//
// The shipped manifest deliberately has no host_permissions — it relies on
// activeTab, which is only granted when a human clicks the toolbar button.
// Automation can't produce that gesture, so both the e2e test and the store
// asset generator run against a throwaway copy with <all_urls> added.

import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  for (const id of [
    "playwright",
    "playwright-core",
    "/usr/local/lib/node_modules/@playwright/cli/node_modules/playwright-core",
    "/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright-core",
  ]) {
    try {
      return require(id).chromium;
    } catch { /* try the next candidate */ }
  }
  return null;
}

export async function findBrowser(chromium) {
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
    const { readdir } = await import("node:fs/promises");
    for (const entry of (await readdir(cache)).filter((n) => n.startsWith("chromium-")).sort().reverse()) {
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

// Copies the extension to a temp dir and grants <all_urls>. Returns the path
// plus a cleanup function that also removes the profile and downloads dirs.
export async function stageExtension(root, { onlyLocale } = {}) {
  const extDir = await mkdtemp(join(tmpdir(), "fps-ext-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "fps-profile-"));
  const downloadsPath = await mkdtemp(join(tmpdir(), "fps-dl-"));

  await cp(root, extDir, {
    recursive: true,
    filter: (src) => !/\/(node_modules|dist|store-assets|\.git|\.claude)$/.test(src) && !src.endsWith(".bak"),
  });
  const manifest = JSON.parse(await readFile(join(extDir, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];

  // chrome.i18n follows the browser UI language and macOS ignores --lang, so the
  // only reliable way to pin the rendered language is to ship a single locale.
  if (onlyLocale) {
    const { readdir } = await import("node:fs/promises");
    const localesDir = join(extDir, "_locales");
    for (const name of await readdir(localesDir)) {
      if (name !== onlyLocale) await rm(join(localesDir, name), { recursive: true, force: true });
    }
    manifest.default_locale = onlyLocale;
  }

  await writeFile(join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return {
    extDir,
    userDataDir,
    downloadsPath,
    cleanup: () => Promise.all(
      [extDir, userDataDir, downloadsPath].map((d) => rm(d, { recursive: true, force: true }))
    ),
  };
}

export async function launchWithExtension(chromium, executablePath, staged, { width, height, lang }) {
  const context = await chromium.launchPersistentContext(staged.userDataDir, {
    executablePath,
    headless: false,
    viewport: null,
    downloadsPath: staged.downloadsPath,
    acceptDownloads: true,
    // chrome.i18n follows the browser UI language, which otherwise comes from the
    // host OS — store assets must be rendered in a language we choose.
    ...(lang ? { locale: lang, env: { ...process.env, LANG: `${lang.replace("-", "_")}.UTF-8`, LANGUAGE: lang } } : {}),
    args: [
      `--disable-extensions-except=${staged.extDir}`,
      `--load-extension=${staged.extDir}`,
      "--no-first-run",
      "--hide-crash-restore-bubble",
      ...(lang ? [`--lang=${lang}`] : []),
      `--window-size=${width},${height}`,
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });

  // chrome-extension: is not a "special" scheme, so URL.origin yields "null".
  // Derive the origin from the worker script URL instead.
  const extensionOrigin = worker.url().replace(/\/background\.js.*$/, "");

  return { context, worker, extensionOrigin };
}
