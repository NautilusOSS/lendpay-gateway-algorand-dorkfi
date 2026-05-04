import {
  BlockNotFoundError,
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  http,
  isHex,
  size,
  type Hex,
  type TransactionReceipt,
} from "viem";
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

/** Canonical USDC on Base mainnet (used to detect native-vs-ERC20 misconfiguration). */
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Multicall3 on Base mainnet (same address as Ethereum). */
const MULTICALL3_ADDRESS = "0xcA11bde05977b363116402886DDbF3BA8e0E3E16";
/** Uniswap Permit2 on Base (same cross-chain address). */
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78Ba3";

const MAX_PAYMENT_BATCH_DECODE_DEPTH = 8;

export function isValidEvmTxHash(hash: string): boolean {
  return isHex(hash) && size(hash) === 32;
}

/** Parsed `PAYMENT_MAX_AGE_SECONDS` (default 60; `0` disables the age check). Trims whitespace. */
export function getPaymentMaxAgeSeconds(): number {
  const raw = process.env.PAYMENT_MAX_AGE_SECONDS;
  if (raw === undefined || raw === null) {
    return 60;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return 60;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return 60;
  }
  return n;
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
  // Explicit 0x0 is not treated as native (common .env placeholder); use empty or NATIVE for ETH.
  return false;
}

/** EIP-3009 USDC-style payment calldata (signed transfer intent); `to` is the payee, not the outer tx `to`. */
const eip3009PaymentAbi = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "receiveWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const multicall3Aggregate3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const multicall2AggregateAbi = [
  {
    type: "function",
    name: "aggregate",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "blockNumber", type: "uint256" },
      { name: "returnData", type: "bytes[]" },
    ],
  },
] as const;

