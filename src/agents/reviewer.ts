'use agent';

import { useModel } from '@flue/runtime';
import { REVIEW_SYSTEM_PROMPT } from './system-prompt.js';

export function ReviewAgent(): string {
  useModel('model-gateway/reviewer', { thinkingLevel: 'off', compaction: false });
  return REVIEW_SYSTEM_PROMPT;
}

ReviewAgent.agentName = 'diff-reviewer';
// Stays under the child's read timeout so the runtime, not the agent,
// reports a reply that never arrives.
ReviewAgent.durability = { maxAttempts: 1, timeoutMs: 195_000 };
