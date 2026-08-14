// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4412 — a scoped test262 run must not append to the committed trend index.
//
// `benchmarks/results/runs/index.json` is committed and drives the report
// page's conformance trend graph. The append in `run-test262-vitest.sh` used
// to fire on any completed run, with no notion of scope, so a partial run
// posted a partial total as if it were a full pass. Observed 2026-08-14: a
// single-shard local run wrote `pass: 1902 / total: 2713` beside real
// ~30,000-test rows. The row is well-formed, so no downstream check rejects
// it — the only defence is refusing to write it.
import { describe, expect, it } from "vitest";
import { FULL_SHARD_GLOB, shouldPublishRunHistory } from "../scripts/should-publish-run-history.mjs";

describe("#4412 run-history publish guard", () => {
  it("publishes an unscoped full-corpus run", () => {
    expect(shouldPublishRunHistory({})).toMatchObject({ publish: true });
    expect(shouldPublishRunHistory({ TEST262_LOCAL_SHARD_GLOB: FULL_SHARD_GLOB })).toMatchObject({ publish: true });
  });

  it("refuses a path-filtered run", () => {
    const v = shouldPublishRunHistory({ TEST262_PATH_FILTER: "with|annexB" });
    expect(v.publish).toBe(false);
    // The reason must name the variable, or the skip looks like a bug.
    expect(v.reason).toContain("TEST262_PATH_FILTER");
  });

  it("refuses a narrowed shard glob — the exact 2026-08-14 case", () => {
    const v = shouldPublishRunHistory({ TEST262_LOCAL_SHARD_GLOB: "tests/test262-local-shard1.test.ts" });
    expect(v.publish).toBe(false);
    expect(v.reason).toContain("shard1");
  });

  it("ignores an empty or whitespace filter — that is not a scope", () => {
    expect(shouldPublishRunHistory({ TEST262_PATH_FILTER: "" })).toMatchObject({ publish: true });
    expect(shouldPublishRunHistory({ TEST262_PATH_FILTER: "   " })).toMatchObject({ publish: true });
    expect(shouldPublishRunHistory({ TEST262_LOCAL_SHARD_GLOB: "" })).toMatchObject({ publish: true });
  });

  it("lets an explicit 1 override the scope, but says the run was scoped", () => {
    const v = shouldPublishRunHistory({ TEST262_PATH_FILTER: "with", TEST262_PUBLISH_HISTORY: "1" });
    expect(v.publish).toBe(true);
    expect(v.reason).toContain("TEST262_PATH_FILTER=with");
  });

  it("lets an explicit 0 suppress an otherwise-publishable full run", () => {
    expect(shouldPublishRunHistory({ TEST262_PUBLISH_HISTORY: "0" })).toMatchObject({ publish: false });
  });

  it("treats a junk TEST262_PUBLISH_HISTORY as unset, not as consent", () => {
    // Only "1" forces. Anything else must not smuggle a scoped run through.
    expect(shouldPublishRunHistory({ TEST262_PATH_FILTER: "with", TEST262_PUBLISH_HISTORY: "yes" })).toMatchObject({
      publish: false,
    });
    expect(shouldPublishRunHistory({ TEST262_PATH_FILTER: "with", TEST262_PUBLISH_HISTORY: "true" })).toMatchObject({
      publish: false,
    });
  });
});
