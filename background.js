// Full-page screenshot: scroll the page, capture each viewport, stitch into one tall image.

const CAPTURE_INTERVAL_MS = 550; // captureVisibleTab is rate-limited to ~2/sec
const MAX_RENDER_WAIT_MS = 1500; // per screen: max wait for lazy images/content to render
const PRESCROLL_STEP_MS = 700; // per step during pre-load: max wait for in-view images
const MAX_SCREENS = 80; // guard against infinite-scroll pages
const TAB_WAIT_TIMEOUT_MS = 60000; // how long to wait for the user to return to the target tab
const TAB_WAIT_POLL_MS = 400;
// A canvas is constrained by both its longest side and its total pixel count.
// Chrome allows 65535 per side, but the real limit here is memory: the backing
// store is 4 bytes per pixel and this runs in a service worker. 32000 x 3840
// (a 1920px viewport on a 2x display) would be ~490MB and fails; capping the
// area keeps every segment at roughly 400MB or less. Pages that exceed one
// segment are split into parts.
const MAX_CANVAS_DIM = 32000;
const MAX_CANVAS_AREA = 1e8;
const RESULT_DB = "fullPageScreenshot";
const RESULT_STORE = "results";
const LATEST_RESULT_KEY = "latest";

let active = null; // { cancelled } for the run in progress

// User-facing failures travel to the popup as a message key + substitutions, so
// the popup renders them in the browser's language. Anything else that escapes
// (raw Chrome API errors) is shown through the errUnexpected key instead.
class CapError extends Error {
  constructor(code, params) {
    super(code);
    this.code = code;
    this.params = params || [];
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "capture") return;
  port.onMessage.addListener((msg) => {
    if (msg.type === "start") {
      if (active) { safePost(port, { type: "error", code: "errBusy" }); return; }
      active = { cancelled: false, port };
      run(port, msg.options || {})
        .catch((err) => safePost(port, err && err.code
          ? { type: "error", code: err.code, params: err.params }
          : { type: "error", message: String((err && err.message) || err) }))
        .finally(() => { active = null; });
    } else if (msg.type === "cancel") {
      if (active) active.cancelled = true;
    } else if (msg.type === "open") {
      // Note: a tab can't navigate to a data: URL, so open a viewer page that
      // reads the cached result from extension storage instead.
      chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
    }
  });
  port.onDisconnect.addListener(() => {
    // Popup closed mid-run → stop the task instead of leaving it orphaned.
    if (active && active.port === port) active.cancelled = true;
  });
});

function safePost(port, m) { try { port.postMessage(m); } catch (_) {} }

// The viewer page reads the cached result straight out of IndexedDB — it shares
// this extension's origin, so there's no need to pipe tens of megabytes of image
// data back through the message channel.

