import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Replace one bundled-skill file inside a fixed harness root or the working directory. */
export function writeSkillFile(request, { home = os.homedir(), cwd = process.cwd() } = {}) {
  if (request === null || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "content,path" ||
      typeof request.path !== "string" || !request.path || request.path.includes("\0") ||
      typeof request.content !== "string") {
    throw new Error("invalid skill-file request");
  }
  const resolved = path.resolve(cwd, request.path);
  const roots = [path.join(home, ".agents", "skills"), path.join(home, ".claude", "skills"), cwd];
  // The whitelist is the seam: the module may name a file, the host decides whether it is inside a
  // permitted root. Both sides are compared through the filesystem (realpath of the deepest existing
  // ancestor), not lexically, so a symlinked `shop/` directory under a root cannot carry the write
  // elsewhere; the final component is then refused if it is itself a link.
  const permitted = roots.some(root => inside(realExisting(path.resolve(root)), realExisting(resolved)));
  if (!permitted) throw new Error("skill path outside permitted directories");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error("skill path is a symlink");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.writeFileSync(resolved, request.content, "utf8");
  return resolved;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** `realpath` of the deepest existing ancestor, with the not-yet-existing tail appended lexically. */
function realExisting(absolute) {
  let existing = absolute;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(existing), ...tail.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}
