import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1_048_576;

function safeNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid issue or comment number');
  return String(value);
}

function safeAgent(value) {
  if (value !== 'opencode') throw new Error('Unsupported agent');
  return value;
}

async function checkConfigFile(workspace, path) {
  const [stat, root, actual] = await Promise.all([lstat(path), realpath(workspace), realpath(path)]);
  const inside = relative(root, actual);
  if (!stat.isFile() || !inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) {
    throw new Error('Board config must be a regular file inside the trusted workspace');
  }
}

// Providers use argument arrays, never a shell. Credentials are separated by
// process and command output/errors are not printed by this module.
export function createProviders({ repository, workspace, boardConfigPath, boardBinary, githubToken, projectsToken,
  githubApiUrl, githubGraphqlUrl, command = executeFile, verifyConfigFile = checkConfigFile }) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') ||
      typeof workspace !== 'string' || !isAbsolute(workspace) ||
      typeof boardConfigPath !== 'string' || !isAbsolute(boardConfigPath) ||
      boardConfigPath !== resolve(workspace, 'ai-agents-board.yml') ||
      typeof boardBinary !== 'string' || !isAbsolute(boardBinary) ||
      typeof githubToken !== 'string' || !githubToken ||
      typeof projectsToken !== 'string' || !projectsToken) {
    throw new Error('Invalid provider configuration');
  }
  // The initial adapter intentionally supports GitHub.com only. Do not send a
  // credential to an inferred enterprise endpoint without a reviewed design.
  if (githubApiUrl !== 'https://api.github.com' ||
      (githubGraphqlUrl !== undefined && githubGraphqlUrl !== 'https://api.github.com/graphql')) {
    throw new Error('Invalid GitHub API URL');
  }
  const baseEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const githubEnv = { ...baseEnv, GH_TOKEN: githubToken, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
  const boardEnv = { ...baseEnv, GITHUB_PROJECTS_TOKEN: projectsToken, GITHUB_API_URL: githubApiUrl,
    ...(githubGraphqlUrl ? { GITHUB_GRAPHQL_URL: githubGraphqlUrl } : {}) };
  const options = (env) => ({ cwd: workspace, env, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
  async function json(file, args, env) {
    try {
      const { stdout } = await command(file, args, options(env));
      return JSON.parse(stdout);
    } catch {
      throw new Error('Authoritative source query failed');
    }
  }
  const board = (args, env = boardEnv) => json(boardBinary, ['--config', boardConfigPath, '--format', 'json', ...args], env);
  const gh = (path) => json('gh', ['api', '--method', 'GET', path], githubEnv);
  return {
    github: {
      async getDefaultBranch() { return (await gh(`repos/${repository}`)).default_branch; },
      async getDefaultHead(branch) {
        if (typeof branch !== 'string' || !branch || branch.length > 255 || /[\u0000-\u001f\u007f]/.test(branch)) throw new Error('Invalid branch');
        return (await gh(`repos/${repository}/commits/${encodeURIComponent(branch)}`)).sha;
      },
      async getPermission(actor) {
        if (!/^[A-Za-z0-9-]+$/.test(actor ?? '')) throw new Error('Invalid actor');
        return (await gh(`repos/${repository}/collaborators/${actor}/permission`)).permission;
      },
      getIssue: (issue) => gh(`repos/${repository}/issues/${safeNumber(issue)}`),
      getComment: (comment) => gh(`repos/${repository}/issues/comments/${safeNumber(comment)}`),
    },
    board: {
      async getConfig() {
        try { await verifyConfigFile(workspace, boardConfigPath); } catch { throw new Error('Invalid board config file'); }
        return board(['inspect-config'], baseEnv);
      },
      checkApproval: (issue, agent) => board(['check-approval', safeNumber(issue), '--agent', safeAgent(agent), '--strict']),
      checkReady: (issue, agent, expectedRepository) => {
        if (expectedRepository !== repository) throw new Error('Repository mismatch');
        return board(['check-ready', safeNumber(issue), '--agent', safeAgent(agent), '--expected-repository', repository]);
      },
      checkUnused: (issue, after, expectedRepository) => {
        if (expectedRepository !== repository || typeof after !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(after)) {
          throw new Error('Invalid approval timestamp or repository');
        }
        return board(['check-unused', safeNumber(issue), '--after', after]);
      },
      checkRunning: (issue, agent, session, expectedRepository) => {
        if (expectedRepository !== repository || typeof session !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(session)) {
          throw new Error('Invalid claim context');
        }
        return board(['check-running', safeNumber(issue), '--agent', safeAgent(agent), '--session', session, '--expected-repository', repository]);
      },
    },
  };
}
