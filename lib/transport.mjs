import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const BODY_CAP = 16 * 1024 * 1024;
const HEADER_CAP = 1024 * 1024;
const CA_FILE_CAP = 16 * 1024 * 1024;
// The Rust client chooses both timer durations; the host only enforces them. Node's setTimeout
// fires immediately above 2^31-1 ms, so a larger value could never mean what the frame says.
const TIMER_CAP = 2_147_483_647;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const BEGIN_CERT = "-----BEGIN CERTIFICATE-----";
const END_CERT = "-----END CERTIFICATE-----";
const ENV_NAMES = [
  "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY",
  "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
];
const REAL_CLOCK = Object.freeze({
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: timer => clearTimeout(timer),
});

// Node's default roots are local to the owning thread and feed the HTTPS-proxy hop. Install one
// immutable profile before any agent exists; a second standalone-CLI profile is a configuration bug.
let installedTlsProfile;

// What the request was waiting on when the timer fired, by phase. Fixed words: the frame must
// never carry Node's own error text, which embeds the proxy URL and therefore its credentials.
const TIMEOUT_ACTIVITY = Object.freeze({
  connect: "connecting",
  tunnel: "awaiting the tunnel",
  tls: "completing the TLS handshake",
  request: "sending the request",
  headers: "awaiting response headers",
  body: "reading the response",
});

// Every frame names the phase in progress and whether this process finished writing the request.
// Pre-dispatch refusals have not started connecting, so the defaults describe them exactly.
function error(kind, message, phase = "connect", sent = false) {
  return { error: { kind, message, phase, sent } };
}

function supportedRuntime() {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 21) || (major === 24 && minor >= 5);
}

function captureEnvironment(source) {
  const values = Object.create(null);
  for (const name of ENV_NAMES) {
    if (!Object.hasOwn(source ?? {}, name)) continue;
    const value = source[name];
    values[name] = typeof value === "string" ? value : null;
  }
  return Object.freeze(values);
}

function strictBytes(value) {
  const bytes = enc.encode(value);
  try {
    return dec.decode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

const validTimer = value => Number.isSafeInteger(value) && value >= 1 && value <= TIMER_CAP;

function requestOptions(req) {
  if (req === null || typeof req !== "object" || Array.isArray(req)) return null;
  const { method, url: rawUrl, headers, body, open_ms: open, silence_ms: silence } = req;
  if (typeof method !== "string" || typeof rawUrl !== "string" || typeof body !== "string" ||
      !validTimer(open) || !validTimer(silence) || !Array.isArray(headers)) return null;
  const bodyBytes = strictBytes(body);
  if (bodyBytes === null || bodyBytes.length > BODY_CAP) return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return null;
  let headerBytes = 0;
  const outgoing = Object.create(null);
  const names = new Map();
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== "string")) return null;
    const name = strictBytes(pair[0]);
    const value = strictBytes(pair[1]);
    const lower = pair[0].toLowerCase();
    if (name === null || value === null || lower === "proxy-authorization") return null;
    headerBytes += name.length + value.length;
    if (headerBytes > HEADER_CAP) return null;
    const canonical = names.get(lower) ?? pair[0];
    names.set(lower, canonical);
    const prior = outgoing[canonical];
    outgoing[canonical] = prior === undefined ? pair[1] : Array.isArray(prior) ? [...prior, pair[1]] : [prior, pair[1]];
  }
  return { method, url, headers: outgoing, body: bodyBytes, open, silence };
}

function responseHeaders(raw) {
  let size = 0;
  const pairs = [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index], value = raw[index + 1];
    if (typeof name !== "string" || typeof value !== "string") return null;
    const nameBytes = strictBytes(name);
    const valueBytes = strictBytes(value);
    if (nameBytes === null || valueBytes === null) return null;
    size += nameBytes.length + valueBytes.length;
    if (size > HEADER_CAP) return null;
    pairs.push([name, value]);
  }
  return pairs;
}

function selected(values, lower, upper) {
  if (Object.hasOwn(values, lower)) return values[lower];
  if (Object.hasOwn(values, upper)) return values[upper];
  return undefined;
}

