---
id: 4231
title: "`with` statement, ES5 standalone: runtime scope-resolution defects in the closed-shape route — `var` names wrongly shadow the object environment record, `delete` returns a number, `with(null)` does not throw"
status: in-progress
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: with-statement
goal: es5
related: [671, 1387, 3025, 4179, 4205, 4206, 3956, 1472]
origin: "Wave 3 of the ES5-standalone-90 program (WP7). Successor to #4206's 'Deferred, precisely located' list, re-measured on the Waves 1+2 branch."
# loc-budget (wave-3 PR aggregate vs main): RC-F write routing, RC-B/D delete-boolean + typeof-binding, and the with-var redirect are point fixes in the owning modules
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/statements/variables.ts
# func-budget: the with-var redirect hook (+10) and delete-boolean tagging (+3)
# are single-branch additions inside the statement dispatchers they modify.
func-budget-allow:
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/typeof-delete.ts::compileDeleteExpression
---

# #4231 — the `with` runtime residue, re-measured after Waves 1+2

## What changed since #4206

#4206's handoff named **global-binding unification** (`this.p1 = 1` then a bare
`p1` read) as the head of this cluster and told the next session to file it
before staffing more `with` work. **Re-measured on the Waves 1+2 branch with a
script-goal probe (`deferTopLevelInit`, no `export`, call `__module_init`): that
blocker is GONE.** #3956 + #4205 landed and

```js
this.p1 = 1;            // script goal
if (p1 !== 1) throw …;  // passes
p5 = 'x5';              // implicit global — passes
```

all pass. The earlier "still fails after #4205" reading came from probing a
**module** (`export function f() { … }`), where top-level `this` is `undefined`
by spec rather than the global object — a measurement artefact, not the defect.

So the residue in `language/statements/with` is now genuinely `with`'s own, and
it is a small set of precise mechanisms rather than one big one.

## Root causes (each measured with an isolated RED probe)

### RC-A — `var` names inside a `with` body wrongly shadow the object

`finalizeStaticWithScope` builds the static scope's `blockedNames` from
`collectBodyDeclaredNames`, which **includes `var`**. The Tier-2 dynamic path
deliberately uses `collectBodyLexicalNames` instead, with the reasoning already
written down at that call site: a `var` inside `with` hoists to the *function*
environment, but the *object* environment is consulted FIRST, so the object wins
whenever it owns the name. Tier-1 never got the same treatment.

Two halves, both required:

1. bare reads/writes of a `var`-declared name inside the body must resolve to the
   object (fix: use the lexical set for the scope, keep the declared set for the
   inherited-key diagnostic so no currently-compiling body starts hard-erroring);
2. the declaration's own initializer — `var value = 'v'` — is an ordinary
   assignment through the scope chain, so it must store into the object, and the
   hoisted function-scoped `value` must stay `undefined`.

This is assertions #18/#19 of every `S12.10_A1.*` file
(`value === undefined` / `myObj.value === "value"`).

### RC-B — a `with`-scoped `delete` yields a number, not a boolean

`del = delete p3` inside a `with` yields `1`, so `del === true` fails.
`emitDynamicWithDelete` returns `{kind:"i32"}` and the with-write path coerces
i32 → externref as a **number** (`f64.convert_i32_s` + `__box_number`). A plain
`delete o.p` is unaffected because its consumer is boolean-typed and no boxing
happens. Carried over verbatim from #4206's deferred list, now measured.

### RC-C — `with(null)` does not throw TypeError

§14.11.7 `ToObject(null)` throws. `with(undefined)` already throws; `with(null)`
does not. One file (`12.10-2-5.js`).

### RC-D — `typeof` of a string-valued `with` binding is `"object"`

`staticTypeofForWasmType` maps every `ref`/`externref` ValType to `"object"`, so
a `with`-bound string field reports `"object"`. Number / boolean / function
bindings are unaffected.

### RC-F — the Tier-2 fallback write shadows a global-object property (the big one)

Not in the original plan; found by delta-debugging `S12.10_A1.1_T1`'s **first**
assertion down to a 6-line repro. It is the gate for the whole family.

`emitIdentifierWriteFromLocal`'s tail branch auto-allocated a local for an
undeclared name — and `allocLocal` registers the name in `fctx.localMap`, so
every LATER bare read of that name in the same function resolves to the fresh
local. The `with` cascade compiles that branch as the HasBinding-**MISS** arm,
which for a name the object owns is **never taken**:

```js
this.p1 = 1;
with (myObj) { p1 = 'x1'; delete p3; }   // myObj owns p1 ⇒ else arm is dead
if (p1 !== 1) …                          // …but reads the dead arm's local ⇒ null
```

