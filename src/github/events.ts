export interface ReviewEvent {
  repository: string;
  number: number;
  automatic: boolean;
  sender: string;
  head?: string;
  installation?: number;
}

/** Parse data only. Permission checks happen against GitHub before any model spending. */
export function reviewEvent(name: string, payload: unknown): ReviewEvent | undefined {
  if (!['pull_request', 'pull_request_target', 'issue_comment', 'workflow_dispatch'].includes(name))
    return undefined;
  if (!payload || typeof payload !== 'object') throw new Error('invalid GitHub event');
  const event = payload as {
    repository?: { full_name?: unknown };
    action?: string;
    pull_request?: { draft?: boolean; number?: number; head?: { sha?: string } };
    issue?: { pull_request?: unknown; number?: number };
    comment?: { body?: unknown };
    inputs?: Record<string, unknown>;
    sender?: { login?: unknown };
    installation?: { id?: number };
  };
  const repository = event.repository?.full_name;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error('invalid event repository');
  let number: number | undefined;
  let automatic = false;
  let head: string | undefined;
  if (name === 'pull_request' || name === 'pull_request_target') {
    if (
      !['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(event.action ?? '') ||
      event.pull_request?.draft
    )
      return undefined;
    number = event.pull_request?.number;
    head = event.pull_request?.head?.sha;
    if (typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(head))
      throw new Error('invalid PR event revision');
    automatic = true;
  } else if (name === 'issue_comment') {
    if (
      event.action !== 'created' ||
      !event.issue?.pull_request ||
      typeof event.comment?.body !== 'string' ||
      !/^\/review\s*$/.test(event.comment.body.trim())
    )
      return undefined;
    number = event.issue?.number;
  } else if (name === 'workflow_dispatch') {
    const value = event.inputs?.['pull-request'];
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
      throw new Error('manual review requires a pull-request number');
    number = Number(value);
  } else return undefined;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)
    throw new Error('invalid PR event number');
  const sender = event.sender?.login;
  if (typeof sender !== 'string' || !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(sender))
    throw new Error('invalid event sender');
  const installation = event.installation?.id;
  return {
    repository,
    number,
    automatic,
    sender,
    ...(head ? { head } : {}),
    ...(typeof installation === 'number' && Number.isSafeInteger(installation) && installation > 0
      ? { installation }
      : {}),
  };
}
