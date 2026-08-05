// `t()` comes from i18n.js, which runs just before this script.
//
// This page shares the extension's origin with the service worker, so it opens
// the result database directly rather than asking the worker to serialize tens
// of megabytes of image data back through chrome.runtime messaging.

const RESULT_DB = "fullPageScreenshot";
const RESULT_STORE = "results";
const LATEST_RESULT_KEY = "latest";

const root = document.getElementById("imgs");
const titleEl = document.getElementById("barTitle");
const metaEl = document.getElementById("barMeta");
const fitBtn = document.getElementById("fit");
const actualBtn = document.getElementById("actual");
const downloadAllBtn = document.getElementById("downloadAll");

let currentImages = []; // { blob, url }

loadLatestImages()
  .then((blobs) => {
    if (!blobs.length) {
      showEmpty(t("viewerEmptyNoImages"));
      return;
    }
    currentImages = blobs.map((blob) => ({ blob, url: URL.createObjectURL(blob) }));
    titleEl.textContent = currentImages.length > 1
      ? t("viewerTitleMulti", [String(currentImages.length)])
      : t("viewerTitle");
    metaEl.textContent = t("viewerLoadingImages");
    renderImages(currentImages);
  })
  .catch(() => showEmpty(t("viewerEmptyCacheFailed")));

window.addEventListener("pagehide", () => {
  for (const image of currentImages) URL.revokeObjectURL(image.url);
});

function loadLatestImages() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(RESULT_DB, 1);
    // The worker normally creates the store; handle the case where the viewer
    // is opened before anything has ever been captured.
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(RESULT_STORE)) {
        open.result.createObjectStore(RESULT_STORE);
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(RESULT_STORE, "readonly");
      const req = tx.objectStore(RESULT_STORE).get(LATEST_RESULT_KEY);
      req.onsuccess = () => resolve((req.result && req.result.images) || []);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("preview cache read aborted")); };
    };
  });
}

fitBtn.addEventListener("click", () => setZoomMode("fit"));
actualBtn.addEventListener("click", () => setZoomMode("actual"));
downloadAllBtn.addEventListener("click", () => {
  currentImages.forEach((image, index) => downloadImage(image, index));
});

function renderImages(images) {
  root.textContent = "";
  let loaded = 0;

  for (const [index, image] of images.entries()) {
    const wrap = document.createElement("section");
    wrap.className = "shot";

    const head = document.createElement("div");
    head.className = "shot-head";

    const label = document.createElement("span");
    label.textContent = images.length > 1 ? t("viewerShotN", [String(index + 1)]) : t("viewerShot");

    const download = document.createElement("button");
    download.type = "button";
    download.textContent = t("viewerDownload");
    download.addEventListener("click", () => downloadImage(image, index));

    head.append(label, download);

    const img = new Image();
    img.src = image.url;
    img.alt = label.textContent;
    img.addEventListener("load", () => {
      loaded += 1;
      if (loaded === 1) {
        metaEl.textContent = t("viewerSizeMeta", [String(img.naturalWidth), String(img.naturalHeight)]);
      }
      if (loaded === images.length && images.length > 1) {
        metaEl.textContent += t("viewerCountMeta", [String(images.length)]);
      }
    });

    wrap.append(head, img);
    root.appendChild(wrap);
  }
}

function setZoomMode(mode) {
  const actual = mode === "actual";
  document.body.classList.toggle("actual", actual);
  fitBtn.classList.toggle("on", !actual);
  actualBtn.classList.toggle("on", actual);
}

function downloadImage(image, index) {
  const a = document.createElement("a");
  a.href = image.url;
  a.download = `long-screenshot${currentImages.length > 1 ? `-part${index + 1}` : ""}.${extensionFor(image.blob)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function extensionFor(blob) {
  return blob.type === "image/jpeg" ? "jpg" : "png";
}

function showEmpty(message) {
  for (const image of currentImages) URL.revokeObjectURL(image.url);
  currentImages = [];
  titleEl.textContent = t("viewerTitle");
  metaEl.textContent = "";
  downloadAllBtn.disabled = true;
  root.textContent = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = message;
  root.appendChild(empty);
}
