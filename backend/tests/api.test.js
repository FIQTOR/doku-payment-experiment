import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import app from '../src/server.js';
import * as store from '../src/store/transactions.js';
import { bodyDigest, signHmacSha256 } from '../src/utils/signature.js';

/** Helper: create a payment and return its response. */
async function createPayment(body = { amount: 25000, description: 'test' }) {
  return request(app).post('/api/payments').send(body);
}

/**
 * Helper: build the DOKU notification signature headers for a payload, so the
 * webhook signature enforcement path is exercised realistically.
 */
function signedWebhook(payload, target = '/api/webhooks/doku') {
  const rawBody = JSON.stringify(payload);
  const clientId = 'TEST-CLIENT-ID';
  const requestId = crypto.randomUUID();
  const timestamp = '2026-01-01T00:00:00Z';
  const componentString = [
    `Client-Id:${clientId}`,
    `Request-Id:${requestId}`,
    `Request-Timestamp:${timestamp}`,
    `Request-Target:${target}`,
    `Digest:${bodyDigest(rawBody)}`,
  ].join('\n');
  const signature = signHmacSha256(componentString, 'test_secret_key');
  return { rawBody, headers: {
    'Content-Type': 'application/json',
    'Client-Id': clientId,
    'Request-Id': requestId,
    'Request-Timestamp': timestamp,
    'Request-Target': target,
    Signature: signature,
  } };
}

