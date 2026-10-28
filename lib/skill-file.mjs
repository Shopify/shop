import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The installer's three host primitives, and the two read-only facts `shop doctor` asks of its
 * host. Every path is the caller's own: the user's `--dir`, or a skills directory the CLI's own
 * target table names, resolved against the working directory. Which directory, whether it is a
 * harness's skills root and what else it holds are the caller's authority; the only policy here
 * is the one the native installer applies too: every write replaces what is at the named path,
 * and a symbolic link there is removed rather than written through. The two reads follow links,
 * as the native report does, and write nothing.
 */

/** The directory holding this package's `bin/` and `lib/`, located through this module itself. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** What a runtime copy carries: the package minus its skills, plugin catalogs and README. */
const RUNTIME_ENTRIES = ["package.json", "bin", "lib"];
const OPTIONAL_RUNTIME_ENTRIES = ["LICENSE"];

/** The POSIX launcher: the copied package's own entrypoint, beside the launcher, under node. */
export const LAUNCHER = '#!/bin/sh\nexec node "$(dirname "$0")/.shop/bin/shop.mjs" "$@"\n';

/**
 * The Windows launcher, shaped like npm's cmd-shim. `%~dp0` is this file's directory with a
 * trailing backslash; `%*` forwards every argument. The explicit `EXIT /b %ERRORLEVEL%` makes the
 * script's exit code node's, whether it is run directly, through `cmd /c`, or `CALL`ed from
 * another batch file.
 */
export const WINDOWS_LAUNCHER = '@ECHO off\r\nnode "%~dp0.shop\\bin\\shop.mjs" %*\r\nEXIT /b %ERRORLEVEL%\r\n';

function validPath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

/** Remove a symbolic link at `file`; anything else, or nothing, is left alone. */
function removeLink(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) fs.rmSync(file, { force: true });
}

/** Write `content` beside `file` and rename it into place, replacing a link rather than following it. */
function replaceFile(file, content, mode) {
  const staged = `${file}.tmp`;
  fs.rmSync(staged, { force: true });
  try {
    fs.writeFileSync(staged, content, { flag: "wx", mode });
    if (mode !== undefined) fs.chmodSync(staged, mode);
    removeLink(file);
    fs.renameSync(staged, file);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
}

/** `skill_write`: replace one installer-owned file exactly where the caller named it. */
export function writeSkillFile(request, { cwd = process.cwd() } = {}) {
  if (request === null || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "content,path" ||
      !validPath(request.path) || typeof request.content !== "string") {
    throw new Error("invalid skill-file request");
  }
  const resolved = path.resolve(cwd, request.path);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  replaceFile(resolved, request.content);
  return resolved;
}

/**
 * `path_kind`: 0 absent, 1 regular file, 2 directory, 3 other. A link is followed, as the native
 * probe's `metadata` does. Only absence is absence: a path that cannot be examined (EACCES,
 * ELOOP, …) throws, so a trigger is never silently false because the host could not look.
 */
export function pathKind(target, { cwd = process.cwd() } = {}) {
  if (!validPath(target)) throw new Error("invalid path-kind request");
  let stat;
  try {
    stat = fs.statSync(path.resolve(cwd, target));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return 0;
    throw error;
  }
  if (stat.isFile()) return 1;
  if (stat.isDirectory()) return 2;
  return 3;
}

function realpathOrNull(target) {
  try { return fs.realpathSync(target); } catch { return null; }
}

/**
 * `runtime_copy`: place the package this host was loaded from into `<directory>/.shop/` and write
 * the fixed launcher `<directory>/shop` (and `shop.cmd` on Windows). The copy is staged as
 * `.shop.tmp/`, swapped in through `.shop.old/`, and skipped when this package already is
 * `<directory>/.shop/` (an install run from the copy itself). Returns `{ code, launcher }`:
 * code 0 copied, 1 skipped; launcher is the resolved POSIX launcher path.
 */
export function runtimeCopy(directory, {
  cwd = process.cwd(), packageRoot = PACKAGE_ROOT, platform = process.platform,
} = {}) {
  if (!validPath(directory)) throw new Error("invalid runtime-copy request");
  const scripts = path.resolve(cwd, directory);
  fs.mkdirSync(scripts, { recursive: true });
  const installed = path.join(scripts, ".shop");
  // A link in the copy's place is replaced like any other: it is not "the running copy".
  removeLink(installed);
  const running = realpathOrNull(packageRoot);
  const skipped = running !== null && running === realpathOrNull(installed);
  if (!skipped) {
    const staged = path.join(scripts, ".shop.tmp");
    const retired = path.join(scripts, ".shop.old");
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged);
    try {
      for (const entry of RUNTIME_ENTRIES) {
        fs.cpSync(path.join(packageRoot, entry), path.join(staged, entry), { recursive: true });
      }
      for (const entry of OPTIONAL_RUNTIME_ENTRIES) {
        const source = path.join(packageRoot, entry);
        if (fs.existsSync(source)) fs.cpSync(source, path.join(staged, entry));
      }
      fs.rmSync(retired, { recursive: true, force: true });
      if (fs.existsSync(installed)) fs.renameSync(installed, retired);
      fs.renameSync(staged, installed);
    } catch (error) {
      fs.rmSync(staged, { recursive: true, force: true });
      // Put the previous copy back if the swap stopped halfway.
      if (!fs.existsSync(installed) && fs.existsSync(retired)) fs.renameSync(retired, installed);
      throw error;
    }
    fs.rmSync(retired, { recursive: true, force: true });
  }
  const launcher = path.join(scripts, "shop");
  replaceFile(launcher, LAUNCHER, 0o755);
  if (platform === "win32") replaceFile(path.join(scripts, "shop.cmd"), WINDOWS_LAUNCHER);
  return { code: skipped ? 1 : 0, launcher };
}

/** `host_info`: what this host is and where it runs from, all real paths. */
export function hostInfo({
  packageRoot = PACKAGE_ROOT, platform = process.platform, version = process.version,
} = {}) {
  return {
    runtime: `node ${version}`,
    platform,
    executable: fs.realpathSync(path.join(packageRoot, "bin", "shop.mjs")),
    package_root: fs.realpathSync(packageRoot),
  };
}

/** Thrown by `readTextFile` for a path that is not a regular UTF-8 file within the cap. */
export class NotTextError extends Error {
  constructor() { super("not a text file within the cap"); }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * `read_file`: one UTF-8 text file of at most `max` bytes, the cap the guest chose, links
 * followed. Returns `null` when nothing is at the path, `{ path, content }` with the real path
 * otherwise, and throws `NotTextError` for a directory or other non-file, a file larger than
 * `max` (checked before reading, and again while reading in case it grew), or bytes that are not
 * UTF-8. Any other failure (permission, a link loop) throws as itself, so it is never "absent".
 */
export function readTextFile(request, { cwd = process.cwd() } = {}) {
  if (request === null || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "max,path" ||
      !validPath(request.path) || !Number.isSafeInteger(request.max) || request.max < 0) {
    throw new Error("invalid read-file request");
  }
  let real;
  try {
    real = fs.realpathSync(path.resolve(cwd, request.path));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
  const fd = fs.openSync(real, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > request.max) throw new NotTextError();
    const bytes = Buffer.alloc(request.max + 1);
    let length = 0;
    for (;;) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > request.max) throw new NotTextError();
    }
    let content;
    try { content = utf8.decode(bytes.subarray(0, length)); } catch { throw new NotTextError(); }
    return { path: real, content };
  } finally { fs.closeSync(fd); }
}
