import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('model telemetry privacy policy', () => {
  it('records bounded metadata without prompt or completion content', () => {
    const source = readFileSync(
      new URL('../src/agents/model-client.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain("'review.input_bytes'");
    expect(source).not.toContain("'gen_ai.prompt'");
    expect(source).not.toContain("'gen_ai.completion'");
  });

  it('disables resource detection so process arguments are not exported', () => {
    const source = readFileSync(
      new URL('../src/agents/model-client.ts', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /new NodeSDK\(\{[\s\S]*?serviceName:[\s\S]*?autoDetectResources:\s*false,[\s\S]*?spanProcessors:/,
    );
    expect(source).not.toMatch(/autoDetectResources:\s*true/);
  });

  it('sends the raw input in the request body, not process arguments', () => {
    const source = readFileSync(
      new URL('../src/runner.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('input: message');
    expect(source).not.toContain("['run', agent, '--message', message]");
  });
});
