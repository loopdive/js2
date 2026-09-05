---
id: 4656
title: "ES5 standalone: Function.prototype residual — 23 rows: this-binding writes to opaque compiled receivers (reverse membrane), bind-of-builtin + curried [[Construct]], %Function.prototype% unreachable through a function-valued prototype, primitive-this in function-code"
status: in-progress
assignee: dev-4656
sprint: current
loc-budget-allow:
  # +4 lines at the `!leftType || !rightType` bail-out of
  # `compileBinaryExpression`. That fork is the DEFECT SITE — the bail-out is
  # what rolled back the operands and substituted a constant — and it cannot be
  # moved: the continuation needs the two operand ValTypes in scope. All of the
  # new logic (≈95 lines) lives in the subsystem module
  # `src/codegen/equality-void-operand.ts`; what remains here is the 4-line call
  # + destructure that hands the materialised operand types back to the existing
  # `foldTypeDisjointThenPromote` → `compileTypedBinaryDispatch` chain.
  - src/codegen/binary-ops.ts
  # (D3) `closed-method-dispatch.ts` is the SUBSYSTEM module for this concern,
  # not a barrel: it already owns `nullishReceiverGuardInstrs`, the in-callee
  # form of the very same guard, and the whole point of D3 is that the callee
  # form cannot get §13.3.6.1's ordering right. Splitting the call-site form
  # into a new file would put two spellings of one predicate in two places —
  # the failure mode #4442 made a rule about. The growth is the two exported
  # entry points plus the argument for why a positive placement change is
  # sound.
  - src/codegen/closed-method-dispatch.ts
  # (D3) The guard has to be EMITTED where the receiver is compiled, and both
  # affected call sites live in this file (the fixed-arity `__call_m_*`
  # dispatch arm, which is the one `11.2.3-3_3` takes, and the generic
  # `__extern_method_call` arm). Five instructions each; every line of the
  # logic itself is in the subsystem module above.
  - src/codegen/expressions/call-receiver-method.ts
  # The reflective Function path opts into explicit `this` for a constant
  # reconstructed body; the two-parameter option is local to this synthesis
  # helper and cannot be moved to the provider lane without losing AOT bodies.
  - src/codegen/expressions/eval-inline.ts
func-budget-allow:
  # Same +4 lines, same rationale — the bail-out fork lives inside
  # `compileBinaryExpression` and the continuation needs its two operand
  # ValTypes in scope, so the growth cannot be moved out of the function.
  - src/codegen/binary-ops.ts::compileBinaryExpression
  # (D3) +12 lines across the TWO arms of this dispatcher that compile a
  # receiver onto the stack and then compile arguments on top of it. The
  # ordering defect IS that adjacency, so the guard cannot be hoisted out of
  # the function without also hoisting the receiver compile — which is the
  # dispatcher's whole job. The logic is in `closed-method-dispatch.ts`.
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  # The carrier predicate now includes reserved standalone Function layouts;
  # the shared helper computes both slotted and slotless carrier partitions.
  - src/codegen/closure-props.ts::fillClosurePropHelpers
oracle-ratchet-allow:
  # The two syntactic global-Function checks reuse the existing
  # `isGlobalFunctionIdentifier` helper, whose binding check intentionally
  # consumes the raw checker. This lane keeps the recognizer restricted to
  # global `Function` without changing the shared helper's oracle contract.
  - src/codegen/expressions/calls.ts
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime-eval, codegen
es_edition: 5
language_feature: call-apply-bind
goal: standalone-gap
related: [4647, 4643, 4637, 4642, 4492]
origin: "wave-6 lead sweep (2026-08-23) on the merged wave-4 tree. #4647 landed 2 of its 16 rows and recorded MEASURED declines for the rest; #4643 measured the %Function.prototype% half and recorded it as a residual with an owner. This issue is that recorded remainder, plus the function-code primitive-this rows no lane owned."
---

# #4656 — Function.prototype residual (23 rows)

