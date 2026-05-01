# DorkFi gateway docs

- **[Repay flow](repay-flow.md)** — Base payment gate, idempotency, `handleRepay` step-by-step (`src/routes/repay.ts`), `/webhook/repay` vs `/webhook/repay/execute`, request/response shape, and error codes.
- **[Manual testing](manual-testing.md)** — local run, health/chains/debt checks, repay cURL patterns, idempotency, and failure matrix.
- **[Install on Ubuntu as a systemd service](install-ubuntu-service.md)** — production-style deploy with `systemd`, journal logs, and upgrades.
- **[Webhook API keys](webhook-api-keys.md)** — optional auth for `POST /webhook/repay` and `POST /webhook/repay/execute`, key generation, and `.env` layout.
