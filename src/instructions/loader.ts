/**
 * Instructions loader — reads the Oliver instructions directory into a
 * cached snapshot used during session assembly.
 *
 * File layout (Hermes-style naming):
 *   instructions/
 *     SOUL.md       ← AUTHORED: voice, principles, agent style
 *     domain.md     ← AUTHORED: domain knowledge
 *     playbook.md   ← AUTHORED: journey protocol
 *     lessons.md    ← LEARNED: textual learnings (agent can write here later)
 *     skills/       ← LEARNED: procedural memory (Phase v0.2)
 *
 * Design notes:
 * - Load ONCE at createAgent() time. Reading .md files per turn would
 *   invalidate the KV-cache (stable prefix requirement). In dev, restart
 *   to pick up changes. v0.1 may add HMR-aware reloading.
 * - Missing files are OK (returned empty). The only required file is
 *   SOUL.md — the agent needs at least a voice to act reasonably.
 * - Builders using `loadInstructions` provide an absolute path or a path
 *   relative to the process CWD. We do NOT try to be clever about locating
 *   the directory — explicit beats magic.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AssembledInstructions {
  /** AUTHORED — voice, principles, agent style. Required. */
  soul: string;
  /** AUTHORED — domain knowledge. Optional but strongly recommended. */
  domain: string;
  /** AUTHORED — journey protocol (e.g., DISCOVER → SUMMARIZE → EXECUTE). Optional. */
  playbook: string;
  /** LEARNED — textual learnings accumulated over sessions. Optional. */
  lessons: string;
  /** Absolute path the instructions were loaded from, for debugging. */
  sourcePath: string;
}

const AUTHORED_FILES = ["SOUL.md", "domain.md", "playbook.md"] as const;
const LEARNED_FILES = ["lessons.md"] as const;

type FileName =
  | (typeof AUTHORED_FILES)[number]
  | (typeof LEARNED_FILES)[number];

async function readIfExists(dir: string, filename: FileName): Promise<string> {
  try {
    return await readFile(join(dir, filename), "utf-8");
  } catch (err) {
    // Missing file → empty string. Other errors bubble up.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return "";
    }
    throw err;
  }
}

/**
 * Load the instructions directory. Call ONCE at agent setup; pass the
 * returned snapshot to `createAgent({ instructions })`.
 *
 * Throws if SOUL.md is missing — the agent needs at least a voice.
 */
export async function loadInstructions(
  dir: string,
): Promise<AssembledInstructions> {
  const [soul, domain, playbook, lessons] = await Promise.all([
    readIfExists(dir, "SOUL.md"),
    readIfExists(dir, "domain.md"),
    readIfExists(dir, "playbook.md"),
    readIfExists(dir, "lessons.md"),
  ]);

  if (!soul.trim()) {
    throw new Error(
      `[@repo/oliver] Missing SOUL.md in ${dir}. Oliver requires at least a voice/principles file to run. Create SOUL.md with the agent's voice and principles.`,
    );
  }

  return {
    soul,
    domain,
    playbook,
    lessons,
    sourcePath: dir,
  };
}

/**
 * Build `AssembledInstructions` in-memory without touching disk. Useful for
 * tests and for builders who want to assemble their instructions from
 * other sources (e.g., a CMS, database, or generated strings).
 *
 * Validation: `soul` must be non-empty — same contract as loadInstructions.
 */
export function instructionsFromStrings(params: {
  soul: string;
  domain?: string;
  playbook?: string;
  lessons?: string;
  /** Label shown as sourcePath — useful for debugging ("<in-memory>"). */
  label?: string;
}): AssembledInstructions {
  if (!params.soul.trim()) {
    throw new Error(
      "[@repo/oliver] instructionsFromStrings: `soul` cannot be empty.",
    );
  }
  return {
    soul: params.soul,
    domain: params.domain ?? "",
    playbook: params.playbook ?? "",
    lessons: params.lessons ?? "",
    sourcePath: params.label ?? "<in-memory>",
  };
}
