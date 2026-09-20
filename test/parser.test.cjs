'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../extension/parser.js');

test('only the exact official HTTPS usage route is eligible', () => {
  for (const base of ['https://chatgpt.com/settings/usage', 'https://chatgpt.com/codex/settings/usage']) {
    for (const value of [base, `${base}/`, `${base}?tab=overview`, `${base}/?tab=overview#weekly`]) {
      assert.equal(parser.allowedLocation(value), true, value);
      assert.equal(parser.allowedLocation(new URL(value)), true, value);
    }
    for (const value of [base.replace('https:', 'http:'), base.replace('chatgpt.com', 'chatgpt.com.evil.invalid'),
      base.replace('chatgpt.com', 'user@chatgpt.com'), base.replace('chatgpt.com', 'user:pass@chatgpt.com'),
      base.replace('chatgpt.com', 'chatgpt.com:8080'), `${base}/extra`, `${base}//`, `${base}-extra`,
      base.replace('usage', '%75sage'), base.replace('settings', 'Settings')]) {
      assert.equal(parser.allowedLocation(value), false, value);
      assert.equal(parser.collect({}, value), null, value);
    }
  }
  for (const value of ['https://chatgpt.com/', 'https://chatgpt.com/c/test', 'https://chatgpt.com/settings', 'invalid']) assert.equal(parser.allowedLocation(value), false, value);
  assert.equal(parser.collect({}, 'https://example.com/'), null);
});

test('recognizes explicit quota labels without assigning generic usage or token totals', () => {
  const expected = new Map([
    ['5 hour usage limit', 'session'], ['5-hour limit', 'session'], ['Current session', 'session'], ['五小时用量', 'session'], ['当前会话额度', 'session'],
    ['Weekly usage limit', 'weekly'], ['7-day limit', 'weekly'], ['每周用量', 'weekly'], ['周使用限额', 'weekly'],
    ['Code review', 'other'], ['代码审查额度', 'other'], ['Lifetime tokens', 'total'], ['All-time token usage', 'total'], ['累计 Token 用量', 'total'], ['历史累计令牌数', 'total'],
    ["Today's tokens", 'today'], ['Tokens used today', 'today'], ['今日 Token 使用量', 'today']
  ]);
  for (const [label, kind] of expected) assert.equal(parser.classifyLabel(label), kind, label);
  for (const label of ['Usage', 'Rate limits', 'Total tokens', 'Today', 'Monthly tokens', 'Token balance', '100% remaining', 'Weekly usage limit (Some model)', 'Total cost', 'Weekly usage limit and current session']) assert.equal(parser.classifyLabel(label), null, label);
});

test('explicit percentages preserve their direction and support Chinese', () => {
  const expected = new Map([['80% remaining', 20], ['20% used', 20], ['Remaining: 80%', 20], ['剩余 80%', 20], ['已使用:20%', 20], ['剩余额度 １００％', 0], ['Used: 0%', 0], ['0% left', 100], ['100% used', 100], ['99.5% remaining', 0.5], ['remaining 99,5%', 0.5], ['80% remaining (20% used)', 20]]);
  for (const [text, used] of expected) assert.equal(parser.parseUsedPercent(text), used, text);
});

test('ambiguous, malformed, negative, and out of range percentages remain unknown', () => {
  for (const value of ['80%', 'Usage: 80%', 'Model accuracy 80%', '80% remaining / 40% used', '101% used', '1000% used', '-5% used', '−5% remaining', '+5% used', '5.1234% remaining', 'NaN% used', 'unlimited', 'No usage data']) assert.equal(parser.parseUsedPercent(value), null, value);
});

test('exact token integers do not turn rounded counters into fabricated precision', () => {
  for (const [value, expected] of [['0', 0], ['1234', 1234], ['1,234', 1234], ['1 234 567', 1234567], [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER]]) assert.equal(parser.parseInteger(value), expected);
  for (const value of ['1.2M', '1.2K', '1.0', '1,23', '01', '-1', '+1', '123 tokens', String(Number.MAX_SAFE_INTEGER + 1)]) assert.equal(parser.parseInteger(value), null, value);
  assert.equal(parser.parseTokenMetric('Lifetime tokens 1,234', 'total'), 1234);
  assert.equal(parser.parseTokenMetric('累计 Token 用量: 2,456', 'total'), 2456);
  assert.equal(parser.parseTokenMetric('Today\'s tokens 0', 'today'), 0);
  assert.equal(parser.parseTokenMetric('987 Tokens used today', 'today'), 987);
  for (const text of ['Total tokens 1234', 'Lifetime tokens 1.2M', 'Lifetime tokens 1234 this week', 'Lifetime tokens 1234 20% increase', 'Lifetime tokens 12,34', 'Lifetime tokens -1']) assert.equal(parser.parseTokenMetric(text, 'total'), null, text);
});

test('absolute reset requires an explicit valid calendar date and timezone', () => {
  assert.equal(parser.parseAbsoluteTime('Resets 2026-09-21T12:30:00Z'), Date.parse('2026-09-21T12:30:00Z'));
  assert.equal(parser.parseAbsoluteTime('2026-09-21 20:30+08:00'), Date.parse('2026-09-21T12:30:00Z'));
  assert.equal(parser.parseAbsoluteTime('2028-02-29T12:30:30.123Z'), Date.parse('2028-02-29T12:30:30.123Z'));
  for (const text of ['2026-09-21 12:30', 'at 12:30', 'September 21', '2026-02-29T12:30:00Z', '2026-09-21T25:00:00Z', '2026-09-21T12:60:00Z', '2026-09-21T12:30:00+15:00', '2026-09-21T12:30:00+14:01']) assert.equal(parser.parseAbsoluteTime(text), null, text);
});

