/**
 * Process-level resource mutex.
 *
 * When two tool calls target the same resource (e.g., both apply discounts
 * to `quote:qot_abc`), their `execute()` steps must not interleave. The
 * mutex serializes them: second caller awaits the first before its own
 * execute runs. Different keys stay fully parallel.
 *
 * Scope: module-level. Each Node process has its own registry. In Vercel
 * serverless each request is its own process, so the mutex protects a
 * single request's tool loop from self-racing. In long-lived dev servers
 * or monolith deployments, it also serializes across concurrent users on
 * the same resource — generally desirable, not worth carving out.
 *
 * Distributed deployments (multiple Node instances hitting shared state)
 * need DB-level advisory locks; that's a v0.1 concern. Document here so
 * builders aren't surprised.
 *
 * Implementation: Map<key, Promise>. Acquiring replaces the map entry
 * with a new promise that resolves on release; waiters await the previous
 * promise first. Chained promises form a FIFO queue per key.
 */

const registry: Map<string, Promise<void>> = new Map();

export interface MutexLock {
  /** Release the lock. Safe to call multiple times (idempotent). */
  release: () => void;
}

/**
 * Acquire a lock on `key`. Returns a handle whose `release()` method must
 * be called when the protected section finishes (success OR failure).
 *
 * Prefer `withLock()` below when possible — it handles release in a
 * try/finally so a thrown error can't leak the lock.
 */
export async function acquireLock(key: string): Promise<MutexLock> {
  const previous = registry.get(key);

  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Install our promise FIRST, then await the previous. This ordering
  // means a third caller arriving while we wait sees our promise in the
  // registry and queues behind US, not behind the one we're waiting on.
  registry.set(key, settled);

  if (previous) {
    await previous;
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      // Only clear the registry entry if it's still ours — someone else
      // may have chained after us and become the current holder.
      if (registry.get(key) === settled) {
        registry.delete(key);
      }
      release();
    },
  };
}

/**
 * Run `fn` while holding the lock on `key`. Releases in a finally block
 * so a thrown exception doesn't leak the lock. Rethrows whatever `fn`
 * threw.
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(key);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * Test-only: clear the mutex registry. NEVER call in production code —
 * concurrent holders would be silently dropped, leaving their promises
 * dangling. Exposed for unit tests that want a clean slate between runs.
 */
export function __resetRegistryForTests(): void {
  registry.clear();
}