const permit2PermitTransferFromAbi = [
  {
    type: "function",
    name: "permitTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        name: "transferDetails",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "requestedAmount", type: "uint256" },
        ],
      },
      { name: "owner", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

function accumulateEip3009ByTo(input: Hex | undefined, into: Map<string, bigint>): void {
  if (!input || input === "0x") {
    return;
  }
  try {
    const decoded = decodeFunctionData({ abi: eip3009PaymentAbi, data: input });
    if (
      decoded.functionName !== "transferWithAuthorization" &&
      decoded.functionName !== "receiveWithAuthorization"
    ) {
      return;
    }
    const [_from, to, value] = decoded.args as readonly [`0x${string}`, `0x${string}`, bigint, ...unknown[]];
    const toAddr = getAddress(to);
    into.set(toAddr, (into.get(toAddr) ?? 0n) + value);
  } catch {
    // not EIP-3009 on this calldata
  }
}

function accumulatePermit2ByTo(input: Hex | undefined, paymentTokenNorm: string, into: Map<string, bigint>): void {
  if (!input || input === "0x") {
    return;
  }
  try {
    const decoded = decodeFunctionData({ abi: permit2PermitTransferFromAbi, data: input });
    if (decoded.functionName !== "permitTransferFrom") {
      return;
    }
    const [permit, transferDetails] = decoded.args as readonly [
      { permitted: { token: `0x${string}`; amount: bigint }; nonce: bigint; deadline: bigint },
      { to: `0x${string}`; requestedAmount: bigint },
      ...unknown[],
    ];
    if (getAddress(permit.permitted.token) !== paymentTokenNorm) {
      return;
    }
    const toAddr = getAddress(transferDetails.to);
    into.set(toAddr, (into.get(toAddr) ?? 0n) + transferDetails.requestedAmount);
  } catch {
    // not Permit2 permitTransferFrom
  }
}

type TxCalldata = { to?: `0x${string}` | null; input: Hex };

type SignedPaymentIntents = {
  eip3009ByTo: Map<string, bigint>;
  permit2ByTo: Map<string, bigint>;
};

function dispatchInnerCall(
  target: `0x${string}`,
  callData: Hex,
  tokenNorm: string,
  out: SignedPaymentIntents,
  depth: number,
): void {
  if (depth > MAX_PAYMENT_BATCH_DECODE_DEPTH) {
    return;
  }
  const t = getAddress(target);
  const permit2Norm = getAddress(PERMIT2_ADDRESS);
  const multicallNorm = getAddress(MULTICALL3_ADDRESS);

  if (t === tokenNorm) {
    accumulateEip3009ByTo(callData, out.eip3009ByTo);
    return;
  }
  if (t === permit2Norm) {
    accumulatePermit2ByTo(callData, tokenNorm, out.permit2ByTo);
    return;
  }
  if (t === multicallNorm) {
    scanAggregate3Batch(callData, tokenNorm, out, depth + 1);
    return;
  }
  scanAggregate3Batch(callData, tokenNorm, out, depth + 1);
  scanAggregate2Batch(callData, tokenNorm, out, depth + 1);
}

function scanAggregate3Batch(
  data: Hex | undefined,
  tokenNorm: string,
  out: SignedPaymentIntents,
  depth: number,
): void {
  if (!data || data === "0x" || depth > MAX_PAYMENT_BATCH_DECODE_DEPTH) {
    return;
  }
  try {
    const decoded = decodeFunctionData({ abi: multicall3Aggregate3Abi, data });
    if (decoded.functionName !== "aggregate3") {
      return;
    }
    const calls = decoded.args[0] as {
      target: `0x${string}`;
      allowFailure: boolean;
      callData: Hex;
    }[];
    for (const c of calls) {
      dispatchInnerCall(c.target, c.callData, tokenNorm, out, depth);
    }
  } catch {
    // not aggregate3
  }
}

function scanAggregate2Batch(
  data: Hex | undefined,
  tokenNorm: string,
  out: SignedPaymentIntents,
  depth: number,
): void {
  if (!data || data === "0x" || depth > MAX_PAYMENT_BATCH_DECODE_DEPTH) {
    return;
  }
  try {
    const decoded = decodeFunctionData({ abi: multicall2AggregateAbi, data });
    if (decoded.functionName !== "aggregate") {
      return;
    }
    const calls = decoded.args[0] as { target: `0x${string}`; callData: Hex }[];
    for (const c of calls) {
      dispatchInnerCall(c.target, c.callData, tokenNorm, out, depth);
    }
  } catch {
    // not Multicall2 aggregate
  }
}

/**
 * Signed payee intents for the configured payment token: EIP-3009 on token target,
 * Permit2 `permitTransferFrom` when `permitted.token` matches, and nested Multicall2/3 batches.
 */
function collectSignedPaymentIntents(tx: TxCalldata, token: `0x${string}`): SignedPaymentIntents {
  const tokenNorm = getAddress(token);
  const out: SignedPaymentIntents = {
    eip3009ByTo: new Map(),
    permit2ByTo: new Map(),
  };
  const data = tx.input;

  if (tx.to && getAddress(tx.to) === tokenNorm) {
    accumulateEip3009ByTo(data, out.eip3009ByTo);
    return out;
  }
  if (tx.to && getAddress(tx.to) === getAddress(PERMIT2_ADDRESS)) {
    accumulatePermit2ByTo(data, tokenNorm, out.permit2ByTo);
    return out;
  }

  scanAggregate3Batch(data, tokenNorm, out, 0);
  scanAggregate2Batch(data, tokenNorm, out, 0);
  return out;
}

function formatRecipientMap(m: Map<string, bigint>): string {
  return [...m.entries()]
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] < b[1] ? 1 : -1))
    .map(([addr, amt]) => `${addr} (${amt.toString()} units)`)
    .join("; ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Some Base RPCs return a receipt before `eth_getBlockByHash` / `eth_getBlockByNumber` serves that
 * block (transient null). Retry with backoff before failing payment age checks.
 */
async function getBlockForReceiptTimestamp(
  receipt: Pick<TransactionReceipt, "blockHash" | "blockNumber">,
  payCfgSuffix: string,
  fetchBlock: (args: { blockHash: `0x${string}` } | { blockNumber: bigint }) => Promise<{ timestamp: bigint }>,
): Promise<{ timestamp: bigint }> {
  const maxAttempts = 5;
  let lastErr = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(200 * 2 ** (attempt - 1));
    }
    try {
      return await fetchBlock({ blockHash: receipt.blockHash });
    } catch (e) {
      if (!(e instanceof BlockNotFoundError)) {
        throw e;
      }
      try {
        return await fetchBlock({ blockNumber: receipt.blockNumber });
      } catch (e2) {
        lastErr = String(e2);
        if (!(e2 instanceof BlockNotFoundError)) {
          throw e2;
        }
      }
    }
  }
  log.warn("base_block_fetch_failed", {
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    err: lastErr,
    attempts: maxAttempts,
  });
  throw new PaymentValidationError(
    "PAYMENT_TX_NOT_FOUND",
    `Receipt exists but the Base RPC did not return that block after ${maxAttempts} attempts (try https://mainnet.base.org or wait and retry).${payCfgSuffix}`,
  );
}

