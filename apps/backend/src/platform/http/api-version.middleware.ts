import { Injectable, NestMiddleware } from "@nestjs/common";

interface Req {
  originalUrl?: string;
  url?: string;
}
interface Res {
  setHeader(name: string, value: string): void;
}

/** Operational endpoints are intentionally unversioned (probes and scrapers must not chase a version). */
const UNVERSIONED_BY_DESIGN = /^\/(health|metrics)(\/|$)/;
const VERSIONED = /^\/v\d+(\/|$)/;

/**
 * API versioning is URI-based (`/v1/...`). Until clients have moved, the same routes also answer
 * without the prefix; those responses carry `Deprecation: true` and a `Link` to the versioned URL
 * so a client can find out it is on the old path without breaking. Remove the unversioned aliases
 * (and this middleware) by dropping VERSION_NEUTRAL from `enableVersioning` in main.ts.
 */
@Injectable()
export class ApiVersionMiddleware implements NestMiddleware {
  use(req: Req, res: Res, next: () => void): void {
    const path = (req.originalUrl ?? req.url ?? "").split("?")[0];
    if (!VERSIONED.test(path) && !UNVERSIONED_BY_DESIGN.test(path)) {
      res.setHeader("Deprecation", "true");
      res.setHeader("Link", `</v1${path}>; rel="successor-version"`);
    }
    next();
  }
}
