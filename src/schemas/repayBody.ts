import { z } from "zod";

const chainEnum = z.enum([
  "algorand-mainnet",
  "algorand-testnet",
  "voi-mainnet",
  "voi-testnet",
]);

export const repayWebhookBodySchema = z.object({
  /** Borrower whose on-chain debt is repaid (pool `get_user` / repay_on_behalf accounts). */
  userAddress: z.string().min(1),
  /**
   * Optional payer when `SERVER_SIGNER_MNEMONIC` is unset: account that sends ARC-200 / app txs
   * (defaults to `userAddress`). When the mnemonic is set, the payer is always the mnemonic-derived
   * address and this field is ignored (logged if it differs).
   */
  payerAddress: z.string().min(1).optional(),
  marketAppId: z.number().int().positive(),
  assetId: z.number().int().positive(),
  repayAmount: z.string().min(1),
  repayMode: z.enum(["exact", "max"]),
  chain: chainEnum,
  basePaymentTxId: z.string().min(1),
  requestId: z.string().min(1).optional(),
});

export type RepayWebhookBody = z.infer<typeof repayWebhookBodySchema>;
