import algosdk from "algosdk";

export type AlgodDecimalsSource = "asa" | "arc200_application";

function tealKeyUtf8(kv: { key: string | Uint8Array }): string {
  const raw = typeof kv.key === "string" ? Buffer.from(kv.key, "base64") : Buffer.from(kv.key);
  return raw.toString("utf8");
}

/**
 * Decimals for an Algorand ASA (`/v2/assets/{id}`) or, when that fails, an ARC-200-style
 * application with a global uint key `decimals` (same pattern as DorkFi nToken apps).
 */
export async function loadAlgorandAssetOrAppDecimals(
  algod: algosdk.Algodv2,
  index: number,
): Promise<{ decimals: number; source: AlgodDecimalsSource } | undefined> {
  try {
    const asset = await algod.getAssetByID(index).do();
    return { decimals: Number(asset.params.decimals ?? 0), source: "asa" };
  } catch {
    /* not an ASA on this network */
  }
  try {
    const app = await algod.getApplicationByID(index).do();
    const gs = app.params.globalState ?? [];
    for (const ent of gs) {
      if (tealKeyUtf8(ent) !== "decimals") continue;
      if (ent.value.type === 2) {
        return { decimals: Number(ent.value.uint), source: "arc200_application" };
      }
    }
  } catch {
    /* not an application or missing decimals key */
  }
  return undefined;
}
