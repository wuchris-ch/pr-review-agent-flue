'use agent';

import { useModel } from '@flue/runtime';
import { REVIEW_SYSTEM_PROMPT } from './system-prompt.js';

export function ReviewAgent(): string {
  useModel('model-gateway/reviewer', { thinkingLevel: 'off', compaction: false });
  return REVIEW_SYSTEM_PROMPT;
}

ReviewAgent.agentName = 'diff-reviewer';
ReviewAgent.durability = { maxAttempts: 1, timeoutMs: 105_000 };
