import algosdk from "algosdk";

/**
 * Matches dorkfi-app `fetchUserDataFromChain` (pool `get_user` / `get_market`):
 * https://github.com/DorkFi/dorkfi-app/blob/next/src/services/lendingService.ts#L1376
 *
 * Uses the same **`SimulateRequest`** shape as **arccjs / ulujs `CONTRACT`** (see `node_modules/arccjs/src/lib/contract.js`)
 * plus **`allow-more-logging`** and **`extra-opcode-budget`** so Puya builds can emit ABI return logs
 * (plain `AtomicTransactionComposer.simulate()` often yields “did not log a return value”).
 */
export const LENDING_POOL_GET_MARKET = algosdk.ABIMethod.fromSignature(
  "get_market(uint64)(bool,uint256,uint256,uint64,uint64,uint64,uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint64,uint256,uint256,uint64,uint64)",
);

export const LENDING_POOL_GET_USER = algosdk.ABIMethod.fromSignature(
  "get_user(address,uint64)(uint256,uint256,uint256,uint256,uint64,uint256)",
);

/**
 * Pool app `repay_on_behalf` — payer repays for `beneficiary`; extra `address` vs `repay`.
 * Verified against DorkFi lending ABI (see dorkfi-app `builder.lending.repay_on_behalf`).
 */
export const LENDING_POOL_REPAY_ON_BEHALF = algosdk.ABIMethod.fromSignature(
  "repay_on_behalf(uint64,uint256,address)uint256",
);

/** ARC-4 `appArgs`: selector + ABI-encoded method arguments. */
export function encodeLendingPoolAppCall(
  method: algosdk.ABIMethod,
  methodArgs: algosdk.ABIValue[],
): Uint8Array[] {
  const encodedArgs = methodArgs.map((arg, index) => {
    const t = method.args[index].type as { encode: (v: algosdk.ABIValue) => Uint8Array };
    return t.encode(arg);
  });
  return [method.getSelector(), ...encodedArgs];
}

/** `MarketData` tuple index for `total_scaled_deposits` (uint256). */
const MARKET_IX_TOTAL_SCALED_DEPOSITS = 9;
/** `MarketData` tuple index for `total_scaled_borrows` (uint256). */
const MARKET_IX_TOTAL_SCALED_BORROWS = 10;
/** `MarketData` tuple index for `borrow_index` (uint256). */
const MARKET_IX_BORROW_INDEX = 12;
/** `MarketData` tuple index for `ntoken_id` (uint64). */
const MARKET_IX_NTOKEN_ID = 16;
/** `UserData` tuple index for `scaled_deposits` (uint256). */
const USER_IX_SCALED_DEPOSITS = 0;
/** `UserData` tuple index for `scaled_borrows` (uint256). */
const USER_IX_SCALED_BORROWS = 1;

export type LendingPoolDebtRead = {
  borrowIndex: bigint;
  /** User `get_user` scaled borrows (uint256). */
  scaledBorrows: bigint;
  /** User `get_user` scaled deposits (uint256). */
  scaledDeposits: bigint;
  /** Market `get_market` aggregate scaled deposits. */
  totalScaledDeposits: bigint;
  /** Market `get_market` aggregate scaled borrows. */
  totalScaledBorrows: bigint;
  resolvedAssetId: number | null;
};

