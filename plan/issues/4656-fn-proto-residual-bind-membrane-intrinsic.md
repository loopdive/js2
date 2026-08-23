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

## A. this-binding writes to opaque compiled receivers — 6 rows (#4647's decline)

```
built-ins/Function/prototype/call/S15.3.4.4_A5_T8.js   obj.touched must be true
built-ins/Function/prototype/call/S15.3.4.4_A6_T6.js   obj["shifted"] must be "42"
built-ins/Function/prototype/apply/S15.3.4.3_A5_T8.js  obj.touched must be true
built-ins/Function/prototype/apply/S15.3.4.3_A7_T6.js  obj["shifted"] must be "42"
built-ins/Function/prototype/call/S15.3.4.4_A7_T6.js   helper crash "Cannot access property on null or undefined at 320:18"
built-ins/Function/prototype/apply/S15.3.4.3_A8_T6.js  same crash
```

#4647 fixed the case where the receiver is a **membrane-wrapped** compiled
object. What remains, per its measured table: a receiver whose representation
is a **module-private nominal struct** (a shape-inferred object literal
`{pre:44}` lowering to `(struct (field f64))`, or a closure struct) is opaque to
the provider's dynamic property runtime **in both directions** — the write does
not even stick inside the provider. Its stated verdict: this needs a **reverse
membrane** or an **allocation-time escape rule**, not a patch.

That is your design decision. Both options are real; pick one on measurement
and record why. The two `A7_T6`/`A8_T6` crashes are the same family failing
harder — treat trap-first (absent-not-wrong) even if the correct answer is out
of scope.

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

| probe (standalone, one module each) | base |
| --- | --- |
| `typeof target.apply` — LITERAL key, plain function receiver | `"function"` |
| `typeof target[k]` where `k` is a loop-carried `"apply"` — same receiver | **`undefined`** |
| `target.own = 5; target[k]` where `k` is a loop-carried `"own"` | `5` |

The third row is the control that makes this claim specific: the opaque-key READ
PATH works on that very receiver, so the miss is about `%Function.prototype%`
membership and **not** about key opacity — and there is no prototype chain
involved in any of the three, the receiver is a plain function. `f.apply`
answers `"function"` only as a compile-time fold on a literal key
(`tryPrototypeMethodAndArityReads`, the #4481 arm). There is no runtime table in
which `%Function.prototype%.apply` is a value, so no prototype link, however
correct, can find one.

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

Both halves are real work in `%Function.prototype%`'s own surface, not in the
prototype LINK — and the link demonstrably already carries values (this lane's
R2 controls: an own property of a function-valued prototype reads through it,
and `%Object.prototype%.toString` is reachable through the same link). Handed to
the builtin-prototype-surface family (#4480/#4481/#4483, dev-4515's C1) with
that narrowing, rather than re-attributed to #4637's bag.

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

### A — reverse membrane (declined, per #4647's measured verdict)

#4647's representation-split table is the evidence and this lane adds nothing to
it: a receiver whose runtime representation is a **module-private nominal
struct** (a shape-inferred object literal lowering to `(struct (field f64))`, or
a closure struct) is opaque to the provider's dynamic property runtime in BOTH
directions — the write does not even stick inside the provider. Its stated
verdict, which this lane accepts: closing it needs a **reverse membrane** (the
caller hands the provider get/set callbacks bound to the object; the provider
can already call compiled closures via `__apply_closure`) or an
**allocation-time escape rule** (any object that can reach a runtime-eval
boundary is allocated in the canonical `$Object` representation —
identity-preserving, where converting at the crossing is not).

Recording the choice this lane would make, since the issue asks for one: the
**allocation-time escape rule**, because the reverse membrane does not obviously
reach the two `A7_T6`/`A8_T6` crashes — those are the same family failing
harder, and a membrane that forwards get/set still has nothing to forward when
the callee never gets a usable receiver. The escape rule is also the only one of
the two that preserves identity by construction rather than by agreement between
two emitters — the property #4442 made a rule of after `%Function%` was built
twice and shipped neither. It is a whole-issue slice and is **not** started
here.
