import algosdk, { waitForConfirmation } from "algosdk";
import type { AlgodConfig, IndexerConfig } from "../config/chains.js";
import { log } from "../lib/logger.js";

export function makeAlgodClient(cfg: AlgodConfig): algosdk.Algodv2 {
  const port = Number.parseInt(cfg.port, 10);
  return new algosdk.Algodv2(cfg.token, cfg.server, Number.isFinite(port) ? port : 443);
}

export function makeIndexerClient(cfg: IndexerConfig): algosdk.Indexer {
  const port = Number.parseInt(cfg.port, 10);
  return new algosdk.Indexer(cfg.token, cfg.server, Number.isFinite(port) ? port : 443);
}

export function addressFromMnemonic(mnemonic: string): string {
  const acct = algosdk.mnemonicToSecretKey(mnemonic.trim());
  return String(acct.addr);
}

export function signTxnsWithMnemonic(
  mnemonic: string,
  txns: algosdk.Transaction[],
): Uint8Array[] {
  const sk = algosdk.mnemonicToSecretKey(mnemonic.trim()).sk;
  return txns.map((txn) => txn.signTxn(sk));
}

export async function sendAndConfirmGroup(
  algod: algosdk.Algodv2,
  signedTxns: Uint8Array[],
): Promise<{ txIds: string[]; confirmedRound: number }> {
  const first = signedTxns[0];
  if (!first) {
    throw new Error("No signed transactions");
  }
  await algod.sendRawTransaction(signedTxns).do();
  const txId = algosdk.decodeSignedTransaction(first).txn.txID();
  const result = await waitForConfirmation(algod, txId, 32);
  const confirmedRound = Number(result.confirmedRound ?? 0);
  const txIds = signedTxns.map((st) => algosdk.decodeSignedTransaction(st).txn.txID());
  log.info("algorand_group_confirmed", { txIds, confirmedRound });
  return { txIds, confirmedRound };
}