Merely *compiling* an unreachable fallback poisoned the binding. Fix: a name the
pre-scan already classified as a global-object property (`sloppyImplicitGlobals`,
#3956/#2726) has real storage that `emitImplicitGlobalRead` reads, so write it
there with `__extern_set`. Genuinely undeclared, unscanned names keep the
auto-local.

The `delete` in the body is what forces Tier-2 (`bodyContainsIdentifierDelete`
declines the Tier-1 struct proof), which is why every `S12.10_A1.*` file — all of
which contain `del = delete p3` — was affected and simpler `with` bodies were not.

### RC-E — a property whose value is `undefined` does not shadow correctly (NOT FIXED)

`with ({p1: undefined}) { s = p1; }` yields neither `undefined` nor `null`.
Deliberately left out: it is a value-representation question about how an
`undefined`-initialised struct field is lowered, not a scope-resolution one, and
the probe could not pin the observed value. Left as the one named leftover.

## Explicitly out of scope

The 31 compile errors `with statement requires a proven closed object-literal
shape` — that is the deliberately-unbuilt dynamic route (#671 scoping decision,
#1387 gate). #4206 additionally measured that cohort to be **downstream** of the
runtime cohort (`S12.10_A1.7_T1` is `A1.1_T1`'s body wrapped in a function
expression), so building it before the runtime defects are fixed yields ≈ 0.

## Acceptance criteria

- [x] RC-A: `var x = v` inside `with (o)` where `o` owns `x` writes `o.x`; bare
      reads of `x` see `o.x`. **Partially** — the object write and the reads are
      fixed; the hoisted binding is not left `undefined` (see RC-H below).
- [x] RC-B: `delete name` inside a `with` yields a boolean.
- [x] RC-C: `with (null)` throws TypeError.
- [x] RC-D: `typeof` of a string-valued `with` binding is `"string"`.
- [x] RC-F: a bare read after a `with` still sees its global-object property.
- [x] Regression tests in `tests/es5-standalone-with.test.ts`, **9 of 24 RED on
      base** (A/B'd by reverting the four touched source files to HEAD).
- [x] No regression in the neighbouring suites: `issue-1387*`, `issue-2663*`,
      `issue-3025`, `issue-4179`, `issue-4206`, `issue-3956`, `issue-2726*` —
      failure sets byte-identical to base (13 and 4 pre-existing failures
      respectively, same tests).

## Measured effect on `language/statements/with` (standalone, local seam)

A/B over all 181 files in the directory via the `runTest262File` seam, same
process, eval provider prebuilt at the REFUSAL tier both arms (so eval-dependent
files are comparable to each other, though not to CI).

| | base | head |
| --- | --- | --- |
| pass | 55 | 56 |
| fail→pass | — | **1** (`12.10-2-5.js`, RC-C) |
| pass→fail | — | **0** |
| still failing, signature ADVANCED | — | **31** |

The headline is the third row, not the first. Every `S12.10_A1.*` file asserts
~19 things in sequence and previously died on **assertion #1**
(`p1 === 1` reading `null`). They now reach **assertion #11**
(`myObj.parseInt !== parseInt`) or **#4** — i.e. assertions 1–10 flipped, the
file still does not. Converting the family needs the remaining blockers below;
none of them is the one #4206's handoff named.

## Leftovers, precisely located

1. **RC-G — Tier-1 writes are coerced to the field's inferred ValType.**
   `with ({foo: 42}) { foo = 'set in with'; }` stores `NaN`: the struct field is
   `f64` and the string is coerced into it. **Pre-existing and not caused by this
   change** — measured identically on base for the plain assignment form; RC-A
   only made the `var` form behave the same way as the plain one, so
   `12.10-0-8.js` fails before and after (its reported value moves `42` → `NaN`).
   The fix belongs in object-shape widening: a `with` target's field type must
   accommodate every value assigned through the body, or the statement must
   decline Tier-1.
2. **RC-H — a `var` inside a `with` body that never EXECUTES is not `undefined`.**
   `with (o) { throw v; var p4 = 'x4'; }` leaves `p4` reading `null`: §10.2.11
   hoisting must initialise it at function/script entry, and instead the
   declaration statement is the only thing that ever writes the slot.
   **Pre-existing, not caused by RC-A — A/B'd directly and byte-identical on
   base** (`.tmp/probe12.mjs`); it was simply masked behind assertion #1, and is
   now the first failure of 9 files. The same slot-default gap also leaves the
   hoisted binding non-`undefined` after RC-A redirects a `var`'s store to the
   object. A plain `if (false) { var p4 = 'x4'; }` outside a `with` is correct,
   so the gap is specific to `with` bodies. Assertions #4 and #18 of the battery.
3. **RC-I — a `with`-owned property named after a folded intrinsic does not
   shadow it.** `with ({NaN: 'obj_NaN'}) { st = NaN; }` reads the global `NaN`:
   `NaN`/`Infinity` are folded to constants before `with` resolution runs.
   Assertions #12/#13. `parseInt`/`isNaN`/`eval` shadow correctly in isolation
   but not in the battery's Tier-2 context (assertion #11) — diagnose together.
4. **RC-E** — see above.
5. The 39 `#1387` gate refusals stay out of scope, and #4206 measured them
   **downstream** of this cohort, so they should not be staffed until the above
   land.
