// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7473 — a default in an array destructuring ASSIGNMENT (`[n = 5] = []`) must fire when the element reads as
// `undefined`. A tuple literal pads a missing or `undefined` number element with the f64 `undefined` marker, and the
// assignment path never tested for it, so `n` took the marker (NaN). A nested pattern with a default
// (`[[n = 5] = []] = []`) was skipped outright. The object forms and the declaration were already right; they are
// pinned as guards. Each row runs on the ordinary pipeline (legacy codegen) on both targets; node answers.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const COUNTER = "var c = 0; function d() { c += 1; return 5; }";

// [shape, declarations, body of `g()`]. Each body returns a number.
const ROWS: readonly (readonly [string, string, string])[] = [
  ["missing element", "", "var n; [n = 5] = []; return n;"],
  ["present element", "", "var n; [n = 5] = [7]; return n;"],
  ["undefined element", "", "var n; [n = 5] = [undefined]; return n;"],
  ["NaN element is present", "", "var n; [n = 5] = [NaN]; return isNaN(n) ? 1 : 0;"],
  ["let target", "", "let n; [n = 5] = []; return n;"],
  ["two elements, one missing", "", "var a, b; [a = 1, b = 2] = [9]; return a * 10 + b;"],
  ["script var target", "var gv;", "[gv = 5] = []; return gv;"],
  ["member target", "", "var o = {}; [o.x = 5] = []; return o.x;"],
  ["member target, present", "", "var o = {}; [o.x = 5] = [3]; return o.x;"],
  ["nested array pattern with a default", "", "var n; [[n = 5] = []] = []; return n;"],
  ["nested array pattern, default supplies the value", "", "var n; [[n = 5] = [7]] = []; return n;"],
  ["nested array pattern, element present", "", "var n; [[n = 5] = [7]] = [[8]]; return n;"],
  ["nested object pattern with a default", "", "var n; [{ n = 5 } = {}] = []; return n;"],
  ["nested object pattern, default supplies the value", "", "var n; [{ n } = { n: 6 }] = []; return n;"],
  ["nested object pattern, element present", "", "var n; [{ n = 5 } = {}] = [{ n: 4 }]; return n;"],
  ["default inside a nested array pattern", "", "var n; [[n = 5]] = [[]]; return n;"],
  ["undefined inside a nested array pattern", "", "var n; [[n = 5]] = [[undefined]]; return n;"],
  // The default runs exactly once when the element is absent, and not at all when it is present.
  ["default runs once when missing", COUNTER, "var n; [n = d()] = []; return n * 10 + c;"],
  ["default runs once when undefined", COUNTER, "var n; [n = d()] = [undefined]; return n * 10 + c;"],
  ["default does not run when present", COUNTER, "var n; [n = d()] = [7]; return n * 10 + c;"],
  ["nested default runs once", COUNTER, "var n; [[n = d()] = []] = []; return n * 10 + c;"],
  [
    "source evaluated once",
    "var c = 0; function s() { c += 1; return []; }",
    "var n; [n = 5] = s(); return n * 10 + c;",
  ],
  // Guards: correct before the fix.
  ["object pattern assignment", "", "var n; ({ n = 5 } = {}); return n;"],
  ["object pattern assignment, let", "", "let n; ({ n = 5 } = {}); return n;"],
  ["object pattern declaration", "", "var { n = 5 } = {}; return n;"],
  ["array pattern declaration", "", "var [n = 5] = []; return n;"],
];

const nodeAnswer = (declarations: string, body: string): unknown =>
  new Function(`${declarations}\nfunction g() { ${body} }\nreturn g();`)();

async function runOrdinary(declarations: string, body: string, target: "gc" | "standalone"): Promise<unknown> {
  const result = await compile(`${declarations}\nexport function g() { ${body} }`, {
    fileName: "test.js",
    allowJs: true,
    ...(target === "standalone" ? { target } : {}),
  });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : built;
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  built.setInstance?.(instance);
  return (instance.exports.g as () => unknown)();
}

describe.each(["gc", "standalone"] as const)("#7473 — default in an array destructuring assignment (%s)", (target) => {
  it.each(ROWS)("%s", async (_, declarations, body) => {
    expect(await runOrdinary(declarations, body, target)).toBe(nodeAnswer(declarations, body));
  });
});
