import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #5181 — the #1058 stack-balance shared-body refusal must be a CLASSIFIED
 * standalone root cause.
 *
 * The selfhost commit 8f161cbf15 (PR #5204) shifted 2,580 standalone rows onto
 * this one compile-error signature. 24 of them (Error.prototype.stack, the
 * harness deepEqual/testTypedArray helpers, instanceof) matched no feature-path
 * bucket, so `--max-unclassified-root-causes 0` failed in every merge_group and
 * wedged the queue. The bucket must claim exactly the residual and must NOT
 * poach rows an earlier feature-path bucket already owns.
 */
describe("#5181 standalone root-cause map — stack-balance shared-body refusal", () => {
  let tmpDir: string;
  let report: ReturnType<typeof JSON.parse>;

  const SIGNATURE =
    'stack-balance (#1058): function "__closure_61" reaches an instruction array from incompatible ' +
    "control-flow or function-local contexts. The repair pass refuses to mutate one shared body for " +
    "all owners; emit distinct instruction arrays at the producer.";

  const row = (file: string, extra: Record<string, unknown> = {}) => ({
    file,
    category: file.split("/")[1] ?? "",
    status: "compile_error",
    error: `L1:0 ${SIGNATURE}`,
    // The report normalises digits out of `error_signature`, so "(#1058)"
    // survives only in `error` — both spellings must match the bucket.
    error_signature: `other:L#:## ${SIGNATURE.replace("#1058", "##")}`,
    error_category: "other",
    scope: "standard",
    scope_official: true,
    strict: "both",
    ...extra,
  });

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-5181-"));
    const jsonl = join(tmpDir, "standalone.jsonl");
    const out = join(tmpDir, "standalone-report.json");

    const records = [
      // The residual: no feature-path bucket claims these four families.
      row("test/built-ins/Error/prototype/stack/setter-no-argument.js"),
      row("test/harness/deepEqual-array.js"),
      row("test/harness/testTypedArray.js"),
      row("test/language/expressions/instanceof/S15.3.5.3_A3_T1.js"),
      // Same signature, but a feature-path bucket owns it — the new bucket sits
      // after those, so this must stay in `temporal-proposal`.
      row("test/built-ins/Temporal/Duration/prototype/round/order-of-operations.js"),
      { file: "test/language/x.js", status: "pass", scope: "standard", scope_official: true, strict: "both" },
    ];
    writeFileSync(jsonl, records.map((r) => JSON.stringify(r)).join("\n"));

    // The gate CI runs in every merge_group. Threshold 0 means a non-exit-0
    // here IS the queue-blocking failure.
    execFileSync(
      "node",
      [
        "scripts/build-test262-report.mjs",
        "--input",
        jsonl,
        "--output",
        out,
        "--target",
        "standalone",
        "--max-unclassified-root-causes",
        "0",
      ],
      { cwd: process.cwd(), stdio: "pipe" },
    );
    report = JSON.parse(readFileSync(out, "utf-8"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("leaves no unclassified standalone failure for the merge_group gate", () => {
    expect(report.root_cause_map.unclassified.count).toBe(0);
  });

  it("claims the residual under a bucket named for the real cause", () => {
    const bucket = report.root_cause_map.buckets.find((b: { id: string }) => b.id === "stack-balance-shared-body");
    expect(bucket, "no stack-balance-shared-body bucket in the root-cause map").toBeTruthy();
    expect(bucket.count).toBe(4);
    expect(bucket.issues).toContain("#1058");
  });

  it("does not poach rows an earlier feature-path bucket already owns", () => {
    const temporal = report.root_cause_map.buckets.find((b: { id: string }) => b.id === "temporal-proposal");
    expect(temporal?.count).toBe(1);
  });
});
