import axios from 'axios';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import config from '../config/index.js';
import {
  bodyDigest,
  buildSnapRequestHeaders,
  buildSnapTokenHeaders,
  loadKey,
  minifyBody,
  requestTimestamp,
  signHmacSha256,
  snapTimestamp,
} from '../utils/signature.js';

/**
 * DOKU API service.
 *
 * Wraps the DOKU (Jokul) HTTP API in **both** Direct API flavours:
 *
 *   • non-SNAP (Jokul classic): signed with HMAC-SHA256 `Client-Id`/`Request-*`
 *     component headers. QRIS paths under `/qris/v1/...`, Checkout, refund,
 *     disbursement.
 *   • SNAP (Bank Indonesia standard): Get-Token signed asymme trically
 *     (SHA256withRSA) and transactional APIs signed symmetrically (HMAC-SHA512)
 *     with `X-PARTNER-ID`/`X-EXTERNAL-ID`/`X-TIMESTAMP`/`X-SIGNATURE`. QRIS
 *     paths under `/snap-adapter/b2b/v1.0/qr/...`.
 *
 * When config.mockMode is true all calls are simulated locally so you can
 * experiment with the full payment flow without live sandbox credentials.
 */
class DokuService {
  constructor() {
    this.client = axios.create({
      baseURL: config.doku.baseUrl,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });
    this._snapToken = null;
    this._snapTokenExpiry = 0;
  }

  // --------------------------------------------------------------- signing ---

  /**
   * Build the DOKU Jokul headers AND the exact minified body string that was
   * signed. Returning the body string guarantees the bytes we sign are the
   * exact bytes we transmit (avoiding any serializer mismatch).
   */
  buildSignedRequest(method, relPath, body) {
    const requestId = crypto.randomUUID();
    const timestamp = requestTimestamp();
    const dataString = minifyBody(body);

    const componentString = [
      `Client-Id:${config.doku.clientId}`,
      `Request-Id:${requestId}`,
      `Request-Timestamp:${timestamp}`,
      `Request-Target:${relPath}`,
      ...(dataString ? [`Digest:${bodyDigest(dataString)}`] : []),
    ].join('\n');

    const signature = signHmacSha256(componentString, config.doku.secretKey);

    const headers = {
      'Client-Id': config.doku.clientId,
      'Request-Id': requestId,
      'Request-Timestamp': timestamp,
      Signature: signature,
      'Content-Type': 'application/json',
    };

    return { headers, dataString, requestId, componentString };
  }

  // ------------------------------------------------- SNAP: B2B access token ---

  /**
   * Obtain a SNAP B2B access token.
   * Get-Token is signed *asymmetrically* (SHA256withRSA) with the merchant
   * private key: stringToSign = clientId + "|" + X-TIMESTAMP.
   */
  async getSnapAccessToken() {
    if (config.mockMode) {
      return { accessToken: `mock-snap-token-${nanoid(24)}`, expiresIn: 900, tokenType: 'Bearer' };
    }
    const now = Date.now();
    if (this._snapToken && now < this._snapTokenExpiry) {
      return { accessToken: this._snapToken, expiresIn: Math.floor((this._snapTokenExpiry - now) / 1000) };
    }

    const timestamp = snapTimestamp();
    const privateKey = loadKey(config.doku.privateKeyPath);
    const { headers } = buildSnapTokenHeaders({
      clientId: config.doku.clientId,
      timestamp,
      privateKeyPem: privateKey,
    });

    const { data } = await this.client.post(
      '/authorization/v1/access-token/b2b',
      { grantType: 'client_credentials' },
      { headers },
    );

    this._snapToken = data.accessToken;
    this._snapTokenExpiry = now + (data.expiresIn || 900) * 1000 - 60_000;
    return data;
  }

  /**
   * Build SNAP transactional headers for a request.
   * Symmetric HMAC-SHA512 signature over the SNAP stringToSign.
   */
  buildSnapSignedRequest(method, relPath, body, accessToken) {
    const externalId = String(Date.now()) + nanoid(6);
    const timestamp = snapTimestamp();
    const { headers, dataString } = buildSnapRequestHeaders({
      method,
      endpointUrl: relPath,
      accessToken,
      body,
      timestamp,
      clientId: config.doku.partnerId,
      externalId,
      channelId: config.doku.channelId,
      secretKey: config.doku.secretKey,
    });
    return { headers, dataString, externalId };
  }

