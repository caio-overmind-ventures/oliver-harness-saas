import { defineConfig } from "tsup";

export default defineConfig({
  // Single entry — index.ts re-exports everything publicly available.
  entry: ["src/index.ts"],
  // ESM only. Modern bundlers + Node 22+ all support it; CJS doubling is
  // extra weight for marginal compat gain in 2026.
  format: ["esm"],
  // Type declarations matter — they're how adopters get IntelliSense.
  dts: true,
  // No splitting for a small library — single-file output is simpler to
  // debug and just as fast to load.
  splitting: false,
  // Keep `require` / `__dirname` working in the (rare) consumer that
  // bridges back to CJS.
  shims: false,
  // Source maps so stack traces in production point at real lines.
  sourcemap: true,
  // Wipe `dist/` before each build.
  clean: true,
  // Don't bundle these — keep them as runtime imports so the consumer's
  // versions take precedence (no duplicates in the final app bundle).
  external: ["ai", "drizzle-orm", "nanoid", "zod"],
});
