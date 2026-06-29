---
id: 2854
title: "Wasm validation: ref.is_null on f64 when a doubly-nested (if-in-for) numeric block-let is captured by a closure (TDZ flag mis-typed)"
status: ready
created: 2026-06-30
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 2015
language_feature: closures
goal: spec-completeness
sprint: Backlog
horizon: m
related: [2818, 1672, 1177, 1128]
architect_spec: candidate
---

# #2854 — `ref.is_null` on an f64 captured local (doubly-nested numeric block-`let` TDZ)

Discovered while fixing #2818. **Distinct, pre-existing bug** (reproduces on
`main` independent of #2818's deferral fix, and with a plain arrow — no class).

## Reproduction (host/gc lane)

```ts
// Arrow capture — no class needed:
export function test(): number {
  let acc = 0;
  for (let i = 0; i < 3; i++) {
    if (i >= 0) { let bump = 10; const g = () => bump; acc += g(); }
  }
  return acc;
}
// => CompileError: WebAssembly.instantiate(): Compiling function "test" failed:
//    ref.is_null[0] expected reference type, found local.get of type f64
```

The class-method variant fails identically:

```ts
export function test(): number {
  let acc = 0;
  for (let i = 0; i < 3; i++) {
    if (i >= 0) { let bump = 10; class C { m(): number { return bump; } } acc += new C().m(); }
  }
  return acc;
}
```

## What is and isn't required to trigger

- **Required:** (a) a **numeric** (`f64`) block-scoped `let`, (b) **doubly
  nested** in `if`-inside-`for` (single nesting does NOT trigger — see controls),
  (c) **captured** by a closure (arrow or class method — the capture is what
  applies the TDZ/box machinery).
- **Controls that PASS** (validate + correct value):
  - `if`-only numeric block-let captured → `10`.
  - `for`-only numeric block-let captured → `30`.
  - doubly-nested numeric block-let **not** captured (`acc += bump`) → `30`.
  - string (`externref`) doubly-nested captured → fine (the `ref.is_null` is
    well-typed for a ref).

## Root cause (hypothesis — needs confirmation)

The capture path promotes/boxes the block-`let` and, for a doubly-nested block,
assigns it a **TDZ flag** (`__tdz_<name>` / boxed ref-cell, #1177/#1128). The
TDZ "is-initialised" guard emits `ref.is_null` — correct for an `externref`
value, but for an **f64** local the guard is emitted against the **f64 value
local itself** instead of an `i32`/ref TDZ flag, producing
`ref.is_null[0] expected reference type, found local.get of type f64`.

The fix likely lives in the same TDZ-flag promotion/guard code touched by #1177
(`boxedTdzFlags`) and `promoteAccessorCapturesToGlobals`
(`src/codegen/closures.ts:426-448`) — ensure the TDZ guard is emitted against
the (i32) TDZ flag, never the numeric value, and that the f64 box/cell path
carries a separate init-flag.

## Acceptance

- Both repros above compile, validate, and return `30`.
- The capture controls (string, single-nest, uncaptured) keep working.
- 0 test262 regressions; the closure/TDZ suites (#1128, #1177, #1672, #2623)
  stay green.

## Pointers

- `src/codegen/closures.ts:426-448` — `__tdz_<name>` global promotion + boxed
  TDZ flag (`boxedTdzFlags`).
- TDZ guard emission (`ref.is_null` on the init flag) — locate the site that
  reads the flag for a numeric capture.
- Probe (gitignored, on the #2818 branch): `.tmp/probe-2818/noclass.mjs`,
  `.tmp/probe-2818/iso.mjs`.
