#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runShop } from "../lib/runner.mjs";

async function main() {
  const hostEnv = { ...process.env };
  const guestEnv = { ...hostEnv };
  const argv = process.argv.slice(2);
  const { createStore } = await import("../lib/store.mjs");
  // Layout notes (a 0755 or setgid directory, a linked ~/.config, an unexpected owner) are the
  // store's static strings; they surface only under the CLI's own --verbose, which the host
  // can see in argv. Refusals are printed by the runner regardless.
  const diagnostic = argv.includes("--verbose")
    ? text => { try { fs.writeSync(2, `shop: credential store: ${text}\n`); } catch {} }
    : undefined;
  const store = createStore({ env: hostEnv, platform: process.platform, diagnostic });
  if (hostEnv.SHOP_AUTH_STORE === "file") delete guestEnv.SHOP_AUTH_STORE;

  const cwd = process.cwd();
  return runShop(argv, {
    wasmPath: fileURLToPath(new URL("../lib/shop.wasm", import.meta.url)),
    env: guestEnv,
    preopens: { ".": cwd, [cwd]: cwd },
    stdin: 0,
    stdout: 1,
    stderr: 2,
    store,
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`shop: ${error instanceof Error ? error.message : "startup failed"}\n`);
  process.exitCode = 1;
}