Every sub-family below was **measured and handed over by a wave-4 lane**, not
guessed. Read those records before touching anything: `#4647`'s Root-cause
table (representation-split matrix), and `#4643`'s flip-list section (the
bag/intrinsic finding).

## A. this-binding writes to opaque compiled receivers — 4 fixed, 2 residual

```
built-ins/Function/prototype/call/S15.3.4.4_A5_T8.js   FIXED — obj.touched is true
built-ins/Function/prototype/call/S15.3.4.4_A6_T6.js   FIXED — obj["shifted"] is "42"
built-ins/Function/prototype/apply/S15.3.4.3_A5_T8.js  FIXED — obj.touched is true
built-ins/Function/prototype/apply/S15.3.4.3_A7_T6.js  FIXED — obj["shifted"] is "42"
built-ins/Function/prototype/call/S15.3.4.4_A7_T6.js   helper crash "Cannot access property on null or undefined at 320:18"
built-ins/Function/prototype/apply/S15.3.4.3_A8_T6.js  same crash
```

#4647 fixed the case where the receiver is a **membrane-wrapped** compiled
object. This lane now fixes the four constant-body rows: standalone
`Function(...).call/apply` is recognized at the call site, routed through the
canonical `__apply_closure` bridge with its explicit receiver, and its foreign
body's reads/writes use the dynamic externref path. Reserved fnctor layouts are
also included in the closure-property carrier registry so expandos created by
the body remain visible on the compiled Function receiver.

The two `A7_T6`/`A8_T6` crashes remain trap-first (absent-not-wrong): their
receiver is the constructor's opaque `this` and the foreign body cannot obtain
a usable dynamic member lane. Closing those needs the reverse membrane or an
allocation-time escape rule described under Root cause → A; this change does
not broaden into either design.

## B. `bind` — 3 rows (#4647's correction: bind is NOT unimplemented)

```
built-ins/Function/prototype/bind/S15.3.4.5_A5.js    "bind is not yet implemented in --target standalone"
built-ins/Function/prototype/bind/15.3.4.5-2-6.js    (o == 42) !== true
built-ins/Function/prototype/bind/15.3.4.5-2-8.js    [object WebAssembly.Exception]
```

