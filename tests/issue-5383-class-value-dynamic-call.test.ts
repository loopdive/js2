// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5383 — the S2i regression fix (2026-09-12).
//
// PR #5820 widened `classDynamicMemberCallApplies` to claim every `C[k](…)`
// whose receiver NAMES a compiled class, then resolved the callee with
// `__extern_get` on a freshly materialized class-object struct. That carrier
// does not hold a computed STATIC FIELD, so the fused call form answered
// `null` where the plain READ of the very same member answered the closure —
// 32 standalone `cpn-class-{decl,expr}-fields-methods-*` rows.
//
// The pins below are the reduction (both halves of the split: the read is
// right, the call was not) and two of the upstream rows.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

/**
 * The ≤10-line reduction, as a module whose export returns a string the host
 * lane and the standalone lane must agree on.
 *
 * `hit` proves the closure was INVOKED rather than merely produced: before the
 * fix the callee resolved to null and `__apply_closure` answered null without
 * calling anything, so a result-only assertion could not tell "called and
 * returned null" from "never called".
 */
const REDUCTION = `
let hit = 0;
let C = class {
  [1.1] = () => { return 3; };
  static [1.1] = () => { hit = hit + 1; return 2; };
};
let c = new C();
export function probe(): number {
  const readIsFn = typeof C[String(1.1)] === "function" ? 1 : 0;
  const called = C[String(1.1)]();
  return readIsFn * 1000 + called * 100 + hit * 10 + c[String(1.1)]();
}
`;

/**
 * `1` read-is-a-function · `2` the call's result · `1` invocation count ·
 * `3` the instance half, which never regressed. Before the fix the call
 * answered null, so the digits were `1` `0` `0` `3` = 1003.
 */
const EXPECTED = 1 * 1000 + 2 * 100 + 1 * 10 + 3;

async function runStandalone(source: string, exportName: string, fileName: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports, "#5383 standalone controls must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>)[exportName]!();
}

describe("#5383 S2i regression — a computed static field survives the fused call form", () => {
  it("standalone: C[k]() invokes the computed static field's closure", async () => {
    expect(await runStandalone(REDUCTION, "probe", "issue-5383-class-value-dynamic-call.ts")).toBe(EXPECTED);
  }, 300_000);

  for (const relativePath of [
    "language/statements/class/cpn-class-decl-fields-methods-computed-property-name-from-decimal-literal.js",
    "language/expressions/class/cpn-class-expr-fields-methods-computed-property-name-from-string-literal.js",
  ]) {
    const file = resolve(process.cwd(), "test262", "test", relativePath);
    it.skipIf(!existsSync(file))(
      `standalone: ${relativePath} passes`,
      async () => {
        try {
          const standalone = await runTest262File(file, "issue-5383", 60_000, "standalone");
          expect({ status: standalone.status, error: standalone.error }).toEqual({
            status: "pass",
            error: undefined,
          });
        } finally {
          restoreHostBuiltins();
        }
      },
      300_000,
    );
  }
});
