import type { ChainId } from "../types.js";

export type AlgodConfig = {
  server: string;
  port: string;
  token: string;
};

export type IndexerConfig = {
  server: string;
  port: string;
  token: string;
};

export type ChainRuntimeConfig = {
  id: ChainId;
  algod: AlgodConfig;
  indexer: IndexerConfig;
};

const SUPPORTED: ChainId[] = [
  "algorand-mainnet",
  "algorand-testnet",
  "voi-mainnet",
  "voi-testnet",
];

function readAlgodFromEnv(prefix: string): AlgodConfig {
  const server = process.env[`${prefix}ALGOD_SERVER`] ?? process.env.ALGOD_SERVER;
  const port = process.env[`${prefix}ALGOD_PORT`] ?? process.env.ALGOD_PORT ?? "443";
  const token = process.env[`${prefix}ALGOD_TOKEN`] ?? process.env.ALGOD_TOKEN ?? "";
  if (!server) {
    throw new Error(`Missing ALGOD_SERVER (or ${prefix}ALGOD_SERVER) for chain configuration`);
  }
  return { server, port, token };
}

function readIndexerFromEnv(prefix: string): IndexerConfig {
  const server = process.env[`${prefix}INDEXER_SERVER`] ?? process.env.INDEXER_SERVER;
  const port = process.env[`${prefix}INDEXER_PORT`] ?? process.env.INDEXER_PORT ?? "443";
  const token = process.env[`${prefix}INDEXER_TOKEN`] ?? process.env.INDEXER_TOKEN ?? "";
  if (!server) {
    throw new Error(
      `Missing INDEXER_SERVER (or ${prefix}INDEXER_SERVER) for chain configuration`,
    );
  }
  return { server, port, token };
}

/** Per-chain env prefix (optional). Falls back to shared ALGOD_* / INDEXER_* when unset. */
function envPrefixForChain(chain: ChainId): string {
  switch (chain) {
    case "algorand-mainnet":
      return "";
    case "algorand-testnet":
      return "TESTNET_";
    case "voi-mainnet":
      return "VOI_MAINNET_";
    case "voi-testnet":
      return "VOI_TESTNET_";
    default: {
      const _exhaustive: never = chain;
      return _exhaustive;
    }
  }
}

export function getChainConfig(chain: ChainId): ChainRuntimeConfig {
  if (!SUPPORTED.includes(chain)) {
    throw new Error(`Unsupported chain: ${chain}`);
  }
  const prefix = envPrefixForChain(chain);
  return {
    id: chain,
    algod: readAlgodFromEnv(prefix),
    indexer: readIndexerFromEnv(prefix),
  };
}

export function defaultChainFromEnv(): ChainId {
  const raw = (process.env.DEFAULT_CHAIN ?? "algorand-mainnet").trim() as ChainId;
  if (!SUPPORTED.includes(raw)) {
    throw new Error(`DEFAULT_CHAIN must be one of: ${SUPPORTED.join(", ")}`);
  }
  return raw;
}

export function listConfiguredChains(): ChainId[] {
  return [...SUPPORTED];
}
