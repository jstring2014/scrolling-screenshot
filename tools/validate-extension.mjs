import { access, readdir, readFile } from "node:fs/promises";

const requiredFiles = [
  "background.js",
  "popup.html",
  "popup.js",
  "viewer.html",
  "viewer.js",
  "i18n.js",
  "_locales/en/messages.json",
  "_locales/zh_CN/messages.json",
  "icons/source.svg",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "tools/generate-icons.mjs",
  "tools/generate-store-assets.mjs",
  "tools/package-extension.mjs",
  "PRIVACY.md",
  "STORE_LISTING.md",
];

// Everything that ships and is expected to be language-neutral: user-facing text
// must come from _locales, not from a literal in the source.
const localizedSources = ["background.js", "popup.js", "viewer.js", "i18n.js", "popup.html", "viewer.html"];

const pngSizes = {
  "icons/icon16.png": [16, 16],
  "icons/icon48.png": [48, 48],
  "icons/icon128.png": [128, 128],
  // Chrome Web Store: screenshots 1280x800, small promo tile 440x280 (required),
  // marquee 1400x560, store icon 128x128. Edge additionally wants a 300x300 logo.
  "store-assets/logo-300.png": [300, 300],
  "store-assets/store-icon-128.png": [128, 128],
  "store-assets/screenshot-popup-1280x800.png": [1280, 800],
  "store-assets/screenshot-fullpage-1280x800.png": [1280, 800],
  "store-assets/screenshot-container-scroll-1280x800.png": [1280, 800],
  "store-assets/screenshot-preview-1280x800.png": [1280, 800],
  "store-assets/screenshot-privacy-1280x800.png": [1280, 800],
  "store-assets/tile-small-440x280.png": [440, 280],
  "store-assets/tile-large-1400x560.png": [1400, 560],
};

// Store listing fields have hard limits and the upload is rejected past them.
const listingLimits = { extensionName: 75, extensionDescription: 132 };

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const errors = [];

if (manifest.manifest_version !== 3) {
  errors.push("manifest_version must be 3");
}

