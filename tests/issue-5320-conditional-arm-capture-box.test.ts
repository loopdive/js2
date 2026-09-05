// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5320 — a mutable capture's ref cell is minted at the CLOSURE CONSTRUCTION
// SITE while the binding's name is re-aimed at that cell for the whole
// FUNCTION. When the construction site sits in one arm of an `if`, every path
// that skips the arm addresses a cell that was never created: the access sites
// null-guard it, but read the guard as "the value is absent", so a write
// silently no-ops and a read yields the value type's default.
//
//     function f(c) { let r; if (c) { const g = () => { r = 2; }; g(); }
//                            else { r = 7; } return r; }
//     f(false)   // native 7, wasm null
//
// The emitted WAT says it outright — the else-arm's `r = 7` becomes
// `local.get $box / ref.is_null / (if (then <EMPTY>) (else … struct.set))`.
//
// The fix is not another entry in `canBoxBindingInDominatingParent`'s
// allow-list. That mechanism moves the `struct.new` to a dominating point, and
// can only do so when it can prove the binding already holds its correct value
// there AND that nothing already emitted in the region writes the raw slot.
// Neither proof is available for an uninitialized `let` or for a sibling arm
// that assigns first — which is why both shapes below were wrong regardless of
// initializer, arm order, or value type. `closures/conditional-capture-box.ts`
// instead completes the null guard: a null cell means the cell was never
// minted, so the binding's storage is still the pre-box slot, and the cell is
// seeded from it on first use.
//
// The fixtures are plain untyped `.js`, matching how the upstream npm suites
// feed package code in. Annotating `: any` routes the capture to a different
// arm of the analysis, and the test then passes identically with and without
// the fix — so a typed fixture proves nothing here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const ENTRY = `import { run } from "./mod.js";\nexport function test(): string { return String((run as unknown as () => unknown)()); }`;

async function runModule(moduleSource: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "js2-5320-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return String((instance.exports as Record<string, () => unknown>).test());
}

