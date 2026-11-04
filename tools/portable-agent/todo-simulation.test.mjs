import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkBeforeClaim, checkRunning } from './board-gate.mjs';
import { issueSnapshot } from './issue-snapshot.mjs';
import { modelDigest, modelEndpointDigest } from './model-config.mjs';
import { runWorkflow } from './runner.mjs';
import { validateStaged } from './verify-patch.mjs';

const todoSource = `export function addTodo(items, title) {
  const text = title.trim();
  if (!text) throw new Error('Title required');
  return [...items, { title: text, done: false }];
}
export function completeTodo(items, index) {
  return items.map((item, i) => i === index ? { ...item, done: true } : item);
}
export function removeTodo(items, index) {
  return items.filter((_, i) => i !== index);
}
`;
const todoTests = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTodo, completeTodo, removeTodo } from '../src/todo.mjs';
test('todo lifecycle', () => {
  const added = addTodo([], '  buy milk  ');
  assert.deepEqual(added, [{ title: 'buy milk', done: false }]);
  assert.equal(completeTodo(added, 0)[0].done, true);
  assert.equal(added[0].done, false);
  assert.deepEqual(removeTodo(added, 0), []);
  assert.throws(() => addTodo([], '  '));
});
`;

async function setup({ extraChange = false, failCheck = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'portable-todo-simulation-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(workspace, 'README.md'), 'Todo simulation fixture\n');
  git('add', 'README.md');
  git('commit', '-qm', 'fixture base');
  const baseSha = git('rev-parse', 'HEAD').trim();
  const configPath = join(root, 'config.json');
  const taskPath = join(root, 'task.txt');
  const fake = join(root, 'fake-agent');
  const checks = {
    install: [process.execPath, '-e', 'process.exit(0)'], // No dependencies in this fixture.
    lint: [process.execPath, '--check', 'src/todo.mjs'],
    typecheck: [process.execPath, '--check', 'test/todo.test.mjs'], // Syntax only, not type checking.
    test: failCheck ? [process.execPath, '-e', 'process.exit(1)'] : [process.execPath, '--test', 'test/todo.test.mjs'],
    build: [process.execPath, '--check', 'src/todo.mjs'], // No build step in this fixture.
  };
  await writeFile(configPath, JSON.stringify({ version: 1, timeoutSeconds: 10, checks }));
  await writeFile(taskPath, 'Implement a Todo List with add, complete, and remove.');
  const fakeScript = `#!/usr/bin/env node
const fs = require('node:fs');
fs.mkdirSync('src', { recursive: true });
fs.mkdirSync('test', { recursive: true });
fs.writeFileSync('src/todo.mjs', ${JSON.stringify(todoSource)});
fs.writeFileSync('test/todo.test.mjs', ${JSON.stringify(todoTests)});
${extraChange ? "fs.writeFileSync('outside.txt', 'outside scope');" : ''}
`;
  await writeFile(fake, fakeScript, { mode: 0o755 });
  const issue = { number: 42, state: 'open', title: 'Todo list', body: 'Implement it' };
  const context = {
    repository: 'fixture/repo', issue: 42, commentId: 123, actor: 'Maintainer', permission: 'admin',
    projectOwner: 'fixture', projectNumber: 1, baseSha,
    allowedPaths: ['src/todo.mjs', 'test/todo.test.mjs'], model: 'aliyun/qwen-test',
    modelBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', maxSteps: 50, budgetCents: 100, budgetCurrency: 'CNY',
    apiUrl: 'https://api.github.com',
  };
  const record = {
    version: 1, repository: context.repository, issue: 42, projectOwner: context.projectOwner,
    projectNumber: context.projectNumber, agent: 'opencode', action: 'draft-pr', baseSha,
    issueDigest: issueSnapshot(issue, 42), allowedPaths: context.allowedPaths, modelDigest: modelDigest(context.model), modelEndpointDigest: modelEndpointDigest(context.modelBaseUrl), maxSteps: context.maxSteps,
    budgetCents: context.budgetCents, budgetCurrency: context.budgetCurrency, expiresAt: '2026-01-01T01:00:00Z',
  };
  const comment = {
    id: 123, user: { login: 'Maintainer', type: 'User' }, issue_url: 'https://api.github.com/repos/fixture/repo/issues/42',
    body: `[Approved][OpenCode]\n${JSON.stringify(record)}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
  const approval = { comment, issue, context, boardApproval: { approved: true, issue: 42, approver: 'Maintainer' }, now: Date.parse('2026-01-01T00:30:00Z') };
  return { root, workspace, git, configPath, taskPath, fake, approval, context };
}

