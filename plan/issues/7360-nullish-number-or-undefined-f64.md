---
id: 7360
title: "`x ?? 7` with `x: number | undefined` returns NaN for `undefined` on the ordinary pipeline"
status: done
sprint: current
created: 2026-11-17
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7359, 7354]
---

# #7360 — `??` on a `number | undefined` f64 never sees `undefined`

## Problem

A wrong answer on the ordinary pipeline, default (gc) and `--target standalone` alike, found while checking the
siblings of #7359:

```ts
function f(x: number | undefined): number { return x ?? 7; }
export function main(): number { return f(undefined); } // node 7; we return NaN
```

Measured on `claude/7354-logical-unused` (`main` returning `f(undefined) + f(2) * 100`, node 207):

| shape | gc | standalone |
| --- | --- | --- |
| `return x ?? 7` | NaN | NaN |
| `return x ?? seven()` (a call on the right, with a counter) | NaN | NaN |
| `const y = x; return y ?? 7` (stored in a local first) | 207 (correct) | 207 (correct) |
| `function f(x?: number)` … `return x ?? 7` | 207 (correct) | 207 (correct) |

## Cause (as read, not yet traced to the line)

`f` compiles on the legacy (non-IR) path to `local.get 0; local.tee 1; return` — the `??` test is gone. The
parameter `number | undefined` is an `f64`, and `undefined` arrives as the f64 undefined sentinel (the NaN payload
`UNDEF_F64_BITS`; `main` passes the bits `0x7FF00000DEADC0DE`); the `??` lowering sees an `f64` operand, treats it as a number
that can never be nullish and folds to the left operand, so the sentinel leaks out as NaN. A local copy and the
optional-parameter form take a path that does test the sentinel.

## IR paths

Not affected: the ordinary pipeline's IR selector does not claim `f` (legacy compiles it), and the Prepared path
refuses all four shapes by name (`ir/from-ast: unsupported type in Phase 1 (f)`, or `rest/default/optional param
not in Phase 1 IR scope (f)` for `x?: number`).

## Acceptance criteria

- The four shapes answer like node on both targets; a parameter, a local and a property of type
  `number | undefined` under `??`, `??=` and `?.`-adjacent forms are swept.
- No change for a plain `number` operand of `??` (its bytes stay identical).

## Implementation Plan (2026-11-19)

Legacy codegen only (no `src/ir/` change; the IR paths refuse these shapes, see above).

- **Owner of the fact.** `src/codegen/value-tags.ts` already owns the f64 `undefined` representation
  (`UNDEF_F64_BITS`, `pushUndefF64`, `emitIsUndefF64`). Add one predicate there, `f64MayHoldUndefined(ctx, expr,
  type)`: the Wasm type is f64 and either carries the `undefSentinel` brand or `ctx.oracle.nullabilityOf(expr)` says
  the static type admits `undefined`.
- **Three nullish tests ask it, none adds its own test:** `compileNullishCoalescing` (`??`,
  `expressions/logical-ops.ts`) and both `??=` arms of `expressions/operator-assignment.ts` (the variable arm and
  `emitLogicalAssignmentPattern`, which now takes its target expression, as every caller already had it). Each
  emits `emitIsUndefF64` instead of folding an f64 to "never nullish". The bits compare is exact, so a genuine `NaN`
  stays a number. `===`/`==` (`binary-ops.ts`) and `typeof` already tested the sentinel and are unchanged.
- **Duplicate removed.** `??` and the variable `??=` arm each spelled out the same reference nullish test
  (`ref.is_null` or `__extern_is_undefined`); it is now one helper, `emitRefIsNullish` in `logical-ops.ts`, used by
  both (same bytes). The property `??=` arm tests `__extern_is_undefined` only for `externref` and stays as it is.
- **Quality criterion.** One predicate, one emitter, reused at all three sites; no second sentinel test. A plain
  `number` operand keeps the old short-circuit, so its bytes stay identical.
- **#7361** (typeof from the operand's source type, IR `from-ast.ts`) has no fact on this path to reuse: its
  `isValueVoid`/void-leaf split is an IR lowering detail, and legacy `typeof` over `number | undefined` already
  answers correctly (swept below).

## Result (2026-11-19, base `origin/main` ee3fcdd610)

Before → after, both targets (node in brackets):

| shape | before | after |
| --- | --- | --- |
| param `x ?? 7` (207) | NaN | 207 |
| param `x ?? s()` with counter (10207) | NaN | 10207 |
| param `x ??= 7` (207) | NaN | 207 |
| optional property `o.a ?? 7` (207) | NaN | 207 |
| `a: number \| undefined` property `?? 7` (207) | NaN | 207 |
| optional property / class field `??=` (207) | — | 207 |
| genuine `NaN` under `??`, `??=`, optional param | NaN (correct) | NaN (correct) |

Already correct and kept: local copy, optional parameter, `number | null`, `number | null | undefined`, `o?.a ?? 7`,
default parameter, `=== undefined`, `== null`, `typeof`, plain `number` under `??`.
`tests/issue-7360-nullish-f64-undefined.test.ts`: 20 programs × gc/standalone, compared with node's answers.

Byte identity: 100 test262 files (coalesce + logical-assignment + Array.prototype.map + `for`), gc and standalone,
binary sha1 identical before/after (200/200).

Nearby tests (`coalesce-operator`, `ir-nullish-coalesce`, `issue-4616/5197/5357/5366/7106`,
`logical-assignment{,-property}`): 44 failures, the identical set on the base, so not caused by this change.

### Left open (separate owner)

An **uninitialised module global** `let g: number | undefined;` starts as `f64.const 0`
(`module-global-registration.ts`), so `g === undefined` and `g ?? 7` read `0`. The nullish tests are right; the
slot's initial value is wrong. A Wasm global initializer must be a constant expression, so the fix is either an
exact-bits `f64.const` of `UNDEF_F64_BITS` or a module-init store; not taken here. Needs its own issue id
(allocation was not available to this lane).