async function run(port, options) {
  const fmt = options.format === "jpeg" ? "jpeg" : "png";
  const quality = 0.92;
  const hideFixedElements = options.hideFixedElements !== false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new CapError("errNoTab");
  // An empty url means activeTab wasn't granted, which is itself a restricted page.
  if (!tab.url || /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(tab.url)) {
    throw new CapError("errInternalPage");
  }

  // 1. Prepare the page (hide scrollbar, freeze smooth-scroll) and read its metrics.
  let frameId; // undefined = capture the top-level document
  let frameLimited = false;
  let metrics = await exec(tab.id, prepPage);

  // Some pages keep the top document at exactly one screen and render the real
  // content inside an <iframe> (claude.ai artifacts, embedded editors and
  // documents, legacy framesets). If the top frame has nothing to scroll, look
  // for the largest scrollable sub-frame and capture that instead — the user
  // asked for the page's content, not for whichever frame happens to be on top.
  if (metrics.scrollMode === "page" && metrics.totalHeight <= metrics.viewportHeight * 1.5) {
    const sub = await findScrollableSubFrame(tab.id).catch(() => null);
    if (sub) {
      await exec(tab.id, restorePage).catch(() => {}); // undo top-frame prep
      frameId = sub.frameId;
      metrics = await exec(tab.id, prepPage, [], frameId);
      // Screens come from captureVisibleTab, which photographs the top-level
      // viewport — so clip to where the iframe sits in it, and measure scale
      // against the top-level viewport, not the frame's own.
      metrics.captureRect = composeRects(sub.rect, metrics.captureRect);
      metrics.viewportHeight = Math.max(1, Math.floor(metrics.captureRect.height));
      metrics.viewportWidth = Math.max(1, Math.floor(metrics.captureRect.width));
      metrics.browserViewportWidth = sub.rect.vw;
      metrics.browserViewportHeight = sub.rect.vh;
      metrics.scrollMode = "container"; // same user-facing semantics
    } else if (await exec(tab.id, hasLargeIframe).catch(() => false)) {
      // There's a big embedded frame we couldn't reach (likely cross-origin
      // under activeTab). Capturing one screen is all we can do — but say so
      // instead of presenting it as a complete capture.
      frameLimited = true;
    }
  }
  const { viewportHeight } = metrics;

  const shots = []; // { y, blob }
  let cancelled = false;
  let lastCaptureAt = 0;
  let truncated = false;
  let totalScreens = 0;
  let capturedScreens = 0;
  let lastY = -1;
  let noAdvance = false;
  let totalHeight = metrics.totalHeight;
  try {
    // 2. Pre-scroll once to trigger lazy-loaded images/content, then re-measure.
    safePost(port, {
      type: "status",
      stage: "stageLoading",
      code: metrics.scrollMode === "container" ? "statusContainerDetected" : "statusLoadingPage",
    });
    const grownHeight = await exec(tab.id, preScroll, [viewportHeight, MAX_SCREENS, PRESCROLL_STEP_MS], frameId);
    totalHeight = Math.max(metrics.totalHeight, grownHeight || 0);
    totalScreens = Math.max(1, Math.ceil(totalHeight / viewportHeight));
    const steps = Math.min(MAX_SCREENS, totalScreens);
    truncated = totalScreens > MAX_SCREENS;
    if (truncated) {
      safePost(port, {
        type: "status",
        stage: "stageLoading",
        code: "statusTruncating",
        params: [String(MAX_SCREENS)],
      });
    }

    // 3. Scroll + capture each screen.
    for (let i = 0; i < steps; i++) {
      if (active && active.cancelled) { cancelled = true; break; }
      if (!(await ensureTargetTabActive(port, tab.id, tab.windowId))) { cancelled = true; break; }
      const targetY = i * viewportHeight;
      const shouldHideFixed = hideFixedElements && (i > 0 || metrics.scrollMode === "container");
      const actualY = await exec(tab.id, scrollToY, [targetY, shouldHideFixed], frameId);

      // The scroll position didn't move: either we're at the real bottom (the
      // measured height was too optimistic) or the detected scroll area can't
      // actually be scrolled. Stop instead of capturing the same screen again —
      // without this the run silently produces MAX_SCREENS identical shots.
      if (i > 0 && actualY <= lastY + 1) { noAdvance = true; break; }
      lastY = actualY;

      // Wait until this screen's lazy images/content have actually rendered
      // (not just a fixed guess) before capturing.
      await exec(tab.id, waitForRender, [MAX_RENDER_WAIT_MS], frameId);
      if (active && active.cancelled) { cancelled = true; break; }

      // Respect captureVisibleTab's rate limit — the render wait usually already
      // covers it, so only sleep the remaining time.
      const gap = CAPTURE_INTERVAL_MS - (performance.now() - lastCaptureAt);
      if (gap > 0) await sleep(gap);

      if (!(await ensureTargetTabActive(port, tab.id, tab.windowId))) { cancelled = true; break; }
      const blob = await captureWithRetry(tab.windowId);
      if (blob === null) { cancelled = true; break; } // cancelled during retry back-off
      lastCaptureAt = performance.now();
      shots.push({ y: actualY, blob });

      safePost(port, { type: "progress", current: i + 1, total: steps });

      // Stop early if we've already reached the bottom (short pages / clamped scroll).
      if (actualY + viewportHeight >= totalHeight - 1) break;
    }
  } finally {
    // 4. Always restore the page to its original state.
    await exec(tab.id, restorePage, [], frameId).catch(() => {});
  }

  if (cancelled || (active && active.cancelled)) { safePost(port, { type: "cancelled" }); return; }
  // Nothing scrolled at all, on a page that claims to be much taller than one
  // screen → we picked the wrong scroll area (or the page can't scroll). Say so
  // instead of handing back a single screen dressed up as a success.
  if (noAdvance && shots.length <= 1 && totalHeight >= viewportHeight * 1.5) {
    throw new CapError(metrics.scrollMode === "container" ? "errContainerStuck" : "errPageStuck");
  }
  // Scrolling stalled well short of the measured bottom — the long image is real
  // but incomplete, so don't report it as a clean success.
  const stoppedEarly = noAdvance && lastY + viewportHeight < totalHeight * 0.9;
  if (!shots.length) throw new CapError("errNothingCaptured");

  // 5. Stitch (splitting into parts if the page exceeds the canvas limit).
  safePost(port, { type: "stitching" });
  const images = await stitch(shots, metrics, fmt, quality);
  capturedScreens = shots.length;
  shots.length = 0;
  const imageCount = images.length;
  const preview = await makeThumb(images[0]);

  // 6. Cache the result before downloading, so a failed download (disk full,
  //    oversized data URL) doesn't throw away a capture that took minutes.
  //    put() overwrites the key, so there's no need to clear first.
  let viewerReady = true;
  try {
    await saveLatestImages(images);
  } catch (err) {
    viewerReady = false;
    await clearLatestImages().catch(() => {});
    console.warn("Failed to cache screenshot preview", err);
  }

  // 7. Download every part.
  const base = hostBase(tab.url, tab.title);
  const ext = fmt === "jpeg" ? "jpg" : "png";
  const time = stamp();
  for (let i = 0; i < images.length; i++) {
    const suffix = images.length > 1 ? `-part${i + 1}` : "";
    // A service worker has no URL.createObjectURL, so downloads still go through
    // a data URL — but build one part at a time so only a single copy is live.
    const url = await blobToDataUrl(images[i]);
    await chrome.downloads.download({ url, filename: `screenshot-${base}-${time}${suffix}.${ext}`, saveAs: false });
  }
  images.length = 0;

  safePost(port, {
    type: "done",
    count: imageCount,
    preview,
    truncated: Boolean(truncated),
    stoppedEarly: Boolean(stoppedEarly),
    frameLimited: Boolean(frameLimited),
    capturedScreens,
    totalScreens,
    maxScreens: MAX_SCREENS,
    viewerReady,
  });
}

