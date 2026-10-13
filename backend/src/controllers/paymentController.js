import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dokuService, mapDokuStatus } from '../services/dokuService.js';
import * as txStore from '../store/transactions.js';
import { generateQrMatrix, matrixToSvg } from '../utils/qr.js';
import config from '../config/index.js';

/** Validation schema for creating a payment. */
const createPaymentSchema = z.object({
  amount: z.coerce.number().positive().max(100_000_000),
  currency: z.string().default('IDR'),
  description: z.string().max(140).optional(),
  merchantRefNo: z.string().max(64).optional(),
  validUpToMinutes: z.coerce.number().int().min(1).max(1440).default(30),
  customerName: z.string().max(64).optional(),
  customerEmail: z.string().email().max(120).optional(),
  // "qris" (default) creates a QRIS MPM; "checkout" creates a hosted Checkout page.
  method: z.enum(['qris', 'checkout']).default('qris'),
  // Direct API flavour for QRIS: non-SNAP (Jokul) or SNAP.
  flavor: z.enum(['nonsnap', 'snap']).optional(),
});

const refundSchema = z.object({
  amount: z.coerce.number().positive().max(100_000_000).optional(),
  reason: z.string().max(140).optional(),
});

/**
 * POST /api/payments
 * Create a new DOKU payment (QRIS or Checkout) and return its payload.
 */
