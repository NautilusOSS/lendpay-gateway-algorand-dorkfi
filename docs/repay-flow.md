# Repay flow

The repay webhooks tie a **Base** payment receipt to **DorkFi** repayment on **Algorand** (or Voi, depending on `chain`). Each successful call proves payment once per `basePaymentTxId`, then either returns unsigned transactions for the user to sign or submits a signed group from the server.

## Endpoints

| Method | Path | Behavior |
|--------|------|----------|
| `POST` | `/webhook/repay` | Validate Base payment, resolve idempotency, build an **unsigned** atomic txn group (base64). |
| `POST` | `/webhook/repay/execute` | Same as above, then **sign** with `SERVER_SIGNER_MNEMONIC` and submit to the network. |

When [webhook API keys](webhook-api-keys.md) are configured, both routes require authentication.

## Request processing order

The shared implementation is **`handleRepay`** in `src/routes/repay.ts`. **`POST /webhook/repay`** calls it with `execute = false`; **`POST /webhook/repay/execute`** calls it with `execute = true`. The handler runs steps in this order:

1. **Parse and validate** the JSON body against `repayWebhookBodySchema` (400 `VALIDATION_ERROR` with `details` from Zod on failure).
2. **Idempotency** (`resolvePaymentIdempotency`) using `basePaymentTxId` (normalized lowercase) and optional `requestId`, on a **lane** of either `unsigned` or `executed` (so the two routes do not share the same cache entry):
   - Same tx + same `requestId` + same lane as a prior success → return the **cached** success JSON immediately (no Base validation, no rebuild).
   - Same tx + **different** `requestId` than the one already bound to a successful use of that tx → 400 `PAYMENT_TX_ALREADY_USED`.
3. **Base payment validation** (`validateBasePaymentReceipt`): Base RPC, successful receipt, optional max age (`PAYMENT_MAX_AGE_SECONDS`; skipped when `0`), receiver, token, minimum amount per `.env`. Failures are 400 with a `PAYMENT_*` code from `PaymentValidationError`, except unexpected errors → 500 `INTERNAL_ERROR` (“Payment validation failed”).
4. **Borrower and payer:** trim `userAddress` → **borrower**; **payer** = `payerAddress` trimmed if present, else borrower. Validate both with `algosdk.isValidAddress` (400 `INVALID_ALGORAND_ADDRESS`).
5. **Chain** via `getChainConfig(body.chain)` (400 `UNSUPPORTED_CHAIN`).
6. **Build DorkFi repay group** (`buildDorkFiRepayGroup` with `repayMaxBuffer()` from `REPAY_MAX_BUFFER_BASE_UNITS`): Algod client for the chain; debt snapshot for **borrower**; then **`buildRepayOnBehalfGroupArccjs`** (`src/services/repayGroupArccjs.ts`) uses **ulujs** `CONTRACT` with **`abi.nt200`** on the token app and a minimal pool ABI for **`repay_on_behalf`**, assembled via **`abi.custom`** on the pool with `setEnableGroupResourceSharing`, optional **beacon** on `algorand-mainnet`, and the same **`[p1,p2]`** retry grid as dorkfi-app for optional `createBalanceBox` / extra payments. Outcomes:
   - `DorkfiNotConfiguredError` → 503 `DORKFI_NOT_CONFIGURED` plus `details` and an expanded `message`.
   - `REPAY_EXCEEDS_DEBT` / `REPAY_AMOUNT_INVALID` → 400 with those codes.
   - Any other build error → 500 `INTERNAL_ERROR` (“Failed to build repay transaction group”).
