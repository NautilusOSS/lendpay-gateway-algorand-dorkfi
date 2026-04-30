import algosdk from "algosdk";
import { WAD, applyBorrowIndex, formatUnits, parseUnits } from "../lib/amounts.js";
import { buildArc200TransferOrApproveTxns } from "./arc200.js";
import { log } from "../lib/logger.js";

type TealValue = { type: number; uint: bigint; bytes: Uint8Array };
type TealKeyValue = { key: Uint8Array; value: TealValue };

export type MarketDebtSnapshot = {
  borrowIndex: bigint;
  scaledBorrows: bigint;
  currentDebt: bigint;
  decimals: number;
  configured: boolean;
  /** Human-readable debt for previews */
  currentDebtFormatted: string;
};

function bufferFromKey(key: string | Uint8Array): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(key);
}

function findTealValue(rows: TealKeyValue[] | undefined, keyUtf8: string): TealValue | undefined {
  if (!rows) {
    return undefined;
  }
  const want = Buffer.from(keyUtf8, "utf8");
  for (const row of rows) {
    if (bufferFromKey(row.key).equals(want)) {
      return row.value;
    }
  }
  return undefined;
}

function tealValueToUint(v: TealValue | undefined): bigint | null {
  if (!v) {
    return null;
  }
  if (v.type === 2) {
    return v.uint;
  }
  if (v.type === 1 && v.bytes.length > 0) {
    return BigInt(`0x${Buffer.from(v.bytes).toString("hex")}`);
  }
  return null;
}

function readBorrowIndexKey(): string | undefined {
  const k = process.env.DORKFI_BORROW_INDEX_GLOBAL_KEY?.trim();
  return k && k.length > 0 ? k : undefined;
}

function readScaledBorrowKey(): string | undefined {
  const k = process.env.DORKFI_SCALED_BORROW_LOCAL_KEY?.trim();
  return k && k.length > 0 ? k : undefined;
}

export async function fetchMarketDebtSnapshot(
  algod: algosdk.Algodv2,
  marketAppId: number,
  userAddress: string,
  assetId: number,
): Promise<MarketDebtSnapshot> {
  const borrowKey = readBorrowIndexKey();
  const scaledKey = readScaledBorrowKey();
  const configured = Boolean(borrowKey && scaledKey);

  const app = await algod.getApplicationByID(marketAppId).do();
  const globalRows = app.params.globalState as TealKeyValue[] | undefined;

  const acctApp = await algod.accountApplicationInformation(userAddress, marketAppId).do();
  const localRows = acctApp.appLocalState?.keyValue as TealKeyValue[] | undefined;

  const borrowIndex = borrowKey ? tealValueToUint(findTealValue(globalRows, borrowKey)) : null;
  const scaledBorrows = scaledKey ? tealValueToUint(findTealValue(localRows, scaledKey)) : null;

  const asset = await algod.getAssetByID(assetId).do();
  const decimals = Number(asset.params.decimals ?? 0);

  if (!configured || borrowIndex === null || scaledBorrows === null || borrowIndex <= 0n) {
    return {
      borrowIndex: borrowIndex ?? WAD,
      scaledBorrows: scaledBorrows ?? 0n,
      currentDebt: 0n,
      decimals,
      configured: false,
      currentDebtFormatted: "0",
    };
  }

  const currentDebt = applyBorrowIndex(scaledBorrows, borrowIndex);
  return {
    borrowIndex,
    scaledBorrows,
    currentDebt,
    decimals,
    configured: true,
    currentDebtFormatted: formatUnits(currentDebt, decimals),
  };
}

export type RepayBuildResult = {
  repayAmountBaseUnits: bigint;
  transactions: algosdk.Transaction[];
};

/**
 * TODO: Replace `repay` placeholder selector with the real DorkFi ABI / TEAL method selector.
 * TODO: Add `sync_market` selector + foreign apps/assets/boxes for pool + market wiring.
 * TODO: Confirm repay app args encoding (uint128 / btoi layout) against deployed contracts.
 */
export async function buildDorkFiRepayGroup(params: {
  algod: algosdk.Algodv2;
  sender: string;
  userAddress: string;
  marketAppId: number;
  assetId: number;
  repayMode: "exact" | "max";
  repayAmount: string;
  repayMaxBufferBaseUnits?: bigint;
}): Promise<RepayBuildResult> {
  const {
    algod,
    sender,
    userAddress,
    marketAppId,
    assetId,
    repayMode,
    repayAmount,
    repayMaxBufferBaseUnits = 0n,
  } = params;

  const snapshot = await fetchMarketDebtSnapshot(algod, marketAppId, userAddress, assetId);
  if (!snapshot.configured) {
    throw new Error("DORKFI_NOT_CONFIGURED");
  }

  const { currentDebt, decimals } = snapshot;
  let repayAmountBaseUnits: bigint;
  if (repayMode === "max") {
    repayAmountBaseUnits = currentDebt + repayMaxBufferBaseUnits;
  } else {
    try {
      repayAmountBaseUnits = parseUnits(repayAmount, decimals);
    } catch {
      throw new Error("REPAY_AMOUNT_INVALID");
    }
  }

  if (repayAmountBaseUnits <= 0n) {
    throw new Error("REPAY_AMOUNT_INVALID");
  }
  if (repayMode !== "max" && repayAmountBaseUnits > currentDebt) {
    throw new Error("REPAY_EXCEEDS_DEBT");
  }

  const suggestedParams = await algod.getTransactionParams().do();
  const txns: algosdk.Transaction[] = [];

  const poolIdRaw = process.env.DORKFI_LENDING_POOL_APP_ID?.trim();
  const poolId = poolIdRaw ? Number(poolIdRaw) : NaN;
  if (Number.isFinite(poolId) && poolId > 0 && poolId !== marketAppId) {
    // TODO: Replace with real sync_market selector + accounts/assets/box refs.
    const syncArgs = [new Uint8Array(Buffer.from("sync_market", "utf8"))];
    txns.push(
      algosdk.makeApplicationNoOpTxnFromObject({
        sender,
        suggestedParams,
        appIndex: poolId,
        appArgs: syncArgs,
        // TODO: foreignApps / foreignAssets / boxes / account references
      }),
    );
  }

  txns.push(
    ...buildArc200TransferOrApproveTxns({
      sender,
      marketAppId,
      assetId,
      repayAmountBaseUnits,
      suggestedParams,
    }),
  );

  // TODO: foreignApps must include lending pool / ARC-200 controller when required.
  const foreignApps: number[] = [];
  if (Number.isFinite(poolId) && poolId > 0 && poolId !== marketAppId) {
    foreignApps.push(poolId);
  }

  const repaySelector = new Uint8Array(Buffer.from("repay", "utf8"));
  const repayArgs = [
    repaySelector,
    // TODO: append uint BE args for amount / mode per DorkFi contract ABI
  ];

  txns.push(
    algosdk.makeApplicationNoOpTxnFromObject({
      sender,
      suggestedParams,
      appIndex: marketAppId,
      appArgs: repayArgs,
      accounts: [userAddress, algosdk.getApplicationAddress(marketAppId)],
      foreignAssets: [assetId],
      foreignApps: foreignApps.length ? foreignApps : undefined,
      // TODO: boxes for user borrow slot / market cache
    }),
  );

  algosdk.assignGroupID(txns);
  log.info("dorkfi_repay_group_built", {
    marketAppId,
    assetId,
    repayMode,
    repayAmountBaseUnits: repayAmountBaseUnits.toString(),
  });

  return { repayAmountBaseUnits, transactions: txns };
}
