import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconPlus, IconRefresh, IconShieldCheck } from '@tabler/icons-react';
import Sidebar from './components/Sidebar';
import StatsGrid from './components/StatsGrid';
import CreatePaymentForm from './components/CreatePaymentForm';
import TransactionList from './components/TransactionList';
import PaymentDetailModal from './components/PaymentDetailModal';
import WebhookTester from './components/WebhookTester';
import DisbursementForm from './components/DisbursementForm';
import { ToastProvider, useToast } from './components/Toast';
import { api } from './lib/api';
import { useTransactionEvents } from './hooks/useTransactionEvents';

function Dashboard() {
  const toast = useToast();
  // Initial tab can be deep-linked via ?tab=create|transactions|disbursements|webhook
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return ['dashboard', 'create', 'transactions', 'disbursements', 'webhook'].includes(t)
      ? t
      : 'dashboard';
  });
  const [transactions, setTransactions] = useState([]);
  const [stats, setStats] = useState(null);
  const [runtimeConfig, setRuntimeConfig] = useState(null);
  const [filter, setFilter] = useState('ALL');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshAll = useCallback(async () => {
    const [list, s] = await Promise.all([api.listPayments({ limit: 100 }), api.stats()]);
    setTransactions(list.data || []);
    setStats(s.data);
  }, []);

  // Initial load
  useEffect(() => {
    (async () => {
      try {
        const [list, s, cfg] = await Promise.all([
          api.listPayments({ limit: 100 }),
          api.stats(),
          api.getConfig(),
        ]);
        setTransactions(list.data || []);
        setStats(s.data);
        setRuntimeConfig(cfg.data);
        // Deep-link: ?open=first auto-opens the newest transaction's detail modal.
        if (new URLSearchParams(window.location.search).get('open') === 'first' && list.data?.[0]) {
          setSelected(list.data.find((t) => t.history?.length > 1) || list.data[0]);
        }
      } catch {
        toast('Backend unreachable. Is the Express server running on :4010?', 'error', 'Connection error');
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  // Live updates over SSE
  const { connected } = useTransactionEvents({
    onCreated: (txn) => {
      setTransactions((prev) =>
        prev.some((t) => t.invoiceNumber === txn.invoiceNumber)
          ? prev.map((t) => (t.invoiceNumber === txn.invoiceNumber ? { ...t, ...txn } : t))
          : [txn, ...prev],
      );
      api.stats().then((s) => setStats(s.data)).catch(() => {});
    },
    onUpdated: (txn) => {
      setTransactions((prev) =>
        prev.some((t) => t.invoiceNumber === txn.invoiceNumber)
          ? prev.map((t) => (t.invoiceNumber === txn.invoiceNumber ? txn : t))
          : [txn, ...prev],
      );
      api.stats().then((s) => setStats(s.data)).catch(() => {});
      setSelected((cur) => (cur?.invoiceNumber === txn.invoiceNumber ? txn : cur));
    },
  });

  const filtered = useMemo(() => {
    if (filter === 'ALL') return transactions;
    return transactions.filter((t) => t.status === filter);
  }, [transactions, filter]);

  const latestRef = transactions[0]?.invoiceNumber;

  const handleCreated = (txn) => {
    setTransactions((prev) =>
      prev.some((t) => t.invoiceNumber === txn.invoiceNumber) ? prev : [txn, ...prev],
    );
    api.stats().then((s) => setStats(s.data)).catch(() => {});
    setSelected(txn);
  };

  const handleUpdate = (txn) => {
    setSelected(txn);
    setTransactions((prev) =>
      prev.map((t) => (t.invoiceNumber === txn.invoiceNumber ? { ...t, ...txn } : t)),
    );
    api.stats().then((s) => setStats(s.data)).catch(() => {});
  };

  const modeBadge = runtimeConfig?.mockMode ? 'Mock mode' : 'Live mode';

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Sidebar active={tab} onChange={setTab} connected={connected} />

      <main className="flex-1 overflow-x-hidden">
        {/* Topbar */}
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 px-4 py-3.5 backdrop-blur lg:px-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-lg font-bold text-slate-900">
                {tab === 'dashboard' && 'Payment Dashboard'}
                {tab === 'create' && 'Create Payment'}
                {tab === 'transactions' && 'Transactions'}
                {tab === 'disbursements' && 'Disbursements'}
                {tab === 'webhook' && 'Webhook Tester'}
              </h1>
              <p className="text-xs text-slate-500">DOKU Jokul API · experimental integration</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 sm:inline-flex">
                <IconShieldCheck size={14} /> {modeBadge}
              </span>
              <button
                onClick={refreshAll}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
              >
                <IconRefresh size={16} /> Refresh
              </button>
              <button
                onClick={() => setTab('create')}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-doku-600 to-accent-500 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-105"
              >
                <IconPlus size={16} /> New
              </button>
            </div>
          </div>
        </header>

        <div className="space-y-6 p-4 lg:p-8">
          {tab === 'dashboard' && (
            <>
              <StatsGrid stats={stats} />
              <div className="grid gap-6 lg:grid-cols-5">
                <div className="lg:col-span-3">
                  <TransactionList
                    transactions={filtered.slice(0, 8)}
                    onOpen={setSelected}
                    filter={filter}
                    onFilter={setFilter}
                    loading={loading}
                  />
                </div>
                <div className="lg:col-span-2">
                  <CreatePaymentForm onCreated={handleCreated} />
                </div>
              </div>
            </>
          )}

          {tab === 'create' && <CreatePaymentForm onCreated={handleCreated} />}

          {tab === 'transactions' && (
            <TransactionList
              transactions={filtered}
              onOpen={setSelected}
              filter={filter}
              onFilter={setFilter}
              loading={loading}
            />
          )}

          {tab === 'disbursements' && <DisbursementForm />}

          {tab === 'webhook' && (
            <WebhookTester defaultRef={latestRef} config={runtimeConfig} />
          )}
        </div>

        <footer className="border-t border-slate-100 px-4 py-6 text-center text-xs text-slate-400 lg:px-8">
          Built for experimentation · DOKU (Jokul) is a payment gateway by PT Espay Debit Indonesia
          Koe. Not affiliated.
        </footer>
      </main>

      <PaymentDetailModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        transaction={selected}
        onUpdate={handleUpdate}
      />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}
