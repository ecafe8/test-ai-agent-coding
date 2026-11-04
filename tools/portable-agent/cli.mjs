#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { CHECKS, loadConfig } from './config.mjs';
import { normalizeModelReference } from './model-config.mjs';
import { runChecks, runWorkflow } from './runner.mjs';

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const configPath = resolve(process.env.AGENT_WORKFLOW_CONFIG ?? 'agent-workflow.json');
  if (action === 'preview' || action === 'doctor') {
    const config = await loadConfig(configPath);
    if (action === 'doctor') {
      for (const name of CHECKS) {
        const command = config.checks[name][0];
        const candidates = command.includes('/') ? [resolve(command)] : (process.env.PATH ?? '').split(':').map((dir) => resolve(dir || '.', command));
        const found = await Promise.any(candidates.map((path) => access(path, constants.X_OK).then(() => path))).catch(() => null);
        if (!found) throw new Error(`Executable not found for ${name}: ${command}`);
      }
    }
    console.log(JSON.stringify({ status: 'ready', mode: action, checks: config.checks, timeoutSeconds: config.timeoutSeconds }, null, 2));
    return;
  }
  if (action === 'run') {
    if (args.length !== 1) throw new Error('Usage: cli.mjs run TASK_FILE');
    const result = await runWorkflow({ configPath, taskPath: resolve(args[0]), cwd: process.cwd(), model: normalizeModelReference(process.env.AGENT_WORKFLOW_MODEL), quiet: true });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (action === 'checks') {
    const config = await loadConfig(configPath);
    const result = await runChecks({ config, cwd: process.cwd() });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
    return;
  }
  throw new Error('Usage: cli.mjs preview | doctor | checks | run TASK_FILE');
}

main().catch((error) => {
  console.error(`agent-workflow: ${error.message}`);
  process.exitCode = 1;
});
