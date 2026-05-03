import algosdk from "algosdk";
import type { ChainId } from "../types.js";
import { WAD, applyBorrowIndex, formatUnits, parseUnits } from "../lib/amounts.js";
import type { AlgodDecimalsSource } from "../lib/algodAssetOrAppDecimals.js";
import { loadAlgorandAssetOrAppDecimals } from "../lib/algodAssetOrAppDecimals.js";
import { readUserDebtFromLendingPool } from "./lendingPoolAbi.js";
import { buildRepayOnBehalfGroupArccjs } from "./repayGroupArccjs.js";
import { log } from "../lib/logger.js";

export type MarketDebtSnapshot = {
  borrowIndex: bigint;
  scaledBorrows: bigint;
  scaledDeposits: bigint;
  totalScaledDeposits: bigint;
  totalScaledBorrows: bigint;
  currentDebt: bigint;
  decimals: number;
  configured: boolean;
  /** Human-readable debt for previews */
  currentDebtFormatted: string;
  /**
   * Pool-resolved token id: underlying ASA, or nToken **application** id from `get_market` when the market is ARC-200.
   * Repay webhooks still pass the **underlying ASA** id for nt200 `deposit` (`xaid`), not this app id when it is an app.
   */
  resolvedAssetId: number | null;
  /** Whether decimals came from ASA metadata or an ARC-200-style app global `decimals`. */
  decimalsSource?: AlgodDecimalsSource;
  /** When `configured` is false, why the snapshot could not be finalized (simulation, ASA lookup, etc.). */
  notConfiguredReason?: string;
};

export type MarketDebtSnapshotOptions = {
  /**
   * When set (e.g. repay webhook `assetId`), use this id for decimals resolution instead of inferring from `get_market`.
   */
  assetIdOverride?: number;
};

function unconfiguredSnapshot(partial: Partial<MarketDebtSnapshot>): MarketDebtSnapshot {
  return {
    borrowIndex: partial.borrowIndex ?? WAD,
    scaledBorrows: partial.scaledBorrows ?? 0n,
    scaledDeposits: partial.scaledDeposits ?? 0n,
    totalScaledDeposits: partial.totalScaledDeposits ?? 0n,
    totalScaledBorrows: partial.totalScaledBorrows ?? 0n,
    currentDebt: 0n,
    decimals: partial.decimals ?? 0,
    configured: false,
    currentDebtFormatted: "0",
    resolvedAssetId: partial.resolvedAssetId ?? null,
    notConfiguredReason: partial.notConfiguredReason,
  };
}

/**
 * Reads pool `get_market` / `get_user` via ABI simulation (same inputs as dorkfi-app `fetchUserDataFromChain`).
 *
 * @param marketAppId — `underlyingContractId` in app config (second arg to `get_user` / `get_market`).
 */
export async function fetchMarketDebtSnapshot(
  algod: algosdk.Algodv2,
  poolAppId: number,
  marketAppId: number,
  userAddress: string,
  options?: MarketDebtSnapshotOptions,
): Promise<MarketDebtSnapshot> {
  const read = await readUserDebtFromLendingPool(
    algod,
    poolAppId,
    marketAppId,
    userAddress,
    options?.assetIdOverride,
  );
  if (!read.ok) {
    log.warn("lending_pool_debt_read_failed", {
      message: read.message,
      poolAppId,
      underlyingContractId: marketAppId,
    });
    return unconfiguredSnapshot({
      notConfiguredReason: read.message,
    });
  }

  const {
    borrowIndex,
    scaledBorrows,
    scaledDeposits,
    totalScaledDeposits,
    totalScaledBorrows,
    resolvedAssetId,
  } = read.data;
  const positionPartial = {
    borrowIndex,
    scaledBorrows,
    scaledDeposits,
    totalScaledDeposits,
    totalScaledBorrows,
    resolvedAssetId,
  };
  if (resolvedAssetId === null) {
    return unconfiguredSnapshot({
      ...positionPartial,
      notConfiguredReason:
        "Could not resolve debt ASA id (underlying is not an ASA on this network and nToken id from get_market is missing or invalid). Omit repay `assetId` to infer from the pool, or pass the `assetId` returned by GET /pools/:poolAppId/markets/:marketAppId/debt/:userAddress.",
    });
  }
  if (borrowIndex <= 0n) {
    return unconfiguredSnapshot({
      ...positionPartial,
      notConfiguredReason: `Invalid borrow_index (${borrowIndex.toString()}) from get_market simulation.`,
    });
  }

  const meta = await loadAlgorandAssetOrAppDecimals(algod, resolvedAssetId);
  if (meta === undefined) {
    return unconfiguredSnapshot({
      ...positionPartial,
      notConfiguredReason: `Could not resolve decimals for id ${resolvedAssetId} (not an ASA on this network and not an app with global uint key "decimals"). For ARC-200 nToken markets, debt preview uses the nToken app id from get_market; POST /webhook/repay still needs the underlying ASA id for nt200 deposit (e.g. mainnet USDC 31566704 for the example USDC market).`,
    });
  }

  const currentDebt = applyBorrowIndex(scaledBorrows, borrowIndex);
  return {
    borrowIndex,
    scaledBorrows,
    scaledDeposits,
    totalScaledDeposits,
    totalScaledBorrows,
    currentDebt,
    decimals: meta.decimals,
    decimalsSource: meta.source,
    configured: true,
    currentDebtFormatted: formatUnits(currentDebt, meta.decimals),
    resolvedAssetId,
  };
}

