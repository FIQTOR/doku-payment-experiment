import { useState } from 'react';
import {
  IconBolt,
  IconCurrencyDollar,
  IconFileDescription,
  IconLoader2,
  IconQrcode,
  IconUser,
  IconClockHour4,
  IconCreditCard,
} from '@tabler/icons-react';
import { api, formatIDR } from '../lib/api';
import { useToast } from './Toast';

const PRESETS = [10000, 25000, 50000, 100000, 250000];
const METHODS = [
  { id: 'qris', label: 'QRIS', icon: IconQrcode },
  { id: 'checkout', label: 'Checkout', icon: IconCreditCard },
];
const FLAVORS = [
  { id: 'nonsnap', label: 'Non-SNAP (Jokul)' },
  { id: 'snap', label: 'SNAP (BI standard)' },
];

export default function CreatePaymentForm({ onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({
    amount: 25000,
    description: 'Pembayaran pesanan',
    customerName: '',
    validUpToMinutes: 30,
  });
  const [method, setMethod] = useState('qris');
  const [flavor, setFlavor] = useState('nonsnap');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.createPayment({
        amount: Number(form.amount),
        description: form.description,
        customerName: form.customerName,
        validUpToMinutes: Number(form.validUpToMinutes),
        method,
        flavor: method === 'qris' ? flavor : undefined,
      });
      toast('Payment created — ready to pay.', 'success', 'Transaction created');
      onCreated?.(res.data);
      setForm((f) => ({ ...f, description: 'Pembayaran pesanan', customerName: '' }));
    } catch (err) {
      setError(err.message);
      toast(err.message, 'error', 'Could not create payment');
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-doku-400 focus:bg-white focus:ring-4 focus:ring-doku-100';

  return (
    <form onSubmit={submit} className="grid gap-5 lg:grid-cols-5">
      {/* Form */}
      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-card lg:col-span-3">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Payment method</label>
          <div className="grid grid-cols-2 gap-2">
            {METHODS.map((m) => {
              const Icon = m.icon;
              const active = method === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMethod(m.id)}
                  className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
                    active
                      ? 'border-doku-300 bg-doku-50 text-doku-700 ring-2 ring-doku-100'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <Icon size={17} /> {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {method === 'qris' && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">
              Direct API flavour
              <span className="ml-1 font-normal text-slate-400">(signature scheme)</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {FLAVORS.map((f) => {
                const active = flavor === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFlavor(f.id)}
                    className={`rounded-xl border px-3 py-2 text-xs font-medium transition ${
                      active
                        ? 'border-doku-300 bg-doku-50 text-doku-700 ring-2 ring-doku-100'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-700">
            <IconCurrencyDollar size={16} className="text-slate-400" /> Amount (IDR)
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-400">
              Rp
            </span>
            <input
              type="number"
              min="1"
              required
              value={form.amount}
              onChange={(e) => set('amount', e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-doku-400 focus:bg-white focus:ring-4 focus:ring-doku-100"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => set('amount', p)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                  Number(form.amount) === p
                    ? 'bg-doku-500 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {formatIDR(p)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-700">
            <IconFileDescription size={16} className="text-slate-400" /> Description
          </label>
          <input
            type="text"
            maxLength={140}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="e.g. Kopi Susu Gula Aren x2"
            className={inputCls}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-700">
              <IconUser size={16} className="text-slate-400" /> Customer (optional)
            </label>
            <input
              type="text"
              value={form.customerName}
              onChange={(e) => set('customerName', e.target.value)}
              placeholder="Customer name"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-700">
              <IconClockHour4 size={16} className="text-slate-400" /> Valid for (minutes)
            </label>
            <input
              type="number"
              min="1"
              max="1440"
              value={form.validUpToMinutes}
              onChange={(e) => set('validUpToMinutes', e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        {error && (
          <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600 ring-1 ring-inset ring-rose-100">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-doku-600 to-accent-500 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:brightness-105 focus:outline-none focus:ring-4 focus:ring-doku-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <IconLoader2 size={18} className="animate-spin" />
          ) : method === 'qris' ? (
            <IconQrcode size={18} />
          ) : (
            <IconCreditCard size={18} />
          )}
          {loading ? 'Creating payment…' : method === 'qris' ? 'Generate QRIS Payment' : 'Create Checkout'}
        </button>
      </div>

      {/* Live preview */}
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 p-5 shadow-card lg:col-span-2">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Preview</p>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center shadow-sm">
          <div className="mx-auto mb-3 grid h-28 w-28 place-items-center rounded-2xl bg-gradient-to-br from-doku-500 to-accent-500 text-white">
            {method === 'qris' ? <IconQrcode size={56} stroke={1.5} /> : <IconCreditCard size={56} stroke={1.5} />}
          </div>
          <p className="text-xs font-medium text-slate-400">Total payment</p>
          <p className="text-2xl font-bold text-slate-900">{formatIDR(form.amount)}</p>
          <p className="mt-1 line-clamp-1 text-sm text-slate-500">
            {form.description || 'No description'}
          </p>
          <div className="mt-3 flex items-center justify-center gap-1.5 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <IconBolt size={14} className="text-doku-500" />
            {method === 'qris'
              ? `QRIS MPM · ${flavor === 'snap' ? 'SNAP' : 'Non-SNAP'}`
              : 'Hosted Checkout'}{' '}
            · valid {form.validUpToMinutes} min
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-slate-400">
          Payment happens on the DOKU sandbox / a real DOKU checkout page.
        </p>
      </div>
    </form>
  );
}
