# Going live with the DOKU sandbox

This walkthrough takes you from mock mode to a real DOKU Jokul sandbox
integration.

## 1. Prerequisites

- A registered DOKU merchant account (business / KYC required).
- Access to the DOKU **Merchant Portal**: <https://dashboard.doku.com>.
- Node.js ≥ 20.

## 2. Get sandbox credentials

1. Log in to the DOKU dashboard.
2. Create a **Sandbox** application (or switch the environment toggle to Sandbox).
3. Open **Jokul → Settings → API Keys** and copy:
   - **Client-Id** (looks like `BRN-xxxx-xxxxxxxxxxxxxxxxxxxx`)
   - **Secret Key**
4. (Optional) If your account uses asymmetric keys, generate an RSA keypair and
   upload the public key:
   ```bash
   npm run keygen     # writes backend/certs/private_key.pem + public_key.pem
   ```

## 3. Configure the backend

Copy and edit the environment file:

```bash
cp backend/.env.example backend/.env
```

Set at minimum:

```env
DOKU_MOCK_MODE=false
DOKU_BASE_URL=https://api-sandbox.doku.com
DOKU_CLIENT_ID=BRN-xxxx-xxxxxxxxxxxxxxxxxxxx
DOKU_SECRET_KEY=your_secret_key
PUBLIC_BASE_URL=https://your-tunnel.example.com
```

## 4. Expose your local server

DOKU cannot reach `localhost`. Start a tunnel:

```bash
npx cloudflared tunnel --url http://localhost:4010
# or
ngrok http 4010
```

Copy the public HTTPS origin into `PUBLIC_BASE_URL`.

## 5. Register the notification URL

In the DOKU dashboard, set the **Payment Notification URL** to:

```text
https://your-tunnel.example.com/api/webhooks/doku
```

(and the **Disbursement Notification URL** to `.../api/webhooks/disburse`).

## 6. Verify

```bash
cd backend
npm run doku:ping
```

A green run means your credentials and signature are correct. You can also check
the runtime config:

```bash
curl -s http://localhost:4010/api/webhooks/config | jq
# expect: "mockMode": false, "hasSecretKey": true
```

## 7. Run a real payment

```bash
npm run dev
# open http://localhost:5174, create a payment, and complete it via the
# DOKU sandbox payment simulator.
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `401` / signature rejected | wrong `DOKU_SECRET_KEY`, or a body that was re-serialized after signing |
| `404` on an endpoint | product/API version not enabled on your account — confirm the path |
| Webhook not received | `PUBLIC_BASE_URL` / notification URL not reachable, or tunnel down |
| `DOKU_ERROR` with a code | DOKU rejected the business payload — read `dokuResponse` in the JSON |

> Always verify against the **sandbox** first. Switching `DOKU_BASE_URL` to
> `https://api.doku.com` uses real money.
