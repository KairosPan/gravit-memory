// src/ids.ts — line ids and the one hash every chain uses
import { createHash, randomBytes } from "node:crypto";
import type { IdPrefix } from "./types.js";

/** `<prefix>-<YYYYMMDD, UTC>-<8 lower hex>`, e.g. r-20260302-0f3a9c21. */
export function newId(prefix: IdPrefix, nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}-${day}-${randomBytes(4).toString("hex")}`;
}

/** SHA-256 in lower hex; a string is hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
