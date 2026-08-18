---
id: 4438
title: "`new <runtime-eval callable>` evaluates to null in standalone — §10.2.2 [[Construct]] through a `Function(src)` value"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: medium
horizon: m
feasibility: hard
model: opus
reasoning_effort: max
task_type: defect
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2660, 2916, 2928, 3468, 4172, 4196, 4242, 4307, 4308]
blocked_by: []
assignee: ttraenkler/claude-es5-standalone
# (#4438) The wiring is three call sites (two imports + a fill hook + one retry
# line + the prototype-seed line); ALL of the logic lives in the new subsystem
# module `src/codegen/runtime-eval-construct.ts`, which is what the
# consolidation plan asks for. The +20 lines below are the unavoidable cost of
# reaching that module from the three places that own the emission points.
loc-budget-allow:
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #4438 — `new <runtime-eval callable>` evaluated to **null**

Measured during #2660 M3 and recorded there as a blocker with a different
owner: "`new <Function(src) value>` evaluates to **null** (measured directly:
`typeof` is `"object"`, the value is `null`)".

## Before-state, measured on this branch's base (`origin/main` f5e2fa6)

`--target standalone`, QuickJS provider linked (`.tmp/p1.mts`, `.tmp/p2.mts` —
each probe is a test262-shaped file run through `runTest262File`):

| probe | base | branch |
| --- | --- | --- |
| `var F = Function("this.prop=1;"); typeof new F()` is `"object"` **and not null** | **FAIL** (null) | **PASS** |
| `(new F()).prop === 1` | **FAIL** (TypeError on null) | **PASS** |
| `typeof F.prototype === "object"` | **FAIL** (`undefined`) | **PASS** |
| `F.prototype.name = "fairy"; F.prototype.name` | **FAIL** (`undefined`) | **PASS** |
| `F.prototype = {q:5}; var i = new F(); i.q` | **FAIL** (null) | **PASS** |
| `Object.getPrototypeOf(new F()) === F.prototype` | FAIL (null) | **PASS** |
| `F.prototype.name="fairy"; (new F()).name` | FAIL (null) | **PASS** |
| `(new F()).constructor === F` | FAIL (null) | **PASS** |
| `typeof F === "function"` | PASS | PASS (unchanged) |
| `F()` returns its value | PASS | PASS (unchanged) |
| `var o={}; F.call(o); o.prop` | PASS | PASS (unchanged) |

Two independent defects, not one. The second was not in the dispatch and was
found by measuring the before-state rather than inheriting #2660 M3's note,
which had verified only the post-WRITE half of `F.prototype`:

1. **`new F()` had no lowering** — it reached the terminal dynamic-`new`
   fallthrough and emitted `ref.null.extern`.
2. **`F.prototype` read `undefined`** — a runtime-eval callable had no
   prototype object at all, so even a correct construct path had nothing to
   build an instance from.

## Root cause

### Why `new` produced null

`Function(src)` lowers through `emitStandaloneDynamicFunctionRuntime`
(`eval-inline.ts`) to the provider import `__runtime_new_function`, and the
result is wrapped in the #4307 AOT-callable **carrier**. At a `new` site the
callee is an `any`/`Function`-typed binding, so it lands in `new-super.ts`'s
`resolvesToDynamicAnyCtorValue` arm — the `$__ta_ctor` runtime kind-switch —
which yields `ref.null.extern` for a value that is not a TypedArray
constructor. #4196 added a bound-function retry on that null; nothing handled a
runtime-eval carrier, so it kept the null.

### Why `F.prototype` was `undefined`

Structural, in the provider. `qjsPublish` exposes a QuickJS function as the
branded `$RuntimeEvalInterpretedCallback` marker whose `target` is an **empty
`$Object`** created only to carry the box row — and that row is registered
`qjsPushBoxRow(retained, carrierTarget, exposed, 0)`, mirror flag **0**,
deliberately unmirrored. QuickJS's real `.prototype` therefore never crosses
the seam, and the caller-side property-get trampoline
(`__runtime_eval_get_aot_property`) has arms for `name` / `length` /
`constructor` only, falling through to a raw `__extern_get` on a foreign
nominal struct that answers nothing.

