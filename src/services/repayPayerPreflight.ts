import algosdk from "algosdk";

export class PayerInsufficientBalanceError extends Error {
  readonly code = "PAYER_INSUFFICIENT_BALANCE" as const;
  readonly details: {
    kind: "underlying_asa";
    payerAddress: string;
    assetId: number;
    required: string;
    available: string;
    frozen?: boolean;
  };

  constructor(details: PayerInsufficientBalanceError["details"], message: string) {
    super(message);
    this.name = "PayerInsufficientBalanceError";
    this.details = details;
  }
}

/**
 * Ensures the repay payer holds enough of the underlying ASA (`assetId` from the webhook).
 * Uses a single Algod `accountInformation` read; no transaction group is required.
 * When `SERVER_SIGNER_MNEMONIC` is set, the payer is the server signer — this is that account’s ASA balance.
 */
export async function assertPayerCanFundRepay(params: {
  algod: algosdk.Algodv2;
  payerAddress: string;
  underlyingAsaId: number;
  repayAmountBaseUnits: bigint;
}): Promise<void> {
  const { algod, payerAddress, underlyingAsaId, repayAmountBaseUnits } = params;

  const info = await algod.accountInformation(payerAddress).do();

  const holding = info.assets?.find((a) => Number(a.assetId) === underlyingAsaId);
  const asaAvailable = holding ? holding.amount : 0n;

  if (holding?.isFrozen) {
    throw new PayerInsufficientBalanceError(
      {
        kind: "underlying_asa",
        payerAddress,
        assetId: underlyingAsaId,
        required: repayAmountBaseUnits.toString(),
        available: asaAvailable.toString(),
        frozen: true,
      },
      `Repay payer ${payerAddress} cannot send ASA ${underlyingAsaId}: holding is frozen.`,
    );
  }

  if (asaAvailable < repayAmountBaseUnits) {
    const reason = holding
      ? "Repay payer does not hold enough of the underlying asset."
      : "Repay payer is not opted in to the underlying ASA (or has zero balance).";
    throw new PayerInsufficientBalanceError(
      {
        kind: "underlying_asa",
        payerAddress,
        assetId: underlyingAsaId,
        required: repayAmountBaseUnits.toString(),
        available: asaAvailable.toString(),
      },
      `${reason} Payer ${payerAddress} needs at least ${repayAmountBaseUnits.toString()} base units of ASA ${underlyingAsaId}; available: ${asaAvailable.toString()}.`,
    );
  }
}
