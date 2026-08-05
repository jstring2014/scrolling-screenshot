// Generates Chrome Web Store / Edge Add-ons listing assets from REAL captures.
//
// It loads the actual extension in Chromium, runs a real capture on two demo
// pages, screenshots the real popup and viewer, then composes the store tiles
// as HTML at exact pixel sizes. Everything is rendered by the browser, so text
// uses real system fonts — the previous generator hand-plotted a bitmap font
// and silently dropped every character it had no glyph for.
//
// Chrome Web Store sizes: screenshots 1280x800 (full bleed, no padding, 1-5),
// small promo tile 440x280 (required), marquee 1400x560 (optional),
// store icon 128x128 with 96x96 of artwork inside 16px of transparent padding.
//
// Needs a Chromium build: set CHROME_BIN, or rely on the Playwright cache.

import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findBrowser, launchWithExtension, loadPlaywright, stageExtension } from "./lib/extension-browser.mjs";

const ROOT = resolve(".");
const OUT = join(ROOT, "store-assets");
const DEMO_ORIGIN = "https://demo.localtest";
const WINDOW = { width: 1240, height: 820, lang: "en-US" };

const chromium = loadPlaywright();
if (!chromium) {
  console.error("playwright-core is required to generate store assets (npm i -D playwright-core)");
  process.exit(1);
}
const executablePath = await findBrowser(chromium);
if (!executablePath) {
  console.error("no Chromium binary found — set CHROME_BIN");
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

const BRAND = { blue: "#2f6df6", teal: "#12b3a0", ink: "#101623", sub: "#5b6472", line: "#e4e8f0" };
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "Helvetica Neue", Arial, sans-serif`;

const LOCALE = process.env.STORE_LOCALE || "en";
const staged = await stageExtension(ROOT, { onlyLocale: LOCALE });
const { context, worker, extensionOrigin } = await launchWithExtension(chromium, executablePath, staged, WINDOW);
const written = [];

try {
  const demoPages = {
    "/article": await readFile(join(ROOT, "tools/store/demo-article.html"), "utf8"),
    "/dashboard": await readFile(join(ROOT, "tools/store/demo-dashboard.html"), "utf8"),
  };
  await context.route(`${DEMO_ORIGIN}/**`, (route) => {
    const body = demoPages[new URL(route.request().url()).pathname];
    return body
      ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body })
      : route.fulfill({ status: 404, body: "not found" });
  });

  const shippedManifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
  const page = context.pages()[0] || (await context.newPage());

  console.log("capturing demo pages with the real extension…");

  await page.goto(`${DEMO_ORIGIN}/article`);
  await page.bringToFront();
  await page.waitForTimeout(500);
  const articleShot = await shot(page);
  const article = await captureLong(worker, 620);
  console.log(`  article: ${article.screens} screens, mode=${article.scrollMode}`);

  await page.goto(`${DEMO_ORIGIN}/dashboard`);
  await page.bringToFront();
  await page.waitForTimeout(500);
  const dashboardShot = await shot(page);
  const panelRect = await page.evaluate(() => {
    const r = document.getElementById("grid").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  const dashboard = await captureLong(worker, 620);
  console.log(`  dashboard: ${dashboard.screens} screens, mode=${dashboard.scrollMode}`);
  if (dashboard.scrollMode !== "container") {
    console.warn("  WARNING: the dashboard demo was captured as a whole page, not as an in-page scroll area —");
    console.warn("  the container screenshot would be misleading. Check findMainScrollTarget().");
  }

  const popupIdle = await popupShot(context, extensionOrigin, null);
  const popupBusy = await popupShot(context, extensionOrigin, (pg) =>
    pg.evaluate(() => {
      show("busy");
      setStage("stageCapturing");
      setProgress(0.44);
      document.getElementById("status").textContent =
        t("statusCapturing", ["4", "9"]) + t("listSeparator") + t("statusRemainingSec", ["6"]);
    })
  );
  const viewerShot = await viewerPageShot(context, extensionOrigin);

  const compose = async (name, width, height, html, omitBackground = false) => {
    const tile = await context.newPage();
    await tile.setViewportSize({ width, height });
    await tile.setContent(`<!DOCTYPE html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      html,body{width:${width}px;height:${height}px;overflow:hidden;font-family:${FONT};color:${BRAND.ink};
                -webkit-font-smoothing:antialiased}
    </style>${html}`);
    await tile.waitForTimeout(300);
    await tile.screenshot({ path: join(OUT, name), omitBackground });
    await tile.close();
    written.push(`${name} (${width}x${height})`);
  };

  await compose("screenshot-popup-1280x800.png", 1280, 800, heroTile(articleShot, popupIdle));
  await compose("screenshot-fullpage-1280x800.png", 1280, 800, comparisonTile(articleShot, article));
  await compose("screenshot-container-scroll-1280x800.png", 1280, 800, containerTile(dashboardShot, dashboard, panelRect));
  await compose("screenshot-preview-1280x800.png", 1280, 800, previewTile(viewerShot, popupBusy));
  await compose("screenshot-privacy-1280x800.png", 1280, 800, privacyTile(shippedManifest));
  await compose("tile-small-440x280.png", 440, 280, promoTile(article));
  await compose("tile-large-1400x560.png", 1400, 560, marqueeTile(article));

  // Edge wants a 300x300 logo; Chrome wants 128x128 with 16px of transparent padding.
  const iconSvg = await readFile(join(ROOT, "icons/source.svg"), "utf8");
  const svgUrl = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}`;
  await compose("logo-300.png", 300, 300, `<img src="${svgUrl}" style="width:300px;height:300px;display:block">`, true);
  await compose("store-icon-128.png", 128, 128,
    `<img src="${svgUrl}" style="width:96px;height:96px;display:block;margin:16px">`, true);
} finally {
  await context.close().catch(() => {});
  await staged.cleanup();
}

console.log(`\nwrote ${written.length} assets to store-assets/`);
for (const w of written) console.log(`  ${w}`);

// ---------------------------------------------------------------- capture

async function shot(page) {
  return `data:image/png;base64,${(await page.screenshot()).toString("base64")}`;
}

// Runs the extension's real capture on the active tab and returns the stitched
// image, downscaled so the composed tile HTML stays a reasonable size.
async function captureLong(worker, maxWidth) {
  return worker.evaluate(async (maxW) => {
    const messages = [];
    await run({ postMessage: (m) => messages.push(m) }, { format: "png", hideFixedElements: true });

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
    if (!images.length) throw new Error("capture produced no image");

    const bmp = await createImageBitmap(images[0]);
    const scale = Math.min(1, maxW / bmp.width);
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const dataUrl = await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result);
      fr.readAsDataURL(blob);
    });

    // Which mode ran is reported through the first status message.
    const status = messages.find((m) => m.type === "status" && m.code);
    return {
      dataUrl,
      width: w,
      height: h,
      screens: messages.filter((m) => m.type === "progress").length,
      scrollMode: status && status.code === "statusContainerDetected" ? "container" : "page",
    };
  }, maxWidth);
}

async function popupShot(context, origin, drive) {
  const pg = await context.newPage();
  await pg.setViewportSize({ width: 360, height: 520 });
  await pg.goto(`${origin}/popup.html`);
  await pg.waitForTimeout(250);
  if (drive) await drive(pg);
  await pg.waitForTimeout(250);
  const buffer = await pg.locator("body").screenshot();
  await pg.close();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function viewerPageShot(context, origin) {
  const pg = await context.newPage();
  await pg.setViewportSize({ width: 1120, height: 700 });
  await pg.goto(`${origin}/viewer.html`);
  await pg.waitForTimeout(1200); // let the cached image decode and lay out
  const buffer = await pg.screenshot();
  await pg.close();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

// ---------------------------------------------------------------- tiles


function bottomBand(items) {
  return `
    <div style="position:absolute;left:56px;right:56px;bottom:34px;display:flex;gap:14px">
      ${items.map((it) => `
        <div style="flex:1;padding:14px 16px;border-radius:10px;background:rgba(255,255,255,.72);
                    border:1px solid ${BRAND.line};backdrop-filter:blur(6px)">
          <div style="font-size:14px;font-weight:750;letter-spacing:-.01em">${it[0]}</div>
          <div style="margin-top:3px;font-size:12.5px;line-height:1.45;color:${BRAND.sub}">${it[1]}</div>
        </div>`).join("")}
    </div>`;
}

function headline(title, sub) { return `
  <div style="padding:44px 56px 0">
    <div style="font-size:38px;font-weight:800;letter-spacing:-.028em;line-height:1.12">${title}</div>
    <div style="margin-top:10px;font-size:17px;color:${BRAND.sub};line-height:1.45;max-width:840px">${sub}</div>
  </div>`; }

function browserFrame(imgSrc, { width, height, url }) { return `
  <div style="width:${width}px;height:${height}px;border-radius:12px;overflow:hidden;
              border:1px solid ${BRAND.line};box-shadow:0 20px 50px rgba(16,22,35,.16);background:#fff">
    <div style="height:34px;display:flex;align-items:center;gap:7px;padding:0 12px;background:#f2f4f8;
                border-bottom:1px solid ${BRAND.line}">
      <i style="width:10px;height:10px;border-radius:50%;background:#ff5f57;display:block"></i>
      <i style="width:10px;height:10px;border-radius:50%;background:#febc2e;display:block"></i>
      <i style="width:10px;height:10px;border-radius:50%;background:#28c840;display:block"></i>
      <div style="flex:1;margin-left:10px;height:20px;border-radius:5px;background:#fff;border:1px solid ${BRAND.line};
                  display:flex;align-items:center;padding:0 9px;font-size:11px;color:${BRAND.sub}">${url}</div>
    </div>
    <img src="${imgSrc}" style="display:block;width:100%;height:${height - 34}px;object-fit:cover;object-position:top">
  </div>`; }

// A long capture shown as a tall strip, clipped with a fade so it reads as
// "this keeps going".
function longStrip(capture, { width, height, label }) { return `
  <div style="width:${width}px;position:relative;height:${height}px;border-radius:10px;overflow:hidden;
              border:1px solid ${BRAND.line};box-shadow:0 16px 40px rgba(16,22,35,.14);background:#fff">
    <img src="${capture.dataUrl}" style="display:block;width:100%">
    <div style="position:absolute;left:0;right:0;bottom:0;height:120px;
                background:linear-gradient(180deg,rgba(255,255,255,0),#fff 62%)"></div>
    ${label ? `<div style="position:absolute;left:0;right:0;bottom:14px;text-align:center;font-size:12.5px;
                           font-weight:700;color:${BRAND.sub}">${label}</div>` : ""}
  </div>`; }

function heroTile(pageShot, popup) {
  return `
  <div style="width:1280px;height:800px;background:linear-gradient(160deg,#f4f7fd,#eef7f5 60%,#fdf4ee)">
    ${headline(
      "Capture the whole page as one image",
      "Scrolls the page for you, waits for lazy content to render, and stitches every screen into a single PNG or JPEG."
    )}
    <div style="position:relative;padding:32px 56px 0">
      ${browserFrame(pageShot, { width: 1168, height: 496, url: "fieldnotes.example/designing-for-long-pages" })}
      <div style="position:absolute;top:16px;right:76px;border-radius:12px;overflow:hidden;
                  box-shadow:0 26px 60px rgba(16,22,35,.30)">
        <img src="${popup}" style="display:block;width:320px">
      </div>
    </div>
    ${bottomBand([
      ["Two clicks, then walk away", "Pick a format, press Capture. Progress and time remaining are shown as it works."],
      ["Waits for content to load", "Lazy images and web fonts are given time to render before each screen is taken."],
      ["Alt+Shift+S", "Open it straight from the keyboard on any page."],
    ])}
  </div>`;
}

function comparisonTile(pageShot, capture) {
  // Draw the long image at a fixed width and mark off exactly one viewport's
  // worth at the top — that ratio is the whole argument for the extension.
  const ribbonW = 300;
  const ribbonH = 470;
  const oneScreenPx = Math.round((capture.height / Math.max(1, capture.screens)) * (ribbonW / capture.width));
  return `
  <div style="width:1280px;height:800px;background:#fff">
    ${headline("One screen in, the entire page out", "No manual scrolling, no five separate images to reassemble afterwards.")}
    <div style="display:flex;align-items:flex-start;gap:44px;padding:34px 56px 0">
      <div>
        <div style="width:700px;height:412px;border-radius:10px;overflow:hidden;border:1px solid ${BRAND.line};
                    box-shadow:0 16px 40px rgba(16,22,35,.12)">
          <img src="${pageShot}" style="display:block;width:100%;height:100%;object-fit:cover;object-position:top">
        </div>
        <div style="margin-top:11px;font-size:13px;font-weight:650;color:${BRAND.sub};text-align:center">
          What the browser shows — one screen
        </div>
      </div>
      <div style="display:flex;align-items:flex-start;gap:26px">
        <div style="font-size:32px;color:${BRAND.blue};font-weight:300;margin-top:150px">&rarr;</div>
        <div style="width:${ribbonW}px">
          <div style="position:relative;height:${ribbonH}px;border-radius:10px;overflow:hidden;
                      border:1px solid ${BRAND.line};box-shadow:0 16px 40px rgba(16,22,35,.14);background:#fff">
            <img src="${capture.dataUrl}" style="display:block;width:100%">
            <div style="position:absolute;left:0;top:0;width:100%;height:${oneScreenPx}px;
                        border-bottom:2px dashed ${BRAND.blue};background:rgba(47,109,246,.10)"></div>
            <div style="position:absolute;left:10px;top:${oneScreenPx - 26}px;background:${BRAND.blue};color:#fff;
                        font-size:11px;font-weight:700;padding:3px 8px;border-radius:5px">one screen</div>
            <div style="position:absolute;left:0;right:0;bottom:0;height:120px;
                        background:linear-gradient(180deg,rgba(255,255,255,0),#fff 62%)"></div>
            <div style="position:absolute;left:0;right:0;bottom:14px;text-align:center;font-size:12.5px;
                        font-weight:700;color:${BRAND.sub}">What you get — ${capture.screens} screens, one image</div>
          </div>
        </div>
      </div>
    </div>
    ${bottomBand([
      ["No seams", "Screens are stitched on exact pixel boundaries, including fractional display scaling."],
      ["No repeated headers", "Sticky headers and footers are hidden after the first screen."],
      ["Very long pages still work", "Past the canvas limit the result is split into numbered parts instead of failing."],
    ])}
  </div>`;
}

function containerTile(pageShot, capture, panel) {
  // The highlight box is derived from the panel's real geometry on the demo page,
  // scaled to the frame, so it can never drift away from what it points at.
  const frameW = 800;
  const chrome = 34;
  const scale = frameW / panel.vw;
  const frameH = Math.round(panel.vh * scale) + chrome;
  const box = {
    left: Math.round(panel.x * scale),
    top: chrome + Math.round(panel.y * scale),
    width: Math.round(panel.w * scale),
    height: Math.round(panel.h * scale),
  };
  return `
  <div style="width:1280px;height:800px;background:linear-gradient(160deg,#eef4ff,#f7fafd 70%)">
    ${headline(
      "Also captures panels that scroll inside the page",
      "Dashboards, data grids, admin consoles and document views keep the page height fixed and scroll a panel instead. Those get captured too."
    )}
    <div style="display:flex;align-items:flex-start;gap:26px;padding:30px 56px 0">
      <div style="position:relative">
        ${browserFrame(pageShot, { width: frameW, height: frameH, url: "console.example/deployments" })}
        <div style="position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;
                    border:3px solid ${BRAND.blue};border-radius:8px;box-shadow:0 0 0 6px rgba(47,109,246,.14)"></div>
        <div style="position:absolute;left:${box.left}px;top:${box.top - 30}px;background:${BRAND.blue};color:#fff;
                    font-size:12px;font-weight:700;padding:4px 10px;border-radius:6px">detected scroll area</div>
      </div>
      <div style="display:flex;align-items:center;gap:22px">
        <div style="font-size:32px;color:${BRAND.blue};font-weight:300">&rarr;</div>
        ${longStrip(capture, { width: 236, height: frameH, label: `${capture.screens} screens of panel content` })}
      </div>
    </div>
    ${bottomBand([
      ["Finds the right box", "Picks the region you are actually reading, not an invisible wrapper around it."],
      ["Stops if it cannot scroll", "If the detected area will not move, it says so instead of returning duplicates."],
      ["Crops to the panel", "Sidebars and toolbars are cropped out of the long image."],
    ])}
  </div>`;
}

function previewTile(viewer, popupBusy) {
  return `
  <div style="width:1280px;height:800px;background:#eef1f6">
    ${headline(
      "Watch the progress, then review the result",
      "Live stage and time remaining while it works. When it finishes, preview the long image at fit-width or actual size and download it again."
    )}
    <div style="position:relative;padding:30px 56px 0">
      <div style="width:1168px;height:560px;border-radius:12px;overflow:hidden;border:1px solid ${BRAND.line};
                  box-shadow:0 20px 50px rgba(16,22,35,.16);background:#fff">
        <img src="${viewer}" style="display:block;width:100%;object-fit:none;object-position:top left">
      </div>
      <div style="position:absolute;left:96px;bottom:-26px;border-radius:12px;overflow:hidden;
                  box-shadow:0 26px 60px rgba(16,22,35,.30)">
        <img src="${popupBusy}" style="display:block;width:296px">
      </div>
    </div>
  </div>`;
}

function privacyTile(manifest) {
  const point = (title, body) => `
    <div style="width:334px">
      <div style="width:38px;height:38px;border-radius:10px;margin-bottom:15px;
                  background:linear-gradient(135deg,${BRAND.blue},${BRAND.teal})"></div>
      <div style="font-size:19px;font-weight:750;letter-spacing:-.015em;margin-bottom:8px">${title}</div>
      <div style="font-size:14px;line-height:1.6;color:${BRAND.sub}">${body}</div>
    </div>`;

  // Printed from the real manifest so the claim can't drift away from the code.
  const perms = JSON.stringify(manifest.permissions);
  const hosts = JSON.stringify(manifest.host_permissions || []);
  return `
  <div style="width:1280px;height:800px;background:#fff">
    ${headline("Everything happens on your device", "No account, no upload, no tracking. The screenshot never leaves your computer.")}
    <div style="display:flex;gap:44px;padding:44px 56px 0">
      ${point("Three permissions, none of them standing", "Only <b>activeTab</b>, <b>scripting</b> and <b>downloads</b>. No access to sites you are not capturing, and no permanent access to any site.")}
      ${point("Nothing is sent anywhere", "No servers, no analytics, no telemetry and no remotely loaded code. The image is written straight to your Downloads folder.")}
      ${point("Honest about its limits", "Pages that recycle rows as you scroll cannot be captured in full by any tool of this kind. This one tells you when that happens instead of silently truncating.")}
    </div>

    <div style="display:flex;align-items:center;gap:36px;padding:40px 56px 0">
      <div style="width:600px;border-radius:12px;overflow:hidden;box-shadow:0 16px 40px rgba(16,22,35,.16)">
        <div style="background:#20263a;color:#8b98b5;font-size:11.5px;font-weight:700;letter-spacing:.06em;
                    padding:9px 16px">MANIFEST.JSON</div>
        <div style="background:#131722;color:#dfe7f5;padding:16px 18px;
                    font:13.5px/1.85 ui-monospace, SFMono-Regular, Menlo, monospace">
          <div><span style="color:#93b4ff">"permissions"</span>: <span style="color:#f0b37a">${perms.replace(/"/g, "&quot;")}</span>,</div>
          <div><span style="color:#93b4ff">"host_permissions"</span>: <span style="color:#f0b37a">${hosts.replace(/"/g, "&quot;")}</span></div>
          <div style="color:#5f6d8a">// no content scripts, no background network access</div>
        </div>
      </div>
      <div style="width:490px">
        <div style="font-size:17px;font-weight:750;letter-spacing:-.015em;margin-bottom:10px">
          That empty list is the point
        </div>
        <div style="font-size:14px;line-height:1.65;color:${BRAND.sub}">
          Extensions that ask for access to <b>all your websites</b> can read every page you visit, forever.
          This one asks for nothing standing: <b>activeTab</b> grants access to a single tab, only at the moment
          you press the button, and it lapses as soon as the capture is done.
        </div>
      </div>
    </div>

    <div style="position:absolute;left:56px;right:56px;bottom:34px;padding:18px 22px;border-radius:12px;
                background:#f6f8fc;border:1px solid ${BRAND.line};font-size:13.5px;color:${BRAND.sub};line-height:1.6">
      Articles, documentation, reports, dashboards, admin consoles, data grids and document views &nbsp;&middot;&nbsp;
      PNG or JPEG &nbsp;&middot;&nbsp; splits very long pages into numbered parts automatically &nbsp;&middot;&nbsp;
      keyboard shortcut Alt+Shift+S
    </div>
  </div>`;
}

function promoTile(capture) {
  return `
  <div style="width:440px;height:280px;position:relative;overflow:hidden;
              background:linear-gradient(140deg,#1d4ed8,#2f6df6 45%,#12b3a0)">
    <div style="position:absolute;right:24px;top:30px;width:152px;height:296px;border-radius:10px;overflow:hidden;
                box-shadow:0 22px 44px rgba(4,14,40,.42);transform:rotate(-6deg);background:#fff">
      <img src="${capture.dataUrl}" style="display:block;width:100%">
    </div>
    <div style="position:absolute;left:30px;top:92px;width:248px">
      <div style="color:#fff;font-size:31px;font-weight:800;letter-spacing:-.03em;line-height:1.1">
        The whole page,<br>one image
      </div>
      <div style="margin-top:12px;color:rgba(255,255,255,.86);font-size:14px;line-height:1.45">
        Full pages and scroll areas
      </div>
    </div>
  </div>`;
}

function marqueeTile(capture) {
  const strip = (rotate, top, left) => `
    <div style="position:absolute;left:${left}px;top:${top}px;width:212px;height:430px;border-radius:12px;
                overflow:hidden;box-shadow:0 26px 54px rgba(4,14,40,.4);transform:rotate(${rotate}deg);background:#fff">
      <img src="${capture.dataUrl}" style="display:block;width:100%">
    </div>`;
  return `
  <div style="width:1400px;height:560px;position:relative;overflow:hidden;
              background:linear-gradient(130deg,#15307e,#2f6df6 52%,#12b3a0)">
    ${strip(-7, 66, 872)}
    ${strip(5, 106, 1128)}
    <div style="position:absolute;left:72px;top:172px;width:800px">
      <div style="color:#fff;font-size:55px;font-weight:800;letter-spacing:-.035em;line-height:1.06">
        Capture the whole page,<br>not just the screen
      </div>
      <div style="margin-top:20px;color:rgba(255,255,255,.86);font-size:20px;line-height:1.45">
        Full pages, dashboards and panels that scroll inside the page
      </div>
    </div>
  </div>`;
}