/** Non-secret payment gate env for error messages. */
function paymentEnvSuffix(
  receiver: string,
  native: boolean,
  tokenRaw: string | undefined,
  tokenAddress: `0x${string}` | null,
  requiredAmount: bigint,
): string {
  const tr = tokenRaw?.trim() ?? "";
  const tokenPart = native
    ? `PAYMENT_TOKEN_ADDRESS=${tr || "unset"} (native ETH mode)`
    : `PAYMENT_TOKEN_ADDRESS=${tokenAddress}`;
  return ` Configured: ${tokenPart}; PAYMENT_RECEIVER_ADDRESS=${receiver}; REQUIRED_PAYMENT_AMOUNT=${requiredAmount.toString()}.`;
}

export async function validateBasePaymentReceipt(basePaymentTxId: string): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL;
  const receiverRaw = process.env.PAYMENT_RECEIVER_ADDRESS;
  const tokenRaw = process.env.PAYMENT_TOKEN_ADDRESS;
  const amountRaw = process.env.REQUIRED_PAYMENT_AMOUNT;
  const maxAgeSeconds = getPaymentMaxAgeSeconds();

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
    if (tokenAddress === getAddress(ZERO_ADDRESS)) {
      throw new PaymentValidationError(
        "PAYMENT_TOKEN_MISMATCH",
        `PAYMENT_TOKEN_ADDRESS cannot be the zero address. Use NATIVE (or omit) for native ETH, or set Base USDC ${BASE_USDC_ADDRESS} for USDC.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
      );
    }
  }

  if (receiver === getAddress(ZERO_ADDRESS)) {
    throw new PaymentValidationError(
      "PAYMENT_RECEIVER_MISMATCH",
      `PAYMENT_RECEIVER_ADDRESS must be a non-zero Base payee address. Replace the 0x000… placeholder in .env.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
    );
  }

  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const chainId = await client.getChainId();
  if (chainId !== base.id) {
    throw new PaymentValidationError(
      "PAYMENT_BASE_RPC_CHAIN_MISMATCH",
      `BASE_RPC_URL must be Base mainnet (chain id ${base.id}); this RPC reports ${chainId}. Fix the URL (e.g. https://mainnet.base.org).${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
    );
  }

  if (!isValidEvmTxHash(basePaymentTxId as `0x${string}`)) {
    throw new PaymentValidationError(
      "PAYMENT_TX_NOT_FOUND",
      `basePaymentTxId is not a valid 32-byte EVM transaction hash.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
    );
  }

  const hash = basePaymentTxId as `0x${string}`;

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (e) {
    log.warn("base_receipt_fetch_failed", { err: String(e) });
    throw new PaymentValidationError(
      "PAYMENT_TX_NOT_FOUND",
      `Transaction receipt not found.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
    );
  }

  if (!receipt) {
    throw new PaymentValidationError(
      "PAYMENT_TX_NOT_FOUND",
      `Transaction receipt not found.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
    );
  }

  if (receipt.status !== "success") {
    throw new PaymentValidationError(
      "PAYMENT_TX_FAILED",
      `Transaction did not succeed.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
    );
  }

  const payCfgSuffix = paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount);
  const block = await getBlockForReceiptTimestamp(receipt, payCfgSuffix, async (args) => {
    const b = await client.getBlock(args);
    return { timestamp: b.timestamp };
  });
  const blockTs = Number(block.timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0) {
    if (now - blockTs > maxAgeSeconds) {
      throw new PaymentValidationError(
        "PAYMENT_TOO_OLD",
        `Payment block timestamp is older than ${maxAgeSeconds}s.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
      );
    }
  }

  if (native) {
    const tx = await client.getTransaction({ hash });
    if (!tx) {
      throw new PaymentValidationError(
        "PAYMENT_TX_NOT_FOUND",
        `Transaction not found.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
      );
    }
    if (!tx.to || getAddress(tx.to) !== receiver) {
      const actual = tx.to
        ? getAddress(tx.to)
        : "none (outer transaction has no to field; often a contract call, AA wallet, or batched flow)";
      if (tx.to && getAddress(tx.to) === getAddress(BASE_USDC_ADDRESS)) {
        throw new PaymentValidationError(
          "PAYMENT_TOKEN_MISMATCH",
          `This transaction calls Base USDC (${BASE_USDC_ADDRESS}) but the server is configured for native ETH (PAYMENT_TOKEN_ADDRESS unset, NATIVE, or ETH). Set PAYMENT_TOKEN_ADDRESS to ${BASE_USDC_ADDRESS} and REQUIRED_PAYMENT_AMOUNT in token smallest units (6 decimals for USDC).${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
        );
      }
      throw new PaymentValidationError(
        "PAYMENT_RECEIVER_MISMATCH",
        `Native ETH recipient does not match PAYMENT_RECEIVER_ADDRESS: expected ${receiver}, transaction to is ${actual}.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
      );
    }
    if (tx.value < requiredAmount) {
      throw new PaymentValidationError(
        "PAYMENT_AMOUNT_TOO_LOW",
        `Native ETH value is below REQUIRED_PAYMENT_AMOUNT (tx.value=${tx.value.toString()}).${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
      );
    }
    return;
  }

  let paidToReceiver = 0n;
  const transferTotalsByTo = new Map<string, bigint>();

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
      const toAddr = getAddress(args.to);
      transferTotalsByTo.set(toAddr, (transferTotalsByTo.get(toAddr) ?? 0n) + args.value);
      if (toAddr === receiver) {
        paidToReceiver += args.value;
      }
    } catch {
      // not a Transfer for this token
    }
  }

  const tx = await client.getTransaction({ hash });
  const signed = tx
    ? collectSignedPaymentIntents(tx, tokenAddress!)
    : { eip3009ByTo: new Map<string, bigint>(), permit2ByTo: new Map<string, bigint>() };
  const authorizedToReceiver =
    (signed.eip3009ByTo.get(receiver) ?? 0n) + (signed.permit2ByTo.get(receiver) ?? 0n);

  if (paidToReceiver >= requiredAmount || authorizedToReceiver >= requiredAmount) {
    return;
  }

  const totalTokenOut = [...transferTotalsByTo.values()].reduce((a, b) => a + b, 0n);
  if (paidToReceiver === 0n && totalTokenOut >= requiredAmount && authorizedToReceiver < requiredAmount) {
    const transferRecipients = formatRecipientMap(transferTotalsByTo);
    const signedParts: string[] = [];
    if (signed.eip3009ByTo.size > 0) {
      signedParts.push(`EIP-3009 to: ${formatRecipientMap(signed.eip3009ByTo)}`);
    }
    if (signed.permit2ByTo.size > 0) {
      signedParts.push(`Permit2 transferDetails.to: ${formatRecipientMap(signed.permit2ByTo)}`);
    }
    const signedPart = signedParts.length > 0 ? ` ${signedParts.join(". ")}.` : "";
    throw new PaymentValidationError(
      "PAYMENT_RECEIVER_MISMATCH",
      `ERC-20 does not credit PAYMENT_RECEIVER_ADDRESS (${receiver}): Transfer to: ${transferRecipients}.${signedPart} (Outer transaction to is often a facilitator; use Transfer logs and signed payee fields, not tx.to.)${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
    );
  }

  if (tx && tx.value >= requiredAmount) {
    throw new PaymentValidationError(
      "PAYMENT_TOKEN_MISMATCH",
      `Expected ERC-20 payment but native ETH value would satisfy the amount instead (tx.value=${tx.value.toString()}).${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
    );
  }
  throw new PaymentValidationError(
    "PAYMENT_AMOUNT_TOO_LOW",
    `ERC-20 transfers to receiver are below REQUIRED_PAYMENT_AMOUNT (counts Transfer to receiver, EIP-3009 to, and Permit2 transferDetails.to); paidToReceiver=${paidToReceiver.toString()}, authorizedToReceiver=${authorizedToReceiver.toString()}.${paymentEnvSuffix(receiver, native, tokenRaw, tokenAddress, requiredAmount)}`,
  );
}
