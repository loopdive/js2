---
id: 4619
title: "ES5 standalone: built-ins/Function residual v2 + wrapper-method value calls — Function.prototype.toString, apply/call TypeErrors, bind surface (~35 rows)"
status: done
completed: 2026-08-23
sprint: current
loc-budget-allow:
  # +38 lines total, all of it DISPATCH into the four new subsystem modules —
  # the bodies themselves live in `wrapper-proto-to-string.ts`,
  # `wrapper-proto-dynamic-demand.ts`, `native-proto-method-call.ts` and
  # `new-boolean-tobooleanarg.ts`, which is what #3102 asks for. Two rounds of
  # extraction already moved everything movable out of these four files: the
  # `.call` spelling override and the ToBoolean argument arm were both inline
  # first, and `new-builtin-globals.ts` crossed the god-file threshold until the
  # latter moved (it is no longer flagged).
  #   calls.ts +17               — one import + the 6-line spelling-override
  #                                dispatch, which must sit ABOVE the #4119
  #                                guard it feeds; that ordering is only
  #                                readable at the call site.
  #   call-receiver-method.ts +10 — one import + the demand hook at #1397's
  #                                hand-off, split from the dispatch condition
  #                                because the two gates differ (see the module).
  #   index.ts +7                — one import + the finalize call at the TWO
  #                                existing `unshiftExternGetProtoMethodArm`
  #                                sites, which it must follow.
  #   array-object-proto.ts +4   — one import + the `toString` arm in the
  #                                `makeGlue` ladder, beside its `valueOf` twin.
  #   new-builtin-globals.ts +3  — one import + the ToBooleanArg hand-off line
  #                                (the arm's BODY was extracted to
  #                                `new-boolean-tobooleanarg.ts`; this is the
  #                                residual dispatch). On the branch alone the
  #                                file stayed under the cap; the merged wave
  #                                crosses it by these 3 lines (CI run
  #                                32619219148 on PR #4781).
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/index.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/new-builtin-globals.ts
coercion-sites-allow:
  # These two modules IMPLEMENT spec coercion operations; they do not hand-roll
  # one at a call site, which is what the gate exists to stop.
  #   `wrapper-proto-to-string.ts` is §21.1.3.6 `Number.prototype.toString`
  #   itself, and it DELEGATES to the single native formatter
  #   (`number_toString` / `number_toString_radix`) plus `__unbox_number` rather
  #   than re-deriving a number→string matrix — that is the engine, reached by
  #   name.
  #   `new-boolean-tobooleanarg.ts` calls `__is_truthy` / `__to_boolean` — the
  #   SAME helper, chosen on the same `ctx.standalone` condition, that the
  #   FUNCTION spelling `Boolean(x)` already uses in
  #   `expressions/call-identifier.ts`. Sharing it is the whole fix: the defect
  #   was that `new Boolean(o)` coerced to f64 and answered `false` while
  #   `Boolean(o)` answered `true`, i.e. two ToBoolean answers in one module.
  - src/codegen/wrapper-proto-to-string.ts
  - src/codegen/new-boolean-tobooleanarg.ts
func-budget-allow:
  # The same +38 lines, counted per FUNCTION. Each is the dispatch line(s) that
  # reach a new subsystem module and cannot live anywhere else: the demand hook
  # must sit at #1397's hand-off inside `compileReceiverMethodCall`, and the
  # finalize call must sit next to `unshiftExternGetProtoMethodArm` inside both
  # module-generation drivers. `tryCompileBuiltinGlobalNew` +2 is the one-line
  # `else if` that routes an object/string argument to ToBoolean.
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
created: 2026-08-16
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-methods
goal: standalone-gap
related: [4483, 4442, 4481, 4518]
origin: "2026-08-16 residual map at 97.26% (222 failing). built-ins/Function 26 + Boolean 2 + Number 2 + ~4 String rows blocked on Function.prototype.toString + wrapper-method value calls."
---

# #4619 — Function residual v2 + wrapper-method value calls

## Problem (measured 2026-08-16, baseline at 7,893/8,115)

- **A — `Function.prototype.toString` not implemented** (explicit TypeError
  "not yet implemented in --target standalone"): blocks ≥2 String rows
  (`function-code` sources concatenated), `addition/S11.6.1_A2.2_T3`
  (`f1 + 1 === f1.toString() + 1`), and Function-bucket rows. A §20.2.3.5
  NativeFunction-shaped render (`"function <name>() { [native code] }"` is
  spec-legal for everything without source) may clear most.
