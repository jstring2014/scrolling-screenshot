// `t()` comes from i18n.js, which runs just before this script.

const views = {
  idle: document.getElementById("view-idle"),
  busy: document.getElementById("view-busy"),
  done: document.getElementById("view-done"),
  error: document.getElementById("view-error"),
};
const barFill = document.getElementById("barFill");
const statusEl = document.getElementById("status");
const stageEl = document.getElementById("stage");
const percentEl = document.getElementById("percent");
const hideFixedEl = document.getElementById("hideFixed");
const cancelBtn = document.getElementById("cancel");
const openImgBtn = document.getElementById("openImg");

let format = "png";
let port = null;
let captureStartedAt = 0;

function show(name) {
  for (const k in views) views[k].classList.toggle("hidden", k !== name);
}

function setStage(key) {
  stageEl.textContent = t(key);
}

function setProgress(p) {
  const percent = Math.max(0, Math.min(100, Math.round(p * 100)));
  barFill.style.width = `${percent}%`;
  percentEl.textContent = `${percent}%`;
}

function resetBusyControls() {
  cancelBtn.disabled = false;
  cancelBtn.textContent = t("popupCancel");
}

function formatRemaining(elapsedMs, current, total) {
  if (!current || !total || current >= total) return "";
  const remainingMs = (elapsedMs / current) * (total - current);
  const seconds = Math.max(1, Math.round(remainingMs / 1000));
  if (seconds < 60) return t("statusRemainingSec", [String(seconds)]);
  return t("statusRemainingMin", [String(Math.ceil(seconds / 60))]);
}

function showError(msg) {
  resetBusyControls();
  document.getElementById("errMsg").textContent = msg.code
    ? t(msg.code, msg.params)
    : t("errUnexpected", [msg.message || ""]);
  show("error");
}

document.getElementById("fmt").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-fmt]");
  if (!btn) return;
  format = btn.dataset.fmt;
  for (const b of document.querySelectorAll("#fmt button")) b.classList.toggle("on", b === btn);
});

function startCapture() {
  show("busy");
  resetBusyControls();
  setStage("stagePreparing");
  statusEl.textContent = t("statusPreparing");
  setProgress(0);
  captureStartedAt = 0;

  // "Capture again" / "Try again" reuse this function — drop the previous port
  // instead of leaving it connected for the lifetime of the popup.
  if (port) { try { port.disconnect(); } catch (_) {} }
  port = chrome.runtime.connect({ name: "capture" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "status") {
      setStage(msg.stage || "stageLoading");
      statusEl.textContent = t(msg.code, msg.params);
    } else if (msg.type === "progress") {
      if (!captureStartedAt) captureStartedAt = performance.now();
      setStage("stageCapturing");
      const elapsed = performance.now() - captureStartedAt;
      const remaining = formatRemaining(elapsed, msg.current, msg.total);
      statusEl.textContent = [
        t("statusCapturing", [String(msg.current), String(msg.total)]),
        remaining,
      ].filter(Boolean).join(t("listSeparator"));
      setProgress(msg.current / msg.total);
    } else if (msg.type === "stitching") {
      setStage("stageStitching");
      statusEl.textContent = t("statusStitching");
      setProgress(1);
      cancelBtn.disabled = true;
    } else if (msg.type === "done") {
      onDone(msg);
    } else if (msg.type === "cancelled") {
      resetBusyControls();
      show("idle");
    } else if (msg.type === "error") {
      showError(msg);
    }
  });
  port.onDisconnect.addListener(() => {
    if (!views.busy.classList.contains("hidden")) showError({ code: "errPortLost" });
  });

  port.postMessage({ type: "start", options: { format, hideFixedElements: hideFixedEl.checked } });
}

function onDone(msg) {
  resetBusyControls();
  document.getElementById("doneMsg").textContent = t("doneSaved");
  const prev = document.getElementById("preview");
  prev.innerHTML = "";
  if (msg.preview) {
    const img = new Image();
    img.src = msg.preview;
    img.alt = t("popupPreviewAlt");
    prev.appendChild(img);
  }
  document.getElementById("doneMeta").textContent =
    [
      msg.count > 1 ? t("doneSplit", [String(msg.count)]) : t("doneOneImage"),
      msg.truncated
        ? t("doneTruncated", [String(msg.capturedScreens), String(msg.totalScreens || msg.maxScreens)])
        : "",
      msg.stoppedEarly ? t("doneStoppedEarly") : "",
      msg.viewerReady ? "" : t("donePreviewFailed"),
    ].filter(Boolean).join(" · ");
  openImgBtn.disabled = !msg.viewerReady;
  show("done");
}

document.getElementById("start").addEventListener("click", startCapture);
document.getElementById("again").addEventListener("click", startCapture);
document.getElementById("retry").addEventListener("click", startCapture);
openImgBtn.addEventListener("click", () => {
  if (port) port.postMessage({ type: "open" });
});
cancelBtn.addEventListener("click", () => {
  if (port) port.postMessage({ type: "cancel" });
  cancelBtn.disabled = true;
  cancelBtn.textContent = t("popupCancelling");
  statusEl.textContent = t("statusCancelling");
});
