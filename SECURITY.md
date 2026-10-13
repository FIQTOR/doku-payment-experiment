# Security Policy

## Scope

This is an **experimental** project intended for local development and sandbox
testing. Do not deploy it as-is to production without a security review.

## Secrets

- **Never commit** real credentials, secret keys, or private keys.
- `.env` and `backend/certs/*.pem` are gitignored — keep it that way.
- Use `backend/.env.example` as the template for new variables.
- Rotate any key that you suspect may have been exposed.

## Reporting a vulnerability

If you discover a security issue, please **do not open a public issue**.
Instead, contact the maintainer privately (see the repository owner profile) with:

- a description of the issue,
- reproduction steps,
- the potential impact.

We'll acknowledge your report as quickly as possible and work on a fix.

## Hardening notes for production

- Replace the in-memory store with a proper database (MySQL via `DB_ENABLED`).
- Always verify webhook signatures (`DOKU_SECRET_KEY` configured) — never disable.
- Terminate TLS in front of the backend and set a strict `CORS_ORIGIN`.
- Tune `RATE_LIMIT_MAX` to your traffic and add authentication to the dashboard.
- Store the DOKU secret key in a secret manager, not on disk.
