import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * DOKU Jokul signature helpers.
 *
 * DOKU Jokul signs every request with **HMAC-SHA256** over a *component string*
 * and sends three headers instead of a single `X-SIGNATURE`:
 *
 *   1. `Client-Id`  → your DOKU client id
 *   2. `Request-Id` → a unique UUID per request (anti-replay)
 *   3. `Request-Timestamp` → RFC3339 UTC time, e.g. 2026-01-01T00:00:00Z
 *   4. `Signature`  → "HMACSHA256=" + base64(HMAC-SHA256(componentString, secretKey))
 *
 * The component string is assembled from the request *digest* plus selected
 * headers, in this exact order (non-empty parts joined by `\n`):
 *
 *   Client-Id:<clientId>
 *   Request-Id:<requestId>
 *   Request-Timestamp:<timestamp>
 *   Request-Target:<path>            (path only, no query string)
 *   Digest:<base64(sha256(minifiedBody))>   (only for requests WITH a body)
 *
 * For requests WITHOUT a body (e.g. GET), the `Digest:` line is omitted.
 *
 * Webhook / notification validation uses a *similar* scheme but the component
 * string is built from the notification headers and the **raw** request body:
 *
 *   Client-Id:<clientId>
 *   Request-Id:<requestId>
 *   Request-Timestamp:<timestamp>
 *   Request-Target:<path>
 *   Digest:<base64(sha256(rawBody))>
 */

/** Load a PEM key from a filesystem path (relative paths resolve from cwd). */
export function loadKey(pemPath) {
  if (!pemPath) return null;
  const abs = path.isAbsolute(pemPath) ? pemPath : path.resolve(process.cwd(), pemPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

/** Minify a JSON body (no insignificant whitespace). */
export function minifyBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

/** Base64 SHA-256 digest of the (minified) request body. */
export function bodyDigest(body) {
  const minified = minifyBody(body);
  return crypto.createHash('sha256').update(minified, 'utf8').digest('base64');
}

/** Lowercase hex SHA-256 (kept for parity/debugging). */
export function hashBody(body) {
  return crypto.createHash('sha256').update(minifyBody(body), 'utf8').digest('hex').toLowerCase();
}

/**
 * Request-Timestamp in RFC3339 UTC, e.g. `2026-01-01T00:00:00Z`.
 * DOKU accepts RFC3339; the spec examples use a trailing `Z` (UTC).
 */
export function requestTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the DOKU Jokul signature component string for an API request.
 * @param {{clientId:string, requestId:string, timestamp:string, target:string, body?:any, includeDigest?:boolean}} p
 */
export function buildComponentString({
  clientId,
  requestId,
  timestamp,
  target,
  body,
  includeDigest,
}) {
  const parts = [
    `Client-Id:${clientId}`,
    `Request-Id:${requestId}`,
    `Request-Timestamp:${timestamp}`,
    `Request-Target:${target}`,
  ];
  // Digest is included only when there is a body to hash.
  const withDigest = includeDigest ?? minifyBody(body).length > 0;
  if (withDigest) parts.push(`Digest:${bodyDigest(body)}`);
  return parts.join('\n');
}

/**
 * Sign a component string with HMAC-SHA256.
 * Returns the value for the `Signature` header: `HMACSHA256=<base64>`.
 */
export function signHmacSha256(componentString, secretKey) {
  const raw = crypto.createHmac('sha256', secretKey).update(componentString, 'utf8').digest('base64');
  return `HMACSHA256=${raw}`;
}

/** Constant-time comparison of two signatures. */
export function safeEqual(a = '', b = '') {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify an inbound DOKU notification signature.
 * @returns {{ valid:boolean, expected:string, componentString:string }}
 */
export function verifyNotificationSignature({ headers, rawBody, secretKey }) {
  const clientId = headers['client-id'];
  const requestId = headers['request-id'];
  const timestamp = headers['request-timestamp'];
  const received = headers['signature'];
  const target = headers['request-target'] || headers['request-uri'] || '';

  const componentString = buildComponentString({
    clientId,
    requestId,
    timestamp,
    target,
    body: rawBody,
    includeDigest: true,
  });
  const expected = signHmacSha256(componentString, secretKey);
  return { valid: safeEqual(received, expected), expected, componentString };
}

/** Generate an RSA-2048 key pair in PEM (kept for parity with merchant key setup). */
export function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/** Verify an RSA-SHA256 signature (used for asymmetric-key integrations). */
export function verifyRsaSha256(message, signatureB64, publicKeyPem) {
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(message, 'utf8');
    verifier.end();
    return verifier.verify(publicKeyPem, signatureB64, 'base64');
  } catch {
    return false;
  }
}
