'use strict';

// This process has no account credentials. Its only network surface accepts
// a small, numeric snapshot from the paired extension on IPv4 loopback.
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const identity = require('../extension-identity.json');

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REQUESTS_PER_MINUTE = 120;
const REQUEST_TIMEOUT_MS = 5_000;
const DAY_MS = 86_400_000;
const ORIGIN = `chrome-extension://${identity.id}`;

function exactObject(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((key) => Object.hasOwn(value, key));
}

function nullableCounter(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validateSnapshot(value, now = Date.now()) {
  if (!exactObject(value, ['version', 'source', 'capturedAt', 'windows', 'tokens'])
      || value.version !== 1
      || !['official-page', 'manual-page'].includes(value.source)
      || !Number.isSafeInteger(value.capturedAt)
      || value.capturedAt < now - 10 * 60_000 || value.capturedAt > now + 60_000
      || !Array.isArray(value.windows) || value.windows.length > 3
      || !exactObject(value.tokens, ['total', 'today'])
      || !nullableCounter(value.tokens.total) || !nullableCounter(value.tokens.today)) {
    return null;
  }

  const kinds = new Set();
  const windows = [];
  for (const window of value.windows) {
    if (!exactObject(window, ['kind', 'usedPercent', 'resetAt', 'resetApproximate'])
        || !['session', 'weekly', 'other'].includes(window.kind) || kinds.has(window.kind)
        || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)
        || window.usedPercent < 0 || window.usedPercent > 100
        || typeof window.resetApproximate !== 'boolean'
        || !(window.resetAt === null || (Number.isSafeInteger(window.resetAt)
          && window.resetAt >= now - DAY_MS && window.resetAt <= now + 60 * DAY_MS))) {
      return null;
    }
    kinds.add(window.kind);
    windows.push(Object.freeze({
      kind: window.kind,
      usedPercent: window.usedPercent,
      resetAt: window.resetAt,
      resetApproximate: window.resetApproximate,
    }));
  }

  // Reconstruct the schema. No unvalidated input object ever crosses into UI state.
  return Object.freeze({
    version: 1,
    source: value.source,
    capturedAt: value.capturedAt,
    windows: Object.freeze(windows),
    tokens: Object.freeze({ total: value.tokens.total, today: value.tokens.today }),
  });
}

function hasSingleHeader(req, name) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count === 1;
}

function reply(res, status, message = '', cors = false) {
  if (res.destroyed || res.writableEnded) return;
  const body = message ? JSON.stringify({ error: message }) : '';
  const headers = {
    'Cache-Control': 'no-store',
    'Connection': 'close',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
  };
  if (cors) headers['Access-Control-Allow-Origin'] = ORIGIN;
  res.writeHead(status, headers);
  res.end(body);
}

class UsageBridge {
  #server = null;
  #port;
  #key = randomBytes(32);
  #generation = 0;
  #lastReceivedAt = null;
  #onSnapshot;
  #onConnection;
  #rateWindow = performance.now();
  #rateCount = 0;

  constructor({ onSnapshot = () => {}, onConnection = () => {}, port = identity.port } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('Invalid local port');
    if (typeof onSnapshot !== 'function' || typeof onConnection !== 'function') {
      throw new TypeError('Callbacks must be functions');
    }
    this.#port = port;
    this.#onSnapshot = onSnapshot;
    this.#onConnection = onConnection;
  }

  getStatus() {
    return Object.freeze({
      listening: this.#server?.listening === true,
      connected: this.#lastReceivedAt !== null,
      lastReceivedAt: this.#lastReceivedAt,
      port: this.#port,
    });
  }

