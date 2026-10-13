#!/usr/bin/env node
/**
 * Creates backend/.env from backend/.env.example if it doesn't exist yet.
 * Run automatically by `npm run setup`, or standalone: `node scripts/setup-env.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, 'backend', '.env');
const examplePath = path.join(root, 'backend', '.env.example');

if (fs.existsSync(envPath)) {
  console.log('✓ backend/.env already exists — leaving it untouched.');
} else if (fs.existsSync(examplePath)) {
  fs.copyFileSync(examplePath, envPath);
  console.log('✓ Created backend/.env from backend/.env.example');
  console.log('  → Defaults run in MOCK mode (no DOKU credentials needed).');
  console.log('  → For live/sandbox, edit backend/.env with your Client-Id + Secret Key.');
} else {
  console.error('✗ backend/.env.example not found — cannot create .env');
  process.exit(1);
}
