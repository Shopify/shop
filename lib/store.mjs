import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { posix as posixPath, win32 as win32Path } from 'node:path';

const MAX_BYTES = 65_536;
const FAILED = 'credential file operation failed';
const UNSAFE = 'credential file is not a private regular file';
const UNPREPARED = 'credential directory cannot be created or written';
const TOO_LARGE = 'credential record exceeds 64 KiB';
const WINDOWS_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const WINDOWS_RETRY_ATTEMPTS = 5;
const WINDOWS_RETRY_DELAY_MS = 10;
// Layouts we accept but a `--verbose` caller may want to hear about. Static text only:
// no path, uid or mode is ever interpolated, so the strings are safe on any surface.
export const NOTES = Object.freeze({
  directoryMode: 'credential directory is not private (mode other than 0700)',
  directoryOwner: 'credential directory is not owned by this user',
  fileMode: 'credential file mode is not 0600',
  fileOwner: 'credential file is not owned by this user',
  fileLinks: 'credential file has more than one hard link',
  symlink: 'credential path crosses a symlink',
});
class StoreError extends Error {}
const fail = (message) => { throw new StoreError(message); };

// Every operation is synchronous and never re-enters, so one module-level collector is
// enough; it is set for exactly the duration of one guarded operation.
let notes = null;
const note = (text) => { notes?.add(text); };

function guarded(operation, diagnostic) {
  notes = new Set();
  try {
    return operation();
  } catch (error) {
    // Never retain OS errors: their message, path and cause can contain private values.
    throw new Error(error instanceof StoreError ? error.message : FAILED);
  } finally {
    const collected = notes;
    notes = null;
    // A reporting failure must never turn a completed save into an error.
    for (const text of collected) { try { diagnostic(text); } catch {} }
  }
}

function normalizedPosix(value) {
  return typeof value === 'string' && !value.includes('\0') &&
    posixPath.isAbsolute(value) && posixPath.normalize(value) === value &&
    (value === '/' || !value.endsWith('/'));
}

// path.win32.isAbsolute also accepts root-relative `\name`, whose drive depends on
// process state. Require a fully qualified drive or UNC root and reject device namespaces;
// Node's ordinary file APIs are the only Windows storage boundary used here.
function normalizedWindows(value) {
  if (typeof value !== 'string' || value.includes('\0') ||
      !win32Path.isAbsolute(value) || win32Path.normalize(value) !== value || value.includes('/')) {
    return false;
  }
  const root = win32Path.parse(value).root;
  const drive = /^[A-Za-z]:\\$/.test(root);
  const unc = /^\\\\[^\\]+\\[^\\]+\\$/.test(root) && !/^\\\\[?.]\\/.test(root);
  return (drive || unc) && (value === root || !value.endsWith('\\'));
}

export function isNormalizedWindowsFilePath(value) {
  return normalizedWindows(value) && win32Path.dirname(value) !== value;
}

// bin/shop.mjs snapshots process.env before constructing the store. Windows environment
// names are case-insensitive, but the resulting JavaScript object is not reliably so
// (notably across workers). Fold only the three store names and refuse ambiguous snapshots.
// POSIX never calls this helper and retains exact-name, lazy property reads.
function windowsStoreEnvironment(env) {
  const names = new Map([
    ['shop_auth_store', 'SHOP_AUTH_STORE'],
    ['shop_auth_file', 'SHOP_AUTH_FILE'],
    ['localappdata', 'LOCALAPPDATA'],
  ]);
  const found = new Set();
  const values = {};
  for (const [key, value] of Object.entries(env)) {
    const name = names.get(key.toLowerCase());
    if (name === undefined) continue;
    if (found.has(name)) fail('duplicate credential environment variable');
    found.add(name);
    values[name] = value;
  }
  return values;
}

