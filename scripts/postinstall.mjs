#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { posix, resolve, win32 } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SKILL_INSTALL_TIMEOUT_MS = 60_000;

export function installBundledSkill({
  env = process.env,
  execPath = process.execPath,
  moduleUrl = import.meta.url,
  platform = process.platform,
  spawn = spawnSync,
  stdout = process.stdout,
} = {}) {
  if (env.CI || Object.hasOwn(env, 'SHOP_SKIP_SKILL_INSTALL')) {
    return;
  }

  const skillPath = fileURLToPath(new URL('../skills/shop', moduleUrl));
  const fallback =
    `shop: skill installation skipped; install the bundled skill manually:\n` +
    `  path: ${JSON.stringify(skillPath)}\n` +
    `  command: npx --yes skills add <path> -g -y\n`;
  const npmExecPath = env.npm_execpath;
  const pathApi = platform === 'win32' ? win32 : posix;
  const usesNpmCli =
    typeof npmExecPath === 'string' &&
    pathApi.basename(npmExecPath).toLowerCase() === 'npm-cli.js';
  const command = usesNpmCli ? execPath : 'npx';
  const commandArgs = usesNpmCli
    ? [pathApi.join(pathApi.dirname(npmExecPath), 'npx-cli.js')]
    : [];

  if (platform === 'win32' && !usesNpmCli) {
    stdout.write(fallback);
    return;
  }

  stdout.write(`shop: installing bundled skill from ${skillPath}\n`);
  try {
    const result = spawn(
      command,
      [...commandArgs, '--yes', 'skills', 'add', skillPath, '-g', '-y'],
      {
        killSignal: 'SIGKILL',
        shell: false,
        stdio: 'inherit',
        timeout: SKILL_INSTALL_TIMEOUT_MS,
      },
    );
    if (result?.error || result?.status !== 0) {
      stdout.write(fallback);
      return;
    }
    stdout.write('shop: bundled skill installed.\n');
  } catch {
    stdout.write(fallback);
  }
}

try {
  if (
    process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  ) {
    installBundledSkill();
  }
} catch {
  // Package installation must never fail because skill installation failed.
}
