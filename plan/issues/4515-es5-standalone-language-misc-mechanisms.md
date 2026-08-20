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
loc-budget-allow:
  # 2026-08-19 accessor-pair fix: for an accessor PAIR, TypeScript takes the
  # property type from the GETTER's return and requires the setter's parameter
  # to match, so `set foo(v)` beside a string-returning getter infers `v: string`
  # and __call_fn_method_1 casts the incoming externref with an UNGUARDED
  # ref.cast — `o.foo = 1` traps. Predicate + rationale live in the new leaf
  # module src/codegen/closures/set-accessor-param.ts; the god-file grows by the
  # IMPORT LINE ONLY (+1).
  - src/codegen/closures.ts
related: [2668, 1888, 3626, 2666, 4504]
loc-budget-allow:
  # One import line. The set-accessor parameter predicate + its rationale live
  # in the new leaf module src/codegen/closures/set-accessor-param.ts; the
  # widening itself replaces an existing line in computeClosureWrapperSig, so
  # this is the import and nothing else.
  # One field. The §13 eval completion register is a FunctionContext slot; the
  # register's whole lifecycle and rationale live in the new leaf module
  # src/codegen/statements/eval-completion-value.ts, and eval-inline.ts SHRANK.
  - src/codegen/context/types.ts
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
