---
id: 4515
title: "ES5 standalone language-misc: 110-row cluster — ToPrimitive in binary ops, `in` on plain objects, arguments-object, completion values, ++/-- ReferenceError (2026-08-16 census)"
status: ready
created: 2026-08-16
sprint: current
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
es_edition: 5
goal: es5
related: [2668, 1888, 3626, 2666, 4504]
# NOTE (2026-08-23 wave-5): this key was DUPLICATED in the frontmatter — two
# separate `loc-budget-allow:` blocks — so a YAML parser kept only the second
# and the `src/codegen/closures.ts` grant was silently dead. Merged into one.
loc-budget-allow:
  # 2026-08-19 accessor-pair fix: for an accessor PAIR, TypeScript takes the
  # property type from the GETTER's return and requires the setter's parameter
  # to match, so `set foo(v)` beside a string-returning getter infers `v: string`
  # and __call_fn_method_1 casts the incoming externref with an UNGUARDED
  # ref.cast — `o.foo = 1` traps. Predicate + rationale live in the new leaf
  # module src/codegen/closures/set-accessor-param.ts; the god-file grows by the
  # IMPORT LINE ONLY (+1).
  - src/codegen/closures.ts
  # One field. The §13 eval completion register is a FunctionContext slot; the
  # register's whole lifecycle and rationale live in the new leaf module
  # src/codegen/statements/eval-completion-value.ts, and eval-inline.ts SHRANK.
  - src/codegen/context/types.ts
  # A carrier-bag miss on a fnctor must continue through the constructor's
  # prototype object before the builtin-prototype fallback.
  - src/codegen/object-runtime.ts
func-budget-allow:
  # Extend the existing `__extern_has` builder with the same fnctor prototype
  # walk already used by value reads.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  # 2026-08-23 wave-5, §14.15.3 step 5 (a NORMALLY-completing `finally`
  # contributes no completion value). +2 LINES, both calls: the snapshot local's
  # lifecycle, the abrupt-exit argument and the clone-safety argument all live in
  # the leaf src/codegen/statements/eval-completion-value.ts. They cannot move
  # out of this function: the save/restore must be emitted INTO the pre-compiled
  # `finallyInstrs` scratch body that compileTryStatement clones into each
  # control-flow path, between its own `pushBody`/`popBody` pair, so any split
  # would have to carry that body-swap protocol with it.
  - src/codegen/statements/exceptions.ts::compileTryStatement
  # 2026-08-23 wave-5, the ANSWER half of the #4484 D guard: a reassigned
  # binding's stale static type must not decide `in` either. The predicate is
  # ONE line plus one extra term in an existing condition; the +24 is the
  # rationale comment, and it belongs here rather than in a leaf module —
  # splitting a one-line predicate out would not shrink this function below its
  # baseline anyway (the gate is a no-growth ratchet), so it would buy nothing
  # and move the reasoning away from the four other route conditions it has to
  # be read against.
  - src/codegen/binary-ops-in.ts::compileInOperator
---

# ES5 standalone `language/` misc — 110 rows, ~7 mechanisms

## Source

2026-08-16 standalone census: ES5 bucket 8,454 / 9,029 pass, 575 nonpasses.
This issue owns the 110 rows under `language/` that are NOT with-statement,
statements/function, identifier-resolution/function-code, or literals/regexp.
Full file list + signatures:
`plan/log/analysis-2026-08-16-es5-standalone-575.md` (§language-misc and the
sub-triage table).

## Mechanism hypotheses (verify per-file before sizing — #3626 method)

| sub-bucket | n | hypothesis |
|---|---|---|
| types/object + expressions/in | 15 | `in` operator on plain `{}` must consult the prototype chain (`"valueOf" in __obj` → true) |
| expressions/assignment | 10 | compound assignment × property descriptors |
| equals/relational/addition | ~12 | ToPrimitive (valueOf/toString) on objects in binary operators; function-to-string in `f + ""` |
| expressions/instanceof | 7 | `[[HasInstance]]`: TypeError for non-Function RHS, prototype-chain walk |
| property-accessors + call | 11 | member access on undefined/null throws TypeError at the right point |
| arguments-object | 7 | `callee` own property + strict descriptor; arguments in nested scopes |
| statements/variable | 5 | var/function-decl shadowing order |
| do-while/while/return/switch | ~11 | completion values / evaluation order |
| ++/-- + types/reference | ~10 | ReferenceError on unresolvable reference; ToNumber ordering |
| singletons | ~19 | diffuse — fix opportunistically, don't chase |

## Acceptance

- Work the sub-buckets top-down; for each, verify the mechanism on 2-3 files
  with the single-file runner BEFORE writing a fix
  (`runTest262File(f, cat, 30000, "standalone")`, see
  `tests/test262-runner.ts:4428`).
- Each landed fix names the sub-bucket and the measured flip count (scoped
  standalone lane run over the sub-bucket paths, denominator stated).
- No host-import regressions: standalone fixes must be Wasm-native
  (CLAUDE.md dual-mode rule).
- Do NOT claim the whole 110 as a flip forecast anywhere.

## Method warnings

