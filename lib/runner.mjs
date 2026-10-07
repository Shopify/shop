import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { createHttpExchange } from "./transport.mjs";

const FRAME_CAP = 16 * 1024 * 1024;
const STORE_CAP = 64 * 1024;
const enc = new TextEncoder();

function diagnostic(fd) {
  try { fs.writeSync(fd, "shop: WASI runtime failed\n"); } catch {}
}

// A store refusal is rare, static and secret-free by the store's own contract (fixed strings,
// never a path, mode or OS text), so its reason is printed beside the CLI's generic envelope
// instead of collapsing into the bare -4 the guest sees.
function storeDiagnostic(fd, error) {
  const reason = error instanceof Error && typeof error.message === "string" && error.message !== ""
    ? error.message : "credential file operation failed";
  try { fs.writeSync(fd, `shop: credential store: ${reason}\n`); } catch {}
}

function validStrings(values) {
  return Array.isArray(values) && values.every(value => typeof value === "string");
}

function validMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => key.length > 0 && typeof item === "string");
}

function reply(sab, code, bytes) {
  const state = new Int32Array(sab, 0, 4);
  if (Atomics.load(state, 0) !== 0) return;
  if (bytes) new Uint8Array(sab, 16, bytes.length).set(bytes);
  Atomics.store(state, 1, code);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}

function httpBytes(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.error !== undefined) {
    const error = value.error;
    if (error === null || typeof error !== "object" || Array.isArray(error) ||
        !["send", "tls", "decode"].includes(error.kind) || typeof error.message !== "string" ||
        enc.encode(error.message).length > 4096) return null;
  } else {
    if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599 ||
        !Array.isArray(value.headers) || typeof value.body !== "string" ||
        enc.encode(value.body).length > FRAME_CAP) return null;
    let size = 0;
    for (const pair of value.headers) {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== "string")) return null;
      size += enc.encode(pair[0]).length + enc.encode(pair[1]).length;
      if (size > 1024 * 1024) return null;
    }
  }
  let bytes;
  try { bytes = enc.encode(JSON.stringify(value)); } catch { return null; }
  return bytes.length <= FRAME_CAP ? bytes : null;
}

/** Run the real WASI CLI. testDeadlineMs/testWorkerExit are API-only seam probes. */
export async function runShop(argv, {
  wasmPath, env, preopens, stdin = 0, stdout = 1, stderr = 2, store, exchange,
  testDeadlineMs, testWorkerExit = false,
} = {}) {
  if (!validStrings(argv) || typeof wasmPath !== "string" || !validMap(env) || !validMap(preopens) ||
      ![stdin, stdout, stderr].every(fd => Number.isInteger(fd) && fd >= 0) ||
      !store || !["load", "save", "delete"].every(name => typeof store[name] === "function") ||
      (testDeadlineMs !== undefined && (!Number.isInteger(testDeadlineMs) || testDeadlineMs < 1 || testDeadlineMs > 60_000)) ||
      (exchange !== undefined && typeof exchange !== "function")) {
    diagnostic(stderr);
    return 255;
  }

  const ownedExchange = exchange === undefined ? createHttpExchange(env) : null;
  const send = exchange ?? ownedExchange;
  // The WASI guest cannot inspect its Node host. These host-owned values replace caller input
  // before the worker receives the environment and are admitted again by Rust's closed maps.
  const guestEnv = {
    ...env,
    SHOP_HOST_NODE: process.versions.node,
    SHOP_HOST_PLATFORM: process.platform,
    SHOP_HOST_ARCH: process.arch,
  };
  const pending = new Set();
  let settled = false;
  let worker;

  const finishPending = () => {
    const bytes = enc.encode(JSON.stringify({ error: { kind: "send", message: "worker stopped" } }));
    for (const item of pending) {
      clearTimeout(item.timer);
      reply(item.sab, bytes.length, bytes);
    }
    pending.clear();
    ownedExchange?.abortAll();
  };

  try {
    worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      // Keep this category quiet only in the owned worker. A worker-local option keeps
      // Node's normal flag inheritance; copying execArgv revalidates process-only flags
      // (including test-runner defaults) that are invalid as explicit worker arguments.
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim(),
      },
      workerData: {
        wasmPath, argv: ["shop", ...argv], env: guestEnv, preopens, stdin, stdout, stderr,
        testDeadlineMs, testExitBeforeStart: testWorkerExit,
      },
    });
  } catch {
    finishPending();
    diagnostic(stderr);
    return 255;
  }

  return await new Promise(resolve => {
    const complete = (code, failed = false) => {
      if (settled) return;
      settled = true;
      finishPending();
      if (failed) diagnostic(stderr);
      resolve(Number.isInteger(code) && code >= 0 && code <= 255 ? code : 255);
    };

    worker.on("message", message => {
      if (settled || message === null || typeof message !== "object" || !(message.sab instanceof SharedArrayBuffer)) return;
      const { sab } = message;
      if (message.type === "store-load") {
        try {
          const bytes = store.load();
          if (bytes === null) reply(sab, -1);
          else if (!(bytes instanceof Uint8Array) || bytes.length > STORE_CAP) reply(sab, -3);
          else reply(sab, bytes.length, bytes);
        } catch (error) { storeDiagnostic(stderr, error); reply(sab, -4); }
        return;
      }
      if (message.type === "store-save") {
        try {
          if (!(message.bytes instanceof Uint8Array) || message.bytes.length > STORE_CAP) reply(sab, -3);
          // A zero-length save is the ABI's sign-in pre-flight, never a record. It goes to the
          // store's prepare() (a store without one has nothing to prepare), so a store that keeps
          // bytes verbatim can never have a stored sign-in replaced by nothing.
          else if (message.bytes.length === 0) {
            if (typeof store.prepare === "function") store.prepare();
            reply(sab, 0);
          } else { store.save(message.bytes); reply(sab, 0); }
        } catch (error) { storeDiagnostic(stderr, error); reply(sab, -4); }
        return;
      }
      if (message.type === "store-delete") {
        try { store.delete(); reply(sab, 0); } catch (error) { storeDiagnostic(stderr, error); reply(sab, -4); }
        return;
      }
      if (message.type !== "http") { reply(sab, -4); return; }

      const item = { sab, timer: undefined };
      pending.add(item);
      // Production has no bridge deadline: the exchange's own open/silence timers, or abortAll
      // when the worker settles, end every request. Only the test seam bounds the bridge.
      if (testDeadlineMs !== undefined) {
        item.timer = setTimeout(() => {
          if (!pending.delete(item)) return;
          const bytes = enc.encode(JSON.stringify({ error: { kind: "send", message: "host bridge timed out" } }));
          reply(sab, bytes.length, bytes);
        }, testDeadlineMs);
      }
      Promise.resolve().then(() => send(message.req)).then(value => {
        if (!pending.delete(item)) return;
        clearTimeout(item.timer);
        const bytes = httpBytes(value);
        bytes ? reply(sab, bytes.length, bytes) : reply(sab, -3);
      }, () => {
        if (!pending.delete(item)) return;
        clearTimeout(item.timer);
        const bytes = enc.encode(JSON.stringify({ error: { kind: "send", message: "host exception" } }));
        reply(sab, bytes.length, bytes);
      });
    });
    worker.on("message", message => {
      if (message?.type === "done") complete(message.exitCode, message.failed === true);
    });
    worker.once("error", () => complete(255, true));
    worker.once("exit", code => complete(code === 0 ? 255 : code, true));
  });
}
