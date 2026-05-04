import type { Response } from "express";
import algosdk from "algosdk";
import type { ApiErrorCode, ApiErrorResponse, ExecutedRepaySuccess, UnsignedRepaySuccess } from "../types.js";
import { log } from "./logger.js";

/** `gateway` = existing `{ ok, error, ... }` contract; `keeperhub` = structured completion JSON for workflow runners. */
export type RepayWebhookFormat = "gateway" | "keeperhub";

export type KeeperhubSuccessJson = {
  success: true;
  status: "completed";
  message: string;
  result: {
    requestId: string | null;
    /** First confirmed group tx id (execute) or first unsigned txn id / fallback reference (unsigned). */
    txId: string;
  };
};

export type KeeperhubFailureJson = {
  success: false;
  status: "failed";
  message: string;
  error: string;
  result: {
    requestId: string | null;
    code?: string;
    details?: unknown;
  };
};

function setJsonContentType(res: Response): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

function keeperhubSuccessFromPayload(body: UnsignedRepaySuccess | ExecutedRepaySuccess): KeeperhubSuccessJson {
  if (body.mode === "executed") {
    const txId = body.txIds[0] ?? "";
    return {
      success: true,
      status: "completed",
      message: "Webhook processed successfully",
      result: {
        requestId: body.requestId,
        txId,
      },
    };
  }
  let txId = "";
  const firstB64 = body.transactions[0];
  if (firstB64) {
    try {
      const txn = algosdk.decodeUnsignedTransaction(Buffer.from(firstB64, "base64"));
      txId = txn.txID();
    } catch {
      txId = "unsigned-pending";
    }
  } else {
    txId = "unsigned-empty";
  }
  return {
    success: true,
    status: "completed",
    message: "Webhook processed successfully",
    result: {
      requestId: body.requestId,
      txId,
    },
  };
}

/** Gateway-style error (`ok: false`, HTTP status reflects error class). */
export function repayGatewayJsonError(res: Response, httpStatus: number, body: ApiErrorResponse): void {
  setJsonContentType(res);
  res.status(httpStatus).json(body);
}

export function repaySendError(
  res: Response,
  format: RepayWebhookFormat,
  opts: {
    httpStatus: number;
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    requestId: string | null;
  },
): void {
  const { httpStatus, code, message, details, requestId } = opts;
  if (format === "gateway") {
    const body: ApiErrorResponse = {
      ok: false,
      error: code,
      message,
      ...(details !== undefined ? { details } : {}),
    };
    repayGatewayJsonError(res, httpStatus, body);
    log.info("repay_response_sent", { format: "gateway", httpStatus, code, requestId });
    return;
  }
  const kh: KeeperhubFailureJson = {
    success: false,
    status: "failed",
    message,
    error: message,
    result: {
      requestId,
      code,
      ...(details !== undefined ? { details } : {}),
    },
  };
  setJsonContentType(res);
  res.status(200).json(kh);
  log.info("repay_response_sent", { format: "keeperhub", httpStatus: 200, success: false, code, requestId });
}

export function repaySendSuccess(
  res: Response,
  format: RepayWebhookFormat,
  payload: UnsignedRepaySuccess | ExecutedRepaySuccess,
): void {
  if (format === "gateway") {
    setJsonContentType(res);
    res.status(200).json(payload);
    log.info("repay_response_sent", { format: "gateway", httpStatus: 200, ok: true, mode: payload.mode, requestId: payload.requestId });
    return;
  }
  const kh = keeperhubSuccessFromPayload(payload);
  setJsonContentType(res);
  res.status(200).json(kh);
  log.info("repay_response_sent", {
    format: "keeperhub",
    httpStatus: 200,
    success: true,
    mode: payload.mode,
    requestId: payload.requestId,
    txId: kh.result.txId,
    ...(payload.mode === "executed"
      ? { txIds: payload.txIds, confirmedRound: payload.confirmedRound }
      : { repayAmountBaseUnits: payload.repayAmountBaseUnits }),
  });
}