test('relative reset labels are recognized only when explicitly associated with resets', () => {
  const expected = new Map([['Resets in 3 hours 20 minutes', 12000000], ['Resets in 2d 4h', 187200000], ['将在 3小时20分钟后重置', 12000000], ['重置倒计时: 1天 2小时', 93600000], ['Resets in 0 minutes', 0]]);
  for (const [label, milliseconds] of expected) assert.equal(parser.relativeReset(label)?.milliseconds, milliseconds, label);
  for (const text of ['3 hours remaining', '5 hour usage limit', 'Resets in -1 hours', 'Resets in 90 days', 'Resets in 1 hour 2 hours', 'Resets tomorrow', 'Resets in 3h 20garbage', 'Resets in 3h / Resets in 4h']) assert.equal(parser.relativeReset(text), null, text);
});

test('unchanged relative reset does not drift forward as the page is reread', () => {
  const anchors = new Map(), now = Date.parse('2026-09-20T00:00:00Z');
  const initial = parser.parseReset('Resets in 3 hours', { now, kind: 'session', anchors });
  const reread = parser.parseReset('75% remaining Resets in 3 hours', { now: now + 60000, kind: 'session', anchors });
  assert.deepEqual(initial, { resetAt: now + 10800000, resetApproximate: true });
  assert.deepEqual(reread, initial);
  const otherWindow = parser.parseReset('Resets in 3 hours', { now: now + 60000, kind: 'weekly', anchors });
  assert.equal(otherWindow.resetAt, now + 10860000);
  const changed = parser.parseReset('Resets in 2 hours 59 minutes', { now: now + 60000, kind: 'session', anchors });
  assert.equal(changed.resetAt, initial.resetAt);
  const expired = parser.parseReset('Resets in 2 hours 59 minutes', { now: now + 20000000, kind: 'session', anchors });
  assert.equal(expired.resetAt, initial.resetAt);
  const veryOld = parser.parseReset('Resets in 2 hours 59 minutes', { now: now + 200000000, kind: 'session', anchors });
  assert.deepEqual(veryOld, { resetAt: null, resetApproximate: false });
});

test('explicit times win over approximate time but conflicting dates stay unknown', () => {
  const options = { now: Date.parse('2026-09-20T00:00:00Z'), kind: 'weekly', anchors: new Map(), absoluteValues: ['2026-09-21T00:00:00Z'] };
  assert.deepEqual(parser.parseReset('Resets in 1 day', options), { resetAt: Date.parse('2026-09-21T00:00:00Z'), resetApproximate: false });
  assert.deepEqual(parser.parseReset('Resets 2026-09-22T00:00:00Z', options), { resetAt: null, resetApproximate: false });
  assert.deepEqual(parser.parseReset('Resets 2026-09-21T00:00:00Z or 2026-09-22T00:00:00Z', { now: options.now }), { resetAt: null, resetApproximate: false });
  assert.deepEqual(parser.parseReset('Today 2026-09-22T00:00:00Z', options), { resetAt: null, resetApproximate: false });
  assert.deepEqual(parser.parseReset('Resets at 2:00 PM'), { resetAt: null, resetApproximate: false });
});

test('outdated or unreasonable absolute reset is unknown without replacing valid usage', () => {
  const now = Date.parse('2026-09-20T00:00:00Z');
  for (const text of ['Resets 2026-09-18T00:00:00Z', 'Resets 2027-09-20T00:00:00Z']) assert.deepEqual(parser.parseReset(text, { now }), { resetAt: null, resetApproximate: false });
  assert.deepEqual(parser.parseReset('Resets 2026-09-19T23:59:00Z', { now }), { resetAt: Date.parse('2026-09-19T23:59:00Z'), resetApproximate: false });
});

test('reinjecting parser preserves its document cache rather than moving relative deadlines', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../extension/parser.js'), 'utf8');
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);
  const original = context.OrbPageParser;
  vm.runInContext(source, context);
  assert.equal(context.OrbPageParser, original);
  assert.equal(context.OrbPageParser.parserVersion, 2);
});

test('updated parser replaces an older injected parser before collecting on the new route', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../extension/parser.js'), 'utf8');
  const oldParser = { parserVersion: 1, allowedLocation: () => false };
  const context = vm.createContext({ URL, OrbPageParser: oldParser });
  vm.runInContext(source, context);
  assert.notEqual(context.OrbPageParser, oldParser);
  assert.equal(context.OrbPageParser.parserVersion, 2);
  assert.equal(context.OrbPageParser.allowedLocation('https://chatgpt.com/settings/usage?tab=overview'), true);
  const updated = context.OrbPageParser;
  vm.runInContext(source, context);
  assert.equal(context.OrbPageParser, updated);
});

test('valid page with no main metric area returns explicit unknowns without scanning page text', () => {
  const document = { querySelector(selector) { assert.equal(selector, 'main,[role="main"]'); return null; }, get body() { throw new Error('full page access is forbidden'); } };
  const snapshot = parser.collect(document, 'https://chatgpt.com/settings/usage?tab=overview');
  assert.deepEqual(snapshot.windows, []);
  assert.deepEqual(snapshot.tokens, { total: null, today: null });
  assert.deepEqual(Object.keys(snapshot).sort(), ['capturedAt', 'source', 'tokens', 'version', 'windows']);
});
