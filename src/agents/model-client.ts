#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { runFlueReview } from './runtime.js';

function startTelemetry(): NodeSDK | undefined {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    && !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return undefined;
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'pr-review-agent-flue',
    autoDetectResources: false,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  sdk.start();
  return sdk;
}

async function main(): Promise<void> {
  const bytes = readFileSync(0);
  if (!bytes.length || bytes.length > 128 * 1024) {
    throw new Error('review input is empty or exceeds the safe byte limit');
  }
  const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const sdk = startTelemetry();
  try {
    const output = await trace.getTracer('pr-review-agent-flue').startActiveSpan(
      'review.flue.request', async (span) => {
        span.setAttributes({
          'review.input_bytes': bytes.length,
          'review.framework': 'flue',
          'gen_ai.request.model': 'reviewer',
        });
        try {
          const result = await runFlueReview(input);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw new Error('Flue review failed');
        } finally {
          span.end();
        }
      },
    );
    process.stdout.write(output);
  } finally {
    await sdk?.shutdown();
  }
}

main().catch(() => {
  // SDK errors can include private endpoints, response bodies, or credentials.
  process.stderr.write('model request failed: check local model gateway configuration or execution limits\n');
  process.exitCode = 1;
});