/** [name, module source, expected]. Cases marked (was ✗) failed before #5320. */
const cases: Array<[string, string, string]> = [
  // ── the reported repro and its family ───────────────────────────────────────
  [
    "uninitialized let, closure arm first (was ✗: null)",
    `function f(c) { let r; if (c) { const g = () => { r = 2; }; g(); } else { r = 7; } return r; }
export function run() { return [f(false), f(true)].join(","); }`,
    "7,2",
  ],
  [
    "arm-swapped, `= 0` initializer does NOT rescue it (was ✗: NaN)",
    `function f(c) { let r = 0; if (!c) { r = 7; } else { const g = () => { r = 2; }; g(); } return r; }
export function run() { return [f(false), f(true)].join(","); }`,
    "7,2",
  ],
  [
    "arm-swapped object capture (was ✗: null)",
    `function f(c) { let r = null; if (!c) { r = { k: 7 }; } else { const g = () => { r = { k: 2 }; }; g(); } return r.k; }
export function run() { return [f(false), f(true)].join(","); }`,
    "7,2",
  ],
  [
    "arm-swapped f64 capture (was ✗: NaN)",
    `function f(c) { let n = 1; if (!c) { n = n + 6; } else { const g = () => { n = n + 1; }; g(); } return n; }
export function run() { return [f(false), f(true)].join(","); }`,
    "7,2",
  ],
  [
    "arm-swapped string capture through += (was ✗)",
    `function f(c) { let s = "a"; if (!c) { s += "b"; } else { const g = () => { s += "z"; }; g(); } return s; }
export function run() { return [f(false), f(true)].join(","); }`,
    "ab,az",
  ],
  [
    "switch arms (was ✗)",
    `function f(c) { let r = 1; switch (c) { case 0: r = 7; break; case 1: { const g = () => { r = 2; }; g(); break; } default: r = 9; } return r; }
export function run() { return [f(0), f(1), f(2)].join(","); }`,
    "7,2,9",
  ],
  [
    "same binding name in two frames stays frame-local (was ✗)",
    `function a(c) { let r = 1; if (c) { const g = () => { r = 2; }; g(); } else { r = 7; } return r; }
function b(c) { let r = 100; if (!c) { r = 700; } else { const g = () => { r = 200; }; g(); } return r; }
export function run() { return [a(false), a(true), b(false), b(true)].join(","); }`,
    "7,2,700,200",
  ],

  // ── controls that already worked; they must keep working ───────────────────
  [
    "control: closure arm FIRST with an initializer (the eager dominating box)",
    `function f(c) { let r = 0; if (c) { const g = () => { r = 2; }; g(); } else { r = 7; } return r; }
export function run() { return [f(false), f(true)].join(","); }`,
    "7,2",
  ],
  [
    "control: classic counter closure",
    `function mk() { let n = 0; return { inc() { n = n + 1; return n; } }; }
export function run() { const c = mk(); c.inc(); c.inc(); return c.inc(); }`,
    "3",
  ],
  [
    "control: per-iteration `let` closures still capture distinct values",
    `function f() { const out = []; for (let i = 0; i < 3; i++) { out.push(() => i); } return out.map((g) => g()).join(""); }
export function run() { return f(); }`,
    "012",
  ],

  // ── shapes that must converge on ONE cell ──────────────────────────────────
  [
    "two conditional construction sites share one cell",
    `function f(a, b) { let r = 1; if (a) { const g = () => { r = 2; }; g(); } if (b) { const h = () => { r = r + 10; }; h(); } return r; }
export function run() { return [f(false,false), f(true,false), f(false,true), f(true,true)].join(","); }`,
    "1,2,11,12",
  ],
  [
    "closure capturing two bindings, only one arm constructs it",
    `function f(c) { let a = 1, b = 2; if (c) { const g = () => { a = a + b; }; g(); } else { a = 7; b = 8; } return a + "," + b; }
export function run() { return [f(false), f(true)].join("|"); }`,
    "7,8|3,2",
  ],
  [
    "deferred closure invoked after both arms",
    `function f(c) { let r = 1; let g = null; if (c) { g = () => { r = r + 5; }; } else { r = 7; } if (g) g(); return r; }
export function run() { return [f(false), f(true)].join(","); }`,
    "7,6",
  ],
  [
    "closure returned from a conditional arm, called by the caller",
    `function f(c) { let r = 1; if (c) { return () => { r = r + 1; return r; }; } r = 7; return () => r; }
export function run() { return [f(false)(), f(true)()].join(","); }`,
    "7,2",
  ],

  // ── every access shape the frame can use on the rebound name ───────────────
  [
    "compound assignment in the non-closure arm",
    `function f(c) { let r = 1; if (c) { const g = () => { r = 2; }; g(); } else { r += 6; } return r; }
export function run() { return [f(false), f(true)].join(","); }`,
    "7,2",
  ],
  [
    "postfix update after the conditional",
    `function f(c) { let r = 5; if (c) { const g = () => { r = r * 2; }; g(); } r++; return r; }
export function run() { return [f(false), f(true)].join(","); }`,
    "6,11",
  ],
  [
    "prefix decrement after the conditional",
    `function f(c) { let r = 5; if (c) { const g = () => { r = r * 2; }; g(); } --r; return r; }
export function run() { return [f(false), f(true)].join(","); }`,
    "4,9",
  ],
  [
    "captured parameter, conditional closure",
    `function f(c, r) { if (c) { const g = () => { r = 2; }; g(); } else { r = r + 6; } return r; }
export function run() { return [f(false, 1), f(true, 1)].join(","); }`,
    "7,2",
  ],

  // ── other block kinds a path can skip ──────────────────────────────────────
  [
    "try/catch arms",
    `function f(c) { let r = 1; try { if (c) throw new Error("x"); const g = () => { r = 2; }; g(); } catch (e) { r = 7; } return r; }
export function run() { return [f(false), f(true)].join(","); }`,
    "2,7",
  ],
  [
    "nested conditionals",
    `function f(a, b) { let r = 1; if (a) { if (b) { const g = () => { r = 2; }; g(); } else { r = 3; } } else { r = 7; } return r; }
export function run() { return [f(false,false), f(true,false), f(true,true)].join(","); }`,
    "7,3,2",
  ],
  [
    "loop body constructs the closure on one iteration only",
    `function f(n) { let r = 0; for (let i = 0; i < n; i++) { if (i === 1) { const g = () => { r = r + 100; }; g(); } else { r = r + 1; } } return r; }
export function run() { return [f(0), f(1), f(3)].join(","); }`,
    "0,1,102",
  ],
  [
    "short-circuit and ternary arms",
    `function f(c) { let r = 1; c && (() => { r = 2; })(); if (!c) r = 7; return r; }
function g(c) { let r = 1; const t = c ? (() => { r = 2; return "y"; })() : ((r = 7), "n"); return t + r; }
export function run() { return [f(false), f(true), g(false), g(true)].join(","); }`,
    "7,2,n7,y2",
  ],
  [
    "closure in a block-scoped arm mutating an outer let",
    `function f(c) { let r = 1; { if (c) { const g = () => { r = 2; }; g(); } else { r = 7; } } return r; }
export function run() { return [f(false), f(true)].join(","); }`,
    "7,2",
  ],
];

describe("#5320 — capture cell minted in a conditional arm", () => {
  for (const [name, source, expected] of cases) {
    it(name, async () => {
      expect(await runModule(source)).toBe(expected);
    });
  }
});
