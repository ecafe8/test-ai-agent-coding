import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// This detects changes after capture; the digest is not itself an authorization.
export function issueSnapshot(issue, expectedNumber) {
  if (!Number.isSafeInteger(expectedNumber) || expectedNumber < 1 ||
      !issue || typeof issue !== 'object' || Array.isArray(issue) ||
      issue.number !== expectedNumber || issue.state !== 'open' || issue.pull_request != null ||
      typeof issue.title !== 'string' || !(typeof issue.body === 'string' || issue.body === null)) {
    throw new Error('Issue is missing, invalid, closed, or is a pull request');
  }
  return createHash('sha256').update(JSON.stringify([issue.number, issue.title, issue.body])).digest('hex');
}

async function main() {
  const [file, number, expectedDigest, ...extra] = process.argv.slice(2);
  if (!file || !/^[1-9][0-9]*$/.test(number ?? '') || extra.length ||
      (expectedDigest !== undefined && !/^[0-9a-f]{64}$/.test(expectedDigest))) {
    throw new Error('Usage: issue-snapshot.mjs ISSUE_JSON ISSUE_NUMBER [EXPECTED_DIGEST]');
  }
  const issue = JSON.parse(await readFile(file, 'utf8'));
  const digest = issueSnapshot(issue, Number(number));
  if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error('Issue content changed');
  console.log(digest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Do not echo issue contents or filesystem errors into workflow logs.
    console.error('Issue snapshot validation failed');
    process.exitCode = 1;
  });
}
