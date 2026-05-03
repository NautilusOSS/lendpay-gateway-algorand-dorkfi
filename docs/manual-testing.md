# Manual testing

Hands-on checks against a running gateway. Assumes a local or deployed instance and a filled `.env` (see [.env.example](../.env.example)). For behavior details, see [Repay flow](repay-flow.md) and the [README](../README.md).

Set a base URL for the examples:

```bash
export BASE_URL=http://localhost:3000
```

## 1. Run the server

```bash
npm install
cp .env.example .env   # if needed
# edit .env — for repay webhooks without a header, leave WEBHOOK_API_KEY / WEBHOOK_API_KEYS unset (see §5).
npm run dev
# or: npm run build && npm start
```

Confirm the process listens without startup errors (JSON logs on stdout).

## 2. Health and chains

**Liveness**

```bash
curl -sS "$BASE_URL/health" | jq .
```

Expect `{"ok":true}`.

**Chain catalog**

```bash
curl -sS "$BASE_URL/chains" | jq .
```

Expect `defaultChain` and a `chains` list aligned with your `ALGOD_*` / per-chain overrides.

## 3. Debt preview (no Base payment)

Uses Algod only; good sanity check before repay.

```bash
# Example mainnet DorkFi: pool 3333688282 (Algorand A), market 3210682240 (USDC) — replace YOUR_ALGORAND_ADDR.
curl -sS "$BASE_URL/pools/3333688282/markets/3210682240/debt/YOUR_ALGORAND_ADDR?chain=algorand-mainnet" | jq .
```

Use a real **pool** id and **`underlyingContractId`** as `marketAppId` (same pair as dorkfi-app `get_user` / `get_market`; the example USDC id **3210682240** is that contract id). Debt is read via **ABI simulation** on the pool — no TEAL key env vars. Decimals come from the resolved token as either an ASA (`decimalsSource`: **`asa`**) or an ARC-200 **nToken application** (`decimalsSource`: **`arc200_application`**, reading global `decimals`). If simulation or that metadata read fails, `configured` is **false**.

When **`decimalsSource`** is **`arc200_application`**, JSON **`assetId`** is the nToken **app** id from `get_market`, not the underlying ASA. **`POST /webhook/repay`** still needs the **underlying ASA** id for nt200 `deposit` (e.g. mainnet USDC **31566704** for this example market — match your token config / dorkfi-app `underlyingAssetId`).

Invalid address returns **400**. Unknown apps or ASA usually return **404** `CHAIN_RESOURCE_NOT_FOUND`.

## 4. Base payment gate

Repay routes need a **successful Base mainnet** transaction hash in `basePaymentTxId` that satisfies:

- `PAYMENT_RECEIVER_ADDRESS` — must be a **non-zero** Base payee. For **native** ETH (`PAYMENT_TOKEN_ADDRESS` empty or `NATIVE` / `ETH`), the tx’s **`to`** must equal this address or you get **`PAYMENT_RECEIVER_MISMATCH`**. If the tx **`to`** is **Base USDC** (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) while the server is in native mode, you get **`PAYMENT_TOKEN_MISMATCH`** with a hint to set `PAYMENT_TOKEN_ADDRESS` to that USDC address. For **ERC-20**, the payee is determined from each `Transfer` event’s **`to`**, from **EIP-3009** `transferWithAuthorization` / `receiveWithAuthorization` **`to`** on the payment token, and from **Permit2** `permitTransferFrom` **`transferDetails.to`** when `permitted.token` is `PAYMENT_TOKEN_ADDRESS`. Batches are unpacked for **Multicall3 `aggregate3`**, **Multicall2 `aggregate`**, and nested Multicall3. The outer transaction **`to`** is often a facilitator; it is not used for ERC-20 recipient checks. If the required amount is not credited to this address by those signals, you get **`PAYMENT_RECEIVER_MISMATCH`** or **`PAYMENT_AMOUNT_TOO_LOW`** as appropriate.
- `PAYMENT_TOKEN_ADDRESS` (native vs ERC-20)
- `REQUIRED_PAYMENT_AMOUNT` (wei or token smallest units)