- Prebuild the eval provider or eval-shaped rows report manufactured failures
  (#4354): `pnpm run build:compiler-bundle && node scripts/build-quickjs-eval-provider.mjs`.
- An assertion that can throw before the probed value is read measures the
  throw, not the value — run a negative control (#3626 §2.2.1).

## 2026-08-19 re-census + dispatch

Fresh standalone baseline (`test262-standalone-current.jsonl`, 48,735 entries,
fetched 2026-08-19 04:52): standalone ES5 is **8,506 / 9,029 (94.2 %)** with
**523 non-passes** (495 fail, 24 compile_error, 4 compile_timeout). Earlier
figures in this file predate that and should be read as history.

This issue's lane in the 2026-08-19 6-way fan-out: **157 rows — language/ statements, expressions, types (largest lane)**.
Umbrella + full partition: #4163.

The residue is a **long tail** — the largest single error signature across all
523 rows is 13. Expect many small root causes, not one lever.

Local gate for this lane: 551 locally-verified-passing standalone ES5 tests must
stay at 551/551. Reproduce with the `--standalone` flag (without it you measure
the JS-host lane, a different and much worse corpus at 84.8 %).

**eval-rooted rows cannot be validated on the dev Mac** — CI's QuickJS eval tier
needs clang-18 (see #4163 for the full toolchain finding); record them as
blocked rather than chasing them.

## 2026-08-19 lane findings (in progress)

### Fixed — `f.length` counts a SYNTHESIZED parameter

`function f(x, y) { return arguments; }` reported `f.length === 3`. TypeScript's
JS inference **synthesizes a trailing `args` parameter** on any function that
mentions `arguments`, and `expectedArgumentCountOfSignature`
(`src/codegen/function-expected-argument-count.ts:84`) counted it because it has
no `valueDeclaration`. Now reads `sig.declaration.parameters` — the actual
FormalsList, which is what §15.1.5 counts.

Verified: `language/expressions/call/S11.2.4_A1.{1,2}_T2` both flip to PASS, and
the #4436 controls (`language/{statements,expressions}/function/length-dflt.js`)
still PASS.

### Not fixed — a get/set PAIR on the same key is a hard trap in standalone

```js
var o = { set foo(v) {}, get foo() { return "G"; } };
o.foo = 1;
// RuntimeError: illegal cast in __call_fn_method_1
//   (via __call_accessor_set ← __extern_set)
```

Decisive controls: a setter **alone** works, and get+set on **different** names
works — so the setter slot ends up holding the arity-0 getter. Emission order in
`literals.ts` (~line 1090) is getter-then-setter and looks correct, so the defect
is below that, in `compileArrowAsClosure` or the `$PropEntry` store.

Gates 3 lane rows
(`language/reserved-words/ident-name-{keyword,global-property-accessor,reserved-word-literal}-accessor.js`)
plus anything else using an accessor pair.

### Two corrections to this issue's own census

- **The 4 `timeout (10s)` rows are NOT compiler hangs.**
  `language/comments/S7.4_A{5,6}` run **65,536 `eval()` calls** each, and
  `language/statements/for/S12.6.3_A10{,.1}_T1` are 9-deep nested loops. They are
  genuinely slow tests, so they should not be triaged as a hang cluster.
- **5 of the 6 `Scope chain disturbed` rows need `with`** (owned by #4206); only
  `S10.2.2_A1_T3` is plain var-hoisting and reachable here.

That removes ~9 rows from this lane's reachable pool.

## 2026-08-19 — `language/expressions/**` slice (branch `es5-language-expr`)

Lane **0 → 8 of 51**, `target=standalone`, guard 551/551.

### 1. Equality operators DISCARDED their operands' side effects (`2ee642ef`)

```js
var calls = 0;
var u = function () { calls++; };
u() == 1;      // calls === 0 — the call was never emitted
```

`==`, `!=`, `===`, `!==` all did it; `+`, `<`, `in`, `instanceof` were fine. The
trigger is an operand whose static type is `void`/`never` — which is what
TypeScript infers for `function () { throw "x"; }`.

`compileBinaryExpression` emitted the operand code — 30 instructions, the call
included — then hit `if (!leftType || !rightType) return null;` because a void
operand yields no value. The caller read `null` as "not handled", **rolled the 30
instructions back**, and substituted the statically-correct `i32.const 0`. The
answer `false` was right; discarding the operand evaluation was not — §13.11.1
evaluates both operands regardless.

The four affected rows report `Actual: [object Object]`, which is a red herring:
nothing throws at all, so the Test262Error from the *next* line is what gets
caught.

Fix: evaluate both sides, drop whatever they produced, then emit the constant —
the pattern already used for the BigInt-vs-Number strict-equality fold. A
counter-operand that is `any`/`unknown`/nullable is not folded and keeps the old
return, so nothing that previously worked moves. Verified on a 14-case matrix
including `u() == null` (true), `u() === null` (false), `u() == u()` (true).
**+4 rows.**

**This is a silent wrong-behaviour bug for ordinary programs**, not a conformance
nicety: any `f() == x` where TS infers `void`/`never` for `f` loses the call.

vitest relative to the merge base — unchanged: 9 equality/operator suites 2
failed → the same 2; 41 operator-related `tests/equivalence/*` 1 file (5 tests)
→ the same 1. Pre-existing: `issue-2063-switch-strict-equality`,
`issue-2742-native-string-equality`, `equivalence/null-dereference-guards`.
`issue-3055` looked like a third regression in the combined run and is **not**
one — a 35 s timeout under load; 9/9 alone.

### 2. `this.p++` on a `var`-declared script global writes NaN — #4500's missing third site

```js
var x = 1; --x;   // x is a Script global, so `this.x` IS the same property
this.x = 1;
--this.x;         // NaN — and this.x stays 1
```

#4500 Slice A fixed the **read** arm (`property-access.ts`) and the **write** arm
(`assignment.ts`) so a `var`-declared script global routes to the module global
that stores it. The read-modify-write in `unary-updates.ts` was never updated: it
read the realm global **object**, which no longer holds the value, got
`undefined`, and stored NaN over the real one. The #4205 arm directly above
already declines the struct path for a realm-global receiver, so the only gap was
that nobody added the module-global arm beside it.

#4500's own note — *"the pair MUST land together; fixing only the read makes
`this.p = 2; this.p === 2` regress"* — was correct and simply needed a **third**
member. **+4 rows.**

### Remaining 43 — long tail, no dominant cluster

Largest visible micro-group is **ToPrimitive on object operands** in `+` and the
relational operators (5–6 rows). Then **getters reached through the wrong
receiver** (`o.foo` reads `null` instead of the getter's value, 3), and
`f_arg.length` on an `arguments`-returning function (2, which belongs with the
#4555 lane rather than here).

## 2026-08-19 — `language/` statements+types slice (branch `es5-language-core`)

**Lane 0 → 3. Denominator 102, not 106** — the 4 `timeout (10s)` rows all sit in
this half and are excluded from the A/B, since they time out in both arms. Base
re-measured by reverting the touched files in the same tree. The three flips are
`language/reserved-words/ident-name-{keyword,global-property-accessor,reserved-word-literal}-accessor.js`.

`75c03b8`'s two rows (`language/expressions/call/S11.2.4_A1.{1,2}_T2`) fell into
the `language/expressions/**` half after the split and are credited there; the
commit itself lives on this branch.

### The accessor-pair root cause was not where it looked

For an accessor **pair**, TypeScript takes the property's type from the
**getter's return** and requires the setter's parameter to match — so
`set foo(v)` beside `get foo(){ return "G"; }` infers `v: string`.
`__call_fn_method_1` then coerces the incoming runtime externref to that declared
ValType with an **unguarded `ref.cast`**, and `o.foo = 1` casts a number to
`$AnyString` → trap.

The descriptor readback was clean throughout (`gOPD(o,"foo").get.length === 0`,
`.set.length === 1`), emission order in `literals.ts` was correct, and the native
store takes getter/setter in the right slots — which is why this looked like a
wrong closure in the slot and was not. The three controls explain themselves once
the cause is known: a setter **alone** works (`v` is `any`), get+set on
**different** names works (no getter constrains `v`), and a **void** getter works
(nothing to cast to).

Fix: a set accessor's parameters stay externref — the same rule
`computeClosureWrapperSig` already applies to its unannotated-JS-default and
unbound-declaration arms.

**This is a wrong-behaviour bug for any object with a matched getter/setter
pair**, which is a common shape — well beyond the 3 conformance rows.

### Verification (the most thorough in this push)

- **Guard 551/551.** A run at HEAD first read 546/551; all 5 were
  `compilation timeout` (16–25 s) during the load spike and **all 5 pass** when
  re-run serially on the same tree.
- **vitest, base vs branch: 0 regressions.** 18 suites over the touched code.
  Base `f7df34f1`: 6 files failed, 15 tests failed / 189 passed / 1 skipped.
  Branch `a9d7ea08`: identical counts — and the sorted failing-test **name sets
  are byte-identical** (`diff` clean), not merely equal in count. All 15
  pre-existing.
- **Prototype-write corpus, both arms: 120 pass / 1 not-pass**, the same single
  QuickJS-provider row each side. Run strictly one-process-per-test via a
  `while read` loop.

### `2f4ad77` — §13 completion value out of a nested statement in `eval` (+5)

`eval` returns the Script's **completion value**, and §13 propagates it out of
nested statements. The inline path used a syntactic shortcut: "last top-level
statement is an ExpressionStatement → its value, else `undefined`".

The sputnik rows force a real runtime `V` register instead, because no deeper
syntactic search can answer them:

```js
eval("do { c++; if (…) continue; odds++; } while (c < 10)")   // 4
```

— the value is the last `odds++` **that actually ran**, reached through a
`continue` on every other iteration.

A local threaded on the `FunctionContext` gives that for free: it persists across
iterations, survives `continue`, and needs **no loop/block/if lowering changes** —
their children merely store instead of drop. Lifecycle and sink live in the new
leaf `src/codegen/statements/eval-completion-value.ts`; the sink is
**byte-identical to the old `drop`** whenever no register is active, and
`eval-inline.ts` shrank.

All five `language/statements/{do-while,while}` rows flip. **Lane 8/102** at the
committed HEAD, guard 551/551 (2 jobs, no timeout artefacts), prototype-write
corpus 120/121 unchanged, and a second vitest set (14 eval/loop suites, 201
tests) at 22 failing on **both** arms with byte-identical failing-name sets.

### Split accounting

`75c03b8`'s two `f.length` rows landed in the `language/expressions/**` half
after the split and are credited there; the commit lives on this branch. The
`Cannot access property on null or undefined` cluster is **2 rows in this half**,
not 4 — the other two went to the expressions lane.

### Routing correction — the 3 object-literal "getter" rows are NOT a getter family

Checked directly rather than by shape, and they are not one family at all, so
they should **not** be routed to #4555 alongside its primitive-receiver getters:

- `language/expressions/object/11.1.5-0-1.js` and `11.1.5-0-2.js` define the
  object **inside `eval()`** — eval-blocked locally (see #4163), not getter bugs.
  A direct `var o = { get foo() { return "In getter"; } }; o.foo` returns
  `"In getter"` correctly, so the getter machinery is fine.
- `language/expressions/object/S11.1.5_A2.js` involves no eval and no getter:
  `var x = this; var object = {prop: x}; object.prop === x` is
  **Script-global-`this` identity**, adjacent to the #4500 realm-global family.

#4555 keeps `f_arg.length` and its own primitive-receiver getters.

## 2026-08-20 follow-up — descriptor getter result carrier

Fresh #4504 triage isolated
`built-ins/Object/defineProperty/15.2.3.6-4-589.js` from prototype lookup. The
inherited setters already run, create no own properties, receive the Date RHS as
externref, and store it in an externref ref-cell. The remaining loss is on the
getter/result boundary: because the captured cell starts at numeric `1001`, the
getter closure is emitted with an f64 result ABI and ends by unboxing the stored
Date, so the read becomes `NaN`. Extend this issue's accessor dynamic-boundary
work to descriptor getter result carriers, or split a narrow follow-up before
implementation. #4504 must keep this row visible but excluded from its nine-row
descriptor-walk denominator.

### The relational/ToPrimitive bucket is spun out to #4564

Root-caused to the bottom and deliberately not landed: the #2059 recovery path is
**dead code** in standalone (`anyValueTypeIdx` is 45, so the
`ctx.anyValueTypeIdx < 0` gate never fires and `emitAnyRelational` is
unreachable), and the real implementation — `__any_lt/gt/le/ge` in
`any-eq-helpers.ts` — is the numeric branch of §7.2.12 only. Full spec, the
"no cheap subset" finding, and why the #1374 landmine does not apply to that
route: **#4564**.

## 2026-08-21 wave-2 reclassification (coercion lane, measured on the fixed tree)

The wave-2 plan's step-2/3/4 hypotheses did not survive measurement:

- **`language/types/object` (12 rows) is NOT ToPrimitive-adjacent.** Four
  unrelated mechanisms: (a) `"valueOf" in {}` false — the `in` operator does not
  consult `Object.prototype`, which standalone does not materialize (4 rows,
  incl. `expressions/in`); (b) `this.x = f; x()` global-binding identity
  (`S8.6.2_A5_T1..T4`); (c) prototype-chain reads (`S8.6.2_A1/A2/A8`) — protos
  lane's territory; (d) `__map.foo` reading `null` where NaN is expected.
- **The instanceof residue (5 rows) is blocked one level ABOVE #4480 R3**: with
  a reassigned binding (`var O = 0; O = Object`), the #4484 guard fires and
  routes to `tryEmitNativeDynamicInstanceOf`, which hits its deliberate
  conservative-`false` arm (`native-dynamic-instanceof.ts:451`) because a
  runtime constructor VALUE cannot be resolved to its prototype. Needs the
  #4480-family substrate (a real `.prototype` per function / materialized
  `Object.prototype`).
- **"Scope chain disturbed": 5-of-6 `with` split CONFIRMED** (T5-T9 → #4206).
  **T3 is not a scope bug**: the hoisted `var x = 1` sits after the `return`,
  the number-typed slot is read before its initializer, and the NaN-for-
  undefined convention surfaces — NaN where the row asserts `undefined`. Fixing
  it needs flow-sensitive slot widening (#4204 machinery) — representation
  level, reported not built.

Converging theme across (a), the instanceof arm, and the protos rows: **the
un-materialized builtin prototype substrate (#4480 family)** is now the single
largest identified blocker class in the language-core residue.

## 2026-08-23 wave-5 census (lead sweep on campaign HEAD, fresh bundle+adapter)

Live failing rows in this issue's territory, re-verified failing by the lead's
own sweep (`.tmp/sweep-wave4b.jsonl`). Clustered by apparent root — VERIFY each
cluster live before trusting the grouping (methodology 1):

**C1 — builtin/ctor reflected as a VALUE (7).** The recurring errors are
`is not a constructor`, `not yet callable as a value`, and
`Function.prototype.toString is not yet implemented`:
```
built-ins/Error/prototype/constructor/S15.11.4.1_A1_T2.js
built-ins/Object/prototype/constructor/S15.2.4.1_A1_T2.js
built-ins/Array/prototype/concat/S15.4.4.4_A2_T1.js     concat as a value
built-ins/Array/prototype/concat/S15.4.4.4_A2_T2.js
built-ins/Array/S15.4.3_A1.1_T2.js                      Array.toString()
built-ins/Error/length.js                               err1.constructor.length
language/expressions/addition/S11.6.1_A2.2_T3.js        f1 + 1 === f1.toString() + 1
```

**C2 — assignment/reference layer + scope chain (8):**
```
language/expressions/assignment/S11.13.1_A6_T1.js   innerX === undefined, got 1
language/expressions/assignment/S11.13.1_A6_T2.js   innerX === 2, got 1
language/expressions/assignment/8.12.5-3-b_1.js
language/expressions/assignment/S8.12.5_A2.js       null-pointer in __str_concat()
language/identifier-resolution/S10.2.2_A1_T3.js     scope chain disturbed
language/statements/with/S12.10_A5_T5.js            x === 1, got undefined
language/types/reference/8.7.2-1-s.js               expected ReferenceError
language/statements/try/12.14-7.js                  e instanceof ReferenceError
```

**C3 — `in` / `instanceof` with a comma-expression LHS (4):**
```
language/expressions/in/S11.8.7_A2.4_T1.js          (NUMBER = Number, "MAX_VALUE") in NUMBER
language/expressions/instanceof/S11.8.6_A2.4_T1.js  (OBJECT = Object, {}) instanceof OBJECT
language/expressions/instanceof/S11.8.6_A6_T4.js    [[HasInstance]] on a non-Function
language/expressions/instanceof/S15.3.5.3_A3_T2.js
```
The first two share one wording: the assignment-inside-comma is evaluated but
its RESULT is not what the operator receives. Likely one root.

**C4 — accessors in an object literal (2):** `language/expressions/object/11.1.5-0-1.js`,
`11.1.5-0-2.js` — `o.foo` answers `null` instead of running the getter.

**C5 — arguments object descriptors (4):** `language/arguments-object/10.6-13-a-1.js`,
`10.6-6-2.js`, `10.6-7-1.js`, `S10.6_A5_T4.js` — `length` descriptor
configurability. **Overlaps #4491** (dev-4491 landed a `freeze`-on-arguments
fix in wave 4); check its wave-4 results before touching these.

**C6 — singles, verify individually (6):** `built-ins/JSON/parse/S15.12.2_A1.js`,
`built-ins/Object/create/15.2.3.5-4-15.js`,
`built-ins/Object/prototype/S15.2.4_A1_T2.js`,
`built-ins/Object/prototype/valueOf/S15.2.4.4_A14.js`,
`language/types/object/S8.6.2_A8.js` (prototype of non-extensible object
mutated), `language/types/boolean/S8.3_A1_T1.js`,
`language/statements/for/head-init-expr-check-empty-inc-empty-completion.js`,
`language/statements/try/S12.14_A18_T6.js`,
`annexB/language/statements/try/catch-redeclared-var-statement.js`,
`language/directive-prologue/14.1-4-s.js` + `14.1-5-s.js`.

Triage-first: measure the cluster roots, fix the largest, attribute the rest.

## 2026-08-23 wave-5 results (dev-4515, branch `issue-4515-wave5`)

Base for every number below: the campaign tip **`8794ab2c9`**, which INCLUDES
dev-4491's wave-4 merge `fbfe60815` — the lane started on `c42bdbe3e`, merged
the tip mid-flight when the lead flagged it, and **re-measured everything on the
merged tree**. The base arm is that tree with only this lane's seven source
files reverted, in the same worktree (`.tmp/base/`, `.tmp/arm.sh`), and the
compiler bundle + quickjs eval adapter are REBUILT on each arm.

**All 36 census rows re-verified failing on the base arm before any edit**
(methodology 1). The clustering held for C3/C5 and did NOT for C1/C4/C6 — see
below.

### Test Results

| run | files | base pass | branch pass |
|---|---|---|---|
| scoped standalone sweep, both arms, this lane's own runs | **291** | 222 | 237 |

**Serially re-confirmed: 14 flips, 0 regressions.** The parallel sweep reported
15; `built-ins/eval/length-non-writable.js` PASSES ON BOTH ARMS when re-run
serially and was a contention artifact (the box sat at load 20–30 for the whole
session; two sibling lanes reported the same class of fake independently). Every
apparent flip was re-run one-process-at-a-time on both arms before being counted.

The 14, all confirmed serially:

```
language/directive-prologue/14.1-4-s.js                     root 1  (census C6)
language/directive-prologue/14.1-5-s.js                     root 1  (census C6)
language/expressions/in/S11.8.7_A2.4_T1.js                  root 3  (census C3)
language/statements/for/head-init-expr-check-empty-inc-empty-completion.js
                                                            root 2a (census C6)
language/statements/if/cptn-else-false-abrupt-empty.js      root 2a
language/statements/if/cptn-else-true-abrupt-empty.js       root 2a
language/statements/if/cptn-no-else-true-abrupt-empty.js    root 2a
language/statements/with/cptn-abrupt-empty.js               root 2a
language/statements/empty/cptn-value.js                     root 2b
language/statements/const/cptn-value.js                     root 2b
language/statements/let/cptn-value.js                       root 2b
language/statements/try/cptn-finally-wo-catch.js            root 2c
language/statements/try/cptn-finally-skip-catch.js          root 2c
language/statements/try/cptn-finally-from-catch.js          root 2c
```

Controls that must NOT move, verified `pass` on both arms serially:
`do-while/S12.6.1_A8.js` (the row the wave-3 register was built for),
`do-while/cptn-{abrupt-empty,normal}.js`, `labeled/cptn-{break,nrml}.js`,
`switch/cptn-abrupt-empty.js`.

**Scope of the sweep, stated so it is not read as more than it is.** 291 files,
not the full census directories — the box was saturated and a 2,740-file two-arm
run was not completable. The set is the *directly-affected population* plus the
census, not a sample: every `cptn*` file in the corpus (97), `directive-prologue`
and `expressions/in` in full, `built-ins/eval`, every eval-CALLING file in the
completion-value statement directories, this issue's 36 census rows, and — the
part that makes root 1's coverage complete rather than sampled — **all 16 files
in the entire corpus whose source contains a string literal starting `use` with
a backslash in it**. No other file can reach the strictness change.

Other suites, both arms, this lane's runs:
- `tests/issue-4515-wave5.test.ts` — **22 passed** (a count, not an exit code).
- `tests/issue-4491-wave4.test.ts` on the combined tree — **14 passed**, so this
  change does not disturb the sibling lane it merged.
- 11 scoped `tests/equivalence/` files, per-file loop (they OOM in one vitest
  invocation): 116 tests, **1 failed on BOTH arms** (`arguments-nested-and-loops`),
  byte-identical summaries — 0 regressions.

### Landed — three roots, 14 rows

#### 1. A Use Strict Directive is matched on the RAW token (§11.2.2) — +2

Every call site compared `stringLiteral.text`, the COOKED value. §11.2.2 says a
Use Strict Directive *"may not contain an EscapeSequence or LineContinuation"*,
so both of these are ordinary (non-directive) ExpressionStatements and their
functions stay SLOPPY:

```js
function foo() { 'use str\
ict'; return this !== undefined; }   // answered false, spec true
function bar() { 'use strict'; return this !== undefined; }  // same
```

`foo.call(undefined)` substitutes the global object in a sloppy function, so the
answer is `true`; treating the directive as real leaves `this` genuinely
`undefined`. **This is not a conformance nicety** — strictness drives `this`
substitution, the mapped-vs-unmapped `arguments` split, assignment-to-
unresolvable-reference and the eval early-error set, so a mis-read directive
silently over-restricts an ordinary program.

One predicate now, `src/codegen/helpers/use-strict-directive.ts`, used by
`is-strict-function.ts`, `eval-inline.ts` and `eval-early-errors.ts`. A
synthesized node with no readable source token keeps the cooked comparison
(absent-not-wrong: a synthesized `"use strict"` is one this compiler emitted).

Flips: `language/directive-prologue/14.1-4-s.js`, `14.1-5-s.js` (both C6).

**The affected population is enumerable and was enumerated**, which is stronger
than a sweep: only a string literal that cooks to `use strict` with a backslash
in its raw token can change, and a corpus-wide grep finds **16 files** in all of
test262.

#### 2. §13 completion value — three missing halves of the wave-3 `V` register — +9

The register (`2f4ad77`, earlier in this issue) modelled "an ExpressionStatement
that runs updates `V`". That is one third of §13.

(a) **`if` / `try` / `switch` / `with` and every loop RESET `V`** —
`UpdateEmpty(stmtCompletion, undefined)` (§14.6.2 / §14.15.3 / §14.12.4 /
§14.11.2) and `Let V be undefined` at loop entry (§14.7.x). `Block` and
`LabelledStatement` deliberately do NOT: they thread the inherited value
(`UpdateEmpty(s, sl)`). **That list was reference-checked, not read off the
grammar** — `eval("1; lbl: {}")` is `1` while `eval("1; if(false);")` is
`undefined`, and a grammar-only reading gets Labelled wrong.

The census row that exposed it:

```js
eval("for(count=0;;) {if (count===supreme)break;else count++; }")   // undefined
```

The `break` sits inside an `if`, so the iteration's completion is
(break, **undefined**), not (break, empty), and the loop's `UpdateEmpty` has
nothing to fill. We answered `4`, the last `count++` to run.

Emitting the reset at STATEMENT ENTRY *is* `UpdateEmpty(…, undefined)`: a branch
that produces a value overwrites it; a branch that produces nothing (`break`,
`continue`, an empty block, a declaration) leaves the `undefined`.

(b) **The register spans the whole StatementList**, not just the tail. §16.1.7
threads `V` across the list, so a value-less tail answers with the last
statement that DID produce one — `eval("2;;")` is `2`, `eval("4; const t = 5;")`
is `4`. Both answered `undefined`. The ExpressionStatement-tail fast path is
deliberately left in place (such a tail always overwrites `V` last, and keeping
it preserves the abrupt `eval("throw 1")` result).

(c) **A normally-completing `finally` contributes nothing** — §14.15.3 step 5,
*"If F.[[type]] is normal, let F be C"*. Snapshot `V` before the block, restore
after. Putting the restore at the END of the protected sequence makes the ABRUPT
arm right for free: a `break`/`continue`/`return` out of the finally branches
PAST the restore, which is step 7 (`eval("1; do { try { 2; } finally { 3; break;
} } while(true)")` is `3`).

Flips: `language/statements/if/cptn-{else-false,else-true,no-else-true}-abrupt-empty.js`,
`with/cptn-abrupt-empty.js`, `try/cptn-finally-{wo-catch,skip-catch,from-catch}.js`,
`{empty,const,let}/cptn-value.js`, `for/head-init-expr-check-empty-inc-empty-completion.js`.

Controls unchanged: `do-while/S12.6.1_A8.js` (the row the register was built
for — the `continue` inside an `if` now carries `undefined` and the answer is
still `4`), `do-while/cptn-{abrupt-empty,normal}.js`, `labeled/cptn-{break,nrml}.js`,
`switch/cptn-*`.

#### 3. `in` on a REASSIGNED binding asks the VALUE — +1 (C3, half)

The #4484 D guard already stopped a reassigned binding's stale static type from
producing a wrong THROW. The same staleness also produces a wrong ANSWER, from
the same type, four lines further down: `tsTypeHasProperty` reads
`rightType.getProperty(key)`, and TS widens `var NUMBER = 0; NUMBER = Number` to
the UNION `number | NumberConstructor`, where a property must exist on every
constituent — so `MAX_VALUE` is invisible and the fold answers `false`.

`__extern_has` decides from the value and already answers this correctly:
measured on this branch, `(function (x, k) { return k in x; })(Number,
"MAX_VALUE")` is `true` and the same with a bogus key is `false`. The site now
routes there when the receiver is a bare identifier the file writes to. Narrow
by construction — that population is exactly the one whose declared type is not
a fact about the site; every other receiver keeps its fold.

Flip: `language/expressions/in/S11.8.7_A2.4_T1.js` (both CHECK#1 and CHECK#2).

### Census re-clustering — what the wave-5 grouping got wrong

- **C1 (7) is one substrate, not seven bugs, and it is NOT reachable from this
  lane.** `Error.prototype.constructor`, `Object.prototype.constructor`,
  `Array.prototype.concat` as a value, `Array.toString()`,
  `err1.constructor.length` all need builtin prototypes materialised as real
  objects carrying `constructor`/`length` — the #4480 family. The one exception
  is `addition/S11.6.1_A2.2_T3`, which is **#4491 T4's** and is handed back with
  a precise root (below).
- **C3's two halves have DIFFERENT roots.** The `in` half is a stale-static-type
  fold (fixed). The `instanceof` half is the #2916 Slice B / #2660 M3 dynamic
  substrate, and it is *not* an identifier-resolution gap: measured on both arms,
  `(function (v, C) { return v instanceof C; })(new U(), U)` is **`false` for a
  plain user constructor** too, as is `({}, Object)`, `([], Array)` and
  `(new Error(), Error)`. `__instanceof_dynamic` answers its documented
  conservative `false` because no runtime constructor→prototype edge resolves.
  Fixing the RHS name resolution would have changed nothing.
- **C4 is not a getter bug.** Confirms this issue's own 2026-08-19 routing
  correction: `11.1.5-0-{1,2}` build the accessor object INSIDE `eval()`, and a
  direct `var o = { get foo(){…} }; o.foo` is correct. The accessor-PAIR trap
  recorded earlier in this file was fixed in wave 3 and is not what these rows
  hit.
- **C5 STILL FAILS after dev-4491's wave-4 merge** — re-verified on the merged
  tip at the lead's request. Narrowed: a NUMBER write to `arguments.length`
  sticks; a STRING write does not, the `length` descriptor reports
  `configurable/writable !== true`, and `typeof argObj.callee` answers
  `"number"`. So the residue is the arguments `length`/`callee` own-property
  descriptors, not element freeze. Left entirely to #4491.
- **C6 is genuinely diffuse and two of its members were the cheapest wins in the
  whole census** (the two directive-prologue rows). `language/statements/if/
  S12.5_A8.js` is a PARSE-phase SyntaxError row (`if()` with an empty
  expression), not a completion-value row.

### Residuals, with owners (all pinned `it.fails` in `tests/issue-4515-wave5.test.ts`)

| shape | owner |
|---|---|
| `(OBJECT = Object, {}) instanceof OBJECT` — and `new U() instanceof U` through a parameter | #2916 Slice B / #2660 M3 (runtime constructor→prototype edge) |
| `f + 1 !== f.toString() + 1` | **#4491 T4 — FIXED after this lane handed it back** (`60f32935b` on `issue-4491-t4-parity`), and **confirmed on the combined tree**: dev-4491 ran THIS lane's pin file against their fixed worktree and it failed with exactly `Expect test to fail`. Flip the `it.fails` to `it` at merge. See the correction below: the guard asymmetry this lane reported was real but NOT sufficient. |
| `arguments.length` string write / descriptor / `callee` | **#4491** |
| `var m = {1:"one", two:2}; m.two = "duo"` reads NaN | #4204 slot widening. This is also the root of `assignment/S8.12.5_A2`, whose reported `__str_concat` null dereference is one step DOWNSTREAM, in the assertion message. |
| a hoisted `var x = true` read before its initializer answers `false` | #4204 slot widening (same convention as the NaN-for-undefined case this issue recorded in wave 2) |
| the catch binding resolves after its block instead of throwing ReferenceError (`try/12.14-7`) | catch-clause scoping — unowned; the parameter is lowered to a plain function local |
| `eval("var x;")` inside a function must create the binding in the FUNCTION's variable environment (`assignment/S11.13.1_A6_T{1,2}`) | eval var-environment — unowned |
| `built-ins/Object/{prototype/S15.2.4_A1_T2, prototype/valueOf/S15.2.4.4_A14, create/15.2.3.5-4-15}`, `JSON/parse/S15.12.2_A1`, `types/object/S8.6.2_A8` | #4480 materialised builtin prototypes |

### An eval-scoping defect found while building the pins (unowned, NOT fixed here)

`eval("<loop>")` inside a minimal `export function test()` throws
`ReferenceError: <name> is not defined`, which is what stopped the first cut of
this lane's pins from running at all.

**Three narrowings were proposed and two were wrong. The live one is
dev-4653's third**, and it is theirs, measured on their tree with a 19-row
table (`plan/issues/4653-…md` residual R, probes `.tmp/probes/ev{1..6}.js`,
commit `82b8c2a1b`):

> Inside eval'd / `Function`-minted code, `++`/`--` throws `ReferenceError` for
> any name whose binding lives in a **FUNCTION variable environment** — the
> enclosing function's locals or parameters, a `Function` mint's parameters, or
> an eval-local `var` when the eval runs inside a function. It works for names
> bound in the **module/global** environment. Reads and `x = x + 1` work in
> every case.

Superseded, both labelled as such in their file: this lane's "an outer binding
in a `while`/`for` TEST position", and dev-4653's own "eval-local name, only
inside an enclosing function". `new Function("p","p++; return p;")(1)` throws at
MODULE TOP LEVEL, which kills the second one's gate.

**The tree question is CLOSED — there was no tree difference.** This lane
reported `var n = 0; eval("while(n<3){ n++; }")` throwing here while clean on
dev-4653's tree, and filed it as an open thread. dev-4653 spotted the tell in
the error text this lane had itself quoted: it says `n4515`, not `n`, because
the probe wraps in `export function test(){ var n4515 = 0; … }` — making the
name a **local of the enclosing function**, a third cell neither table varied.
It throws on their tree too. Not a tree difference, a different cell.

Two lessons, and the second is the one worth carrying:

- **A survey run entirely at module top level cannot see a defect gated on
  "inside an enclosing function"**, and mis-attributes the one case that does
  surface (this lane's error).
- **A table is only evidence for the axes it varies; the axis you did not vary
  is where the wrong rule hides** (dev-4653's, after their own table's gate
  fell). Here the axis was *where the name is bound* — not the operator, not the
  surrounding syntax, not the nesting depth. Both of us had varied everything
  except that.

A third lesson came out of *how* the disagreement was handled, and it is a brief
gap rather than either lane's carelessness — **both lanes independently stopped
at the same wrong place, from opposite sides.** This lane wrote "different trees,
neither of us can speak for the other's"; dev-4653 wrote "I can only say it does
not reproduce here, whether their tip differs is theirs to measure." Both are the
third-arm rule invoked to avoid reconciling. The rule governs **claims**, not
**disagreements**: "it does not reproduce here" is a hypothesis about your own
cell before it is a fact about their tree. dev-4653 has amended the brief for it
(their `issue-4653` @ `e37bfab39`), together with the corollary that opened this
one — read the peer's error text against the peer's quoted source, because a name
that does not match means you are not looking at the program that ran.

Still holds from every round: `for`-vs-`while` is irrelevant, and the loop
itself is irrelevant. Plausibly the same substrate as
`language/expressions/assignment/S11.13.1_A6_T{1,2}` (an eval `var` must land in
the enclosing FUNCTION's variable environment), which are C2 rows this lane
could not reach. Tracked as #4662 — whose body was written from the superseded
table and, as written, **excludes the most common real shape**; dev-4653 has
flagged that to the lead.

Practical consequence for anyone writing a pin: it turns a minimal
`export function test() { … eval(<loop>) … }` into a test of THIS defect. The
test262 original-harness lane puts its bindings at TOP LEVEL, which is why the
conformance rows pass while the minimal module throws.

### Correction to this lane's own hand-back (dev-4491, cited as theirs)

This lane handed `S11.6.1_A2.2_T3` to #4491 with a root: the `fctx.localMap`
guard in `addOperandCallableSourceText` always fires under the harness wrapper,
while the `.toString()` spelling reads the same map with no guard. **That was
true and NOT sufficient — repairing it alone moved 0 of 128 rows**, because for
this operand shape the helper *is never called*. `binary-ops.ts` has TWO `+`
object dispatches and the one that wins for a top-level function declaration is
`admitsObjectAddition` → `emitObjectAdd` (`addition-to-primitive.ts`, #4564),
not `admitsObjectAdd` → `emitAnyAdd` (`add-to-primitive.ts`, the helper's only
caller). Two modules whose names differ by three letters own the same operator,
and the live one had no source-text arm at all. dev-4491's fix needed both
halves.

The transferable part: **a root that explains the symptom is not yet a root that
reaches it.** The dispatch that actually claims the shape has to be identified —
instrumenting the helper and getting zero output is what found it. Handing the
row back rather than patching the guard in place is what kept a plausible
non-fix from burying the real cause.

**Confirmed on the combined tree, which neither lane could produce alone.**
dev-4491 copied this lane's whole pin file into their fixed worktree as a
gitignored `tests/probe-*.test.ts` and ran it: the `it.fails` pin failed with
exactly `Error: Expect test to fail`. So the merge-time action is `it.fails` →
`it`, measured rather than predicted — and it doubles as an independent check of
their fix on a module shape they did not write (`deferTopLevelInit: true`,
`hostBridge: "always"`, a module-level `var __r4515`).

### Method notes worth keeping
- **`inferModuleStrictArguments: false` is required in any strictness pin.** The
  `export function test()` entry point makes TypeScript flag the source a
  MODULE, and module code is always strict — so without it every function in the
  pin is strict for a reason unrelated to its directive prologue. Measured: both
  arms answered the same value, i.e. the pin could not fail for the reason it
  existed.
- The issue frontmatter carried **two `loc-budget-allow:` keys**, so a YAML
  parser kept only the second and the `src/codegen/closures.ts` grant was dead.
  Merged into one.
- **A parallel sweep will hand you a fake eventually.** One of 15 apparent flips
  here was a contention artifact, and two sibling lanes hit the same class in the
  same session (one fake regression, two fake flips between them). Re-run every
  apparent flip AND every apparent regression one process at a time before
  counting it; `runTest262File`'s `timeoutMs` is post-hoc and cannot interrupt a
  slow compile.
- **"Green because nothing ran" now has FOUR measured causes, not one.** A
  `describe.skipIf`; a suite whose own `CompilerPool` worker cannot start; a
  path/glob matching no file; and — found by dev-4491 while running this lane's
  pin file — **`vitest -t` is a REGEX**, so `-t "f + 1 must agree"` requires two
  spaces, selects zero tests, and reports `22 skipped` + exit 0 on a file with no
  `skipIf` in it. Escape `+ ( ) [ ] . * ?` in `-t`. The defence is identical for
  all four and is the whole rule: read the counts, require N > 0. Widened in
  `plan/method/es5-standalone-agent-brief.md`.
- **Contention also fakes the OPPOSITE of a failure.** A final run of this
  lane's pin suite reported `Tests 22 passed` next to `Errors 1 error` — the
  error being `[vitest-worker]: Timeout calling "onTaskUpdate"`, vitest's own
  RPC giving up under load, with no test involved. Read what the error IS
  before treating it as a result.
- **The counts rule has TWO tiers, and the free one comes first** (dev-4491's
  calibration, prompted by the line above; final form after they re-censused
  their own denominator and found it over-counting). Tier 1 needs nothing but
  vitest's summary line — `executed = passed + failed`, require
  `total > 0 && executed == total` — and catches four of the five failure modes
  with a denominator that cannot be mis-counted, because it is printed on the
  same line as the parts. Verified against all 22 summary lines this lane
  recorded: every one sums (`1 failed | 45 passed (46)`, and so on). Tier 2 —
  an external declared count — is needed ONLY for the RPC-drop case, where
  `passed` and `total` shrink together and tier 1 cannot see it.
- **An external denominator is wrong in both directions, and this lane's own pin
  file shows both at once.** It really declares 22. `grep -c "it("` answers
  **16** (every `it.fails(` is invisible to it); `grep -cE "it\(|test\("`
  answers **21** (it picks up `export function test()` in a doc comment, the
  same text inside a template string, and `exports.test()`). Two errors in
  opposite directions, neither landing on 22. dev-4653's pin file is the same
  pattern's other direction — declares 23, naive `it\(` says 13, under by ten.
  The anchored pattern that does work here was calibrated to this file, not
  derived — the same defect as a stale baseline restated as a measurement.
- **Tier 1 takes no count at all, including for deliberate skips** (dev-4491's
  objection to this lane's first draft, which had added an "expected skip count"
  exception and thereby put the unreliable number back into the tier built to
  avoid it). Floor `total > 0 && executed > 0` never false-alarms; strong form
  `executed == total`; and when they disagree you **read the skipped names**,
  which also catches the right number of skips from the WRONG set — something no
  count can see.
- **It is a three-rung ladder, and only the top rung needs verbose** (this
  lane's first framing — "our loops use `--reporter=basic`, the one that hides
  the names" — read as an indictment of working tooling; dev-4491 measured that
  the counts are reporter-independent). Rung 1, the aggregate line, every
  reporter: something was lost. Rung 2, `↓ <file> (N tests | N skipped)`,
  default and basic: which FILE. Rung 3, per-test `↓` paths, verbose only:
  which TESTS. Nothing existing needs re-plumbing; climb to verbose for rung 3
  alone.
- **CORRECTION — this lane's "rung 2 is blind to partial loss" was WRONG, and
  wrong in the artifact documenting the hazard.** dev-4491 measured it and the
  lead has already fixed the brief. The claim came from grepping for the `↓`
  MARKER: a partially-skipped file is still reported, it just lands on a
  different marker because it has a passing test. The line was in this lane's
  OWN run all along —
  `✓ tests/issue-4515-wave5.test.ts (22 tests | 21 skipped)` — and a search for
  `↓` did not find it. Re-run and confirmed here.

  **So the rung-2 rule is: match `skipped` on the FILE line, never the marker.**
  Three markers now measured, all carrying the count:
  ```
  ↓ tests/…in-operator-edge-cases.test.ts (9 tests | 9 skipped)          wholly skipped
  ✓ tests/issue-4515-wave5.test.ts        (22 tests | 21 skipped)        partial, pass+skip
  ❯ tests/probe-…-failskip.test.ts        (3 tests | 1 failed | 2 skipped)  partial, fail+skip
  ```
  The third shape was untested by anyone and is measured here (throwaway
  gitignored probe, no compiler, 34 ms), closing dev-4491's stated limit. It
  also refines their rule: **the suffix has a VARIABLE number of segments** — a
  failing file inserts `| N failed` — so a grep for the two-segment form
  `(N tests | M skipped)` misses exactly the shape you most want to catch.

  Rung 2 therefore localizes partial loss on `basic` after all; rung 3 is needed
  only for WHICH tests, not whether.

  This is the third time in one session a filter hid the evidence of its own
  unreliability — dev-4491's `grep -E "Tests |✓|×"` dropping `Errors`, this
  lane's `--reporter=basic` habit, and now this lane's `grep ↓`. The first two
  were caught by peers; the third was too. Worth stating plainly: the pattern
  survived being written down by the people writing it down.
- **Exit status is uncorrelated with the outcome — both directions on ONE
  suite** (dev-4653, `tests/issue-4653.test.ts`): `23 skipped (23)` exits **0**
  with nothing executed, `23 passed (23)` exits **1** with everything passing.
  Same file, so the "different suites, different causes" objection does not
  arise. Second, independent exit-0 instance from a real accident rather than a
  deliberate filter — dev-4491's dead `CompilerPool` worker,
  `22 passed | 36 skipped (58)`, thirty-six never executed. All of the above is
  adopted in `plan/method/es5-standalone-agent-brief.md`.
- **The brief merge was simulated by BOTH lanes, and the second time by the one
  moving the target.** dev-4653 ran it twice (against `ac96bd773`, then
  `ad7719378`); this lane then committed again, so it ran the same simulation
  itself against its own HEAD — `git merge-file`, base `c42bdbe3e`, theirs
  `2bfebb7ea`: rc=0, zero conflict markers, each of the four distinctive strings
  present exactly once, methodology numbering 1..7 intact. The lesson is not
  "simulate merges"; it is that **the lane whose commits keep invalidating a
  peer's verification owes the re-run** — and the trigger is cheap to automate
  (dev-4653's addition): any commit touching a file another lane has also
  touched.
- **…and all four of those runs answered the WRONG QUESTION.** Every one
  simulated a single FILE. dev-4653 flagged that limit, neither lane acted on
  it, and the whole-tree merge was one flag away the entire time:
  `git merge-tree --write-tree --name-only issue-4653 issue-4515-wave5` → rc=0,
  tree `1d431607a8bf…`, **empty conflict list**. Run independently by both lanes
  against the same tips, same tree sha. Verified inside the written tree: the
  brief carries dev-4653's methodology 6 and both their bullets AND this lane's
  Tier 1 / Tier 2, numbering 1..7, superseded strings gone; both issue files,
  their two new source modules and both pin files present. Nothing from either
  lane is dropped, at any level.

  The companion to *look for the cheap oracle* (dev-4653's, and it is the
  sharper half): **check that the oracle answers the question you actually
  have, not the narrower one you happened to set up.** Four rounds of
  re-verifying one file while the real question — do these two branches merge —
  sat unasked.
- **Both lanes' brief amendments: ACCEPTED, merged, and in PR #4814** (lead
  ruling). Nothing trimmed — the offer to compress the worked examples was
  declined on the grounds that the examples are what make the rules act on a
  reader. The `f + 1` pin was flipped `it.fails` → `it` at merge, as this lane
  and dev-4491 specified. The lead also corrected this lane's rung-2 error in
  the PR directly (see the correction above).
  **The brief is now CLOSED to further amendment for this session** — eleven
  edits in one day to a document every lane must read before its first edit; the
  budget is not insight per page. The remaining synthesis (*the check you didn't
  run / the axis you didn't vary / the line you didn't print*) stays in this file
  and dev-4653's, which is where a lane doing that work lands. A fourth wave
  hitting the same shape is the promotion trigger.
- **A survey run entirely at module top level is blind to any defect gated on
  "inside an enclosing function"** — and worse, it mis-attributes the one case
  that does surface, because that case looks like the odd one out. See the
  eval-scoping correction above.
