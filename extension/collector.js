(() => {
  'use strict';
  if (globalThis.__orbCollector) globalThis.__orbCollector.stop();
  let active = true;
  let timer;
  let debounce;
  let lastRead = 0;
  let pending = false;

  function onUsagePage() {
    return location.origin === 'https://chatgpt.com' &&
      (location.pathname === '/codex/settings/usage' || location.pathname === '/codex/settings/usage/');
  }

  function stop() {
    if (!active) return;
    active = false;
    clearInterval(timer);
    clearTimeout(debounce);
    observer.disconnect();
    chrome.runtime.onMessage.removeListener(onMessage);
  }

  async function sample() {
    if (!active || pending) return;
    if (!onUsagePage()) { stop(); return; }
    pending = true;
    lastRead = Date.now();
    try {
      const snapshot = globalThis.OrbPageParser?.collect(document, location);
      if (!snapshot || !active || !onUsagePage()) return;
      const response = await chrome.runtime.sendMessage({ type: 'orb:snapshot', snapshot });
      if (response?.stop) stop();
    } catch { stop(); }
    finally { pending = false; }
  }

  function onMessage(message, sender, respond) {
    if (sender.id !== chrome.runtime.id || message?.type !== 'orb:stop') return;
    stop(); respond({ ok: true });
  }

  const observer = new MutationObserver(() => {
    if (!active) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (Date.now() - lastRead >= 5000) sample();
    }, 1800);
  });

  globalThis.__orbCollector = { stop };
  if (!onUsagePage()) return;
  chrome.runtime.onMessage.addListener(onMessage);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['aria-valuenow', 'aria-label', 'datetime', 'hidden', 'style', 'class'] });
  timer = setInterval(sample, 60000);
  sample();
})();
