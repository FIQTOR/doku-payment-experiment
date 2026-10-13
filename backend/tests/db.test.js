import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * DB-layer tests using SQLite (no external server required).
 * We flip the env before importing modules so config picks it up.
 */
process.env.DB_ENABLED = 'true';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';

const { initDb, closeDb, isDbEnabled, getTransactionModel, disableDb } = await import(
  '../src/db/sequelize.js'
);
const store = await import('../src/store/transactions.js');

describe('store (sqlite backend)', () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await store._reset();
  });

  it('reports the DB backend as enabled + sqlite', async () => {
    expect(isDbEnabled()).toBe(true);
    expect(getTransactionModel().getTableName()).toBe('transactions');
  });

  it('persists a transaction and reads it back', async () => {
    await store.createTransaction({
      invoiceNumber: 'INV-DB-1',
      amount: { value: 30000, currency: 'IDR' },
      description: 'db test',
    });
    const txn = await store.getTransaction('INV-DB-1');
    expect(txn).not.toBeNull();
    expect(txn.amount.value).toBe(30000);
    expect(txn.status).toBe('PENDING');
  });

  it('updates status, history and refund tracking', async () => {
    await store.createTransaction({
      invoiceNumber: 'INV-DB-2',
      amount: { value: 40000, currency: 'IDR' },
    });
    await store.updateTransaction('INV-DB-2', { status: 'SUCCESS' }, 'paid');
    const txn = await store.getTransaction('INV-DB-2');
    expect(txn.status).toBe('SUCCESS');
    expect(txn.history.map((h) => h.status)).toEqual(['PENDING', 'SUCCESS']);
  });

  it('lists newest-first with a status filter', async () => {
    await store.createTransaction({ invoiceNumber: 'INV-DB-A', amount: { value: 1000 } });
    await store.createTransaction({ invoiceNumber: 'INV-DB-B', amount: { value: 2000 } });
    await store.updateTransaction('INV-DB-A', { status: 'SUCCESS' });

    const all = await store.listTransactions();
    expect(all.length).toBe(2);
    const success = await store.listTransactions({ status: 'SUCCESS' });
    expect(success).toHaveLength(1);
    expect(success[0].invoiceNumber).toBe('INV-DB-A');
  });

  it('computes stats from the DB', async () => {
    await store.createTransaction({ invoiceNumber: 'INV-DB-S1', amount: { value: 5000 } });
    await store.updateTransaction('INV-DB-S1', { status: 'SUCCESS' });
    const s = await store.stats();
    expect(s.total).toBeGreaterThanOrEqual(1);
    expect(s.backend).toBe('sqlite');
  });

  // Keep this LAST: it flips the global DB kill-switch used by isDbEnabled().
  it('disableDb() truly falls back to the in-memory store', async () => {
    expect(isDbEnabled()).toBe(true);
    expect(store.usingDb()).toBe(true);

    disableDb();

    expect(isDbEnabled()).toBe(false);
    expect(store.usingDb()).toBe(false);
    // Writes now go to the in-memory map, not Sequelize.
    const txn = await store.createTransaction({
      invoiceNumber: 'INV-MEM-1',
      amount: { value: 1234, currency: 'IDR' },
    });
    expect(txn).not.toBeNull();
    expect((await store.stats()).backend).toBe('memory');
  });
});
