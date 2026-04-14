/**
 * Demo — visual proof that concurrencyKey serializes same-key execute()
 * and keeps different-key calls parallel.
 *
 * Run:  pnpm --filter oliver-agent demo:mutex
 */

import { withLock } from "../src/concurrency/mutex";

const t0 = Date.now();
const ts = () => String(Date.now() - t0).padStart(4, " ") + "ms";
const log = (line: string) => console.log(`[${ts()}] ${line}`);

async function work(name: string, key: string | undefined, durationMs: number) {
  const runner = async () => {
    log(`${name} START (key=${key ?? "—"})`);
    await new Promise((r) => setTimeout(r, durationMs));
    log(`${name} END`);
  };
  return key ? withLock(key, runner) : runner();
}

async function main() {
  console.log("=== Demo: 3 calls on quote:q1 + 1 call on quote:q2 ===\n");

  // Fire them ALL in parallel. Same-key ones must serialize; different-key
  // runs freely alongside.
  await Promise.all([
    work("A (q1)", "quote:q1", 100),
    work("B (q1)", "quote:q1", 100),
    work("C (q1)", "quote:q1", 100),
    work("D (q2)", "quote:q2", 100),
  ]);

  console.log("\n=== Control: 3 calls with NO key (should fully parallel) ===\n");

  await Promise.all([
    work("E", undefined, 100),
    work("F", undefined, 100),
    work("G", undefined, 100),
  ]);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