async function captureWithRetry(windowId, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      // Turn it into a Blob right away. Keeping 80 base64 strings alive for the
      // whole run costs ~1.33x the image bytes and all of it on the worker heap;
      // a Blob is refcounted storage the browser can spill to disk.
      return await (await fetch(dataUrl)).blob();
    } catch (err) {
      lastErr = err;
      // Most common failure is the rate limit — back off and retry, but don't
      // keep the user waiting through the full back-off after they hit cancel.
      if (active && active.cancelled) return null;
      await sleep(CAPTURE_INTERVAL_MS * (i + 1));
      if (active && active.cancelled) return null;
    }
  }
  throw lastErr || new CapError("errCaptureFailed");
}

// Stitch shots into one or more tall images. Returns an array of Blobs: usually
// one, but a page too tall for a single canvas is split into sequential parts.
async function stitch(shots, metrics, fmt, quality) {
  // Probe the first shot for the real captured pixel dimensions (every screen
  // has the same viewport size, so one probe is enough).
  const probe = await createImageBitmap(shots[0].blob);
  const crop = getSourceCrop(probe, metrics);
  const width = crop ? crop.sw : probe.width;
  const shotH = crop ? crop.sh : probe.height;
  const scrollScale = crop ? crop.scaleY : probe.height / (metrics.browserViewportHeight || metrics.viewportHeight || probe.height);
  probe.close();

  // Destination Y of each screen. With fractional DPR (Windows 125%/150%),
  // round(y*dpr) can leave a 1px gap between consecutive screens — pull a screen
  // up to abut the previous one so the long image has no transparent seam lines.
  const dest = new Array(shots.length);
  let prevBottom = 0;
  for (let i = 0; i < shots.length; i++) {
    let dy = Math.round(shots[i].y * scrollScale);
    // Only close sub-pixel rounding gaps. A bigger gap means the scroll actually
    // landed off-grid (scroll-snap, scroll-jacking) and pulling the screen up
    // would splice real content out of the long image.
    if (i > 0 && dy > prevBottom && dy - prevBottom <= 2) dy = prevBottom;
    dest[i] = dy;
    prevBottom = dy + shotH;
  }
  const fullHeight = prevBottom;

  // Compute segments, bounded by both the per-side and the total-area limit.
  const maxSegHeight = Math.max(1, Math.min(MAX_CANVAS_DIM, Math.floor(MAX_CANVAS_AREA / width)));
  const segments = [];
  for (let y = 0; y < fullHeight; y += maxSegHeight) {
    segments.push([y, Math.min(maxSegHeight, fullHeight - y)]);
  }

  const mime = fmt === "jpeg" ? "image/jpeg" : "image/png";
  const out = [];
  for (const [segY, segHeight] of segments) {
    const canvas = new OffscreenCanvas(width, segHeight);
    const ctx = canvas.getContext("2d");
    if (fmt === "jpeg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, segHeight); }
    // Decode each contributing screen on demand and free it immediately, so peak
    // memory stays at ~one screen rather than the whole page.
    for (let i = 0; i < shots.length; i++) {
      const y = dest[i];
      if (y + shotH <= segY || y >= segY + segHeight) continue; // outside this segment
      const bmp = await createImageBitmap(shots[i].blob);
      if (crop) {
        ctx.drawImage(bmp, crop.sx, crop.sy, crop.sw, crop.sh, 0, y - segY, crop.sw, crop.sh);
      } else {
        ctx.drawImage(bmp, 0, y - segY);
      }
      bmp.close();
    }
    out.push(await canvas.convertToBlob({ type: mime, quality }));
  }
  return out;
}

function getSourceCrop(bitmap, metrics) {
  const rect = metrics.captureRect;
  if (!rect) return null;

  const scaleX = bitmap.width / (metrics.browserViewportWidth || bitmap.width);
  const scaleY = bitmap.height / (metrics.browserViewportHeight || bitmap.height);
  const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round(rect.left * scaleX)));
  const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round(rect.top * scaleY)));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * scaleX)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * scaleY)));

  return { sx, sy, sw, sh, scaleY };
}

