import type { NextFunction, Request, Response } from "express";

function collectAllowedKeys(): Set<string> {
  const keys = new Set<string>();
  const single = process.env.WEBHOOK_API_KEY?.trim();
  if (single) {
    keys.add(single);
  }
  const list = process.env.WEBHOOK_API_KEYS?.trim();
  if (list) {
    for (const part of list.split(",")) {
      const k = part.trim();
      if (k) {
        keys.add(k);
      }
    }
  }
  return keys;
}

function extractProvidedKey(req: Request): string | undefined {
  const fromHeader = req.header("x-api-key")?.trim();
  if (fromHeader) {
    return fromHeader;
  }
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    return token || undefined;
  }
  return undefined;
}

/** When no keys are set in env, POSTs are not gated (existing behavior). */
export function requireWebhookApiKey(req: Request, res: Response, next: NextFunction): void {
  const allowed = collectAllowedKeys();
  if (allowed.size === 0) {
    next();
    return;
  }
  const provided = extractProvidedKey(req);
  if (!provided || !allowed.has(provided)) {
    res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED",
      message: "Invalid or missing API key",
    });
    return;
  }
  next();
}
