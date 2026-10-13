import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * DOKU Jokul signature helpers.
 *
 * DOKU exposes **two** signature schemes:
 *
 * ── A) Non-SNAP (Jokul classic) ──────────────────────────────────────────────
 * Signs every request with **HMAC-SHA256** over a *component string*. Headers:
 *   `Client-Id`, `Request-Id`, `Request-Timestamp`, `Signature: HMACSHA256=…`
 *
 *   Client-Id:<clientId>
 *   Request-Id:<requestId>
 *   Request-Timestamp:<timestamp>
 *   Request-Target:<path>                     (path only, no query string)
 *   Digest:<base64(sha256(minifiedBody))>     (only when there is a body)
 *
 * ── B) SNAP (Bank Indonesia standard) ────────────────────────────────────────
 * Two sub-flavours:
 *   • Get Token API  → **Asymmetric** (SHA256withRSA):
 *       stringToSign = clientId + "|" + X-TIMESTAMP
 *     Headers: `X-CLIENT-KEY`, `X-TIMESTAMP`, `X-SIGNATURE`.
 *   • Transactional APIs & notifications → **Symmetric** (HMAC-SHA512):
 *       stringToSign = HTTPMethod + ":" + EndpointUrl + ":" + AccessToken
 *                      + ":" + Lowercase(HexEncode(SHA256(minify(RequestBody))))
 *                      + ":" + Timestamp
 *     Headers: `X-PARTNER-ID`, `X-EXTERNAL-ID`, `X-TIMESTAMP`, `X-SIGNATURE`,
 *              `Authorization: Bearer <token>`, `CHANNEL-ID`.
 *
 *   For the B2B2C / e-wallet notification flavour the stringToSign matches the
 *   SNAP notification spec:
 *       HTTP-METHOD:RELATIVE-URL:ACCESS-TOKEN:HEX(SHA256(requestBody)):TIMESTAMP
 *
 * The non-SNAP webhook / notification validation reuses the component string
 * built from the notification headers and the **raw** request body.
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

/** Sign a message with RSA-SHA256 using a merchant private key (base64 output). */
export function signRsaSha256(message, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

/** Timestamp in SNAP format (ISO-8601 with +07:00 Asia/Jakarta offset). */
export function snapTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const utc = date.getTime() + date.getTimezoneOffset() * 60_000;
  const jakarta = new Date(utc + 7 * 60 * 60_000);
  return (
    `${jakarta.getFullYear()}-${pad(jakarta.getMonth() + 1)}-${pad(jakarta.getDate())}` +
    `T${pad(jakarta.getHours())}:${pad(jakarta.getMinutes())}:${pad(jakarta.getSeconds())}+07:00`
  );
}

// ── SNAP: Get Token (Asymmetric / SHA256withRSA) ──────────────────────────────

/** SNAP Get-Token stringToSign: `clientId + "|" + X-TIMESTAMP`. */
export function buildSnapTokenStringToSign(clientId, timestamp) {
  return `${clientId}|${timestamp}`;
}

/**
 * Build the SNAP access-token request headers.
 * Signature = SHA256withRSA(privateKey, clientId + "|" + timestamp).
 */
export function buildSnapTokenHeaders({ clientId, timestamp, privateKeyPem }) {
  const stringToSign = buildSnapTokenStringToSign(clientId, timestamp);
  const signature = privateKeyPem ? signRsaSha256(stringToSign, privateKeyPem) : 'MOCK_SIGNATURE';
  return {
    headers: {
      'X-CLIENT-KEY': clientId,
      'X-TIMESTAMP': timestamp,
      'X-SIGNATURE': signature,
      'Content-Type': 'application/json',
    },
    stringToSign,
    signature,
  };
}

// ── SNAP: Transactional APIs (Symmetric / HMAC-SHA512) ────────────────────────

/** Lowercase hex SHA-256 of the minified body (SNAP variant). */
export function snapBodyHash(body) {
  return crypto.createHash('sha256').update(minifyBody(body), 'utf8').digest('hex').toLowerCase();
}

/** Build the SNAP transactional signature (HMAC-SHA512 over stringToSign). */
export function buildSnapSignature({
  method,
  endpointUrl,
  accessToken = '',
  body,
  timestamp,
  secretKey,
}) {
  const stringToSign = [
    method.toUpperCase(),
    endpointUrl,
    accessToken,
    snapBodyHash(body),
    timestamp,
  ].join(':');
  const signature = crypto
    .createHmac('sha512', secretKey)
    .update(stringToSign, 'utf8')
    .digest('base64');
  return { stringToSign, signature };
}

/**
 * Build the SNAP headers for a transactional request.
 * @returns {{ headers:object, dataString:string, stringToSign:string }}
 */
export function buildSnapRequestHeaders({
  method,
  endpointUrl,
  accessToken,
  body,
  timestamp,
  clientId,
  externalId,
  channelId = 'H2H',
  secretKey,
}) {
  const dataString = minifyBody(body);
  const { stringToSign, signature } = buildSnapSignature({
    method,
    endpointUrl,
    accessToken,
    body: dataString,
    timestamp,
    secretKey,
  });
  const headers = {
    'X-PARTNER-ID': clientId,
    'X-EXTERNAL-ID': externalId,
    'X-TIMESTAMP': timestamp,
    'X-SIGNATURE': signature,
    'CHANNEL-ID': channelId,
    'Content-Type': 'application/json',
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return { headers, dataString, stringToSign };
}

/**
 * Verify an inbound SNAP notification (HMAC-SHA512).
 * stringToSign = METHOD:REQUEST-TARGET:ACCESS-TOKEN:HEX(SHA256(rawBody)):X-TIMESTAMP
 * @returns {{ valid:boolean, expected:string, stringToSign:string }}
 */
export function verifySnapNotificationSignature({ headers, method = 'POST', rawBody, secretKey }) {
  const target =
    headers['request-target'] ||
    headers['x-request-target'] ||
    headers['x-original-url'] ||
    '';
  const timestamp = headers['x-timestamp'];
  const accessToken = String(headers.authorization || '').replace(/^Bearer\s+/i, '');
  const received = headers['x-signature'];

  const stringToSign = [
    method.toUpperCase(),
    target,
    accessToken,
    snapBodyHash(rawBody),
    timestamp,
  ].join(':');
  const expected = crypto
    .createHmac('sha512', secretKey)
    .update(stringToSign, 'utf8')
    .digest('base64');
  return { valid: safeEqual(received, expected), expected, stringToSign };
}