  /** POST a transactional request over SNAP (fetches a token automatically). */
  async _postSnap(relPath, body) {
    const { accessToken } = await this.getSnapAccessToken();
    const { headers, dataString } = this.buildSnapSignedRequest('POST', relPath, body, accessToken);
    const { data } = await this.client.post(relPath, dataString, { headers });
    return data;
  }

  // ------------------------------------------------------------- Checkout ---

  /**
   * Create a DOKU Checkout payment (hosted payment page).
   * @param {{invoiceNumber:string, amount:number, currency?:string, description?:string, customerName?:string, customerEmail?:string, paymentDueMinutes?:number}} input
   */
  async createCheckoutPayment(input) {
    const relPath = '/checkout/v1/payment';
    const body = {
      order: {
        invoice_number: input.invoiceNumber,
        line_items: [
          {
            name: input.description || 'DOKU payment',
            price: Number(input.amount),
            quantity: 1,
          },
        ],
        amount: Number(input.amount),
        currency: input.currency || 'IDR',
      },
      payment: {
        payment_due_date: input.paymentDueMinutes || 60,
      },
      customer: {
        name: input.customerName || 'Customer',
        email: input.customerEmail || 'customer@example.com',
      },
      additional_info: {
        override_notification_url: `${config.doku.publicBaseUrl}/api/webhooks/doku`,
      },
    };

    if (config.mockMode) return this._mockCheckout(body);
    return this._post(relPath, body);
  }

  // ---------------------------------------------------------------- QRIS ---

  /**
   * Create a QRIS MPM (Merchant Presented Mode) transaction.
   * Dispatches to the non-SNAP or SNAP flavour based on `input.flavor`
   * (defaults to config.doku.apiFlavor).
   * @param {{invoiceNumber:string, amount:number, currency?:string, description?:string, expiryMinutes?:number, flavor?:'nonsnap'|'snap'}} input
   */
  async createQrisTransaction(input) {
    const flavor = input.flavor || config.doku.apiFlavor;
    if (flavor === 'snap') return this.createSnapQrisTransaction(input);

    const relPath = '/qris/v1/generate-qr-code';
    const body = {
      partnerReferenceNo: input.invoiceNumber,
      merchantId: config.doku.merchantId,
      amount: {
        value: Number(input.amount).toFixed(2),
        currency: input.currency || 'IDR',
      },
      additionalInfo: {
        description: input.description || 'DOKU QRIS payment',
        expiryMinutes: input.expiryMinutes || 30,
      },
    };

    if (config.mockMode) return this._mockGenerate(body);
    return this._post(relPath, body);
  }

  /**
   * SNAP QRIS — Generate (POST /snap-adapter/b2b/v1.0/qr/qr-mpm-generate).
   * Requires `merchantId` and `terminalId` (per DOKU SNAP QRIS spec).
   */
  async createSnapQrisTransaction(input) {
    const relPath = '/snap-adapter/b2b/v1.0/qr/qr-mpm-generate';
    const body = {
      partnerReferenceNo: input.invoiceNumber,
      amount: {
        value: Number(input.amount).toFixed(2),
        currency: input.currency || 'IDR',
      },
      merchantId: config.doku.merchantId,
      terminalId: input.terminalId || config.doku.terminalId,
      validityPeriod: this._validityPeriod(input.expiryMinutes || 30),
      additionalInfo: {
        postalCode: input.postalCode || '13120',
        feeType: '1',
      },
    };

    if (config.mockMode) return this._mockSnapGenerate(body);
    return this._postSnap(relPath, body);
  }