- **B — apply/call TypeErrors still missing (5)**: "Expected a TypeError"
  rows that survived #4483 — re-measure which shapes (likely non-callable
  receiver via VALUE call `Function.prototype.apply.call(...)` or
  arguments-object argArray edge).
- **C — bound-function surface (2)**: `obj.touched` rows — #4483 family B,
  untaken.
- **D — wrapper-method VALUE calls "called value is not a function" (~6)**:
  `Boolean.prototype.toString` (S15.6.4.2_A1_T1/T2), `Number.prototype.
  toString` (S15.7.4.2_A1_T01), `property-accessors/S11.2.1_A3_T1/T2`,
  `String "is not a constructor"` — the #4481 identity singletons made
  these READABLE; calling the read value still fails. The call arm for a
  singleton-carried proto method value is the gap (#4481 R4's call-site vs
  call-value non-equivalence, pinned there).
- **E — `Array.prototype.concat` "not yet callable as a value" (2 Array
  rows)** — same class as D, explicit CE-style TypeError.
- **F — null-property TypeErrors at 263:18 (2)** + `obj["shifted"]` rows —
  triage.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   every family live; the baseline lags a fast-moving main.
2. Family D/E first (one mechanism): make the #4481/#2175 singleton values
   CALLABLE through the reflective dispatch — the closure-struct the
   singleton carries needs a call arm in calls.ts's callable-value路径
   (read #4481's R4 pin + `instance-proto-method-identity.ts` + the #4442
   provider-linked call constraint). Likely ONE fix clearing D+E+part of B.
3. Family A: implement `Function.prototype.toString` as §20.2.3.5
   NativeFunction render from the #4437 metadata (name available) —
   `"function " + name + "() { [native code] }"`; user functions with
   known source may defer (record residual). Wire as native proto method +
   value singleton.
4. B/C: re-measure post-D; fix what remains per #4483's family records.
5. Verify: scoped sweeps built-ins/{Function,Boolean,Number} +
   property-accessors before/after (own runs); fn-family pins
   (4436/4437/4440/4442/4456/4460/4464/4483) green; ≥18 of ~35 flip, zero
   regressions.

## Root cause (family D; measured on base `2937ca57a`)

**The issue's own framing of family D is wrong, and correcting it IS the fix.**
D was filed as "the #4481 identity singletons made these READABLE; calling the
read VALUE still fails", pointing at #4481's R4 call-site/call-value pin. The
rows do not call a read value. Re-measured live, one module per probe, real
`runTest262File` standalone lane:

