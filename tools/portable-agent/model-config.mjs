import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SHARED_HOSTS = new Set([
  'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com', 'cn-hongkong.dashscope.aliyuncs.com',
]);
const REGIONAL_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.(?:cn-beijing|cn-hongkong|ap-southeast-1|ap-northeast-1|us-east-1|eu-central-1)\.maas\.aliyuncs\.com$/;
export const DEFAULT_MAX_STEPS = 50;
export const MAX_ALLOWED_STEPS = 100;

export function parseMaxSteps(value = String(DEFAULT_MAX_STEPS)) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid model step limit');
  const steps = Number(value);
  if (!Number.isSafeInteger(steps) || steps > MAX_ALLOWED_STEPS) throw new Error('Invalid model step limit');
  return steps;
}

export function modelEndpointDigest(baseUrl) {
  if (typeof baseUrl !== 'string') throw new Error('Invalid Model Studio URL');
  return createHash('sha256').update(baseUrl).digest('hex');
}

export function modelDigest(model) {
  return createHash('sha256').update(normalizeModelReference(model)).digest('hex');
}

export function normalizeModelReference(model) {
  if (typeof model !== 'string') throw new Error('Expected an Alibaba model ID');
  const reference = model.startsWith('aliyun/') ? model : `aliyun/${model}`;
  if (!/^aliyun\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reference)) {
    throw new Error('Expected an aliyun/model ID');
  }
  return reference;
}

// Only reviewed Model Studio endpoints are allowed to receive the provider key.
export function validateModelTarget(model, baseUrl) {
  const reference = normalizeModelReference(model);
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid Model Studio URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== '/compatible-mode/v1' || url.href !== baseUrl ||
      url.hostname.startsWith('token-plan.') ||
      !(SHARED_HOSTS.has(url.hostname) || REGIONAL_HOST.test(url.hostname))) {
    throw new Error('Unsupported Model Studio URL');
  }
  return reference.slice('aliyun/'.length);
}

// No credential values belong in this document. The generated system config
// is mounted read-only and receives its key through the container environment.
export function buildModelConfig(model, baseUrl, maxSteps = DEFAULT_MAX_STEPS) {
  const modelId = validateModelTarget(model, baseUrl);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_ALLOWED_STEPS) throw new Error('Invalid model step limit');
  return {
    $schema: 'https://opencode.ai/config.json',
    agents: { build: { steps: maxSteps } },
    providers: {
      aliyun: {
        name: 'Alibaba Cloud Model Studio',
        env: ['DASHSCOPE_API_KEY'],
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: baseUrl },
        models: Object.fromEntries([[modelId, { name: modelId }]]),
      },
    },
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'aliyun', effect: 'allow' },
      { action: 'tool.use', resource: 'websearch:*', effect: 'deny' },
      { action: 'tool.use', resource: 'subagent:*', effect: 'deny' },
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Invalid arguments');
    console.log(JSON.stringify(buildModelConfig(process.env.AGENT_WORKFLOW_MODEL, process.env.DASHSCOPE_BASE_URL, parseMaxSteps(process.env.AGENT_MAX_STEPS))));
  } catch {
    console.error('Invalid Alibaba Model Studio configuration');
    process.exitCode = 1;
  }
}
