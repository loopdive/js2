// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6411 — a SPREAD argument to a host-bridged Array method contributes its
// runtime element count, not one slot.
//
// Same idiom as #5361, in the two host-array argument builders that fix did not
// reach: `compileArrayConcatExternHost` (`__array_concat_any`) and
// `compileArrayMethodExtern` (`__extern_method_call`). Both built the argument
// array with `__js_array_new` + one `__js_array_push` per AST node, so
// `[].concat(...arrays)` handed `Array.prototype.concat` the SOURCE array as a
// single argument and it flattened one level too few:
//
//   [].concat(...[[], [1], [2, 3]])   // => [[], [1], [2, 3]], not [1, 2, 3]
//
// Found as a real test262 regression: `built-ins/Iterator/concat/many-arguments`
// compares `Iterator.concat(...iterables)` against `[].concat(...iterables)`.
// Both were wrong in the same direction, so the test passed by coincidence;
// once #5361 fixed the Iterator side, the coincidence broke and the file
// flipped pass -> fail.
//
// Every assertion pins BOTH the resulting length and a join with a NON-comma
// separator — a default `,` join hides the nesting, since the inner arrays
// stringify to the same text.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProject, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const LIB_SOURCE = `
export function concatSpreadArrayLiterals() {
  const parts = [[], [1], [2, 3], [4, 5, 6]];
  return [].concat(...parts);
}

export function concatSpreadHostArrays(a, b) {
  const parts = [a.split(":"), b.split(":")];
  return [].concat(...parts);
}

export function concatMixedSpread(tail) {
  const parts = [tail.split(":")];
  return [].concat(["a"], ...parts, ["z"]);
}

export function concatNoSpreadControl() {
  return [].concat([1], [2, 3]);
}
`;

const ENTRY_SOURCE = `
import {
  concatSpreadArrayLiterals,
  concatSpreadHostArrays,
  concatMixedSpread,
  concatNoSpreadControl,
} from "./lib.js";

export function literalJoin() { return concatSpreadArrayLiterals().join("|"); }
export function literalLength() { return concatSpreadArrayLiterals().length; }
export function hostJoin() { return concatSpreadHostArrays("a:b", "c:d").join("|"); }
export function hostLength() { return concatSpreadHostArrays("a:b", "c:d").length; }
export function mixedJoin() { return concatMixedSpread("m:n").join("|"); }
export function mixedLength() { return concatMixedSpread("m:n").length; }
export function controlJoin() { return concatNoSpreadControl().join("|"); }
export function controlLength() { return concatNoSpreadControl().length; }

// The test262 shape: the spread-concat result is compared element by element
// against an independently-built list, so a missing flatten level is a hard
// value mismatch rather than a formatting difference.
export function iteratorConcatParity() {
  const iterables = [[], [1], [2, 3], [4, 5, 6]];
  const flattened = [].concat(...iterables);
  let out = "";
  for (let i = 0; i < flattened.length; i++) {
    out = out + (i === 0 ? "" : "|") + flattened[i];
  }
  return out;
}
`;

let dir: string;
let exports: Record<string, () => unknown>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "js2-issue-6411-"));
  writeFileSync(join(dir, "lib.js"), LIB_SOURCE);
  const entry = join(dir, "entry.js");
  writeFileSync(entry, ENTRY_SOURCE);

  const result: CompileResult = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
  });
  expect(
    result.success,
    `compile failed:\n${(result.errors ?? []).map((e) => `${e.severity}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const instance = await instantiateWithRuntime(result);
  exports = instance.exports as unknown as Record<string, () => unknown>;
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("#6411 — the host Array bridges expand spread arguments", () => {
  it("flattens a spread of inline array literals", () => {
    expect(exports.literalLength!()).toBe(6);
    expect(String(exports.literalJoin!())).toBe("1|2|3|4|5|6");
  });

  it("flattens a spread of host (externref) arrays", () => {
    expect(exports.hostLength!()).toBe(4);
    expect(String(exports.hostJoin!())).toBe("a|b|c|d");
  });

  it("interleaves positional arguments and a spread in argument order", () => {
    expect(exports.mixedLength!()).toBe(4);
    expect(String(exports.mixedJoin!())).toBe("a|m|n|z");
  });

  it("keeps the no-spread control exact", () => {
    expect(exports.controlLength!()).toBe(3);
    expect(String(exports.controlJoin!())).toBe("1|2|3");
  });

  it("matches element by element (the test262 many-arguments shape)", () => {
    expect(String(exports.iteratorConcatParity!())).toBe("1|2|3|4|5|6");
  });
});