// Offline composition test: it does not exercise GitHub Actions, live board state,
// claims, provider spending, or PR creation.
async function simulate(fixture, approval = fixture.approval) {
  const { context } = fixture;
  const event = { ...context, triggeringActor: context.actor, runAttempt: 1, refName: 'main',
    defaultBranch: 'main', workflowSha: context.baseSha, issueDigest: issueSnapshot(fixture.approval.issue, context.issue) };
  const providers = {
    github: {
      getDefaultBranch: async () => 'main',
      getDefaultHead: async () => context.baseSha, getPermission: async () => context.permission,
      getIssue: async () => approval.issue, getComment: async () => approval.comment,
    },
    board: {
      getConfig: async () => ({ repository: context.repository, owner: context.projectOwner,
        project_number: context.projectNumber, enabled_agents: ['opencode'] }),
      checkApproval: async () => approval.boardApproval,
      checkReady: async () => ({ ready: true, issue: context.issue, agent: 'opencode', repository: context.repository }),
      checkUnused: async (_issue, after) => ({ unused: true, issue: context.issue, after }),
      checkRunning: async () => ({ running: true, issue: context.issue, agent: 'opencode',
        repository: context.repository, session_id: 'synthetic-session' }),
    },
  };
  const gate = { event, providers, clock: () => approval.now };
  const approvalDigest = await checkBeforeClaim(gate);
  await checkRunning({ ...gate, session: 'synthetic-session', expectedDigest: approvalDigest });
  const result = await runWorkflow({ configPath: fixture.configPath, taskPath: fixture.taskPath,
    cwd: fixture.workspace, model: fixture.context.model, agentCommand: fixture.fake, quiet: true });
  if (result.status !== 'passed') return { result, patch: null };
  fixture.git('add', '-A');
  validateStaged(fixture.workspace, fixture.context.allowedPaths);
  await checkRunning({ ...gate, session: 'synthetic-session', expectedDigest: approvalDigest });
  return { result, patch: fixture.git('diff', '--cached', '--binary', '--no-renames') };
}

test('offline Todo fixture passes checks and a separate publisher validates the patch', async () => {
  const fixture = await setup();
  const { result, patch } = await simulate(fixture);
  assert.equal(result.status, 'passed');
  assert.equal(Object.keys(result.checks).length, 5);
  const publisher = join(fixture.root, 'publisher');
  execFileSync('git', ['clone', '-q', fixture.workspace, publisher]);
  execFileSync('git', ['checkout', '-q', fixture.context.baseSha], { cwd: publisher });
  execFileSync('git', ['apply', '--index'], { cwd: publisher, input: patch });
  assert.deepEqual(validateStaged(publisher, fixture.context.allowedPaths).sort(), fixture.context.allowedPaths.toSorted());
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ['--test', 'test/todo.test.mjs'], { cwd: publisher, env, stdio: 'pipe' });
});

test('offline Todo simulation rejects unauthorized and out-of-scope work', async () => {
  const unauthorized = await setup();
  await assert.rejects(simulate(unauthorized, { ...unauthorized.approval, boardApproval: { approved: false } }));
  assert.equal(unauthorized.git('status', '--porcelain').trim(), '');
  const outside = await setup({ extraChange: true });
  await assert.rejects(simulate(outside), /outside approved scope/);
});

test('offline Todo simulation does not produce a patch after a failed check', async () => {
  const fixture = await setup({ failCheck: true });
  const { result, patch } = await simulate(fixture);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.test.status, 'failed');
  assert.equal(result.checks.build, undefined);
  assert.equal(patch, null);
});