## Can the seam express construction? YES — verified, not assumed

The `js2wasm:runtime-eval` ABI has exactly four entries
(`__runtime_direct_eval`, `__runtime_indirect_eval`, `__runtime_new_function`,
`__runtime_apply_interpreted`) and **no construct entry**. It does not need
one. The fourth takes a `thisArg`, and the #4245 inward membrane makes a
compiled `$Object` receiver writable from inside evaluated code. Probed on the
BASE, before any code was written:

```js
var F = Function("this.prop=1; return 9;");
var o = {}; F.call(o);     // → 9, and o.prop === 1   ✓ PASSES on base
```

So §10.2.2 decomposes into operations that already work:
`OrdinaryCreateFromConstructor` (caller-side `__object_create`) + an ordinary
`[[Call]]` with the fresh object as receiver + the step-13 result rule. **No
ABI extension, no provider change, no QuickJS artifact rebuild.** The
analysis-only stop the dispatch allowed for was therefore not taken.

## The fix

New subsystem module `src/codegen/runtime-eval-construct.ts`; three wiring
sites. The module header carries the full rationale — the load-bearing parts:

### 1. The prototype is minted at the `Function(...)` site, not in the trampoline

§20.2.1.1 always creates an ordinary **constructable** function with a fresh
`prototype` whose `constructor` is the function, so seeding it at
`emitStandaloneDynamicFunctionRuntime` is spec-mandated rather than a guess —
and that site knows it from the SOURCE.

The obvious alternative — vivify `prototype` inside the shared carrier
property-get trampoline on a key miss — was designed and **rejected**. That
trampoline also serves carriers wrapping arrows, prototype methods and AOT
declarations. An arrow must NOT have a `prototype` (§15.3), and an AOT
declaration already has one (its fnctor global), so a trampoline-side vivify
would both invent a property that must not exist and mint a SECOND, rival
prototype object for one that does — the exact split-brain #2660 M3 spent its
lap removing. Telling the cases apart at runtime needs an `IsConstructor` bit
on the cross-module marker struct, i.e. an ABI widening. Minting at the
source-known site costs nothing and is exactly as narrow.

The store is the carrier's own #3468 property **bag** — the same table
`F.zz = 7` and `F.prototype = {…}` already round-trip through (both verified
PASSING on base). It is written with `__defineProperty_value`, not
`__extern_set`, so the attributes are the spec's: `prototype` is
`{writable:true, enumerable:false, configurable:false}` (§20.2.3.2) and
`constructor` is `{writable:true, enumerable:false, configurable:true}`
(§10.2.5). **Enumerability is load-bearing, not decoration** — a bag entry
written by assignment is enumerable, and `for (var k in F)` would then report
`prototype`, which `13.2-15-s` enumerates over.

### 2. The driver — `__construct_runtime_eval`, mirroring #4196's `__construct_bound`

```
__construct_runtime_eval(callee, args) -> externref
  if callee is not a BRANDED runtime-eval carrier: return null
  proto = __extern_get(callee, "prototype")        ;; §10.2.2 step 3
  if proto is not an Object:                 return null
  self   = __object_create(proto)
  result = __apply_closure(callee, self, args)     ;; [[Call]] with this=self
  return IsObject(result) ? result : self          ;; §10.2.2 step 13
```

**The `proto is not an Object → null` clause is the safety property of the
whole change, not an oversight.** It is what stops the driver turning a carrier
around an arrow — or any callable that legitimately has no `prototype` — into a
silently-wrong constructed object: such a value reads `undefined` there and
keeps the site's pre-#4438 null, byte-for-byte the same observable outcome as
today. Only a callable that ACTUALLY has a prototype object constructs, which
after the seeding above is precisely the `Function(src)` population (plus any
carrier the user explicitly assigned a `prototype` to, where constructing is
also correct).

