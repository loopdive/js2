import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function writeJsonl(path: string, records: Record<string, unknown>[]) {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function buildReport(input: string, output: string, extraArgs: string[] = []) {
  execFileSync(
    "node",
    ["scripts/build-test262-report.mjs", "--input", input, "--output", output, "--target", "standalone", ...extraArgs],
    { cwd: process.cwd(), stdio: "pipe" },
  );
  return JSON.parse(readFileSync(output, "utf-8"));
}

describe("#1781 standalone test262 artifact root-cause map", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("builds a standalone root-cause map from JSONL failure metadata", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-1781-"));
    const input = join(tmpDir, "test262-standalone-results.jsonl");
    const output = join(tmpDir, "test262-standalone-report.json");

    writeJsonl(input, [
      {
        file: "test/language/expressions/literal/pass.js",
        category: "language/expressions/literal",
        status: "pass",
        scope: "standard",
        scope_official: true,
        strict: "both",
        reached_test: true,
      },
      {
        file: "test/built-ins/Object/dynamic-get.js",
        category: "built-ins/Object",
        status: "compile_error",
        error: "No dependency provided for imported function env::__extern_get",
        error_category: "wasm_compile",
        error_signature: "wasm_compile:No dependency provided for imported function env::__extern_get",
        imports: ["env::__extern_get"],
        host_import_leak_class: "dynamic_object_property",
        reached_test: false,
        scope: "standard",
        scope_official: true,
        strict: "both",
      },
      {
        file: "test/built-ins/RegExp/prototype/test/basic.js",
        category: "built-ins/RegExp",
        status: "fail",
        error: "returned 2",
        error_category: "assertion_fail",
        error_signature: "assertion_fail:returned #",
        reached_test: true,
        scope: "standard",
        scope_official: true,
        strict: "both",
      },
      {
        file: "test/built-ins/Proxy/proxy-newtarget.js",
        category: "built-ins/Proxy",
        status: "compile_error",
        error: "L12:3 Codegen error: Proxy not supported in standalone mode (#1472 Phase C).",
        error_category: "other",
        error_signature: "other:L#:## Codegen error: Proxy not supported in standalone mode (## Phase C).",
        reached_test: false,
        scope: "standard",
        scope_official: true,
        strict: "both",
      },
      {
        file: "test/language/expressions/object/dstr/meth-obj-ptrn-list-err.js",
        category: "language/expressions",
        status: "compile_error",
        error: "L34:12 unexpected undefined AST node in compileExpression",
        error_category: "other",
        error_signature: "other:L#:## unexpected undefined AST node in compileExpression",
        reached_test: false,
        scope: "standard",
        scope_official: true,
        strict: "both",
      },
    ]);

    const report = buildReport(input, output, ["--max-unclassified-root-causes", "0"]);

    expect(report.mode.target).toBe("standalone");
    expect(report.summary.total).toBe(5);
    expect(report.root_cause_map.total_non_pass_non_skip).toBe(4);
    expect(report.root_cause_map.classified).toBe(4);
    expect(report.root_cause_map.unclassified.count).toBe(0);

    const byId = new Map(report.root_cause_map.buckets.map((bucket: any) => [bucket.id, bucket]));
    expect(byId.get("standalone-dynamic-object-property").issues).toContain("#1472");
    expect(byId.get("standalone-regexp-native-engine").issues).toContain("#1914");
    expect(byId.get("standalone-dynamic-object-property").sample_signatures).toContain(
      "wasm_compile:No dependency provided for imported function env::__extern_get",
    );
    expect(byId.get("standalone-dynamic-object-property").sample_signatures).toContain(
      "other:L#:## Codegen error: Proxy not supported in standalone mode (## Phase C).",
    );
    expect(byId.get("object-property-semantics").sample_files).toContain(
      "test/language/expressions/object/dstr/meth-obj-ptrn-list-err.js",
    );
  });

  it("fails the explicit standalone unclassified threshold", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-1781-threshold-"));
    const input = join(tmpDir, "test262-standalone-results.jsonl");
    const output = join(tmpDir, "test262-standalone-report.json");

    writeJsonl(input, [
      {
        file: "test/new-area/new-root-cause.js",
        category: "new-area",
        status: "fail",
        error: "brand new diagnostic",
        error_category: "other",
        error_signature: "other:brand new diagnostic",
        reached_test: true,
        scope: "standard",
        scope_official: true,
        strict: "both",
      },
    ]);

    expect(() => buildReport(input, output, ["--max-unclassified-root-causes", "0"])).toThrow();
    const report = JSON.parse(readFileSync(output, "utf-8"));
    expect(report.root_cause_map.unclassified.count).toBe(1);
    expect(report.root_cause_map.unclassified.sample_files).toContain("test/new-area/new-root-cause.js");
  });

  it("wires local and CI standalone report generation to the shared checked builder", () => {
    const localRunner = readFileSync("scripts/run-test262-vitest.sh", "utf-8");
    expect(localRunner).toContain("scripts/build-test262-report.mjs");
    expect(localRunner).toContain('--target "$TEST262_TARGET"');
    expect(localRunner).toContain("--max-unclassified-root-causes");
    expect(localRunner).toContain("TEST262_MAX_UNCLASSIFIED_ROOT_CAUSES:-0");

    const shardedWorkflow = readFileSync(".github/workflows/test262-sharded.yml", "utf-8");
    expect(shardedWorkflow).toContain("--input merged-reports/test262-standalone-results-merged.jsonl");
    expect(shardedWorkflow).toContain("--target standalone");
    expect(shardedWorkflow).toContain("--max-unclassified-root-causes 0");
  });
});
