/**
 * #4304 — the upstream Test262 harness self-tests must participate in the
 * canonical local and CI census. TEST_CATEGORIES is the shared discovery list
 * consumed by the precompiler, the local runner, and both sharded CI lanes.
 */
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findTestFiles, TEST_CATEGORIES } from "./test262-runner.js";

const ROOT = resolve(import.meta.dirname, "..");
const HARNESS_ROOT = join(ROOT, "test262", "test", "harness");

function upstreamHarnessTests(dir = HARNESS_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...upstreamHarnessTests(full));
    else if (entry.name.endsWith(".js") && !entry.name.includes("_FIXTURE") && !entry.name.endsWith(".imports.js")) {
      files.push(full);
    }
  }
  return files.sort();
}

describe("#4304 — Test262 harness tests are part of the canonical census", () => {
  it("registers the harness category used by local and sharded CI runners", () => {
    expect(TEST_CATEGORIES).toContain("harness");
  });

  it("discovers every upstream harness self-test with a non-vacuous corpus floor", () => {
    const expected = upstreamHarnessTests();
    const discovered = findTestFiles("harness");

    expect(expected.length).toBeGreaterThanOrEqual(116);
    expect(discovered.map((file) => relative(HARNESS_ROOT, file))).toEqual(
      expected.map((file) => relative(HARNESS_ROOT, file)),
    );
  });
});
