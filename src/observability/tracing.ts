import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { TracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace';

const OPERATIONS = ['webhook.ingest', 'webhook.route', 'automation.send', 'automation.wait', 'automation.finalize', 'relay.deliver'] as const;
const ROUTES = ['webhook', 'management', 'health', 'metrics', 'console', 'unmatched'] as const;
export type TraceOperation = (typeof OPERATIONS)[number];
export type TraceRouteGroup = (typeof ROUTES)[number];
export interface RequestTrace {
  run<T>(work: () => T): T;
  end(statusCode: number, routeGroup: TraceRouteGroup): void;
}
export interface Tracing {
  enabled: boolean;
  startRequest(method: string): RequestTrace;
  withSpan<T>(operation: TraceOperation, work: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const noopRequest: RequestTrace = { run: (work) => work(), end() {} };
const disabled: Tracing = {
  enabled: false,
  startRequest: () => noopRequest,
  withSpan: (_operation, work) => work(),
  flush: async () => {},
  shutdown: async () => {},
};

/**
 * Explicit instrumentation only. No automatic request/SQL instrumentation or environment resource
 * detection, so bodies, URLs, tokens, SQL parameters and exception messages cannot enter a trace.
 * An absent endpoint allocates no exporter, timer or network connection.
 */
export function createTracing(env: NodeJS.ProcessEnv = process.env): Tracing {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || (env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces` : undefined);
  if (!endpoint || env.OTEL_SDK_DISABLED === 'true') return disabled;
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('OTLP endpoint must be an HTTP(S) collector URL without embedded credentials');
  const protocol = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol && protocol !== 'http/json') throw new Error('Tracing supports OTLP http/json');
  const role = ['all', 'api', 'worker', 'relay'].includes(env.ROLE ?? '') ? env.ROLE! : 'all';
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'blotato-comment-automation', 'service.version': '0.1.0', 'service.role': role }),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: url.toString(), timeoutMillis: 5_000 }), scheduledDelayMillis: 1_000, exportTimeoutMillis: 5_000 })],
  });
  const tracer = provider.getTracer('blotato-comment-automation', '0.1.0');
  const activeContexts = new AsyncLocalStorage<Context>();
  return {
    enabled: true,
    startRequest(method) {
      const safeMethod = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'OTHER';
      const span = tracer.startSpan('http.request', { kind: SpanKind.SERVER, attributes: { 'http.request.method': safeMethod } }, ROOT_CONTEXT);
      let ended = false;
      return {
        run: (work) => activeContexts.run(trace.setSpan(ROOT_CONTEXT, span), work),
        end(statusCode, routeGroup) {
          if (ended) return;
          ended = true;
          const code = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 0;
          span.setAttribute('http.response.status_code', code);
          span.setAttribute('app.route_group', ROUTES.includes(routeGroup) ? routeGroup : 'unmatched');
          if (code >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        },
      };
    },
    async withSpan(operation, work) {
      const name = OPERATIONS.includes(operation) ? operation : 'automation.operation';
      const parent = activeContexts.getStore() ?? ROOT_CONTEXT;
      const span = tracer.startSpan(name, {}, parent);
      try {
        return await activeContexts.run(trace.setSpan(parent, span), work);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally { span.end(); }
    },
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