function resolveFile(env, platform) {
  if (platform === 'win32' || process.platform === 'win32') {
    // Platform injection is a test seam, not an emulator: never interpret Windows paths
    // or touch a host filesystem unless this is a native Windows process.
    if (platform !== 'win32' || process.platform !== 'win32') {
      fail('requested credential store is unavailable');
    }
    const values = windowsStoreEnvironment(env);
    if (values.SHOP_AUTH_STORE !== undefined && values.SHOP_AUTH_STORE !== 'file') {
      fail('unsupported SHOP_AUTH_STORE value');
    }
    if (values.SHOP_AUTH_FILE !== undefined) {
      if (!isNormalizedWindowsFilePath(values.SHOP_AUTH_FILE)) {
        fail('SHOP_AUTH_FILE must be an absolute normalized file path');
      }
      return { backend: 'windows', file: values.SHOP_AUTH_FILE };
    }
    if (!normalizedWindows(values.LOCALAPPDATA)) {
      fail('LOCALAPPDATA must be an absolute normalized path');
    }
    return { backend: 'windows', file: win32Path.join(values.LOCALAPPDATA, 'shop-node-wasm', 'credentials.json') };
  }
  if (env.SHOP_AUTH_STORE !== undefined && env.SHOP_AUTH_STORE !== 'file') {
    fail('unsupported SHOP_AUTH_STORE value');
  }
  if (!['darwin', 'linux'].includes(platform) ||
      !['darwin', 'linux'].includes(process.platform) ||
      typeof process.geteuid !== 'function' ||
      !['O_NOFOLLOW', 'O_NONBLOCK', 'O_DIRECTORY'].every((key) => Number.isInteger(fs.constants[key]))) {
    fail('requested credential store is unavailable');
  }
  if (env.SHOP_AUTH_FILE !== undefined) {
    if (!normalizedPosix(env.SHOP_AUTH_FILE) || env.SHOP_AUTH_FILE === '/') {
      fail('SHOP_AUTH_FILE must be an absolute normalized file path');
    }
    return { backend: 'posix', file: env.SHOP_AUTH_FILE };
  }
  // Match native POSIX precedence: an unusable XDG base falls back to HOME.
  if (normalizedPosix(env.XDG_CONFIG_HOME)) {
    return { backend: 'posix', file: posixPath.join(env.XDG_CONFIG_HOME, 'shop-node-wasm/credentials.json') };
  }
  if (!normalizedPosix(env.HOME)) fail('HOME must be an absolute normalized path');
  return { backend: 'posix', file: posixPath.join(env.HOME, '.config/shop-node-wasm/credentials.json') };
}

