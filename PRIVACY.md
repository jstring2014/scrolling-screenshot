# Privacy Policy

Last updated: 2026-08-05

Scrolling Screenshot is a browser extension that captures the page the user
chooses and saves the resulting image on the user's own device.

## Data collection

**The extension collects no data at all.**

It does not collect, sell, transmit, or share personal information. It does not
send screenshots, webpage content, browsing history, account information,
analytics events, telemetry, or usage data to any server. There is no account, no
sign-in, and no network request of any kind at runtime.

## Local data use

When the user starts a capture, the extension temporarily reads the active tab in
order to measure the page, identify which area scrolls, scroll it, capture each
visible screen, and stitch those screens into one long image. The page's original
scroll position and styles are restored when the capture ends, is cancelled, or
fails.

Generated screenshots are saved to the user's local downloads folder through the
browser's download API.

The most recent result is cached in the extension's own IndexedDB storage so the
preview tab can display it. That cache never leaves the device and is overwritten
by the next capture.

## Permissions

- `activeTab` — granted only when the user invokes the extension, and only for the
  single tab being captured. It lapses when the capture finishes.
- `scripting` — injects the extension's own bundled functions into that tab to
  measure the page, identify the scroll target, scroll it, wait for content to
  render, temporarily hide sticky headers and footers, and restore the page.
- `downloads` — saves the finished image to the user's downloads folder.

The extension requests **no host permissions**, so it has no standing access to any
website.

## Remote code

The extension does not load or execute remotely hosted code. All JavaScript, HTML,
CSS and image assets are included in the extension package that was reviewed by
the store.

## Changes to this policy

Any change will be published on this page with an updated date above.

## Contact

For privacy questions or support: weixianfuln@gmail.com
