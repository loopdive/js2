---
id: 6966
title: "standalone: `numericFunctions` verdict is settled against the PRE-groundedness property set — a method returning an opaque-param-written field (`return this.v2`) gets an f64 twin and unboxes the object to NaN (Octane deltablue `BinaryConstraint.prototype.input`)"
status: ready
sprint: current
created: 2026-10-11
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: constructor-functions, type-inference
goal: standalone-gap
related: [874, 3683, 3753, 4406, 4122, 6951]
---

# `numericFunctions` is not re-settled after the groundedness filter shrinks `numericProperties`

Found by the Octane standalone triage (Session D, 2026-10-11). deltablue fails with
`Cannot access property on null or undefined at 506:29` (`Strength.weaker`) because
`BinaryConstraint.prototype.input()` — `return (this.direction == 1) ? this.v1 : this.v2` —
returns `NaN` (a number) instead of the `Variable` object.

## Minimized (`.tmp/db8.js`, node `object:b`, standalone `number:undefined`)

```js
function Variable(name) { this.name = name; }
function BC(var2) { this.v2 = var2; }
BC.prototype.input = function () { return this.v2; };
export function main() {
  var e = new BC(new Variable("b"));
  var ihn = e.input();
  return typeof ihn + ":" + ihn.name;
}
```

The conditional is irrelevant (`.tmp/db1..db5`); a direct `e.v2` read is fine (`.tmp/db7`). The
`BC.prototype.input` twin is minted as `(param (ref null $__fnctor_BC)) (result f64)`
(`$__closure_21__typed_this` in `.tmp/db8.js.wat`): it `struct.get`s the `externref` field `v2`
and UNBOXES it to f64 (`i31.get_s` / `__unbox_number`), and the call site types `ihn` as `f64`.

## Root cause

`src/codegen/numeric-property-analysis.ts` `analyzeNumericPropertyNames`:

1. The greatest-fixpoint loop (lines ~1424-1461) shrinks three sets together: `numericFunctions`
   (every function named `m` returns numeric), `numericSlots`, `numericProperties`. For `v2` the
   only write is `this.v2 = var2` — an **opaque param read**, which `writeAcceptable` accepts — so
   `v2` stays in `numericProperties` throughout the loop, and `input` (whose only return is
   `this.v2`, judged via `sets.numericProperties.has("v2")` in `makeProver.isNumeric`) stays in
   `numericFunctions`.
2. The **groundedness** pass (lines ~1468-1484) then removes `v2` (no write is provably numeric
   with self-reads excluded) — but runs AFTER the loop and never re-evaluates `numericFunctions`
   or `numericSlots`. `numericFunctions` is published (`publishNumericFunctions`, ~1601) with
   `input` still in it.
3. `refinedTwinReturnType` (`src/codegen/typed-this.ts:1095-1131`) reads
   `ctx.numericFunctionNames.has("input")` → `{kind:"f64"}` twin result; the twin body coerces the
   externref field to f64 (NaN for an object), and every direct twin call (`tryEmitDirectTwinCall`)
   types the result f64.

Verified with `JS2WASM_NUMERIC_FIELDS_DEBUG=1 JS2WASM_NUMERIC_FIELDS_EXPLAIN=v2`: `v2: rejected
(opaque-param var2)` while `input` is still published numeric. The fnctor FIELD typer already uses
the post-groundedness set (field `v2` is `externref` in `$__fnctor_BC`), so the two consumers
disagree — a split brain inside one analysis.

## Implementation Plan

**File: `src/codegen/numeric-property-analysis.ts`, `analyzeNumericPropertyNames`**

1. Move the groundedness + `anyBoolean` filter INTO the `while (changed …)` fixpoint as a fourth
   shrink step after the `numericProperties` loop (lines ~1454-1460): for each name still in
   `numericProperties`, compute `grounded` (`prover.withoutSelf(name, …writes.some(forcedNumeric
   || isNumeric(value)))`) and `anyBoolean` (`host.excludeNames?.has(name) || writes.some(
   isBooleanish(value))`); on `!grounded || anyBoolean` → `numericProperties.delete(name);
   changed = true`. Both predicates are monotone in the three sets (they only consult
   `isNumeric`/`isBooleanish`, which only shrink as sets shrink), so the loop still terminates
   (bump `safety` by `numericProperties.size` once more to be explicit) and the final
   `numericProperties` is a SUBSET of today's. The post-loop pass (1468-1484) becomes redundant;
   delete it or keep as an assertion-only no-op.
2. No change to `typed-this.ts` — once `input` leaves `numericFunctions` the twin keeps the
   declared `externref` result and the direct call types `ihn` externref.
3. The simulated patch (exactly step 1, in-loop copy of the filter) is in
   `/home/user/js2/.claude/worktrees/agent-af047ca9deb401f6e/.tmp/patched-numeric-property-analysis.ts`
   (diff against `.tmp/base/numeric-property-analysis.ts`).

### Measured with the simulated fix
- `.tmp/db8.js` → `object:b`; `.tmp/db42.js` → `object:a>b` (node-identical).
- `node --import tsx .tmp/octane-sa.mjs deltablue --script --no-eval` → `standalone run -> 1`,
  teardown ok (compile 5.8 s).
- Pin suites `tests/issue-3683-numeric-fields.test.ts`, `issue-3765-numeric-locals`,
  `issue-4406-ret-unbox-abi`, `issue-6627-reflect-namespace-numeric-inference`: 50 pass; the one
  failure (`a promoted slot still marshals through the reflection arms`, expects 11, gets 31) is
  **pre-existing on the base** (A/B-verified with the base file) — a stale pin, not this change.
  Update that pin to 31 in the same PR or file it separately.

### Edge cases
- A property with ≥1 provably numeric write plus opaque-param writes stays numeric (grounded) —
  unchanged.
- A function returning a mix of a grounded numeric field and a now-withdrawn one correctly leaves
  `numericFunctions`; callers that relied on the f64 twin lose a fast path only.
- Perf: fewer promotions are possible on acorn/lodash lanes; re-measure `benchmarks/cross-engine`
  and the Octane richards/crypto standalone scores (the integration branch's harness run) — report
  deltas, do not gate.

### Acceptance
- `tests/issue-<id>.test.ts`: standalone (and gc) vs node for `.tmp/db8.js` (`object:b`) and
  `.tmp/db42.js` (`object:a>b`); a control where the field IS grounded (`this.v2 = var2;
  this.v2 = 3` elsewhere) keeps an f64 twin (assert via `emitWatOnlyFunctions` that the twin's
  result is f64).
- `pnpm run -s benchmark:octane -- --only deltablue --lanes node,standalone --timeout 600` —
  standalone row must no longer be an error row. NOTE: with this fix the row becomes `skipped:
  timeout after 180s (run, reps 736)` — standalone deltablue is correct but ~2500× slower than
  node (10 reps ≈ 2 s vs node 0.7 ms); that is a separate perf issue, see the triage report.
- Size: **S**.
