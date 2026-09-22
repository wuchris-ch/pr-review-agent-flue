import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppAuth, validWebhook } from './app-auth.js';
import { GitHubClient } from './client.js';
import { type ReviewEvent, reviewEvent } from './events.js';
import { runGitHubReview } from './run.js';

/** One process owns this durable queue. Work starts on delivery or startup, never on a timer. */
export class DeliveryQueue {
  private readonly db: DatabaseSync;
  private draining = false;
  constructor(
    path: string,
    private readonly run: (event: ReviewEvent) => Promise<void>,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, event TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL); UPDATE deliveries SET state='queued' WHERE state='running'",
    );
  }
  enqueue(id: string, event: ReviewEvent): 'queued' | 'duplicate' {
    const existing = this.db.prepare('SELECT state FROM deliveries WHERE id=?').get(id);
    if (existing && existing.state !== 'failed') return 'duplicate';
    const count = this.db
      .prepare("SELECT count(*) AS count FROM deliveries WHERE state IN ('queued','running')")
      .get()!.count as number;
    if (count >= 30) throw new Error('review queue is full; redeliver later');
    this.db
      .prepare(
        "INSERT INTO deliveries VALUES (?,?,'queued',?) ON CONFLICT(id) DO UPDATE SET state='queued'",
      )
      .run(id, JSON.stringify(event), Date.now());
    this.db.exec(
      "DELETE FROM deliveries WHERE state IN ('done','failed') AND id NOT IN (SELECT id FROM deliveries ORDER BY created DESC LIMIT 1000)",
    );
    return 'queued';
  }
  state(id: string): unknown {
    return this.db.prepare('SELECT state FROM deliveries WHERE id=?').get(id)?.state;
  }
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const row = this.db
          .prepare("SELECT id,event FROM deliveries WHERE state='queued' ORDER BY created LIMIT 1")
          .get();
        if (!row) break;
        this.db.prepare("UPDATE deliveries SET state='running' WHERE id=?").run(row.id!);
        try {
          await this.run(JSON.parse(row.event as string) as ReviewEvent);
          this.db.prepare("UPDATE deliveries SET state='done' WHERE id=?").run(row.id!);
        } catch {
          this.db.prepare("UPDATE deliveries SET state='failed' WHERE id=?").run(row.id!);
          process.stderr.write('A webhook review failed. Redeliver its event to retry.\n');
        }
      }
    } finally {
      this.draining = false;
    }
  }
  close(): void {
    this.db.close();
  }
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('event too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function serveApp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  const secret = required('GITHUB_WEBHOOK_SECRET');
  if (secret.length < 32)
    throw new Error('GITHUB_WEBHOOK_SECRET must contain at least 32 characters');
  const auth = new AppAuth(
    required('GITHUB_APP_ID'),
    readFileSync(required('GITHUB_APP_PRIVATE_KEY_FILE'), 'utf8'),
  );
  const actor = await auth.identity();
  const queue = new DeliveryQueue(required('REVIEW_APP_DATABASE'), async (event) => {
    if (!event.installation) throw new Error('installation required');
    const token = await auth.token(event.installation);
    const client = new GitHubClient(token);
    if (!event.automatic && !(await client.canReview(event.repository, event.sender))) return;
    const result = await runGitHubReview({
      ...event,
      token,
      actor,
      publish: true,
      client,
      ...(event.head ? { expectedHead: event.head } : {}),
    });
    if (result.outcome === 'failed') throw new Error('review failed');
  });
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200).end('ok');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/webhooks/github') {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await body(request);
      const signature = request.headers['x-hub-signature-256'];
      if (!validWebhook(bytes, typeof signature === 'string' ? signature : undefined, secret)) {
        response.writeHead(401).end();
        return;
      }
      const id = request.headers['x-github-delivery'];
      const name = request.headers['x-github-event'];
      if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(id) || typeof name !== 'string') {
        response.writeHead(400).end();
        return;
      }
      if (name === 'ping') {
        response.writeHead(200).end('ok');
        return;
      }
      const event = reviewEvent(name, JSON.parse(bytes.toString('utf8')));
      if (!event || !event.installation) {
        response.writeHead(200).end('ignored');
        return;
      }
      const outcome = queue.enqueue(id, event);
      response.writeHead(outcome === 'queued' ? 202 : 200).end(outcome);
      void queue.drain();
    } catch {
      response.writeHead(503).end('event could not be accepted');
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT');
  server.listen(port, env.REVIEW_APP_HOST ?? '127.0.0.1', () => {
    process.stdout.write('GitHub App webhook receiver is ready.\n');
    void queue.drain();
  });
}
