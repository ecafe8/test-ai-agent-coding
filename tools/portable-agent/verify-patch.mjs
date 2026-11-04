import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const protectedPaths = [
  '.github/', '.gitmodules', 'AGENTS.md', 'CLAUDE.md', '.agents.yaml', '.mcp.json',
  '.opencode/', 'opencode.json', 'opencode.jsonc', 'agent-workflow.json', 'tools/portable-agent/',
  'ai-agents-board.yml', 'ai-agents-board.yaml', '.ai-agents-board.yml', '.ai-agents-board.yaml',
];

const MAX_FILES = 100;
const MAX_PATH_BYTES = 4096;
const MAX_SCOPE_BYTES = 16384;

function validatePath(path) {
  if (typeof path !== 'string' || path.length === 0 || !path.isWellFormed() ||
      Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES ||
      /[\u0000-\u001f\u007f-\u009f\\*?\[\]]/u.test(path) ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid literal repository-relative file path');
  }
  const folded = path.toLowerCase();
  if (protectedPaths.some((entry) => entry.endsWith('/') ? folded.startsWith(entry.toLowerCase()) : folded === entry.toLowerCase())) {
    throw new Error(`Protected path changed: ${path}`);
  }
  if (folded.split('/').some((part) => part === '.git' || part === '.env' || part.startsWith('.env.'))) {
    throw new Error(`Sensitive path changed: ${path}`);
  }
}

// Only exact file paths are supported. Directory prefixes and globs grant no scope.
export function validateScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0 || scope.length > MAX_FILES) {
    throw new Error('Scope must contain between 1 and 100 literal file paths');
  }
  const unique = new Set();
  for (const path of scope) {
    validatePath(path);
    if (unique.has(path)) throw new Error('Scope contains a duplicate path');
    unique.add(path);
  }
  if (Buffer.byteLength(JSON.stringify(scope), 'utf8') > MAX_SCOPE_BYTES) throw new Error('Scope is too large');
  return unique;
}

export function validatePaths(paths, scope) {
  const allowed = validateScope(scope);
  if (paths.length === 0) throw new Error('Agent produced no changes');
  if (paths.length > MAX_FILES) throw new Error('Agent changed more than 100 files');
  for (const path of paths) {
    validatePath(path);
    if (!allowed.has(path)) throw new Error(`Path outside approved scope: ${path}`);
  }
}

export function validateStaged(cwd, scope) {
  const options = { cwd };
  // Lossy UTF-8 decoding could make different Git paths appear identical.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const paths = decoder.decode(execFileSync('git', ['diff', '--cached', '--name-only', '--no-renames', '-z'], options)).split('\0').filter(Boolean);
  validatePaths(paths, scope);
  const raw = decoder.decode(execFileSync('git', ['diff', '--cached', '--raw', '--no-renames', '-z'], options)).split('\0');
  for (let i = 0; i < raw.length - 1; i += 2) {
    const header = raw[i];
    if (!/^:([0-7]{6}) ([0-7]{6}) /.test(header)) throw new Error('Invalid git diff metadata');
    const [, oldMode, newMode] = header.match(/^:([0-7]{6}) ([0-7]{6}) /);
    if ([oldMode, newMode].some((mode) => mode === '120000' || mode === '160000')) {
      throw new Error(`Symlink or submodule change rejected: ${raw[i + 1]}`);
    }
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--check-scope')) throw new Error('Invalid arguments');
    const input = process.env.AGENT_ALLOWED_PATHS;
    if (!input || Buffer.byteLength(input, 'utf8') > MAX_SCOPE_BYTES) throw new Error('Missing or oversized scope');
    let scope;
    try { scope = JSON.parse(input); } catch { throw new Error('Scope must be valid JSON'); }
    if (args[0] === '--check-scope') {
      validateScope(scope);
      console.log('Scope syntax is valid; this does not authorize execution.');
    } else {
      console.log(JSON.stringify({ files: validateStaged(process.cwd(), scope) }));
    }
  } catch (error) {
    console.error(`patch rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
