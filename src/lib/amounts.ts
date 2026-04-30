/** Fixed-point 1e18 as used by many lending indices. */
export const WAD = 10n ** 18n;

export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal string: ${value}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  if (decimals < 0 || decimals > 36) {
    throw new Error("decimals out of range");
  }
  if (fracPart.length > decimals) {
    throw new Error("Too many fractional digits");
  }
  const fracPadded = fracPart.padEnd(decimals, "0");
  const combined = `${wholePart}${fracPadded}`;
  if (!/^\d+$/.test(combined)) {
    throw new Error("Invalid amount");
  }
  let result = BigInt(combined);
  if (negative) {
    result = -result;
  }
  return result;
}

export function formatUnits(value: bigint, decimals: number): string {
  if (decimals < 0 || decimals > 36) {
    throw new Error("decimals out of range");
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = frac.toString().padStart(decimals, "0");
  while (fracStr.endsWith("0") && fracStr.length > 0) {
    fracStr = fracStr.slice(0, -1);
  }
  const sign = negative ? "-" : "";
  return fracStr.length > 0 ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/**
 * currentDebt = scaledBorrows * borrowIndex / WAD (bigint floor).
 */
export function applyBorrowIndex(scaled: bigint, index: bigint): bigint {
  return (scaled * index) / WAD;
}
