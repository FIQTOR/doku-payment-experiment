import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair } from './signature.js';

/**
 * Generates an RSA-2048 key pair and writes it to backend/certs/. Run with:
 * `npm run gen-key`
 *
 * NOTE: DOKU Jokul request/notification signing uses HMAC-SHA256 with your
 * shared secret key — it does NOT require a key pair. This generator exists so
 * you can create key pairs for products that use asymmetric keys (e.g. DOKU
 * public-key based integrations or webhook RSA verification if enabled for
 * your merchant account).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const certsDir = path.resolve(__dirname, '../../certs');

if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

const { privateKey, publicKey } = generateKeyPair();

const privPath = path.join(certsDir, 'private_key.pem');
const pubPath = path.join(certsDir, 'public_key.pem');

fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });

console.log('✔ Generated RSA-2048 key pair');
console.log('  Private key :', privPath);
console.log('  Public key  :', pubPath);
console.log('\nUpload the PUBLIC key to the DOKU dashboard if your integration uses asymmetric keys.');
console.log('The PRIVATE key must be kept secret — never commit it.');
