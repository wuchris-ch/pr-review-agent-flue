#!/usr/bin/env node
import { runEntrypoint } from '../cli/harness.js';
import { runCli } from '../cli/main.js';

runEntrypoint(import.meta.url, () => runCli(process.argv.slice(2)));