Two traps inherited verbatim from #4196, both re-checked here: the null test in
the step-13 probe is **separate and first** (`__typeof_object(null)` is 1 by
design, so folding them would return null from `new` and reinstate this very
bug); and the fill **declines** unless a `__call_fn_method_<N>` receiver
dispatcher exists, because without one `__apply_closure` returns its undefined
sentinel and the driver would hand back an EMPTY instance — worse than the null.

### 3. Reserve-then-fill + byte-neutrality gate

The driver calls `__apply_closure` (filled at finalize) and needs
`ctx.runtimeEvalAotCallableCarrier` (a `new` site can compile before any
carrier is minted), so the site reserves an `unreachable` stub and
`fillRuntimeEvalConstructDriver` supplies the body at finalize — degrading to
`ref.null.extern`, never a trap, when the module minted no carrier. The retry
is emitted only in a file that syntactically mentions `eval` or `Function`
(memoized AST walk, same discipline and the same synthesized-node guard as
`nodeCanMintBoundFn`), so every other module is untouched.

## Measured after-state

### test262, `--target standalone`, QuickJS engine — the attribution matrix

`language/expressions/instanceof`, all 43 files, `runTest262File`. Four
configurations, each a full rebuild (compiler bundle + runtime bundle + QuickJS
adapter) from `.tmp/base/` ↔ `.tmp/new/` file copies:

| configuration | dir | `S15.3.5.3_A2_T5` | `S15.3.5.3_A3_T1` |
| --- | ---: | --- | --- |
| base (`origin/main` f5e2fa6) | 24/43 | fail | fail |
| base **+ #4438 (this change)** | 24/43 | fail | fail |
| base **+ #4538's M3 instanceof arm alone** | 26/43 | fail | fail |
| base **+ #4538 + #4438** | **28/43** | **pass** | **pass** |

