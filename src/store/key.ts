// HMAC key: `~/.omp/agent/omp-roundtable/key`, 32 random bytes as hex, file 0600 in a 0700 directory.
// Created on first use; its migration between hosts belongs to omp-config (crash matrix row 10).

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Brand } from "../core/index.ts";

export type HmacKey = Brand<string, "HmacKey">;

export const DEFAULT_KEY_PATH = join(homedir(), ".omp", "agent", "omp-roundtable", "key");

export function parseKey(text: string): HmacKey {
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("HMAC key must be 64 lowercase hex characters (32 bytes)");
  return hex as HmacKey;
}

/** Load the key at `path`, creating it (exclusively, so two first runs cannot both win) when it does not exist. */
export function loadOrCreateKey(path: string = DEFAULT_KEY_PATH): HmacKey {
  try {
    return parseKey(readFileSync(path, "utf8"));
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  try {
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
  }
  return parseKey(readFileSync(path, "utf8"));
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
}
