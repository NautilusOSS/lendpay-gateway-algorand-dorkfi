import algosdk from "algosdk";
import { CONTRACT, abi } from "ulujs";
import type { ChainId } from "../types.js";
import { DORKFI_LENDING_POOL_ARCC_SPEC } from "./dorkFiLendingPoolArccSpec.js";

const ALGORAND_MAINNET_BEACON_APP_ID = 3209233839;

type ArccjsAccount = { addr: string; sk: Uint8Array };

function emptyAccount(addr: string): ArccjsAccount {
  return { addr, sk: new Uint8Array(0) };
}

/**
 * Builds the same repay-on-behalf atomic group as dorkfi-app (`lendingService.repayOnBehalf` ASA path):
 * arccjs `CONTRACT` + `abi.nt200` for wrap/approve, minimal pool spec for `repay_on_behalf`, then
 * `abi.custom` anchor on the pool with `setExtraTxns` + `setEnableGroupResourceSharing` + optional beacon (mainnet).
 */
export async function buildRepayOnBehalfGroupArccjs(params: {
  algod: algosdk.Algodv2;
  payerAddress: string;
  borrowerAddress: string;
  poolAppId: number;
  /** nt200 / underlying token app id (= webhook `marketAppId`). */
  tokenAppId: number;
  underlyingAsaId: number;
  repayAmountBaseUnits: bigint;
  chainId: ChainId;
}): Promise<algosdk.Transaction[]> {
  const {
    algod,
    payerAddress,
    borrowerAddress,
    poolAppId,
    tokenAppId,
    underlyingAsaId,
    repayAmountBaseUnits,
    chainId,
  } = params;

  const acc = emptyAccount(payerAddress);
  const tokenCi = new CONTRACT(tokenAppId, algod, undefined, abi.nt200, acc, true, false, true);
  const lendingCi = new CONTRACT(poolAppId, algod, undefined, DORKFI_LENDING_POOL_ARCC_SPEC, acc, true, false, true);
  const ci = new CONTRACT(poolAppId, algod, undefined, abi.custom, acc);

  const bigAmount = repayAmountBaseUnits;
  const marketIdNum = Number(tokenAppId);
  const poolAddrB32 = algosdk.encodeAddress(algosdk.getApplicationAddress(poolAppId).publicKey);
  const aamt = Number(bigAmount);

  let lastFailure: unknown;
  for (const [p1, p2] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const buildN: Record<string, unknown>[] = [];

    if (p1 > 0) {
      const txnO = (await tokenCi.createBalanceBox(payerAddress)).obj as Record<string, unknown>;
      buildN.push({
        ...txnO,
        payment: 28501,
        note: new TextEncoder().encode("nt200 createBalanceBox"),
      });
    }

    {
      const txnO = (await tokenCi.deposit(bigAmount)).obj as Record<string, unknown>;
      buildN.push({
        ...txnO,
        aamt,
        xaid: underlyingAsaId,
        note: new TextEncoder().encode("nt200 deposit"),
      });
    }

    {
      const txnO = (await tokenCi.arc200_approve(poolAddrB32, bigAmount)).obj as Record<string, unknown>;
      buildN.push({
        ...txnO,
        note: new TextEncoder().encode("arc200 approve pool spend"),
        payment: p2 > 0 ? 28502 : 0,
      });
    }

    {
      const txnO = (await lendingCi.repay_on_behalf(marketIdNum, bigAmount, borrowerAddress)).obj as Record<
        string,
        unknown
      >;
      buildN.push({
        ...txnO,
        payment: 200_000,
        note: new TextEncoder().encode("lending repayOnBehalf"),
      });
    }

    ci.setEnableGroupResourceSharing(true);
    ci.setExtraTxns(buildN);
    ci.setFee(100_000);
    if (chainId === "algorand-mainnet") {
      ci.setBeaconId(ALGORAND_MAINNET_BEACON_APP_ID);
    }

    const customR = (await ci.custom()) as { success?: boolean; txns?: string[]; error?: unknown };
    if (customR.success && Array.isArray(customR.txns) && customR.txns.length > 0) {
      return customR.txns.map((b64) => algosdk.decodeUnsignedTransaction(Buffer.from(b64, "base64")));
    }
    lastFailure = customR.error ?? customR;
  }

  const detail = lastFailure !== undefined ? String(lastFailure) : "unknown arccjs failure";
  throw new Error(`ARCCJS_REPAY_BUILD_FAILED: ${detail}`);
}
