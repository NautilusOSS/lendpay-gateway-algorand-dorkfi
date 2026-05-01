export type { RepayWebhookBody } from "./schemas/repayBody.js";

export type ChainId =
  | "algorand-mainnet"
  | "algorand-testnet"
  | "voi-mainnet"
  | "voi-testnet";

export type PaymentErrorCode =
  | "PAYMENT_TX_NOT_FOUND"
  | "PAYMENT_TX_FAILED"
  | "PAYMENT_TOO_OLD"
  | "PAYMENT_RECEIVER_MISMATCH"
  | "PAYMENT_AMOUNT_TOO_LOW"
  | "PAYMENT_TOKEN_MISMATCH"
  | "PAYMENT_TX_ALREADY_USED";

export type ApiErrorCode =
  | PaymentErrorCode
  | "VALIDATION_ERROR"
  | "UNSUPPORTED_CHAIN"
  | "INVALID_ALGORAND_ADDRESS"
  | "REPAY_AMOUNT_INVALID"
  | "REPAY_EXCEEDS_DEBT"
  | "DORKFI_NOT_CONFIGURED"
  | "EXECUTE_NOT_CONFIGURED"
  | "SIGNER_MISMATCH"
  | "CHAIN_RESOURCE_NOT_FOUND"
  | "ALGOD_ERROR"
  | "INTERNAL_ERROR";

export type ApiErrorResponse = {
  ok: false;
  error: ApiErrorCode;
  message: string;
  details?: unknown;
};

export type UnsignedRepaySuccess = {
  ok: true;
  mode: "unsigned";
  requestId: string | null;
  repayAmountBaseUnits: string;
  transactions: string[];
};

export type ExecutedRepaySuccess = {
  ok: true;
  mode: "executed";
  requestId: string | null;
  txIds: string[];
  confirmedRound: number;
};

export type RepaySuccessResponse = UnsignedRepaySuccess | ExecutedRepaySuccess;
