#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBeforeClaim, checkRunning } from './board-gate.mjs';
import { createProviders } from './providers.mjs';
import { parseMaxSteps } from './model-config.mjs';

function positiveInteger(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? '')) throw new Error('Invalid numeric input');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Invalid numeric input');
  return parsed;
}

export async function runGate({ action, env, providersFactory = createProviders, clock = Date.now }) {
  if (!['before-claim', 'running'].includes(action) || !env.GITHUB_WORKSPACE || !isAbsolute(env.GITHUB_WORKSPACE) ||
      !env.AGENT_ALLOWED_PATHS || Buffer.byteLength(env.AGENT_ALLOWED_PATHS, 'utf8') > 16384) {
    throw new Error('Invalid gate inputs');
  }
  let allowedPaths;
  try { allowedPaths = JSON.parse(env.AGENT_ALLOWED_PATHS); } catch { throw new Error('Invalid scope'); }
  const workspace = resolve(env.GITHUB_WORKSPACE);
  const event = {
    repository: env.GITHUB_REPOSITORY, issue: positiveInteger(env.ISSUE_NUMBER),
    commentId: positiveInteger(env.APPROVAL_COMMENT_ID), actor: env.ACTOR, triggeringActor: env.TRIGGERING_ACTOR,
    runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT), refName: env.REF_NAME, defaultBranch: env.DEFAULT_BRANCH,
    workflowSha: env.WORKFLOW_SHA, baseSha: env.EXPECTED_SHA, issueDigest: env.ISSUE_DIGEST, projectOwner: env.PROJECT_OWNER,
    projectNumber: positiveInteger(env.PROJECT_NUMBER), allowedPaths, model: env.AGENT_WORKFLOW_MODEL,
    modelBaseUrl: env.DASHSCOPE_BASE_URL, maxSteps: parseMaxSteps(env.AGENT_MAX_STEPS), budgetCents: positiveInteger(env.AGENT_BUDGET_CENTS),
    budgetCurrency: env.AGENT_BUDGET_CURRENCY, apiUrl: env.GITHUB_API_URL,
  };
  const providers = providersFactory({ repository: event.repository, workspace,
    boardConfigPath: resolve(workspace, 'ai-agents-board.yml'), boardBinary: env.BOARD_MANAGER_BINARY,
    githubToken: env.GATE_GITHUB_TOKEN, projectsToken: env.GATE_PROJECTS_TOKEN,
    githubApiUrl: env.GITHUB_API_URL, githubGraphqlUrl: env.GITHUB_GRAPHQL_URL });
  const options = { event, providers, clock };
  if (action === 'before-claim') return checkBeforeClaim(options);
  return checkRunning({ ...options, session: env.AGENT_CLAIM_SESSION, expectedDigest: env.APPROVAL_DIGEST });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error('Gate failed: invalid arguments');
    process.exitCode = 1;
  } else {
    runGate({ action: process.argv[2], env: process.env })
      .then((digest) => console.log(digest))
      .catch(() => {
        // Never print provider responses, issue content, or credentials.
        console.error('Gate failed: authorization or source verification failed');
        process.exitCode = 1;
      });
  }
}