| probe                                    | base                                        |
| ---------------------------------------- | ------------------------------------------- |
| `new Boolean(true).toString()`           | `TypeError: called value is not a function` |
| `(new Number(0)).toString()`             | same                                        |
| `(new String("ab")).toString()`          | same                                        |
| `Boolean.prototype.toString()`           | same                                        |
| `new Boolean(true).valueOf()`            | **passes** (#4491 wave-5 T2 / #4582)        |
| `(255).toString(16)`                     | passes (primitive receiver)                 |
| `var f = Boolean.prototype.toString; f.call(true)` | `undefined` — thisArg dropped     |

`S15.6.4.2_A1_T1`, `S15.7.4.2_A1_T01` and `S11.2.1_A3_T1` are all the DIRECT
call. The `valueOf` row is the tell: same receivers, same route, and the only
difference is that `valueOf` has a native body.

Three independent gaps, each verified by isolating it:

1. **No native body** for `{Number,String,Boolean}.prototype.toString` — the
   `makeGlue` ladder had a `valueOf` arm (#4491 T2/#4582) and no `toString`
   twin, so the member reified to the catchable refusal stand-in.
2. **Nothing MINTS the closure for a plain call.** #4248's `__extern_get` arm
   answers only for members already in `ctx.funcMap` — the right demand gate
   for the IDENTITY question it was built for (you cannot ask
   `x.toString === Number.prototype.toString` without naming the prototype
   member), and blind to `new Number(0).toString()`, which names only the
   instance member. Proof: adding a bare `var _f = Number.prototype.toString;`
   to the same module moved the error from "called value is not a function" to
   the refusal body's own message.
   The call reaches the dynamic route in the first place because of #1397's
   wrapper-reassignment branch, whose whole-file `sourceHasMethodReassignment`
   scan is TRUE for `toString` in **every test262 file** — `sta.js` carries
   `Test262Error.prototype.toString = function () {…}`. That branch is correct
   (§15.7.4.2 `_A2_*` need the own slot observed) and is left alone.
3. **`__extern_method_call` had no `$NativeProto` receiver arm** — the missing
   twin of #4248's `__extern_get` arm, so `<Builtin>.prototype.<member>()`
   fell past the `$Object` / vec / closure-prop arms to the terminal
   absent-callee TypeError. Measured separately: minting the closure by hand
   did NOT fix this shape, while the same closure on a wrapper `$Object`
   receiver worked — i.e. only the receiver guard was missing.

A fourth, smaller one surfaced from the `.call` spelling: **`lib.es5.d.ts`
declares no `toString` on `interface Boolean`**, so `Boolean.prototype.toString`
resolves through `Object`'s method signature and the reflective `.call`
dispatch mis-attributes it to the Object brand. `Number`'s and `String`'s
interfaces DO declare it, which is why only the Boolean spelling answered
`undefined`.

## Fix

Four changes, three of them new modules:

- `src/codegen/wrapper-proto-to-string.ts` — §21.1.3.6 / §22.1.3.27 / §20.3.3.2
  bodies. The receiver ladder is `valueOf`'s, shared verbatim: `valueOf`'s
  three-arm `this<X>Value(this)` emitter was generalised in place to
  `emitWrapperThisValueBody(…, buildTail)`, with `valueOf` passing
  `() => [{op:"return"}]` so its emitted body is byte-identical. Only the
  conversion is new — identity for String, `__unbox_boolean` → `"true"`/
  `"false"` for Boolean, `__unbox_number` → `number_toString[_radix]` for
  Number, with §21.1.3.6's radix range check and #3175's
  `undefined`-radix-means-10 carve-out.
  `buildTail` is a FACTORY (called once per arm) because finalize's DCE/remap
  walk double-remaps a shared `Instr` object — the #4221 hazard.
- `src/codegen/wrapper-proto-dynamic-demand.ts` — mints the brand's member
  closure immediately before #1397's hand-off, so the dynamic read has
  something to find.
- `src/codegen/native-proto-method-call.ts` — the `$NativeProto` arm, unshifted
  onto `__extern_method_call` at FINALIZE. **The first cut spliced it at
  `ensureObjectRuntime` time and was silently DEAD CODE**: `$NativeProto`
  registers lazily, on the first prototype materialization, which is strictly
  later; a trace printed `protoTypeIdx=undefined` for exactly the probe it was
  written for, while an unrelated probe passed — the win would have been
  mis-attributed. It claims the call only when the member RESOLVES, so an
  absent member still reaches the §13.3.6.2 step-5 TypeError.
- `expressions/calls.ts` — the reflective `.call` dispatch now prefers the
  SYNTACTIC `<Brand>.prototype.<member>` spelling over the symbol for exactly
  `toString`/`valueOf` on the three wrapper ctors (the lib.d.ts gap above).
  Deliberately not widened: `Boolean.prototype.hasOwnProperty.call(o, k)` IS
  Object's method and resolves correctly through the symbol today.

Two more gaps surfaced only once the three above were in place — each was the
NEXT blocker on a row this issue owns, and each is measured on its own:

- `src/codegen/new-boolean-tobooleanarg.ts` — `new Boolean(<object|string>)`
  coerced its argument to `f64`, which for an object or a string INVERTS
  §7.1.2: `new Boolean(new Object()).valueOf()` was `false`, and
  `new Boolean("0").valueOf()` was `false`. The FUNCTION spelling
  `Boolean(new Object())` already answered `true`, so the module held two
  ToBoolean answers for one value. The arm reuses the SAME `__is_truthy` /
  `__to_boolean` helper the function spelling picks, on the same condition, so
  they cannot drift apart again; numeric arguments keep the f64 path untouched.
- Argument-carrying spellings of the parameterless wrapper members. Two gates
  each required 0 arguments and sent `(new Boolean(-1)).valueOf(false)` and
  `Boolean.prototype.toString(true)` to lowerings that answered `false` /
  "called value is not a function". Both now admit an argument for members the
  spec gives no parameters, and only those — `Number.prototype.toString`'s
  RADIX is excluded by name, because the standalone dynamic path carries no
  arguments and routing it there would silently drop the radix. The arguments
  are compiled and dropped so §13.3.6.2's evaluation order survives.

## Test Results

Every number below is from a run executed on this branch. Base copies were
captured at the first edit and the A/B is a file copy (`.tmp/flip.sh`), never
`git stash` — other agents share this clone's ref stack. Both sides ran under
the SAME eval tier: quickjs, via
`JS2WASM_QUICKJS_ARTIFACT_DIR=…/quickjs-artifact-d8a5a91d6f183b87` (the
worktree's own cache key does not match the prebuilt artifact — the #4484
"fresh worktree has no `.test262-cache`" trap in a second form; without the
override every eval-dependent row fails identically on both sides as
"quickjs provider is not built", which under-measures the sweep).

**Scoped standalone sweeps, base vs after, 983 files:**

| directory set | base | after | flips |
| --- | --- | --- | --- |
| `built-ins/Boolean` + `built-ins/Number` + `property-accessors` + `addition` (460) | 416/460 | **422/460** | +6, −0 |
| `built-ins/Object/prototype` + `String/prototype/{toString,valueOf}` + `Function/prototype/toString` (342) | 190/342 | 190/342 | 0 changed |
| Date/Map/Set/RegExp prototype control (181) | 159/181 | 159/181 | 0 changed |

Flip list — every one a `toString`/`valueOf` row on a wrapper receiver:
`Boolean/prototype/toString/S15.6.4.2_A1_T1`, `_A1_T2`,
`Boolean/prototype/valueOf/S15.6.4.3_A1_T1`, `_A1_T2`,
`Boolean/S15.6.2.1_A3`, `Number/prototype/toString/S15.7.4.2_A1_T01`.

The third row is the **inert control**: 181 files that drive
`__extern_method_call` hard and contain no wrapper receiver at all. The new
`$NativeProto` arm is a dynamic-dispatch widening, so a per-file status map that
is IDENTICAL on both sides is the evidence that the widening did not reach past
its buckets. The second row is the adjacent-corpus control and is likewise
unmoved.

**Probe matrix, 20 shapes** (`.tmp/p-d2.mts`, real `runTest262File` standalone,
one module per probe): **8 → 18 of 20 pass**, none regressed. The two that remain
are the element-access spelling (residual R1).

**Vitest-lane matrix, 22 shapes × 2 module shapes** (`.tmp/lane-ab.mts`, base and
after). The `sta` column is the corpus condition — one unrelated `.toString`
assignment, which is what `sta.js` gives every test262 file and what decides
whether the call takes the dynamic route at all:

| shape | base plain | base sta | after plain | after sta |
| --- | --- | --- | --- | --- |
| `new {Boolean,Number,String}(…).toString()` | 1 | −30 | 1 | **1** |
| `{Boolean,Number,String}.prototype.toString()` | 1 | −30 | 1 | **1** |
| `var NP = Number.prototype; NP.toString()` | 1 | −71 | 1 | **1** |
| `Boolean.prototype.toString.call(true)` | 0 | 0 | 0 (R4) | **1** |
| `o.g = Boolean.prototype.toString; o.g()` | −72 | −72 | **1** | **1** |
| `Number.prototype.toString.call(new String("x"))` | no throw | no throw | **TypeError** | **TypeError** |
| every control row (valueOf, primitives, `Object.prototype.toString`) | 1 | 1 | 1 | 1 |

(`−N` = a thrown Error with an N-character message: 30 = "called value is not a
function", 71/72 = the member's "not yet implemented" refusal.) The
brand-mismatch row is the one worth naming: on base it did **not throw at all**,
where §21.1.3.6 step 1 → §21.1.3.7 step 3 requires a TypeError — so the body's
brand check removed a silent wrong answer, not just an error message.

**Pins** (all under the same quickjs artifact override):

- `tests/issue-4619.test.ts` — **23 passed** (new; 4 of them `it.fails`
  residual pins).
- `issue-4436` / `4437` / `4442` / `4460` / `4464` / `4481` / `4483` — **179
  passed** together with #4619's own file.
- `issue-2175-v2s2-singleton-identity`, `issue-2193-builtin-proto-value-read`,
  `issue-3175`, `issue-3181`, `es5-standalone-ctor-identity`,
  `es5-standalone-number-format` — **72 passed**.
- `tests/equivalence/` per-file batches (the directory OOMs in one invocation)
  over the 11 files this diff plausibly touches — **119 passed, 0 failed**:
  `tostring-valueof`, `object-to-primitive`, `wrapper-constructors`,
  `wrapper-string-concat`, `number-statics`, `boolean-relational-comparison`,
  `string-methods`, `array-prototype-methods`, `json-stringify`,
  `issue-3205-property-call-wrapper-root`,
  `issue-4123-param-receiver-proto-method`.
- **21 failures in `issue-4440` / `4456` / `4482` / `1472` / `2984` are
  PRE-EXISTING in this worktree**, and that is measured rather than assumed: the
  same five files were run on base and on after, and the failing test NAMES diff
  clean (`.tmp/pins-base.txt` vs `.tmp/pins-new.txt`, 21 = 21, identical). They
  are eval-tier and Proxy/`setPrototypeOf` shapes untouched by this diff.

**Gates**: typecheck, biome (changed files), prettier, oracle-ratchet (+0),
dead-exports, pushraw (+0), any-box-sites all OK. loc-budget (+38 across four
dispatch sites), func-budget (four functions) and coercion-sites (the two new
modules) need the allowances granted in this file's frontmatter — two rounds of
extraction already moved everything movable into the new subsystem modules, and
`new-builtin-globals.ts` no longer crosses the god-file threshold.

## Residuals

- **R1 — the element-access spelling `x["toString"]()`.** Base AND after both
  throw `TypeError: Cannot access property on null or undefined`. A static-key
  `ElementAccess` callee has its own dispatch chain
  (`expressions/call-tail-dispatch.ts`) which never reaches the property-access
  route this issue fixed. This is the whole of what still blocks
  `language/expressions/property-accessors/S11.2.1_A3_T1` (CHECK#2/#4) and `_T2`
  (CHECK#3/#4) — both rows' FIRST checks now pass. The natural fix is to
  normalise a string-literal element-access callee onto the property-access
  path; the blast radius wants its own issue. Pinned `it.fails`. Owner:
  standalone-gap, unclaimed.
- **R2 — an inherited member borrowed off a wrapper prototype.**
  `Boolean.prototype.hasOwnProperty.call(o, "k")` answers falsy, base and after.
  Recorded because the syntactic-spelling override added here deliberately does
  NOT claim inherited members, and this row is the proof that the decline is not
  what makes it fail. Pinned `it.fails`.
- **R3 — a module with no `__typeof_<brand>` predicate keeps the refusal.** The
  `this<X>Value` ladder needs the brand predicate to classify a receiver, so a
  module that never reaches one declines the body wholesale. Only the
  no-`sta.js` module shape is affected; the corpus always carries it. Pinned
  `it.fails`.
- **R4 — `<Brand>.prototype.<m>.call(…)` answers NULL in a module with no
  `.toString` install.** Base and after. The `typeof` fold reports `"string"`
  over that null — #4481's R2 masking trap one level down, which is why the
  probe asserts `.length`, not `typeof`. Whoever takes it should start from
  WHICH arm claims the call when `sourceHasMethodReassignment` is false, not
  from the closure factory. Pinned `it.fails`.
- **R5 — families A, B, C, E and F of this issue are NOT addressed.** Each was
  re-measured live and each is a different mechanism from D:
  - **A** is no longer "Function.prototype.toString not implemented" — it is
    implemented. `built-ins/Function` measured **394/509** on base; the largest
    remaining bucket (~30 rows) is `Conforms to NativeFunction Syntax` for
    CLASS, METHOD and ACCESSOR values, whose `.toString()` answers
    `"[object Object]"` / `"null"` / `"undefined"` because the compiler retains
    no `[[SourceText]]` for them. `addition/S11.6.1_A2.2_T3` is a separate
    one-row disagreement: `f1 + 1` renders the §20.2.3.5 step-3 NativeFunction
    string while `f1.toString()` renders the real source, and #4491 T4's
    `addOperandCallableSourceText` — which exists precisely to reconcile them —
    declines on this shape. Both want their own slice.
  - **E** (`Array.prototype.concat` "not yet callable as a value") is 6 rows in
    `built-ins/Array/prototype/concat`, and wiring a real `concat` body is a
    species / `isConcatSpreadable` job, not a call-arm one. Its neighbours in
    that directory fail for ~10 further independent reasons.
  - **B / C / F** were not reached.
- **Blocked-behind, now visible.** `Boolean/prototype/toString/S15.6.4.2_A1_T1`
  only flipped once `new Boolean(<object>)` was fixed as well — these rows carry
  several independent failures in sequence, so "the mechanism is fixed" and "the
  row flips" are different claims. That is why this issue reports +6 rows against
  a probe matrix that moved 10 cells: the remaining cells are blocked by defects
  belonging to other families.
