// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

// #6939 — `for (var i …)` head re-declaration re-typed a BOXED ref-cell slot.
//
// Direct-eval reification (eval-visible bindings live in `__direct_eval_cell_*`
// cells) and closure capture boxing re-aim `localMap[i]` at a ref-cell local
// before the loop compiles. The for-head arm then promoted `i` to an i32
// counter and re-typed the CELL local to i32, so every cell-typed use
// (`local.tee cell`, `struct.new … cell`) became invalid Wasm — Octane
// earley-boyer `sc_jsNew`. Fix: the head stores through the live cell (the
// variables.ts #3396 `boxedForInitStore` idiom) and never re-types / promotes it.

type Lane = "gc" | "standalone";

async function run(src: string, lane: Lane): Promise<unknown> {
  const r = await compile(src, {
    fileName: "repro.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    validate: false,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary); // the defect was a validation failure
  if (lane === "standalone") {
    const inst = await WebAssembly.instantiate(mod, {});
    return (inst.exports as { run: () => unknown }).run();
  }
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as { run: () => unknown }).run();
}

// The two minimized triage repros, unchanged.
const EB7 = `function f(c) {
    for (var i = 0; i < 1; i++) {}
    return eval("c");
}
export function run() { return f(1); }
`;
const EB8 = `function f(c) {
    var g = function () { return i; };
    for (var i = 0; i < 1; i++) {}
    return g() + c;
}
export function run() { return f(1); }
`;

const CASES: [string, string, unknown, Lane?][] = [
  ["eb7: direct eval + for-head var", EB7, 1],
  ["eb8: closure captures the for-head var", EB8, 2],
  [
    "eval reads the counter after the loop",
    `function f() { for (var i = 0; i < 3; i++) {} return eval("i"); }
     export function run() { return f(); }`,
    3,
  ],
  [
    "closure sees every iteration's write through the shared cell",
    `function f() {
       var g = function () { return i; };
       var s = 0;
       for (var i = 2; i < 5; i++) { s = s * 10 + g(); }
       return s * 10 + g();
     }
     export function run() { return f(); }`,
    2345,
  ],
  [
    // standalone: valid since #6939 (was INVALID), but the boxed-string
    // `.length` read derefs null on the plain `var s = …` path too — separate
    // pre-existing defect, so the value is checked on gc only.
    "boxed string-valued head with a multi-declarator list",
    `function f() {
       var g = function () { return s; };
       for (var s = "a", n = 0; s.length < 3; s += "b", n++) {}
       return g() + n;
     }
     export function run() { return f(); }`,
    "abb2",
    "gc",
  ],
  [
    "negative control: let head (fresh per-iteration binding) unchanged",
    `function f() { var s = 0; for (let i = 0; i < 4; i++) { s += i; } return s; }
     export function run() { return f(); }`,
    6,
  ],
  [
    "negative control: unboxed var counter keeps the fast path",
    `function f() { var s = 0; for (var i = 0; i < 4; i++) { s += i; } return s + i; }
     export function run() { return f(); }`,
    10,
  ],
];

describe("#6939 for-head var over a boxed cell slot", () => {
  it("[standalone] boxed string-valued head compiles to valid Wasm", async () => {
    const r = await compile(
      `function f() { var g = function () { return s; }; for (var s = "a"; s.length < 3; s += "b") {} return g(); }
       export function run() { return f(); }`,
      { fileName: "repro.js", allowJs: true, skipSemanticDiagnostics: true, validate: false, target: "standalone" },
    );
    expect(r.success).toBe(true);
    await expect(WebAssembly.compile(r.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  });

  for (const lane of ["gc", "standalone"] as const) {
    for (const [name, src, expected, only] of CASES) {
      if (only && only !== lane) continue;
      it(`[${lane}] ${name}`, async () => {
        expect(await run(src, lane)).toBe(expected);
      });
    }
  }
});
