import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

/**
 * Per-request context carried through async calls (AsyncLocalStorage), so any code — including
 * event producers deep inside a service — can stamp `correlation_id` / `trace_id` without every
 * function signature growing a context parameter (audit §16: every distributed operation carries
 * trace_id, span_id and correlation_id).
 */
export interface RequestContext {
  correlationId: string;
  traceId: string | null;
  spanId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** W3C trace context: version-traceid(32 hex)-parentid(16 hex)-flags */
const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * Builds a context from inbound headers. An `x-correlation-id` is accepted only if it is a short
 * token of safe characters (it is echoed in a response header and written to logs, so an
 * unconstrained value would allow header/log injection); otherwise a fresh one is generated.
 */
export function contextFromHeaders(headers: Record<string, string | string[] | undefined>): RequestContext {
  const rawCorrelation = firstValue(headers["x-correlation-id"]);
  const correlationId = rawCorrelation && CORRELATION_ID_PATTERN.test(rawCorrelation) ? rawCorrelation : randomUUID();

  const trace = TRACEPARENT_PATTERN.exec(firstValue(headers["traceparent"]) ?? "");
  return { correlationId, traceId: trace?.[1] ?? null, spanId: trace?.[2] ?? null };
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