async function simulatePoolMethod(
  algod: algosdk.Algodv2,
  poolAppId: number,
  method: algosdk.ABIMethod,
  methodArgs: algosdk.ABIValue[],
): Promise<{ ok: true; returnValue: algosdk.ABIValue } | { ok: false; message: string }> {
  const sender = algosdk.encodeAddress(algosdk.getApplicationAddress(poolAppId).publicKey);
  const params = await algod.getTransactionParams().do();
  params.flatFee = true;
  const minFee = params.minFee ?? 1000n;
  params.fee = minFee > 1000n ? minFee : 1000n;

  const encodedArgs = methodArgs.map((arg, index) => {
    const t = method.args[index].type as { encode: (v: algosdk.ABIValue) => Uint8Array };
    return t.encode(arg);
  });
  const appAccounts =
    method.name === "get_user" && typeof methodArgs[0] === "string"
      ? [methodArgs[0] as string]
      : undefined;

  const appCall = algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    suggestedParams: params,
    appIndex: poolAppId,
    appArgs: [method.getSelector(), ...encodedArgs],
    accounts: appAccounts,
  });

  try {
    const encodedTxn = algosdk.encodeUnsignedSimulateTransaction(appCall);
    const signedTxn = algosdk.decodeSignedTransaction(encodedTxn);
    const txnGroup = new algosdk.modelsv2.SimulateRequestTransactionGroup({
      txns: [signedTxn],
    });
    const request = new algosdk.modelsv2.SimulateRequest({
      txnGroups: [txnGroup],
      allowUnnamedResources: true,
      allowEmptySignatures: true,
      fixSigners: true,
      allowMoreLogging: true,
      // Algod caps extra budget per simulate request (typically 320000).
      extraOpcodeBudget: 320000n,
    });

    const response = await algod.simulateTransactions(request).do();
    const group = response.txnGroups[0];
    if (group.failureMessage) {
      return { ok: false, message: String(group.failureMessage) };
    }
    const txnResult = group.txnResults[0].txnResult;
    const methodResult = {
      txID: "",
      method,
      rawReturnValue: new Uint8Array(),
    } satisfies algosdk.ABIResult;
    const parsed = algosdk.AtomicTransactionComposer.parseMethodResponse(method, methodResult, txnResult);
    if (parsed.decodeError) {
      return { ok: false, message: parsed.decodeError.message };
    }
    if (parsed.returnValue === undefined) {
      return { ok: false, message: "empty ABI return" };
    }
    return { ok: true, returnValue: parsed.returnValue };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function asTuple(v: algosdk.ABIValue): unknown[] {
  if (!Array.isArray(v)) {
    throw new Error("expected ABI tuple");
  }
  return v;
}

function toBigint(v: unknown): bigint {
  if (typeof v === "bigint") {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return BigInt(Math.trunc(v));
  }
  if (typeof v === "boolean") {
    return v ? 1n : 0n;
  }
  throw new Error(`cannot coerce to bigint: ${typeof v}`);
}

function bigintToPositiveNumber(b: bigint): number | null {
  if (b <= 0n || b > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(b);
}

/**
 * @param underlyingContractId — Same `uint64` as dorkfi-app `get_user` / `get_market` (e.g. token `underlyingContractId`).
 */
export async function readUserDebtFromLendingPool(
  algod: algosdk.Algodv2,
  poolAppId: number,
  underlyingContractId: number,
  userAddress: string,
  assetIdOverride?: number,
): Promise<{ ok: true; data: LendingPoolDebtRead } | { ok: false; message: string }> {
  const marketR = await simulatePoolMethod(algod, poolAppId, LENDING_POOL_GET_MARKET, [
    BigInt(underlyingContractId),
  ]);
  if (!marketR.ok) {
    return { ok: false, message: `get_market: ${marketR.message}` };
  }

  const userR = await simulatePoolMethod(algod, poolAppId, LENDING_POOL_GET_USER, [
    userAddress,
    BigInt(underlyingContractId),
  ]);
  if (!userR.ok) {
    return { ok: false, message: `get_user: ${userR.message}` };
  }

  const mt = asTuple(marketR.returnValue);
  const ut = asTuple(userR.returnValue);
  const borrowIndex = toBigint(mt[MARKET_IX_BORROW_INDEX]);
  const scaledBorrows = toBigint(ut[USER_IX_SCALED_BORROWS]);
  const scaledDeposits = toBigint(ut[USER_IX_SCALED_DEPOSITS]);
  const totalScaledDeposits = toBigint(mt[MARKET_IX_TOTAL_SCALED_DEPOSITS]);
  const totalScaledBorrows = toBigint(mt[MARKET_IX_TOTAL_SCALED_BORROWS]);

  let resolvedAssetId: number | null = null;
  if (typeof assetIdOverride === "number" && Number.isFinite(assetIdOverride) && assetIdOverride > 0) {
    resolvedAssetId = assetIdOverride;
  } else {
    try {
      await algod.getAssetByID(underlyingContractId).do();
      resolvedAssetId = underlyingContractId;
    } catch {
      const ntoken = toBigint(mt[MARKET_IX_NTOKEN_ID]);
      resolvedAssetId = bigintToPositiveNumber(ntoken);
    }
  }

  return {
    ok: true,
    data: {
      borrowIndex,
      scaledBorrows,
      scaledDeposits,
      totalScaledDeposits,
      totalScaledBorrows,
      resolvedAssetId,
    },
  };
}
