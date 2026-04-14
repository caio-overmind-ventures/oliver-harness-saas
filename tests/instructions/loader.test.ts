import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadInstructions,
  instructionsFromStrings,
} from "../../src/instructions/loader";

describe("loadInstructions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oliver-instructions-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads all four files when present", async () => {
    await writeFile(join(dir, "SOUL.md"), "voice");
    await writeFile(join(dir, "domain.md"), "domain knowledge");
    await writeFile(join(dir, "playbook.md"), "playbook");
    await writeFile(join(dir, "lessons.md"), "lessons");

    const instructions = await loadInstructions(dir);

    expect(instructions.soul).toBe("voice");
    expect(instructions.domain).toBe("domain knowledge");
    expect(instructions.playbook).toBe("playbook");
    expect(instructions.lessons).toBe("lessons");
    expect(instructions.sourcePath).toBe(dir);
  });

  it("treats missing optional files as empty strings", async () => {
    await writeFile(join(dir, "SOUL.md"), "voice");
    // domain, playbook, lessons missing

    const instructions = await loadInstructions(dir);

    expect(instructions.soul).toBe("voice");
    expect(instructions.domain).toBe("");
    expect(instructions.playbook).toBe("");
    expect(instructions.lessons).toBe("");
  });

  it("throws when SOUL.md is missing", async () => {
    await writeFile(join(dir, "domain.md"), "stuff");

    await expect(loadInstructions(dir)).rejects.toThrow(/Missing SOUL\.md/);
  });

  it("throws when SOUL.md exists but is empty/whitespace-only", async () => {
    await writeFile(join(dir, "SOUL.md"), "   \n\n  ");

    await expect(loadInstructions(dir)).rejects.toThrow(/Missing SOUL\.md/);
  });

  it("throws when directory does not exist (propagates ENOENT on non-missing-file reads)", async () => {
    // The error here surfaces from readFile on a nonexistent dir — different
    // code path from an existing dir with a missing file.
    await expect(loadInstructions(join(dir, "nope"))).rejects.toThrow();
  });
});

describe("instructionsFromStrings", () => {
  it("builds a valid snapshot from raw strings", () => {
    const snapshot = instructionsFromStrings({
      soul: "voice",
      domain: "domain",
      playbook: "playbook",
      lessons: "lessons",
      label: "test",
    });

    expect(snapshot.soul).toBe("voice");
    expect(snapshot.domain).toBe("domain");
    expect(snapshot.playbook).toBe("playbook");
    expect(snapshot.lessons).toBe("lessons");
    expect(snapshot.sourcePath).toBe("test");
  });

  it("defaults optional fields to empty strings", () => {
    const snapshot = instructionsFromStrings({ soul: "voice" });

    expect(snapshot.domain).toBe("");
    expect(snapshot.playbook).toBe("");
    expect(snapshot.lessons).toBe("");
    expect(snapshot.sourcePath).toBe("<in-memory>");
  });

  it("throws on empty soul", () => {
    expect(() => instructionsFromStrings({ soul: "" })).toThrow(/soul.*empty/);
  });
});
