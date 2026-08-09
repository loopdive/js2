import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function writeJsonl(path: string, records: Record<string, unknown>[]) {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

describe("#1908 standalone isSameValue residual bucket split", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function buildReport(records: Record<string, unknown>[]) {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-1908-"));
    const input = join(tmpDir, "test262-standalone-results.jsonl");
    const output = join(tmpDir, "test262-standalone-report.json");
    writeJsonl(input, records);

    execFileSync(
      "node",
      [
        "scripts/build-test262-report.mjs",
        "--input",
        input,
        "--output",
        output,
        "--target",
        "standalone",
        "--max-unclassified-root-causes",
        "0",
      ],
      { cwd: process.cwd(), stdio: "pipe" },
    );

    return JSON.parse(readFileSync(output, "utf-8"));
  }

  it("keeps real isSameValue validator failures while reclassifying assert.sameValue failures", () => {
    const report = buildReport([
      {
        file: "test/language/statements/async-generator/dflt-params-ref-self.js",
        category: "language/statements/async-generator",
        status: "compile_error",
        error:
          'invalid Wasm binary (WebAssembly.instantiate(): Compiling function #47:"isSameValue" failed: call[0] expected type i32, found local.get of type externref @+123)',
        error_category: "wasm_compile",
        error_signature:
          'wasm_compile:invalid Wasm binary (WebAssembly.instantiate(): Compiling function #47:"isSameValue" failed: call[0] expected type i32, found local.get of type externref @+123)',
        scope: "standard",
        scope_official: true,
        strict: "both",
      },
      {
        file: "test/language/statements/class/accessor-name-static/literal-string-empty.js",
        category: "language/statements/class/accessor-name-static",
        status: "fail",
        error: "returned 1 - assert 1 at L42: assert.sameValue(C[''], 'get string');",
        error_category: "assertion_fail",
        error_signature: "assertion_fail:returned # - assert ## at L#: assert.sameValue(C[''], 'get string');",
        scope: "standard",
        scope_official: true,
        strict: "both",
      },
    ]);

    const byId = new Map(report.root_cause_map.buckets.map((bucket: any) => [bucket.id, bucket]));

    expect(byId.get("issamevalue-invalid-wasm")?.count).toBe(1);
    expect(byId.get("issamevalue-invalid-wasm")?.sample_files).toContain(
      "test/language/statements/async-generator/dflt-params-ref-self.js",
    );
    expect(byId.get("class-element-private-descriptor")?.count).toBe(1);
    expect(byId.get("class-element-private-descriptor")?.sample_signatures).toContain(
      "assertion_fail:returned # - assert ## at L#: assert.sameValue(C[''], 'get string');",
    );
    expect(report.root_cause_map.unclassified.count).toBe(0);
  });
});