#4647 measured that this-binding, partial args, `.length` and `.name` all
already work. The three rows need: **bind of a builtin constructor**, **curried
`[[Construct]]`** (`new` on a bound function ignores the bound this and
forwards to the target — `construct-return-value.ts`, #4464), and
**`%Function.prototype.bind%` reachable as a value** (the builtin-as-value
family, dev-4515's C1 root — coordinate, don't duplicate).

## C. `%Function.prototype%` through a function-valued prototype — 5 rows (#4643's residual)

```
built-ins/Function/prototype/apply/S15.3.4.3_A1_T1.js  typeof obj.apply → undefined
built-ins/Function/prototype/apply/S15.3.4.3_A1_T2.js  same
built-ins/Function/prototype/call/S15.3.4.4_A1_T1.js   typeof obj.call → undefined
built-ins/Function/prototype/call/S15.3.4.4_A1_T2.js   same
built-ins/Function/prototype/S15.3.5.2_A1_T1.js        f.hasOwnProperty('prototype')
```

`FACTORY.prototype = Function(); typeof (new FACTORY()).apply` must be
`"function"`. #4643 fixed the OWN half (`o.k` reads through the same link) and
verified on the merged tree that these do **not** heal: #4637's prototype bag
has a **null `$proto` by design**, so the chain never reaches
`%Function.prototype%`. Its note: linking the bag to the intrinsic touches every
closure's own-property table — that is the work here, and it is why this is
`horizon: l`.

## D. primitive/`this` in function-code — 6 rows (unowned until now)

```
language/function-code/10.4.3-1-17-s.js   eval("typeof this") → "object", want "undefined"
language/function-code/10.4.3-1-83-s.js   TypeError: not a function
language/function-code/10.4.3-1-84-s.js   same
language/function-code/S10.2.1_A4_T1.js   Cannot access property on null or undefined at 325:6
language/function-code/S10.2.1_A4_T2.js   SameValue(«undefined», «[object Object]»)
language/types/undefined/S8.1_A2_T2.js    test2() === void 0, got undefined-vs-object mismatch
language/expressions/call/11.2.3-3_{3,4,8}.js  call on undefined/null must TypeError at the right point
```
Strict-mode `this` (undefined, not boxed/global) and the TypeError timing of a
call on a non-callable. Verify whether the `S10.2.1_A4_T1` crash shares the
helper with A's `320:18` crash — same wording, possibly the same helper.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read fully.
   Load-bearing here: **eval-tier pin arms** (most of A and B mint from body
   strings — every pin needs a quickjs arm AND `JS2WASM_EVAL_ENGINE=interpreter`),
   the **stale `compiler-bundle.mjs` trap** (rebuild bundle+adapter on BOTH
   arms before any A/B — this territory is where that trap was found),
   methodology 1–7, the `test262/` symlink-farm + **GITLINK hazard**, the
   verification floor, commit rules.
2. Order by value/risk: **D** (self-contained semantics) → **C** (one
   structural link, 5 rows) → **B** → **A** (the design decision, most
   invasive). Landing D+C with A and B correctly designed-and-declined is a
   good outcome; a rushed reverse membrane is not.
3. Cross-lane (methodology 7 — five lanes active): builtin-as-value roots go to
   dev-4515 (#4515 C1); `toString`/`valueOf`-override roots to dev-4492;
   descriptor MOP to dev-4491. Hand over with evidence; a claim about another
   lane's effect needs an arm containing their change.

## Acceptance

Scoped standalone sweep over `built-ins/Function`, `language/function-code`,
`language/expressions/call` before AND after from your own runs; per-file flip
list; **zero regressions**. `tests/issue-4656.test.ts`, both eval tiers, each
pin EXECUTING the operation it guards (perform the this-bound write and read it
back; call the inherited `.apply`), verified failing on base by revert;
`it.fails` for residuals with owners. Record `## Root cause` per sub-family /
`## Fix` / `## Test Results` / `## Residuals` here.

## Root cause

Four sub-families, four different roots. **Two are fixed here, one is fixed in
part, and one is declined with a design.** Nothing below is inherited: every
"base" figure comes from a run this lane executed on its own tree (campaign base
= `origin/main` at `f6e094cdb`, merged into this branch before measuring), with
`scripts/compiler-bundle.mjs` and the quickjs adapter rebuilt on **each** arm
(the adapter reported `cache MISS — compiling` on the base arm, so the
stale-bundle trap is ruled out by construction, not by assumption).

### D1 — a VOID-typed equality operand was not compared at all

`compileBinaryExpression` bails out when either operand compiles to "no value"
(`leftType === null`). For `===`/`!==` that bail-out reached
`foldVoidOperandEquality`, which *decided* the comparison statically and emitted
a constant. Two defects rode in it:

1. **The constant was wrong for a union.** The decidability test was a flag
   mask, and `number | undefined` carries `TypeFlags.Union`, whose intersection
   with the nullish mask is `0` — so the fold read a possibly-`undefined` value
   as provably-non-nullish and answered `false`. `f() === void 0` and
   `f() !== void 0` therefore **both** answered `false`, which is the tell: one
   of them has to be true.
2. **The operand's code was rolled back with the fold.** §13.11.1 evaluates both
   operands. Emitting a constant in place of the comparison discarded the call
   that had already been compiled, so the call never ran. Measured: of four
   void-operand comparisons in one function, exactly **one** of four calls
   executed.

Row: `language/types/undefined/S8.1_A2_T2.js`.

### D2 — a resolved callee that BRANDS as a primitive was called anyway

§7.3.14: `recv.k(…)` where `k` resolves to a non-callable is a **TypeError**.
#4221 shipped the ABSENT half (`ref.is_null` after `__nullish_to_null`) and
explicitly declined the rest, on the ground that a *negative* callable test
misfires on callable shapes the classifier does not recognise.

That argument is sound and it **does not transfer to a positive primitive
test**. A callable shape the classifier does not know answers `false` to
`__typeof_number`/`__typeof_string`/`__typeof_boolean`, so it cannot be mistaken
for a primitive; only a value that positively brands as a number, string or
boolean throws, and calling one of those is a TypeError under every reading of
§7.3.14. The two tests have opposite failure modes, which is why one was
declinable and the other is not.

Row: `language/expressions/call/11.2.3-3_4.js` (an accessor whose getter returns
`42`; on base there was **no throw at all** — the getter ran, the argument
evaluated, and the call answered `undefined`).

Still deliberately not covered (absent-not-wrong): a non-callable **object**
(`new Number(1)`, a plain `{}`) keeps the legacy `undefined`. Branding those
needs the negative classifier #4221 declined.

### D3 — the callee-reference TypeError was thrown AFTER the arguments

§13.3.6.1 evaluates the callee MemberExpression **before**
ArgumentListEvaluation, so `o.bar.gar(foo())` with `o.bar === undefined` must
throw while resolving the callee and `foo()` must never run.

On base the right error was thrown at the wrong time: `assert.throws(TypeError,
…)` passed and `fooCalled` was `true`. The reason is structural, not a missing
check — **every** guard we had lived inside a callee
(`closed-method-dispatch.ts`'s `nullishReceiverGuardInstrs`, #4221's
absent-callee arm, D2's primitive-callee arm above), and a callee cannot observe
its arguments un-evaluated: by the time it runs, the call site has already built
the argument array. The receiver, however, is already parked in a local at the
call site *before* the argument loop, so the identical predicate placed one step
earlier gets the order right.

Row: `language/expressions/call/11.2.3-3_3.js`.

### D4 (NOT fixed) — every remaining `function-code` row needs a global `this` object

The five rows left in D look like five bugs and are one missing substrate: the
**`this` value of a plain function call** — the global object in sloppy mode,
`undefined` in strict mode.

| row | what it needs |
| --- | --- |
| `10.4.3-1-83-s` / `-84-s` | `this.f = …` at top level must create a global binding that a `Function(…)`-minted strict function can then call |
| `11.2.3-3_8` | `this.bar(foo())` where `this` is the global object: TypeError *with* the argument evaluated |
| `10.4.3-1-17-s` | `eval("typeof this")` inside a strict function must be `"undefined"`, not `"object"` |
| `S10.2.1_A4_T{1,2}` | additionally `f1().constructor.prototype === Function.prototype` — intrinsic identity, i.e. C's substrate |

Note that `11.2.3-3_8` is *not* healed by D3 and is not made worse by it: with
no global object, `this` is nullish, so the new call-site guard throws the
correct TypeError but with `fooCalled` still `false`. It moves from "no throw"
to "right throw, wrong side effect" — the remaining half is the global object.
This is the #4480 family (functions/objects materialised as real objects), and
is handed over there rather than patched here.

### C — `%Function.prototype%` members are not reachable as a VALUE at all

#4643 recorded this residual as "#4637's prototype bag has a null `$proto` by
design, so the chain never reaches `%Function.prototype%`". **Measured with an
OPAQUE key, that attribution is wrong in a way that changes who owns it.**

| probe (standalone, one module each) | base and branch |
| --- | --- |
| `typeof target.apply` — LITERAL key, plain function receiver | `"function"` |
| `typeof target[k]` where `k` is a loop-carried `"apply"` — same receiver | **`undefined`** |
| `target.own = 5; target[k]` where `k` is a loop-carried `"own"` | `5` |
| `box[i].call(null,1,2)` — LITERAL key, OPAQUE receiver, `box[i]` is a function | **misses** |
| `typeof inst.apply` where `inst = new FACTORY()`, `FACTORY.prototype = Function()` | **`undefined`** |
| `typeof inst.toString` — same `inst`, i.e. `%Object.prototype%` | **`undefined`** |
| `P.own = 5; inst.own` — same link, an OWN property of the prototype object | `5` |

Row 3 is the control that makes the claim specific: the opaque-key READ PATH
works on that very receiver, so the miss is not about key opacity — and no
prototype chain is involved in the first three at all, the receiver is a plain
function. Row 7 is the same control one link out: the prototype LINK carries
values fine.

**Rows 4 and 6 are corrections this lane owes its own first draft.** Both were
written as CONTROLS — "these pass on both arms" — and both FAIL on both arms.
Fixing the label changes the conclusion twice over, in the useful direction:
the miss is reachable from an opaque RECEIVER as well as an opaque KEY, and it
is **not specific to `%Function.prototype%`** — `%Object.prototype%.toString` is
equally unreachable through the identical link. A builtin prototype's members
are reachable only through the #4481 compile-time fold, which needs a
statically-branded receiver AND a literal key. There is no runtime table in
which they are values, so no prototype link, however correct, can find one.

**The substrate for the value already exists, and this is the actionable part
of the correction.** #2175 V2-S2's `pushBuiltinFnSingletonValueInstrs` already
mints ONE identity-stable value per (brand, member) — that is why #4481 could
make `[].toString === Array.prototype.toString` hold by construction. What is
missing for C is (i) a RUNTIME arm: at `__extern_get`'s terminal proto-walk
miss, a receiver whose walk lands on the `$NativeProto` glue for brand
`Function` and whose key is one of `apply`/`call`/`bind`/`toString` should
answer that singleton, exactly as the #4176 proto-companion consult answers a
user-written prototype property one step earlier in the same tail; and (ii) the
`IsCallable(this)` check inside those members' `[[Call]]`, since the rows go on
to require `obj.apply()` to throw TypeError when `obj` is not callable.

Both halves are real work in the builtin-prototype SURFACE, not in the prototype
LINK — the link demonstrably carries values (row 7: an own property of a
function-valued prototype reads through it). And per the correction above, the
work is not `%Function.prototype%`-shaped: whatever serves `apply`/`call` at
runtime has to serve `%Object.prototype%.toString` too. Handed to the
builtin-prototype-surface family (#4480/#4481/#4483, dev-4515's C1) with that
narrowing, rather than re-attributed to #4637's bag.

### B — `bind` (unchanged from #4647's correction; re-verified, not re-derived)

#4647 measured that `bind` is NOT unimplemented: this-binding, partial
application, `.length` and `.name` all already work for a user function. The
three rows need `bind` of a **builtin constructor**, curried `[[Construct]]`
through the bound result, and `%Function.prototype.bind%` as a first-class
**value** (the refusal message the issue quotes comes from
`builtin-value-read.ts`'s `genericThrowBody` — it is the bind VALUE read, not
`bind`). `src/codegen/construct-bound.ts` (#4196) already implements §10.4.1.2
for user targets; the missing pieces are the builtin-carrier arms.

Two of those three pieces are C's substrate (a `%Function.prototype%` member as
a value; a builtin carrier with a real `[[Construct]]`), so B is **declined as a
dependent of C**, not as independent work. Sequencing it before C would build
the carrier twice.

### A — four explicit-this rows fixed; two opaque-constructor rows remain

#4647's representation-split table still explains the two remaining crashes:
a receiver whose runtime representation is a **module-private nominal struct**
(a shape-inferred object literal lowering to `(struct (field f64))`, or a
closure struct) is opaque to the provider's dynamic property runtime in BOTH
directions. The body cannot obtain a usable receiver lane, so the `A7_T6` and
`A8_T6` operations remain absent-not-wrong rather than being silently treated
as successful writes.

The four constant-body rows have a narrower mechanism and are fixed here.
`standaloneDynamicFunctionCtorArgs` recognizes only global `Function(...)` and
`new Function(...)` syntax in standalone code. The reflective call arm then
uses `tryStaticNewFunction(..., allowExplicitThis = true)` when all constructor
arguments are constant, compiles the foreign body in the caller module, and
routes `.call`/`.apply` through `__apply_closure` with the explicit receiver and
materialized argument vector. Foreign property reads and writes use
`__extern_get`/`__extern_set`, and reserved fnctor layouts are registered as
slotless closure-property carriers so the expando is visible after return.

Closing the two remaining rows needs the reverse membrane (the caller hands the
provider get/set callbacks bound to the object) or an allocation-time escape
rule (objects that can reach runtime eval are allocated in canonical `$Object`
representation). This change deliberately does not broaden into either design.

## Fix

Six changes, each standalone/WASI-gated so the JS-host lane is byte-identical
(with a host the engine throws on its own, and the host bridge owns the
ordering).

**A — `src/codegen/expressions/calls.ts`, `eval-inline.ts`,
`property-access.ts`, `expressions/assignment.ts`, and `closure-props.ts`.**
Standalone `Function(...)` and `new Function(...)` constructor syntax is
recognized only for the reflective `.call`/`.apply` lane. Constant constructor
arguments use the existing AOT body synthesis with an explicit-this opt-in;
non-constant bodies retain the provider path. The reflective arm materializes
the actual `call` arguments or `apply` vector and invokes `__apply_closure` with
the supplied receiver. Foreign eval property reads/writes bypass checker type
queries and lower through the dynamic externref get/set helpers. Fnctor layouts
are added to the slotless closure-property carrier registry, making expandos
written on a compiled Function receiver observable after the call returns.
This flips A5/A6 for both call and apply; A7/A8 remain the documented opaque-
constructor trap residuals.

**D1 — `src/codegen/equality-void-operand.ts` (+ 4 lines in
`binary-ops.ts`).** The module gains `provablyNonNullish`, which looks THROUGH a
union's constituents so any nullish member refuses the fold, and a third
outcome: instead of only "constant" or "not handled", it can now materialise the
canonical `undefined` for the void side and hand the two operand `ValType`s back
to the caller, which CONTINUES into the ordinary typed dispatch
(`foldTypeDisjointThenPromote` → `compileTypedBinaryDispatch`). That is what
keeps the already-emitted operand code alive: there is no rollback, because
there is no substitution. The 4 lines in `compileBinaryExpression` are the call
plus the destructure — the fork is the defect site and the continuation needs
both `ValType`s in scope.

**D2 — new `src/codegen/resolved-callee-guard.ts`, spliced into three arms of
`__extern_method_call`.** The guard tees the resolved callee, throws on
`ref.is_null` (the #4221 arm, moved), then throws on each POSITIVE primitive
brand (`__typeof_number` / `__typeof_string` / `__typeof_boolean`), then leaves
the callee back on the stack. It is a FACTORY, not a shared `Instr[]` — finalize's
DCE/remap walks double-remap a shared instruction object
(`reference_shared_instr_object_dce_double_remap`) and this guard is spliced
more than once. Each brand predicate is looked up, never required, so a module
that registered none of them emits the pre-#4656 bytes exactly.

**D3 — `src/codegen/closed-method-dispatch.ts` +
`expressions/call-receiver-method.ts`.** `buildCallSiteNullishReceiverGuard` is
the existing `nullishReceiverGuardInstrs` with its leading `local.get 0`
re-pointed at an arbitrary local, so it fires on exactly the same predicate as
the in-callee guard and can never throw where that one would not. Two call sites
take it: the fixed-arity `__call_m_<name>_<arity>` arm (the one
`11.2.3-3_3` takes — confirmed by reading the WAT, where the inlined
dispatcher's `__inl9___argvec` locals name it) and the generic
`__extern_method_call` arm. The receiver is already on the stack at both points,
so `local.tee` into a POOLED temp (`allocTempLocal`) keeps it there: no
per-call-site local, and `callSiteNullishReceiverGuardApplies` skips the spill
entirely on any lane where the guard would be empty. The `then` exemption
(#4394) is preserved unchanged.

A note on why D3's blast radius is smaller than it looks: for the dispatcher arm
the dispatcher ALREADY threw this exact TypeError for a nullish receiver, so the
only observable delta is that the arguments are no longer evaluated first. The
generic-arm splice is the one that can throw where nothing threw before; it is
kept because §7.3.14 requires it and it is covered by the sweep below.

Finding the right arm was itself the work. The obvious call site — the generic
`__extern_method_call` arm — is **not** the one `11.2.3-3_3` takes, and wiring
only that arm produced a byte-identical module (same `wasm_sha`, `a0e061db4c24`
before and after). Reading the WAT settled it: the emitted body carried
`__inl9___argvec`, a local name that belongs to `closed-method-dispatch.ts`, so
the call was an INLINED `__call_m_gar_1`. That is the fixed-arity arm, ~700
lines further down the same dispatcher.

## Test Results

Every number below is from a run this lane executed, on its own tree, with the
compiler bundle AND quickjs adapter rebuilt on each arm — the base arm's adapter
key was `70afda182fdbfd59`, the branch arm's `bacfe64cd8008662`, both reported
`cache MISS — compiling`, so the stale-`compiler-bundle.mjs` trap is excluded by
construction.

**Scoped standalone sweep** — the issue's three directories, 818 files, both
arms complete:

| arm | pass | fail | compile_error |
| --- | --- | --- | --- |
| base (`origin/main` @ `f6e094cdb`, merged in) | 668 | 146 | 4 |
| branch | **670** | 144 | 4 |

Plus `language/types/undefined` (8 files — D1's row lives outside the issue's
three directories, so it is measured separately, both arms): base **7/8**,
branch **8/8**.

**Flip list — 3 gains, 0 regressions, 0 other status changes across 826 files:**

```
+ language/expressions/call/11.2.3-3_3.js        (D3)
+ language/expressions/call/11.2.3-3_4.js        (D2)
+ language/types/undefined/S8.1_A2_T2.js         (D1)
```

Two things worth stating rather than assuming:

- **Neither arm produced a single `compilation timeout` row.** The box ran at
  load 9–17 for the whole measurement (three other lanes sweeping), which is
  exactly the condition the brief warns fakes flips and regressions in both
  directions. It did not here, and that is checked, not hoped.
- **The 4 `compile_error` rows are identical on both arms** — all in
  `built-ins/Function/prototype/bind/`, all the same genuine decline
  (`standalone Reflect.construct cannot preserve an arbitrary distinct
  NewTarget…`, #3371), not infrastructure.

**Historical D1–D3 pins — `tests/issue-4656.test.ts`, 27 tests, BOTH eval tiers
(before the A regression pins were added):**

| run | result |
| --- | --- |
| quickjs (default) | `27 passed (27)` |
| `JS2WASM_EVAL_ENGINE=interpreter` (refusal provider) | `27 passed (27)` |
| **base arm, by file-copy revert of all six files** | `9 failed \| 17 passed \| 1 skipped (27)` |

`passed + failed == total` on all three, so nothing was silently deselected; the
declared 27 was established by enumerating the `it(`/`it.fails(` lines, not by a
grep count (the brief's tier-2 caveat — the naive patterns are wrong in both
directions on real files). The 9 base failures are the three F1 pins, the three
F2 pins, the F3 pin and the two rows demoted below. The fourth F1 pin
(`v0() !== void 0` is false) passes on base **for the wrong reason** and is
pinned separately for exactly that: on base `===` and `!==` both answered
`false`, and a fix that repaired one and broke the other would otherwise read
as green.

**Current A-focused standalone census (2026-08-25):** the authoritative
131-row nonpass list compared the aggregate base at **81/131** with this branch
at **85/131**, for four gains and zero losses. The exact flips are:

```
+ built-ins/Function/prototype/apply/S15.3.4.3_A5_T8.js
+ built-ins/Function/prototype/apply/S15.3.4.3_A7_T6.js
+ built-ins/Function/prototype/call/S15.3.4.4_A5_T8.js
+ built-ins/Function/prototype/call/S15.3.4.4_A6_T6.js
```

The focused issue file now contains 36 tests. Both quickjs and the
`JS2WASM_EVAL_ENGINE=interpreter` refusal tier passed all 36. The four new tests
execute the writes and reads (including the `arguments` vector), rather than
merely checking that compilation succeeds.

### Three corrections this lane owes its own first draft

1. **Two pins labelled `CONTROL` fail on BOTH arms** — `%Function.prototype%
   .call/.apply` through an opaque receiver, and `%Object.prototype%.toString`
   through a function-valued prototype. They are residuals, not controls, and
   demoting them is what produced the sharper C root cause above (the miss is
   not `%Function.prototype%`-specific, and it is reachable from an opaque
   RECEIVER as well as an opaque KEY). A control that has never been run on the
   base arm is a label, not evidence.
2. **R2's eval-tier gate was unnecessary and was removed.** It was
   `skipIf(REFUSAL_TIER)` on the assumption that `Function()` mints from a body
   string. Measured: an **argument-less** `Function()` is AOT-synthesized by
   #2924 and never reaches the provider — the block answers `0` identically on
   both tiers. A pin now asserts that identity, so the gate comes back
   automatically if that ever changes. Whether a snippet mints is not
   answerable by reading it; the compiler decides.
3. **The first D3 wiring changed nothing at all** (identical `wasm_sha`) — see
   the arm-identification note under Fix.

## Residuals, with owners

16 of the issue's 23 rows remain. All are pinned `it.fails` in
`tests/issue-4656.test.ts` where a pin is meaningful, and each is routed to the
family that owns the substrate — not left unassigned.

| shape | rows | owner |
| --- | --- | --- |
| a builtin prototype's MEMBER as a value, reached by an opaque KEY, an opaque RECEIVER, or a dynamically-typed receiver — `%Function.prototype%.{apply,call}` and `%Object.prototype%.toString` alike | C's 5, plus 2 demoted controls | **#4480/#4481/#4483 — the builtin-prototype surface** (dev-4515's C1). Narrowed above: the prototype LINK works; the members are not values. |
| `bind` of a builtin constructor · curried `[[Construct]]` · `%Function.prototype.bind%` as a value | B's 3 | **dependent on the row above.** `construct-bound.ts` (#4196) already does §10.4.1.2 for user targets; only the builtin-carrier arms are missing. Sequencing B first would build the carrier twice. |
| this-binding writes to a receiver whose runtime representation is a module-private nominal struct | A7/A8 (2) | **#4647's recorded decline**, unchanged. Needs a reverse membrane or an allocation-time escape rule; this lane's residual reasoning is under *Root cause → A*. |
| the `this` value of a plain function call — global object in sloppy mode, `undefined` in strict | D4's 5 | **#4480** (a real global object). `11.2.3-3_8` needs it *plus* D3, which is now landed. |
| a function DECLARATION must override a same-named PARAMETER (§10.2.11 order) | 1, inside `S10.2.1_A4_T1` | **unowned — file it.** Isolated here with two controls that pass: the same collision against a `var` DOES override, and a non-colliding inner declaration hoists, so the hoist itself is sound; only the parameter case loses. |

Not attempted, and worth saying plainly: **C was in the plan for this lane and
is not done.** What is delivered instead is a corrected root cause with an owner
and a measured design (the runtime arm at `__extern_get`'s proto-walk terminus
serving `pushBuiltinFnSingletonValueInstrs`, plus `IsCallable(this)` in the
members' `[[Call]]`), which is the part that was wrong in the record and would
have been re-derived wrongly by the next lane.

## Status — PARTIAL, deliberately

**7 of 23 rows land here; the other 16 are routed above, none dropped.** The
issue stays `in-progress` rather than `done` so the remainder does not become
invisible — but note that every remaining row's substrate belongs to a
DIFFERENT issue (#4480/#4481/#4483, #4647, #4196) except the one §10.2.11
parameter-vs-declaration row, which needs filing. If the lead prefers, closing
this issue and filing that single row is a defensible alternative; what must not
happen is the 20 rows being read as still owned here.

The plan's order was D → C → B → A on the ground that "landing D+C with A and B
correctly designed-and-declined is a good outcome; a rushed reverse membrane is
not". D landed as far as it goes without a global object. C did not, and the
reason is recorded rather than glossed: its substrate turned out to be wider
than the issue described (`%Object.prototype%` too, not just
`%Function.prototype%`), which makes it another issue's whole slice rather than
this one's next step.