export async function createPayment(req, res, next) {
  try {
    const parsed = createPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const input = parsed.data;
    const invoiceNumber = `${config.doku.invoicePrefix}-${Date.now()}-${nanoid(6).toUpperCase()}`;
    const flavor = input.method === 'checkout' ? 'nonsnap' : input.flavor || config.doku.apiFlavor;

    await txStore.createTransaction({
      invoiceNumber,
      merchantRefNo: input.merchantRefNo,
      amount: { value: input.amount, currency: input.currency },
      description: input.description,
      customerName: input.customerName,
      apiFlavor: flavor,
      validUntil: new Date(Date.now() + input.validUpToMinutes * 60_000).toISOString(),
    });

    let dokuRes;
    try {
      if (input.method === 'checkout') {
        dokuRes = await dokuService.createCheckoutPayment({
          invoiceNumber,
          amount: input.amount,
          currency: input.currency,
          description: input.description,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          paymentDueMinutes: input.validUpToMinutes,
        });
      } else {
        dokuRes = await dokuService.createQrisTransaction({
          invoiceNumber,
          amount: input.amount,
          currency: input.currency,
          description: input.description,
          expiryMinutes: input.validUpToMinutes,
          flavor,
        });
      }
    } catch (err) {
      await txStore.updateTransaction(
        invoiceNumber,
        { status: 'FAILED' },
        `DOKU create failed: ${err.message}`,
      );
      throw err;
    }

    // DOKU signals business-level errors via responseCode/message, not HTTP status.
    const code = dokuRes.responseCode;
    if (code && !/^(2|SUCCESS)/i.test(String(code))) {
      await txStore.updateTransaction(
        invoiceNumber,
        { status: 'FAILED' },
        `DOKU error ${code}: ${dokuRes.responseMessage}`,
      );
      return res.status(422).json({
        success: false,
        error: 'DOKU_ERROR',
        message: dokuRes.responseMessage || 'DOKU rejected the request',
        dokuResponse: dokuRes,
      });
    }

    // QRIS returns qrContent; Checkout returns response.payment.url + token_id.
    const qrContent = dokuRes.qrContent;
    const checkoutUrl = dokuRes.response?.payment?.url || null;
    const updated = await txStore.updateTransaction(
      invoiceNumber,
      {
        dokuReferenceNo: dokuRes.referenceNo || dokuRes.response?.payment?.token_id,
        qrContent: qrContent || null,
        qrUrl: dokuRes.qrUrl || checkoutUrl,
        checkoutUrl,
      },
      'DOKU payment created',
      { silent: true },
    );

    await txStore.emitCreated(invoiceNumber);

    const payload = { ...updated, mockMode: config.mockMode };
    if (qrContent) {
      const svg = matrixToSvg(generateQrMatrix(qrContent));
      payload.qrImage = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }

    return res.status(201).json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
}

/** GET /api/payments — list transactions. */
export async function listPayments(req, res, next) {
  try {
    const { status, limit } = req.query;
    const parsedLimit = Number(limit);
    const data = await txStore.listTransactions({
      status: status || undefined,
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/** GET /api/payments/:ref — get one transaction. */
export async function getPayment(req, res, next) {
  try {
    const txn = await txStore.getTransaction(req.params.ref);
    if (!txn) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    res.json({ success: true, data: txn });
  } catch (err) {
    next(err);
  }
}

/** GET /api/payments/:ref/qr.svg — render the QR as an SVG image. */
export async function getPaymentQr(req, res, next) {
  try {
    const txn = await txStore.getTransaction(req.params.ref);
    if (!txn || !txn.qrContent) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    res.type('image/svg+xml').send(matrixToSvg(generateQrMatrix(txn.qrContent)));
  } catch (err) {
    next(err);
  }
}

/** POST /api/payments/:ref/query — poll DOKU for the latest status. */
export async function queryPayment(req, res, next) {
  try {
    const txn = await txStore.getTransaction(req.params.ref);
    if (!txn) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const isQris = Boolean(txn.qrContent);
    const flavor = txn.apiFlavor || 'nonsnap';
    const dokuRes = isQris
      ? await dokuService.queryQrisTransaction(txn.invoiceNumber, txn.dokuReferenceNo, flavor)
      : await dokuService.queryOrderStatus(txn.invoiceNumber);

    const mapped = mapDokuStatus(
      dokuRes.latestTransactionStatus ||
        dokuRes.transaction?.status ||
        dokuRes.order?.status ||
        dokuRes.status,
      flavor,
    );

    // Terminal states we own locally must never be downgraded by a status poll:
    // DOKU reports the *payment* outcome and knows nothing about a refund/void
    // we already applied. So ignore anything that would move us out of them.
    const TERMINAL_OWNED = ['REFUNDED', 'CANCELLED'];
    const isDowngrade =
      TERMINAL_OWNED.includes(txn.status) && mapped && mapped !== txn.status;

    let latest = txn;
    if (mapped && mapped !== txn.status && !isDowngrade) {
      latest =
        (await txStore.updateTransaction(
          txn.invoiceNumber,
          {
            status: mapped,
            dokuReferenceNo:
              dokuRes.originalReferenceNo || dokuRes.referenceNo || txn.dokuReferenceNo,
            payer: dokuRes.payer || dokuRes.additionalInfo?.payer || txn.payer,
          },
          'Status synced from DOKU query',
        )) || txn;
    }

    res.json({ success: true, data: { transaction: latest, dokuResponse: dokuRes } });
  } catch (err) {
    next(err);
  }
}

/** POST /api/payments/:ref/cancel — cancel a payment. */
export async function cancelPayment(req, res, next) {
  try {
    const txn = await txStore.getTransaction(req.params.ref);
    if (!txn) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (txn.status !== 'PENDING') {
      return res.status(409).json({
        success: false,
        error: 'INVALID_STATE',
        message: `Cannot cancel a ${txn.status} transaction`,
      });
    }

    if (txn.qrContent) {
      await dokuService.cancelQrisTransaction(
        txn.invoiceNumber,
        txn.dokuReferenceNo,
        txn.apiFlavor || 'nonsnap',
      );
    }
    const updated = await txStore.updateTransaction(
      txn.invoiceNumber,
      { status: 'CANCELLED' },
      'Cancelled by merchant',
    );
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/:ref/refund — refund a settled payment (full or partial).
 * Tracks the cumulative refunded amount:
 *   - partial refunds keep the transaction SUCCESS with refundedAmount > 0
 *   - once the full amount is refunded the status becomes REFUNDED
 */
export async function refundPayment(req, res, next) {
  try {
    const parsed = refundSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const txn = await txStore.getTransaction(req.params.ref);
    if (!txn) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (!['SUCCESS', 'REFUNDED'].includes(txn.status)) {
      return res.status(409).json({
        success: false,
        error: 'INVALID_STATE',
        message: `Only SUCCESS transactions can be refunded (current: ${txn.status})`,
      });
    }

    const alreadyRefunded = Number(txn.refundedAmount) || 0;
    const refundable = txn.amount.value - alreadyRefunded;
    if (refundable <= 0) {
      return res.status(409).json({
        success: false,
        error: 'ALREADY_REFUNDED',
        message: 'This transaction has already been fully refunded',
      });
    }

    const refundAmount = parsed.data.amount ?? refundable;
    if (refundAmount > refundable) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_AMOUNT',
        message: `Refund amount exceeds the refundable balance (${refundable} ${txn.amount.currency})`,
        refundable,
      });
    }

    const refundRefNo = `RFD-${Date.now()}-${nanoid(6).toUpperCase()}`;
    const refundInput = {
      partnerRefundNo: refundRefNo,
      originalInvoiceNumber: txn.invoiceNumber,
      originalReferenceNo: txn.dokuReferenceNo,
      amount: { value: refundAmount, currency: txn.amount.currency },
      reason: parsed.data.reason,
    };
    const dokuRes =
      txn.apiFlavor === 'snap'
        ? await dokuService.refundSnapQrisTransaction(refundInput)
        : await dokuService.refundTransaction(refundInput);

    const code = dokuRes.responseCode;
    if (code && !/^(2|SUCCESS)/i.test(String(code))) {
      return res.status(422).json({
        success: false,
        error: 'DOKU_ERROR',
        message: dokuRes.responseMessage || 'DOKU rejected the refund',
        dokuResponse: dokuRes,
      });
    }

    const newRefunded = alreadyRefunded + refundAmount;
    const fullyRefunded = newRefunded >= txn.amount.value;
    const updated = await txStore.updateTransaction(
      txn.invoiceNumber,
      {
        refundedAmount: newRefunded,
        status: fullyRefunded ? 'REFUNDED' : 'SUCCESS',
      },
      fullyRefunded
        ? `Fully refunded ${newRefunded} ${txn.amount.currency}`
        : `Partially refunded ${refundAmount} ${txn.amount.currency} (${newRefunded}/${txn.amount.value})`,
    );

    res.json({
      success: true,
      data: {
        transaction: updated,
        refund: {
          refundReferenceNo: refundRefNo,
          amount: refundAmount,
          currency: txn.amount.currency,
          refundedTotal: newRefunded,
          refundableRemaining: txn.amount.value - newRefunded,
          fullyRefunded,
          dokuResponse: dokuRes,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/:ref/simulate — EXPERIMENT ONLY.
 * Force a transaction into SUCCESS/FAILED/EXPIRED to test the UI without a real payer.
 * Gated by config.mockMode so it can never be used against live payments.
 */
export async function simulatePayment(req, res, next) {
  try {
    if (!config.mockMode) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'Simulation is only available in mock mode (DOKU_MOCK_MODE=true).',
      });
    }

    const txn = await txStore.getTransaction(req.params.ref);
    if (!txn) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const body = req.body || {};
    const status = body.status || 'SUCCESS';
    if (!['SUCCESS', 'FAILED', 'EXPIRED'].includes(status)) {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS' });
    }

    const payer =
      status === 'SUCCESS'
        ? {
            name: typeof body.payerName === 'string' ? body.payerName : 'Test Payer',
            accountNo: typeof body.payer === 'string' ? body.payer : '081234567890',
          }
        : null;

    const updated = await txStore.updateTransaction(
      txn.invoiceNumber,
      { status, payer },
      'Simulated by developer',
    );
    res.json({ success: true, data: updated, simulated: true });
  } catch (err) {
    next(err);
  }
}

/** GET /api/payments/stats — aggregate stats for the dashboard. */
export async function paymentStats(_req, res, next) {
  try {
    res.json({ success: true, data: await txStore.stats() });
  } catch (err) {
    next(err);
  }
}
