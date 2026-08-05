// Shared localization helper for the extension's HTML pages.
//
// Loaded at the end of <body>, before the page's own script, so the DOM is
// already parsed and `t()` is available to whatever runs next. (Top-level
// `const` in a classic script lands in the shared global lexical scope.)
// An external file rather than an inline script because the extension CSP
// forbids inline JavaScript.

const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;

document.documentElement.lang = t("localeCode");

// <title data-i18n="..."> works too: setting textContent updates document.title.
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-alt]")) el.alt = t(el.dataset.i18nAlt);
for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