function statIfPresent(file) {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(a, b) {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/**
 * The file decision, pure so the owner branch can be tested without a second uid. Only
 * type and group/other readability refuse: a non-regular file is never a credential and
 * a readable one is already exposed. Setuid/setgid/sticky bits are masked out (the native
 * store also masks with 0o777), and owner/link-count surprises are reported, not fatal.
 */
export function assessFile(stat, uid) {
  if (!stat.isFile() || (stat.mode & 0o077n) !== 0n) return { refusal: UNSAFE, notes: [] };
  const found = [];
  if ((stat.mode & 0o777n) !== 0o600n) found.push(NOTES.fileMode);
  if (stat.uid !== BigInt(uid)) found.push(NOTES.fileOwner);
  if (stat.nlink !== 1n) found.push(NOTES.fileLinks);
  return { refusal: null, notes: found };
}

/** The terminal-directory decision: we create it 0700 but never refuse to use it. */
export function assessDirectory(stat, uid) {
  const found = [];
  if ((stat.mode & 0o777n) !== 0o700n) found.push(NOTES.directoryMode);
  if (stat.uid !== BigInt(uid)) found.push(NOTES.directoryOwner);
  return found;
}

function checkFile(stat) {
  const { refusal, notes: found } = assessFile(stat, process.geteuid());
  if (refusal !== null) fail(refusal);
  found.forEach(note);
}

function fileStat(file) {
  const stat = statIfPresent(file);
  if (stat !== null) checkFile(stat);
  return stat;
}

function checkSize(stat) {
  if (stat.size > BigInt(MAX_BYTES)) fail(TOO_LARGE);
}

// A symlinked component (a linked ~/.config is common) is followed and reported. A link
// that resolves to nothing is an OS error, not absence: nothing could be created there.
function directoryStat(directory) {
  const link = statIfPresent(directory);
  if (link === null) return null;
  if (link.isSymbolicLink()) note(NOTES.symlink);
  const stat = link.isSymbolicLink() ? fs.statSync(directory, { bigint: true }) : link;
  if (!stat.isDirectory()) fail(FAILED);
  return stat;
}

// Walk from the root so a missing child cannot hide a non-directory ancestor. Broader
// ancestors (/, /home, /private/tmp) are expected to be public; only the terminal
// directory's mode and owner are worth reporting.
function parentsOf(file, create) {
  const parent = posixPath.dirname(file);
  const directories = ['/'];
  for (const segment of parent.split('/').filter(Boolean)) {
    directories.push(posixPath.join(directories.at(-1), segment));
  }
  const parents = [];
  for (const directory of directories) {
    let stat = directoryStat(directory);
    if (stat === null) {
      if (!create) return null;
      fs.mkdirSync(directory, { mode: 0o700 });
      stat = directoryStat(directory);
      if (stat === null) fail(FAILED);
    }
    if (directory === parent) assessDirectory(stat, process.geteuid()).forEach(note);
    parents.push({ directory, stat });
  }
  return parents;
}

// Identity rechecks guard the temp-and-rename sequence against a directory swapped
// underneath it; a swap is an operation failure, not a layout opinion.
function recheckParents(parents) {
  for (const { directory, stat } of parents) {
    if (!sameFile(directoryStat(directory), stat)) fail(FAILED);
  }
}

function recheckFile(file, expected) {
  const actual = fileStat(file);
  if (expected === null ? actual !== null : !sameFile(actual, expected)) fail(UNSAFE);
}

function withFd(file, flags, mode, operation) {
  const fd = mode === undefined ? fs.openSync(file, flags) : fs.openSync(file, flags, mode);
  try {
    return operation(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function withParent(file, create, operation) {
  const parents = parentsOf(file, create);
  if (parents === null) return null;
  const terminal = parents.at(-1);
  return withFd(terminal.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY, undefined, (fd) => {
    if (!sameFile(fs.fstatSync(fd, { bigint: true }), terminal.stat)) fail(FAILED);
    recheckParents(parents);
    return operation(parents, fd);
  });
}

function withRecord(file, expected, operation) {
  // NONBLOCK prevents a raced-in FIFO from blocking before fstat can reject it.
  return withFd(file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    undefined, (fd) => {
      const actual = fs.fstatSync(fd, { bigint: true });
      checkFile(actual);
      if (!sameFile(actual, expected)) fail(UNSAFE);
      return operation(fd, actual);
    });
}

function readRecord(file, expected, parents) {
  checkSize(expected);
  return withRecord(file, expected, (fd, actual) => {
    checkSize(actual);
    // Bound both allocation and reads even if the file grows after either stat.
    const bytes = new Uint8Array(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) fail(TOO_LARGE);
    const final = fs.fstatSync(fd, { bigint: true });
    checkFile(final);
    checkSize(final);
    if (final.size !== BigInt(length)) fail(FAILED);
    recheckParents(parents);
    recheckFile(file, expected);
    return bytes.subarray(0, length);
  });
}

const temporaryBeside = (file, pathImpl = posixPath) =>
  pathImpl.join(pathImpl.dirname(file), `.shop-auth-${randomBytes(16).toString('hex')}.tmp`);
const STAGING_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function saveRecord(file, bytes) {
  withParent(file, true, (parents, parentFd) => {
    const expected = fileStat(file);
    if (expected !== null) readRecord(file, expected, parents);
    const temporary = temporaryBeside(file);
    let staged = null;
    let renamed = false;
    try {
      withFd(temporary, STAGING_FLAGS, 0o600, (fd) => {
        staged = fs.fstatSync(fd, { bigint: true });
        checkFile(staged);
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count === 0) fail(FAILED);
          offset += count;
        }
        fs.fsyncSync(fd);
        const actual = fs.fstatSync(fd, { bigint: true });
        checkFile(actual);
        if (!sameFile(actual, staged) || actual.size !== BigInt(bytes.length)) fail(FAILED);
        recheckParents(parents);
        recheckFile(temporary, staged);
        recheckFile(file, expected);
        fs.renameSync(temporary, file);
        renamed = true;
        recheckParents(parents);
        recheckFile(file, staged);
        fs.fsyncSync(parentFd);
      });
    } finally {
      if (staged !== null && !renamed) {
        // Best-effort cleanup only of our own inode through unchanged parents. Never
        // chase a replaced path; a cleanup failure must not hide the original failure.
        try {
          recheckParents(parents);
          if (sameFile(statIfPresent(temporary), staged)) fs.unlinkSync(temporary);
        } catch {}
      }
    }
  });
}

// Pre-flight for login: the sandbox that lost a freshly issued token would have been
// refused here, before any device-flow traffic, instead of after the exchange succeeded.
// Creating and unlinking a sibling probe exercises exactly the path a later save takes.
function prepareDirectory(file) {
  try {
    withParent(file, true, () => {
      const probe = temporaryBeside(file);
      withFd(probe, STAGING_FLAGS, 0o600, () => {});
      fs.unlinkSync(probe);
    });
  } catch {
    fail(UNPREPARED);
  }
}

// Windows exposes no openat-style path walk or portable reparse-tag query. lstat reports
// symlinks and junctions as symbolic links; those are refused at every record/parent step,
// and dev/inode identity is rechecked around each operation. Other reparse kinds receive
// the strongest regular-file/directory and identity checks Node's platform APIs expose.
function windowsDirectoryStat(directory) {
  const stat = statIfPresent(directory);
  if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) fail(FAILED);
  return stat;
}

function windowsCheckFile(stat) {
  if (stat.isSymbolicLink() || !stat.isFile()) fail(UNSAFE);
}

function windowsFileStat(file) {
  const stat = statIfPresent(file);
  if (stat !== null) windowsCheckFile(stat);
  return stat;
}

function windowsParentsOf(file, create) {
  const parent = win32Path.dirname(file);
  const root = win32Path.parse(parent).root;
  const directories = [root];
  for (const segment of parent.slice(root.length).split('\\').filter(Boolean)) {
    directories.push(win32Path.join(directories.at(-1), segment));
  }
  const parents = [];
  for (const directory of directories) {
    let stat = windowsDirectoryStat(directory);
    if (stat === null) {
      // A missing drive or UNC share is a configuration/I/O failure. Only a descendant
      // beneath a root whose identity was observed can mean an absent credential.
      if (directory === root) fail(FAILED);
      if (!create) return null;
      fs.mkdirSync(directory);
      stat = windowsDirectoryStat(directory);
      if (stat === null) fail(FAILED);
    }
    parents.push({ directory, stat });
  }
  return parents;
}

function windowsRecheckParents(parents) {
  for (const { directory, stat } of parents) {
    if (!sameFile(windowsDirectoryStat(directory), stat)) fail(FAILED);
  }
}

function windowsRecheckFile(file, expected) {
  const actual = windowsFileStat(file);
  if (expected === null ? actual !== null : !sameFile(actual, expected)) fail(UNSAFE);
}

function windowsWithParent(file, create, operation) {
  const parents = windowsParentsOf(file, create);
  if (parents === null) return null;
  windowsRecheckParents(parents);
  return operation(parents);
}

function windowsWithRecord(file, expected, operation) {
  const binary = Number.isInteger(fs.constants.O_BINARY) ? fs.constants.O_BINARY : 0;
  return withFd(file, fs.constants.O_RDONLY | binary, undefined, (fd) => {
    const actual = fs.fstatSync(fd, { bigint: true });
    windowsCheckFile(actual);
    if (!sameFile(actual, expected)) fail(UNSAFE);
    return operation(fd, actual);
  });
}

function windowsReadRecord(file, expected, parents) {
  checkSize(expected);
  return windowsWithRecord(file, expected, (fd, actual) => {
    checkSize(actual);
    const bytes = new Uint8Array(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) fail(TOO_LARGE);
    const final = fs.fstatSync(fd, { bigint: true });
    windowsCheckFile(final);
    checkSize(final);
    if (!sameFile(final, expected) || final.size !== BigInt(length)) fail(FAILED);
    windowsRecheckParents(parents);
    windowsRecheckFile(file, expected);
    return bytes.subarray(0, length);
  });
}

export function isUnsupportedWindowsFsyncError(error) {
  return ['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(error?.code);
}

function windowsFsyncFile(fd) {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows filesystems normally support FlushFileBuffers. Node/libuv has also surfaced
    // EISDIR for this file operation; ignore only these fixed unsupported classes.
    if (!isUnsupportedWindowsFsyncError(error)) throw error;
  }
}

function windowsRetry(operation, recheck) {
  for (let attempt = 0; attempt < WINDOWS_RETRY_ATTEMPTS; attempt++) {
    recheck();
    try {
      operation();
      return;
    } catch (error) {
      if (!WINDOWS_RETRY_CODES.has(error?.code) || attempt + 1 === WINDOWS_RETRY_ATTEMPTS) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WINDOWS_RETRY_DELAY_MS);
    }
  }
}

function windowsRenameReplacement(temporary, staged, file, expected, parents) {
  windowsRetry(
    () => fs.renameSync(temporary, file),
    () => {
      windowsRecheckParents(parents);
      windowsRecheckFile(temporary, staged);
      windowsRecheckFile(file, expected);
    },
  );
}

function windowsUnlink(file, expected, parents) {
  windowsRetry(
    () => fs.unlinkSync(file),
    () => {
      windowsRecheckParents(parents);
      windowsRecheckFile(file, expected);
    },
  );
}

const WINDOWS_STAGING_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
  (Number.isInteger(fs.constants.O_BINARY) ? fs.constants.O_BINARY : 0);

function windowsSaveRecord(file, bytes) {
  windowsWithParent(file, true, (parents) => {
    const expected = windowsFileStat(file);
    if (expected !== null) windowsReadRecord(file, expected, parents);
    const temporary = temporaryBeside(file, win32Path);
    let staged = null;
    let renamed = false;
    try {
      withFd(temporary, WINDOWS_STAGING_FLAGS, undefined, (fd) => {
        staged = fs.fstatSync(fd, { bigint: true });
        windowsCheckFile(staged);
        windowsRecheckParents(parents);
        windowsRecheckFile(temporary, staged);
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count === 0) fail(FAILED);
          offset += count;
        }
        windowsFsyncFile(fd);
        const actual = fs.fstatSync(fd, { bigint: true });
        windowsCheckFile(actual);
        if (!sameFile(actual, staged) || actual.size !== BigInt(bytes.length)) fail(FAILED);
      });
      // Close the staged Windows handle before rename. A bounded retry admits only
      // sharing/transient-busy errors and rechecks every involved identity per attempt.
      windowsRenameReplacement(temporary, staged, file, expected, parents);
      renamed = true;
      windowsRecheckParents(parents);
      windowsRecheckFile(file, staged);
    } finally {
      if (staged !== null && !renamed) {
        try {
          windowsRecheckParents(parents);
          if (sameFile(windowsFileStat(temporary), staged)) windowsUnlink(temporary, staged, parents);
        } catch {}
      }
    }
  });
}

