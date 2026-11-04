import { createHash } from 'node:crypto';
import { issueSnapshot } from './issue-snapshot.mjs';
import { validateScope } from './verify-patch.mjs';
import { MAX_ALLOWED_STEPS, modelDigest, modelEndpointDigest, validateModelTarget } from './model-config.mjs';

const MAX_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RECORD_KEYS = [
  'version', 'repository', 'issue', 'projectOwner', 'projectNumber', 'agent',
  'action', 'baseSha', 'issueDigest', 'allowedPaths', 'modelDigest', 'modelEndpointDigest', 'maxSteps', 'budgetCents', 'budgetCurrency', 'expiresAt',
];

function utcSeconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error('Invalid authorization timestamp');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace('.000Z', 'Z') !== value) {
    throw new Error('Invalid authorization timestamp');
  }
  return parsed;
}

function validApiBase(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const path = url.pathname === '/' ? '' : url.pathname;
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      !path.endsWith('/') && `${url.origin}${path}` === value;
  } catch {
    return false;
  }
}

// Every input except the comment body must come from a trusted GitHub query or
// pinned workflow context. This function performs no network or permission check.
export function validateAuthorization({ comment, issue, boardApproval, context, now, expectedDigest }) {
  if (!context || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(context.repository ?? '') ||
      !Number.isSafeInteger(context.issue) || context.issue < 1 ||
      !Number.isSafeInteger(context.commentId) || context.commentId < 1 ||
      !/^[A-Za-z0-9-]+$/.test(context.actor ?? '') ||
      !['admin', 'maintain'].includes(context.permission) ||
      !/^[A-Za-z0-9-]+$/.test(context.projectOwner ?? '') ||
      !Number.isSafeInteger(context.projectNumber) || context.projectNumber < 1 ||
      !/^[0-9a-f]{40}$/.test(context.baseSha ?? '') ||
      !Number.isSafeInteger(context.budgetCents) || context.budgetCents < 1 ||
      !Number.isSafeInteger(context.maxSteps) || context.maxSteps < 1 || context.maxSteps > MAX_ALLOWED_STEPS ||
      !['CNY', 'USD'].includes(context.budgetCurrency) ||
      !validApiBase(context.apiUrl) ||
      !Number.isFinite(now)) {
    throw new Error('Invalid authorization context');
  }
  validateModelTarget(context.model, context.modelBaseUrl);
  validateScope(context.allowedPaths);
  if (!comment || comment.id !== context.commentId ||
      comment.user?.type !== 'User' || typeof comment.user?.login !== 'string' ||
      comment.user.login.toLowerCase() !== context.actor.toLowerCase() ||
      comment.issue_url !== `${context.apiUrl}/repos/${context.repository}/issues/${context.issue}` ||
      typeof comment.body !== 'string' || comment.body.length > 20000 ||
      comment.updated_at !== comment.created_at) {
    throw new Error('Invalid approval comment');
  }
  const created = utcSeconds(comment.created_at);
  if (!boardApproval || boardApproval.approved !== true || boardApproval.issue !== context.issue ||
      typeof boardApproval.approver !== 'string' || boardApproval.approver.toLowerCase() !== context.actor.toLowerCase()) {
    throw new Error('Board approval does not match the authorizing actor');
  }
  const prefix = '[Approved][OpenCode]\n';
  if (!comment.body.startsWith(prefix)) throw new Error('Approval marker missing');
  const recordText = comment.body.slice(prefix.length);
  let record;
  try { record = JSON.parse(recordText); } catch { throw new Error('Invalid approval record'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      JSON.stringify(record) !== recordText || Object.keys(record).length !== RECORD_KEYS.length ||
      RECORD_KEYS.some((key) => !Object.hasOwn(record, key))) {
    throw new Error('Invalid approval record fields');
  }
  validateScope(record.allowedPaths);
  const digest = issueSnapshot(issue, context.issue);
  if (record.version !== 1 || record.repository !== context.repository || record.issue !== context.issue ||
      record.projectOwner !== context.projectOwner || record.projectNumber !== context.projectNumber ||
      record.agent !== 'opencode' || record.action !== 'draft-pr' || record.baseSha !== context.baseSha ||
      record.issueDigest !== digest || JSON.stringify(record.allowedPaths) !== JSON.stringify(context.allowedPaths) ||
      record.modelDigest !== modelDigest(context.model) || record.modelEndpointDigest !== modelEndpointDigest(context.modelBaseUrl) ||
      record.maxSteps !== context.maxSteps ||
      record.budgetCents !== context.budgetCents || record.budgetCurrency !== context.budgetCurrency) {
    throw new Error('Approval does not match the requested operation');
  }
  const expires = utcSeconds(record.expiresAt);
  if (now < created || now >= expires || expires <= created || expires - created > MAX_APPROVAL_LIFETIME_MS) {
    throw new Error('Approval expired or outside its allowed lifetime');
  }
  const snapshot = createHash('sha256').update(JSON.stringify([
    comment.id, comment.issue_url, comment.user.login.toLowerCase(), comment.created_at, comment.updated_at, comment.body,
  ])).digest('hex');
  if (expectedDigest !== undefined && (!/^[0-9a-f]{64}$/.test(expectedDigest) || snapshot !== expectedDigest)) {
    throw new Error('Approval changed after capture');
  }
  return snapshot;
}
