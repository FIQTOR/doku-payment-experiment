import { Router } from 'express';
import {
  handleDokuNotification,
  handleDisbursementNotification,
} from '../controllers/webhookController.js';
import { loadKey } from '../utils/signature.js';
import { storageLabel } from '../db/sequelize.js';
import config from '../config/index.js';

const router = Router();

/**
 * DOKU payment notification endpoint.
 * Configure this URL in the Jokul dashboard (e.g. https://your-host/api/webhooks/doku).
 */
router.post('/doku', handleDokuNotification);

/**
 * DOKU disbursement (transfer-to-bank) notification endpoint.
 */
router.post('/disburse', handleDisbursementNotification);

/** Health/inspection endpoint to showcase the current configuration. */
router.get('/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      env: config.env,
      mockMode: config.mockMode,
      baseUrl: config.doku.baseUrl,
      clientId: config.doku.clientId,
      merchantId: config.doku.merchantId,
      terminalId: config.doku.terminalId,
      notificationUrl: `${config.doku.publicBaseUrl}/api/webhooks/doku`,
      disburseNotifyUrl: `${config.doku.publicBaseUrl}/api/webhooks/disburse`,
      hasSecretKey: Boolean(
        config.doku.secretKey && config.doku.secretKey !== 'change_me_secret_key',
      ),
      hasPublicKey: Boolean(loadKey(config.doku.publicKeyPath)),
      storage: storageLabel(),
    },
  });
});

export default router;
