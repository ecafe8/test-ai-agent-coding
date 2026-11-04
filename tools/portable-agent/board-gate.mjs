import { validateAuthorization } from './authorization.mjs';
import { issueSnapshot } from './issue-snapshot.mjs';

// Providers must read current authoritative sources. In particular, getConfig
// must inspect the pinned local board config without contacting a project.
async function checkGate({ event, providers, stage, session, expectedDigest, clock = Date.now }) {
  if (!event || !['before-claim', 'running'].includes(stage) ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(event.repository ?? '') ||
      !Number.isSafeInteger(event.issue) || event.issue < 1 ||
      !Number.isSafeInteger(event.commentId) || event.commentId < 1 ||
      !Number.isSafeInteger(event.projectNumber) || event.projectNumber < 1 ||
      !/^[A-Za-z0-9-]+$/.test(event.projectOwner ?? '') ||
      !/^[A-Za-z0-9-]+$/.test(event.actor ?? '') || event.actor !== event.triggeringActor ||
      event.runAttempt !== 1 || !event.defaultBranch || event.refName !== event.defaultBranch ||
      !/^[0-9a-f]{40}$/.test(event.baseSha ?? '') || event.workflowSha !== event.baseSha ||
      !/^[0-9a-f]{64}$/.test(event.issueDigest ?? '') ||
      (stage === 'running' && (typeof session !== 'string' || !session.trim() || !/^[0-9a-f]{64}$/.test(expectedDigest ?? '')))) {
    throw new Error('Invalid gate context');
  }
  const config = await providers.board.getConfig();
  if (!config || typeof config.repository !== 'string' ||
      config.repository.toLowerCase() !== event.repository.toLowerCase() ||
      typeof config.owner !== 'string' || config.owner.toLowerCase() !== event.projectOwner.toLowerCase() ||
      config.project_number !== event.projectNumber || !Array.isArray(config.enabled_agents) ||
      !config.enabled_agents.some((agent) => typeof agent === 'string' && agent.toLowerCase() === 'opencode')) {
    throw new Error('Board configuration does not match the authorized target');
  }
  const defaultBranch = await providers.github.getDefaultBranch();
  if (defaultBranch !== event.defaultBranch) throw new Error('Default branch identity changed');
  const head = await providers.github.getDefaultHead(event.defaultBranch);
  if (head !== event.baseSha) throw new Error('Default branch changed');
  const permission = await providers.github.getPermission(event.actor);
  const issue = await providers.github.getIssue(event.issue);
  if (issueSnapshot(issue, event.issue) !== event.issueDigest) throw new Error('Issue differs from the captured task');
  const comment = await providers.github.getComment(event.commentId);
  const boardApproval = await providers.board.checkApproval(event.issue, 'opencode');
  const context = {
    repository: event.repository, issue: event.issue, commentId: event.commentId,
    actor: event.actor, permission, projectOwner: event.projectOwner, projectNumber: event.projectNumber,
    baseSha: event.baseSha, allowedPaths: event.allowedPaths, model: event.model, modelBaseUrl: event.modelBaseUrl, maxSteps: event.maxSteps,
    budgetCents: event.budgetCents, budgetCurrency: event.budgetCurrency, apiUrl: event.apiUrl,
  };
  const digest = validateAuthorization({ comment, issue, boardApproval, context, now: clock(), expectedDigest });
  const state = stage === 'before-claim'
    ? await providers.board.checkReady(event.issue, 'opencode', event.repository)
    : await providers.board.checkRunning(event.issue, 'opencode', session, event.repository);
  if (!state || state.issue !== event.issue || typeof state.agent !== 'string' || state.agent.toLowerCase() !== 'opencode' ||
      typeof state.repository !== 'string' || state.repository.toLowerCase() !== event.repository.toLowerCase() ||
      (stage === 'before-claim' && state.ready !== true) ||
      (stage === 'running' && (state.running !== true || state.session_id !== session))) {
    throw new Error('Board or claim state does not permit the operation');
  }
  if (stage === 'before-claim') {
    const unused = await providers.board.checkUnused(event.issue, comment.created_at, event.repository);
    if (!unused || unused.unused !== true || unused.issue !== event.issue || unused.after !== comment.created_at) {
      throw new Error('Approval may already have been used');
    }
  }
  // A slow board query must not turn an expired approval into a successful gate.
  validateAuthorization({ comment, issue, boardApproval, context, now: clock(), expectedDigest: digest });
  return digest;
}

// These functions only evaluate state. They do not claim, execute, publish,
// reserve a provider budget, or prevent another dispatch from using an approval.
export function checkBeforeClaim(options) {
  return checkGate({ ...options, stage: 'before-claim' });
}

export function checkRunning(options) {
  return checkGate({ ...options, stage: 'running' });
}
