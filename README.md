# DorkFi repay gateway

Minimal **Express + TypeScript** webhook service: verify a **Base** payment receipt, then build or execute a **DorkFi** debt repayment group on **Algorand** (ARC-200 / ASA path is scaffolded with TODOs).

## Prerequisites

- Node.js 20+
- A Base RPC endpoint (`BASE_RPC_URL`)
- Algod (and indexer env vars for future use) reachable for your target chain
- For production debt math: set `DORKFI_BORROW_INDEX_GLOBAL_KEY` and `DORKFI_SCALED_BORROW_LOCAL_KEY` to the UTF-8 keys used in the deployed market’s global / local state

## Setup

```bash
cd dorkfi-gateway
cp .env.example .env
# Edit .env — never commit secrets
npm install
npm run dev
# or: npm run build && npm start
```

## Environment

See [.env.example](.env.example) for all variables. Highlights:

| Variable | Role |
|----------|------|
| `BASE_RPC_URL` | Base JSON-RPC for receipt + block time checks |
| `PAYMENT_RECEIVER_ADDRESS` | Expected payee (checksummed EVM address) |
| `PAYMENT_TOKEN_ADDRESS` | ERC-20 address, or `NATIVE` / empty / zero address for ETH |
| `REQUIRED_PAYMENT_AMOUNT` | Minimum amount (wei or token smallest units, integer string) |
| `PAYMENT_MAX_AGE_SECONDS` | Max age of payment block timestamp (default `60`) |
| `DORKFI_*_KEY` | TEAL state keys for borrow index (global) and scaled borrows (user local) |
| `SERVER_SIGNER_MNEMONIC` | Required only for **execute** mode; must derive **`userAddress`** |

Structured logs are JSON lines to stdout. **Mnemonics and private keys are never logged.**

## API

### `GET /health`

Liveness probe.

### `GET /chains`

Lists supported logical chains and echoes `DEFAULT_CHAIN`.

### `GET /markets/:marketAppId/debt/:userAddress?assetId=&chain=`

Preview on-chain debt (requires `assetId` query param, same ASA / ARC-200 id you repay with).  
Returns `configured: false` until the DorkFi state keys above match your deployment.

### `POST /webhook/repay`

Validates Base payment + builds an **unsigned** atomic group (base64-encoded unsigned txns for the client to sign).

### `POST /webhook/repay/execute`

Same validation + **signs** with `SERVER_SIGNER_MNEMONIC` and submits to Algorand.  
**Constraint:** the mnemonic must resolve to the same address as `userAddress` (custodial / rekeyed hot wallet pattern).

### Request body (both repay routes)

```json
{
  "userAddress": "ALGOADDRESS...",
  "marketAppId": 123,
  "assetId": 456,
  "repayAmount": "100.25",
  "repayMode": "exact",
  "chain": "algorand-mainnet",
  "basePaymentTxId": "0xabc...",
  "requestId": "optional-idempotency-key"
}
```

- `repayMode`: `exact` uses `repayAmount` (decimal string, token decimals from chain). `max` repays `currentDebt + REPAY_MAX_BUFFER_BASE_UNITS`.
- `basePaymentTxId`: **32-byte EVM tx hash**; used as anti-replay and tied to `requestId` for idempotency.

### Payment errors (examples)

| Code | When |
|------|------|
| `PAYMENT_TX_NOT_FOUND` | Invalid hash or RPC has no receipt |
| `PAYMENT_TX_FAILED` | Receipt status not success |
| `PAYMENT_TOO_OLD` | Block timestamp older than `PAYMENT_MAX_AGE_SECONDS` |
| `PAYMENT_RECEIVER_MISMATCH` | Wrong recipient |
| `PAYMENT_AMOUNT_TOO_LOW` | Below `REQUIRED_PAYMENT_AMOUNT` |
| `PAYMENT_TOKEN_MISMATCH` | e.g. native expected but only ERC-20 satisfies amount |
| `PAYMENT_TX_ALREADY_USED` | Same tx hash reused with a **different** `requestId` |

Used Base tx ids are stored **in memory** (Map); restart clears the set — see TODO for persistence.

## cURL examples

Replace placeholders. For payment demos you need a **real recent successful Base tx** paying the configured receiver/token/amount.

### Unsigned repay

```bash
curl -sS -X POST "http://localhost:3000/webhook/repay" \
  -H "content-type: application/json" \
  -d '{
    "userAddress":"YOUR_ALGORAND_ADDR",
    "marketAppId":123,
    "assetId":456,
    "repayAmount":"1.0",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xREPLACE_WITH_VALID_BASE_TX_HASH",
    "requestId":"req-001"
  }' | jq .
```

### Execute repay

```bash
curl -sS -X POST "http://localhost:3000/webhook/repay/execute" \
  -H "content-type: application/json" \
  -d '{
    "userAddress":"SAME_AS_MNEMONIC_DERIVED_ADDR",
    "marketAppId":123,
    "assetId":456,
    "repayAmount":"1.0",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xANOTHER_VALID_BASE_TX_HASH",
    "requestId":"req-002"
  }' | jq .
```

### Failure: payment too old

Use any **confirmed** Base tx whose block is older than `PAYMENT_MAX_AGE_SECONDS`:

```bash
curl -sS -X POST "http://localhost:3000/webhook/repay" \
  -H "content-type: application/json" \
  -d '{
    "userAddress":"YOUR_ALGORAND_ADDR",
    "marketAppId":123,
    "assetId":456,
    "repayAmount":"1.0",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xOLD_BLOCK_TX_HASH",
    "requestId":"req-old"
  }' | jq .
```

Expect `"error":"PAYMENT_TOO_OLD"`.

### Failure: reused payment with different request id

1. Call `/webhook/repay` successfully with `requestId":"a"` and a fresh `basePaymentTxId`.  
2. Call again with the **same** `basePaymentTxId` and `requestId":"b"`:

```bash
curl -sS -X POST "http://localhost:3000/webhook/repay" \
  -H "content-type: application/json" \
  -d '{
    "userAddress":"YOUR_ALGORAND_ADDR",
    "marketAppId":123,
    "assetId":456,
    "repayAmount":"1.0",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xSAME_TX_AS_STEP_1",
    "requestId":"different-id"
  }' | jq .
```

Expect `"error":"PAYMENT_TX_ALREADY_USED"`.

### Idempotent replay

Repeat the **exact** same body as a successful call (same `basePaymentTxId` + same `requestId`): the server returns the cached success payload without double-charging the proof.

## Implementation TODOs (on-chain wiring)

- **DorkFi:** real `sync_market` / `repay` method selectors, `appArgs` layout, `foreignApps` / `foreignAssets`, and **box** references for user / market slots.
- **ARC-200:** confirm whether repayment uses `axfer`, ARC-200 controller `appl`, or inner transactions; adjust `src/services/arc200.ts`.
- **Persistence:** replace in-memory used-tx map with Redis/DB for multi-instance deployments.

## License

MIT (add a license file if your org requires it).
