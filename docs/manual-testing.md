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

**Self-repay** (borrower signs and pays; omit **`payerAddress`**) when **no** webhook key is configured and **`SERVER_SIGNER_MNEMONIC` is unset** (otherwise the mnemonic account is always payer):

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

**Repay on behalf** (optional **`payerAddress`** only when **`SERVER_SIGNER_MNEMONIC` is unset** — hot wallet that will **`axfer`** and call **`repay_on_behalf`**; when the mnemonic is set, payer is always that account). **`userAddress`** = borrower for debt read and app accounts:

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

**Success:** `ok: true`, `mode: "unsigned"`, non-empty `transactions` (base64), `repayAmountBaseUnits`. For **repay on behalf** without **`SERVER_SIGNER_MNEMONIC`**, set optional **`payerAddress`** to the hot wallet that will sign and fund the ARC-200 transfer; with the mnemonic set, payer is always the mnemonic account. **`userAddress`** stays the borrower (debt read + `repay_on_behalf` accounts).

**Common failures:** `UNAUTHORIZED` (missing/wrong key when `WEBHOOK_API_KEY*` is set), `PAYMENT_TOO_OLD` (Base tx block older than `PAYMENT_MAX_AGE_SECONDS`; see §4), other `PAYMENT_*` receipt errors, `VALIDATION_ERROR`, `UNSUPPORTED_CHAIN`, `DORKFI_NOT_CONFIGURED` (wrong repay **`assetId`** for nt200 — use **underlying ASA**, not nToken app id when §3 shows **`arc200_application`**; see §5), `REPAY_EXCEEDS_DEBT`, `REPAY_AMOUNT_INVALID`, `PAYER_INSUFFICIENT_BALANCE` (payer lacks underlying ASA for the built repay amount after build).

## 6. Execute repay (`POST /webhook/repay/execute`)

Same JSON shape as §5, but the server **signs** with `SERVER_SIGNER_MNEMONIC` and submits the group. When the mnemonic env is set, **payer** is always that account (body `payerAddress` ignored). When unset, payer comes from **`payerAddress`** or **`userAddress`** and the mnemonic must match that payer. **This spends real Algorand fees and can move loan state on-chain** — use testnet / small amounts unless you intend production effects.

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

**On-behalf execute** (mnemonic = payer; when env is set, not the borrower unless same keys):

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

Expect `mode: "executed"`, `txIds`, `confirmedRound` on success. `EXECUTE_NOT_CONFIGURED` if the mnemonic env is missing or invalid; **`SIGNER_MISMATCH`** only when the mnemonic env is **unset** and the mnemonic does not match **`payerAddress`** / **`userAddress`**.

### KeeperHub workflow URLs

Workflow runners (e.g. KeeperHub) often require **`HTTP 200`** with explicit JSON so the step records **completion**. Use the **same JSON body** as §5–§6, but call:

- **`POST $BASE_URL/webhook/keeperhub/repay`** — unsigned group (same behavior as `/webhook/repay`).
- **`POST $BASE_URL/webhook/keeperhub/repay/execute`** — sign + submit (same as `/webhook/repay/execute`).

Responses always use **`Content-Type: application/json; charset=utf-8`**. **Success:** `{ "success": true, "status": "completed", "message": "Webhook processed successfully", "result": { "requestId", "mode", "txId", … } }`. **Failure:** `{ "success": false, "status": "failed", "message", "error", "result": { "requestId", "code", "details?" } }` with **HTTP 200** so the step is not treated as a transport hang. Gateway routes (`/webhook/repay*`) keep **`{ ok: … }`** and classic status codes (`400`, `503`, …).

