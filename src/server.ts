import "dotenv/config";
import express from "express";
import algosdk from "algosdk";
import { z } from "zod";
import repayRouter from "./routes/repay.js";
import { defaultChainFromEnv, getChainConfig, listConfiguredChains } from "./config/chains.js";
import { makeAlgodClient } from "./services/algorand.js";
import { fetchMarketDebtSnapshot } from "./services/dorkfi.js";
import { log } from "./lib/logger.js";

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

app.get("/markets/:marketAppId/debt/:userAddress", async (req, res, next) => {
  try {
    const marketAppId = Number(req.params.marketAppId);
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
    const assetIdRaw = req.query.assetId;
    if (typeof assetIdRaw !== "string" || !/^\d+$/.test(assetIdRaw)) {
      res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        message: "Query parameter assetId (positive integer) is required",
      });
      return;
    }
    const assetId = Number(assetIdRaw);

    const chainParam = req.query.chain;
    let chain: z.infer<typeof chainQuerySchema>;
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
    const snapshot = await fetchMarketDebtSnapshot(algod, marketAppId, userAddress, assetId);
    res.json({
      ok: true,
      chain,
      marketAppId,
      userAddress,
      assetId,
      configured: snapshot.configured,
      borrowIndex: snapshot.borrowIndex.toString(),
      scaledBorrows: snapshot.scaledBorrows.toString(),
      currentDebtBaseUnits: snapshot.currentDebt.toString(),
      currentDebtFormatted: snapshot.currentDebtFormatted,
      decimals: snapshot.decimals,
    });
  } catch (e) {
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
  log.info("server_listen", { port });
});
