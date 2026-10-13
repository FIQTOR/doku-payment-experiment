import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * First-run convenience: if no `backend/.env` exists yet (fresh clone), copy it
 * from `.env.example` so the app boots with sane, credential-free defaults.
 */
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = path.join(backendRoot, '.env');
const envExamplePath = path.join(backendRoot, '.env.example');
if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
  try {
    fs.copyFileSync(envExamplePath, envPath);
    console.log('[config] Created backend/.env from .env.example (first run).');
  } catch {
    /* read-only fs — fall back to defaults */
  }
}

// Load env AFTER ensuring the file exists.
await import('dotenv/config');

/**
 * Centralised configuration loader for the DOKU payment backend.
 * All values come from environment variables (see backend/.env.example).
 */
const num = (v) => (v !== undefined && v !== '' ? Number(v) : undefined);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT) || 4010,
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5174')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  doku: {
    // Client-Id issued by DOKU (Jokul). Sent as the `Client-Id` header.
    clientId: process.env.DOKU_CLIENT_ID || 'BRN-0000-000000000000000000',
    // Shared secret used for the HMAC-SHA256 request signature (Jokul).
    // Also used to validate inbound webhook notifications (with the JSON body).
    secretKey: process.env.DOKU_SECRET_KEY || 'change_me_secret_key',
    // Base URL for DOKU Jokul.
    // Sandbox: https://api-sandbox.doku.com   Prod: https://api.doku.com
    baseUrl: process.env.DOKU_BASE_URL || 'https://api-sandbox.doku.com',
    // Merchant identifier (optional for QRIS; required by some products).
    merchantId: process.env.DOKU_MERCHANT_ID || 'YOUR_MERCHANT_ID',
    // Terminal / store identifiers used by some Jokul products.
    terminalId: process.env.DOKU_TERMINAL_ID || 'TERMINAL-01',
    // Invoice issuer prefix, e.g. merchant id used in Checkout invoice numbers.
    invoicePrefix: process.env.DOKU_INVOICE_PREFIX || 'INV',
    // Path to DOKU's public key (PEM) for RSA-based signature verification.
    publicKeyPath: process.env.DOKU_PUBLIC_KEY_PATH,
    // Path to YOUR RSA private key (PEM, PKCS#8) — used to sign SNAP Get-Token
    // requests (SHA256withRSA). Generate with `npm run gen-key`.
    privateKeyPath: process.env.DOKU_PRIVATE_KEY_PATH,
    // SNAP partner identifier (the client id sent as X-PARTNER-ID).
    // Defaults to clientId, then the placeholder, so it is never undefined.
    partnerId:
      process.env.DOKU_PARTNER_ID ||
      process.env.DOKU_CLIENT_ID ||
      'BRN-0000-000000000000000000',
    // CHANNEL-ID sent with SNAP QRIS requests (H2H for host-to-host).
    channelId: process.env.DOKU_CHANNEL_ID || 'H2H',
    // Default Direct API flavour: 'nonsnap' | 'snap'. Can be overridden per request.
    apiFlavor: (process.env.DOKU_API_FLAVOR || 'nonsnap').toLowerCase() === 'snap' ? 'snap' : 'nonsnap',
    // Publicly reachable base URL so DOKU can deliver async notifications.
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4010',
  },

  // Local simulation mode — do not hit the network.
  mockMode: String(process.env.DOKU_MOCK_MODE || 'true').toLowerCase() === 'true',

  // Optional DB persistence (Sequelize). Disabled by default → in-memory store.
  db: {
    enabled: String(process.env.DB_ENABLED || 'false').toLowerCase() === 'true',
    dialect: process.env.DB_DIALECT || 'mysql',
    host: process.env.DB_HOST || '',
    port: num(process.env.DB_PORT) || 3306,
    storage: process.env.DB_STORAGE || ':memory:', // sqlite only
    name: process.env.DB_NAME || 'doku_payments',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    logging: String(process.env.DB_LOGGING || 'false').toLowerCase() === 'true',
    syncAlter: String(process.env.DB_SYNC_ALTER || 'false').toLowerCase() === 'true',
  },
};

export default config;
