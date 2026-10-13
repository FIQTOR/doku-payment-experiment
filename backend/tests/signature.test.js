import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  bodyDigest,
  buildComponentString,
  generateKeyPair,
  hashBody,
  minifyBody,
  requestTimestamp,
  safeEqual,
  signHmacSha256,
  verifyNotificationSignature,
} from '../src/utils/signature.js';

describe('signature utils (DOKU Jokul HMAC-SHA256)', () => {
  it('minifies JSON bodies without insignificant whitespace', () => {
    expect(minifyBody({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(minifyBody('plain')).toBe('plain');
    expect(minifyBody(null)).toBe('');
  });

  it('produces a base64 sha256 body digest', () => {
    const expected = crypto.createHash('sha256').update('{"a":1}').digest('base64');
    expect(bodyDigest({ a: 1 })).toBe(expected);
    expect(hashBody({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds the component string with a Digest line when a body exists', () => {
    const cs = buildComponentString({
      clientId: 'CID',
      requestId: 'RID',
      timestamp: '2026-01-01T00:00:00Z',
      target: '/checkout/v1/payment',
      body: { a: 1 },
    });
    const lines = cs.split('\n');
    expect(lines[0]).toBe('Client-Id:CID');
    expect(lines[1]).toBe('Request-Id:RID');
    expect(lines[2]).toBe('Request-Timestamp:2026-01-01T00:00:00Z');
    expect(lines[3]).toBe('Request-Target:/checkout/v1/payment');
    expect(lines[4]).toBe(`Digest:${bodyDigest({ a: 1 })}`);
  });

  it('omits the Digest line for bodyless requests', () => {
    const cs = buildComponentString({
      clientId: 'CID',
      requestId: 'RID',
      timestamp: 'TS',
      target: '/orders/v1/status',
      includeDigest: false,
    });
    expect(cs).not.toContain('Digest:');
    expect(cs.split('\n')).toHaveLength(4);
  });

  it('produces the HMACSHA256= base64 signature header', () => {
    const sig = signHmacSha256('a:b', 'secret');
    const expected = crypto.createHmac('sha256', 'secret').update('a:b').digest('base64');
    expect(sig).toBe(`HMACSHA256=${expected}`);
  });

  it('compares signatures in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('formats Request-Timestamp as RFC3339 UTC', () => {
    expect(requestTimestamp(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00Z');
  });

  it('verifies an inbound notification signature', () => {
    const secretKey = 'topsecret';
    const rawBody = JSON.stringify({ order: { invoice_number: 'INV-1' } });
    const headers = {
      'client-id': 'CID',
      'request-id': 'RID',
      'request-timestamp': '2026-01-01T00:00:00Z',
      'request-target': '/api/webhooks/doku',
    };
    const componentString = buildComponentString({
      clientId: 'CID',
      requestId: 'RID',
      timestamp: '2026-01-01T00:00:00Z',
      target: '/api/webhooks/doku',
      body: rawBody,
    });
    headers.signature = signHmacSha256(componentString, secretKey);

    const { valid } = verifyNotificationSignature({ headers, rawBody, secretKey });
    expect(valid).toBe(true);

    const tampered = verifyNotificationSignature({
      headers: { ...headers, signature: 'HMACSHA256=nope' },
      rawBody,
      secretKey,
    });
    expect(tampered.valid).toBe(false);
  });

  it('generates a valid RSA keypair (parity helper)', () => {
    const { privateKey, publicKey } = generateKeyPair();
    expect(privateKey).toContain('PRIVATE KEY');
    expect(publicKey).toContain('PUBLIC KEY');
  });
});
