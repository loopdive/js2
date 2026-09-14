---
id: 6485
title: "standalone: `new (registryLookup(key))(…)` evaluates to null and never evaluates its arguments — a CALL-expression callee matches no dynamic-`new` arm"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s20-lane
created: 2026-09-14
loc-budget-allow:
  # 2026-09-14 (S20) — the host-free dynamic-`new` arm for a CALL-expression
  #   callee (`new (ce("%Temporal.Duration%"))(…)`, the intrinsic-registry
  #   spelling the Temporal polyfill uses at three sites including the string
  #   branch of `Duration.from`). The growth is two doc blocks plus ~8 lines of
  #   code: a narrow `resolvesToDynamicCallCtorValue` predicate beside the
  #   existing member-callee one, one extra `||` clause at the dispatch, and one
  #   optional parameter threaded into `emitDynamicNewFallback` that pins the
  #   no-match base to the PRE-EXISTING `ref.null.extern` for this arm only.
  #   Most of the added lines are the rationale for that last part: it is what
  #   keeps a non-constructor callee behaving exactly as it did before, and it
  #   is what keeps the arm's code size off every site in a 3.3 MB provider that
  #   links into every consumer compile. A reader who "simplifies" it away
  #   changes both the semantics of a bad callee and the byte size of the
  #   hottest artifact in the standalone lane.
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  # 2026-09-14 (S20) — same change, function-level: `compileNewExpression` gains
  #   the one-line arm + its comment, `emitDynamicNewFallback` gains the pinned
  #   no-match base branch. Both are documented at the site because the reason
  #   is not visible from the code.
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
---

# #6485 — `new (<call>)(…)` in a host-free module: a silent null, with the arguments never evaluated

Child of [#5383](5383-standalone-temporal-provider.md) (S20), following
[#6484](6484-standalone-class-static-dynamic-dispatch.md) (S19).

## Summary

S19 ended at the polyfill's intrinsic registry: provider-internal, one module,
no link, `new (ce("%Temporal.Duration%"))(1).toJSON()` throws
*invalid receiver: method called with the wrong type of this-object* while
`new Duration(1).toJSON()` answers `P1Y`.

S20's hand-off read that as an instance failing its own class's brand check and
named the likely mechanisms (prototype identity, a WeakMap keyed on the struct
vs a boxed carrier, `fnctor-constructor-identity.ts`). **All of that is wrong,
and the brand check is the symptom, not the defect: no instance is created at
all.** `new` on a value that came out of a call evaluates to **null**, and — the
part no reading of the symptom would predict — **its arguments are never
evaluated either**.

## Reduction — 16 probes, one standalone module, no polyfill, no link

`.tmp/s20/c6.mjs`, run through `.tmp/s20/single.mjs` (one compiled module per
probe, `target: "standalone"`, `hostBridge: "off"`). The prelude is the
registry shape the polyfill actually has — a bare `{}` whose values are `any`:

```js
class C { constructor(a) { this.tag = "T" + a; } }
class D { constructor(a, b) { this.tag = "D" + a + b; } }
const ie = {};
function se(k, v) { ie["%" + k + "%"] = v; }
function ce(k) { return ie[k]; }
se("C", C); se("D", D);
```

| probe | base | S20 |
| --- | --- | --- |
| `new (ce("%C%"))(1).tag` | `undefined` | **`T1`** |
| `new (ce("%D%"))(1, 2).tag` | `undefined` | **`D12`** |
| arg order — `new (ce("%D%"))(mark("a"), mark("b"))` | `/undefined` (no effects) | **`ab/Dab`** |
| literal spread / named-const spread | `undefined` | **`D12`** |
| zero args | `undefined` | **`Tundefined`** |
| nested `new` | `undefined` | **`TT1`** |
| in a loop, 3 iterations | `undefinedundefinedundefined` | **`T0T1T2`** |
| method-call callee — `new (({g: ce}).g("%C%"))(1)` | `undefined` | **`T1`** |
| **arg side effect runs** | **`""`** | **`z`** |
| callee side effect once | `""` | **`k`** |
| 10 args (Duration's real arity) | `undefined` | **`D12`** |
| null callee (control) | `undefined` | `undefined` |
| number callee (control) | `undefined` | `undefined` |
| plain-function callee (control) | `undefined` | `undefined` |
| missing key (control) | `undefined` | `undefined` |

The four controls are unchanged **by design** — see the `plainNullNoMatchBase`
note below. Base and branch both measured on this tree by file-copy revert
(`.tmp/s20/c6-base.out` vs `c6-inst.out`).

## Root cause

`compileNewExpression` (`src/codegen/expressions/new-super.ts`) reaches the
dynamic-`new` dispatch for two callee shapes: a bare **identifier** that is not
a known class, and — JS-host lane only — a **member access** for which
`resolvesToDynamicAnyCtorValue` says the value is dynamic (#4616). A
**call-expression** callee matches neither. It therefore fell all the way
through to the `__new___unknown` host import, which does not exist in any lane
and cannot exist in standalone, so the emitted body was a bare
`ref.null.extern`.

Two consequences, and the second is the one that makes the failure look like a
brand-check bug: the `new` evaluates to null, and because the legacy arm returns
**before** the argument loop, the argument expressions are dropped on the floor.
Downstream, the polyfill calls a prototype method on that null and its
internal-slot lookup reports the wrong-receiver message.

## The fix

A third clause on the same dispatch, **host-free lane only**, for a
call-expression callee whose static result is genuinely dynamic
(`any` / `unknown` / `Function`). The tag dispatch below it is callee-shape
agnostic — it compiles the callee once into an anyref descriptor and `ref.test`s
it — so a call callee needs no new machinery.

`plainNullNoMatchBase` pins this arm's no-match outcome to the pre-existing
`ref.null.extern` rather than the standalone TypedArray-construct base used by
the identifier arm. Both reasons are in the code; the load-bearing one is size:
a value from an intrinsic registry is never a `$__ta_ctor`, and inlining the TA
construct plus its `IsConstructor` guard at every one of these sites is not free
in a 3.3 MB provider that links into every consumer compile.

## Acceptance

- The reduction above moves, in one standalone module with no polyfill.
- `tests/issue-6485-standalone-dynamic-new-call-callee.test.ts` — a
  single-module witness whose base was measured failing.
- 0 legitimate `pass→fail` across the three-family Temporal sample; 0
  `__temporal_*` leaks; must-not-move samples flat.
