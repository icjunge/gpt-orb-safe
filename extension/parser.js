/* Reads bounded, visible metric cards on the official usage page. No credentials or page text leave this module. */
(function (root) {
  'use strict';
  // executeScript may inject again on a manual refresh; preserve deadlines for this document.
  if (root.OrbPageParser?.parserVersion === 1) {
    if (typeof module !== 'undefined' && module.exports) module.exports = root.OrbPageParser;
    return;
  }

  const DAY = 86400000;
  const WINDOW_ORDER = ['session', 'weekly', 'other'];
  const documentAnchors = new WeakMap();
  const EXCLUDED = 'script,style,noscript,template,nav,aside,header,footer,input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[hidden],[inert],[aria-hidden="true"]';
  const LABEL_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"],dt,label,legend,p,span,div';

  function normalize(value) {
    return String(value || '').normalize('NFKC').replace(/\u2212/g, '-').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  }

  function allowedLocation(location) {
    try {
      const url = new URL(typeof location === 'string' ? location : location.href);
      return url.origin === 'https://chatgpt.com' && !url.username && !url.password &&
        /^\/codex\/settings\/usage\/?$/.test(url.pathname);
    } catch { return false; }
  }

  function classifyLabel(value) {
    const text = normalize(value).toLowerCase();
    if (!text || text.length > 100 || text.includes('%')) return null;
    if (/^(?:(?:current|your) )?(?:(?:5|five)[ -]?(?:hour|hr)s?(?: (?:usage |rate )?(?:limit|limits))?|session(?: (?:usage |rate )?(?:limit|limits))?)(?: \(all models\))?$/.test(text) ||
        /^(?:当前)?(?:(?:5|五)\s*小时|会话)(?:用量|使用量|使用限额|用量限制|使用限制|额度|限额|限制)?(?:[ (（]所有模型[)）]?)?$/.test(text)) return 'session';
    if (/^(?:weekly|(?:7|seven)[ -]day)(?: (?:usage |rate )?(?:limit|limits))?(?: \(all models\))?$/.test(text) ||
        /^(?:每周|本周|周|(?:7|七)\s*天)(?:用量|使用量|使用限额|用量限制|使用限制|额度|限额|限制)(?:[ (（]所有模型[)）]?)?$/.test(text)) return 'weekly';
    if (/^code review(?: (?:usage )?(?:limit|limits))?$/.test(text) || /^代码(?:审查|审阅)(?:用量|额度|限额|限制)?$/.test(text)) return 'other';
    if (/^(?:lifetime|all[ -]time|cumulative) (?:token usage|tokens?(?: used)?)$/.test(text) ||
        /^(?:累计|累积|历史累计)(?:使用)?\s*(?:tokens?|令牌)\s*(?:用量|使用量|数|总数)?$/.test(text)) return 'total';
    if (/^(?:(?:today|today's|todays) (?:token usage|tokens?(?: used)?)|tokens?(?: used)? today)$/.test(text) ||
        /^(?:今日|今天|当日)(?:使用)?\s*(?:tokens?|令牌)\s*(?:用量|使用量|数|总数)?$/.test(text)) return 'today';
    return null;
  }

  function parseUsedPercent(value) {
    const text = normalize(value).toLowerCase();
    const number = '(?<![+\\-\\d.,])(?:\\d{1,3})(?:[.,]\\d{1,3})?';
    const direction = 'remaining|available|left|consumed|used|已使用|已消耗|已用|剩余|可用';
    const results = [];
    const patterns = [
      new RegExp('(' + number + ')\\s*%\\s*(' + direction + ')(?![a-z])', 'g'),
      new RegExp('(?<![a-z])(' + direction + ')(?:\\s*(?:quota|usage|额度|用量))?\\s*[:：]?\\s*(' + number + ')\\s*%', 'g')
    ];
    for (let index = 0; index < patterns.length; index++) {
      for (const match of text.matchAll(patterns[index])) {
        const amount = Number(match[index ? 2 : 1].replace(',', '.'));
        if (!Number.isFinite(amount) || amount < 0 || amount > 100) return null;
        const word = match[index ? 1 : 2];
        const used = /^(remaining|available|left|剩余|可用)$/.test(word) ? 100 - amount : amount;
        results.push(Math.round(used * 1000) / 1000);
      }
    }
    if (!results.length || results.some(number => number !== results[0])) return null;
    return results[0];
  }

  function parseInteger(value) {
    const text = normalize(value);
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{0,2}(?: \d{3})+)$/.test(text)) return null;
    const result = Number(text.replace(/[, ]/g, ''));
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
  }

  function parseTokenMetric(value, kind) {
    if (kind !== 'total' && kind !== 'today') return null;
    const text = normalize(value);
    // Require exactly one explicit lifetime/today label and an exact integer. Rounded K/M values remain unknown.
    const trailing = text.match(/^(.*?)\s*[:：]?\s+(\d[\d, ]*)(?:\s*(?:tokens?|令牌|个))?$/i);
    if (trailing && classifyLabel(trailing[1].replace(/[:：]$/, '')) === kind) return parseInteger(trailing[2]);
    const leading = text.match(/^(\d[\d, ]*)\s+(.+)$/);
    if (leading && classifyLabel(leading[2]) === kind) return parseInteger(leading[1]);
    return null;
  }

  function parseAbsoluteTime(value) {
    const text = normalize(value);
    const match = text.match(/\b(20\d{2})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})\b/i);
    if (!match) return null;
    const [, y, mo, d, h, mi, s = '0', fraction = '', zone] = match;
    const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
    if (zone !== 'Z' && zone !== 'z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59 || (zone.slice(1, 3) === '14' && zone.slice(4) !== '00'))) return null;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${String(s).padStart(2, '0')}${fraction}${zone.toUpperCase()}`;
    const timestamp = Date.parse(iso);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function relativeReset(value) {
    const text = normalize(value).toLowerCase();
    if ((text.match(/\bresets?\b|重置/g) || []).length !== 1) return null;
    const match = text.match(/\bresets?\s+in\s+((?:\d+(?:\.\d+)?\s*(?:weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[wdhms])\s*(?:,\s*|and\s*)?)+)(?![a-z0-9.])(?!\s*\d)/i) ||
      text.match(/(?:将在|还有|剩余)?\s*((?:\d+(?:\.\d+)?\s*(?:周|天|小时|分钟|分|秒)\s*)+)后?\s*重置/) ||
      text.match(/重置(?:倒计时|时间)?\s*[:：]?\s*((?:\d+(?:\.\d+)?\s*(?:周|天|小时|分钟|分|秒)\s*)+)/);
    if (!match) return null;
    let milliseconds = 0;
    const units = new Set();
    const amounts = [...match[1].matchAll(/(\d+(?:\.\d+)?)\s*(weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[wdhms]|周|天|小时|分钟|分|秒)/g)];
    for (const [, amount, unit] of amounts) {
      const group = /^(w|week|weeks|周)$/.test(unit) ? 'w' : /^(d|day|days|天)$/.test(unit) ? 'd' : /^(h|hour|hours|hr|hrs|小时)$/.test(unit) ? 'h' : /^(m|minute|minutes|min|mins|分钟|分)$/.test(unit) ? 'm' : 's';
      if (units.has(group)) return null;
      units.add(group);
      milliseconds += Number(amount) * ({ w: DAY * 7, d: DAY, h: 3600000, m: 60000, s: 1000 }[group]);
    }
    if (!amounts.length || !Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > DAY * 32) return null;
    return { signature: normalize(match[0]).toLowerCase(), milliseconds: Math.round(milliseconds) };
  }

  function parseReset(value, { absoluteValues = [], now = Date.now(), kind = 'other', anchors = new Map() } = {}) {
    const text = normalize(value);
    if (!/\breset(?:s)?\b|重置/i.test(text)) return { resetAt: null, resetApproximate: false };
    const absoluteTexts = text.match(/\b20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/gi) || [];
    const absolutes = [...absoluteTexts, ...absoluteValues].map(parseAbsoluteTime).filter(value => value !== null);
    if (absolutes.length) {
      if (absolutes.some(value => value !== absolutes[0])) return { resetAt: null, resetApproximate: false };
      anchors.delete(kind);
      if (absolutes[0] < now - DAY || absolutes[0] > now + DAY * 60) return { resetAt: null, resetApproximate: false };
      return { resetAt: absolutes[0], resetApproximate: false };
    }
    const relative = relativeReset(text);
    if (!relative) return { resetAt: null, resetApproximate: false };
    const previous = anchors.get(kind);
    if (previous && previous.signature === relative.signature) return previous.resetAt < now - DAY ? { resetAt: null, resetApproximate: false } : { resetAt: previous.resetAt, resetApproximate: true };
    const resetAt = now + relative.milliseconds;
    anchors.set(kind, { signature: relative.signature, resetAt });
    return { resetAt, resetApproximate: true };
  }

  function isVisible(element, document) {
    if (!element || element.nodeType !== 1 || element.closest(EXCLUDED)) return false;
    const view = document.defaultView;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = view?.getComputedStyle(node);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || style.opacity === '0')) return false;
    }
    return Boolean(element.getClientRects().length);
  }

  function ownText(element) {
    let text = '';
    for (const node of element.childNodes) {
      if (node.nodeType === 3) text += node.nodeValue + ' ';
      if (text.length > 140) return '';
    }
    return normalize(text);
  }

  function cardText(element, document) {
    // Bounds prevent accidentally treating the whole dashboard as one metric card.
    let visited = 0, characters = 0;
    const output = [];
    function visit(node) {
      if (++visited > 100 || characters > 1600) return false;
      if (node.nodeType === 3) {
        const value = normalize(node.nodeValue);
        characters += value.length;
        if (characters > 1600) return false;
        if (value) output.push(value);
      } else if (node.nodeType === 1) {
        if (!isVisible(node, document)) return true;
        for (const child of node.childNodes) if (!visit(child)) return false;
      }
      return true;
    }
    return visit(element) ? output.join(' ') : null;
  }

  function collect(document, location) {
    if (!document || !allowedLocation(location)) return null;
    const now = Date.now();
    const snapshot = { version: 1, source: 'official-page', capturedAt: now, windows: [], tokens: { total: null, today: null } };
    const scope = document.querySelector('main,[role="main"]');
    if (!scope || !isVisible(scope, document)) return snapshot;
    let anchors = documentAnchors.get(document);
    if (!anchors) { anchors = new Map(); documentAnchors.set(document, anchors); }
    const candidates = [];
    // Only short, visible metric labels are candidates. Never read body.innerText, scripts, inputs, or browser storage.
    for (const element of scope.querySelectorAll(LABEL_SELECTOR)) {
      if (candidates.length > 80) return snapshot;
      if (!isVisible(element, document)) continue;
      const kind = classifyLabel(ownText(element));
      if (kind) candidates.push({ element, kind });
    }
    const windows = new Map(), tokens = new Map(), collisions = new Set();
    for (const candidate of candidates) {
      let card = candidate.element;
      for (let depth = 0; card && card !== scope && depth < 5; depth++, card = card.parentElement) {
        // A card with any second metric label cannot be attributed safely.
        if (candidates.some(other => other.element !== candidate.element && card.contains(other.element))) break;
        const text = cardText(card, document);
        if (!text) break;
        if (candidate.kind === 'total' || candidate.kind === 'today') {
          const count = parseTokenMetric(text, candidate.kind);
          if (count === null) continue;
          if (tokens.has(candidate.kind)) collisions.add(candidate.kind);
          tokens.set(candidate.kind, count);
          break;
        }
        const usedPercent = parseUsedPercent(text);
        if (usedPercent === null) continue;
        const absoluteValues = [...card.querySelectorAll('time[datetime]')].filter(element => isVisible(element, document)).map(element => element.getAttribute('datetime'));
        const reset = parseReset(text, { absoluteValues, now, kind: candidate.kind, anchors });
        const window = { kind: candidate.kind, usedPercent, ...reset };
        const previous = windows.get(candidate.kind);
        if (previous) collisions.add(candidate.kind);
        windows.set(candidate.kind, window);
        break;
      }
    }
    snapshot.windows = WINDOW_ORDER.filter(kind => windows.has(kind) && !collisions.has(kind)).map(kind => windows.get(kind));
    for (const kind of ['total', 'today']) if (tokens.has(kind) && !collisions.has(kind)) snapshot.tokens[kind] = tokens.get(kind);
    return snapshot;
  }

  const api = Object.freeze({ parserVersion: 1, collect, allowedLocation, classifyLabel, parseUsedPercent, parseInteger, parseTokenMetric, parseAbsoluteTime, relativeReset, parseReset });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OrbPageParser = api;
})(globalThis);