function windowsPrepareDirectory(file) {
  try {
    windowsWithParent(file, true, (parents) => {
      const probe = temporaryBeside(file, win32Path);
      let staged = null;
      let removed = false;
      try {
        withFd(probe, WINDOWS_STAGING_FLAGS, undefined, (fd) => {
          staged = fs.fstatSync(fd, { bigint: true });
          windowsCheckFile(staged);
          windowsRecheckParents(parents);
          windowsRecheckFile(probe, staged);
        });
        windowsUnlink(probe, staged, parents);
        removed = true;
        windowsRecheckParents(parents);
        windowsRecheckFile(probe, null);
      } finally {
        if (staged !== null && !removed) {
          try {
            windowsRecheckParents(parents);
            if (sameFile(windowsFileStat(probe), staged)) windowsUnlink(probe, staged, parents);
          } catch {}
        }
      }
    });
  } catch {
    fail(UNPREPARED);
  }
}

function loadAt(location) {
  if (location.backend === 'windows') {
    return windowsWithParent(location.file, false, (parents) => {
      const expected = windowsFileStat(location.file);
      if (expected !== null) return windowsReadRecord(location.file, expected, parents);
      windowsRecheckParents(parents);
      return null;
    });
  }
  return withParent(location.file, false, (parents) => {
    const expected = fileStat(location.file);
    if (expected !== null) return readRecord(location.file, expected, parents);
    recheckParents(parents);
    return null;
  });
}