  /** Query QRIS transaction status (non-SNAP or SNAP). */
  async queryQrisTransaction(invoiceNumber, originalReferenceNo, flavor = config.doku.apiFlavor) {
    if (flavor === 'snap') return this.querySnapQrisTransaction(invoiceNumber, originalReferenceNo);

    const relPath = '/qris/v1/query';
    const body = {
      partnerReferenceNo: invoiceNumber,
      originalReferenceNo,
      merchantId: config.doku.merchantId,
    };

    if (config.mockMode) {
      return {
        responseCode: '2004700',
        responseMessage: 'Successful',
        latestTransactionStatus: '00', // DOKU QRIS: "00" == success
        ...body,
      };
    }
    return this._post(relPath, body);
  }

  /**
   * SNAP QRIS — Query (POST /snap-adapter/b2b/v1.0/qr/qr-mpm-query).
   * serviceCode for QRIS is "47".
   */
  async querySnapQrisTransaction(invoiceNumber, originalReferenceNo) {
    const relPath = '/snap-adapter/b2b/v1.0/qr/qr-mpm-query';
    const body = {
      originalReferenceNo: originalReferenceNo || '',
      originalPartnerReferenceNo: invoiceNumber,
      serviceCode: '47',
      merchantId: config.doku.merchantId,
    };

    if (config.mockMode) {
      return {
        responseCode: '2004700',
        responseMessage: 'Successful',
        latestTransactionStatus: '00',
        transactionStatusDesc: 'Success',
        originalPartnerReferenceNo: invoiceNumber,
        originalReferenceNo,
      };
    }
    return this._postSnap(relPath, body);
  }

  /** Cancel/expire a QRIS transaction (non-SNAP or SNAP). */
  async cancelQrisTransaction(invoiceNumber, originalReferenceNo, flavor = config.doku.apiFlavor) {
    if (flavor === 'snap') return this.cancelSnapQrisTransaction(invoiceNumber, originalReferenceNo);

    const relPath = '/qris/v1/cancel';
    const body = {
      partnerReferenceNo: invoiceNumber,
      originalReferenceNo,
      merchantId: config.doku.merchantId,
      reason: 'Merchant cancelled',
    };

    if (config.mockMode) return { responseCode: '2005400', responseMessage: 'Successful' };
    return this._post(relPath, body);
  }

  /**
   * SNAP QRIS — Cancel (POST /snap-adapter/b2b/v1.0/qr/qr-expire).
   * Invalidates the QR by expiring it immediately.
   */
  async cancelSnapQrisTransaction(invoiceNumber, originalReferenceNo) {
    const relPath = '/snap-adapter/b2b/v1.0/qr/qr-expire';
    const body = {
      partnerReferenceNo: invoiceNumber,
      referenceNo: originalReferenceNo || '',
      merchantId: config.doku.merchantId,
      reason: 'Merchant cancelled',
    };

    if (config.mockMode) return { responseCode: '2005400', responseMessage: 'Successful' };
    return this._postSnap(relPath, body);
  }

  /**
   * SNAP QRIS — Refund (POST /snap-adapter/b2b/v1.0/qr/qr-mpm-refund).
   */
  async refundSnapQrisTransaction(input) {
    const relPath = '/snap-adapter/b2b/v1.0/qr/qr-mpm-refund';
    const body = {
      originalPartnerReferenceNo: input.originalInvoiceNumber,
      originalReferenceNo: input.originalReferenceNo,
      partnerRefundNo: input.partnerRefundNo,
      merchantId: config.doku.merchantId,
      refundAmount: {
        value: Number(input.amount.value).toFixed(2),
        currency: input.amount.currency || 'IDR',
      },
      reason: input.reason || 'Merchant refund',
      additionalInfo: { approvalCode: input.approvalCode || '000000' },
    };

    if (config.mockMode) {
      return {
        responseCode: '2004900',
        responseMessage: 'Successful',
        refundNo: nanoid(16).toUpperCase(),
        partnerRefundNo: input.partnerRefundNo,
        refundAmount: body.refundAmount,
      };
    }
    return this._postSnap(relPath, body);
  }

  /** ISO-8601 duration for SNAP QRIS validityPeriod (default 30 min). */
  _validityPeriod(minutes) {
    return `PT${Number(minutes) || 30}M`;
  }

