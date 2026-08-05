# Store listing copy

Fill-in text for the Chrome Web Store Developer Dashboard and the Microsoft Edge
Partner Center. Field limits: name 75 characters, short description 132.

Assets live in `store-assets/` and are produced by `npm run store-assets`, which
loads the real extension in Chromium and captures it working — do not hand-edit them.

---

## Name (75 max)

```
Scrolling Screenshot — Full Page & In-Page Scroll Area Capture
```

62 characters. Chrome uses the manifest `name` as the listing title, so this comes
from `_locales/*/messages.json` → `extensionName`, not from the dashboard.

Why not "Full Page Screenshot": that exact phrase is owned by GoFullPage (9M+ users)
and 300+ near-clones. "Scrolling Screenshot" is a real query with far less
competition, and the tail carries both the head term ("Full Page") and the thing no
one else puts in their title ("In-Page Scroll Area").

Do **not** put ChatGPT, GPT, Gmail, Notion or any other product name in the title —
OpenAI's brand policy forbids "GPT" in product names and store trademark complaints
get listings pulled. Naming them as examples in the description body is fine.

## Short description (132 max)

```
Capture a whole page — or a panel that scrolls inside it — as one long PNG or JPEG. Runs entirely on your device.
```

113 characters.

## Category

**Chrome Web Store:** Tools (alternative: Workflow & Planning)
**Edge Add-ons:** Productivity

## Search terms (Edge only — max 7, policy 1.1.4)

```
scrolling screenshot, long screenshot, full page screenshot, webpage capture, scroll area capture, dashboard screenshot, page to image
```

Chrome has no keyword field; the name and description carry all of it.

---

## Detailed description — en

```
Capture an entire web page as one continuous image, instead of five separate
screenshots you have to reassemble afterwards.

Press the toolbar button (or Alt+Shift+S), pick PNG or JPEG, and the extension
scrolls the page for you, waits for each screen to finish rendering, and stitches
everything into a single long image saved straight to your Downloads folder.

WHAT MAKES IT DIFFERENT

Most pages today do not scroll the document — dashboards, admin consoles, data
grids and document views keep the page height fixed and scroll a panel inside it.
Tools that measure the document see one screen and stop there. This extension
detects the panel you are actually reading, scrolls that, and crops the sidebars
and toolbars out of the result.

FEATURES

• Full page capture in one click, saved as PNG or JPEG
• Captures panels that scroll inside the page, not just the document
• Waits for lazy-loaded images and web fonts before taking each screen, so you
  do not get half-rendered blanks
• Hides sticky headers and footers after the first screen so they do not repeat
• Seamless stitching, including on 125% and 150% display scaling
• Very long pages are split into numbered parts instead of failing
• Live progress with the current stage and time remaining
• Preview the result at fit-width or actual size, and download it again
• Pause and resume: switching tabs mid-capture pauses instead of losing the run
• Stops with a clear message if the detected area cannot actually be scrolled
• Interface available in English and Simplified Chinese

PRIVACY

Everything happens on your device. There is no account, no upload, no analytics,
no telemetry and no remotely loaded code. The extension requests only three
permissions — activeTab, scripting and downloads — and no host permissions at
all, which means it has no standing access to any website. activeTab grants
access to a single tab only at the moment you press the button.

KNOWN LIMITS

Pages that recycle rows as you scroll (virtualised lists such as very long chat
threads and social timelines) destroy off-screen content, so no scroll-and-stitch
tool can capture them in full. This extension tells you when a capture stopped
early rather than silently handing you an incomplete image.

Browser built-in pages (chrome:// and similar) cannot be captured.
```

## Detailed description — zh-CN

```
把整个网页截成一张完整的长图，而不是五张需要自己拼回去的截图。

点工具栏按钮（或按 Alt+Shift+S），选择 PNG 或 JPEG，插件会自动滚动页面、等待每一屏
渲染完成，再拼接成一张长图保存到下载目录。

与同类插件的区别

现在多数页面并不滚动文档本身——后台系统、数据看板、表格和文档视图都是页面高度固定、
内部面板滚动。只测量文档高度的工具在这类页面上只能截到一屏。本插件会识别你正在阅读的
那个滚动面板，滚动它并把侧栏、工具栏裁掉。

功能

• 一键整页截图，输出 PNG 或 JPEG
• 支持页面内滚动的面板，而不只是整个文档
• 每屏截取前等待懒加载图片和字体渲染，避免截到空白
• 第一屏之后隐藏固定页头/页脚，避免重复
• 无缝拼接，兼容 125%/150% 缩放
• 超长页面自动拆分为多张，而不是直接失败
• 实时显示当前阶段和预计剩余时间
• 预览页支持适应宽度、原始尺寸和重新下载
• 截图中途切换标签页会暂停，切回来继续，不会丢失进度
• 识别到的区域滚不动时会明确报错，而不是给你一堆重复图

隐私

全程本机处理。没有账号、不上传、无统计、无远程代码。只申请 activeTab、scripting、
downloads 三个权限，不申请任何 host 权限，也就是对任何网站都没有常驻访问能力。

已知限制

滚动时会回收 DOM 的虚拟列表（超长聊天记录、社交时间线等），屏幕外的内容根本不在页面里，
任何"滚动+拼接"的工具都无法截全。本插件会在提前停止时明确告知，而不是悄悄给你一张不完整的图。

浏览器内置页面（chrome:// 等）无法截图。
```