function prepareAt(location) {
  return location.backend === 'windows'
    ? windowsPrepareDirectory(location.file)
    : prepareDirectory(location.file);
}

function saveAt(location, bytes) {
  return location.backend === 'windows'
    ? windowsSaveRecord(location.file, bytes)
    : saveRecord(location.file, bytes);
}

function deleteAt(location) {
  if (location.backend === 'windows') {
    return windowsWithParent(location.file, false, (parents) => {
      const expected = windowsFileStat(location.file);
      if (expected === null) {
        windowsRecheckParents(parents);
        return;
      }
      windowsWithRecord(location.file, expected, () => {
        windowsRecheckParents(parents);
        windowsRecheckFile(location.file, expected);
      });
      // As with replacement, close the Windows record handle before bounded unlink.
      windowsUnlink(location.file, expected, parents);
      windowsRecheckParents(parents);
      windowsRecheckFile(location.file, null);
    });
  }
  return withParent(location.file, false, (parents, parentFd) => {
    const expected = fileStat(location.file);
    if (expected === null) {
      recheckParents(parents);
      return;
    }
    withRecord(location.file, expected, () => {
      recheckParents(parents);
      recheckFile(location.file, expected);
      fs.unlinkSync(location.file);
      fs.fsyncSync(parentFd);
      recheckParents(parents);
      recheckFile(location.file, null);
    });
  });
}

