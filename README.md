# DorkFi repay gateway

Minimal **Express + TypeScript** webhook service: verify a **Base** payment receipt, then build or execute a **DorkFi** debt repayment group on **Algorand** (ARC-200 / ASA path is scaffolded with TODOs).

## Prerequisites

- Node.js 20+
- A Base RPC endpoint (`BASE_RPC_URL`)
- Algod (and indexer env vars for future use) reachable for your target chain
- For debt / repay math: set `DORKFI_LENDING_POOL_APP_ID` to the lending **pool** app when it differs from the webhook `marketAppId` (which must be the pool’s `underlyingContractId`, same as dorkfi-app `get_user` / `get_market`)

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
| `PAYMENT_TOKEN_ADDRESS` | ERC-20 address, or `NATIVE` / empty for native ETH (do not use `0x000…` as a stand-in for USDC) |
| `REQUIRED_PAYMENT_AMOUNT` | Minimum amount (wei or token smallest units, integer string) |
| `PAYMENT_MAX_AGE_SECONDS` | Max age of payment block vs server time (default `60`); `0` disables the check |
| `DORKFI_LENDING_POOL_APP_ID` | Lending pool app id for ABI `get_user` / `get_market` (defaults to webhook `marketAppId` when unset) |
| `SERVER_SIGNER_MNEMONIC` | Required only for **execute** mode; must derive **`userAddress`** |

Structured logs are JSON lines to stdout. **Mnemonics and private keys are never logged.**

## API

### `GET /health`

Liveness probe.

### `GET /chains`

Lists supported logical chains and echoes `DEFAULT_CHAIN`.

### `GET /pools/:poolAppId/markets/:marketAppId/debt/:userAddress?chain=`

