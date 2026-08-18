---
id: 4246
title: "`new` on a non-constructor does not throw, and a sloppy callee binds a primitive `this` verbatim"
status: done
completed: 2026-08-08
sprint: 78
created: 2026-08-08
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: new-expression, this-binding, function-semantics
goal: es5
related: [4221, 4243, 4190, 4203, 4017, 4192, 1596, 4202]
func-budget-allow:
  # The same two edits the loc-budget rationale below covers, seen at function
  # granularity: the sloppy-`this` reshape and inlined receiver bind/restore
  # sit inside compileCallExpression's dispatch block (+33), and the
  # non-constructor guard dispatch sits in compileNewExpression's early
  # chain (+11). Neither can move out without moving the dispatch itself.
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/new-super.ts::compileNewExpression
loc-budget-allow:
  # calls.ts (+35): both edits are arms of the ONE `.call`/`.apply` dispatch
  # block. The sloppy-`this` reshape must sit at the TOP of that block (above
  # the several receiver-install lowerings it exists to unify), and the inlined
  # receiver bind/restore has to wrap Case 0's `compileCallExpression` call —
  # it needs that arm's `fnExpr`, its `directArgs`, and its early return. The
  # decision logic itself lives in the two satellite modules; what is left here
  # is the ordering, which cannot move without moving the dispatch.
  - src/codegen/expressions/calls.ts
  # new-super.ts (+12): one guard dispatch in `compileNewExpression`'s early
  # chain plus its rationale comment. Placement is load-bearing (after the
  # intrinsic-name interceptions, before the class-expression / unknown-ctor
  # paths), so it can only live in that chain; the guard body is a satellite.
  - src/codegen/expressions/new-super.ts
origin: "2026-08-08 — ES5-standalone-90 Wave 4, function `this`/TypeError semantics"
---

# #4246 — `new` on a non-constructor, and sloppy `this` coercion

Wave 4 of [es5-standalone-90](../goals/es5-standalone-90.md), continuing
#4221 (call-site TypeErrors) and #4243 (`arguments`).

Three independent root causes, all of the same shape as #4221's: **the program
kept going with the wrong value** rather than failing anywhere a conformance
number would notice. Nothing crashed; an assertion just compared against
something plausible.

Test coverage: `tests/es5-standalone-this-and-construct.test.ts`.

## Baseline

59 files — every non-`eval`/`Function`-gated ES5 failure under
`language/expressions/{new,assignment}`, `language/function-code`,
`Function/prototype/{call,apply}`, plus the coordinator's three adjacent
untagged files — measured **sequentially** with `runTest262File` on the Wave-3
branch tip: **16 / 59 pass**.

Two method notes, both inherited from #4221/#4243 and both re-confirmed here:

- A fresh worktree has no runtime-eval provider cache, so five files report an
  `Import #0 module="js2wasm:runtime-eval"` instantiation error instead of their
  real signature. `node --import tsx scripts/build-runtime-eval-provider.mjs
  --refusal-only` builds it (the bare `node` form fails).
- **Node 25 is required.** Under the container default (Node 22) early-error
  validation manufactures phantom regexp-modifier failures.

## Root cause 1 — `new <non-constructor>` answered `undefined`

