# Repay flow

The repay webhooks tie a **Base** payment receipt to **DorkFi** repayment on **Algorand** (or Voi, depending on `chain`). Each successful call proves payment once per `basePaymentTxId`, then either returns unsigned transactions for the user to sign or submits a signed group from the server.

## Endpoints

| Method | Path | Behavior |
|--------|------|----------|
| `POST` | `/webhook/repay` | Validate Base payment, resolve idempotency, build an **unsigned** atomic txn group (base64). |
| `POST` | `/webhook/repay/execute` | Same as above, then **sign** with `SERVER_SIGNER_MNEMONIC` and submit to the network. |

When [webhook API keys](webhook-api-keys.md) are configured, both routes require authentication.

## Request processing order

The handler runs steps in this order (see `src/routes/repay.ts`):

1. **Parse and validate** the JSON body against the schema (400 `VALIDATION_ERROR` on failure).
2. **Idempotency** using `basePaymentTxId` (case-insensitive) and optional `requestId`:
   - Same tx + same `requestId` as a prior success → return the **cached** success JSON (no re-validation of Base or rebuild side effects beyond returning cache).
   - Same tx + **different** `requestId` than the stored success → 400 `PAYMENT_TX_ALREADY_USED`.
3. **Base payment validation** (`validateBasePaymentReceipt`): RPC on Base mainnet, receipt success, block age, receiver, token type, and minimum amount per `.env` (400 with payment error codes, or 500 if env is misconfigured).
4. **Algorand address** check on `userAddress` (400 `INVALID_ALGORAND_ADDRESS`).
5. **Chain** resolution via `getChainConfig` (400 `UNSUPPORTED_CHAIN` if not one of the supported chain ids).
6. **Build DorkFi repay group** (`buildDorkFiRepayGroup`): reads on-chain debt, applies `repayMode` / `repayAmount`, emits the atomic group. Can return `DORKFI_NOT_CONFIGURED`, `REPAY_EXCEEDS_DEBT`, `REPAY_AMOUNT_INVALID`, or 500 `INTERNAL_ERROR`.
7. **Branch:**
   - **`/webhook/repay`:** Encode unsigned txns, **record** success in the idempotency store, respond with `mode: "unsigned"`.
   - **`/webhook/repay/execute`:** Require `SERVER_SIGNER_MNEMONIC`, ensure derived address **equals** `userAddress` (400 `SIGNER_MISMATCH` or 503 `EXECUTE_NOT_CONFIGURED`), sign, send and confirm (502 `INTERNAL_ERROR` on Algorand failure), **record** success, respond with `mode: "executed"`.

Successful responses are stored by `basePaymentTxId` so replays stay consistent.

## Request body

All fields are required except `requestId`.

```json
{
  "userAddress": "<Algorand address>",
  "marketAppId": 123,
  "assetId": 456,
  "repayAmount": "1.0",
  "repayMode": "exact",
  "chain": "algorand-mainnet",
  "basePaymentTxId": "0x…",
  "requestId": "optional-correlation-id"
}
```

- **`chain`:** One of `algorand-mainnet`, `algorand-testnet`, `voi-mainnet`, `voi-testnet`.
- **`repayMode`:** `exact` — `repayAmount` is a **decimal string** in human units; the service converts using the asset’s on-chain decimals. `max` — repays **current on-chain debt** plus `REPAY_MAX_BUFFER_BASE_UNITS` (optional env, default `0`).
- **`basePaymentTxId`:** 32-byte EVM transaction hash on **Base**; acts as the payment proof and idempotency anchor.

## Success responses

**Unsigned** (`POST /webhook/repay`):

- `ok`, `mode: "unsigned"`, `requestId` (echoed or `null`), `repayAmountBaseUnits` (string integer), `transactions` (array of base64-encoded unsigned Algorand transactions).

**Executed** (`POST /webhook/repay/execute`):

- `ok`, `mode: "executed"`, `requestId`, `txIds`, `confirmedRound`.

## Error codes (repay-specific)

Beyond [payment validation errors](../README.md#payment-errors-examples) and `VALIDATION_ERROR` / `INTERNAL_ERROR`:

| Code | Typical cause |
|------|----------------|
| `UNSUPPORTED_CHAIN` | `chain` not in the supported set. |
| `INVALID_ALGORAND_ADDRESS` | `userAddress` fails Algorand format check. |
| `REPAY_AMOUNT_INVALID` | Non-positive or unparseable amount for `exact` mode. |
| `REPAY_EXCEEDS_DEBT` | `exact` amount greater than current on-chain debt. |
| `DORKFI_NOT_CONFIGURED` | Missing `DORKFI_BORROW_INDEX_GLOBAL_KEY` / `DORKFI_SCALED_BORROW_LOCAL_KEY` for debt math. |
| `EXECUTE_NOT_CONFIGURED` | Execute route called without `SERVER_SIGNER_MNEMONIC`. |
| `SIGNER_MISMATCH` | Mnemonic does not derive `userAddress`. |
| `PAYMENT_TX_ALREADY_USED` | Same Base tx reused with a different `requestId` after a prior success bound that tx. |

## Idempotency semantics

- The in-memory store keys off **`basePaymentTxId` only** (lowercased); the stored entry remembers the **`requestId`** (or a sentinel when omitted) that completed successfully.
- **Replay:** identical `basePaymentTxId` **and** identical `requestId` (both absent counts as a pair) returns the **same** success payload without re-running the pipeline.
- **Conflict:** same `basePaymentTxId` with a **different** `requestId` after a success → `PAYMENT_TX_ALREADY_USED`.

The store is **in process memory**; restart clears it — not safe for multi-instance production without external persistence (see README TODOs).

## Configuration touchpoints

- **Base gate:** `BASE_RPC_URL`, `PAYMENT_RECEIVER_ADDRESS`, `PAYMENT_TOKEN_ADDRESS`, `REQUIRED_PAYMENT_AMOUNT`, `PAYMENT_MAX_AGE_SECONDS` — see [.env.example](../.env.example).
- **Repay build:** Algod URLs per chain, `DORKFI_*` keys, optional `DORKFI_LENDING_POOL_APP_ID`, `REPAY_MAX_BUFFER_BASE_UNITS`.
- **Execute only:** `SERVER_SIGNER_MNEMONIC` must match `userAddress` (custodial or rekeyed signer).
- **Optional auth:** [Webhook API keys](webhook-api-keys.md).

## Related API

- **`GET /markets/:marketAppId/debt/:userAddress`** — preview debt for the same `assetId` / `chain` you intend to repay (helps pick `repayAmount` or validate `max`).

For cURL examples and implementation TODOs (on-chain wiring, persistence), see the [project README](../README.md).