describe('API integration (mock mode)', () => {
  beforeEach(async () => {
    await store._reset();
  });

  it('GET / returns the service descriptor', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.name).toMatch(/DOKU/);
    expect(res.body.mode).toBe('mock');
  });

  it('GET /api/webhooks/config reports setup status', async () => {
    const res = await request(app).get('/api/webhooks/config');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('mockMode', true);
    expect(res.body.data).toHaveProperty('storage');
    expect(res.body.data.notificationUrl).toContain('/api/webhooks/doku');
  });

  describe('POST /api/payments', () => {
    it('creates a PENDING QRIS payment with a QR image', async () => {
      const res = await createPayment();
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.qrContent).toBeTruthy();
      expect(res.body.data.qrImage).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(res.body.data.invoiceNumber).toMatch(/^INV-/);
    });

    it('creates a Checkout payment with a hosted URL', async () => {
      const res = await createPayment({ amount: 15000, method: 'checkout' });
      expect(res.status).toBe(201);
      expect(res.body.data.checkoutUrl).toBeTruthy();
      expect(res.body.data.qrImage).toBeUndefined();
    });

    it('rejects invalid amounts with 400', async () => {
      const res = await request(app).post('/api/payments').send({ amount: -10 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('rejects a missing amount with 400', async () => {
      const res = await request(app).post('/api/payments').send({ description: 'x' });
      expect(res.status).toBe(400);
    });
  });

  describe('transaction retrieval', () => {
    it('GET /api/payments lists transactions', async () => {
      await createPayment();
      const res = await request(app).get('/api/payments');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('GET /api/payments/:ref returns one transaction', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      const res = await request(app).get(`/api/payments/${ref}`);
      expect(res.status).toBe(200);
      expect(res.body.data.invoiceNumber).toBe(ref);
    });

    it('GET /api/payments/:ref returns 404 for unknown refs', async () => {
      const res = await request(app).get('/api/payments/NOPE');
      expect(res.status).toBe(404);
    });

    it('GET /api/payments/:ref/qr.svg returns an SVG image', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      const res = await request(app).get(`/api/payments/${ref}/qr.svg`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
      const svg = res.text || res.body?.toString('utf8') || '';
      expect(svg).toContain('<svg');
    });

    it('guards against a non-numeric limit', async () => {
      await createPayment();
      const res = await request(app).get('/api/payments?limit=abc');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('state transitions', () => {
    it('simulates a SUCCESS payment', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      const res = await request(app)
        .post(`/api/payments/${ref}/simulate`)
        .send({ status: 'SUCCESS', payerName: 'Budi' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('SUCCESS');
      expect(res.body.data.payer.name).toBe('Budi');
    });

    it('rejects an invalid simulate status', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      const res = await request(app).post(`/api/payments/${ref}/simulate`).send({ status: 'WAT' });
      expect(res.status).toBe(400);
    });

    it('cancels a PENDING payment', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      const res = await request(app).post(`/api/payments/${ref}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');
    });

    it('refuses to cancel a non-PENDING payment (409)', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      await request(app).post(`/api/payments/${ref}/simulate`).send({ status: 'SUCCESS' });
      const res = await request(app).post(`/api/payments/${ref}/cancel`);
      expect(res.status).toBe(409);
    });

    it('refunds a SUCCESS payment', async () => {
      const created = await createPayment({ amount: 25000 });
      const ref = created.body.data.invoiceNumber;
      await request(app).post(`/api/payments/${ref}/simulate`).send({ status: 'SUCCESS' });
      const res = await request(app).post(`/api/payments/${ref}/refund`).send({ reason: 'test' });
      expect(res.status).toBe(200);
      expect(res.body.data.transaction.status).toBe('REFUNDED');
      expect(res.body.data.refund.refundReferenceNo).toMatch(/^RFD-/);
    });

    it('refuses to refund a non-SUCCESS payment (409)', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      const res = await request(app).post(`/api/payments/${ref}/refund`).send({});
      expect(res.status).toBe(409);
    });

    it('refuses to refund more than the original amount (400)', async () => {
      const created = await createPayment({ amount: 10000 });
      const ref = created.body.data.invoiceNumber;
      await request(app).post(`/api/payments/${ref}/simulate`).send({ status: 'SUCCESS' });
      const res = await request(app).post(`/api/payments/${ref}/refund`).send({ amount: 99999 });
      expect(res.status).toBe(400);
    });

    it('supports partial refunds and tracks the refundable balance', async () => {
      const created = await createPayment({ amount: 25000 });
      const ref = created.body.data.invoiceNumber;
      await request(app).post(`/api/payments/${ref}/simulate`).send({ status: 'SUCCESS' });

      const r1 = await request(app).post(`/api/payments/${ref}/refund`).send({ amount: 10000 });
      expect(r1.status).toBe(200);
      expect(r1.body.data.transaction.status).toBe('SUCCESS');
      expect(r1.body.data.transaction.refundedAmount).toBe(10000);
      expect(r1.body.data.refund.refundableRemaining).toBe(15000);

      const r2 = await request(app).post(`/api/payments/${ref}/refund`).send({ amount: 15000 });
      expect(r2.status).toBe(200);
      expect(r2.body.data.transaction.status).toBe('REFUNDED');
      expect(r2.body.data.refund.fullyRefunded).toBe(true);

      const r3 = await request(app).post(`/api/payments/${ref}/refund`).send({ amount: 1 });
      expect(r3.status).toBe(409);
    });
  });

  describe('stats', () => {
    it('GET /api/payments/stats aggregates data', async () => {
      const created = await createPayment({ amount: 15000 });
      const ref = created.body.data.invoiceNumber;
      await request(app).post(`/api/payments/${ref}/simulate`).send({ status: 'SUCCESS' });
      const res = await request(app).get('/api/payments/stats');
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.successValue).toBe(15000);
    });
  });

  describe('disbursements', () => {
    it('POST /api/disbursements/inquiry returns an account name', async () => {
      const res = await request(app)
        .post('/api/disbursements/inquiry')
        .send({ bankCode: 'BCA', bankAccountNo: '1234567890' });
      expect(res.status).toBe(200);
      expect(res.body.data.accountName).toBeTruthy();
    });

    it('POST /api/disbursements creates a transfer', async () => {
      const res = await request(app).post('/api/disbursements').send({
        bankCode: 'BCA',
        bankAccountNo: '1234567890',
        beneficiaryName: 'Budi',
        amount: 50000,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.partnerReferenceNo).toMatch(/^DSB-/);
    });

    it('validates the disbursement payload', async () => {
      const res = await request(app).post('/api/disbursements').send({ bankCode: 'B' });
      expect(res.status).toBe(400);
    });
  });

  describe('webhooks', () => {
    it('rejects an unsigned notification with 401', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      const res = await request(app)
        .post('/api/webhooks/doku')
        .send({ order: { invoice_number: ref, status: 'SUCCESS' } });
      expect(res.status).toBe(401);

      // The transaction must be untouched.
      const txn = await request(app).get(`/api/payments/${ref}`);
      expect(txn.body.data.status).toBe('PENDING');
    });

    it('acknowledges a signed DOKU notification and applies the status', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      const payload = {
        order: { invoice_number: ref, amount: 25000, status: 'SUCCESS' },
        transaction: { status: 'SUCCESS' },
      };
      const { rawBody, headers } = signedWebhook(payload);
      const res = await request(app).post('/api/webhooks/doku').set(headers).send(rawBody);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('SUCCESS');

      const txn = await request(app).get(`/api/payments/${ref}`);
      expect(txn.body.data.status).toBe('SUCCESS');
    });

    it('acknowledges a signed disbursement notification', async () => {
      const payload = { partnerReferenceNo: 'DSB-1', status: 'SUCCESS' };
      const { rawBody, headers } = signedWebhook(payload, '/api/webhooks/disburse');
      const res = await request(app).post('/api/webhooks/disburse').set(headers).send(rawBody);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('SUCCESS');
    });

    it('prefers order.status over transaction.status', async () => {
      const created = await createPayment();
      const ref = created.body.data.invoiceNumber;
      const payload = {
        order: { invoice_number: ref, status: 'SUCCESS' },
        transaction: { status: 'EXPIRED' },
      };
      const { rawBody, headers } = signedWebhook(payload);
      await request(app).post('/api/webhooks/doku').set(headers).send(rawBody);
      const txn = await request(app).get(`/api/payments/${ref}`);
      expect(txn.body.data.status).toBe('SUCCESS');
    });
  });
});
