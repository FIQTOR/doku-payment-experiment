/** Seed demo transactions for local screenshots. Usage: node tools/seed-demo.mjs */
const BASE = process.env.API_BASE || 'http://localhost:4010/api';
const j = (r) => r.json();
const mk = (b) => fetch(`${BASE}/payments`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b) }).then(j);
const sim = (ref, status) => fetch(`${BASE}/payments/${ref}/simulate`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status, payerName:'Budi Santoso' }) }).then(j);
const refund = (ref) => fetch(`${BASE}/payments/${ref}/refund`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }).then(j);

const items = [
  { amount: 15000, description: 'Kopi Susu Gula Aren x2', flavor: 'snap' },
  { amount: 25000, description: 'Nasi Goreng Spesial', flavor: 'nonsnap' },
  { amount: 32000, description: 'Es Teh Manis', flavor: 'snap' },
  { amount: 18000, description: 'Ayam Geprek', flavor: 'nonsnap' },
  { amount: 45000, description: 'Mie Ayam Bakso', flavor: 'snap' },
  { amount: 75000, description: 'Parking fee', flavor: 'nonsnap' },
  { amount: 12000, description: 'Checkout order', method: 'checkout' },
  { amount: 60000, description: 'Snack box meeting', flavor: 'snap' },
];
const made = [];
for (const it of items) made.push((await mk(it)).data.invoiceNumber);
await sim(made[0], 'SUCCESS');
await sim(made[1], 'SUCCESS');
await sim(made[2], 'FAILED');
await sim(made[3], 'SUCCESS');
await sim(made[4], 'SUCCESS');
await refund(made[4]);
console.log('seeded', made.length, 'transactions');
console.log('stats', JSON.stringify((await fetch(`${BASE}/payments/stats`).then(j)).data));