/**
 * Isolated plaintext host seam. No filesystem or env inspection at construction; the
 * first operation resolves configuration, then every operation checks the filesystem.
 * Only ENOENT means absence. Record decoding and save/read-back verification stay in Rust.
 * Refusals are reserved for what protects the record (type, POSIX group/other
 * readability, size, selector/platform, OS failures); other POSIX layout surprises reach
 * `diagnostic` as static strings. POSIX and Windows path checks limit accidental races,
 * not hostile same-user races (Node exposes no openat API). POSIX file/directory fsync is
 * attempted; Windows fsyncs the staged file where supported and makes no POSIX mode, uid,
 * custom ACL, or directory-fsync claim. Neither is a power-loss durability guarantee.
 */
export function createStore({ env = process.env, platform = process.platform, diagnostic } = {}) {
  let resolved;
  const location = () => (resolved ??= resolveFile(env, platform));
  const report = typeof diagnostic === 'function' ? diagnostic : () => {};
  return Object.freeze({
    load() {
      return guarded(() => loadAt(location()), report);
    },
    prepare() {
      guarded(() => prepareAt(location()), report);
    },
    save(bytes) {
      guarded(() => {
        const target = location();
        if (!(bytes instanceof Uint8Array)) fail('credential record must be bytes');
        if (bytes.byteLength > MAX_BYTES) fail(TOO_LARGE);
        // Convention: an empty save is the pre-flight, not a record. Rust always encodes a
        // JSON object, so zero bytes is unambiguous and rides the existing `store_save`
        // host import without a new one.
        if (bytes.byteLength === 0) return prepareAt(target);
        saveAt(target, new Uint8Array(bytes));
      }, report);
    },
    delete() {
      guarded(() => deleteAt(location()), report);
    },
  });
}