7. **Branch on `execute`:**
   - **`false` (`/webhook/repay`):** Encode each txn with `algosdk.encodeUnsignedTransaction`, base64, `recordSuccessfulRepay` on the **unsigned** lane, respond `200` with `mode: "unsigned"`.
   - **`true` (`/webhook/repay/execute`):** If `SERVER_SIGNER_MNEMONIC` is missing → 503 `EXECUTE_NOT_CONFIGURED`. Compare **canonical** Algorand address from the mnemonic to **payer** (400 `SIGNER_MISMATCH` with `details.mnemonicDerives`, `payerAddress`, `userAddress`, `payerIsBorrower` if mismatch). Sign the group with the mnemonic, `sendAndConfirmGroup` on Algod. On submit/confirm failure → **`ALGOD_ERROR`** with `message` / `details` from `describeAlgodFailure` (HTTP status from `httpStatusForAlgodFailure`, often **400** for rejected txns, **504** for confirmation timeout, **502** for other Algod client errors). On success → `recordSuccessfulRepay` on the **executed** lane, respond `200` with `mode: "executed"`, `txIds`, `confirmedRound`.

Successful responses are stored by `basePaymentTxId` (per lane) so replays stay consistent.

## `handleRepay` reference

| Concern | Behavior |
|--------|----------|
| **Entry** | `handleRepay(req, res, execute)` — only `execute` differs between the two POST routes. |
| **Webhook auth** | `requireWebhookApiKey` runs on the router **before** `handleRepay` (see [webhook API keys](webhook-api-keys.md)). |
| **Borrower vs payer** | Debt and `repay_on_behalf` beneficiary use **borrower** (`userAddress`). **Sender** of the wrap (`axfer` + nt200 app calls) and pool `repay_on_behalf` is **payer** (`payerAddress` or borrower). Execute mode requires the mnemonic to match **payer**, not only the borrower. |
| **Idempotency lanes** | `unsigned` vs `executed` — same `basePaymentTxId` + `requestId` can succeed on `/repay` then on `/repay/execute` without conflict. |
| **Errors not listed in “repay-specific”** | Payment validation uses the shared `PAYMENT_*` codes; Algod failures on execute use `ALGOD_ERROR`. Unhandled exceptions propagate to the global Express error handler (`500` `INTERNAL_ERROR`). |

## Request body

All fields are required except `requestId` and **`payerAddress`**.

```json
{
  "userAddress": "<borrower Algorand address>",
  "payerAddress": "<optional payer; defaults to userAddress>",
  "marketAppId": 123,
  "assetId": 456,
  "repayAmount": "1.0",
  "repayMode": "exact",
  "chain": "algorand-mainnet",
  "basePaymentTxId": "0x…",
  "requestId": "optional-correlation-id"
}
```

- **`userAddress`:** Borrower whose debt is read and who is passed as the **`repay_on_behalf`** beneficiary (`address` arg) and in app **accounts**.
- **`payerAddress`:** Optional. Account that **sends** the ASA wrap + nt200 approvals and the **pool** `repay_on_behalf` app call (must match `SERVER_SIGNER_MNEMONIC` on execute). Omit for self-repay (`payerAddress` = `userAddress`).
- **`chain`:** One of `algorand-mainnet`, `algorand-testnet`, `voi-mainnet`, `voi-testnet`.
- **`marketAppId`:** Lending pool **`underlyingContractId`** (second argument to pool `get_user` / `get_market` in dorkfi-app), not an arbitrary label.
- **`repayMode`:** `exact` — `repayAmount` is a **decimal string** in human units; the service converts using the asset’s on-chain decimals. `max` — repays **current on-chain debt** plus `REPAY_MAX_BUFFER_BASE_UNITS` (optional env, default `0`).
- **`basePaymentTxId`:** 32-byte EVM transaction hash on **Base**; acts as the payment proof and idempotency anchor.

## Success responses

**Unsigned** (`POST /webhook/repay`):

- `ok`, `mode: "unsigned"`, `requestId` (echoed or `null`), `repayAmountBaseUnits` (string integer), `transactions` (array of base64-encoded unsigned Algorand transactions).

**Executed** (`POST /webhook/repay/execute`):

- `ok`, `mode: "executed"`, `requestId`, `txIds`, `confirmedRound`.

## Error codes (repay-specific)

