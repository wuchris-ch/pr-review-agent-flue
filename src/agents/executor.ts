import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_AGENT_OUTPUT_BYTES = 1024 * 1024;

export interface AgentProcess {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type AgentExecutor = (message: string, timeoutMs: number) => Promise<AgentProcess>;

/**
 * Variables the model child is allowed to inherit.
 *
 * The child runs untrusted diff text through a model, so it gets an
 * explicit allowlist rather than the parent environment.
 */
const INHERITED_VARIABLES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'MODEL_GATEWAY_API_KEY',
  'MODEL_GATEWAY_BASE_URL',
  'REVIEW_AGENT_MODEL',
  'REVIEW_MAX_OUTPUT_TOKENS',
  'REVIEW_REASONING_EFFORT',
  'REVIEW_GATEWAY_TIMEOUT_SECONDS',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
  'OTEL_SERVICE_NAME',
  'OTEL_TRACES_EXPORTER',
]);

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && INHERITED_VARIABLES.has(key)) {
      environment[key] = value;
    }
  }
  return environment;
}

function collect(
  stream: NodeJS.ReadableStream | null,
  onOverflow: () => void,
): { read: () => string } {
  const chunks: string[] = [];
  let bytes = 0;
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_AGENT_OUTPUT_BYTES) {
      onOverflow();
      return;
    }
    chunks.push(chunk);
  });
  return { read: () => chunks.join('') };
}

/**
 * Run one review request in an isolated child process.
 *
 * Asynchronous by design: the pipeline runs several partitions at once,
 * which the previous `spawnSync` implementation made impossible.
 */
export function runModelChild(message: string, timeoutMs: number): Promise<AgentProcess> {
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  const agent = join(packageRoot, 'dist', 'agents', 'model-client.js');

  return new Promise<AgentProcess>((resolve) => {
    const child = spawn(process.execPath, [agent], {
      cwd: packageRoot,
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let failure: Error | undefined;
    const finish = (status: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ...(failure ? { error: failure } : {}),
        status,
        stdout: stdout.read(),
        stderr: stderr.read(),
        ...usageMetadata(stderr.read()),
      });
    };

    const abort = (reason: string): void => {
      failure ??= new Error(reason);
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => abort('model child exceeded its deadline'), timeoutMs);
    const stdout = collect(child.stdout, () => abort('model child produced too much output'));
    const stderr = collect(child.stderr, () => abort('model child produced too much output'));

    child.on('error', (error: Error) => {
      failure ??= error;
      finish(null);
    });
    child.on('close', (code) => finish(failure ? null : code));
    child.stdin.on('error', () => abort('model child closed its input stream'));
    child.stdin.end(message, 'utf8');
  });
}

/** Accept only non-sensitive, numeric metadata from the isolated child. */
export function usageMetadata(stderr: string): Pick<AgentProcess, 'usage'> {
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('REVIEW_USAGE ')) continue;
    try {
      const value = JSON.parse(line.slice(13));
      if (
        Number.isSafeInteger(value.inputTokens) &&
        value.inputTokens >= 0 &&
        Number.isSafeInteger(value.outputTokens) &&
        value.outputTokens >= 0
      ) {
        return { usage: { inputTokens: value.inputTokens, outputTokens: value.outputTokens } };
      }
    } catch {
      /* Malformed metadata cannot affect a review. */
    }
  }
  return {};
}
