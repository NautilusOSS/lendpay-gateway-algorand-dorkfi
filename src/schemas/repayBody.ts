import { z } from "zod";

const chainEnum = z.enum([
  "algorand-mainnet",
  "algorand-testnet",
  "voi-mainnet",
  "voi-testnet",
]);

export const repayWebhookBodySchema = z.object({
  userAddress: z.string().min(1),
  marketAppId: z.number().int().positive(),
  assetId: z.number().int().positive(),
  repayAmount: z.string().min(1),
  repayMode: z.enum(["exact", "max"]),
  chain: chainEnum,
  basePaymentTxId: z.string().min(1),
  requestId: z.string().min(1).optional(),
});

export type RepayWebhookBody = z.infer<typeof repayWebhookBodySchema>;