§13.3.5.1 step 4: after evaluating the constructor expression, a value that is
not a constructor throws a **TypeError**. `compileNewExpression` had arms for a
non-constructable *shape* (arrow, prototype method — #730/#1528/#4017) but none
for a callee that is provably not an object at all, so every one of these fell
through the unknown-constructor path and evaluated to `undefined` with no throw:

```js
new true;  new 1;  new "s";  new null;  new undefined;
var x = true; new x;
new new Boolean(true);
new x;                      // `x` undeclared — wants ReferenceError, not TypeError
```

### Fix

`src/codegen/expressions/new-non-constructable-value.ts` — the `new`-site twin
of #4221's `tryNonCallableValueCall`, reusing that guard's
`NEVER_CALLABLE_FACT_KINDS` / `isEvolvingAnyBinding` /
`isFreshlyConstructedNonCallable` rather than re-deciding them. That sharing is
the point: the two sites answer the same question ("does the oracle PROVE this
value has no internal method?") and carry the same false-positive hazard (a
wrong fire converts working code into a hard throw), so a second copy of the
judgement is how the two would drift.

Two ways [[Construct]] is narrower than [[Call]] are deliberately NOT exploited
here — arrows and prototype methods are callable but not constructable, and both
already have their own (subtler) arms in `non-constructable.ts`.

The **unresolvable-identifier** arm is separate on purpose: §9.1.1.1 step 3
fires while evaluating the constructor *expression*, one step earlier and with a
different error class. The unknown-ctor path never compiled its callee at all,
so `new x` with no `x` in scope silently answered `undefined`.

#### The hazard that arm introduced, and the guard against it

A `ts.factory`-built identifier has `pos === -1` and therefore **no checker
symbol** — indistinguishable from an undeclared name. Several lowerings rewrite
a call/construct into a fresh AST (`Function.prototype.apply.call` reshape, the
`.call`→direct-call reshapes, and root cause 2 below), so without a synthesized-
node check this arm would turn every such rewrite into a ReferenceError. It is
`nodeIsSynthesized` in that module, and it is load-bearing rather than
defensive — root cause 2's own rewrite trips it.

The binding question routes through the oracle's existing
`isUnresolvableIdentifier` rather than a raw `ctx.checker` site under
`src/codegen` (oracle-ratchet, #1930/#3273). A first cut added a new
`resolvesToBinding` method before noticing that seam already existed; it was
removed rather than left as a second spelling of one boundary question.

## Root cause 2 — a sloppy callee bound a PRIMITIVE `this` verbatim

§10.2.1.2 step 5.b (ES5 §10.4.3 step 3): a non-strict function called with a
primitive `thisArg` binds `ToObject(thisArg)`.

```js
function bar() { return typeof this; }             bar.call(1)   // want "object", got "number"
function foo() { "use strict"; return typeof this; } foo.call(1) // "number"  ✓ already right
```

The nullish half of the same step (`undefined`/`null` → the global object) landed
as #4190/#4203; the primitive half was never supplied. `.call`/`.apply` threaded
the raw primitive into `__current_this`.

### Fix

`src/codegen/expressions/sloppy-this-toobject.ts` rewrites
`f.call(1, …)` → `f.call(new Number(1), …)` **once**, at the top of the
`.call`/`.apply` dispatch, above the three different receiver-install lowerings
(named-`this` trampoline, closure-receiver install, explicit-this-param direct
call). Putting the decision below the split would put the same §10.2.1.2
judgement in three places, which is exactly how the strict and sloppy answers
drift apart. The wrapper produced is the same `$Object`-with-`[[PrimitiveValue]]`
a source-level `new Number(1)` already builds (#1910/#1472 S2), so `valueOf`,
`.constructor` (#4223) and the string-index exotics (#4232) come out right by
construction instead of needing arms here.

Three gates, each a refusal rather than an approximation:

1. **The CALLEE must be sloppy** — strictness is a property of the function
   being entered, not of the call site. `10.4.3-1-1-s` is exactly the pair (one
   strict callee, one sloppy, same call site), so a call-site test fails half of
   it.
2. **The body must reference its own `this`** — boxing is semantically harmless
   otherwise, but would allocate a wrapper (and pull the wrapper runtime into
   the module) for every `.call(0, …)` in a corpus where most callees ignore
   `this`.
3. **The primitive must be PROVEN** — an `any`/union receiver is left alone. A
   missed box keeps today's answer; a box on a value that turns out to be an
   object would be a NEW wrong answer.

`.bind` is deliberately not rewritten: [[BoundThis]] is coerced when the bound
function is *called*, and the carrier stores the raw value.

## Root cause 3 — an inlined function-expression callee dropped its receiver

```js
var obj = {};
(function () { this.touched = true; }).call(obj);
obj.touched                                    // undefined
```

Case 0 of the `.call`/`.apply` dispatch rewrites a function LITERAL callee into
a direct invocation and reuses the IIFE-inlining path (which is what makes
`arguments` come out right, #1596). It evaluated the receiver purely for side
effects and dropped it — "standalone functions ignore `this`", true for the
shapes that arm was written for.

**Why this survived: the failure is asymmetric.** With the body inlined into
`__module_init`, a `this` READ falls through the ThisKeyword ladder to
`emitUnboundThis`, which for sloppy code answers the global object (#4190) — so
`typeof this` is `"object"` and looks fine. Only the identity is wrong, and every
property WRITE silently lands on the global object.

### Fix

`src/codegen/expressions/inlined-call-receiver.ts` binds the receiver as a real
`this` LOCAL for the duration of the inline. Inlining is precisely the claim
that the callee's body executes in this frame, so giving the frame a `this`
local is the same statement — and it needs no new arm in the `this` lowering,
which matters because that lowering is a five-way ladder
(#3365 / #1636-S1 / #1702 / #4190 / #4203) where an extra arm is how strict and
sloppy answers diverge. The binding is saved and restored around the inline.

Two gates:

- **Function expressions only, never arrows.** An arrow has no `this` binding to
  coerce; installing one would be a new wrong answer, not an improvement.
- **A receiver the oracle proves non-nullish.** `.call(null)` / `.call(undefined)`
  are not "pass null as `this`" — §10.4.3 substitutes the global object (sloppy)
  or `undefined` (strict), and both answers are already correct today.
  Installing the raw nullish value would replace two right answers with one
  wrong one.

## Measured flips

Standalone lane, `runTest262File`, sequential, same 59-file list on both sides:

| bucket | before | after |
| --- | --- | --- |
| `language/expressions/new` | 0 / 11 | **10 / 11** |
| `language/function-code` (clean subset) | 1 / 14 | **4 / 14** |
| `Function/prototype/{call,apply}` (clean subset) | 0 / 6 | **2 / 6** |
| `language/expressions/assignment` (clean subset) | 1 / 12 | 1 / 12 |
| adjacent untagged (`toString`, `A7_T4`) | 14 / 16 | 14 / 16 |
| **total** | **16 / 59** | **31 / 59** |

**+15 flips, 0 regressions in-list.** Per root cause: RC1 +11 (10 `new` files +
the ReferenceError file), RC2 +3 (`10.4.3-1-{1,2,4}-s`), RC3 +2
(`S15.3.4.{3,4}_A5_T6`).

### Regression sampling

All 18 `tests/es5-standalone-*.test.ts` wave suites: **222 / 222 pass**.

A 235-file deterministic cross-section of every directory these changes can
reach — `language/{expressions/{new,call,assignment,function},statements/function,
function-code,arguments-object}` and `built-ins/{Function,Object,Array/prototype,
String/prototype,Number,Boolean}` — run **sequentially** on both sides of a
file-copy A/B (`git show HEAD~2:<path>` for the base arm; never `git stash`,
which is a single shared stack across worktrees):

| arm | pass | fail | delta |
| --- | --- | --- | --- |
| without #4246 | 159 | 76 | — |
| with #4246 | 160 | 75 | **+1 gain, 0 regressions** |

The single in-sample gain is `expressions/new/S11.2.2_A3_T1`; the other 14
flips are outside the sample (the sample is a 1-in-11 slice, and the flips
cluster in two small directories). What the sample is actually for is the
denominator: 235 files across the reachable surface, byte-identical except for
that one row.

The measurement is sequential for the reason #4221 and #4243 both recorded:
`runTest262File` reports a TIMEOUT as `compile_error`, so a parallel sample on
a loaded box manufactures phantom regressions.

**gc lane** — all three root causes are lane-independent (the `new` guard and
the sloppy-`this` reshape are pure AST decisions; the inlined receiver binds a
local), so the host lane was A/B'd on the same corpus, a 118-file half of the
cross-section:

| arm | pass | delta |
| --- | --- | --- |
| gc without #4246 | 89 | — |
| gc with #4246 | 90 | **+1 gain, 0 regressions** |

## Deliberately NOT in scope (leftovers, with the mechanism named)

- **`new new Math()`** (`S11.2.2_A4_T5` CHECK#2) — the outer `new`'s callee is a
  NewExpression whose TS type is an ERROR type (`Math` has no construct
  signature), so its oracle fact is `any`, not `builtin`/`class`/`object`, and
  the fresh-`new` arm cannot fire. The real defect is one level up: the
  unknown-constructor path does not EVALUATE its constructor expression at all
  (§13.3.5.1 step 2), so the inner `new Math()` — which would throw on its own —
  is never compiled. Widening the fresh-`new` arm to `any` is not the fix: a
  constructor may legitimately return a function. Fix by evaluating the callee in
  the unknown-ctor path.
- **`.call(null)` reaching the GLOBAL object as a mutable receiver**
  (`S15.3.4.{3,4}_A3_T6`) — `this.feat = "…"` inside a sloppy `.call(null)`
  callee must write to the global object and be observable as `this["feat"]` at
  script top level. Blocked on the global-object model (#4202/#4205), same
  blocker as #4221's `11.2.3-3_8`.
- **`typeof obj.call === "function"`** (`S15.3.4.{3,4}_A1_T2`) — needs
  `Function.prototype` to be reachable as an object whose `call`/`apply` are own
  properties on a user object's prototype chain.
- **Strict assignment TypeErrors** — scoped, then deliberately dropped after
  reading the files: the bucket is FOUR mechanisms, not one, and only one is
  in the assignment lowering. `Math.PI = 20` / `Function.length = 42`
  (`11.13.1-4-{28,29}gs`, `-4-6-s`) need non-writable BUILTIN STATIC properties;
  `global.Infinity = 42` / `global.undefined = 42` (`-4-3-s`, `-4-27-s`) are the
  global-object model again; `8.14.4-8-b_{1,2}` need the inherited-non-writable
  check in ordinary [[Set]], which lives in the object runtime that another lane
  owns. Filed as observations rather than attempted, because a fix confined to
  "the assignment lowering" reaches none of them.
- **`S11.13.1_A7_T4`** (coordinator's bonus item) — `base[prop] = expr()` must
  call `ToPropertyKey(prop)` exactly once and before the RHS. Genuinely in the
  assignment lowering, but it is an evaluation-ORDER defect independent of every
  root cause here, so it is a separate change.
- **`Function.prototype.toString/{name,not-a-constructor}.js`** (coordinator's
  bonus items) — the two failing files in that directory. `name.js` wants
  `Function.prototype.toString`'s own `name` descriptor to be configurable;
  `not-a-constructor.js` wants `new (Function.prototype.toString)()` to throw —
  a builtin-function-object descriptor question, not a `new`-site one (the guard
  here declines because the callee is a real function value). Both need the
  builtin-function-object property model.
- **`10.4.3-1-{103,104,106}`** — `Object.defineProperty(Object.prototype, "x",
  {get(){return this}})` then `(5).x`. Needs an accessor inherited from
  `Object.prototype` to fire on a PRIMITIVE receiver, with the §10.4.3
  strict/sloppy split applied to the getter's `this`. Adjacent to root cause 2
  but a different site (property access, not `.call`).
- **`S10.2.1_A{1,4,5.2}`** — FunctionDeclarationInstantiation ordering:
  `function f(x){ var x; …}` must not reset the parameter, and a hoisted function
  declaration must REPLACE a same-named parameter (§10.2.11 steps 22-27). Three
  files, one coherent family, entirely in declaration instantiation — worth its
  own issue.
- **`new Number(5).valueOf()` through `new (Number as any)(5)`** — noticed while
  building a negative control; answers something other than 5. Pre-existing
  (reproduces with every change here reverted) and unrelated.
- **`new C(7)` where `C` is an `any` binding holding a `function` declaration** —
  crashes at runtime. Verified pre-existing by file-copy A/B against the same
  probe. A `class` through an `any` binding works, which is why the guard's
  negative control uses that shape.
