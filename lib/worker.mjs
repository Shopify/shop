import fs from "node:fs";
import { writePrivateFile } from "./private-file.mjs";
import { writeSkillFile } from "./skill-file.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { WASI } from "node:wasi";

const FRAME_CAP = 16 * 1024 * 1024;
const STORE_CAP = 64 * 1024;
const WASM_CAP = 32 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
// Same bound as transport.mjs requestOptions: Rust chooses the durations, hosts only enforce them.
const TIMER_CAP = 2_147_483_647;
const validTimer = value => Number.isSafeInteger(value) && value >= 1 && value <= TIMER_CAP;
let memory;
let staged = null;

if (workerData.testExitBeforeStart) process.exit(91);

function view(ptr, len, cap) {
  const start = ptr >>> 0;
  const size = len >>> 0;
  if (size > cap || !memory || start + size > memory.buffer.byteLength) throw new Error("invalid guest memory");
  return new Uint8Array(memory.buffer, start, size);
}

function wait(type, fields, capacity, deadline) {
  const sab = new SharedArrayBuffer(16 + capacity);
  const state = new Int32Array(sab, 0, 4);
  parentPort.postMessage({ type, ...fields, sab });
  return Atomics.wait(state, 0, 0, deadline) === "timed-out" ? null : Atomics.load(state, 1);
}

function stage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > FRAME_CAP) return -3;
  staged = bytes;
  return bytes.length;
}

function guarded(callback) {
  try { return callback(); } catch { staged = null; return -4; }
}

const shopHost = {
  http_send(ptr, len) {
    staged = null;
    return guarded(() => {
      const frame = view(ptr, len, FRAME_CAP).slice();
      const req = JSON.parse(dec.decode(frame));
      if (req === null || typeof req !== "object" || Array.isArray(req) ||
          !validTimer(req.open_ms) || !validTimer(req.silence_ms)) return -3;
      const sab = new SharedArrayBuffer(16 + FRAME_CAP);
      const state = new Int32Array(sab, 0, 4);
      parentPort.postMessage({ type: "http", req, sab });
      // Unbounded in production: the parent always replies (its exchange timers or abortAll
      // settle every request), and this worker dies with the process. Tests bound it.
      if (Atomics.wait(state, 0, 0, workerData.testDeadlineMs ?? Infinity) === "timed-out") {
        return stage(enc.encode(JSON.stringify({ error: { kind: "send", message: "host bridge timed out" } })));
      }
      const code = Atomics.load(state, 1);
      if (code < 0) return code;
      if (code > FRAME_CAP) return -3;
      return stage(new Uint8Array(sab, 16, code).slice());
    });
  },
  store_load() {
    staged = null;
    return guarded(() => {
      const sab = new SharedArrayBuffer(16 + STORE_CAP);
      const state = new Int32Array(sab, 0, 4);
      parentPort.postMessage({ type: "store-load", sab });
      if (Atomics.wait(state, 0, 0, workerData.testDeadlineMs ?? 60_000) === "timed-out") return -4;
      const code = Atomics.load(state, 1);
      if (code < 0) return code;
      if (code > STORE_CAP) return -3;
      staged = new Uint8Array(sab, 16, code).slice();
      return code;
    });
  },
  store_save(ptr, len) {
    return guarded(() => {
      const bytes = view(ptr, len, STORE_CAP).slice();
      const code = wait("store-save", { bytes }, 0, workerData.testDeadlineMs ?? 60_000);
      return code === null ? -4 : code;
    });
  },
  store_delete() {
    return guarded(() => {
      const code = wait("store-delete", {}, 0, workerData.testDeadlineMs ?? 60_000);
      return code === null ? -4 : code;
    });
  },
  file_write(ptr, len) {
    staged = null;
    return guarded(() => {
      const request = JSON.parse(dec.decode(view(ptr, len, FRAME_CAP)));
      return stage(enc.encode(writePrivateFile(request)));
    });
  },
  skill_write(ptr, len) {
    staged = null;
    return guarded(() => {
      const request = JSON.parse(dec.decode(view(ptr, len, FRAME_CAP)));
      return stage(enc.encode(writeSkillFile(request)));
    });
  },
  read_result(ptr, cap) {
    return guarded(() => {
      if (staged === null) return -1;
      const bytes = staged;
      staged = null;
      if ((cap >>> 0) < bytes.length) return -3;
      view(ptr, bytes.length, FRAME_CAP).set(bytes);
      return bytes.length;
    });
  },
};

function readModule(path) {
  const fd = fs.openSync(path, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > WASM_CAP) throw new Error("invalid module");
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("truncated module");
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) throw new Error("growing module");
    return bytes;
  } finally { fs.closeSync(fd); }
}

let result = { type: "done", exitCode: 255, failed: true };
try {
  const wasi = new WASI({
    version: "preview1", args: workerData.argv, env: workerData.env,
    preopens: workerData.preopens, stdin: workerData.stdin,
    stdout: workerData.stdout, stderr: workerData.stderr, returnOnExit: true,
  });
  const module = await WebAssembly.compile(readModule(workerData.wasmPath));
  const instance = await WebAssembly.instantiate(module, { ...wasi.getImportObject(), shop_host: shopHost });
  memory = instance.exports.memory;
  const code = wasi.start(instance);
  result = { type: "done", exitCode: Number.isInteger(code) ? code : 0, failed: false };
} catch {}
parentPort.postMessage(result);
