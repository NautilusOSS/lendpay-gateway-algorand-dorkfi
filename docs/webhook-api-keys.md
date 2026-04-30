# Webhook API keys

When `WEBHOOK_API_KEY` or `WEBHOOK_API_KEYS` is set, `POST /webhook/repay` and `POST /webhook/repay/execute` require a key via the `x-api-key` header or `Authorization: Bearer <key>`. See [.env.example](../.env.example).

## Generate keys on the command line

**Random hex (recommended, 32 bytes / 256 bits):**

```bash
openssl rand -hex 32
```

**Random base64 (compact string; avoid newlines):**

```bash
openssl rand -base64 32 | tr -d '\n'
```

**Another hex key (for a second client or rotation):**

```bash
openssl rand -hex 32
```

Copy the output into `.env` (never commit real keys):

```bash
# single key
WEBHOOK_API_KEY=paste-output-here

# or multiple comma-separated keys (no spaces unless intentional)
WEBHOOK_API_KEYS=key-for-service-a,key-for-service-b
```

Restart the server after changing environment variables.
