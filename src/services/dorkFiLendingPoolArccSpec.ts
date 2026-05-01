/**
 * Minimal ABI surface for arccjs `CONTRACT` to build `repay_on_behalf` (matches on-chain ARC-4).
 * Full generated client lives in dorkfi-app `DorkFiLendingPoolClient.ts`.
 */
export const DORKFI_LENDING_POOL_ARCC_SPEC = {
  name: "DorkFiLendingPool",
  desc: "Gateway subset",
  methods: [
    {
      name: "repay_on_behalf",
      args: [
        { type: "uint64", name: "marketId" },
        { type: "uint256", name: "amount" },
        { type: "address", name: "beneficiary" },
      ],
      returns: { type: "uint256", desc: "out" },
    },
  ],
  events: [],
};