  /** Query a Checkout order status by invoice number. */
  async queryOrderStatus(invoiceNumber) {
    const relPath = '/orders/v1/status';
    const body = { invoice_number: invoiceNumber };

    if (config.mockMode) {
      return {
        order: { invoice_number: invoiceNumber, status: 'SUCCESS' },
        transaction: { status: 'SUCCESS' },
      };
    }
    return this._post(relPath, body);
  }

  // -------------------------------------------------------------- Refund ---

  /**
   * Refund a settled transaction.
   * DOKU endpoint: POST /refund/v1/do-refund
   */
  async refundTransaction(input) {
    const relPath = '/refund/v1/do-refund';
    const body = {
      partner_refund_no: input.partnerRefundNo,
      original_partner_reference_no: input.originalInvoiceNumber,
      invoice_number: input.originalInvoiceNumber,
      amount: {
        value: Number(input.amount.value).toFixed(2),
        currency: input.amount.currency || 'IDR',
      },
      reason: input.reason || 'Merchant refund',
    };

    if (config.mockMode) {
      return {
        responseCode: 'SUCCESS',
        responseMessage: 'Refund processed',
        refund_no: nanoid(16).toUpperCase(),
        partner_refund_no: input.partnerRefundNo,
        amount: body.amount,
      };
    }
    return this._post(relPath, body);
  }

  // -------------------------------------------------------- Disbursement ---

  /**
   * Disburse (transfer) funds to a bank account.
   * DOKU endpoint: POST /disbursement/v1/transfer
   */
  async disburseToBank(input) {
    const relPath = '/disbursement/v1/transfer';
    const body = {
      partnerReferenceNo: input.partnerReferenceNo,
      bankAccountNo: input.bankAccountNo,
      bankCode: input.bankCode,
      amount: {
        value: Number(input.amount.value).toFixed(2),
        currency: input.amount.currency || 'IDR',
      },
      beneficiaryName: input.beneficiaryName,
      remark: input.remark || 'Disbursement',
      notifyUrl: `${config.doku.publicBaseUrl}/api/webhooks/disburse`,
    };

    if (config.mockMode) {
      return {
        responseCode: '2006700',
        responseMessage: 'Successful',
        referenceNo: nanoid(16).toUpperCase(),
        partnerReferenceNo: input.partnerReferenceNo,
        amount: body.amount,
        bankCode: input.bankCode,
        bankAccountNo: input.bankAccountNo,
      };
    }
    return this._post(relPath, body);
  }

  /**
   * Look up a bank account holder name.
   * DOKU endpoint: POST /disbursement/v1/bank-account-inquiry
   */
  async inquireBankAccount(input) {
    const relPath = '/disbursement/v1/bank-account-inquiry';
    const body = {
      partnerReferenceNo: `INQ-${Date.now()}`,
      bankCode: input.bankCode,
      bankAccountNo: input.bankAccountNo,
    };

    if (config.mockMode) {
      return {
        responseCode: '2006800',
        responseMessage: 'Successful',
        accountName: 'BUDI SANTOSO',
        bankCode: input.bankCode,
        bankAccountNo: input.bankAccountNo,
      };
    }
    return this._post(relPath, body);
  }

  // -------------------------------------------------------------- internal ---

  async _post(relPath, body) {
    const { headers, dataString } = this.buildSignedRequest('POST', relPath, body);
    const { data } = await this.client.post(relPath, dataString, { headers });
    return data;
  }

  // ------------------------------------------------------------------ mock ---

  _mockCheckout(body) {
    const invoice = body.order.invoice_number;
    const token = nanoid(40);
    return {
      message: ['SUCCESS'],
      response: {
        order: {
          invoice_number: invoice,
          amount: body.order.amount,
          currency: body.order.currency,
        },
        payment: {
          payment_due_date: body.payment.payment_due_date,
          token_id: token,
          url: `https://sandbox.doku.com/checkout/${token}`,
        },
      },
    };
  }