**Neither change alone flips either target file; together they flip both.**
That is the honest headline and it is stated first deliberately: measured in
isolation, this change moves **zero** test262 rows in the two directories the
dispatch named. It supplies the half #2660 M3's own write-up identified as its
blocker ("`new <runtime-eval callable>` → null, plus `FACTORY.prototype.type =
1` needs a vivified prototype on a value with no compile-time global"); #4538
supplies the other half (the `else` arm in `native-dynamic-instanceof.ts` that
lets a non-`$Object` callable carrier reach the own-`prototype` read).

The third row is a **counterfactual run**, not an inference: #4538's arm was
reproduced locally on the base, measured, and reverted (`.tmp/base/
native-dynamic-instanceof.ts`). `native-dynamic-instanceof.ts` is **not touched
by this branch** — that file is #4538's live scope and duplicating it would
merge-conflict.

### Zero regressions

Both named directories are **line-for-line identical** between base and branch
(`diff` of the per-file status sweeps; the only differing line is the runner's
adapter-key banner):

| directory | base | branch |
| --- | ---: | ---: |
| `language/expressions/instanceof` (43) | 24 | 24 |
| `language/statements/function` `13.2-*` (33) | 23 | 23 |

The ten still-failing `13.2-*` files were read: `13.2-5-s`, `13.2-6-s`,
`13.2-13-s`, `13.2-14-s`, `13.2-17-*`, `13.2-18-*` are the **strict-poison**
family (`foo.caller` / `foo.arguments` must throw TypeError) — a different
defect with a different owner, not construction.

### Suites

`issue-1164-es5-eval-slice` + `es5-standalone-instanceof`: **49 passed**.
`issue-2928` · `issue-4307-closure-carrier-wrap` · `issue-4196` ·
`issue-3981-standalone-construct-function-value` · `issue-3468-closure-own-props`
· `fn-constructor` · `new-function-noop` · `es5-standalone-this-and-construct`:
green. `tests/new-non-constructor.test.ts` fails IDENTICALLY on base — a broken
import path (`Cannot find module '../../src/index.js'`), pre-existing on main
and unrelated. New: `tests/issue-4438-runtime-eval-construct.test.ts` (5 cases,
3 of them refusal pins that must hold in both directions).

`tests/issue-2660-m3-closure-prototype-edge.test.ts` — named in the dispatch —
does not exist on this base; it arrives with #4538.

## The one place the fix is INCOMPLETE, found by probing past the target files

Making construction work at all exposed a second question the null was hiding:
**which prototype objects the instance can actually inherit through.** Measured
(`.tmp/p4.mts`, `.tmp/p5.mts`, `.tmp/p6.mts`):

| how `F.prototype` got its value | `(new F()).k` |
| --- | --- |
| the #4438 seeded object, written via `F.prototype.k = v` | **5** ✓ |
| `F.prototype = {}` then `F.prototype.k = v` | **5** ✓ |
| `F.prototype = { k: v }` (literal WITH inline properties) | `undefined` ✗ |
| `var p = { k: v }; F.prototype = p` | `undefined` ✗ |

The first hypothesis — "an object literal with inline properties is a closed
typed struct the dynamic `$proto` walk cannot read" — was **tested and is
WRONG**. With no eval anywhere, `var p = {q:5}; var k = "q"; p[k]`,
`Object.create(p)[k]` and `G.prototype = {q:5}; (new G()).q` on an AOT fnctor
all answer **5**. So the literal is readable dynamically AND usable as an
`Object.create` prototype; what fails is specifically that object arriving at
`__object_create` through the CARRIER BAG round-trip. The mechanism is not
identified and is deliberately not guessed at here.

**This is not a regression, and the direction is worth naming:** on base every
one of those four programs produced `null` and a hard null-access TypeError on
the read. Two of the four now work; the other two answer `undefined` instead of
throwing — quieter, but strictly closer to spec than a null `new`.

## Residuals, with owners

- **`instance instanceof FACTORY` / the `F.prototype = void 0` TypeError** —
  needs #4538 (#2660 M3). Measured above; not this branch's file.
- **The `13.2-*` strict-poison family** (`foo.caller` / `foo.arguments` must
  throw) — unrelated defect, unowned here.
- **Caller-side and QuickJS-side `F.prototype` are DIFFERENT objects.** Inside
  evaluated code `F.prototype` is QuickJS's own; the compiled side sees the
  seeded one. The caller-side view is self-consistent (identity, inherited
  reads, `getPrototypeOf`, `constructor` all hold), which is what the ES5
  population exercises, but a program that sets `F.prototype.x` from compiled
  code and reads it from inside a later `eval` will not see it. Closing that
  means publishing QuickJS's real prototype as a mirrored box, which trades the
  split for a carrier-vs-marker identity break on `instance.constructor === F`
  — strictly worse for this population. Owner: the runtime-eval seam (#4245).
- **Only the bare-identifier dynamic-`new` site is wired.**
  `new (Function("…"))()` and `new obj.f()` reach different dispatch arms and
  keep their existing behaviour.
- **`hasOwnProperty(F, "prototype")`** answered `false` on base; it is `true` on
  the branch as a side effect of the bag write (re-measured, not assumed).
  Correct, and noted because #2660 M3's write-up cited the post-write behaviour
  of this same probe.
- **The bag-round-tripped prototype object** above — inherited reads miss when
  `F.prototype` is REPLACED by an object that already carries properties. Owner:
  unassigned; it is a `$proto`-linkage question (#4172 / #2660 territory), not a
  construct-lowering one, and the driver is doing exactly what
  `__construct_bound` (#4196) does at the same step.

## Gates

`typecheck` green. `check:loc-budget` / `check:func-budget` require the
allowances granted in this file's frontmatter — three wiring files, +20 lines
total, all of the logic in the new subsystem module. `check:oracle-ratchet`: the
new module asks no type questions at all (zero raw-checker queries).

## Files

- `src/codegen/runtime-eval-construct.ts` (new)
- `src/codegen/expressions/eval-inline.ts` — §20.2.1.1 prototype seed
- `src/codegen/expressions/new-super.ts` — the null retry, chained after #4196's
- `src/codegen/index.ts` — two fill hooks (single-module + multi-module finalize)
- `tests/issue-4438-runtime-eval-construct.test.ts` (new)