// The normalized proxy for one protocol: its own pair if present, otherwise ALL_PROXY. A malformed
// protocol-specific value fails, as it does in undici (it throws). ALL_PROXY is curl's convention
// and undici never reads it, so one this host cannot use, such as SOCKS, counts as unset (D115).
function proxyFor(values, lower, upper) {
  const protocol = selected(values, lower, upper);
  if (protocol !== undefined) return normalizedProxy(protocol);
  return normalizedProxy(selected(values, "all_proxy", "ALL_PROXY")) ?? undefined;
}

function normalizedProxy(value) {
  if (value === undefined || value === "") return value;
  if (typeof value !== "string") return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.hostname === "" ||
      !["", "/"].includes(url.pathname) || url.search !== "" || url.hash !== "") return null;
  return url.href;
}

function proxyEnvironment(values) {
  const httpProxy = proxyFor(values, "http_proxy", "HTTP_PROXY");
  const httpsProxy = proxyFor(values, "https_proxy", "HTTPS_PROXY");
  const noProxy = selected(values, "no_proxy", "NO_PROXY");
  if (httpProxy === null || httpsProxy === null ||
      (noProxy !== undefined && typeof noProxy !== "string")) return null;
  const result = Object.create(null);
  if (httpProxy) result.HTTP_PROXY = httpProxy;
  if (httpsProxy) result.HTTPS_PROXY = httpsProxy;
  if (noProxy) result.NO_PROXY = noProxy;
  return Object.freeze(result);
}

function readBounded(path) {
  let descriptor;
  try {
    const nonblocking = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | nonblocking);
    if (!fs.fstatSync(descriptor).isFile()) return null;
    const chunks = [];
    let total = 0;
    while (total <= CA_FILE_CAP) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, CA_FILE_CAP + 1 - total));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) return Buffer.concat(chunks, total);
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
  return null;
}

function certificates(path) {
  const bytes = readBounded(path);
  if (bytes === null || bytes.length === 0) return null;
  let text;
  try { text = dec.decode(bytes); } catch { return null; }
  let cursor = 0;
  const roots = [];
  while (cursor < text.length) {
    const begin = text.indexOf(BEGIN_CERT, cursor);
    const strayEnd = text.indexOf(END_CERT, cursor);
    if (begin < 0) return strayEnd < 0 && roots.length > 0 ? roots : null;
    if (strayEnd >= 0 && strayEnd < begin) return null;
    const end = text.indexOf(END_CERT, begin + BEGIN_CERT.length);
    const nested = text.indexOf(BEGIN_CERT, begin + BEGIN_CERT.length);
    if (end < 0 || (nested >= 0 && nested < end)) return null;
    const boundary = end + END_CERT.length;
    const pem = text.slice(begin, boundary);
    try { new X509Certificate(pem); } catch { return null; }
    roots.push(`${pem}\n`);
    cursor = boundary;
  }
  return roots.length === 0 ? null : roots;
}

function tlsSelection(values) {
  const replacement = Object.hasOwn(values, "SSL_CERT_FILE") ? values.SSL_CERT_FILE : undefined;
  const extra = replacement === undefined && Object.hasOwn(values, "NODE_EXTRA_CA_CERTS")
    ? values.NODE_EXTRA_CA_CERTS : undefined;
  if ((replacement !== undefined && typeof replacement !== "string") ||
      (extra !== undefined && typeof extra !== "string")) return null;
  return Object.freeze({ replacement, extra });
}

function sameTlsSelection(left, right) {
  return left.replacement === right.replacement && left.extra === right.extra;
}

function installTlsProfile(values) {
  const selection = tlsSelection(values);
  if (selection === null ||
      (Object.hasOwn(values, "NODE_TLS_REJECT_UNAUTHORIZED") &&
        (typeof values.NODE_TLS_REJECT_UNAUTHORIZED !== "string" || values.NODE_TLS_REJECT_UNAUTHORIZED === "0"))) {
    return error("tls", "TLS configuration failed");
  }
  if (installedTlsProfile !== undefined) {
    if (!sameTlsSelection(installedTlsProfile.selection, selection)) {
      return error("tls", "TLS profile already initialized");
    }
    return installedTlsProfile.failure;
  }

  const record = { selection, failure: undefined };
  installedTlsProfile = record;
  let roots;
  if (selection.replacement !== undefined) {
    roots = certificates(selection.replacement);
  } else {
    // Node's bundled roots plus the OS store, which is what `node --use-system-ca` trusts (D117). On
    // macOS and Windows the OS store Node reads holds only locally trusted certificates, such as a
    // corporate or proxy CA, never the platform's root program, so alone it fails public chains.
    // An unreadable OS store leaves the bundled roots, which is undici's own default. Duplicates
    // are harmless: Node's store keeps one copy of each certificate.
    let system;
    try { system = tls.getCACertificates("system"); } catch { system = []; }
    try { roots = [...tls.getCACertificates("bundled"), ...system]; } catch { roots = null; }
    if (roots !== null && selection.extra !== undefined) {
      const extra = certificates(selection.extra);
      roots = extra === null ? null : [...roots, ...extra];
    }
  }
  if (roots === null || roots.length === 0) {
    record.failure = error("tls", "TLS configuration failed");
    return record.failure;
  }
  try {
    tls.setDefaultCACertificates(roots);
  } catch {
    record.failure = error("tls", "TLS configuration failed");
    return record.failure;
  }
  return undefined;
}

