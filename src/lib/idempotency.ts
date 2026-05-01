import type { ExecutedRepaySuccess, RepaySuccessResponse, UnsignedRepaySuccess } from "../types.js";

type TxCommit = {
  requestId: string;
  unsigned?: UnsignedRepaySuccess;
  executed?: ExecutedRepaySuccess;
};

const usedPaymentTx = new Map<string, TxCommit>();

function normalizeRequestId(requestId: string | undefined): string {
  return requestId ?? "__no_request_id__";
}

export function idempotencyCacheKey(basePaymentTxId: string, requestId: string | undefined): string {
  const tx = basePaymentTxId.toLowerCase();
  const rid = normalizeRequestId(requestId);
  return `${tx}:${rid}`;
}

export type IdempotencyLane = "unsigned" | "executed";

export type IdempotencyResolution =
  | { kind: "miss" }
  | { kind: "replay"; response: RepaySuccessResponse }
  | { kind: "tx_used_other_request" };

/**
 * Idempotency is per `basePaymentTxId` (lowercased) plus bound `requestId`, with **separate** replay slots for
 * `POST /webhook/repay` (`unsigned`) vs `POST /webhook/repay/execute` (`executed`) so a successful unsigned build
 * does not block a later execute with the same payment hash and request id.
 */
export function resolvePaymentIdempotency(
  basePaymentTxId: string,
  requestId: string | undefined,
  lane: IdempotencyLane,
): IdempotencyResolution {
  const txKey = basePaymentTxId.toLowerCase();
  const rid = normalizeRequestId(requestId);
  const existing = usedPaymentTx.get(txKey);
  if (!existing) {
    return { kind: "miss" };
  }
  if (existing.requestId !== rid) {
    return { kind: "tx_used_other_request" };
  }
  if (lane === "unsigned" && existing.unsigned) {
    return { kind: "replay", response: existing.unsigned };
  }
  if (lane === "executed" && existing.executed) {
    return { kind: "replay", response: existing.executed };
  }
  return { kind: "miss" };
}

export function recordSuccessfulRepay(
  basePaymentTxId: string,
  requestId: string | undefined,
  response: RepaySuccessResponse,
): void {
  const txKey = basePaymentTxId.toLowerCase();
  const rid = normalizeRequestId(requestId);
  let entry = usedPaymentTx.get(txKey);
  if (!entry) {
    entry = { requestId: rid };
    usedPaymentTx.set(txKey, entry);
  } else if (entry.requestId !== rid) {
    return;
  }
  if (response.mode === "unsigned") {
    entry.unsigned = response;
  } else {
    entry.executed = response;
  }
}

/** Test helper */
export function clearIdempotencyStore(): void {
  usedPaymentTx.clear();
}
