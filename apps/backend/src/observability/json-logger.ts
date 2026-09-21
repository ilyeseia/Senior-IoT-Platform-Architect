import { LoggerService, LogLevel } from "@nestjs/common";
import { currentContext } from "../platform";

const LEVELS: Record<string, number> = { verbose: 10, debug: 20, log: 30, warn: 40, error: 50, fatal: 60 };

/**
 * One JSON object per line on stdout/stderr (`level`, `time`, `context`, `msg`, `correlation_id`),
 * ready for any log shipper — the "structured logs with correlation ids" of audit §16 without
 * adding a logging dependency. The active request's correlation id is attached automatically, so
 * every line written while handling a request can be found with one filter.
 * Selected with LOG_FORMAT=json (the default when NODE_ENV=production); text logs remain the
 * development default.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly minLevel: LogLevel = "log") {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write("log", message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write("error", message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.write("warn", message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.write("debug", message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write("verbose", message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.write("fatal", message, rest);
  }

  private write(level: LogLevel, message: unknown, rest: unknown[]): void {
    if ((LEVELS[level] ?? 30) < (LEVELS[this.minLevel] ?? 30)) {
      return;
    }
    // Nest passes the logger context (class name) as the last string argument; for `error` the
    // previous argument may be a stack trace.
    const strings = rest.filter((r): r is string => typeof r === "string");
    const context = strings.length > 0 ? strings[strings.length - 1] : undefined;
    const stack = level === "error" && strings.length > 1 ? strings[0] : undefined;

    const line = {
      level,
      time: new Date().toISOString(),
      context,
      correlation_id: currentContext()?.correlationId,
      msg: typeof message === "string" ? message : safeStringify(message),
      ...(stack ? { stack } : {}),
    };
    const out = level === "error" || level === "fatal" ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + "\n");
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}
