import { createPublicClient, decodeEventLog, getAddress, http, isHex, size } from "viem";
import { base } from "viem/chains";
import type { PaymentErrorCode } from "../types.js";
import { log } from "../lib/logger.js";

export class PaymentValidationError extends Error {
  readonly code: PaymentErrorCode;

  constructor(code: PaymentErrorCode, message: string) {
    super(message);
    this.name = "PaymentValidationError";
    this.code = code;
  }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isValidEvmTxHash(hash: string): boolean {
  return isHex(hash) && size(hash) === 32;
}

function isNativePaymentToken(tokenEnv: string | undefined): boolean {
  if (!tokenEnv) {
    return true;
  }
  const t = tokenEnv.trim();
  if (t.length === 0) {
    return true;
  }
  if (t.toUpperCase() === "NATIVE" || t.toUpperCase() === "ETH") {
    return true;
  }
  return getAddress(t) === getAddress(ZERO_ADDRESS);
}

export async function validateBasePaymentReceipt(basePaymentTxId: string): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL;
  const receiverRaw = process.env.PAYMENT_RECEIVER_ADDRESS;
  const tokenRaw = process.env.PAYMENT_TOKEN_ADDRESS;
  const amountRaw = process.env.REQUIRED_PAYMENT_AMOUNT;
  const maxAgeSeconds = Number(process.env.PAYMENT_MAX_AGE_SECONDS ?? "60");

  if (!rpcUrl) {
    throw new Error("BASE_RPC_URL is not set");
  }
  if (!receiverRaw) {
    throw new Error("PAYMENT_RECEIVER_ADDRESS is not set");
  }
  if (!amountRaw) {
    throw new Error("REQUIRED_PAYMENT_AMOUNT is not set");
  }

  let requiredAmount: bigint;
  try {
    requiredAmount = BigInt(amountRaw.trim());
  } catch {
    throw new Error("REQUIRED_PAYMENT_AMOUNT must be a base-10 integer string");
  }

  const receiver = getAddress(receiverRaw.trim());
  const native = isNativePaymentToken(tokenRaw);
  let tokenAddress: `0x${string}` | null = null;
  if (!native) {
    tokenAddress = getAddress(tokenRaw!.trim()) as `0x${string}`;
  }

  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  if (!isValidEvmTxHash(basePaymentTxId as `0x${string}`)) {
    throw new PaymentValidationError(
      "PAYMENT_TX_NOT_FOUND",
      "basePaymentTxId is not a valid 32-byte EVM transaction hash",
    );
  }

  const hash = basePaymentTxId as `0x${string}`;

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (e) {
    log.warn("base_receipt_fetch_failed", { err: String(e) });
    throw new PaymentValidationError("PAYMENT_TX_NOT_FOUND", "Transaction receipt not found");
  }

  if (!receipt) {
    throw new PaymentValidationError("PAYMENT_TX_NOT_FOUND", "Transaction receipt not found");
  }

  if (receipt.status !== "success") {
    throw new PaymentValidationError("PAYMENT_TX_FAILED", "Transaction did not succeed");
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const blockTs = Number(block.timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0) {
    if (now - blockTs > maxAgeSeconds) {
      throw new PaymentValidationError(
        "PAYMENT_TOO_OLD",
        `Payment block timestamp is older than ${maxAgeSeconds}s`,
      );
    }
  }

  if (native) {
    const tx = await client.getTransaction({ hash });
    if (!tx) {
      throw new PaymentValidationError("PAYMENT_TX_NOT_FOUND", "Transaction not found");
    }
    if (!tx.to || getAddress(tx.to) !== receiver) {
      throw new PaymentValidationError(
        "PAYMENT_RECEIVER_MISMATCH",
        "Native transfer recipient does not match PAYMENT_RECEIVER_ADDRESS",
      );
    }
    if (tx.value < requiredAmount) {
      throw new PaymentValidationError(
        "PAYMENT_AMOUNT_TOO_LOW",
        "Native ETH value is below REQUIRED_PAYMENT_AMOUNT",
      );
    }
    return;
  }

  let paid = 0n;
  for (const logEntry of receipt.logs) {
    if (!logEntry.topics.length) {
      continue;
    }
    if (logEntry.address.toLowerCase() !== tokenAddress!.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: [
          {
            type: "event",
            name: "Transfer",
            inputs: [
              { name: "from", type: "address", indexed: true },
              { name: "to", type: "address", indexed: true },
              { name: "value", type: "uint256", indexed: false },
            ],
          },
        ] as const,
        data: logEntry.data,
        topics: logEntry.topics,
        strict: false,
      });
      if (decoded.eventName !== "Transfer") {
        continue;
      }
      const args = decoded.args as { from: `0x${string}`; to: `0x${string}`; value: bigint };
      if (getAddress(args.to) !== receiver) {
        continue;
      }
      paid += args.value;
    } catch {
      // not a Transfer for this token
    }
  }

  if (paid < requiredAmount) {
    const tx = await client.getTransaction({ hash });
    if (tx && tx.value >= requiredAmount) {
      throw new PaymentValidationError(
        "PAYMENT_TOKEN_MISMATCH",
        "Expected ERC-20 payment but native ETH value would satisfy the amount instead",
      );
    }
    throw new PaymentValidationError(
      "PAYMENT_AMOUNT_TOO_LOW",
      "ERC-20 transfers to receiver are below REQUIRED_PAYMENT_AMOUNT",
    );
  }
}
