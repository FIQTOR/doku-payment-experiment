#!/usr/bin/env node
/**
 * DOKU connection self-test — `npm run doku:ping`
 *
 * Validates your local setup before you blame your integration:
 *   1. Reads configuration and prints a summary
 *   2. Builds a sample Jokul request signature and verifies the HMAC round-trip
 *   3. If not in mock mode: sends a signed request to DOKU and reports whether
 *      the credentials + signature were accepted
 *
 * Exit code 0 = all good, 1 = something needs fixing.
 */
import axios from 'axios';
import crypto from 'node:crypto';
import config from '../config/index.js';
import {
  bodyDigest,
  buildSnapSignature,
  loadKey,
  requestTimestamp,
  signHmacSha256,
} from '../utils/signature.js';

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const info = (m) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

let failures = 0;
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

async function main() {
  console.log('\n\x1b[1mDOKU connection self-test\x1b[0m');

  // ---------------------------------------------------------------- config ---
  section('Configuration');
  info(`base URL       : ${config.doku.baseUrl}`);
  info(`client ID      : ${config.doku.clientId}`);
  info(`merchant ID    : ${config.doku.merchantId}`);
  info(`mode           : ${config.mockMode ? 'MOCK (offline)' : 'LIVE (calls DOKU)'}`);

  if (config.doku.clientId === 'BRN-0000-000000000000000000') {
    warn('DOKU_CLIENT_ID is still the placeholder value');
    if (!config.mockMode) failures++;
  }
  if (!config.doku.secretKey || config.doku.secretKey === 'change_me_secret_key') {
    warn('DOKU_SECRET_KEY is not set (required for live mode)');
    if (!config.mockMode) failures++;
  }

  // ---------------------------------------------------------- signature ---
  section('Signature (HMAC-SHA256)');
  const target = '/checkout/v1/payment';
  const body = { order: { invoice_number: `SELFTEST-${Date.now()}`, amount: 10000 } };
  const requestId = crypto.randomUUID();
  const timestamp = requestTimestamp();
  const dataString = JSON.stringify(body);
  const componentString = [
    `Client-Id:${config.doku.clientId}`,
    `Request-Id:${requestId}`,
    `Request-Timestamp:${timestamp}`,
    `Request-Target:${target}`,
    `Digest:${bodyDigest(dataString)}`,
  ].join('\n');
  const signature = signHmacSha256(componentString, config.doku.secretKey);
  ok(`Built a signature: ${signature.slice(0, 24)}…`);

  const expected = `HMACSHA256=${crypto
    .createHmac('sha256', config.doku.secretKey)
    .update(componentString, 'utf8')
    .digest('base64')}`;
  if (signature === expected) ok('Signature matches the expected HMAC-SHA256 digest');
  else {
    bad('Signature does not match the expected digest');
    failures++;
  }

  // ------------------------------------------------------- SNAP signature ---
  section('SNAP signature (HMAC-SHA512)');
  const snap = buildSnapSignature({
    method: 'POST',
    endpointUrl: '/snap-adapter/b2b/v1.0/qr/qr-mpm-generate',
    accessToken: 'dummy-token',
    body,
    timestamp: '2026-01-01T00:00:00+07:00',
    secretKey: config.doku.secretKey,
  });
  ok(`Built SNAP signature: ${snap.signature.slice(0, 24)}…`);

  const snapPrivateKey = loadKey(config.doku.privateKeyPath);
  if (snapPrivateKey) {
    ok(`SNAP private key loaded (${config.doku.privateKeyPath})`);
    try {
      crypto.createPrivateKey(snapPrivateKey);
      ok('Valid RSA private key for SNAP Get-Token (SHA256withRSA)');
    } catch (e) {
      bad(`SNAP private key is invalid: ${e.message}`);
      failures++;
    }
  } else {
    warn(`SNAP private key not found at ${config.doku.privateKeyPath} (run: npm run gen-key)`);
  }

  // ------------------------------------------------------- live connectivity ---
  if (config.mockMode) {
    section('DOKU connectivity');
    warn('Mock mode is ON — skipping the live request.');
    info('Set DOKU_MOCK_MODE=false to test against the DOKU sandbox.');
  } else {
    section('DOKU connectivity (live request)');
    try {
      const res = await axios.post(`${config.doku.baseUrl}${target}`, dataString, {
        timeout: 15_000,
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': config.doku.clientId,
          'Request-Id': requestId,
          'Request-Timestamp': timestamp,
          Signature: signature,
        },
      });
      ok(`DOKU responded (HTTP ${res.status})`);
      info('Your credentials + HMAC signature are correct. 🎉');
      info(JSON.stringify(res.data).slice(0, 300));
    } catch (e) {
      const status = e.response?.status;
      const data = e.response?.data;
      if (status) {
        bad(`DOKU rejected the request (HTTP ${status})`);
        info(JSON.stringify(data));
        failures++;
      } else {
        bad(`Network error reaching DOKU: ${e.message}`);
        info('Check your internet connection / DOKU_BASE_URL / firewall.');
        failures++;
      }
    }
  }

  // ------------------------------------------------------------------ result ---
  console.log('');
  if (failures === 0) {
    console.log('\x1b[32m\x1b[1mAll checks passed.\x1b[0m\n');
    process.exit(0);
  } else {
    console.log(`\x1b[31m\x1b[1m${failures} check(s) need attention.\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nUnexpected error during self-test:', e);
  process.exit(1);
});
