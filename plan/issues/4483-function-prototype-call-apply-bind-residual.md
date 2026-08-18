---
id: 4483
title: "ES5 standalone: built-ins/Function residual — call/apply arg semantics, bind carrier surface, __get_builtin CE (~30 tractable of 58 rows)"
status: done
completed: 2026-08-16
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-methods
goal: standalone-gap
loc-budget-allow:
  # Both entries are CONSUMED by the shipped diff (`npm run check:loc-budget`
  # names each one and its delta); no entry is speculative.
  #   expressions/calls.ts  +32  three arms in the ONE `.call`/`.apply` /
  #                              call-expression dispatcher: the Function-ctor
  #                              reshape, the §20.2.3.1 argArray guard and the
  #                              §10.2.1 class-call guard. Each arm's BODY
  #                              lives in its own new module
  #                              (function-ctor-reflective-call.ts,
  #                              apply-arglist-typeerror.ts,
  #                              class-call-without-new.ts); what stays here is
  #                              the dispatch line plus the comment that says
  #                              why it sits at that exact position, which is
  #                              order-sensitive and cannot move out.
  #   property-access.ts    +10  one dispatch site for the primitive
  #                              absent-property arm, placed LAST before the
  #                              legacy tail so no existing arm loses its claim.
  - src/codegen/expressions/calls.ts
  - src/codegen/property-access.ts
func-budget-allow:
  # compileCallExpression +29: the three dispatch lines above, in the function
  # that IS the call dispatcher — a new call-shape decision has nowhere else to
  # be made, and the arms it calls are already extracted.
  # inlineUserFunctions +31, 296 → 327 (crosses 300): the caller-poison
  # strictness guard must sit inside the per-call-site admission loop, next to
  # the other `declined(...)` reasons, because it is one more admission rule;
  # hoisting it out would need the loop's callee/caller pair passed to a helper
  # for a two-line comparison. The bulk of the +31 is the comment that records
  # the measurement and why the guard is free when no `.caller` is read.
  # (Both deltas here are quoted from `npm run check:func-budget` as run on the
  # shipped diff, which prints each granted entry and its measured delta.)
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/ir-inline.ts::inlineUserFunctions
related: [4442, 4437, 4440, 4480, 4157, 1472]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. built-ins/Function = 58 ES≤5 standalone failures after the #4442 wave (+19); signatures split into apply/call TypeErrors (8), bind-carrier reads (4), null-length (3), __get_builtin CE (3), tail."
---

# #4483 — built-ins/Function residual families

## Problem

After #4442's `%Function%` carrier (+19), `built-ins/Function` still holds 58
ES≤5 standalone failures. Measured signatures:

- **A — apply/call argument semantics (8 rows)**: "Expected a TypeError" —
  §15.3.4.3/4 require TypeError when `argArray` is neither object nor
  array-like, and when the callee is not callable; also `arguments`-object
  pass-through rows.
- **B — bound-function surface (4 rows)**: `typeof obj.touched` — bind's
  carrier loses own-property writes / target surface.
