import express from "express";
import algosdk from "algosdk";
import { repayWebhookBodySchema } from "../schemas/repayBody.js";
import type { ApiErrorResponse, ExecutedRepaySuccess, UnsignedRepaySuccess } from "../types.js";
import { getChainConfig } from "../config/chains.js";
import { makeAlgodClient, addressFromMnemonic, signTxnsWithMnemonic, sendAndConfirmGroup } from "../services/algorand.js";
import { validateBasePaymentReceipt, PaymentValidationError } from "../services/basePayment.js";
import { buildDorkFiRepayGroup, DorkfiNotConfiguredError } from "../services/dorkfi.js";
import { resolvePaymentIdempotency, recordSuccessfulRepay } from "../lib/idempotency.js";
import { describeAlgodFailure, httpStatusForAlgodFailure } from "../lib/algodHttp.js";
import { log } from "../lib/logger.js";
import { requireWebhookApiKey } from "../lib/webhookApiKey.js";

const router = express.Router();
router.use(requireWebhookApiKey);

function repayMaxBuffer(): bigint {
  const raw = process.env.REPAY_MAX_BUFFER_BASE_UNITS?.trim();
  if (!raw) {
    return 0n;
  }
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

function jsonError(res: express.Response, status: number, body: ApiErrorResponse): express.Response {
  return res.status(status).json(body);
}

function canonicalAlgorandAddress(addr: string): string {
  return algosdk.encodeAddress(algosdk.decodeAddress(addr).publicKey);
}

async function handleRepay(
  req: express.Request,
  res: express.Response,
  execute: boolean,
): Promise<void> {
  const parsed = repayWebhookBodySchema.safeParse(req.body);
  if (!parsed.success) {
    jsonError(res, 400, {
      ok: false,
      error: "VALIDATION_ERROR",
      message: "Invalid request body",
      details: parsed.error.flatten(),
    });
    return;
  }

  const body = parsed.data;
  const requestId = body.requestId ?? null;

  const idem = resolvePaymentIdempotency(
    body.basePaymentTxId,
    body.requestId,
    execute ? "executed" : "unsigned",
  );
  if (idem.kind === "replay") {
    res.json(idem.response);
    return;
  }
  if (idem.kind === "tx_used_other_request") {
    jsonError(res, 400, {
      ok: false,
      error: "PAYMENT_TX_ALREADY_USED",
      message: "This Base payment transaction was already used with a different requestId",
    });
    return;
  }

  try {
    await validateBasePaymentReceipt(body.basePaymentTxId);
  } catch (e) {
    if (e instanceof PaymentValidationError) {
      jsonError(res, 400, { ok: false, error: e.code, message: e.message });
      return;
    }
    log.error("base_payment_validation_error", { err: String(e) });
    jsonError(res, 500, { ok: false, error: "INTERNAL_ERROR", message: "Payment validation failed" });
    return;
  }

  const borrower = body.userAddress.trim();
  if (!algosdk.isValidAddress(borrower)) {
    jsonError(res, 400, {
      ok: false,
      error: "INVALID_ALGORAND_ADDRESS",
      message: "userAddress is not a valid Algorand address",
    });
    return;
  }

  const payer = body.payerAddress?.trim() ? body.payerAddress.trim() : borrower;
  if (!algosdk.isValidAddress(payer)) {
    jsonError(res, 400, {
      ok: false,
      error: "INVALID_ALGORAND_ADDRESS",
      message: "payerAddress is not a valid Algorand address",
    });
    return;
  }

  let chainCfg;
  try {
    chainCfg = getChainConfig(body.chain);
  } catch {
    jsonError(res, 400, {
      ok: false,
      error: "UNSUPPORTED_CHAIN",
      message: `Chain ${body.chain} is not supported`,
    });
    return;
  }

  const algod = makeAlgodClient(chainCfg.algod);

  let built;
  try {
    built = await buildDorkFiRepayGroup({
      algod,
      payerAddress: payer,
      userAddress: borrower,
      marketAppId: body.marketAppId,
      assetId: body.assetId,
      repayMode: body.repayMode,
      repayAmount: body.repayAmount,
      repayMaxBufferBaseUnits: repayMaxBuffer(),
      chainId: body.chain,
    });
  } catch (e) {
    if (e instanceof DorkfiNotConfiguredError) {
      const d = e.details;
      jsonError(res, 503, {
        ok: false,
        error: "DORKFI_NOT_CONFIGURED",
        message: `${d.reason} Context: DORKFI_LENDING_POOL_APP_ID=${d.dorkfiLendingPoolAppIdEnv || "(unset; using marketAppId as pool)"}, effective poolAppId=${d.poolAppId}, marketAppId (underlyingContractId)=${d.marketAppId}, webhook assetId=${d.assetId}, userAddress=${d.userAddress}. Align assetId with GET /pools/:poolAppId/markets/:marketAppId/debt/:userAddress when configured is true.`,
        details: d,
      });
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "REPAY_EXCEEDS_DEBT") {
      jsonError(res, 400, {
        ok: false,
        error: "REPAY_EXCEEDS_DEBT",
        message: "Repay amount exceeds current on-chain debt for exact mode",
      });
      return;
    }
    if (msg === "REPAY_AMOUNT_INVALID") {
      jsonError(res, 400, {
        ok: false,
        error: "REPAY_AMOUNT_INVALID",
        message: "Repay amount must be positive and parseable for this asset's decimals",
      });
      return;
    }
    log.error("dorkfi_build_failed", { err: msg });
    jsonError(res, 500, { ok: false, error: "INTERNAL_ERROR", message: "Failed to build repay transaction group" });
    return;
  }

  if (!execute) {
    const transactions = built.transactions.map((txn) =>
      Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64"),
    );
    const payload: UnsignedRepaySuccess = {
      ok: true,
      mode: "unsigned",
      requestId,
      repayAmountBaseUnits: built.repayAmountBaseUnits.toString(),
      transactions,
    };
    recordSuccessfulRepay(body.basePaymentTxId, body.requestId, payload);
    res.json(payload);
    return;
  }

  const mnemonic = process.env.SERVER_SIGNER_MNEMONIC?.trim();
  if (!mnemonic) {
    jsonError(res, 503, {
      ok: false,
      error: "EXECUTE_NOT_CONFIGURED",
      message: "SERVER_SIGNER_MNEMONIC is not set",
    });
    return;
  }

  const signerAddr = addressFromMnemonic(mnemonic);
  const signerCanon = canonicalAlgorandAddress(signerAddr);
  const payerCanon = canonicalAlgorandAddress(payer);
  if (signerCanon !== payerCanon) {
    const payerIsBorrower = payerCanon === canonicalAlgorandAddress(borrower);
    jsonError(res, 400, {
      ok: false,
      error: "SIGNER_MISMATCH",
      message: `SERVER_SIGNER_MNEMONIC derives ${signerCanon} but this request's payer is ${payerCanon}${
        payerIsBorrower
          ? " (payer defaulted from userAddress — use a mnemonic for that borrower, or set payerAddress to the account your mnemonic controls)."
          : " (set payerAddress to the account your mnemonic controls, or change SERVER_SIGNER_MNEMONIC)."
      }`,
      details: {
        mnemonicDerives: signerCanon,
        payerAddress: payerCanon,
        userAddress: canonicalAlgorandAddress(borrower),
        payerIsBorrower,
      },
    });
    return;
  }

  const signed = signTxnsWithMnemonic(mnemonic, built.transactions);
  let confirmedRound = 0;
  let txIds: string[] = [];
  try {
    const out = await sendAndConfirmGroup(algod, signed);
    confirmedRound = out.confirmedRound;
    txIds = out.txIds;
  } catch (e) {
    const desc = describeAlgodFailure(e);
    log.error("algorand_submit_failed", { ...desc.details, err: String(e) });
    jsonError(res, httpStatusForAlgodFailure(desc), {
      ok: false,
      error: "ALGOD_ERROR",
      message: desc.clientMessage,
      details: desc.details,
    });
    return;
  }

  const payload: ExecutedRepaySuccess = {
    ok: true,
    mode: "executed",
    requestId,
    txIds,
    confirmedRound,
  };
  recordSuccessfulRepay(body.basePaymentTxId, body.requestId, payload);
  res.json(payload);
}

router.post("/repay", (req, res, next) => {
  void handleRepay(req, res, false).catch(next);
});

router.post("/repay/execute", (req, res, next) => {
  void handleRepay(req, res, true).catch(next);
});

export default router;
