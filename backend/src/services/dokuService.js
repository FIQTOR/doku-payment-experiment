import axios from 'axios';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import config from '../config/index.js';
import { bodyDigest, minifyBody, requestTimestamp, signHmacSha256 } from '../utils/signature.js';

/**
 * DOKU Jokul API service.
 *
 * Wraps the DOKU Jokul HTTP API (Indonesian payment gateway) using its
 * HMAC-SHA256 request signature scheme. When config.mockMode is true all calls
 * are simulated locally so you can experiment with the full payment flow
 * (create → QR/invoice → poll → webhook) without live sandbox credentials.
 *
 * Real endpoints (sandbox: https://api-sandbox.doku.com, prod: https://api.doku.com):
 *   POST /checkout/v1/payment             → create a Checkout payment (hosted page)
 *   POST /qris/v1/generate-qr-code        → create a QRIS transaction (MPM)
 *   POST /orders/v1/status                → query transaction status by invoice
 *   POST /qris/v1/query                   → query QRIS transaction status
 *   POST /qris/v1/cancel                  → cancel a QRIS transaction
 *   POST /refund/v1/do-refund             → refund a settled transaction
 *   POST /disbursement/v1/transfer        → disburse funds to a bank account
 *   POST /disbursement/v1/bank-account-inquiry → look up an account holder name
 */
class DokuService {
  constructor() {
    this.client = axios.create({
      baseURL: config.doku.baseUrl,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });
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
   * @param {{invoiceNumber:string, amount:number, currency?:string, description?:string, expiryMinutes?:number}} input
   */
  async createQrisTransaction(input) {
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

  /** Query QRIS transaction status. */
  async queryQrisTransaction(invoiceNumber, originalReferenceNo) {
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

  /** Cancel a QRIS transaction. */
  async cancelQrisTransaction(invoiceNumber, originalReferenceNo) {
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
}

export const dokuService = new DokuService();

/**
 * Map a DOKU transaction status value to our internal status.
 * DOKU uses several vocabularies depending on the product:
 *   - Checkout order status:  SUCCESS | FAILED | PENDING | EXPIRED | REFUNDED
 *   - QRIS `latestTransactionStatus`: "00" success, "01" failed, "02" pending, "03" expired
 * Returns null when the status is unknown/absent.
 */
export function mapDokuStatus(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).toUpperCase();
  const map = {
    SUCCESS: 'SUCCESS',
    SUCCESSFUL: 'SUCCESS',
    PAID: 'SUCCESS',
    SETTLED: 'SUCCESS',
    '00': 'SUCCESS',
    FAILED: 'FAILED',
    FAILURE: 'FAILED',
    DENIED: 'FAILED',
    '01': 'FAILED',
    EXPIRED: 'EXPIRED',
    '03': 'EXPIRED',
    CANCELLED: 'CANCELLED',
    CANCELED: 'CANCELLED',
    VOID: 'CANCELLED',
    '04': 'CANCELLED',
    PENDING: 'PENDING',
    INITIATED: 'PENDING',
    PROCESSING: 'PENDING',
    '02': 'PENDING',
    REFUNDED: 'REFUNDED',
    REFUND: 'REFUNDED',
  };
  return map[s] || null;
}

export default dokuService;