---

## Privacy practices tab

Paste-ready text for the Chrome dashboard. Every field there has a 1,000 character
limit; the counts below are current.

### Single purpose (672)

```
This extension has a single purpose: to capture the web page the user is currently viewing - or the scrollable panel inside that page - as one long screenshot image saved to the user's own computer.

When the user clicks the toolbar button (or presses Alt+Shift+S) and starts a capture, the extension measures the page, scrolls it one viewport at a time, captures each visible screen, stitches those screens into a single PNG or JPEG, saves the file to the Downloads folder, and then restores the page to its original scroll position and styles.

It does nothing else. It does not modify page content, does not collect user data, and does not send anything off the device.
```

### activeTab justification (613)

```
activeTab gives the extension temporary access to the one tab the user wants to capture, and only at the moment the user invokes the extension by clicking the toolbar button or pressing the keyboard shortcut.

That access is required in order to read the page's dimensions and scroll position, scroll it, and call chrome.tabs.captureVisibleTab on it. Without activeTab the extension cannot see or capture the page at all.

The extension deliberately requests no host permissions, so it has no standing access to any website. Access is limited to the single tab the user chose and lapses once the capture finishes.
```

### scripting justification (876)

```
chrome.scripting.executeScript runs the extension's own bundled functions inside the tab being captured. Those functions:

- measure the document and viewport size;
- identify which element actually scrolls (the document itself, or a panel that scrolls inside the page, such as a dashboard's data grid);
- scroll that element one viewport at a time;
- wait for lazy-loaded images and web fonts in the current viewport to finish rendering before each screen is captured, so the result contains no half-rendered blanks;
- temporarily hide sticky headers and footers after the first screen so they do not repeat down the stitched image;
- restore the page's original scroll position, overflow and scroll-behaviour styles when the capture ends, is cancelled, or fails.

All injected code ships inside the uploaded package. No remote or dynamically generated code is ever executed.
```

### downloads justification (605)

```
chrome.downloads.download writes the finished screenshot to the user's Downloads folder. This is the deliverable the user explicitly asked for by starting a capture - without it the extension could not hand the image back.

Files are saved with saveAs:false under a name derived from the page's hostname and a timestamp, for example screenshot-example.com-20260805-143012.png. A page too tall for a single canvas produces several numbered parts.

The permission is used only to save the images the user just requested. The extension never reads, searches, or modifies the user's existing download history.
```

### Remote code

Select **"No, I am not using remote code."** All JavaScript, HTML and CSS ships
inside the uploaded package; nothing is fetched, imported or `eval`'d at runtime.
Answering yes here is both untrue and a rejection risk.

## Data usage disclosure

Answer "No" to every data collection category.

The extension reads the visible content of the active tab only while a capture the
user started is running. Images are generated locally and written to the Downloads
folder. The most recent result is cached in the extension's own IndexedDB so the
preview tab can display it; it never leaves the device and is overwritten by the
next capture.

## Privacy policy URL

Required by Chrome. `PRIVACY.md` must be published at a public URL and that URL
entered in the dashboard — a local file is not accepted.

---

## Review / certification notes

```
No account or login is required.

1. Install the extension.
2. Open any long article page.
3. Click the toolbar icon, choose PNG, click Capture.
4. The page scrolls automatically; the popup shows progress. When it finishes the
   image is in the Downloads folder.
5. Click "Open preview" to view the stitched long image in a tab.
6. Open a page whose main content scrolls inside a panel (any admin dashboard with
   a scrolling table works).
7. Capture again — the popup reports "Found an in-page scroll area" and the result
   contains the panel's full contents with the sidebar cropped out.

Expected behaviour:
- Browser built-in pages (chrome://, edge://) are rejected with a message.
- Pages taller than one canvas are split into numbered parts.
- Switching to another tab pauses the capture; it resumes when you switch back,
  and gives up after 60 seconds away.
```

## Screenshots to upload, in order

1. `screenshot-popup-1280x800.png` — the popup on a real article page
2. `screenshot-fullpage-1280x800.png` — one screen vs the full stitched image
3. `screenshot-container-scroll-1280x800.png` — in-page scroll area detection
4. `screenshot-preview-1280x800.png` — progress and the preview tab
5. `screenshot-privacy-1280x800.png` — permissions and privacy

Promo tiles: `tile-small-440x280.png` (required by Chrome),
`tile-large-1400x560.png` (marquee, optional).
Store icon: `store-icon-128.png` (96x96 artwork inside 16px of transparent padding).
Edge also wants `logo-300.png`.
