import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Coding-agent command-line tools that can review a checkout with read-only tools. */
export const AGENT_CLIS = ['claude', 'codex'] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

const MAX_AGENT_STDOUT_BYTES = 16 * 1024 * 1024;

export interface AgentReviewerOptions {
  readonly cli: AgentCli;
  /** Checkout the agent may read. It is never modified. */
  readonly cwd: string;
  /** Tells the agent where the change is, for example which branch holds it. */
  readonly description: string;
  /** Command that prints the change, for example `git diff main...pr`. */
  readonly diffCommand: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeoutMs: number;
}

/**
 * A plain review request.
 *
 * Benchmarking showed a strong agent given this short request, free to read the
 * repository, finds far more real defects than the same model constrained by the
 * pipeline's long contract prompt. Precision comes from the stages after it:
 * grounding to changed lines, optional evidence validation, merging and caps.
 */
export function agentReviewPrompt(description: string, diffCommand: string): string {
  return [
    `Review this pull request. ${description} Use \`${diffCommand}\` to see the change and read the surrounding code as needed.`,
    '',
    'Report the bugs and problems this pull request introduces that the author should fix before merging. Reply with only the list of findings, one per issue, in exactly this format:',
    '',
    '- [P1] Short title | path/relative/to/repo:line',
    '  Explanation of the problem, when it happens and its impact.',
    '',
    'Use P0 for critical, P1 for high, P2 for medium and P3 for low priority. If there are no issues, reply with: No findings.',
  ].join('\n');
}

/** The agent may search and read the checkout and inspect Git history. It cannot edit, run code or use the network. */
const CLAUDE_TOOLS = 'Read,Grep,Glob,Bash';
const CLAUDE_ALLOWED = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git status:*)',
  'Bash(git grep:*)',
  'Bash(git ls-files:*)',
];

interface Invocation {
  command: string;
  args: string[];
  stdin?: string;
}

function invocation(options: AgentReviewerOptions, prompt: string, outputFile: string): Invocation {
  if (options.cli === 'claude') {
    return {
      command: 'claude',
      args: [
        '-p',
        prompt,
        ...(options.model ? ['--model', options.model] : []),
        ...(options.effort ? ['--effort', options.effort] : []),
        '--safe-mode',
        '--tools',
        CLAUDE_TOOLS,
        '--allowedTools',
        ...CLAUDE_ALLOWED,
        '--permission-prompts',
        'none',
        '--output-format',
        'json',
        '--no-session-persistence',
      ],
    };
  }
  return {
    command: 'codex',
    args: [
      'exec',
      ...(options.model ? ['-m', options.model] : []),
      ...(options.effort ? ['-c', `model_reasoning_effort="${options.effort}"`] : []),
      '-c',
      'sandbox_mode="read-only"',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '-o',
      outputFile,
      '-',
    ],
    stdin: prompt,
  };
}

/** Extract the final answer from Claude Code's JSON output (a result object or an event list). */
export function claudeResult(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const result = [...events]
    .reverse()
    .find(
      (event): event is { type: string; result?: unknown; is_error?: unknown } =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: unknown }).type === 'result',
    );
  if (!result || result.is_error === true || typeof result.result !== 'string') {
    throw new Error('the agent reviewer did not return a result');
  }
  return result.result;
}

/** Run one read-only agent review of a checkout and return its findings text. */
export async function runAgentReviewer(options: AgentReviewerOptions): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'pr-review-agent-'));
  const outputFile = join(scratch, 'last-message.md');
  const prompt = agentReviewPrompt(options.description, options.diffCommand);
  const { command, args, stdin } = invocation(options, prompt, outputFile);
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? '');
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('the agent reviewer exceeded its time budget'));
      }, options.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_AGENT_STDOUT_BYTES) {
          child.kill('SIGTERM');
          finish(new Error('the agent reviewer produced too much output'));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.resume();
      child.on('error', (error) =>
        finish(new Error(`unable to start ${command}: ${error.message}`)),
      );
      child.on('close', (code) => {
        if (code !== 0) finish(new Error(`the agent reviewer exited with status ${String(code)}`));
        else finish(undefined, Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.end(stdin ?? '');
    });
    return options.cli === 'claude' ? claudeResult(stdout) : readFileSync(outputFile, 'utf8');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export type AgentPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface AgentFinding {
  priority: AgentPriority;
  title: string;
  file: string;
  line: number;
  body: string;
}

const HEADER =
  /^\s*[-*]\s+\[(P[0-3])\]\s+(.+?)\s+(?:\||\u2014|\u2013|--)\s+`?([^\s`]+?):(\d+)(?:-\d+)?`?\s*$/u;

function relativePath(path: string, root: string): string | undefined {
  let value = path.replace(/^\.\//, '');
  for (const prefix of root ? [`/private${root}/`, `${root}/`] : []) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length);
  }
  return value.startsWith('/') || value.split('/').includes('..') ? undefined : value;
}

/** Parse the agent's findings list. Lines that do not follow the format are ignored. */
export function parseAgentFindings(text: string, root = ''): AgentFinding[] {
  const findings: AgentFinding[] = [];
  let current: AgentFinding | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = HEADER.exec(line);
    if (match) {
      const file = relativePath(match[3]!, root.replace(/\/$/, ''));
      current = file
        ? {
            priority: match[1] as AgentPriority,
            title: match[2]!.trim(),
            file,
            line: Number(match[4]),
            body: '',
          }
        : undefined;
      if (current) findings.push(current);
    } else if (current && line.trim()) {
      current.body = current.body ? `${current.body} ${line.trim()}` : line.trim();
    }
  }
  return findings.filter((finding) => finding.line > 0);
}
