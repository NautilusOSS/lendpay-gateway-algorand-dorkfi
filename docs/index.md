# DorkFi gateway docs

- **[Repay flow](repay-flow.md)** — Base payment gate, idempotency, `/webhook/repay` vs `/webhook/repay/execute`, request/response shape, and error codes.
- **[Install on Ubuntu as a systemd service](install-ubuntu-service.md)** — production-style deploy with `systemd`, journal logs, and upgrades.
- **[Webhook API keys](webhook-api-keys.md)** — optional auth for `POST /webhook/repay` and `POST /webhook/repay/execute`, key generation, and `.env` layout.
