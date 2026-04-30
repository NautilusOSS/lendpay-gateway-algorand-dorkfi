import algosdk from "algosdk";

type SuggestedParams = NonNullable<
  Parameters<typeof algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject>[0]["suggestedParams"]
>;

/**
 * ARC-200 (Algorand fungible) transfer / approval path toward a DorkFi market.
 *
 * TODO: Confirm whether DorkFi expects `axfer` to the market app account, an ARC-200
 * `ApplicationCall` approval flow, or inner payments — wire the correct opcode + args.
 * TODO: Add foreign apps/assets and box references required by the ARC-200 controller app.
 */
export function buildArc200TransferOrApproveTxns(params: {
  sender: string;
  marketAppId: number;
  assetId: number;
  repayAmountBaseUnits: bigint;
  suggestedParams: SuggestedParams;
}): algosdk.Transaction[] {
  const { sender, marketAppId, assetId, repayAmountBaseUnits, suggestedParams } = params;
  if (repayAmountBaseUnits <= 0n) {
    return [];
  }
  const marketAddr = algosdk.getApplicationAddress(marketAppId);
  const amount =
    repayAmountBaseUnits > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(repayAmountBaseUnits);
  // TODO: If amounts can exceed MAX_SAFE_INTEGER, chunk into multiple txns or use appl-based amounts.
  const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver: marketAddr,
    amount,
    assetIndex: assetId,
    suggestedParams,
  });
  return [axfer];
}
