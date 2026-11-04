import { readFile } from 'node:fs/promises';

const CHECKS = ['install', 'lint', 'typecheck', 'test', 'build'];

export async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!config || config.version !== 1 || typeof config.checks !== 'object' || !config.checks) {
    throw new Error('Expected version 1 and a checks object');
  }
  for (const name of CHECKS) {
    const command = config.checks[name];
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || part.length === 0)) {
      throw new Error(`checks.${name} must be a non-empty array of non-empty strings`);
    }
  }
  const timeoutSeconds = config.timeoutSeconds ?? 1800;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error('timeoutSeconds must be an integer between 1 and 3600');
  }
  return { checks: config.checks, timeoutSeconds };
}

export { CHECKS };
