/**
 * CLI: Algod-only check that the server signer holds enough of an ASA (no repay build, no submit).
 *
 * Env:
 * - SERVER_SIGNER_MNEMONIC — account whose ASA balance is read (same signer as execute path)
 * - REPAY_UNDERLYING_ASA_ID — ASA to check (default 31566704 mainnet USDC)
 * - REPAY_TEST_AMOUNT — human decimal string compared against balance (default "0.1")
 * - REPAY_DECIMALS — decimals for that amount (default 6)
 * - REPAY_CHAIN — default algorand-mainnet
 *
 * Usage: npm run script:test-repay-payer-balance
 */
import "dotenv/config";
import { getChainConfig } from "../config/chains.js";
import { parseUnits } from "../lib/amounts.js";
import { makeAlgodClient, addressFromMnemonic } from "../services/algorand.js";
import { assertPayerCanFundRepay, PayerInsufficientBalanceError } from "../services/repayPayerPreflight.js";
import type { ChainId } from "../types.js";

const SUPPORTED: ChainId[] = ["algorand-mainnet", "algorand-testnet", "voi-mainnet", "voi-testnet"];

async function main(): Promise<void> {
  const mnemonic = process.env.SERVER_SIGNER_MNEMONIC?.trim();
  if (!mnemonic) {
    console.error("Set SERVER_SIGNER_MNEMONIC (account to inspect).");
    process.exit(1);
  }

  const chainRaw = process.env.REPAY_CHAIN?.trim() ?? "algorand-mainnet";
  if (!SUPPORTED.includes(chainRaw as ChainId)) {
    console.error(`REPAY_CHAIN must be one of: ${SUPPORTED.join(", ")}`);
    process.exit(1);
  }
  const chain = chainRaw as ChainId;

  const underlyingAsaId = Number(process.env.REPAY_UNDERLYING_ASA_ID ?? "31566704");
  if (!Number.isFinite(underlyingAsaId) || underlyingAsaId <= 0) {
    console.error("Invalid REPAY_UNDERLYING_ASA_ID.");
    process.exit(1);
  }

  const humanAmount = process.env.REPAY_TEST_AMOUNT?.trim() ?? "0.1";
  const decimals = Number(process.env.REPAY_DECIMALS ?? "6");
  let repayAmountBaseUnits: bigint;
  try {
    repayAmountBaseUnits = parseUnits(humanAmount, decimals);
  } catch {
    console.error(`Invalid REPAY_TEST_AMOUNT / REPAY_DECIMALS: ${humanAmount} (${decimals} dp)`);
    process.exit(1);
  }

  if (repayAmountBaseUnits <= 0n) {
    console.error("Required amount must be positive.");
    process.exit(1);
  }

  const payer = addressFromMnemonic(mnemonic);
  const cfg = getChainConfig(chain);
  const algod = makeAlgodClient(cfg.algod);

  console.log(
    JSON.stringify(
      {
        step: "balance_check",
        chain,
        underlyingAsaId,
        payer,
        repayTestAmount: humanAmount,
        repayDecimals: decimals,
        repayAmountBaseUnits: repayAmountBaseUnits.toString(),
      },
      null,
      2,
    ),
  );

  try {
    await assertPayerCanFundRepay({
      algod,
      payerAddress: payer,
      underlyingAsaId,
      repayAmountBaseUnits,
    });
  } catch (e) {
    if (e instanceof PayerInsufficientBalanceError) {
      console.error("Balance check failed (PAYER_INSUFFICIENT_BALANCE):", e.message);
      console.error(JSON.stringify({ details: e.details }, null, 2));
      process.exit(1);
    }
    throw e;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        message: "Server account holds at least the required ASA balance (same check as webhook preflight).",
        repayAmountBaseUnits: repayAmountBaseUnits.toString(),
      },
      null,
      2,
    ),
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
