import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../harness.js';

export const initCommand: Command = {
  name: 'init',
  summary: 'Create repository review rules and settings.',
  usage: 'usage: pr-review init',
  async run(args, { io, cwd }) {
    if (args.length) throw new Error(this.usage);
    const path = join(cwd, '.pr-review.json');
    if (existsSync(path)) throw new Error('.pr-review.json already exists');
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, rules: [], exclude: ['**/node_modules/**', '**/dist/**', '**/*.lock'], context: true, validateFindings: true, maxComments: 8, minSeverity: 'minor', failOnFindings: false, autoReview: true }, null, 2)}\n`,
      { flag: 'wx' },
    );
    io.stdout(
      'Created .pr-review.json. Set MODEL_GATEWAY_API_KEY, MODEL_GATEWAY_BASE_URL and REVIEW_AGENT_MODEL, then run pr-review review.\n',
    );
    return 0;
  },
};

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'Check runtime and model configuration without revealing secrets.',
  usage: 'usage: pr-review doctor',
  async run(args, { io }) {
    if (args.length) throw new Error(this.usage);
    let missing = false;
    for (const key of ['MODEL_GATEWAY_API_KEY', 'MODEL_GATEWAY_BASE_URL', 'REVIEW_AGENT_MODEL']) {
      const present = Boolean(process.env[key]?.trim());
      missing ||= !present;
      io.stdout(`${key}: ${present ? 'configured' : 'missing'}\n`);
    }
    io.stdout(`Node.js: ${process.version}\n`);
    return missing ? 1 : 0;
  },
};
