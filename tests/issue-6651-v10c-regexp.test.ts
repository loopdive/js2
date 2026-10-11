// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 slice V10c) Three standalone RegExp rows, two root causes — neither
 * in the RegExp builtins themselves:
 *
 * - `exec/{success,failure}-lastindex-access` — `r.lastIndex = counter` records
 *   the counter's struct type so a later `assert.sameValue(r.lastIndex,
 *   counter)` passes the ORIGINAL reference, not a ToPrimitive `$Object` copy.
 *   That record lived on the function frame, and a large top-level script is
 *   split into `__module_init_chunk_N` frames, so the assertion compiled in the
 *   next chunk lost it and compared two different objects. The module-init
 *   chunks now share one record (declarations.ts).
 * - `Symbol.split/coerce-flags-err` — `u = { flags: Symbol.split }` over
 *   `var u = { flags: { toString() {…} } }` was compiled INTO the initializer's
 *   struct, dropping the symbol for `null`; `@@split` then built flags
 *   `"nully"` and threw SyntaxError instead of TypeError. A diverging assigned
 *   literal now pins the binding to the open `$Object` carrier
 *   (declarations/assigned-shape-divergent-objects.ts).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/RegExp/prototype/Symbol.split/coerce-flags-err.js",
  "built-ins/RegExp/prototype/exec/success-lastindex-access.js",
  "built-ins/RegExp/prototype/exec/failure-lastindex-access.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

describe("#6651 V10c — standalone RegExp singles", () => {
  for (const relativePath of EXACT_ROWS) {
    itWithTest262(
      `test262 standalone: ${relativePath}`,
      async () => {
        try {
          const result = await runTest262File(
            join(TEST262_ROOT, "test", relativePath),
            "issue-6651-v10c",
            180_000,
            "standalone",
          );
          expect(`${relativePath}: ${result.status}`).toBe(`${relativePath}: pass`);
        } finally {
          restoreHostBuiltins();
        }
      },
      200_000,
    );
  }

  it("a differently shaped assigned literal keeps its own property values", async () => {
    const source = `
var u = { flags: { toString: function () { throw 1; } } };
u = { flags: Symbol.split };
var w = { a: 1 };
w = { b: 2 };
export function test(): number {
  const f: any = u.flags;
  if (f === null) return -1;
  if (f !== Symbol.split) return -2;
  if ((w as any).b !== 2) return -3;
  if ((w as any).a !== undefined) return -4;
  return 1;
}
`;
    const result = await compile(source, {
      fileName: "v10c-shape.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toHaveLength(0);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(1);
  }, 200_000);
});
