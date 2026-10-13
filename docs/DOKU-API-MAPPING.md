# DOKU Jokul — endpoint mapping

This document maps the experiment's internal API to DOKU Jokul endpoints and
documents the status vocabularies used.

## Request signing

Every outbound request carries a Jokul **HMAC-SHA256** signature (see
`backend/src/utils/signature.js`):

| Header | Value |
| --- | --- |
| `Client-Id` | `DOKU_CLIENT_ID` |
| `Request-Id` | a fresh UUID per request |
| `Request-Timestamp` | RFC3339 UTC, e.g. `2026-01-01T00:00:00Z` |
| `Signature` | `HMACSHA256=<base64(HMAC-SHA256(component, DOKU_SECRET_KEY))>` |

Component string (non-empty lines joined by `\n`, in this order):

```text
Client-Id:<clientId>
Request-Id:<requestId>
Request-Timestamp:<timestamp>
Request-Target:<path>          # path only, no query string
Digest:<base64(sha256(body))>  # omitted for bodyless requests
```

## Outbound endpoints

| Experiment function | DOKU Jokul endpoint |
| --- | --- |
| `createCheckoutPayment` | `POST /checkout/v1/payment` |
| `createQrisTransaction` | `POST /qris/v1/generate-qr-code` |
| `queryQrisTransaction` | `POST /qris/v1/query` |
| `cancelQrisTransaction` | `POST /qris/v1/cancel` |
| `queryOrderStatus` | `POST /orders/v1/status` |
| `refundTransaction` | `POST /refund/v1/do-refund` |
| `disburseToBank` | `POST /disbursement/v1/transfer` |
| `inquireBankAccount` | `POST /disbursement/v1/bank-account-inquiry` |

> Endpoint paths and payloads can vary slightly by DOKU product version and by
> the Jokul API version enabled on your merchant account. Treat the paths above
> as a starting point and confirm against the latest
> [DOKU API reference](https://developers.doku.com/).

## Inbound notifications

| Experiment route | Purpose |
| --- | --- |
| `POST /api/webhooks/doku` | Payment status notification |
| `POST /api/webhooks/disburse` | Disbursement status notification |

Notifications are validated with the same HMAC-SHA256 component string, computed
over the **raw** request body. Configure the notification URL in the DOKU
dashboard (or send `override_notification_url` when creating a Checkout payment).

## Status mapping

`mapDokuStatus()` normalises DOKU's per-product vocabularies to internal statuses:

| DOKU value | Internal |
| --- | --- |
| `SUCCESS`, `SUCCESSFUL`, `PAID`, `SETTLED`, `"00"` | `SUCCESS` |
| `FAILED`, `FAILURE`, `DENIED`, `"01"` | `FAILED` |
| `EXPIRED`, `"03"` | `EXPIRED` |
| `CANCELLED`, `CANCELED`, `VOID` | `CANCELLED` |
| `PENDING`, `INITIATED`, `PROCESSING`, `"02"` | `PENDING` |
| `REFUNDED`, `REFUND` | `REFUNDED` |

- **Checkout** `order.status` / `transaction.status` use words (`SUCCESS`, `FAILED`, …).
- **QRIS** `latestTransactionStatus` uses numeric codes (`"00"` = success).

## Environment variables

See [`backend/.env.example`](../backend/.env.example) for the full list. The
essentials are `DOKU_CLIENT_ID`, `DOKU_SECRET_KEY`, `DOKU_BASE_URL`, and
`DOKU_MOCK_MODE`.
