// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7014 — the post-merge `issue-tests` detector (scripts/issue-tests-gate.mjs)
 * lost whole shards to one accumulated-heap OOM: one vitest fork ran every file
 * of a ~390-file shard, the built-in JSON reporter writes only at the end, so a
 * crash left no report and the shard exited 2 (7 of 12 shards in run
 * 38797187257). The gate now runs files through known-failures-gate's
 * crash-safe runner and reduces its per-file results with `resultsToIds`.
 *
 * These pin the reduction: a crashed or never-run file is ONE red id (never a
 * silent green, never the whole shard), collect errors and ordinary failures
 * keep their #3008 ids, and #3340 unexpected passes stay out of `failing`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT_EXCLUDE } from "../scripts/known-failures-gate.mjs";
import { resultsToIds } from "../scripts/lib/issue-tests-ids.mjs";

const REPO_ROOT = join(import.meta.dirname, "..");

const entry = (assertionResults: unknown[], status = "passed", message = "") => ({
  entry: { name: "/x", status, message, assertionResults },
});

describe("#7014 issue-tests gate — crash-safe per-test reduction", () => {
  it("keeps the other files of a shard when one file crashed alone", () => {
    const results = new Map<string, unknown>([
      ["tests/a.test.ts", { crash: "worker died even when run alone at 4096 MB heap (OOM / crash)" }],
      ["tests/b.test.ts", entry([{ fullName: "b works", status: "passed", failureMessages: [] }])],
    ]);
    const r = resultsToIds(["tests/a.test.ts", "tests/b.test.ts"], results);
    expect([...r.failing]).toEqual(["tests/a.test.ts :: <crash>"]);
    expect([...r.passing]).toEqual(["tests/b.test.ts :: b works"]);
    expect(r.messages["tests/a.test.ts :: <crash>"]).toMatch(/OOM/);
  });

  it("a file that reached no result is red <not-run>, never silently absent", () => {
    const r = resultsToIds(["tests/lost.test.ts"], new Map());
    expect([...r.failing]).toEqual(["tests/lost.test.ts :: <not-run>"]);
  });

  it("collect errors, failures and #3340 unexpected passes keep their ids", () => {
    const results = new Map<string, unknown>([
      ["tests/c.test.ts", entry([], "failed", "Cannot find module './gone'\n    at x")],
      [
        "tests/d.test.ts",
        entry(
          [
            { fullName: "d red", status: "failed", failureMessages: ["AssertionError: expected 1 to be 2\n  at y"] },
            { fullName: "d sentinel", status: "failed", failureMessages: ["Error: Expect test to fail"] },
            { fullName: "d skipped", status: "skipped", failureMessages: [] },
          ],
          "failed",
        ),
      ],
    ]);
    const r = resultsToIds(["tests/c.test.ts", "tests/d.test.ts"], results);
    expect([...r.failing].sort()).toEqual(["tests/c.test.ts :: <collect>", "tests/d.test.ts :: d red"]);
    expect([...r.unexpectedPasses]).toEqual(["tests/d.test.ts :: d sentinel"]);
    expect(r.passing.size).toBe(0);
    expect(r.messages["tests/c.test.ts :: <collect>"]).toBe("Cannot find module './gone'");
    expect(r.messages["tests/d.test.ts :: d red"]).toBe("AssertionError: expected 1 to be 2");
  });

  it("the gate no longer pins every shard file into one fork", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "issue-tests-gate.mjs"), "utf8");
    expect(src).not.toContain("singleFork=true");
    expect(src).toContain("runFiles(");
  });

  it("the population leaves out the test262 corpus entry points", () => {
    for (const f of ["test262-chunk1.test.ts", "test262-chunk-dynamic.test.ts", "linear-foo.test.ts"]) {
      expect(ROOT_EXCLUDE.test(f)).toBe(true);
    }
    expect(ROOT_EXCLUDE.test("issue-7014.test.ts")).toBe(false);
  });
});