  _mockGenerate(body) {
    const ref = body.partnerReferenceNo;
    // A realistic-looking QRIS payload string (EMVCo). Not a real QR.
    const qrContent =
      '00020101021226610014ID.CO.QRIS.WWW0118' +
      ref.slice(0, 16).padEnd(16, '0') +
      '0215ID' +
      String(config.doku.merchantId).slice(0, 12).padEnd(12, '0') +
      '5204581453033605802ID5910DOKU STORE6007JAKARTA6304ABCD';
    return {
      responseCode: '2004700',
      responseMessage: 'Successful',
      referenceNo: nanoid(16).toUpperCase(),
      partnerReferenceNo: ref,
      qrContent,
      qrUrl: `https://sandbox.doku.com/qr/${ref}`,
      validUpTo: requestTimestamp(new Date(Date.now() + (body.additionalInfo?.expiryMinutes || 30) * 60_000)),
      additionalInfo: { description: body.additionalInfo?.description },
    };
  }

  /** Mock response for the SNAP QRIS generate endpoint. */
  _mockSnapGenerate(body) {
    const ref = body.partnerReferenceNo;
    const qrContent =
      '00020101021226610014ID.CO.QRIS.WWW0118' +
      ref.slice(0, 16).padEnd(16, '0') +
      '0215ID' +
      String(config.doku.merchantId).slice(0, 12).padEnd(12, '0') +
      '5204581453033605802ID5910DOKU STORE6007JAKARTA6304SNAP';
    return {
      responseCode: '2004700',
      responseMessage: 'Successful',
      referenceNo: nanoid(16).toUpperCase(),
      partnerReferenceNo: ref,
      qrContent,
      terminalId: body.terminalId,
      additionalInfo: {
        validityPeriod: body.validityPeriod,
        postalCode: body.additionalInfo?.postalCode,
        feeType: body.additionalInfo?.feeType,
      },
    };
  }
}

export const dokuService = new DokuService();

/**
 * Map a DOKU transaction status value to our internal status.
 *
 * DOKU uses different vocabularies per product/flavour:
 *   - Word statuses (Checkout order, non-SNAP notification): SUCCESS | FAILED |
 *     PENDING | EXPIRED | CANCELLED | REFUNDED | VOIDED
 *   - SNAP numeric codes:   00=SUCCESS, 03=PENDING, 04=REFUNDED, 05=CANCELLED, 06=FAILED
 *   - non-SNAP legacy QRIS: 00=SUCCESS, 01=FAILED,  02=PENDING, 03=EXPIRED
 *
 * The numeric codes 03/04 collide between the SNAP and legacy vocabularies, so
 * pass `flavor` ('snap' | 'nonsnap') to disambiguate. When omitted, the SNAP
 * interpretation is used for numeric codes (the modern standard).
 *
 * @param {string|number} raw
 * @param {'snap'|'nonsnap'} [flavor]
 * @returns {string|null} internal status, or null when unknown/absent
 */
export function mapDokuStatus(raw, flavor = 'snap') {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).toUpperCase();

  // Word-based statuses are unambiguous.
  const words = {
    SUCCESS: 'SUCCESS',
    SUCCESSFUL: 'SUCCESS',
    PAID: 'SUCCESS',
    SETTLED: 'SUCCESS',
    FAILED: 'FAILED',
    FAILURE: 'FAILED',
    DENIED: 'FAILED',
    EXPIRED: 'EXPIRED',
    CANCELLED: 'CANCELLED',
    CANCELED: 'CANCELLED',
    VOID: 'CANCELLED',
    VOIDED: 'CANCELLED',
    PENDING: 'PENDING',
    INITIATED: 'PENDING',
    PROCESSING: 'PENDING',
    REFUNDED: 'REFUNDED',
    REFUND: 'REFUNDED',
  };
  if (words[s]) return words[s];

  // Numeric codes depend on the flavour (03/04 collide).
  const snapCodes = { '00': 'SUCCESS', '03': 'PENDING', '04': 'REFUNDED', '05': 'CANCELLED', '06': 'FAILED' };
  const legacyCodes = { '00': 'SUCCESS', '01': 'FAILED', '02': 'PENDING', '03': 'EXPIRED' };
  const codes = flavor === 'nonsnap' ? legacyCodes : snapCodes;
  return codes[s] || null;
}

export default dokuService;
