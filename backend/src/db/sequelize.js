import { Sequelize } from 'sequelize';
import config from '../config/index.js';
import { defineTransaction } from './models/transaction.js';

/**
 * Database connection via Sequelize (MySQL by default, SQLite for tests).
 * Only initialised when DB_ENABLED=true and a host is configured. When disabled
 * the app falls back to the in-memory store, so the project still runs with no
 * setup.
 */
let sequelize = null;
let Transaction = null;
// Runtime kill-switch so a failed connection can truly fall back to in-memory.
let disabled = false;

export function isDbEnabled() {
  if (disabled) return false;
  const needsHost = config.db.dialect !== 'sqlite';
  return Boolean(config.db.enabled && (!needsHost || config.db.host));
}

/** Force the store back to in-memory (used when the DB connection fails). */
export function disableDb() {
  disabled = true;
}

export function getSequelize() {
  if (!sequelize) {
    const common = {
      dialect: config.db.dialect,
      logging: config.db.logging ? (msg) => console.log(`[sql] ${msg}`) : false,
      define: { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' },
    };

    if (config.db.dialect === 'sqlite') {
      sequelize = new Sequelize({ ...common, storage: config.db.storage, define: {} });
    } else {
      sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
        ...common,
        host: config.db.host,
        port: config.db.port,
        pool: { max: 5, min: 0, idle: 10_000 },
      });
    }

    Transaction = defineTransaction(sequelize);
  }
  return sequelize;
}

export function getTransactionModel() {
  if (!Transaction) getSequelize();
  return Transaction;
}

/** Human-readable label for the active storage backend. */
export function storageLabel() {
  return isDbEnabled() ? config.db.dialect : 'memory';
}

/** Connect, verify, and sync the schema. Throws on failure. */
export async function initDb() {
  const s = getSequelize();
  await s.authenticate();
  await s.sync({ alter: config.db.syncAlter });
  return s;
}

export async function closeDb() {
  if (sequelize) await sequelize.close();
}
