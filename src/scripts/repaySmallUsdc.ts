/**
 * CLI: build nt200 + repay_on_behalf group via arccjs, sign with SERVER_SIGNER_MNEMONIC, submit to Algod.
 *
 * Env (see .env.example for ALGOD_*):
 * - SERVER_SIGNER_MNEMONIC — payer (must hold USDC + ALGO; same as gateway execute)
 * - REPAY_BORROWER_ADDRESS — beneficiary passed to repay_on_behalf (often the borrower)
 * - DORKFI_LENDING_POOL_APP_ID — optional; defaults to REPAY_MARKET_APP_ID when unset
 * - REPAY_MARKET_APP_ID — default 3210682240 (USDC market app on mainnet A pool)
 * - REPAY_UNDERLYING_ASA_ID — default 31566704 (mainnet USDC ASA)
 * - REPAY_AMOUNT — human decimal string, default "0.01"
 * - REPAY_DECIMALS — default 6
 * - REPAY_CHAIN — default algorand-mainnet
 *
 * Usage: npm run script:repay-small-usdc
 */
import "dotenv/config";
import algosdk from "algosdk";
import { getChainConfig } from "../config/chains.js";
import { parseUnits } from "../lib/amounts.js";
import { makeAlgodClient, addressFromMnemonic, signTxnsWithMnemonic, sendAndConfirmGroup } from "../services/algorand.js";
import { buildRepayOnBehalfGroupArccjs } from "../services/repayGroupArccjs.js";
import type { ChainId } from "../types.js";

const SUPPORTED: ChainId[] = ["algorand-mainnet", "algorand-testnet", "voi-mainnet", "voi-testnet"];

function poolAppIdFromEnv(marketAppId: number): number {
  const poolRaw = process.env.DORKFI_LENDING_POOL_APP_ID?.trim();
  const poolNum = poolRaw ? Number(poolRaw) : NaN;
  return Number.isFinite(poolNum) && poolNum > 0 ? poolNum : marketAppId;
}

async function main(): Promise<void> {
  const mnemonic = process.env.SERVER_SIGNER_MNEMONIC?.trim();
  if (!mnemonic) {
    console.error("Set SERVER_SIGNER_MNEMONIC (payer account).");
    process.exit(1);
  }

  const borrower = process.env.REPAY_BORROWER_ADDRESS?.trim();
  if (!borrower || !algosdk.isValidAddress(borrower)) {
    console.error("Set REPAY_BORROWER_ADDRESS to a valid Algorand borrower address.");
    process.exit(1);
  }

  const chainRaw = process.env.REPAY_CHAIN?.trim() ?? "algorand-mainnet";
  if (!SUPPORTED.includes(chainRaw as ChainId)) {
    console.error(`REPAY_CHAIN must be one of: ${SUPPORTED.join(", ")}`);
    process.exit(1);
  }
  const chain = chainRaw as ChainId;

  const marketAppId = Number(process.env.REPAY_MARKET_APP_ID ?? "3210682240");
  if (!Number.isFinite(marketAppId) || marketAppId <= 0) {
    console.error("Invalid REPAY_MARKET_APP_ID.");
    process.exit(1);
  }

  const underlyingAsaId = Number(process.env.REPAY_UNDERLYING_ASA_ID ?? "31566704");
  if (!Number.isFinite(underlyingAsaId) || underlyingAsaId <= 0) {
    console.error("Invalid REPAY_UNDERLYING_ASA_ID.");
    process.exit(1);
  }

  const humanAmount = process.env.REPAY_AMOUNT?.trim() ?? "0.01";
  const decimals = Number(process.env.REPAY_DECIMALS ?? "6");
  let repayAmountBaseUnits: bigint;
  try {
    repayAmountBaseUnits = parseUnits(humanAmount, decimals);
  } catch {
    console.error(`Invalid REPAY_AMOUNT / REPAY_DECIMALS: ${humanAmount} (${decimals} dp)`);
    process.exit(1);
  }

  if (repayAmountBaseUnits <= 0n) {
    console.error("Repay amount must be positive.");
    process.exit(1);
  }

  const payer = addressFromMnemonic(mnemonic);
  const poolAppId = poolAppIdFromEnv(marketAppId);

  const cfg = getChainConfig(chain);
  const algod = makeAlgodClient(cfg.algod);

  console.log(
    JSON.stringify(
      {
        chain,
        poolAppId,
        marketAppId,
        underlyingAsaId,
        payer,
        borrower,
        repayAmountBaseUnits: repayAmountBaseUnits.toString(),
      },
      null,
      2,
    ),
  );

  const txns = await buildRepayOnBehalfGroupArccjs({
    algod,
    payerAddress: payer,
    borrowerAddress: borrower,
    poolAppId,
    tokenAppId: marketAppId,
    underlyingAsaId,
    repayAmountBaseUnits,
    chainId: chain,
  });

  console.log(`Signing and submitting ${txns.length} transactions…`);
  const signed = signTxnsWithMnemonic(mnemonic, txns);
  const { txIds, confirmedRound } = await sendAndConfirmGroup(algod, signed);
  console.log(JSON.stringify({ ok: true, txIds, confirmedRound }, null, 2));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
