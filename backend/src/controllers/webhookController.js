import config from '../config/index.js';
import * as txStore from '../store/transactions.js';
import { mapDokuStatus } from '../services/dokuService.js';
import {
  loadKey,
  verifyNotificationSignature,
  verifyRsaSha256,
  verifySnapNotificationSignature,
} from '../utils/signature.js';

/** True when a non-placeholder secret key is configured. */
function hasRealSecret() {
  return Boolean(config.doku.secretKey && config.doku.secretKey !== 'change_me_secret_key');
}

/** True when a DOKU public key file is present for RSA verification. */
function hasPublicKey() {
  return Boolean(loadKey(config.doku.publicKeyPath));
}

/** Heuristic: is this a SNAP notification (X-SIGNATURE / X-PARTNER-ID headers)? */
function isSnapNotification(req) {
  return Boolean(req.headers['x-signature'] && (req.headers['x-partner-id'] || req.headers['x-external-id']));
}

/**
 * DOKU async notification (webhook) handler for payment status updates.
 *
 * DOKU POSTs a JSON notification to the notification URL configured in the
 * Jokul dashboard (or passed via `override_notification_url`). The payload
 * typically contains an `order` (with invoice_number / amount / status) and a
 * `transaction` (with status) block, plus the `channel` used.
 *
 * Verification: DOKU signs notifications with HMAC-SHA256 (same scheme as
 * requests) using your shared secret key. The signature is validated against
 * the raw request bytes captured by the JSON body parser. When a real secret is
 * configured, an invalid/missing signature is REJECTED (401) and the
 * transaction is left untouched. In mock mode (placeholder secret) verification
 * is skipped so local testing still works.
 */
export async function handleDokuNotification(req, res, next) {
  try {
    const body = req.body || {};
    const { valid } = verifyNotification(req, body);

    // Enforce the signature whenever a real secret key is configured.
    if (hasRealSecret() && !valid) {
      return res.status(401).json({ status: 'UNAUTHORIZED', message: 'Invalid signature' });
    }

    // Status vocabulary differs by flavour:
    //   non-SNAP → order.status / transaction.status ("SUCCESS"/"FAILED"/…)
    //   SNAP     → latestTransactionStatus ("00"/"03"/…)
    const rawStatus =
      body.latestTransactionStatus ||
      body.order?.status ||
      body.transaction?.status ||
      body.status ||
      '';
    const status = mapDokuStatus(rawStatus, isSnapNotification(req) ? 'snap' : 'nonsnap');

    // Prefer the invoice number; fall back to other reference fields.
    const ref =
      body.order?.invoice_number ||
      body.originalPartnerReferenceNo ||
      body.partnerReferenceNo ||
      body.invoice_number ||
      body.acquirer?.reference_number ||
      body.channel?.reference_number;

    const txn = ref ? await txStore.getTransaction(ref) : null;

    if (txn && status) {
      await txStore.updateTransaction(
        ref,
        {
          status,
          dokuReferenceNo:
            body.originalReferenceNo ||
            body.transaction?.original_request_id ||
            body.acquirer?.reference_number ||
            txn.dokuReferenceNo,
          payer: body.customer || body.channel?.payer || txn.payer,
        },
        `Webhook: ${rawStatus} (verified=${valid})`,
      );
    } else if (!ref) {
      // No reference at all — nothing we can correlate. Log it loudly.
      console.warn('[webhook] notification without a reference number; ignored.');
    } else if (!txn) {
      // Unknown invoice. Return 404 so DOKU can retry / surface the mismatch
      // instead of silently accepting a notification we cannot apply.
      console.warn(`[webhook] unknown invoice "${ref}"; no transaction to update.`);
      return res
        .status(404)
        .json({ status: 'NOT_FOUND', message: `Unknown invoice: ${ref}` });
    } else if (!status) {
      // Known invoice but unrecognised status code — ack but warn so it is visible.
      console.warn(
        `[webhook] unmapped status "${rawStatus}" for invoice "${ref}"; transaction unchanged.`,
      );
    }

    // DOKU expects a 200 acknowledgement.
    res.status(200).json({ status: 'SUCCESS', message: 'Notification received' });
  } catch (err) {
    next(err);
  }
}

/**
 * DOKU async notification for disbursement (transfer-to-bank) status updates.
 */
export async function handleDisbursementNotification(req, res, next) {
  try {
    const body = req.body || {};
    const { valid } = verifyNotification(req, body);

    if (hasRealSecret() && !valid) {
      return res.status(401).json({ status: 'UNAUTHORIZED', message: 'Invalid signature' });
    }

    // Disbursements are fire-and-forget in this experiment; we acknowledge and log.
    console.log(
      `[webhook:disburse] ref=${body.partnerReferenceNo || body.originalReferenceNo || '-'} ` +
        `status=${body.latestTransactionStatus || body.status || '-'} verified=${valid}`,
    );

    res.status(200).json({ status: 'SUCCESS', message: 'Notification received' });
  } catch (err) {
    next(err);
  }
}

/** Verify the inbound webhook signature (SNAP HMAC-SHA512, non-SNAP HMAC-SHA256, or RSA). */
function verifyNotification(req, body) {
  // Prefer raw bytes; fall back to the parsed body only when unavailable.
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body || {});

  // 0) SNAP notifications use X-SIGNATURE + HMAC-SHA512.
  if (isSnapNotification(req)) {
    const snap = verifySnapNotificationSignature({
      headers: req.headers,
      method: req.method,
      rawBody,
      secretKey: config.doku.secretKey,
    });
    return { ...snap, componentString: snap.stringToSign };
  }

  // 1) non-SNAP: HMAC-SHA256 over the Jokul component string.
  const hmac = verifyNotificationSignature({
    headers: req.headers,
    rawBody,
    secretKey: config.doku.secretKey,
  });
  if (hmac.valid) return hmac;

  // 2) RSA-SHA256 fallback using DOKU's public key, if one is configured.
  const publicKey = loadKey(config.doku.publicKeyPath);
  const signature = String(req.headers['signature'] || '').replace(/^HMACSHA256=/i, '');
  if (publicKey && signature) {
    const rsaValid = verifyRsaSha256(hmac.componentString, signature, publicKey);
    if (rsaValid) return { ...hmac, valid: true };
  }

  return hmac;
}
