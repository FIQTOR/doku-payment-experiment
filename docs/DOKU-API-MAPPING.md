# DOKU Direct API — endpoint mapping (SNAP & non-SNAP)

This document maps the experiment's internal API to DOKU **Direct API**
endpoints, covering **both** integration flavours, and documents the signature
schemes and status vocabularies.

Source: <https://developers.doku.com/accept-payments/direct-api>

---

## 1. Request signing

DOKU exposes two signature schemes. See `backend/src/utils/signature.js`.

### 1.1 non-SNAP (Jokul classic) — HMAC-SHA256

| Header | Value |
| --- | --- |
| `Client-Id` | `DOKU_CLIENT_ID` |
| `Request-Id` | a fresh UUID per request |
| `Request-Timestamp` | RFC3339 UTC, e.g. `2026-01-01T00:00:00Z` |
| `Signature` | `HMACSHA256=<base64(HMAC-SHA256(component, DOKU_SECRET_KEY))>` |

Component string (lines joined by `\n`, in order):

```text
Client-Id:<clientId>
Request-Id:<requestId>
Request-Timestamp:<timestamp>
Request-Target:<path>          # path only, no query string
Digest:<base64(sha256(body))>  # omitted for bodyless requests
```

### 1.2 SNAP — Get-Token (asymmetric, SHA256withRSA)

| Header | Value |
| --- | --- |
| `X-CLIENT-KEY` | `DOKU_CLIENT_ID` |
| `X-TIMESTAMP` | RFC3339 with `+07:00` offset |
| `X-SIGNATURE` | `base64(SHA256withRSA(privateKey, clientId + "|" + timestamp))` |

Endpoint: `POST /authorization/v1/access-token/b2b` with body
`{"grantType":"client_credentials"}` → returns `accessToken` (Bearer, ~900s).

### 1.3 SNAP — transactional (symmetric, HMAC-SHA512)

| Header | Value |
| --- | --- |
| `X-PARTNER-ID` | `DOKU_PARTNER_ID` (defaults to client id) |
| `X-EXTERNAL-ID` | unique per request |
| `X-TIMESTAMP` | RFC3339 with `+07:00` |
| `X-SIGNATURE` | `base64(HMAC-SHA512(secretKey, stringToSign))` |
| `Authorization` | `Bearer <accessToken>` |
| `CHANNEL-ID` | `H2H` (host-to-host) |

```text
stringToSign = HTTPMethod : RequestTarget : AccessToken
             : Lowercase(HexEncode(SHA256(minify(RequestBody)))) : Timestamp
```

---

## 2. Outbound endpoints

| Experiment function | non-SNAP | SNAP |
| --- | --- | --- |
| Get access token | *(none)* | `POST /authorization/v1/access-token/b2b` |
| Create Checkout | `POST /checkout/v1/payment` | — |
| QRIS generate | `POST /qris/v1/generate-qr-code` | `POST /snap-adapter/b2b/v1.0/qr/qr-mpm-generate` |
| QRIS query | `POST /qris/v1/query` | `POST /snap-adapter/b2b/v1.0/qr/qr-mpm-query` |
| QRIS cancel | `POST /qris/v1/cancel` | `POST /snap-adapter/b2b/v1.0/qr/qr-expire` |
| QRIS refund | `POST /refund/v1/do-refund` | `POST /snap-adapter/b2b/v1.0/qr/qr-mpm-refund` |
| Order status | `POST /orders/v1/status` | `POST /orders/v1/status` |
| Disbursement transfer | `POST /disbursement/v1/transfer` | — |
| Bank account inquiry | `POST /disbursement/v1/bank-account-inquiry` | — |