function tlsFailure(failure) {
  const code = typeof failure?.code === "string" ? failure.code : "";
  return code.startsWith("ERR_TLS") || code.startsWith("CERT_") ||
    code.includes("CERT") || code.includes("TLS") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN";
}

function liveTlsDisabled() {
  return process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
}

function tlsConfigurationFailure() {
  return Object.assign(new Error("TLS configuration failed"), { code: "ERR_TLS_CONFIGURATION" });
}

function ownAgent(agent, opened) {
  const sockets = new Set();
  const createConnection = agent.createConnection;
  const retain = socket => {
    if (socket === null || typeof socket !== "object" || typeof socket.destroy !== "function" ||
        typeof socket.once !== "function" || sockets.has(socket) || socket.destroyed) return;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  agent.createConnection = function (options, callback) {
    if (liveTlsDisabled()) {
      const failure = tlsConfigurationFailure();
      if (typeof callback === "function") process.nextTick(() => callback(failure));
      else throw failure;
      return undefined;
    }
    const delivered = typeof callback === "function" ? function (...args) {
      retain(args[1]);
      if (liveTlsDisabled()) {
        if (args[1] !== undefined) args[1].destroy();
        args[0] = tlsConfigurationFailure();
        args[1] = undefined;
      }
      return callback.apply(this, args);
    } : callback;
    const socket = createConnection.call(this, options, delivered);
    retain(socket);
    // The returned socket is the first hop: the origin when direct, otherwise the proxy. Node's
    // tunnel path hands the request a different, tunneled socket later, so this is the only
    // moment the phase tracker can observe the first hop's own connection events.
    if (sockets.has(socket)) opened(socket);
    return socket;
  };
  return {
    agent,
    destroy() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      agent.destroy();
    },
  };
}

