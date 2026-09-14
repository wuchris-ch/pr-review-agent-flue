import { runWatcher } from '../../watch/service.js';
import type { Command } from '../harness.js';

export const watchCommand: Command = {
  name: 'watch',
  summary: 'Poll GitHub continuously and publish reviews and commit statuses.',
  usage: 'usage: pr-review-watch',
  async run(args) {
    if (args.length > 0) {
      throw new Error('usage: pr-review-watch');
    }
    await runWatcher();
    // runWatcher never resolves; this keeps the Command contract total.
    return 0;
  },
};
