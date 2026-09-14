#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { GatewayRejectedError, runFlueReview } from './runtime.js';

const MAX_INPUT_BYTES = 128 * 1024;

/** Exit codes the parent process distinguishes. */
export const EXIT_TRANSIENT = 1;
export const EXIT_REJECTED = 2;

function startTelemetry(): NodeSDK | undefined {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    return undefined;
  }
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
  if (!bytes.length || bytes.length > MAX_INPUT_BYTES) {
    throw new Error('review input is empty or exceeds the safe byte limit');
  }
  const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const sdk = startTelemetry();

  try {
    const output = await trace
      .getTracer('pr-review-agent-flue')
      .startActiveSpan('review.flue.request', async (span) => {
        span.setAttributes({
          'review.input_bytes': bytes.length,
          'review.framework': 'flue',
          'gen_ai.request.model': 'reviewer',
        });
        try {
          const result = await runFlueReview(input);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } finally {
          span.end();
        }
      });
    process.stdout.write(output);
  } finally {
    await sdk?.shutdown();
  }
}

main().catch((error: unknown) => {
  // SDK errors can include private endpoints, response bodies, or credentials,
  // so only the retry classification crosses the process boundary.
  const rejected = error instanceof GatewayRejectedError;
  const detail = error instanceof Error ? error.message : '';
  process.stderr.write(
    rejected
      ? 'model request rejected: check local model gateway configuration\n'
      : `model request failed: the gateway did not return a usable response. ${detail}\n`,
  );
  process.exitCode = rejected ? EXIT_REJECTED : EXIT_TRANSIENT;
});