// The optional clock controls only our deadlines, never Node's socket/TLS timers. Test handles
// provide active refresh semantics; normal callers retain native timers without a policy fork.
export function createHttpExchange(env = process.env, clock = REAL_CLOCK) {
  const values = captureEnvironment(env);
  const active = new Map();
  const activeAgents = new Set();
  let networkConfig;
  let stopped = false;

  const initialize = () => {
    if (networkConfig !== undefined) return undefined;
    if (!supportedRuntime()) return error("send", "unsupported Node runtime");
    const proxies = proxyEnvironment(values);
    if (proxies === null) return error("send", "proxy configuration failed");
    const tlsError = installTlsProfile(values);
    if (tlsError !== undefined) return tlsError;
    networkConfig = Object.freeze({ proxies });
    return undefined;
  };

  const send = req => new Promise(resolve => {
    if (stopped) {
      resolve(error("send", "worker stopped"));
      return;
    }
    const options = requestOptions(req);
    if (options === null) {
      resolve(error("send", "invalid host request"));
      return;
    }
    if (liveTlsDisabled()) {
      resolve(error("tls", "TLS configuration failed"));
      return;
    }
    const setupError = initialize();
    if (setupError !== undefined) {
      resolve(setupError);
      return;
    }

    let finished = false;
    let request;
    let agent;
    // Two timers and no total deadline. `open` bounds reaching the first hop (proxy or origin, DNS
    // included); after that hop connects, `silence` ends the request only when no observable
    // progress arrives for its whole duration, and every progress signal restarts it. Node's own
    // `timeout` request option is deliberately not used: Node reuses it as `proxyTunnelTimeout`,
    // clears it once the CONNECT is answered, and so leaves a TLS handshake stalled inside the
    // tunnel without a bound. One watchdog of our own gives the direct and proxied paths the same
    // semantics.
    let openTimer;
    let silenceTimer;
    const timedOut = () => {
      request?.destroy();
      finish(error("send", `timed out while ${TIMEOUT_ACTIVITY[phase]}`, phase, sent));
    };
    const progress = () => {
      if (!finished && silenceTimer !== undefined) silenceTimer.refresh();
    };
    // Phase tracking from public signals only. `firstHop` is the socket createConnection returned;
    // `attached` is the socket the request owns once Node emits `socket`. Direct requests own the
    // first hop before it even connects, while Node's CONNECT tunnel withholds `socket` until the
    // tunneled TLS handshake succeeds, so `attached !== firstHop` at `connect` means a tunnel is
    // being established. Proxied plain HTTP has no tunnel; Node marks it by rewriting the request
    // target to absolute form, which is the only public trace that the first hop is the proxy.
    let phase = "connect";
    let sent = false;
    let firstHop;
    let attached;
    const host = options.url.hostname;
    const viaProxy = () => /^https?:\/\//i.test(request?.path ?? "") ||
      (firstHop !== undefined && attached !== firstHop);
    const opened = socket => {
      if (firstHop !== undefined) return;
      firstHop = socket;
      // Node enables TCP keepalive on a direct origin socket but not on the proxy socket it
      // creates for a tunnel; set it on the first hop so both paths probe a silent peer alike.
      socket.setKeepAlive?.(true, 1_000);
      openTimer = clock.setTimeout(() => {
        openTimer = undefined;
        timedOut();
      }, options.open);
      socket.once("connect", () => {
        if (finished) return;
        clock.clearTimeout(openTimer);
        openTimer = undefined;
        silenceTimer = clock.setTimeout(timedOut, options.silence);
        if (phase !== "connect") return;
        if (attached === socket) {
          phase = socket instanceof tls.TLSSocket ? "tls" : "request";
          return;
        }
        // An HTTPS proxy's own handshake is collapsed into `tunnel`: it is part of reaching the
        // proxy, and naming it `tls` would point the reader at the origin's handshake instead.
        phase = "tunnel";
        // Node reads the CONNECT answer in paused mode, so the first `readable` on the proxy
        // socket is the answer arriving; Node's own listener runs first and, on 200, has already
        // wrapped the socket for the origin handshake. A proxy that trickles a partial status
        // line would advance this early; that is accepted over consuming Node's bytes.
        socket.once("readable", () => {
          progress();
          if (phase === "tunnel") phase = "tls";
        });
      });
      socket.once("secureConnect", () => {
        progress();
        if (phase === "tls" && attached === socket) phase = "request";
      });
    };
    // Which fixed text describes a connection failure depends only on the phase in progress.
    const interrupted = () => {
      if (phase === "connect") return viaProxy() ? "proxy unreachable" : `${host} unreachable`;
      if (phase === "tunnel") return `proxy did not answer the tunnel request for ${host}`;
      if (phase === "tls") return "TLS handshake incomplete";
      if (phase === "request") return "connection lost before the request was fully sent";
      if (phase === "headers") return "no response after the request was sent";
      return "response interrupted";
    };
    const failed = failure => {
      // Our own refusal of NODE_TLS_REJECT_UNAUTHORIZED=0 set mid-flight is a configuration error,
      // not a handshake; the generic classifier below matches any code containing "TLS" and would
      // call it a connection failure, pointing the reader at the network instead of the setting.
      if (failure?.code === "ERR_TLS_CONFIGURATION") return error("tls", "TLS configuration failed", phase, sent);
      if (tlsFailure(failure)) return error("tls", "TLS connection failed", phase, sent);
      // Node's proxy path reports a non-200 CONNECT answer with the parsed status and a proxy
      // that ends or times out mid-CONNECT without one; both are tunnel-phase by definition.
      if (failure?.code === "ERR_PROXY_TUNNEL") {
        // Unreachable while no `timeout` option is passed; mapped so a Node change cannot leak.
        if (failure.proxyTunnelTimeout) return error("send", `timed out while ${TIMEOUT_ACTIVITY.tunnel}`, "tunnel", false);
        const status = failure.statusCode;
        return error("send", Number.isInteger(status) && status >= 100 && status <= 999
          ? `proxy refused the tunnel to ${host} (HTTP ${status})`
          : `proxy did not answer the tunnel request for ${host}`, "tunnel", false);
      }
      return error("send", interrupted(), phase, sent);
    };
    const finish = value => {
      if (finished) return;
      finished = true;
      clock.clearTimeout(openTimer);
      clock.clearTimeout(silenceTimer);
      if (request !== undefined) {
        active.delete(request);
        if (!request.destroyed) request.destroy();
      }
      if (agent !== undefined) {
        activeAgents.delete(agent);
        agent.destroy();
      }
      resolve(value);
    };
    const client = options.url.protocol === "https:" ? https : http;
    try {
      // Node can return a raw proxy socket before CONNECT completes, before Agent.destroy() owns it.
      // Keep every socket exposed by this request-owned agent's public hook until settlement.
      // HTTPS persistence avoids forcing Connection: close; finish still destroys this per-request
      // agent after the response, so this does not introduce cross-request pooling or replay.
      // ALPN offers only http/1.1: Node's HTTP client cannot speak h2, and undici and curl make
      // the same offer, so a server must never be invited to choose a protocol we cannot read.
      agent = ownAgent(options.url.protocol === "https:"
        ? new https.Agent({ keepAlive: true, maxCachedSessions: 0, proxyEnv: networkConfig.proxies,
          rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] })
        : new http.Agent({ keepAlive: false, proxyEnv: networkConfig.proxies }), opened);
      activeAgents.add(agent);
      request = client.request(options.url, {
        method: options.method,
        headers: options.headers,
        agent: agent.agent,
        maxHeaderSize: HEADER_CAP,
        ...(options.url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
      }, response => {
        progress();
        phase = "body";
        if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
          response.destroy();
          finish(error("send", "invalid HTTP response", phase, sent));
          return;
        }
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy();
          finish(error("send", "redirect refused", phase, sent));
          return;
        }
        const headers = responseHeaders(response.rawHeaders);
        if (headers === null) {
          response.destroy();
          finish(error("decode", "response headers exceed host cap", phase, sent));
          return;
        }
        const chunks = [];
        let total = 0;
        let tooLarge = false;
        response.on("data", chunk => {
          progress();
          total += chunk.length;
          if (total > BODY_CAP) {
            tooLarge = true;
            response.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        response.once("end", () => {
          if (tooLarge) {
            finish(error("decode", "response exceeds host cap", phase, sent));
            return;
          }
          const bytes = Buffer.concat(chunks, total);
          try {
            finish({ status: response.statusCode, headers, body: dec.decode(bytes) });
          } catch {
            finish(error("decode", "response is not UTF-8", phase, sent));
          }
        });
        // `on`, not `once`, here and on the request: finish() keeps only the first outcome, and a
        // second 'error' with no listener would crash the process and print Node's own message.
        response.on("error", failure => finish(tooLarge
          ? error("decode", "response exceeds host cap", phase, sent)
          : failed(failure)));
      });
    } catch {
      finish(error("send", "invalid HTTP request"));
      return;
    }
    request.once("socket", socket => {
      attached = socket;
      progress();
      // A socket other than the first hop is Node's tunneled TLS socket: the tunnel and the
      // origin handshake are complete and the request is about to be written.
      if (firstHop !== undefined && socket !== firstHop) phase = "request";
    });
    // `finish` means this process handed the whole request to the socket, not that the peer
    // received or read it; a server may also answer before the body is fully written.
    request.once("finish", () => {
      progress();
      sent = true;
      if (phase !== "body") phase = "headers";
    });
    // Persistent: Node 22.21 emits ERR_PROXY_TUNNEL on the request twice, and an unhandled second
    // 'error' crashes the CLI while printing the proxy URL with its credentials.
    request.on("error", failure => finish(failed(failure)));
    active.set(request, () => {
      request.destroy();
      finish(error("send", "worker stopped", phase, sent));
    });
    request.end(options.body);
  });

  send.abortAll = () => {
    if (stopped) return;
    stopped = true;
    for (const cancel of [...active.values()]) cancel();
    active.clear();
    for (const agent of activeAgents) agent.destroy();
    activeAgents.clear();
  };
  return send;
}