Beyond [payment validation errors](../README.md#payment-errors-examples) and generic `VALIDATION_ERROR` / `INTERNAL_ERROR` (build or payment validation edge cases):

| Code | Typical cause |
|------|----------------|
| `UNSUPPORTED_CHAIN` | `chain` not in the supported set. |
| `INVALID_ALGORAND_ADDRESS` | `userAddress` or optional `payerAddress` fails Algorand format check. |
| `REPAY_AMOUNT_INVALID` | Non-positive or unparseable amount for `exact` mode. |
| `REPAY_EXCEEDS_DEBT` | `exact` amount greater than current on-chain debt. |
| `DORKFI_NOT_CONFIGURED` | Pool ABI debt read failed (`get_user` / `get_market` simulation), invalid `marketAppId`, wrong **`assetId`** for nt200 (e.g. nToken **app** id instead of **underlying ASA** for `deposit` / `xaid`), missing `DORKFI_LENDING_POOL_APP_ID` when the pool differs from `marketAppId`, or decimals could not be read (neither ASA nor app global `decimals`). The JSON **`message`** summarizes the cause; **`details`** repeats `poolAppId`, `marketAppId`, `assetId`, `userAddress`, and the raw `DORKFI_LENDING_POOL_APP_ID` env string. |
| `EXECUTE_NOT_CONFIGURED` | Execute route called without `SERVER_SIGNER_MNEMONIC`. |
| `SIGNER_MISMATCH` | Mnemonic does not derive **`payerAddress`** (defaults to `userAddress` when `payerAddress` is omitted). |
| `ALGOD_ERROR` | **Execute only:** submit or confirmation failed on Algorand. `message` and `details` (e.g. `kind`, `httpStatus`, `algodMessage`, `poolError`) come from `describeAlgodFailure`; HTTP status is often **400** (rejected txn), **504** (not confirmed in time), or **502**. |
| `PAYMENT_TX_ALREADY_USED` | Same Base tx reused with a different `requestId` after a prior success bound that tx. |
| `UNAUTHORIZED` | `WEBHOOK_API_KEY` / `WEBHOOK_API_KEYS` is set but the request has no valid `x-api-key` or `Authorization: Bearer` header. |

## Idempotency semantics

- The in-memory store keys off **`basePaymentTxId`** (lowercased); the stored entry remembers the **`requestId`** (or a sentinel when omitted) that completed successfully, and **separately** caches **`POST /webhook/repay`** (`mode: "unsigned"`) vs **`POST /webhook/repay/execute`** (`mode: "executed"`). A successful unsigned response does **not** satisfy replay for execute: the same `basePaymentTxId` + `requestId` can first hit `/repay`, then `/repay/execute`, without `PAYMENT_TX_ALREADY_USED`.
- **Replay:** identical `basePaymentTxId`, identical `requestId`, and the **same route** (`/repay` vs `/repay/execute`) returns the **same** success payload for that route without re-running the pipeline.
- **Conflict:** same `basePaymentTxId` with a **different** `requestId` after any success on that tx → `PAYMENT_TX_ALREADY_USED`.

The store is **in process memory**; restart clears it — not safe for multi-instance production without external persistence (see README TODOs).

## Configuration touchpoints

- **Base gate:** `BASE_RPC_URL`, `PAYMENT_RECEIVER_ADDRESS`, `PAYMENT_TOKEN_ADDRESS`, `REQUIRED_PAYMENT_AMOUNT`, `PAYMENT_MAX_AGE_SECONDS` (default `60`; set to `0` to accept payments of any age) — see [.env.example](../.env.example).
- **Repay build:** Algod URLs per chain, `DORKFI_LENDING_POOL_APP_ID` (pool for ABI reads; optional if same as `marketAppId`), body `marketAppId` + `assetId`, `REPAY_MAX_BUFFER_BASE_UNITS`.
- **Execute only:** `SERVER_SIGNER_MNEMONIC` must derive **`payerAddress`** (or **`userAddress`** when `payerAddress` is omitted).
- **Optional auth:** [Webhook API keys](webhook-api-keys.md).

## Related API

- **`GET /pools/:poolAppId/markets/:marketAppId/debt/:userAddress`** — preview debt via pool `get_market` / `get_user` (path `marketAppId` = `underlyingContractId`); optional `chain`. Example mainnet: pool **3333688282** (Algorand A), `marketAppId` **3210682240** (USDC).

For cURL examples and implementation TODOs (on-chain wiring, persistence), see the [project README](../README.md).