// Small JPEG thumbnail of the (first) result for the popup preview. This one
// stays a data URL: it's a few KB and has to survive the trip through postMessage.
async function makeThumb(imageBlob) {
  const bmp = await createImageBitmap(imageBlob);
  const W = Math.min(240, bmp.width);
  const scale = W / bmp.width;
  const fullH = Math.round(bmp.height * scale);
  const H = Math.min(fullH, 3600); // cap very tall previews
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, 0, 0, W, fullH);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
  return await blobToDataUrl(blob);
}

// ---- helpers running in the service worker ----

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// Probe every frame we can reach and return the most plausible content frame:
// scrollable (or hosting a big internal scroller), with the largest viewport.
// Under activeTab, cross-origin frames may be unreachable — they simply don't
// appear in the results, and we fall back to the top frame.
async function findScrollableSubFrame(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: probeFrame,
    });
  } catch (_) {
    return null;
  }

  let best = null;
  for (const r of results || []) {
    const p = r && r.result;
    if (!p || r.frameId === 0) continue;
    // Tracking pixels and other degenerate frames scroll "1.5x their height"
    // trivially — demand real size and a real scrollable distance.
    if (p.innerWidth < 200 || p.innerHeight < 200) continue;
    if (p.scrollHeight - p.innerHeight < 64 && !p.hasInnerScroller) continue;
    const area = p.innerWidth * p.innerHeight;
    if (!best || area > best.area) best = { frameId: r.frameId, probe: p, area };
  }
  if (!best) return null;

  // Match the frame back to its <iframe> element in the top document to learn
  // where it sits in the viewport we photograph. The frame's inner viewport has
  // the same size as the element's client box, which is enough to identify it.
  const rect = await exec(tabId, locateIframe, [best.probe.innerWidth, best.probe.innerHeight]);
  if (!rect) return null;
  return { frameId: best.frameId, rect };
}

// The frame's own capture rect (a scroller inside the iframe) is relative to
// the iframe's viewport; offset it by where the iframe sits in the top one.
function composeRects(outer, inner) {
  if (!inner) return outer;
  return {
    left: outer.left + inner.left,
    top: outer.top + inner.top,
    width: Math.max(1, Math.min(inner.width, outer.width - inner.left)),
    height: Math.max(1, Math.min(inner.height, outer.height - inner.top)),
    vw: outer.vw,
    vh: outer.vh,
  };
}

