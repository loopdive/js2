---
id: 4656
title: "ES5 standalone: Function.prototype residual — 23 rows: this-binding writes to opaque compiled receivers (reverse membrane), bind-of-builtin + curried [[Construct]], %Function.prototype% unreachable through a function-valued prototype, primitive-this in function-code"
status: ready
sprint: current
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
