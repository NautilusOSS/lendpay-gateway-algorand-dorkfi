import express from "express";
import algosdk from "algosdk";
import { repayWebhookBodySchema } from "../schemas/repayBody.js";
import type { ExecutedRepaySuccess, UnsignedRepaySuccess } from "../types.js";
import { getChainConfig } from "../config/chains.js";
import { makeAlgodClient, addressFromMnemonic, signTxnsWithMnemonic, sendAndConfirmGroup } from "../services/algorand.js";
import { validateBasePaymentReceipt, PaymentValidationError } from "../services/basePayment.js";
import { buildDorkFiRepayGroup, DorkfiNotConfiguredError } from "../services/dorkfi.js";
import { assertPayerCanFundRepay, PayerInsufficientBalanceError } from "../services/repayPayerPreflight.js";
import { resolvePaymentIdempotency, recordSuccessfulRepay } from "../lib/idempotency.js";
import { describeAlgodFailure, httpStatusForAlgodFailure } from "../lib/algodHttp.js";
import { log } from "../lib/logger.js";
import { requireWebhookApiKey } from "../lib/webhookApiKey.js";
import type { RepayWebhookFormat } from "../lib/keeperhubWebhook.js";
import { repaySendError, repaySendSuccess } from "../lib/keeperhubWebhook.js";

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

function canonicalAlgorandAddress(addr: string): string {
  return algosdk.encodeAddress(algosdk.decodeAddress(addr).publicKey);
}

function extractRequestIdFromReq(req: express.Request): string | null {
  const v = (req.body as { requestId?: unknown })?.requestId;
  return typeof v === "string" ? v : null;
}

