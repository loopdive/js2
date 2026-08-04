// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4133 — two modules declaring the same top-level function name must each keep
// their own body.
//
// `ctx.funcMap` is keyed by the BARE name. Registration already minted a
// distinct Wasm slot per declaration (the emitted module really did carry two
// `$shared` functions), but the name→index map kept only the last, and
// `compileDeclarations` installed every body by the same last-wins name scan. So
// one body was emitted twice and the other slot was left empty — while the
// compile reported `success: true` with ZERO errors.
//
// These rungs therefore assert VALUES, not compile success: the defect's whole
// signature is that it compiles cleanly and computes the wrong answer.
//
// WHICH RUNG ACTUALLY PINS THE DEFECT: only "keeps bodies with very different
// local counts apart". Measured against the unfixed base, the other three PASS
// there — a small `shared` is INLINED at its call site, so each caller gets the
// right code regardless of which slot `funcMap` names. The collision is only
// observable once a body is too large to inline. The small-function rungs are
// kept as guards (and the no-collision rung as a did-not-change-anything-else
// check), but they are not evidence on their own, and a future edit that makes
// only them pass has not fixed anything.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

/** Instantiate, backfilling imports the convenience object omits. */
async function run(files: Record<string, string>, entry: string): Promise<Record<string, unknown>> {
  const result = await compileMulti(files, entry, { target: "gc" });
  expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  const imports = { ...(result.importObject as Record<string, Record<string, unknown>>) };
  for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(result.binary))) {
    const mod = (imports[imp.module] ??= {});
    if (mod[imp.name] !== undefined) continue;
    if (imp.kind === "function") mod[imp.name] = () => undefined;
    else if (imp.kind === "global") mod[imp.name] = new WebAssembly.Global({ value: "externref" }, undefined);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return instance.exports as Record<string, unknown>;
}

describe("#4133 — same-named top-level functions in different modules", () => {
  it("each module calls ITS OWN function, not whichever registered last", async () => {
    const exports = await run(
      {
        "./a.ts": `export function shared(x: number): number { return x + 100; }
export function callA(x: number): number { return shared(x); }`,
        "./b.ts": `export function shared(x: number): number { return x * 2; }
export function callB(x: number): number { return shared(x); }`,
        "./main.ts": `import { callA } from "./a.js";
import { callB } from "./b.js";
export function run(x: number): number { return callA(x) + callB(x); }`,
      },
      "./main.ts",
    );
    // node: callA(3) = 103, callB(3) = 6 -> 109. Before the fix: 6 + 6 = 12.
    expect((exports.run as (x: number) => number)(3)).toBe(109);
  });

  it("keeps bodies with very different local counts apart", async () => {
    // The local-frame mismatch is the shape that corrupted binary emit on a
    // large graph ("local index out of range — 65 (valid: [0, 8))"): a body
    // compiled for a 40-local frame installed into an 8-local slot.
    const wide =
      Array.from({ length: 40 }, (_, i) => `  const v${i} = x + ${i};`).join("\n") +
      `\n  return ${Array.from({ length: 40 }, (_, i) => `v${i}`).join(" + ")};`;
    const exports = await run(
      {
        "./a.ts": `export function shared(x: number): number {\n${wide}\n}
export function callA(x: number): number { return shared(x); }`,
        "./b.ts": `export function shared(x: number): number { return x * 2; }
export function callB(x: number): number { return shared(x); }`,
        "./main.ts": `import { callA } from "./a.js";
import { callB } from "./b.js";
export function run(x: number): number { return callA(x) + callB(x); }`,
      },
      "./main.ts",
    );
    // a.shared(3) = 40*3 + (0+..+39) = 120 + 780 = 900; b.shared(3) = 6 -> 906.
    expect((exports.run as (x: number) => number)(3)).toBe(906);
  });

  it("handles three modules sharing one name", async () => {
    const exports = await run(
      {
        "./a.ts": `export function pick(): number { return 1; }
export function fromA(): number { return pick(); }`,
        "./b.ts": `export function pick(): number { return 20; }
export function fromB(): number { return pick(); }`,
        "./c.ts": `export function pick(): number { return 300; }
export function fromC(): number { return pick(); }`,
        "./main.ts": `import { fromA } from "./a.js";
import { fromB } from "./b.js";
import { fromC } from "./c.js";
export function run(): number { return fromA() + fromB() + fromC(); }`,
      },
      "./main.ts",
    );
    // Each digit position is a different module — any cross-talk is legible.
    expect((exports.run as () => number)()).toBe(321);
  });

  it("leaves a graph with no colliding names unaffected", async () => {
    // The rebinding is gated on the collision set, so a clean graph must be
    // untouched. This is the "did the fix change anything it shouldn't" rung.
    const exports = await run(
      {
        "./a.ts": `export function alpha(x: number): number { return x + 1; }`,
        "./b.ts": `export function beta(x: number): number { return x * 3; }`,
        "./main.ts": `import { alpha } from "./a.js";
import { beta } from "./b.js";
export function run(x: number): number { return alpha(x) + beta(x); }`,
      },
      "./main.ts",
    );
    expect((exports.run as (x: number) => number)(4)).toBe(17);
  });
});

describe("#4133 — same-named functions taken as VALUES (closure trampolines)", () => {
  it("gives each module's function its own trampoline and cache", async () => {
    // `ensureFuncClosureSingleton` keyed `__fn_tramp_<name>_cached` and the
    // closure-cache global by the BARE name, and its reuse path validated the
    // existing trampoline's shape but never that it targeted the same function.
    // So the second module's closure value called the FIRST module's function —
    // and once both units were genuinely reachable, two unit-anchored ABI
    // binding ids claimed one trampoline object and planning aborted with
    // "allocator locator … is already owned by". That is the exact error the
    // ESLint graph hit (eslint-visitor-keys 3.4.3 and 5.0.1 both ship `getKeys`).
    const exports = await run(
      {
        "./a.ts": `export function pick(x: number): number { return x + 100; }
export function useA(): number { const f: (n: number) => number = pick; return f(3); }`,
        "./b.ts": `export function pick(x: number): number { return x * 2; }
export function useB(): number { const f: (n: number) => number = pick; return f(3); }`,
        "./main.ts": `import { useA } from "./a.js";
import { useB } from "./b.js";
export function run(): number { return useA() * 1000 + useB(); }`,
      },
      "./main.ts",
    );
    // node: useA() = 103, useB() = 6 -> 103006. The two halves are placed in
    // different digit ranges so any cross-talk is legible rather than a
    // coincidentally-equal sum.
    expect((exports.run as () => number)()).toBe(103006);
  });
});