async function isTargetTabActive(tabId, windowId) {
  const [current] = await chrome.tabs.query({ active: true, windowId });
  return Boolean(current && current.id === tabId);
}

// Capturing while another tab is in front would photograph the wrong page, but
// discarding a run that already took minutes is worse. Pause and wait for the
// user to come back; only give up once they've been away for a full minute.
// Returns false if the run was cancelled while waiting.
async function ensureTargetTabActive(port, tabId, windowId) {
  if (await isTargetTabActive(tabId, windowId)) return true;

  safePost(port, { type: "status", stage: "stageCapturing", code: "statusWaitingForTab" });
  const deadline = performance.now() + TAB_WAIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (active && active.cancelled) return false;
    await sleep(TAB_WAIT_POLL_MS);
    if (await isTargetTabActive(tabId, windowId)) {
      await sleep(250); // let the tab repaint after being brought forward
      return true;
    }
  }
  throw new CapError("errTabSwitched");
}

function openResultDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RESULT_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(RESULT_STORE)) {
        req.result.createObjectStore(RESULT_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("preview cache is blocked by another connection"));
  });
}

async function saveLatestImages(images) {
  const db = await openResultDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RESULT_STORE, "readwrite");
    tx.objectStore(RESULT_STORE).put({ images, savedAt: Date.now() }, LATEST_RESULT_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("preview cache write aborted")); };
  });
}

async function clearLatestImages() {
  const db = await openResultDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RESULT_STORE, "readwrite");
    tx.objectStore(RESULT_STORE).delete(LATEST_RESULT_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("preview cache clear aborted")); };
  });
}