  getPairingCode() {
    if (!this.#server?.listening) return null;
    return `GPTORB2.${this.#port}.${this.#key.toString('base64url')}`;
  }

  #notify() {
    try { this.#onConnection(this.getStatus()); } catch { /* Callbacks cannot expose input. */ }
  }

  rotateKey() {
    this.#key.fill(0);
    this.#key = randomBytes(32);
    this.#generation += 1;
    this.#lastReceivedAt = null;
    this.#notify();
    return this.getPairingCode();
  }

  async start() {
    if (this.#server?.listening) return this.getStatus();
    if (this.#server) throw new Error('Local bridge is already starting');
    const server = http.createServer({
      maxHeaderSize: 4_096,
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: REQUEST_TIMEOUT_MS,
      keepAliveTimeout: 1_000,
      connectionsCheckingInterval: 1_000,
      insecureHTTPParser: false,
    }, (req, res) => this.#handle(req, res));
    server.maxConnections = 16;
    server.maxHeadersCount = 24;
    server.maxRequestsPerSocket = 1;
    server.on('checkContinue', (_req, res) => reply(res, 417, 'unsupported_request'));
    server.on('checkExpectation', (_req, res) => reply(res, 417, 'unsupported_request'));
    server.on('upgrade', (_req, socket) => socket.destroy());
    server.on('connect', (_req, socket) => socket.destroy());
    server.on('clientError', (_error, socket) => {
      if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    this.#server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: this.#port, exclusive: true }, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.#server = null;
      throw new Error('Cannot start local usage bridge', { cause: error });
    }
    this.#port = server.address().port;
    // An unexpected server failure disables synchronization; it never changes
    // the bind address or opens another network interface as a fallback.
    server.on('error', () => { void this.close(); });
    this.#notify();
    return this.getStatus();
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    this.#key.fill(0);
    this.#key = randomBytes(32);
    this.#generation += 1;
    this.#lastReceivedAt = null;
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    this.#notify();
  }

  #allowRate() {
    const now = performance.now();
    if (now - this.#rateWindow >= 60_000) {
      this.#rateWindow = now;
      this.#rateCount = 0;
    }
    this.#rateCount += 1;
    return this.#rateCount <= MAX_REQUESTS_PER_MINUTE;
  }

  #handle(req, res) {
    req.on('error', () => { if (!res.writableEnded) res.destroy(); });
    res.on('error', () => { /* Transport failures are not logged with headers. */ });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => reply(res, 408, 'request_timeout'));

    const validOrigin = hasSingleHeader(req, 'origin') && req.headers.origin === ORIGIN;
    if (req.socket.remoteAddress !== '127.0.0.1'
        || !hasSingleHeader(req, 'host') || req.headers.host !== `127.0.0.1:${this.#port}`
        || !validOrigin) {
      reply(res, 403, 'forbidden');
      return;
    }
    if (!this.#allowRate()) {
      reply(res, 429, 'rate_limited', true);
      return;
    }
    if (req.url !== '/v1/usage') {
      reply(res, 404, 'not_found', true);
      return;
    }
    if (req.method === 'OPTIONS') {
      const rawRequestedHeaders = req.headers['access-control-request-headers'];
      const requestedHeaders = typeof rawRequestedHeaders === 'string'
        ? rawRequestedHeaders.split(',').map((header) => header.trim().toLowerCase()) : [];
      const privateNetwork = req.headers['access-control-request-private-network'];
      if (!hasSingleHeader(req, 'access-control-request-method')
          || req.headers['access-control-request-method'] !== 'POST'
          || !hasSingleHeader(req, 'access-control-request-headers')
          || requestedHeaders.length !== 2
          || new Set(requestedHeaders).size !== 2
          || !requestedHeaders.includes('content-type') || !requestedHeaders.includes('x-orb-key')
          || (privateNetwork !== undefined && (privateNetwork !== 'true'
            || !hasSingleHeader(req, 'access-control-request-private-network')))) {
        reply(res, 403, 'forbidden', true);
        return;
      }
      const headers = {
        'Access-Control-Allow-Origin': ORIGIN,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type, x-orb-key',
        'Access-Control-Max-Age': '0',
        'Cache-Control': 'no-store',
        'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        'Connection': 'close',
        'Content-Length': '0',
      };
      if (privateNetwork === 'true') headers['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      reply(res, 405, 'method_not_allowed', true);
      return;
    }
    const suppliedKey = req.headers['x-orb-key'];
    // Canonical encoding rejects alternative spellings before constant-time
    // comparison. The secret is never included in URLs, logs, or responses.
    if (!hasSingleHeader(req, 'x-orb-key') || typeof suppliedKey !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(suppliedKey)) {
      reply(res, 401, 'unauthorized', true);
      return;
    }
    const suppliedBytes = Buffer.from(suppliedKey, 'base64url');
    if (suppliedBytes.length !== 32 || suppliedBytes.toString('base64url') !== suppliedKey
        || !timingSafeEqual(suppliedBytes, this.#key)) {
      suppliedBytes.fill(0);
      reply(res, 401, 'unauthorized', true);
      return;
    }
    suppliedBytes.fill(0);
    if (!hasSingleHeader(req, 'content-type')
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])
        || req.headers['content-encoding'] !== undefined) {
      reply(res, 415, 'unsupported_content_type', true);
      return;
    }
    const contentLength = req.headers['content-length'];
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
      reply(res, 413, 'payload_too_large', true);
      return;
    }
    const generation = this.#generation;
    let size = 0;
    let chunks = [];
    req.on('data', (chunk) => {
      if (res.writableEnded) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks = [];
        reply(res, 413, 'payload_too_large', true);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded || res.destroyed) return;
      if (!this.#server?.listening || generation !== this.#generation) {
        reply(res, 401, 'unauthorized', true);
        return;
      }
      let snapshot;
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        snapshot = validateSnapshot(JSON.parse(decoder.decode(Buffer.concat(chunks, size))));
      } catch { snapshot = null; }
      chunks = [];
      if (!snapshot) {
        reply(res, 400, 'invalid_snapshot', true);
        return;
      }
      try {
        const result = this.#onSnapshot(snapshot);
        // State callbacks must complete synchronously. A rejected Promise is
        // consumed and cannot create an unhandled rejection in the main app.
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          reply(res, 503, 'snapshot_unavailable', true);
          return;
        }
      } catch {
        reply(res, 503, 'snapshot_unavailable', true);
        return;
      }
      this.#lastReceivedAt = Date.now();
      this.#notify();
      reply(res, 204, '', true);
    });
  }
}

module.exports = { UsageBridge, validateSnapshot };
