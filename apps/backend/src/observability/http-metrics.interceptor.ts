import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { MetricsService } from "./metrics.service";

interface Req {
  method: string;
  route?: { path?: string };
}
interface Res {
  statusCode: number;
}

/**
 * Records latency per (method, route template, status). The label is the route TEMPLATE
 * (`/devices/:id/commands`), never the concrete URL, so metric cardinality stays bounded no matter
 * how many device ids exist.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }
    const http = context.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<Res>();
    const started = process.hrtime.bigint();
    const record = (status: number) =>
      this.metrics.observeHttp(req.method, req.route?.path ?? "unmatched", status, Number(process.hrtime.bigint() - started) / 1e9);

    return next.handle().pipe(
      tap({
        next: () => record(res.statusCode),
        error: (err: unknown) => record(err instanceof HttpException ? err.getStatus() : 500),
      }),
    );
  }
}
