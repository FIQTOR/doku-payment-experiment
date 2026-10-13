# Contributing

Thanks for your interest in the DOKU Payment Experiment! 🎉

## Getting started

```bash
npm install
npm run install:all
cp backend/.env.example backend/.env
npm run dev
```

- Backend → <http://localhost:4010>
- Frontend → <http://localhost:5174>

## Project layout

- `backend/` — Express API, Jokul signing, in-memory/SQLite/MySQL store.
- `frontend/` — React 19 + Vite + Tailwind v4 dashboard.
- `docs/` — setup + API mapping.

## Before opening a PR

1. **Backend tests pass**
   ```bash
   cd backend && npm test
   ```
2. **Frontend lints & builds**
   ```bash
   cd frontend && npm run lint && npm run build
   ```
3. Keep changes focused and update docs where behaviour changes.
4. **Never commit secrets** — `.env` and `certs/*.pem` are gitignored. Use
   `backend/.env.example` for new variables.

## Style

- 2-space indentation, single quotes, semicolons (JS).
- Prefer small, composable functions and comments that explain *why*.
- Match the existing naming (`invoiceNumber`, `dokuReferenceNo`, `checkoutUrl`).

## Commit messages

Short, imperative, scoped where useful, e.g.:

```text
backend: validate webhook signature against raw body
frontend: show checkout URL in the detail modal
```

## Reporting issues

Please include your Node version, mock/live mode, and the relevant request +
response (`/api/webhooks/config`, `npm run doku:ping` output) with secrets
redacted.
