import { useState } from 'react';
import {
  IconSpeakerphone,
  IconCopy,
  IconSend,
  IconLoader2,
  IconCode,
  IconCheck,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { useToast } from './Toast';

const SAMPLE = `{
  "order": {
    "invoice_number": "<paste an invoice number>",
    "amount": 25000,
    "currency": "IDR",
    "status": "SUCCESS"
  },
  "transaction": {
    "status": "SUCCESS",
    "original_request_id": "20260101123456789"
  },
  "channel": {
    "id": "QRIS",
    "payer": { "name": "Budi", "accountNo": "08123456789" }
  }
}`;

export default function WebhookTester({ defaultRef, config }) {
  const toast = useToast();
  // When a real secret key is configured the backend enforces signature
  // verification, so an unsigned test payload will be rejected with 401.
  const signatureEnforced = Boolean(config && config.hasSecretKey && !config.mockMode);
  const [payload, setPayload] = useState(SAMPLE);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState(null);

  const webhookPath = '/api/webhooks/doku';
  const fullUrl = `${window.location.origin}${webhookPath}`;

  const copy = () => {
    navigator.clipboard?.writeText(fullUrl);
    toast('Webhook URL copied', 'success');
  };

  const send = async () => {
    let body;
    try {
      body = JSON.parse(payload);
    } catch {
      toast('Payload is not valid JSON', 'error');
      return;
    }
    const invoice = body.order?.invoice_number;
    if (!invoice || invoice.includes('<')) {
      toast('Set a real invoice_number first', 'error');
      return;
    }
    setSending(true);
    setResponse(null);
    try {
      const res = await fetch(webhookPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      setResponse({ ok: res.ok, status: res.status, json });
      toast('Webhook delivered', res.ok ? 'success' : 'error');
    } catch (err) {
      setResponse({ ok: false, status: 0, json: { error: err.message } });
      toast(err.message, 'error');
    } finally {
      setSending(false);
    }
  };

  const useDefault = () => {
    try {
      const parsed = JSON.parse(payload);
      if (defaultRef) parsed.order.invoice_number = defaultRef;
      setPayload(JSON.stringify(parsed, null, 2));
      toast('Invoice number inserted', 'info');
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
        <div className="mb-4 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-100 text-violet-600">
            <IconSpeakerphone size={20} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Notification endpoint</h3>
            <p className="text-xs text-slate-500">Configure this URL in the DOKU Jokul dashboard</p>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-xl bg-slate-900 p-3">
          <code className="flex-1 truncate text-xs text-emerald-300">{fullUrl}</code>
          <button
            onClick={copy}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/10 text-white transition hover:bg-white/20"
          >
            <IconCopy size={14} />
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Method <span className="font-mono font-semibold text-slate-700">POST</span> · content-type{' '}
          <span className="font-mono font-semibold text-slate-700">application/json</span>. DOKU signs
          notifications with HMAC-SHA256 — verify using your secret key (
          <span className="font-mono">Signature</span>, <span className="font-mono">Client-Id</span>,{' '}
          <span className="font-mono">Request-Id</span>, <span className="font-mono">Request-Timestamp</span>).
        </p>

        {defaultRef && (
          <button
            onClick={useDefault}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
          >
            <IconCheck size={14} /> Use latest invoice: {defaultRef.slice(0, 22)}…
          </button>
        )}

        {signatureEnforced && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
            <IconAlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              Signature verification is <b>enforced</b> (a real secret key is configured), so this
              unsigned test payload will be rejected with <span className="font-mono">401</span>.
              Set <span className="font-mono">DOKU_MOCK_MODE=true</span> or send a signed request to
              test callbacks locally.
            </span>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
          <IconCode size={16} className="text-slate-400" /> Test payload
        </div>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          spellCheck={false}
          rows={12}
          className="w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700 outline-none transition focus:border-doku-400 focus:bg-white focus:ring-4 focus:ring-doku-100"
        />
        <div className="mt-3 flex gap-2">
          <button
            onClick={send}
            disabled={sending}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-doku-600 to-accent-500 px-3 py-2.5 text-sm font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
          >
            {sending ? <IconLoader2 size={16} className="animate-spin" /> : <IconSend size={16} />}
            Send notification
          </button>
          <button
            onClick={() => setPayload(SAMPLE)}
            className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            Reset
          </button>
        </div>

        {response && (
          <div
            className={`mt-3 rounded-xl border p-3 text-xs ${
              response.ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'
            }`}
          >
            <p className="mb-1 font-semibold text-slate-700">
              HTTP {response.status} {response.ok ? '· accepted' : '· failed'}
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-slate-600">
              {JSON.stringify(response.json, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