- **C — `.length` of null (3 rows)**: `cannot read property 'length' of
  null` — a Function.prototype method value read answers null then dies
  (identity family; overlaps #4481 — coordinate, do not double-fix).
- **D — `__get_builtin` CE (3 rows)**: dynamic-shape object/property on a
  builtin — compile error where a decline was possible.
- **E — tail** (`this["feat"]` rows, constructor.length): assorted.

`fn.prototype`-dependent rows belong to #4480, not here.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`);
   produce the per-family file list first.
2. Family A: the call/apply lowering (grep `"apply"`/`"call"` arms in
   `src/codegen/expressions/calls.ts`) — add the §15.3.4.3 step-2/3 guards
   with real TypeError instances (`buildThrowJsErrorInstrs`). Arity/spread
   semantics for `arguments` receivers exist in the #4436 work — read
   `function-expected-argument-count.ts` first.
3. Family D first among the rest (CE class beats wrong-answer class): find
   the `__get_builtin` emission site, make the unsupported shape DECLINE to
   a runtime miss instead of a compile error.
4. Family B: read the bind lowering; bound carriers are closures — the
   #4437 metadata pattern may carry the target/own-props surface.
5. Family C: coordinate with #4481 (identity singletons) — if #4481 lands
   first, C may already be fixed; re-measure before touching.
6. Controls: fn-family pins (4436/4437/4440/4442/4456/4460/4464); scoped
   sweep `built-ins/Function` before/after; byte-identity on modules not
   using apply/call/bind.

## Acceptance criteria

- ≥15 rows flip in `built-ins/Function`; zero regressions; families not
  taken recorded with owners.

## Re-verification (the issue's map vs. what is actually there)

The family map above was written off the lagging baseline. Re-measured live on
this branch's base with `runTest262File(…, "standalone")` over ALL 509 `.js`
files under `built-ins/Function` (3-way sharded, one process per shard):

| state | pass | fail | compile_error |
| ----- | ---- | ---- | ------------- |
| base  | 363  | 132  | 14            |

This base row was independently re-measured after the session that wrote it was
killed — same three numbers, on a base that had since advanced past the
#4479/#4480 wave. See `## Sweep`.

Three corrections that changed what was worth doing:

1. **Family D is 9 rows, not 3** — every `__get_builtin` CE in the directory is
   the SAME shape, `Function.call(thisArg, body)` (8 files) plus `JSON.bind()`
   (1). The other 5 CEs are a different refusal (#3371 `Reflect.construct`
   NewTarget, #1907 builtin static value read).
2. **Family C is not an identity bug and does not overlap #4481.** The three
   "cannot read property 'length' of null" rows are
   `Function("a1,a2,a3", …).call(null, arguments, "", 2)` — the `arguments`
   OBJECT arriving as null across the runtime-eval provider boundary. #4481's
   instance-proto singletons are unrelated; nothing here was double-fixed.
3. **Family B's `typeof obj.touched` rows are not bind at all.** They are
   §15.3.4.3 A5 (`ToObject(thisArg)` for a PRIMITIVE thisArg), and the actual
   defect is one level down and much wider than `bind`: an absent property of a
   `number`/`boolean` primitive answered `null` instead of `undefined`
   (`typeof null === "object"` is what the assertions see). The real
   bind-carrier gap (`.length`/`.name`) is measured and left as a residual.

Two of the four eval-tier families additionally required the local quickjs
provider artifact; without it 9 rows fail with a "provider is not built"
infrastructure error that is NOT a conformance signal. It is linked from
`.test262-cache/` — worth knowing before reading any local sweep.

## Root cause

Five independent defects, one per family. Each was measured on this branch's
base by the driver, not inherited from an artifact.

**R1 — `Function.call/apply` was a dynamic builtin member read.**
`Function` is a builtin VALUE, so `Function.call` went to the generic member
path → `env::__get_builtin` → the #1472 Phase A standalone COMPILE ERROR. The
identical program spelled `Function("…")` compiles and runs. Nothing about the
shape needs a host: §15.3.1 says the constructor's [[Call]] discards `this`, so
`Function.call(x, …args)` IS `Function(…args)`.

**R2 — absent property of a number/boolean primitive answered `null`.**
`(1).touched` fell through every arm to the legacy tail's `ref.null.extern`
placeholder. Measured, one module, six receivers
(`.tmp/probes/p6-missing-prop.js`): number `null`, boolean `null`, and string /
object / array / function all already `undefined`. So the hole was exactly the
two primitives with no string-like or object-like fast path of their own.

**R3 — the IR inliner merged activations of different strictness.**
The §15.3.5.4 caller marker is emitted per WASM FUNCTION body by
`finalizeFunctionPoisonPillCalls`, which runs *immediately after*
`inlineUserFunctions`. A strict callee inlined into a sloppy caller therefore
had its calls marked SLOPPY. Traced on `15.3.5.4_2-42gs`'s shape with the
pass's own debug view: `f` (strict) was registered and instrumented correctly
(`marker strict=true at call 2097226`) and then left DEAD, while the executed
copy — `__closure_42`, the sloppy `f1` — carried `marker strict=false at call
2097226`, i.e. the same callee handle, inlined. The sloppy self-`caller` read
then read 0 and did not throw.

**R4 — `Function.prototype.{call,apply,bind}` read as a VALUE was treated as
possibly-constructable.** `classifyNonConstructableValue` had an arm for
`f.call(x)` (a CALL, correctly only a "probe" — it returns an arbitrary value)
but none for `f.call` (the READ, which IS the intrinsic and has no
[[Construct]]).

**R5 — two missing spec throws.** `f.apply(thisArg, <primitive>)` skipped
§20.2.3.1 step 4 → CreateListFromArrayLike step 2; a `class` constructor called
without `new` skipped §10.2.1 [[Call]] step 2 and silently answered `null`.

## Fix

Four new modules + four dispatch sites; every arm DECLINES rather than guessing.

| file | what it does |
| ---- | ------------ |
| `src/codegen/function-ctor-reflective-call.ts` | R1 — AST reshape `Function.call/apply(thisArg, …)` → `Function(…)`, reusing the ORIGINAL `Function` identifier as the callee so downstream resolution sees what the source wrote. Declines for a user `Function` shadow and for a non-literal `.apply` argument list. |
| `src/codegen/primitive-absent-property.ts` | R2 — `undefined` for a provably-absent property of a `number`/`boolean` primitive. Declines for any wrapper-chain member, for a module that extends `Number`/`Boolean`/`Object.prototype`, and for write/delete targets. Dispatched LAST, immediately before the legacy tail, so no existing arm loses its claim. |
| `src/codegen/ir-inline.ts` (guard) | R3 — decline to inline across a strictness boundary, **only** when `ctx.callerStrictGlobalIdx >= 0` (i.e. some function really reads a legacy `caller`). A module that never observes `.caller` — every real program — keeps every inlining decision it had. |
| `src/codegen/expressions/non-constructable.ts` (arm) | R4 — the `.call`/`.apply`/`.bind` READ is `"provable"`, narrowed to a receiver the oracle types as `function` (or the `Function` builtin). |
| `src/codegen/apply-arglist-typeerror.ts` | R5a — §20.2.3.1 step 4 TypeError for a provably-primitive argArray, **and only when the RECEIVER is provably callable**. `null`/`undefined` deliberately do NOT throw (step 3). See the over-application note below — the receiver half is what makes this arm correct, not a refinement of it. |
| `src/codegen/class-call-without-new.ts` | R5b — §10.2.1 step 2 TypeError. Declines for ambient (`.d.ts`) classes, which is how the callable builtins (`Number(1)`, `String(x)`) are modelled — that exclusion is the whole correctness story. |

All type queries go through `ctx.oracle`; `npm run check:oracle-ratchet` reports
`getTypeAtLocation +0, ctx.checker +0` across the 9 changed files.

### One over-application found and fixed while verifying (R5a)

The first cut of the R5a arm keyed only on the METHOD NAME (`apply`) and the
argument's type. But `x.apply(…)` reaches that dispatch site for **any** `x`,
so a plain object owning its own `apply` member was claimed by it. Measured
here on the pre-guard tree with `.tmp/probes/p20-user-apply.mts`:

| tree | `({ apply: function (a, b) { return b + 1; } }).apply(null, 6)` |
| ---- | -------------------------------------------------------------- |
| base (five source files reverted) | `7` |
| snapshot, before the guard | **threw TypeError** (probe returned `-1`) |
| shipped (with `isCallableReceiver`) | `7` |

That is a wrong answer where base was right — the "a wrong answer in a fold is
worse than no fold" failure the campaign brief forbids — so `tryEmitApplyArgArrayTypeError`
now requires the oracle to type the receiver as `function` (or the `Function`
builtin) before it claims the shape, the same narrowing the neighbouring `bind`
lowering already applies. `tests/issue-4483.test.ts` pins it as an F5 negative
control. The whole-directory sweep below was run on the GUARDED tree; the
unguarded tree was never measured past this probe.

## Test Results

Every number below is from a run executed in this worktree; nothing is carried
over from the pre-kill snapshot, whose own sweep results did not survive.

| what | result |
| ---- | ------ |
| Scoped standalone sweep, `built-ins/Function`, 509 files, base vs shipped | **+15 flips, 0 regressions, net +15** — see `## Sweep` |
| `tests/issue-4483.test.ts` (default QuickJS provider) | 30 passed |
| `tests/issue-4483.test.ts` under `JS2WASM_EVAL_ENGINE=interpreter` (refusal provider, CI's changed-root tier) | 30 passed — so no tier arm is needed; every `Function(…)` in the pins has a constant body and is folded AOT |
| Fn-family control pins `tests/issue-{4436,4437,4440}.test.ts` | 56 passed |
| Fn-family control pins `tests/issue-{4442,4456,4460,4464}.test.ts` | 72 passed |
| `npm run typecheck` | clean |
| `check:loc-budget` / `check:func-budget` / `check:coercion-sites` / `check:dead-exports` / `check:oracle-ratchet` | all OK; the two LOC and two func entries granted here are each consumed and named by the gate output |

`tests/equivalence/` was NOT run: it cannot run in one vitest invocation in this
container, and the campaign brief scopes it to per-file loops over files the
diff plausibly touches. The fn-family pins above are the equivalent control for
this diff's surface.

## Sweep — `built-ins/Function`, standalone, 509 files

A/B run by this agent with `runTest262File(…, "standalone")`, 3 shards, one
process per shard (`.tmp/sweep.mts`). "base" is this branch's first parent with
the five modified source files reverted byte-for-byte from `HEAD^1`
(`git diff --stat HEAD^1 -- <the five>` empty at measurement time); "after" is
the shipped tree including the R5a receiver guard.

| state | pass | fail | compile_error |
| ----- | ---- | ---- | ------------- |
| base | 363 | 132 | 14 |
| after | **378** | 125 | 6 |

**+15 pass · 0 regressions · net +15** — meets the ≥15 acceptance bar exactly.

Flip list (all 15, base status → pass):

| file | was |
| ---- | --- |
| `S15.3_A2_T1` | compile_error |
| `S15.3_A2_T2` | compile_error |
| `S15.3_A3_T1` | compile_error |
| `S15.3_A3_T2` | compile_error |
| `15.3.5.4_2-20gs` | fail |
| `15.3.5.4_2-42gs` | fail |
| `15.3.5.4_2-45gs` | fail |
| `internals/Call/class-ctor` | fail |
| `prototype/apply/argarray-not-object` | fail |
| `prototype/apply/S15.3.4.3_A5_T1` | fail |
| `prototype/apply/S15.3.4.3_A5_T2` | fail |
| `prototype/apply/S15.3.4.3_A8_T5` | fail |
| `prototype/call/S15.3.4.4_A5_T1` | fail |
| `prototype/call/S15.3.4.4_A5_T2` | fail |
| `prototype/call/S15.3.4.4_A7_T5` | fail |

Four further rows moved `compile_error → fail` — `S15.3_A3_T3/T4/T5/T6`. They
are **not** regressions and not counted above: the R1 reshape removed their
`__get_builtin` refusal, so they now compile and run, and they stop on the
eval-provider global-binding residual already recorded below
(`f() returns undefined … SameValue(«null», «undefined»)`). They are the
clearest available evidence for that residual's owner.

Non-pass rows remaining after the fix: 131, by directory —
`prototype/toString` 39 · `built-ins/Function` (top level) 26 ·
`prototype/bind` 19 · `prototype/Symbol.hasInstance` 11 · `prototype/apply` 11 ·
`prototype/call` 10 · `prototype` 7 · `internals/Construct` 5 · three
single-row directories. Six compile errors remain, none of them the
`__get_builtin` shape this issue removed except one unrelated bind row
(`bind/15.3.4.5-2-7`, #1472 Phase B); four are the #3371 `Reflect.construct`
NewTarget refusal and one is the #1907 builtin-static-value read.

## Residuals — measured here, NOT fixed

| residual | rows | evidence | owner |
| -------- | ---- | -------- | ----- |
| Bound function has no `length` / `name` | **9** measured here: `bind/instance-length-{prop-desc,default-value,remaining-args,exceeds-int32,tointeger}`, `bind/instance-name{,-chained,-non-string,-error}` (of 19 non-pass rows under `prototype/bind`) | The two `it.fails` pins in `tests/issue-4483.test.ts` reproduce it directly and are green as `it.fails` in both engine tiers: `bar.bind(null).length` is not 2 and `bar.bind(null).name` is not `"bound bar"`. The carrier (`$__bound_fn`) has target/thisArg/boundArgs/bag and no metadata fields. | unclaimed — successor to #4483, family B |
| Eval-provider global bindings read wrong | **6, each confirmed in this sweep**: `S15.3_A3_T3/T4/T5/T6`, `S15.3.2.1_A1_T10`, `S15.3.2.1_A3_T15` | All six fail with the identical signature `f() returns undefined … SameValue(«null», «undefined»)` — a hoisted-but-unassigned global var reads `null` where it must read `undefined`. The four `S15.3_A3_T*` rows are the ones this issue moved `compile_error → fail`, so they are newly-visible instances rather than new breakage. (The pre-kill draft additionally attributed this to module binding LAYOUT on the strength of two probes, `p10-eval-undef` / `p11-eval-global`, whose files did not survive that session — that narrowing is NOT re-measured here and should be re-derived by whoever takes this.) | unclaimed — runtime-eval lane |
| `arguments` object arrives as null across the provider | `prototype/call/S15.3.4.4_A6_T5/T6/T9` (3, confirmed in this sweep) | "cannot read property 'length' of null" inside a `Function(…)` body handed `arguments` via `.call`. | unclaimed — runtime-eval lane |
| `Function(…)` product used as a mutable thisArg | `prototype/{apply,call}/S15.3.4.{3,4}_A5_T8` (2, confirmed in this sweep) | `obj = Function(); Function("this.touched=true").apply(obj)` leaves `obj.touched` unset — the provider's function object is not the same mutable object on both sides. | unclaimed — runtime-eval lane |
| `Function.prototype.toString` source text | `prototype/toString/*` — **39** non-pass measured in this sweep (11 of them Proxy), not the ~25 the pre-kill draft carried | "Conforms to NativeFunction Syntax" — the whole cluster is out of this issue's families and is by a wide margin the largest remaining one in the directory (39 of the 131 residual rows). | unclaimed — needs its own issue |
| Realm / Proxy `__module_init` null-deref | 14 rows (`*-realm.js`, `Symbol.hasInstance/*`) | `$262.createRealm` / revoked-proxy shapes. | unclaimed — not ES≤5 |
| `Function.call/apply` in a plain ES-MODULE lane | 0 (no test262 row) | In `export function test(){ var f = Function.call(…) }` the shape is claimed by an earlier eval-boundary arm and yields a non-function, so the F1 pins use the runner's own option set (`runRunnerLike`, which documents the seam). The pre-kill session recorded verifying this identical on base by reverting `calls.ts` alone; that specific A/B was not re-run here. What IS re-measured here is the stronger claim it was offered for — the full-directory sweep shows **0 regressions**, so nothing this change did moved a passing row in either lane. | unclaimed — runtime-eval lane |
