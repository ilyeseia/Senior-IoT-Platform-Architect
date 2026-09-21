import { Injectable, NestMiddleware } from "@nestjs/common";
import { contextFromHeaders, runWithContext } from "./request-context";

interface Req {
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  setHeader(name: string, value: string): void;
}

/** Establishes the request context and echoes the correlation id, so a caller can quote it when reporting a problem. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Req, res: Res, next: () => void): void {
    const ctx = contextFromHeaders(req.headers);
    res.setHeader("x-correlation-id", ctx.correlationId);
    runWithContext(ctx, next);
  }
}