Idempotency **lanes** (`unsigned` vs `executed`) are shared with the gateway paths: the same `basePaymentTxId` + `requestId` hits the same cache whether you call `/webhook/repay` or `/webhook/keeperhub/repay`; replay responses follow the **route you called** (KeeperHub shape only from the KeeperHub paths).

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
| Execute: mnemonic does not match resolved payer (only when `SERVER_SIGNER_MNEMONIC` was unset for payer resolution) | `SIGNER_MISMATCH` |
| Unknown `chain` | `UNSUPPORTED_CHAIN` |
| `repayAmount` invalid for `exact` | `REPAY_AMOUNT_INVALID` |
| `exact` amount above on-chain debt | `REPAY_EXCEEDS_DEBT` |
| Repay `assetId` wrong (placeholder, wrong network, or nToken **app** id instead of underlying ASA for nt200) | `503` `DORKFI_NOT_CONFIGURED` — use underlying ASA for repay; see §3 `decimalsSource` |
| Base tx confirmed but block older than `PAYMENT_MAX_AGE_SECONDS` (default 60s) | `PAYMENT_TOO_OLD` — use a newer tx, increase the env, or **`0`** to disable (§4) |

## 9. Logs

Watch stdout for structured JSON lines (`server_listen`, `dorkfi_repay_group_built`, errors). Mnemonics are not logged.

## 10. Direct Algorand repay script (no HTTP / no Base gate)

[`src/scripts/repaySmallUsdc.ts`](../src/scripts/repaySmallUsdc.ts) calls the same **`buildRepayOnBehalfGroupArccjs`** path as the gateway (nt200 `deposit` + `arc200_approve` + pool `repay_on_behalf`), signs with **`SERVER_SIGNER_MNEMONIC`**, and submits the group via **`sendAndConfirmGroup`**. Use it to debug arccjs / on-chain failures without Base payment or webhook idempotency.

```bash
export REPAY_BORROWER_ADDRESS=YOUR_BORROWER_ALGORAND_ADDR
# Same .env as the gateway: SERVER_SIGNER_MNEMONIC, ALGOD_*, and usually DORKFI_LENDING_POOL_APP_ID for pool ≠ market.
npm run script:repay-small-usdc
```

**Defaults:** `REPAY_AMOUNT` **`0.01`** (human USDC string), `REPAY_DECIMALS` **6**, `REPAY_MARKET_APP_ID` **3210682240**, `REPAY_UNDERLYING_ASA_ID` **31566704**, `REPAY_CHAIN` **`algorand-mainnet`**.

| Env | Role |
|-----|------|
| `SERVER_SIGNER_MNEMONIC` | **Required.** Payer; must hold enough underlying USDC + ALGO, opted into the ASA. |
| `REPAY_BORROWER_ADDRESS` | **Required.** `repay_on_behalf` beneficiary (borrower). |
| `DORKFI_LENDING_POOL_APP_ID` | Optional; if unset, script uses `REPAY_MARKET_APP_ID` as pool id (same fallback as gateway). |
| `REPAY_MARKET_APP_ID` | Optional; default **3210682240**. |
| `REPAY_UNDERLYING_ASA_ID` | Optional; default **31566704** (mainnet USDC ASA). |
| `REPAY_AMOUNT` | Optional; default **`0.01`** (decimal string, not micro-units). |
| `REPAY_DECIMALS` | Optional; default **6**. |
| `REPAY_CHAIN` | Optional; default **`algorand-mainnet`**. |

**Not included:** Base payment validation, debt ceiling (`REPAY_EXCEEDS_DEBT`), or webhook API keys. If `REPAY_AMOUNT` exceeds on-chain debt, Algod may reject the group with a logic error. **Mainnet spends real funds** — use testnet envs or tiny amounts unless intentional.

[`src/scripts/testRepayPayerBalance.ts`](../src/scripts/testRepayPayerBalance.ts) only calls **`assertPayerCanFundRepay`**: Algod **`accountInformation`** for the mnemonic account vs **`REPAY_UNDERLYING_ASA_ID`** and a required amount from **`REPAY_TEST_AMOUNT`** + **`REPAY_DECIMALS`** (no pool simulation, no arccjs build, no submit). Default amount is **`0.1`** with **6** decimals.

```bash
export SERVER_SIGNER_MNEMONIC="…"
npm run script:test-repay-payer-balance
```

Override: `REPAY_TEST_AMOUNT=0.01 REPAY_UNDERLYING_ASA_ID=31566704 npm run script:test-repay-payer-balance`.
