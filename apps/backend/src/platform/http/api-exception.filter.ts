import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { currentContext } from "../context/request-context";

/**
 * The one error shape every endpoint returns (audit §20 "consistent errors"):
 *
 *   { "error": { "code": "not_found", "message": "...", "status": 404,
 *                "details": [...],            // only when there is structured detail (validation issues)
 *                "correlation_id": "..." } }  // quote this when reporting a problem
 *
 * `code` is a stable, machine-readable string derived from the HTTP status; `message` is for humans.
 * Unexpected (non-HTTP) errors never leak their message or stack: the client gets a generic 500 and
 * the correlation id, and the full error is logged server-side under that id.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    correlation_id: string | null;
  };
}

const CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: "invalid_request",
  [HttpStatus.UNAUTHORIZED]: "unauthorized",
  [HttpStatus.FORBIDDEN]: "forbidden",
  [HttpStatus.NOT_FOUND]: "not_found",
  [HttpStatus.METHOD_NOT_ALLOWED]: "method_not_allowed",
  [HttpStatus.CONFLICT]: "conflict",
  [HttpStatus.PAYLOAD_TOO_LARGE]: "payload_too_large",
  [HttpStatus.UNPROCESSABLE_ENTITY]: "unprocessable",
  [HttpStatus.TOO_MANY_REQUESTS]: "too_many_requests",
  [HttpStatus.SERVICE_UNAVAILABLE]: "unavailable",
};

export function errorCodeForStatus(status: number): string {
  return CODES[status] ?? (status >= 500 ? "internal_error" : "error");
}

interface Normalized {
  status: number;
  message: string;
  details?: unknown;
}

export function normalizeException(exception: unknown): Normalized {
  if (!(exception instanceof HttpException)) {
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: "Internal server error" };
  }
  const status = exception.getStatus();
  const body = exception.getResponse();
  if (typeof body === "string") {
    return { status, message: body };
  }
  const obj = body as { message?: unknown; issues?: unknown; details?: unknown; error?: unknown };
  if (Array.isArray(obj.message)) {
    return { status, message: "Validation failed", details: obj.message };
  }
  const message = typeof obj.message === "string" ? obj.message : exception.message;
  // `details` (or the older `issues`, used by parseBody) carries structured, client-safe detail.
  const details = obj.details ?? obj.issues;
  return { status, message, ...(details !== undefined ? { details } : {}) };
}

interface ResponseLike {
  status(code: number): { json(body: unknown): void };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ResponseLike>();
    const correlationId = currentContext()?.correlationId ?? null;
    const { status, message, details } = normalizeException(exception);

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`unhandled error (correlation ${correlationId}): ${err.message}`, err.stack);
    }

    const body: ApiErrorBody = {
      error: {
        code: errorCodeForStatus(status),
        message,
        status,
        ...(details !== undefined ? { details } : {}),
        correlation_id: correlationId,
      },
    };
    response.status(status).json(body);
  }
}
