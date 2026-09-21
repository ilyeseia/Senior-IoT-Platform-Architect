import type { Repository } from "typeorm";
import { User } from "../../src/identity/user.entity";

/**
 * In-memory stand-in for Repository<User> covering exactly what IdentityService calls
 * (find/findOne/count/create/save + manager.transaction). Rows are keyed by id, so `save` of an
 * existing user updates it, like the real repository.
 *
 * `manager.transaction` runs transactions strictly one at a time, which is what the Postgres
 * advisory lock taken inside IdentityService guarantees in production.
 */
export function fakeUserRepo(): Repository<User> & { rows: Map<string, User> } {
  const rows = new Map<string, User>();
  let seq = 0;

  const withDefaults = (u: Partial<User>): User =>
    ({
      disabledAt: null,
      tokenVersion: 0,
      role: "admin",
      createdAt: new Date(2026, 0, 1, 0, 0, ++seq),
      ...u,
      id: u.id ?? `00000000-0000-4000-8000-${String(rows.size + 1).padStart(12, "0")}`,
    }) as User;

  const save = async (user: User) => {
    const stored = rows.has(user.id ?? "") ? Object.assign(rows.get(user.id)!, user) : withDefaults(user);
    rows.set(stored.id, stored);
    return stored;
  };
  // Copies, like a real database read: mutating a loaded entity must not silently change stored state.
  const find = async () => [...rows.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((r) => ({ ...r }) as User);
  const count = async () => rows.size;

  let queue: Promise<unknown> = Promise.resolve();
  const manager = {
    transaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      const run = queue.then(() =>
        work({
          query: async () => undefined,
          count,
          find,
          create: (_target: unknown, partial: Partial<User>) => partial as User,
          save: (a: unknown, b?: unknown) => save((b ?? a) as User),
        }),
      );
      queue = run.catch(() => undefined);
      return run;
    },
  };

  return {
    rows,
    count,
    find,
    findOne: async ({ where }: { where: { email?: string; id?: string } }) => {
      const row = [...rows.values()].find((r) => (where.email !== undefined ? r.email === where.email : r.id === where.id));
      return row ? ({ ...row } as User) : null;
    },
    create: (partial: Partial<User>) => partial as User,
    save,
    manager,
  } as unknown as Repository<User> & { rows: Map<string, User> };
}