**Age window:** If `PAYMENT_MAX_AGE_SECONDS` is a positive number, the payment block must be within that many seconds of the server clock; otherwise you get **`PAYMENT_TOO_OLD`**. The message text includes that limit (e.g. **`older than 60s`** means the process still sees the **default 60**, not `0` — wrong `.env` for that process, cwd, or restart needed). **`export PAYMENT_MAX_AGE_SECONDS=0` in your shell does not change a running server**; put the value in `.env` (or the process manager’s env) and **restart** the gateway. On startup, JSON logs include `paymentMaxAgeSeconds` under `server_listen` so you can confirm what loaded. Use a **very recent** Base tx, raise the limit, or set **`PAYMENT_MAX_AGE_SECONDS=0`** (no spaces around `=`, then restart) to disable the check. See [README environment table](../README.md#environment).

Obtain a hash from a block explorer or your own wallet (same network as `BASE_RPC_URL` — expected to be Base).

## 5. Unsigned repay (`POST /webhook/repay`)

**Webhook API key:** If `.env` sets `WEBHOOK_API_KEY` or `WEBHOOK_API_KEYS`, every repay request **must** send that key or the server responds with **`401`** and **`"error":"UNAUTHORIZED"`** (not a payment/body validation error). For copy-paste testing without auth, comment those variables out and restart. Details: [webhook API keys](webhook-api-keys.md).

**Before the curl:** Run §3 debt preview for your borrower. Use the same **`marketAppId`** as in the path (`underlyingContractId`). Set repay **`assetId`** to the **underlying ASA** used for nt200 wrap (same as dorkfi-app `underlyingAssetId` / `xaid`). If the debt preview shows **`decimalsSource":"asa"`** and a single ASA id, that same id is usually correct for repay. If it shows **`decimalsSource":"arc200_application"`**, the preview **`assetId`** is an app id — **do not** paste it into repay; use the underlying ASA (e.g. **31566704** for mainnet USDC here). Use a **recent** successful Base tx hash for **`basePaymentTxId`** that satisfies §4.

**Self-repay** (borrower signs and pays; omit **`payerAddress`**) when **no** webhook key is configured:

```bash
curl -sS -X POST "$BASE_URL/webhook/repay" \
  -H "content-type: application/json" \
  -d '{
    "userAddress":"YOUR_BORROWER_ALGORAND_ADDR",
    "marketAppId":3210682240,
    "assetId":31566704,
    "repayAmount":"0.1",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xYOUR_VALID_BASE_TX",
    "requestId":"manual-test-1"
  }' | jq .
```

(`assetId` **31566704** is the underlying mainnet USDC ASA for nt200 deposit in this example; see §3 when the debt preview uses **`arc200_application`**.)

When a webhook key **is** configured, add the header (same body shape):

```bash
export WEBHOOK_API_KEY=your_key   # or paste inline below
curl -sS -X POST "$BASE_URL/webhook/repay" \
  -H "content-type: application/json" \
  -H "x-api-key: $WEBHOOK_API_KEY" \
  -d '{
    "userAddress":"YOUR_BORROWER_ALGORAND_ADDR",
    "marketAppId":3210682240,
    "assetId":31566704,
    "repayAmount":"0.1",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xYOUR_VALID_BASE_TX",
    "requestId":"manual-test-1"
  }' | jq .
```

(`Authorization: Bearer $WEBHOOK_API_KEY` works too.)

**Repay on behalf** (optional **`payerAddress`** = hot wallet that will **`axfer`** and call **`repay_on_behalf`**; **`userAddress`** = borrower for debt read and app accounts):

```bash
curl -sS -X POST "$BASE_URL/webhook/repay" \
  -H "content-type: application/json" \
  -H "x-api-key: $WEBHOOK_API_KEY" \
  -d '{
    "userAddress":"YOUR_BORROWER_ALGORAND_ADDR",
    "payerAddress":"YOUR_PAYER_ALGORAND_ADDR",
    "marketAppId":3210682240,
    "assetId":31566704,
    "repayAmount":"0.1",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xYOUR_VALID_BASE_TX",
    "requestId":"manual-test-2"
  }' | jq .
```

**Success:** `ok: true`, `mode: "unsigned"`, non-empty `transactions` (base64), `repayAmountBaseUnits`. For **repay on behalf**, set optional **`payerAddress`** to the hot wallet that will sign and fund the ARC-200 transfer; **`userAddress`** stays the borrower (debt read + `repay_on_behalf` accounts). Execute mode checks the mnemonic against **`payerAddress`** (defaults to `userAddress`).

**Common failures:** `UNAUTHORIZED` (missing/wrong key when `WEBHOOK_API_KEY*` is set), `PAYMENT_TOO_OLD` (Base tx block older than `PAYMENT_MAX_AGE_SECONDS`; see §4), other `PAYMENT_*` receipt errors, `VALIDATION_ERROR`, `UNSUPPORTED_CHAIN`, `DORKFI_NOT_CONFIGURED` (wrong repay **`assetId`** for nt200 — use **underlying ASA**, not nToken app id when §3 shows **`arc200_application`**; see §5), `REPAY_EXCEEDS_DEBT`, `REPAY_AMOUNT_INVALID`.

## 6. Execute repay (`POST /webhook/repay/execute`)

Same JSON shape as §5, but the server **signs** with `SERVER_SIGNER_MNEMONIC` and submits the group. The mnemonic must derive **`payerAddress`** when set, otherwise **`userAddress`** (self-repay). **This spends real Algorand fees and can move loan state on-chain** — use testnet / small amounts unless you intend production effects.

Use a **new** `basePaymentTxId` (and usually a new `requestId`) from a fresh Base payment if you already consumed a prior hash. Omit `-H "x-api-key: …"` when webhook keys are **not** set in `.env` (see §5).

**Self-repay execute** (mnemonic = borrower):

```bash
curl -sS -X POST "$BASE_URL/webhook/repay/execute" \
  -H "content-type: application/json" \
  -H "x-api-key: $WEBHOOK_API_KEY" \
  -d '{
    "userAddress":"YOUR_BORROWER_ALGORAND_ADDR",
    "marketAppId":3210682240,
    "assetId":31566704,
    "repayAmount":"0.1",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xANOTHER_VALID_BASE_TX",
    "requestId":"manual-test-execute-1"
  }' | jq .
```

**On-behalf execute** (mnemonic = **`payerAddress`**, not the borrower):

```bash
curl -sS -X POST "$BASE_URL/webhook/repay/execute" \
  -H "content-type: application/json" \
  -H "x-api-key: $WEBHOOK_API_KEY" \
  -d '{
    "userAddress":"YOUR_BORROWER_ALGORAND_ADDR",
    "payerAddress":"YOUR_PAYER_ALGORAND_ADDR",
    "marketAppId":3210682240,
    "assetId":31566704,
    "repayAmount":"0.1",
    "repayMode":"exact",
    "chain":"algorand-mainnet",
    "basePaymentTxId":"0xANOTHER_VALID_BASE_TX",
    "requestId":"manual-test-execute-2"
  }' | jq .
```

Expect `mode: "executed"`, `txIds`, `confirmedRound` on success. `EXECUTE_NOT_CONFIGURED` if the mnemonic env is missing; **`SIGNER_MISMATCH`** if the mnemonic does not match **`payerAddress`** (or **`userAddress`** when `payerAddress` is omitted).

## 7. Idempotency

1. **Replay (per route):** Send the **identical** JSON (same `basePaymentTxId` and `requestId`) to the **same** endpoint as a prior success (`POST .../repay` or `POST .../repay/execute`). Expect the **same** success payload for that route; server should not require a new Base payment.
2. **Unsigned then execute:** A successful **`/webhook/repay`** (unsigned base64 txns) does **not** block **`/webhook/repay/execute`** with the same `basePaymentTxId` and `requestId`; execute runs signing/submit unless execute already succeeded (then execute replays `mode: "executed"`).
3. **Conflict:** After a success on a Base tx, call again with the **same** `basePaymentTxId` but a **different** `requestId`. Expect `PAYMENT_TX_ALREADY_USED`.
4. **Restart:** After restarting the process, the in-memory idempotency map is empty; the same Base tx may be accepted again if other checks pass (documented limitation).

## 8. Negative checks (quick matrix)

| Scenario | Expect |
|----------|--------|
| Malformed JSON / missing required field | `400`, `VALIDATION_ERROR` |
| Invalid `basePaymentTxId` (not 32-byte hex) | `PAYMENT_TX_NOT_FOUND` |
| Native ETH `to` ≠ `PAYMENT_RECEIVER_ADDRESS` | `PAYMENT_RECEIVER_MISMATCH` |
| Base USDC payment tx while `PAYMENT_TOKEN_ADDRESS` is unset / `NATIVE` / `ETH` | `PAYMENT_TOKEN_MISMATCH` (message tells you to set USDC) |
| `PAYMENT_RECEIVER_ADDRESS` is `0x000…0000` | `PAYMENT_RECEIVER_MISMATCH` (configure a real payee) |
| ERC-20: enough token in `Transfer` logs but none `to` = `PAYMENT_RECEIVER_ADDRESS` (e.g. paid facilitator only) | `PAYMENT_RECEIVER_MISMATCH` (message lists `Transfer` `to` addresses) |
| `userAddress` or optional `payerAddress` not valid Algorand | `INVALID_ALGORAND_ADDRESS` |
| Execute: mnemonic does not match `payerAddress` (or `userAddress` if payer omitted) | `SIGNER_MISMATCH` |
| Unknown `chain` | `UNSUPPORTED_CHAIN` |
| `repayAmount` invalid for `exact` | `REPAY_AMOUNT_INVALID` |
| `exact` amount above on-chain debt | `REPAY_EXCEEDS_DEBT` |
| Repay `assetId` wrong (placeholder, wrong network, or nToken **app** id instead of underlying ASA for nt200) | `503` `DORKFI_NOT_CONFIGURED` — use underlying ASA for repay; see §3 `decimalsSource` |
| Base tx confirmed but block older than `PAYMENT_MAX_AGE_SECONDS` (default 60s) | `PAYMENT_TOO_OLD` — use a newer tx, increase the env, or **`0`** to disable (§4) |

## 9. Logs

Watch stdout for structured JSON lines (`server_listen`, `dorkfi_repay_group_built`, errors). Mnemonics are not logged.
