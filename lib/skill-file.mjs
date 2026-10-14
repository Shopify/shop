import fs from "node:fs";
import path from "node:path";

/** The host's own refusal, as opposed to a filesystem failure: the worker maps it to its own code. */
export const SYMLINK_REFUSED = "SHOP_SKILL_SYMLINK";

/**
 * Replace one bundled-skill file exactly where the caller named it. The path is
 * the user's own `--dir` and the content is this build's embedded skill, so the only policy here
 * is the one the native installer also applies: a link in the final position would carry the
 * write somewhere the caller did not name, and is refused. Everything else — which directory,
 * whether it is a harness's skills root, what it already holds — is the caller's authority, as it
 * is for the credential export beside it in `private-file.mjs`.
 */
export function writeSkillFile(request, { cwd = process.cwd() } = {}) {
  if (request === null || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "content,path" ||
      typeof request.path !== "string" || !request.path || request.path.includes("\0") ||
      typeof request.content !== "string") {
    throw new Error("invalid skill-file request");
  }
  const resolved = path.resolve(cwd, request.path);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      throw Object.assign(new Error("skill path is a symlink"), { code: SYMLINK_REFUSED });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.writeFileSync(resolved, request.content, "utf8");
  return resolved;
}