> Endpoint paths and payloads can vary by DOKU product/API version and by what is
> enabled on your merchant account. Confirm against the latest
> [DOKU API reference](https://developers.doku.com/).

SNAP QRIS specifics: `serviceCode` is `"47"`; `terminalId` is required on
generate; `validityPeriod` is an ISO-8601 duration (e.g. `PT30M`);
`additionalInfo` requires `postalCode` and `feeType`.

---

## 3. Inbound notifications

| Experiment route | Purpose |
| --- | --- |
| `POST /api/webhooks/doku` | Payment status notification (non-SNAP **and** SNAP) |
| `POST /api/webhooks/disburse` | Disbursement status notification |

Verification is chosen automatically from the headers:

- **SNAP** (has `X-SIGNATURE` + `X-PARTNER-ID`/`X-EXTERNAL-ID`):
  ```text
  stringToSign = METHOD : RequestTarget : AccessToken
               : Hex(SHA256(rawBody)) : X-TIMESTAMP     # note: no Digest label
  X-SIGNATURE  = base64(HMAC-SHA512(secretKey, stringToSign))
  ```
- **non-SNAP** (has `Client-Id`/`Request-Timestamp`/`Signature`): the component
  string above, HMAC-SHA256.
- **RSA fallback**: if `DOKU_PUBLIC_KEY_PATH` is set and HMAC fails, the
  signature is verified as `SHA256withRSA` over the same component/string-to-sign.

When `DOKU_SECRET_KEY` is a real value, an invalid/missing signature → **`401`**
and the transaction is not modified. In mock mode (placeholder secret) the check
is skipped.

### Notification payloads

**non-SNAP** (`SUCCESS`/`FAILED`, order + transaction blocks):
```json
{
  "order": { "invoice_number": "INV-…", "amount": 25000, "status": "SUCCESS" },
  "transaction": { "status": "SUCCESS", "original_request_id": "…" },
  "channel": { "id": "QRIS_DOKU" }
}
```

**SNAP** (numeric `latestTransactionStatus`):
```json
{
  "originalPartnerReferenceNo": "INV-…",
  "originalReferenceNo": "…",
  "latestTransactionStatus": "00",
  "transactionStatusDesc": "Success",
  "amount": { "value": "25000.00", "currency": "IDR" }
}
```

---

## 4. Status mapping

`mapDokuStatus()` normalises all vocabularies to internal statuses:

| DOKU value | Internal |
| --- | --- |
| `SUCCESS`, `SUCCESSFUL`, `PAID`, `SETTLED`, `"00"` | `SUCCESS` |
| `FAILED`, `FAILURE`, `DENIED`, `"06"`, `"01"` | `FAILED` |
| `EXPIRED`, `"03"`*(pending in SNAP — see note)* | `EXPIRED` |
| `CANCELLED`, `CANCELED`, `VOID`, `"05"` | `CANCELLED` |
| `PENDING`, `INITIATED`, `PROCESSING`, `"02"` | `PENDING` |
| `REFUNDED`, `REFUND`, `"04"` | `REFUNDED` |

> **Note:** SNAP uses `03` for *pending* while the non-SNAP QRIS legacy uses `03`
> for *expired*. The mapper accepts both `"03"` → `EXPIRED` (legacy) is
> intentionally avoided in SNAP notification handling, which reads
> `latestTransactionStatus` directly; adjust `mapDokuStatus` if your SNAP account
> emits other codes.

---

## 5. Environment variables

See [`backend/.env.example`](../backend/.env.example). Key variables:

```
DOKU_CLIENT_ID            # non-SNAP Client-Id / SNAP partner id base
DOKU_SECRET_KEY           # HMAC key (both flavours) + notification verification
DOKU_BASE_URL             # https://api-sandbox.doku.com | https://api.doku.com
DOKU_MERCHANT_ID          # QRIS merchant id
DOKU_TERMINAL_ID          # SNAP QRIS terminalId
DOKU_PARTNER_ID           # SNAP X-PARTNER-ID (defaults to client id)
DOKU_CHANNEL_ID           # SNAP CHANNEL-ID (H2H)
DOKU_API_FLAVOR           # nonsnap | snap (default)
DOKU_PRIVATE_KEY_PATH     # RSA key for SNAP Get-Token (SHA256withRSA)
DOKU_PUBLIC_KEY_PATH      # DOKU's public key for RSA webhook verification
```
