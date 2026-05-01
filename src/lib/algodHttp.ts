/** Alg SDK HTTP errors carry `response.status` (see URLTokenBaseHTTPError). */
export function readAlgodHttpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("response" in err)) {
    return undefined;
  }
  const r = (err as { response?: { status?: number } }).response;
  return typeof r?.status === "number" ? r.status : undefined;
}

function responseBodyUtf8(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("response" in err)) {
    return undefined;
  }
  const body = (err as { response?: { body?: unknown } }).response?.body;
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  return undefined;
}

/** Max UTF-8 length when the error body is not JSON (safety bound for API payloads). */
const ALGOD_ERROR_BODY_MAX_CHARS = 65536;

/** Parse Algod JSON error `message` when present (otherwise full body up to {@link ALGOD_ERROR_BODY_MAX_CHARS}). */
export function readAlgodErrorMessage(err: unknown): string | undefined {
  const raw = responseBodyUtf8(err);
  if (!raw) {
    return undefined;
  }
  try {
    const j = JSON.parse(raw) as { message?: string };
    if (typeof j.message === "string" && j.message.trim()) {
      return j.message.trim();
    }
  } catch {
    /* not JSON */
  }
  return raw.length > ALGOD_ERROR_BODY_MAX_CHARS
    ? `${raw.slice(0, ALGOD_ERROR_BODY_MAX_CHARS)}…`
    : raw;
}

/**
 * Summarize failures from Algod `sendRawTransaction`, `waitForConfirmation`, `status`, etc.
 * Safe to log or return in API `details` (no tokens).
 */
export function describeAlgodFailure(err: unknown): {
  httpStatus?: number;
  clientMessage: string;
  details: Record<string, unknown>;
} {
  const str = String(err);
  const httpStatus = readAlgodHttpStatus(err);

  const rejectedPrefix = "Transaction Rejected:";
  const rejectedIdx = str.indexOf(rejectedPrefix);
  if (rejectedIdx !== -1) {
    const poolError = str.slice(rejectedIdx + rejectedPrefix.length).trim();
    return {
      clientMessage: poolError ? `Transaction rejected: ${poolError}` : str,
      details: { kind: "txn_rejected", poolError: poolError || str },
    };
  }

  if (str.includes("Transaction not confirmed after")) {
    return {
      clientMessage: str,
      details: { kind: "confirmation_timeout" },
    };
  }

  if (str === "Error: Unable to get node status" || str.includes("Unable to get node status")) {
    return {
      clientMessage: "Algod did not return node status (network or node error).",
      details: { kind: "node_status" },
    };
  }

  if (httpStatus !== undefined) {
    const algodMessage = readAlgodErrorMessage(err);
    const suffix = algodMessage ? `: ${algodMessage}` : "";
    const clientMessage = `Algod HTTP ${httpStatus}${suffix}`;
    return {
      httpStatus,
      clientMessage,
      details: {
        kind: "http",
        httpStatus,
        ...(algodMessage ? { algodMessage } : {}),
      },
    };
  }

  const fallback = str.length > 0 ? str : "Algorand submission or confirmation failed";
  return {
    clientMessage:
      fallback.length > ALGOD_ERROR_BODY_MAX_CHARS
        ? `${fallback.slice(0, ALGOD_ERROR_BODY_MAX_CHARS)}…`
        : fallback,
    details: { kind: "unknown" },
  };
}

/** HTTP status to use for the webhook response given an Algod client failure. */
export function httpStatusForAlgodFailure(desc: ReturnType<typeof describeAlgodFailure>): number {
  if (desc.details.kind === "confirmation_timeout") {
    return 504;
  }
  if (desc.httpStatus === 400 || desc.details.kind === "txn_rejected") {
    return 400;
  }
  if (desc.httpStatus !== undefined && desc.httpStatus >= 400 && desc.httpStatus < 500) {
    return 502;
  }
  return 502;
}
