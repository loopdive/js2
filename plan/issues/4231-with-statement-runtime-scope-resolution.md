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

- [ ] RC-A: `var x = v` inside `with (o)` where `o` owns `x` writes `o.x` and
      leaves the function-scoped `x` undefined; bare reads of `x` see `o.x`.
- [ ] RC-B: `delete name` inside a `with` yields a boolean.
- [ ] RC-C: `with (null)` throws TypeError.
- [ ] RC-D: `typeof` of a string-valued `with` binding is `"string"`.
- [ ] No regression in the `gc` (JS-host) lane for the same bucket.
- [ ] Regression tests in `tests/es5-standalone-with.test.ts`, RED on base.