export type RepayBuildResult = {
  repayAmountBaseUnits: bigint;
  transactions: algosdk.Transaction[];
};

export type DorkfiNotConfiguredDetails = {
  reason: string;
  poolAppId: number;
  marketAppId: number;
  assetId: number;
  userAddress: string;
  /** Raw `DORKFI_LENDING_POOL_APP_ID` env (empty if unset). */
  dorkfiLendingPoolAppIdEnv: string;
};

export class DorkfiNotConfiguredError extends Error {
  readonly details: DorkfiNotConfiguredDetails;

  constructor(details: DorkfiNotConfiguredDetails) {
    super(details.reason);
    this.name = "DorkfiNotConfiguredError";
    this.details = details;
  }
}

/**
 * Builds the full repay atomic group (nt200 wrap + approve + pool `repay_on_behalf`) via ulujs/arccjs,
 * aligned with dorkfi-app. `uint64` market id in the pool call is **`marketAppId`** (`underlyingContractId`).
 */
export async function buildDorkFiRepayGroup(params: {
  algod: algosdk.Algodv2;
  /** Pays fees and holds ARC-200 balance for the axfer; must sign the group in execute mode. */
  payerAddress: string;
  /** Borrower whose debt is simulated and passed to the market app `repay_on_behalf` accounts. */
  userAddress: string;
  marketAppId: number;
  assetId: number;
  repayMode: "exact" | "max";
  repayAmount: string;
  repayMaxBufferBaseUnits?: bigint;
  chainId: ChainId;
}): Promise<RepayBuildResult> {
  const {
    algod,
    payerAddress,
    userAddress,
    marketAppId,
    assetId,
    repayMode,
    repayAmount,
    repayMaxBufferBaseUnits = 0n,
    chainId,
  } = params;

  const poolRaw = process.env.DORKFI_LENDING_POOL_APP_ID?.trim();
  const poolNum = poolRaw ? Number(poolRaw) : NaN;
  const poolAppId =
    Number.isFinite(poolNum) && poolNum > 0 ? poolNum : marketAppId;

  const snapshot = await fetchMarketDebtSnapshot(algod, poolAppId, marketAppId, userAddress, {
    assetIdOverride: assetId,
  });
  if (!snapshot.configured) {
    throw new DorkfiNotConfiguredError({
      reason:
        snapshot.notConfiguredReason ??
        "Debt snapshot is not configured (pool simulation or ASA metadata incomplete).",
      poolAppId,
      marketAppId,
      assetId,
      userAddress,
      dorkfiLendingPoolAppIdEnv: poolRaw ?? "",
    });
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

  const txns = await buildRepayOnBehalfGroupArccjs({
    algod,
    payerAddress,
    borrowerAddress: userAddress,
    poolAppId,
    tokenAppId: marketAppId,
    underlyingAsaId: assetId,
    repayAmountBaseUnits,
    chainId,
  });
  log.info("dorkfi_repay_group_built", {
    marketAppId,
    assetId,
    repayMode,
    repayAmountBaseUnits: repayAmountBaseUnits.toString(),
    borrower: userAddress,
    payer: payerAddress,
  });

  return { repayAmountBaseUnits, transactions: txns };
}
