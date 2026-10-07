import fs from "node:fs";
import path from "node:path";

/** Explicit file handoff, not the OAuth store. null content checks without creating a file. */
export function writePrivateFile(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "content,path" ||
      typeof request.path !== "string" || !request.path || request.path.includes("\0") ||
      (request.content !== null && typeof request.content !== "string")) {
    throw new Error("invalid private-file request");
  }
  const resolved = path.resolve(request.path);
  try {
    fs.lstatSync(resolved);
    throw new Error("output file already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fs.statSync(path.dirname(resolved)).isDirectory()) throw new Error("missing output directory");
  if (request.content === null) return resolved;
  // O_EXCL refuses all existing entries, including links, at the actual write. Mode 0600
  // applies on POSIX; Windows inherits the caller-selected directory's ACLs, as file storage does.
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(resolved, flags, 0o600);
  try { fs.writeFileSync(fd, request.content, { encoding: "utf8" }); }
  finally { fs.closeSync(fd); }
  return resolved;
}
