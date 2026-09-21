import { HttpException, HttpStatus, Injectable } from "@nestjs/common";

/**
 * In-memory brute-force protection for POST /auth/login (audit I2). Counts FAILED attempts in a
 * sliding window per account (email) and per client address, and refuses further attempts once a
 * limit is reached. A success clears the account counter (not the address counter).
 *
 * Deliberately in-process: correct for one backend instance, and it fails safe (a restart only
 * forgets counters, it never locks anyone out). With more than one replica the limits become
 * per-replica; moving the counters to Redis is part of the same change that introduces Redis
 * (see ADVANCED-ARCHITECTURE-AUDIT.md §29). Bcrypt's cost (12) is the second line of defence.
 */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_ACCOUNT = 5;
export const MAX_FAILURES_PER_ADDRESS = 20;
/** Bound on tracked keys so a flood of distinct emails/addresses cannot grow the maps forever. */
const MAX_TRACKED_KEYS = 10_000;

interface Window {
  failures: number[]; // timestamps (ms) of failures inside the window
}

@Injectable()
export class LoginThrottle {
  private readonly byAccount = new Map<string, Window>();
  private readonly byAddress = new Map<string, Window>();

  /** Clock source; a plain field (not a constructor parameter) so Nest's DI has nothing to resolve. Tests replace it. */
  now: () => number = Date.now;

  /** Throws 429 when either the account or the address is over its limit. */
  assertAllowed(email: string, address: string): void {
    const retryAfter = Math.max(
      this.retryAfterMs(this.byAccount, normalize(email), MAX_FAILURES_PER_ACCOUNT),
      this.retryAfterMs(this.byAddress, address, MAX_FAILURES_PER_ADDRESS),
    );
    if (retryAfter > 0) {
      throw new HttpException(
        `Too many failed login attempts. Try again in ${Math.ceil(retryAfter / 1000)} seconds.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Counts a failed attempt. Returns which limits this very failure reached, so the caller can
   * report a lockout once (when it starts) instead of once per further attempt.
   */
  recordFailure(email: string, address: string): { account: boolean; address: boolean } {
    return {
      account: this.push(this.byAccount, normalize(email)) === MAX_FAILURES_PER_ACCOUNT,
      address: this.push(this.byAddress, address) === MAX_FAILURES_PER_ADDRESS,
    };
  }

  recordSuccess(email: string): void {
    this.byAccount.delete(normalize(email));
  }

  /** Milliseconds until the oldest counted failure leaves the window, or 0 if under the limit. */
  private retryAfterMs(map: Map<string, Window>, key: string, limit: number): number {
    const window = this.prune(map, key);
    if (!window || window.failures.length < limit) {
      return 0;
    }
    return window.failures[0] + LOGIN_WINDOW_MS - this.now();
  }

  /** Adds a failure and returns how many are now inside the window. */
  private push(map: Map<string, Window>, key: string): number {
    const window = this.prune(map, key) ?? { failures: [] };
    window.failures.push(this.now());
    map.set(key, window);
    if (map.size > MAX_TRACKED_KEYS) {
      this.evictExpired(map);
    }
    return window.failures.length;
  }

  private prune(map: Map<string, Window>, key: string): Window | undefined {
    const window = map.get(key);
    if (!window) {
      return undefined;
    }
    const cutoff = this.now() - LOGIN_WINDOW_MS;
    window.failures = window.failures.filter((t) => t > cutoff);
    if (window.failures.length === 0) {
      map.delete(key);
      return undefined;
    }
    return window;
  }

  private evictExpired(map: Map<string, Window>): void {
    for (const key of [...map.keys()]) {
      this.prune(map, key);
    }
    // Still over the bound (a sustained flood of distinct keys): drop the oldest-inserted entries.
    for (const key of map.keys()) {
      if (map.size <= MAX_TRACKED_KEYS) {
        break;
      }
      map.delete(key);
    }
  }
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}
