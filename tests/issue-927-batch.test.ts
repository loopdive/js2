import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { readFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { parseMeta, wrapTest } from "./test262-runner.ts";
import { buildImports } from "../src/runtime.ts";

// The negative test262 tests that still compiled and instantiated (error "expected parse/early <Error> but compiled
// and instantiated successfully") in the earliest baseline snapshot that survives: loopdive/js2wasm-baselines
// 63c403d (test262-current.jsonl, 2026-04-25). The original April list (/tmp/current-neg-failures.txt, made by hand
// for #927 on ~2026-04-03, 840 tests) is lost; this list was regenerated from that snapshot on 2026-11-26 with:
//   git -C js2wasm-baselines show 63c403d:test262-current.jsonl | node -e 'const rows = require("fs")
//     .readFileSync(0, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) =>
//     /expected parse\/early \w+ but compiled and instantiated/.test(r.error ?? ""));
//     console.log(rows.map((r) => r.file).sort().join("\n"))'
// That gives 165 tests: the ones #927 had not yet fixed by 2026-04-25, a harder subset than the original 840.
const lines = readFileSync(new URL("./fixtures/issue-927-negative-failures-2026-04-25.txt", import.meta.url), "utf-8")
  .trim()
  .split("\n");
const TEST262_DIR = fileURLToPath(new URL("../test262/", import.meta.url));

describe("Issue #927 batch test — negative test rejection rate", () => {
  it("should reject negative tests (matching vitest runner behavior)", async () => {
    let nowReject = 0;
    let stillAccept = 0;
    let fileErrors = 0;
    const acceptedTests: string[] = [];

    for (const rel of lines) {
      const fullPath = TEST262_DIR + rel;
      try {
        const src = readFileSync(fullPath, "utf-8");
        const meta = parseMeta(src);

        // Use wrapTest like the vitest runner does (includes resolveUnicodeEscapes etc.)
        const { source: wrapped } = wrapTest(src, meta);

        // Compile with skipSemanticDiagnostics like the worker does
        const result = await compile(wrapped, {
          fileName: "test.ts",
          emitWat: false,
          skipSemanticDiagnostics: true,
        });

        // Same logic as test262-worker.mjs: check success and error-severity only
        const hasErrors = !result.success || result.errors.some((e: any) => e.severity === "error");

        if (hasErrors) {
          nowReject++;
          continue;
        }

        // Compilation succeeded — try instantiation (like the worker does)
        try {
          const imports = buildImports(result.imports, undefined, result.stringPool);
          await WebAssembly.instantiate(result.binary, imports);
        } catch {
          // Instantiation failed — counts as rejection
          nowReject++;
          continue;
        }

        // Compiled AND instantiated successfully — still failing
        stillAccept++;
        if (acceptedTests.length < 30) {
          acceptedTests.push(rel);
        }
      } catch {
        fileErrors++;
      }
    }

    console.log(`\n  Results: ${nowReject} now rejected, ${stillAccept} still accepted, ${fileErrors} file errors`);
    console.log(`  Rate: ${nowReject}/${lines.length} = ${((nowReject / lines.length) * 100).toFixed(1)}%`);
    if (acceptedTests.length > 0) {
      console.log(`  Still accepted (first ${Math.min(acceptedTests.length, 20)}):`);
      for (const t of acceptedTests.slice(0, 20)) console.log(`    ${t}`);
    }
    // Acceptance criteria: significant improvement
    expect(nowReject).toBeGreaterThanOrEqual(100);
  }, 600000);
});
