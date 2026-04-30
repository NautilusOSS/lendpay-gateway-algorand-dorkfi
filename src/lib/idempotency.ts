import type { RepaySuccessResponse } from "../types.js";

type CacheEntry = {
  cacheKey: string;
  response: RepaySuccessResponse;
};

const usedPaymentTx = new Map<string, CacheEntry>();

export function idempotencyCacheKey(
  basePaymentTxId: string,
  requestId: string | undefined,
): string {
  const tx = basePaymentTxId.toLowerCase();
  const rid = requestId ?? "__no_request_id__";
  return `${tx}:${rid}`;
}

export type IdempotencyResolution =
  | { kind: "miss" }
  | { kind: "replay"; response: RepaySuccessResponse }
  | { kind: "tx_used_other_request" };

export function resolvePaymentIdempotency(
  basePaymentTxId: string,
  requestId: string | undefined,
): IdempotencyResolution {
  const txKey = basePaymentTxId.toLowerCase();
  const cacheKey = idempotencyCacheKey(basePaymentTxId, requestId);
  const existing = usedPaymentTx.get(txKey);
  if (!existing) {
    return { kind: "miss" };
  }
  if (existing.cacheKey === cacheKey) {
    return { kind: "replay", response: existing.response };
  }
  return { kind: "tx_used_other_request" };
}

export function recordSuccessfulRepay(
  basePaymentTxId: string,
  requestId: string | undefined,
  response: RepaySuccessResponse,
): void {
  const txKey = basePaymentTxId.toLowerCase();
  const cacheKey = idempotencyCacheKey(basePaymentTxId, requestId);
  usedPaymentTx.set(txKey, { cacheKey, response });
}

/** Test helper */
export function clearIdempotencyStore(): void {
  usedPaymentTx.clear();
}