function exec(tabId, func, args = [], frameId) {
  const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId };
  return chrome.scripting
    .executeScript({ target, func, args })
    .then((res) => res && res[0] && res[0].result);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeName(s) {
  return (s || "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 50).trim() || "page";
}

function hostBase(url, title) {
  try { return safeName(new URL(url).hostname.replace(/^www\./, "")); }
  catch (_) { return safeName(title); }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- functions injected into the page ----

// Runs in EVERY frame: report whether this frame has meaningful scrollable
// content, either the document itself or a large scroller inside it.
function probeFrame() {
  const de = document.documentElement;
  const body = document.body;
  const scrollHeight = Math.max(de.scrollHeight, body ? body.scrollHeight : 0);
  let hasInnerScroller = false;
  if (body) {
    for (const el of body.querySelectorAll("*")) {
      if (el.scrollHeight - el.clientHeight >= window.innerHeight) {
        hasInnerScroller = true;
        break;
      }
    }
  }
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollHeight,
    hasInnerScroller,
  };
}

// Runs in the TOP frame: find the visible <iframe> element whose client box
// matches the chosen frame's inner viewport, and return its on-screen rect.
function locateIframe(w, h) {
  let best = null;
  let bestArea = 0;
  for (const f of document.querySelectorAll("iframe")) {
    if (f.clientWidth < 200 || f.clientHeight < 200) continue;
    if (Math.abs(f.clientWidth - w) > 4 || Math.abs(f.clientHeight - h) > 4) continue;
    const r = f.getBoundingClientRect();
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(window.innerWidth, r.right);
    const bottom = Math.min(window.innerHeight, r.bottom);
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (area > bestArea) {
      bestArea = area;
      best = {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    }
  }
  return best;
}

// Runs in the TOP frame: is there a big embedded frame covering a meaningful
// share of the viewport? Used to warn when we couldn't reach the content.
function hasLargeIframe() {
  for (const f of document.querySelectorAll("iframe")) {
    const r = f.getBoundingClientRect();
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(window.innerWidth, r.right);
    const bottom = Math.min(window.innerHeight, r.bottom);
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (area >= window.innerWidth * window.innerHeight * 0.4) return true;
  }
  return false;
}

function prepPage() {
  const stateKey = "__fullPageScreenshotExtensionState__";
  const de = document.documentElement;
  const body = document.body;
  const scrollingElement = document.scrollingElement || de;
  const target = findMainScrollTarget(scrollingElement);
  const isWindow = target === scrollingElement || target === de || target === body;

  window[stateKey] = {
    target: isWindow ? null : target,
    isWindow,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    targetScrollTop: isWindow ? 0 : target.scrollTop,
    targetScrollLeft: isWindow ? 0 : target.scrollLeft,
    htmlScrollBehavior: de.style.scrollBehavior,
    htmlScrollSnapType: de.style.scrollSnapType,
    htmlOverflow: de.style.overflow,
    bodyOverflow: body ? body.style.overflow : "",
    targetScrollBehavior: isWindow ? "" : target.style.scrollBehavior,
    targetScrollSnapType: isWindow ? "" : target.style.scrollSnapType,
    targetOverflowY: isWindow ? "" : target.style.overflowY,
  };

  if (isWindow) {
    de.style.scrollBehavior = "auto";
    // scroll-snap would drag each step to the nearest snap point, so the screens
    // no longer tile at exact viewport intervals.
    de.style.scrollSnapType = "none";
    // Hide the scrollbar so it doesn't leave a strip down the right of the long
    // image. overflow:hidden on the root still allows programmatic scrolling.
    de.style.overflow = "hidden";
  } else {
    target.style.scrollBehavior = "auto";
    target.style.scrollSnapType = "none";
    target.style.overflowY = "hidden";
  }

  const totalHeight = Math.max(
    isWindow ? de.scrollHeight : target.scrollHeight,
    isWindow ? de.offsetHeight : target.offsetHeight,
    isWindow ? de.clientHeight : target.clientHeight,
    isWindow && body ? body.scrollHeight : 0,
    isWindow && body ? body.offsetHeight : 0
  );
  const rect = isWindow ? null : visibleRect(target);
  return {
    scrollMode: isWindow ? "page" : "container",
    viewportHeight: isWindow ? window.innerHeight : Math.max(1, Math.floor(rect.height)),
    viewportWidth: isWindow ? window.innerWidth : Math.max(1, Math.floor(rect.width)),
    browserViewportHeight: window.innerHeight,
    browserViewportWidth: window.innerWidth,
    captureRect: rect,
    totalHeight,
    dpr: window.devicePixelRatio || 1,
  };

  function findMainScrollTarget(rootScroller) {
    const pageRange = Math.max(
      rootScroller.scrollHeight - window.innerHeight,
      rootScroller.scrollHeight - rootScroller.clientHeight,
      0
    );
    const rangeCap = window.innerHeight * 20;
    let best = null;
    let bestScore = 0;

    const nodes = body ? body.querySelectorAll("*") : [];
    for (const el of nodes) {
      if (el === de || el === body) continue;
      const range = el.scrollHeight - el.clientHeight;
      if (range < 64) continue;

      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      // Invisible / click-through shells are scroll containers by spec but are
      // never the region the user is reading.
      if (style.opacity === "0" || style.pointerEvents === "none") continue;
      // overflow:hidden elements are scrollable programmatically, but the user
      // can't scroll them, so they're clipping wrappers rather than the content
      // area. App shells (Gmail, admin consoles) are full of them and they used
      // to out-score the real scroller.
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;

      const r = visibleRect(el);
      if (r.width < Math.min(320, window.innerWidth * 0.25)) continue;
      if (r.height < Math.min(180, window.innerHeight * 0.25)) continue;

      const area = r.width * r.height;
      // Cap the scrollable distance: a wrapper with an enormous scrollHeight
      // shouldn't be able to out-score the region the user is looking at.
      const score = Math.min(range, rangeCap) * area;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    const pageScore = Math.min(pageRange, rangeCap) * window.innerWidth * window.innerHeight;
    return best && bestScore > pageScore * 0.75 ? best : rootScroller;
  }

  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(window.innerWidth, r.right);
    const bottom = Math.min(window.innerHeight, r.bottom);
    return {
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }
}

// Scroll through the whole page once so lazy images/content load, waiting for the
// images in each step to finish, then return to the top and report the (possibly
// grown) page height.
async function preScroll(step, maxScreens, perStepMaxMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stateKey = "__fullPageScreenshotExtensionState__";
  const state = window[stateKey] || {};
  const target = state.target;
  const isWindow = state.isWindow !== false || !target;
  const de = document.documentElement;
  const height = () => Math.max(
    isWindow ? de.scrollHeight : target.scrollHeight,
    isWindow ? de.offsetHeight : target.offsetHeight,
    isWindow && document.body ? document.body.scrollHeight : 0,
    isWindow && document.body ? document.body.offsetHeight : 0
  );
  const scrollTo = (y) => {
    if (isWindow) window.scrollTo(0, y);
    else target.scrollTop = y;
  };
  const scrollTop = () => isWindow ? window.scrollY : target.scrollTop;
  const pendingInView = () => {
    const vh = window.innerHeight;
    return Array.from(document.images).filter((img) => {
      const r = img.getBoundingClientRect();
      return r.top < vh && r.bottom > 0 && r.width > 0 && !img.complete;
    });
  };
  for (let i = 0; i < maxScreens; i++) {
    scrollTo(i * step);
    await sleep(50); // let IntersectionObserver lazy-loaders assign src
    const start = performance.now();
    while (pendingInView().length && performance.now() - start < perStepMaxMs) await sleep(80);
    if (scrollTop() + step >= height() - 1) break;
  }
  scrollTo(0);
  await sleep(80);
  return height();
}

// Before capturing a screen, wait until its lazy content has actually rendered:
// give lazy-loaders a tick to assign image src, wait for in-view images to finish
// loading (bounded), wait for web fonts, then a couple of frames to ensure paint.
async function waitForRender(maxWaitMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = performance.now();
  await sleep(80); // let IntersectionObserver lazy-loaders kick in
  while (performance.now() - start < maxWaitMs) {
    const vh = window.innerHeight;
    const pending = Array.from(document.images).filter((img) => {
      const r = img.getBoundingClientRect();
      return r.top < vh && r.bottom > 0 && r.width > 0 && !img.complete;
    });
    if (!pending.length) break;
    await sleep(80);
  }
  try {
    if (document.fonts && document.fonts.ready) {
      await Promise.race([document.fonts.ready, sleep(300)]);
    }
  } catch (_) {}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))));
}