Preview on-chain debt via the lending pool’s **`get_market`** / **`get_user`** ABI (same pattern as [dorkfi-app `fetchUserDataFromChain`](https://github.com/DorkFi/dorkfi-app/blob/next/src/services/lendingService.ts#L1376)): path `marketAppId` is the pool’s **`underlyingContractId`** (e.g. USDC market id). Optional `chain` query; defaults to `DEFAULT_CHAIN`.  
Response includes `assetId` / `underlyingContractId` when resolved (use `assetId` with `POST /webhook/repay` when it is the repay ASA).  
Returns `configured: false` if ABI simulation or ASA metadata lookup fails.  
JSON includes **`scaledDeposits` / `scaledBorrows`** (user `get_user`) and **`totalScaledDeposits` / `totalScaledBorrows`** (market `get_market` aggregates), all as decimal integer strings.

Example (Algorand mainnet): pool **3333688282** (Algorand A), market **3210682240** (USDC) — `GET /pools/3333688282/markets/3210682240/debt/<algorand-address>?chain=algorand-mainnet`.

### `POST /webhook/repay`

Validates Base payment + builds an **unsigned** atomic group (base64-encoded unsigned txns for the client to sign).

### `POST /webhook/repay/execute`

Same validation + **signs** with `SERVER_SIGNER_MNEMONIC` and submits to Algorand.  
**Constraint:** the mnemonic must resolve to **`payerAddress`**, or to **`userAddress`** if `payerAddress` is omitted (self-repay). Use **`payerAddress`** for repay-on-behalf when the server wallet pays the borrower’s loan.

### Request body (both repay routes)

```json
{
  "userAddress": "BORROWER_ALGO_ADDR...",
  "payerAddress": "PAYER_ALGO_ADDR...",
  "marketAppId": 123,
  "assetId": 456,
  "repayAmount": "100.25",
  "repayMode": "exact",
  "chain": "algorand-mainnet",
  "basePaymentTxId": "0xabc...",
  "requestId": "optional-idempotency-key"
}
```

`payerAddress` is optional; omit it to default the payer to `userAddress`. The market app call uses the **`repay_on_behalf`** method string (same style as `sync_market` in the scaffold).

- `marketAppId`: lending pool **`underlyingContractId`** (same as dorkfi-app `get_user` / `get_market`); must match the market you are repaying.
- `repayMode`: `exact` uses `repayAmount` (decimal string, token decimals from chain). `max` repays `currentDebt + REPAY_MAX_BUFFER_BASE_UNITS`.
- `basePaymentTxId`: **32-byte EVM tx hash**; used as anti-replay and tied to `requestId` for idempotency.

### Payment errors (examples)

| Code | When |
|------|------|
| `PAYMENT_TX_NOT_FOUND` | Invalid hash or RPC has no receipt |
| `PAYMENT_TX_FAILED` | Receipt status not success |
| `PAYMENT_TOO_OLD` | Block timestamp older than `PAYMENT_MAX_AGE_SECONDS` (never when that env is `0`) |
| `PAYMENT_RECEIVER_MISMATCH` | Native `to` wrong, or ERC-20 `Transfer` / EIP-3009 / Permit2 payee fields never credit receiver while enough token moved elsewhere (e.g. facilitator) |
| `PAYMENT_AMOUNT_TOO_LOW` | Below `REQUIRED_PAYMENT_AMOUNT` |
| `PAYMENT_TOKEN_MISMATCH` | e.g. native configured but the tx calls Base USDC; or native expected while only ERC-20 satisfies amount |
| `PAYMENT_TX_ALREADY_USED` | Same tx hash reused with a **different** `requestId` |

Used Base tx ids are stored **in memory** (Map), with **separate** cached success for **`/webhook/repay`** vs **`/webhook/repay/execute`** so unsigned then execute with the same `requestId` is allowed; restart clears the map — see TODO for persistence.

## cURL examples

Replace placeholders. For payment demos you need a **real recent successful Base tx** paying the configured receiver/token/amount. For **`marketAppId`** / **`assetId`**, use the same **`underlyingContractId`** and resolved **`assetId`** as in [manual testing §3](docs/manual-testing.md) (example USDC market **3210682240**, ASA **3333764003** — confirm with your debt GET).

If `WEBHOOK_API_KEY` / `WEBHOOK_API_KEYS` is set in `.env`, add `-H "x-api-key: <key>"` (or `Authorization: Bearer <key>`) to each repay curl or you get **`401` `UNAUTHORIZED`**. See [docs/webhook-api-keys.md](docs/webhook-api-keys.md).

### Unsigned repay

```bash
curl -sS -X POST "http://localhost:3000/webhook/repay" \
  -H "content-type: application/json" \
  -d '{
    "userAddress":"YOUR_BORROWER_ALGORAND_ADDR",
    "marketAppId":3210682240,
    "assetId":3333764003,
    "repayAmount":"0.1",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xREPLACE_WITH_VALID_BASE_TX_HASH",
    "requestId":"req-001"
  }' | jq .
```

### Execute repay

Mnemonic must match **`payerAddress`** if set, else **`userAddress`**.

```bash
curl -sS -X POST "http://localhost:3000/webhook/repay/execute" \
  -H "content-type: application/json" \
  -d '{
    "userAddress":"SAME_AS_MNEMONIC_DERIVED_ADDR",
    "marketAppId":3210682240,
    "assetId":3333764003,
    "repayAmount":"0.1",
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
    "userAddress":"YOUR_BORROWER_ALGORAND_ADDR",
    "marketAppId":3210682240,
    "assetId":3333764003,
    "repayAmount":"0.1",
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
    "userAddress":"YOUR_BORROWER_ALGORAND_ADDR",
    "marketAppId":3210682240,
    "assetId":3333764003,
    "repayAmount":"0.1",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xSAME_TX_AS_STEP_1",
    "requestId":"different-id"
  }' | jq .
```

Expect `"error":"PAYMENT_TX_ALREADY_USED"`.

### Idempotent replay

Repeat the **exact** same body to the **same** route as a successful call (same `basePaymentTxId` + same `requestId`): the server returns the cached success payload for that route without double-charging the proof. See [manual testing §7](docs/manual-testing.md) for unsigned vs execute replay.

## Implementation TODOs (on-chain wiring)

- **DorkFi:** additional pool methods / box refs beyond what the **ulujs/arccjs** builder covers, if any.
- **ARC-200 / nt200:** repay groups are built with **ulujs** `CONTRACT` + **arccjs** `abi.custom` (`src/services/repayGroupArccjs.ts`), mirroring dorkfi-app `repayOnBehalf` (deposit, approve, `repay_on_behalf`, optional `createBalanceBox` / payment retries, group resource sharing, mainnet beacon).
- **Persistence:** replace in-memory used-tx map with Redis/DB for multi-instance deployments.

## License

MIT (add a license file if your org requires it).
