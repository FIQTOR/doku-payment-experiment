import { describe, expect, it } from 'vitest';
import { dokuService, mapDokuStatus } from '../src/services/dokuService.js';

describe('dokuService (mock mode)', () => {
  it('creates a QRIS transaction with a scannable-looking payload', async () => {
    const res = await dokuService.createQrisTransaction({
      invoiceNumber: 'INV-TEST-1',
      amount: 25000,
      description: 'unit test',
      expiryMinutes: 15,
    });
    expect(res.responseCode).toBe('2004700');
    expect(res.qrContent).toBeTruthy();
    expect(res.partnerReferenceNo).toBe('INV-TEST-1');
    expect(res.qrUrl).toContain('INV-TEST-1');
  });

  it('creates a Checkout payment with a hosted URL and token', async () => {
    const res = await dokuService.createCheckoutPayment({
      invoiceNumber: 'INV-TEST-2',
      amount: 15000,
    });
    expect(res.message[0]).toBe('SUCCESS');
    expect(res.response.payment.url).toMatch(/^https:\/\//);
    expect(res.response.payment.token_id).toBeTruthy();
  });

  it('queries and cancels a QRIS transaction', async () => {
    const q = await dokuService.queryQrisTransaction('INV-TEST-3', 'REF-3');
    expect(q.responseCode).toBe('2004700');
    expect(q.latestTransactionStatus).toBe('00');

    const c = await dokuService.cancelQrisTransaction('INV-TEST-3', 'REF-3');
    expect(c.responseMessage).toBe('Successful');
  });

  it('refunds a transaction', async () => {
    const res = await dokuService.refundTransaction({
      partnerRefundNo: 'RFD-1',
      originalInvoiceNumber: 'INV-TEST-4',
      amount: { value: 5000 },
      reason: 'test',
    });
    expect(res.responseCode).toBe('SUCCESS');
    expect(res.refund_no).toBeTruthy();
  });

  it('disburses to a bank and inquires an account', async () => {
    const d = await dokuService.disburseToBank({
      partnerReferenceNo: 'DSB-1',
      bankCode: 'BCA',
      bankAccountNo: '1234567890',
      beneficiaryName: 'Budi',
      amount: { value: 50000 },
    });
    expect(d.responseCode).toBe('2006700');
    expect(d.referenceNo).toBeTruthy();

    const i = await dokuService.inquireBankAccount({ bankCode: 'BCA', bankAccountNo: '1234567890' });
    expect(i.accountName).toBe('BUDI SANTOSO');
  });
});

describe('mapDokuStatus', () => {
  it('maps Checkout-style words', () => {
    expect(mapDokuStatus('SUCCESS')).toBe('SUCCESS');
    expect(mapDokuStatus('FAILED')).toBe('FAILED');
    expect(mapDokuStatus('EXPIRED')).toBe('EXPIRED');
    expect(mapDokuStatus('refunded')).toBe('REFUNDED');
  });

  it('maps SNAP numeric codes (default flavour)', () => {
    expect(mapDokuStatus('00')).toBe('SUCCESS');
    expect(mapDokuStatus('03')).toBe('PENDING');
    expect(mapDokuStatus('04')).toBe('REFUNDED');
    expect(mapDokuStatus('05')).toBe('CANCELLED');
    expect(mapDokuStatus('06')).toBe('FAILED');
  });

  it('maps legacy non-SNAP QRIS numeric codes when flavor=nonsnap', () => {
    expect(mapDokuStatus('00', 'nonsnap')).toBe('SUCCESS');
    expect(mapDokuStatus('01', 'nonsnap')).toBe('FAILED');
    expect(mapDokuStatus('02', 'nonsnap')).toBe('PENDING');
    expect(mapDokuStatus('03', 'nonsnap')).toBe('EXPIRED');
  });

  it('disambiguates the 03/04 collision by flavour', () => {
    expect(mapDokuStatus('03', 'snap')).toBe('PENDING');
    expect(mapDokuStatus('03', 'nonsnap')).toBe('EXPIRED');
    expect(mapDokuStatus('04', 'snap')).toBe('REFUNDED');
  });

  it('maps word statuses the same regardless of flavour', () => {
    expect(mapDokuStatus('VOIDED')).toBe('CANCELLED');
    expect(mapDokuStatus('EXPIRED', 'nonsnap')).toBe('EXPIRED');
  });

  it('returns null for unknown/absent values', () => {
    expect(mapDokuStatus('')).toBeNull();
    expect(mapDokuStatus(null)).toBeNull();
    expect(mapDokuStatus('WAT')).toBeNull();
  });
});

describe('dokuService — SNAP flavour (mock mode)', () => {
  it('creates a SNAP QRIS transaction with terminalId and validityPeriod', async () => {
    const res = await dokuService.createQrisTransaction({
      invoiceNumber: 'INV-SNAP-1',
      amount: 20000,
      flavor: 'snap',
      expiryMinutes: 15,
    });
    expect(res.responseCode).toBe('2004700');
    expect(res.qrContent).toBeTruthy();
    expect(res.partnerReferenceNo).toBe('INV-SNAP-1');
    expect(res.terminalId).toBeTruthy();
    expect(res.additionalInfo.validityPeriod).toBe('PT15M');
  });

  it('queries and cancels a SNAP QRIS transaction', async () => {
    const q = await dokuService.queryQrisTransaction('INV-SNAP-2', 'REF-2', 'snap');
    expect(q.latestTransactionStatus).toBe('00');
    const c = await dokuService.cancelQrisTransaction('INV-SNAP-2', 'REF-2', 'snap');
    expect(c.responseMessage).toBe('Successful');
  });

  it('refunds a SNAP QRIS transaction', async () => {
    const res = await dokuService.refundSnapQrisTransaction({
      partnerRefundNo: 'RFD-SNAP-1',
      originalInvoiceNumber: 'INV-SNAP-3',
      originalReferenceNo: 'REF-3',
      amount: { value: 5000 },
    });
    expect(res.responseCode).toBe('2004900');
    expect(res.refundNo).toBeTruthy();
  });

  it('issues a mock SNAP access token', async () => {
    const tok = await dokuService.getSnapAccessToken();
    expect(tok.accessToken).toMatch(/^mock-snap-token-/);
    expect(tok.tokenType).toBe('Bearer');
  });
});