function scrollToY(y, hideFixed) {
  const hiddenKey = "__fullPageScreenshotHiddenFixed__";
  const stateKey = "__fullPageScreenshotExtensionState__";
  const state = window[stateKey] || {};
  const target = state.target;
  const isWindow = state.isWindow !== false || !target;
  // Hide fixed/sticky elements after the first screen so headers/footers
  // don't get duplicated down the long image.
  if (hideFixed && !window[hiddenKey]) {
    window[hiddenKey] = [];
    const els = document.body ? document.body.querySelectorAll("*") : [];
    for (const el of els) {
      // visibility is inherited, so hiding the scroll target — or any ancestor
      // of it — blanks out everything we're trying to capture. App-shell layouts
      // routinely wrap the content area in a position:fixed shell.
      if (target && (el === target || el.contains(target))) continue;
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") {
        window[hiddenKey].push([el, el.style.visibility]);
        el.style.visibility = "hidden";
      }
    }
  }
  if (isWindow) {
    window.scrollTo(0, y);
    return window.scrollY;
  }
  target.scrollTop = y;
  return target.scrollTop;
}

function restorePage() {
  const stateKey = "__fullPageScreenshotExtensionState__";
  const hiddenKey = "__fullPageScreenshotHiddenFixed__";
  const s = window[stateKey];
  if (window[hiddenKey]) {
    for (const [el, vis] of window[hiddenKey]) el.style.visibility = vis;
    delete window[hiddenKey];
  }
  if (s) {
    const de = document.documentElement;
    de.style.scrollBehavior = s.htmlScrollBehavior;
    de.style.scrollSnapType = s.htmlScrollSnapType;
    de.style.overflow = s.htmlOverflow;
    if (document.body) document.body.style.overflow = s.bodyOverflow;
    if (s.target) {
      s.target.style.scrollBehavior = s.targetScrollBehavior;
      s.target.style.scrollSnapType = s.targetScrollSnapType;
      s.target.style.overflowY = s.targetOverflowY;
      s.target.scrollLeft = s.targetScrollLeft;
      s.target.scrollTop = s.targetScrollTop;
    }
    window.scrollTo(s.scrollX, s.scrollY);
    delete window[stateKey];
  }
}