if (manifest.version !== pkg.version) {
  errors.push(`version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
}

for (const permission of ["activeTab", "scripting", "downloads"]) {
  if (!manifest.permissions.includes(permission)) {
    errors.push(`missing required permission: ${permission}`);
  }
}

for (const permission of ["tabs"]) {
  if (manifest.permissions.includes(permission)) {
    errors.push(`permission should stay removed unless there is a concrete need: ${permission}`);
  }
}

if (manifest.host_permissions && manifest.host_permissions.length) {
  errors.push("host_permissions should stay empty; activeTab is enough for the current workflow");
}

if (manifest.name !== "__MSG_extensionName__") {
  errors.push("manifest.name should use localization placeholder __MSG_extensionName__");
}

if (manifest.description !== "__MSG_extensionDescription__") {
  errors.push("manifest.description should use localization placeholder __MSG_extensionDescription__");
}

// English is the fallback for every user whose language has no locale directory,
// so it has to be the default rather than zh_CN.
if (manifest.default_locale !== "en") {
  errors.push("manifest.default_locale should be en (it is what non-matching languages fall back to)");
}

for (const file of requiredFiles) {
  try {
    await access(file);
  } catch {
    errors.push(`missing file: ${file}`);
  }
}

for (const [file, expected] of Object.entries(pngSizes)) {
  try {
    const { width, height, colorType } = await pngInfo(file);
    if (width !== expected[0] || height !== expected[1]) {
      errors.push(`invalid PNG size for ${file}: expected ${expected.join("x")}, got ${width}x${height}`);
    }
    // Chrome rejects screenshots and promo tiles that carry an alpha channel
    // ("24-bit PNG, no alpha"), but the store icon needs its transparent padding.
    const isIcon = /icon|logo/.test(file);
    const hasAlpha = colorType === 4 || colorType === 6;
    if (!isIcon && hasAlpha) {
      errors.push(`${file} has an alpha channel; Chrome requires 24-bit PNG with no alpha for screenshots and promo tiles`);
    }
    if (isIcon && !hasAlpha) {
      errors.push(`${file} has no alpha channel; the store icon needs transparent padding`);
    }
  } catch (err) {
    errors.push(`missing or invalid PNG: ${file} (${err.message})`);
  }
}

// ---- localization ----

const localeNames = (await readdir("_locales", { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!localeNames.includes(manifest.default_locale)) {
  errors.push(`_locales is missing the default locale directory: ${manifest.default_locale}`);
}

const locales = {};
for (const name of localeNames) {
  try {
    locales[name] = JSON.parse(await readFile(`_locales/${name}/messages.json`, "utf8"));
  } catch (err) {
    errors.push(`unreadable locale ${name}: ${err.message}`);
  }
}

const base = locales[manifest.default_locale] || {};
const baseKeys = Object.keys(base).sort();

for (const [name, messages] of Object.entries(locales)) {
  const keys = Object.keys(messages).sort();

  for (const key of baseKeys) {
    if (!keys.includes(key)) errors.push(`locale ${name}: missing key ${key}`);
  }
  for (const key of keys) {
    if (!baseKeys.includes(key)) errors.push(`locale ${name}: extra key not in ${manifest.default_locale}: ${key}`);
  }

  for (const [key, entry] of Object.entries(messages)) {
    if (!entry || typeof entry.message !== "string" || !entry.message.trim()) {
      errors.push(`locale ${name}: empty message for key ${key}`);
      continue;
    }

    // Every $NAME$ used in the text must be declared, or getMessage renders it raw.
    const used = new Set([...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()));
    const declared = new Set(Object.keys(entry.placeholders || {}).map((p) => p.toLowerCase()));
    for (const name2 of used) {
      if (!declared.has(name2)) errors.push(`locale ${name}: key ${key} uses undeclared placeholder $${name2}$`);
    }
    for (const name2 of declared) {
      if (!used.has(name2)) errors.push(`locale ${name}: key ${key} declares unused placeholder ${name2}`);
    }

    if (listingLimits[key] && entry.message.length > listingLimits[key]) {
      errors.push(`locale ${name}: ${key} is ${entry.message.length} characters, the store limit is ${listingLimits[key]}`);
    }

    // A translation that drops a substitution silently loses data at runtime.
    const baseEntry = base[key];
    if (baseEntry && name !== manifest.default_locale) {
      const baseUsed = new Set([...baseEntry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()));
      for (const name2 of baseUsed) {
        if (!used.has(name2)) errors.push(`locale ${name}: key ${key} is missing placeholder $${name2}$ present in ${manifest.default_locale}`);
      }
    }
  }
}

// Keys referenced from the manifest and from code must actually exist.
const usedKeys = new Set();
for (const match of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) usedKeys.add(match[1]);

const cjk = /[　-〿㐀-䶿一-鿿＀-￯]/;
for (const file of localizedSources) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    continue; // already reported as a missing required file
  }

  for (const match of source.matchAll(/data-i18n(?:-alt|-title)?="([A-Za-z0-9_]+)"/g)) usedKeys.add(match[1]);
  // Message keys reach getMessage() through too many shapes to pattern-match the
  // call sites (t(), setStage(), new CapError(), `code:`, ternaries inside all of
  // those). Instead, treat any string literal that follows the key naming
  // convention — a known prefix followed by a capitalized word — as a reference.
  // That catches a typo in any of those forms. Element ids share the convention,
  // so drop element ids — both the HTML attribute and the lookup — first.
  const scannable = source
    .replace(/getElementById\(\s*"[^"]*"\s*\)/g, "getElementById()")
    .replace(/\sid="[^"]*"/g, " id=\"\"");
  for (const match of scannable.matchAll(/"((?:popup|viewer|status|stage|done|err|extension|action|command|locale|list)[A-Z][A-Za-z0-9_]*)"/g)) {
    usedKeys.add(match[1]);
  }

  source.split("\n").forEach((line, index) => {
    if (cjk.test(line)) errors.push(`${file}:${index + 1}: hardcoded CJK text — move it into _locales`);
  });
}

for (const key of usedKeys) {
  if (!baseKeys.includes(key)) errors.push(`message key used in code/manifest but missing from _locales: ${key}`);
}

if (!manifest.background || manifest.background.service_worker !== "background.js") {
  errors.push("background.service_worker must point to background.js");
}

if (!manifest.action || manifest.action.default_popup !== "popup.html") {
  errors.push("action.default_popup must point to popup.html");
}

async function pngInfo(file) {
  const data = await readFile(file);
  if (data.length < 26 || data.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("not a PNG");
  }
  // IHDR: width, height, bit depth, colour type at fixed offsets.
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colorType: data[25] };
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`extension validation passed (${localeNames.length} locales, ${baseKeys.length} message keys, ${usedKeys.size} referenced)`);
