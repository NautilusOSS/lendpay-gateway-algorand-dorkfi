import "dotenv/config";
import express from "express";
import algosdk from "algosdk";
import { z } from "zod";
import repayRouter from "./routes/repay.js";
import { defaultChainFromEnv, getChainConfig, listConfiguredChains } from "./config/chains.js";
import { makeAlgodClient } from "./services/algorand.js";
import { fetchMarketDebtSnapshot } from "./services/dorkfi.js";
import { readAlgodHttpStatus } from "./lib/algodHttp.js";
import { log } from "./lib/logger.js";
import { getPaymentMaxAgeSeconds } from "./services/basePayment.js";

const chainQuerySchema = z.enum([
  "algorand-mainnet",
  "algorand-testnet",
  "voi-mainnet",
  "voi-testnet",
]);

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/chains", (_req, res) => {
  res.json({
    defaultChain: process.env.DEFAULT_CHAIN ?? "algorand-mainnet",
    chains: listConfiguredChains(),
  });
});

app.get("/pools/:poolAppId/markets/:marketAppId/debt/:userAddress", async (req, res, next) => {
  let chain: z.infer<typeof chainQuerySchema> | undefined;
  let poolAppId = 0;
  let marketAppId = 0;
  try {
    poolAppId = Number(req.params.poolAppId);
    if (!Number.isFinite(poolAppId) || poolAppId <= 0) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid poolAppId" });
      return;
    }
    marketAppId = Number(req.params.marketAppId);
    if (!Number.isFinite(marketAppId) || marketAppId <= 0) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid marketAppId" });
      return;
    }
    const userAddress = req.params.userAddress;
    if (!algosdk.isValidAddress(userAddress)) {
      res.status(400).json({
        ok: false,
        error: "INVALID_ALGORAND_ADDRESS",
        message: "Invalid user address",
      });
      return;
    }

    const chainParam = req.query.chain;
    if (chainParam === undefined || chainParam === "") {
      chain = defaultChainFromEnv();
    } else if (typeof chainParam !== "string") {
      res.status(400).json({
        ok: false,
        error: "UNSUPPORTED_CHAIN",
        message: "chain query parameter must be a string",
      });
      return;
    } else {
      const chainParsed = chainQuerySchema.safeParse(chainParam);
      if (!chainParsed.success) {
        res.status(400).json({
          ok: false,
          error: "UNSUPPORTED_CHAIN",
          message: "Invalid or unsupported chain query parameter",
        });
        return;
      }
      chain = chainParsed.data;
    }

    const cfg = getChainConfig(chain);
    const algod = makeAlgodClient(cfg.algod);
    const snapshot = await fetchMarketDebtSnapshot(algod, poolAppId, marketAppId, userAddress);
    res.json({
      ok: true,
      chain,
      poolAppId,
      marketAppId,
      underlyingContractId: marketAppId,
      userAddress,
      assetId: snapshot.resolvedAssetId,
      configured: snapshot.configured,
      ...(snapshot.notConfiguredReason ? { notConfiguredReason: snapshot.notConfiguredReason } : {}),
      borrowIndex: snapshot.borrowIndex.toString(),
      scaledDeposits: snapshot.scaledDeposits.toString(),
      scaledBorrows: snapshot.scaledBorrows.toString(),
      totalScaledDeposits: snapshot.totalScaledDeposits.toString(),
      totalScaledBorrows: snapshot.totalScaledBorrows.toString(),
      currentDebtBaseUnits: snapshot.currentDebt.toString(),
      currentDebtFormatted: snapshot.currentDebtFormatted,
      decimals: snapshot.decimals,
      ...(snapshot.decimalsSource ? { decimalsSource: snapshot.decimalsSource } : {}),
    });
  } catch (e) {
    const httpStatus = readAlgodHttpStatus(e);
    if (httpStatus === 404) {
      log.warn("debt_snapshot_not_found", { poolAppId, marketAppId, chain, err: String(e) });
      res.status(404).json({
        ok: false,
        error: "CHAIN_RESOURCE_NOT_FOUND",
        message:
          "Algod returned 404: the pool or market application or resolved debt ASA does not exist on this network, or the account has no local state for the market. Check poolAppId, marketAppId, and chain match your Algod endpoint.",
      });
      return;
    }
    if (httpStatus !== undefined) {
      log.warn("debt_snapshot_algod_http", { poolAppId, marketAppId, chain, httpStatus, err: String(e) });
      res.status(502).json({
        ok: false,
        error: "ALGOD_ERROR",
        message: `Algod request failed (HTTP ${httpStatus})`,
      });
      return;
    }
    next(e);
  }
});

app.use("/webhook", repayRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  void _next;
  log.error("unhandled_error", { err: String(err) });
  res.status(500).json({
    ok: false,
    error: "INTERNAL_ERROR",
    message: "Unexpected server error",
  });
});

const port = Number(process.env.PORT ?? "3000");
app.listen(port, () => {
  log.info("server_listen", {
    port,
    paymentMaxAgeSeconds: getPaymentMaxAgeSeconds(),
  });
});
