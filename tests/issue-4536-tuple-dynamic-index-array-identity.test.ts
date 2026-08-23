// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4536 — webpack ArrayHelpers.groupBy: a JSDoc `@returns {[T[], T[]]}` types
 * the reduce accumulator as a TUPLE, lowered to a fixed struct {_0, _1}. Three
 * defects stacked on that shape (all fixed here):
 *
 *  1. `groups[fn(v) ? 0 : 1]` — a DYNAMIC index into the tuple — compiled to
 *     `undefined` silently (property-access.ts required a numeric literal).
 *     Now a homogeneous tuple lowers a dynamic index to an i32 `struct.get`
 *     ladder.
 *  2. The tuple value crossing to the host read as `{_0:…,_1:…}`:
 *     `Array.isArray` said false and `.length` was 0. Tuples ARE arrays in JS
 *     semantics — `__extern_is_array` / `__extern_length` / `_wrapForHost` now
 *     present tuple structs (all fields `_N`) as arrays.
 *  3. (closure-exports) A vec-typed closure param receiving a host array via
 *     the dynamic `__call_fn_method_N` bridge trapped on a bare `ref.cast`;
 *     it now routes through the #2831 `__vec_from_extern` materializer.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";

// The verbatim upstream shape: CJS export, JSDoc tuple typing, default param.
const ARRAY_HELPERS_JS = `
"use strict";

/**
 * Partition an array by calling a predicate function on each value.
 * @template T
 * @param {T[]} arr Array of values to be partitioned
 * @param {(value: T) => boolean} fn Partition function which partitions based on truthiness of result.
 * @returns {[T[], T[]]} returns the values of \`arr\` partitioned into two new arrays based on fn predicate.
 */
module.exports.groupBy = (
	arr = [],
	fn
) =>
	arr.reduce(
		(groups, value) => {
			groups[fn(value) ? 0 : 1].push(value);
			return groups;
		},
		[[], []]
	);
`;

const MAIN_TS = `
import ArrayHelpers from "./lib/ArrayHelpers.js";

function deepSame(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Array.isArray(a[i]) || a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) if (a[i][j] !== b[i][j]) return false;
  }
  return true;
}
export function t(): any {
  return deepSame(ArrayHelpers.groupBy([1, 2, 3, 4, 5, 6], (x) => x % 2 === 0), [[2, 4, 6], [1, 3, 5]]) ? "yes" : "no";
}
export function t2(): any {
  return deepSame(ArrayHelpers.groupBy([], (x) => x % 2 === 0), [[], []]) ? "yes" : "no";
}
`;

async function compileAndWrap() {
  const root = mkdtempSync(join(tmpdir(), "issue-4536-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "ArrayHelpers.js"), ARRAY_HELPERS_JS);
  const entry = join(root, "main.ts");
  writeFileSync(entry, MAIN_TS);
  const result = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "web",
    experimentalIR: true,
    emitWat: false,
    deferTopLevelInit: true,
  });
  expect(result.success).toBe(true);
  const imports = buildCompiledImports(result as never, {}) as Record<string, unknown> & {
    setInstance?: (i: WebAssembly.Instance) => void;
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary!, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4536 JSDoc tuple accumulator behaves as an array (webpack groupBy)", () => {
  it("partitions into two arrays via the dynamic tuple index", async () => {
    const exp = await compileAndWrap();
    expect(exp.t!()).toBe("yes");
  });

  it("empty input returns the [[], []] seed intact", async () => {
    const exp = await compileAndWrap();
    expect(exp.t2!()).toBe("yes");
  });
});