async function handleRepayImpl(
  req: express.Request,
  res: express.Response,
  execute: boolean,
  format: RepayWebhookFormat,
): Promise<void> {
  log.info("repay_webhook_received", { execute, format });

  const parsed = repayWebhookBodySchema.safeParse(req.body);
  if (!parsed.success) {
    log.warn("repay_payload_invalid", { execute, format, issues: parsed.error.flatten() });
    repaySendError(res, format, {
      httpStatus: 400,
      code: "VALIDATION_ERROR",
      message: "Invalid request body",
      details: parsed.error.flatten(),
      requestId: extractRequestIdFromReq(req),
    });
    return;
  }

  const body = parsed.data;
  const requestId = body.requestId ?? null;
  log.info("repay_payload_validated", { execute, format, requestId });

  const idem = resolvePaymentIdempotency(
    body.basePaymentTxId,
    body.requestId,
    execute ? "executed" : "unsigned",
  );
  if (idem.kind === "replay") {
    log.info("repay_idempotent_replay", { execute, format, requestId });
    repaySendSuccess(res, format, idem.response);
    return;
  }
  if (idem.kind === "tx_used_other_request") {
    repaySendError(res, format, {
      httpStatus: 400,
      code: "PAYMENT_TX_ALREADY_USED",
      message: "This Base payment transaction was already used with a different requestId",
      requestId,
    });
    return;
  }

  try {
    await validateBasePaymentReceipt(body.basePaymentTxId);
  } catch (e) {
    if (e instanceof PaymentValidationError) {
      log.warn("repay_base_payment_rejected", { execute, format, code: e.code, requestId });
      repaySendError(res, format, {
        httpStatus: 400,
        code: e.code,
        message: e.message,
        requestId,
      });
      return;
    }
    log.error("base_payment_validation_error", { execute, format, requestId, err: String(e) });
    repaySendError(res, format, {
      httpStatus: 500,
      code: "INTERNAL_ERROR",
      message: "Payment validation failed",
      requestId,
    });
    return;
  }

  const borrower = body.userAddress.trim();
  if (!algosdk.isValidAddress(borrower)) {
    repaySendError(res, format, {
      httpStatus: 400,
      code: "INVALID_ALGORAND_ADDRESS",
      message: "userAddress is not a valid Algorand address",
      requestId,
    });
    return;
  }

  const mnemonicTrimmed = process.env.SERVER_SIGNER_MNEMONIC?.trim() ?? "";
  let payer: string;
  if (mnemonicTrimmed) {
    try {
      payer = canonicalAlgorandAddress(addressFromMnemonic(mnemonicTrimmed));
    } catch {
      repaySendError(res, format, {
        httpStatus: 503,
        code: "EXECUTE_NOT_CONFIGURED",
        message: "SERVER_SIGNER_MNEMONIC is invalid or could not derive an account",
        requestId,
      });
      return;
    }
    if (body.payerAddress?.trim()) {
      const requested = canonicalAlgorandAddress(body.payerAddress.trim());
      if (requested !== payer) {
        log.info("repay_payer_from_mnemonic_ignores_body", {
          bodyPayerAddress: requested,
          payerFromMnemonic: payer,
        });
      }
    }
  } else {
    payer = body.payerAddress?.trim() ? body.payerAddress.trim() : borrower;
    if (!algosdk.isValidAddress(payer)) {
      repaySendError(res, format, {
        httpStatus: 400,
        code: "INVALID_ALGORAND_ADDRESS",
        message: "payerAddress is not a valid Algorand address",
        requestId,
      });
      return;
    }
    payer = canonicalAlgorandAddress(payer);
  }

  let chainCfg;
  try {
    chainCfg = getChainConfig(body.chain);
  } catch {
    repaySendError(res, format, {
      httpStatus: 400,
      code: "UNSUPPORTED_CHAIN",
      message: `Chain ${body.chain} is not supported`,
      requestId,
    });
    return;
  }

  const algod = makeAlgodClient(chainCfg.algod);

  log.info("repay_build_started", { execute, format, requestId, marketAppId: body.marketAppId });
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
      log.warn("repay_dorkfi_not_configured", { execute, format, requestId, details: d });
      repaySendError(res, format, {
        httpStatus: 503,
        code: "DORKFI_NOT_CONFIGURED",
        message: `${d.reason} Context: DORKFI_LENDING_POOL_APP_ID=${d.dorkfiLendingPoolAppIdEnv || "(unset; using marketAppId as pool)"}, effective poolAppId=${d.poolAppId}, marketAppId (underlyingContractId)=${d.marketAppId}, webhook assetId=${d.assetId}, userAddress=${d.userAddress}. For nt200 markets, webhook assetId must be the underlying ASA used in deposit (xaid), not the nToken app id from the debt preview. When the debt preview shows decimalsSource arc200_application, use your token’s underlying ASA (e.g. mainnet USDC 31566704) unless you know another id from your app config.`,
        details: d,
        requestId,
      });
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "REPAY_EXCEEDS_DEBT") {
      repaySendError(res, format, {
        httpStatus: 400,
        code: "REPAY_EXCEEDS_DEBT",
        message: "Repay amount exceeds current on-chain debt for exact mode",
        requestId,
      });
      return;
    }
    if (msg === "REPAY_AMOUNT_INVALID") {
      repaySendError(res, format, {
        httpStatus: 400,
        code: "REPAY_AMOUNT_INVALID",
        message: "Repay amount must be positive and parseable for this asset's decimals",
        requestId,
      });
      return;
    }
    log.error("dorkfi_build_failed", { execute, format, requestId, err: msg });
    const arccjs = msg.startsWith("ARCCJS_REPAY_BUILD_FAILED:");
    const logicEval = /logic eval error/i.test(msg);
    const hint = logicEval
      ? "Simulation failed inside a contract (see buildError for app id / pc). Common causes: payer lacks enough underlying USDC (ASA 31566704) for the axfer, is not opted in to that ASA, missing nt200 balance box / min balance for first deposit, or pool/market state rejects the amount. Less often: wrong assetId for xaid still produces a different failure earlier."
      : "For nt200 / ARC-200 markets, assetId must be the underlying ASA used in deposit (xaid), e.g. mainnet USDC 31566704 — not the nToken application id from the pool or GET .../debt/...";
    repaySendError(res, format, {
      httpStatus: 500,
      code: "INTERNAL_ERROR",
      message: "Failed to build repay transaction group",
      details: arccjs ? { buildError: msg, hint } : undefined,
      requestId,
    });
    return;
  }

  try {
    await assertPayerCanFundRepay({
      algod,
      payerAddress: payer,
      underlyingAsaId: body.assetId,
      repayAmountBaseUnits: built.repayAmountBaseUnits,
    });
  } catch (e) {
    if (e instanceof PayerInsufficientBalanceError) {
      log.warn("repay_payer_preflight_failed", { execute, format, requestId, ...e.details });
      repaySendError(res, format, {
        httpStatus: 400,
        code: "PAYER_INSUFFICIENT_BALANCE",
        message: e.message,
        details: e.details,
        requestId,
      });
      return;
    }
    const desc = describeAlgodFailure(e);
    log.error("repay_payer_preflight_algod_error", { execute, format, requestId, ...desc.details, err: String(e) });
    repaySendError(res, format, {
      httpStatus: httpStatusForAlgodFailure(desc),
      code: "ALGOD_ERROR",
      message: desc.clientMessage,
      details: desc.details,
      requestId,
    });
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
    log.info("repay_flow_completed", { execute: false, format, requestId, mode: "unsigned" });
    repaySendSuccess(res, format, payload);
    return;
  }

  const mnemonic = process.env.SERVER_SIGNER_MNEMONIC?.trim();
  if (!mnemonic) {
    repaySendError(res, format, {
      httpStatus: 503,
      code: "EXECUTE_NOT_CONFIGURED",
      message: "SERVER_SIGNER_MNEMONIC is not set",
      requestId,
    });
    return;
  }

  const signerAddr = addressFromMnemonic(mnemonic);
  const signerCanon = canonicalAlgorandAddress(signerAddr);
  const payerCanon = canonicalAlgorandAddress(payer);
  if (signerCanon !== payerCanon) {
    const payerIsBorrower = payerCanon === canonicalAlgorandAddress(borrower);
    repaySendError(res, format, {
      httpStatus: 400,
      code: "SIGNER_MISMATCH",
      message: `SERVER_SIGNER_MNEMONIC derives ${signerCanon} but this request's payer is ${payerCanon}${
        payerIsBorrower
          ? " (with SERVER_SIGNER_MNEMONIC unset, payer defaults to userAddress — use a mnemonic for that borrower, or set payerAddress to the account your mnemonic controls)."
          : " (with SERVER_SIGNER_MNEMONIC unset, set payerAddress to the account your mnemonic controls, or change SERVER_SIGNER_MNEMONIC.)"
      }`,
      details: {
        mnemonicDerives: signerCanon,
        payerAddress: payerCanon,
        userAddress: canonicalAlgorandAddress(borrower),
        payerIsBorrower,
      },
      requestId,
    });
    return;
  }

  const signed = signTxnsWithMnemonic(mnemonic, built.transactions);
  let confirmedRound = 0;
  let txIds: string[] = [];
  log.info("repay_execute_submit_started", { format, requestId, txnCount: signed.length });
  try {
    const out = await sendAndConfirmGroup(algod, signed);
    confirmedRound = out.confirmedRound;
    txIds = out.txIds;
  } catch (e) {
    const desc = describeAlgodFailure(e);
    log.error("algorand_submit_failed", { format, requestId, ...desc.details, err: String(e) });
    repaySendError(res, format, {
      httpStatus: httpStatusForAlgodFailure(desc),
      code: "ALGOD_ERROR",
      message: desc.clientMessage,
      details: desc.details,
      requestId,
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
  log.info("repay_flow_completed", { execute: true, format, requestId, mode: "executed", txIds });
  repaySendSuccess(res, format, payload);
}

async function handleRepay(
  req: express.Request,
  res: express.Response,
  execute: boolean,
  format: RepayWebhookFormat = "gateway",
): Promise<void> {
  try {
    await handleRepayImpl(req, res, execute, format);
  } catch (e) {
    log.error("repay_webhook_unhandled_exception", { execute, format, err: String(e) });
    if (res.headersSent) {
      return;
    }
    const requestId = extractRequestIdFromReq(req);
    repaySendError(res, format, {
      httpStatus: 500,
      code: "INTERNAL_ERROR",
      message: "Unexpected error processing webhook",
      details: e instanceof Error ? e.message : String(e),
      requestId,
    });
  }
}

router.post("/repay", (req, res, next) => {
  void handleRepay(req, res, false, "gateway").catch(next);
});

router.post("/repay/execute", (req, res, next) => {
  void handleRepay(req, res, true, "gateway").catch(next);
});

router.post("/keeperhub/repay", (req, res, next) => {
  void handleRepay(req, res, false, "keeperhub").catch(next);
});

router.post("/keeperhub/repay/execute", (req, res, next) => {
  void handleRepay(req, res, true, "keeperhub").catch(next);
});

export default router;
