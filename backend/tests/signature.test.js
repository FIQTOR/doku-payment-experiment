import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  bodyDigest,
  buildComponentString,
  buildSnapRequestHeaders,
  buildSnapSignature,
  buildSnapTokenHeaders,
  buildSnapTokenStringToSign,
  generateKeyPair,
  hashBody,
  minifyBody,
  requestTimestamp,
  safeEqual,
  signHmacSha256,
  snapBodyHash,
  snapTimestamp,
  verifyNotificationSignature,
  verifyRsaSha256,
  verifySnapNotificationSignature,
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

describe('SNAP signature utils', () => {
  it('builds the Get-Token stringToSign as clientId|timestamp', () => {
    expect(buildSnapTokenStringToSign('CID', '2026-01-01T00:00:00+07:00')).toBe(
      'CID|2026-01-01T00:00:00+07:00',
    );
  });

  it('signs the Get-Token with SHA256withRSA and verifies it', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const ts = '2026-01-01T00:00:00+07:00';
    const { headers, stringToSign } = buildSnapTokenHeaders({
      clientId: 'CID',
      timestamp: ts,
      privateKeyPem: privateKey,
    });
    expect(headers['X-CLIENT-KEY']).toBe('CID');
    expect(headers['X-TIMESTAMP']).toBe(ts);
    expect(verifyRsaSha256(stringToSign, headers['X-SIGNATURE'], publicKey)).toBe(true);
  });

  it('builds the SNAP transactional stringToSign in the correct order', () => {
    const { stringToSign, signature } = buildSnapSignature({
      method: 'post',
      endpointUrl: '/snap-adapter/b2b/v1.0/qr/qr-mpm-generate',
      accessToken: 'TOKEN',
      body: { a: 1 },
      timestamp: '2026-01-01T00:00:00+07:00',
      secretKey: 'secret',
    });
    expect(stringToSign).toBe(
      `POST:/snap-adapter/b2b/v1.0/qr/qr-mpm-generate:TOKEN:${snapBodyHash({ a: 1 })}:2026-01-01T00:00:00+07:00`,
    );
    const expected = crypto
      .createHmac('sha512', 'secret')
      .update(stringToSign, 'utf8')
      .digest('base64');
    expect(signature).toBe(expected);
  });

  it('builds SNAP transactional headers with the required SNAP headers', () => {
    const { headers } = buildSnapRequestHeaders({
      method: 'POST',
      endpointUrl: '/snap-adapter/b2b/v1.0/qr/qr-mpm-generate',
      accessToken: 'TOKEN',
      body: { a: 1 },
      timestamp: '2026-01-01T00:00:00+07:00',
      clientId: 'PARTNER',
      externalId: 'EXT-1',
      secretKey: 'secret',
    });
    expect(headers['X-PARTNER-ID']).toBe('PARTNER');
    expect(headers['X-EXTERNAL-ID']).toBe('EXT-1');
    expect(headers['X-SIGNATURE']).toBeTruthy();
    expect(headers.Authorization).toBe('Bearer TOKEN');
  });

  it('verifies a SNAP notification (HMAC-SHA512, no Digest in stringToSign)', () => {
    const secretKey = 'topsecret';
    const rawBody = JSON.stringify({ originalPartnerReferenceNo: 'INV-1' });
    const timestamp = '2026-01-01T00:00:00+07:00';
    const stringToSign = [
      'POST',
      '/api/webhooks/doku-snap',
      '',
      snapBodyHash(rawBody),
      timestamp,
    ].join(':');
    const signature = crypto
      .createHmac('sha512', secretKey)
      .update(stringToSign, 'utf8')
      .digest('base64');
    const headers = {
      'x-partner-id': 'CID',
      'x-external-id': 'EXT-1',
      'x-timestamp': timestamp,
      'x-signature': signature,
      'request-target': '/api/webhooks/doku-snap',
    };
    const { valid } = verifySnapNotificationSignature({ headers, method: 'POST', rawBody, secretKey });
    expect(valid).toBe(true);

    const bad = verifySnapNotificationSignature({
      headers: { ...headers, 'x-signature': 'nope' },
      method: 'POST',
      rawBody,
      secretKey,
    });
    expect(bad.valid).toBe(false);
  });

  it('formats SNAP timestamps with a +07:00 offset', () => {
    expect(snapTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
  });
});
