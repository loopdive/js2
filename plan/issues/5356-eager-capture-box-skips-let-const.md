---
id: 5356
title: "A hoisted inner function that mutates an outer `let` gets its ref cell minted at the first CALL site — a conditional call leaves every later read null"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-06
completed: 2026-09-06
assignee: ttraenkler/sendev-5356
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
loc-budget-allow:
  # 2026-09-06 (#5356): call sites into the new statements/eager-capture-box.ts
  # module (+9 / +6 / +4 / +2 lines); the mechanism itself lives in the module.
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/statements/variables.ts
  - src/codegen/context/types.ts
  - src/codegen/statements/control-flow.ts
func-budget-allow:
  # 2026-09-06 (#5356): the same call sites (+8 / +1 / +1 lines).
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/statements/control-flow.ts::compileSwitchStatement
  - src/codegen/statements/variables.ts::compileVariableStatement
---

## Problem

A nested `function` declaration that assigns to an enclosing `let`/`const`
captures it by ref cell. The cell is minted **at the first call site** of that
function, into whatever body buffer is active there. When the call sits in a
branch that does not execute, the `struct.new` never runs — but
`fctx.localMap[name]` was re-aimed at the cell **unconditionally**, so every
read after that point does `struct.get` on a null cell and yields
`null`/`undefined`.

This is the exact bug #2669 diagnosed and #2692 fixed — for `var` and
parameters. `emitEagerCaptureBoxes`
(`src/codegen/statements/nested-declarations.ts`) creates the box during
function-declaration hoisting, in the unconditional function-top body, and the
call site then takes its already-boxed branch. But it opens with:

```ts
if (cap.hasTdzFlag) continue;
```

`let`/`const` captures are deliberately excluded, and its own comment names
this as the follow-up: *"TDZ (`let`/`const`) captures fall back to the existing
lazy call-site boxing (the pre-#2692 behaviour). Follow-up can extend the
declaration path to be box-aware for the residual let/const-counter case."*

Everything real is written with `let`.

### Minimal reproduction (untyped `.js`, no loop, no closure construction)

```js
export function probe() {
  let output = "";
  output += "a";
  if (output === "zzz") { trim(); }   // never taken
  return "v=" + JSON.stringify(output);
  function trim() { output = ""; }
}
```

Node: `v="a"`. Wasm on `01ce47aba7`: **`v=null`**.

The emitted body makes the mechanism plain — the box (`local 2`) is built only
inside the `then` arm, and the read after the `if` routes through it anyway:

```wat
local.set 0                 ;; $output = ""
…                           ;; $output = "a"
(if                         ;; output === "zzz"
  (then
    local.get 0
    struct.new 13           ;; the cell — created ONLY on this path
    local.tee 2             ;; $__boxed_output
    …))
global.get 4                ;; "v="
local.get 2                 ;; $__boxed_output — null on the other path
local.tee 4
ref.is_null
(if (result externref)
  (then ref.null extern)    ;; -> null
  (else local.get 4 struct.get 13 0))
```

Variants measured on the same commit:

| shape | result | correct |
| --- | --- | --- |
| `function trim(){ output = ""; }` declared after `return`, called in a dead branch | `null` | `"aa"` |
| same, declared **before** the loop | `null` | `"aa"` |
| same, **never called** | `"aa"` | `"aa"` |
| `const trim = () => { output = ""; }` (arrow), called in a dead branch | `"aa"` | `"aa"` |
| counter is a `number`, not a string | `null` | `2` |
| reads **before** the call site, inside the loop | correct | correct |

So: hoisted `function` declarations only (arrows construct a closure at their
declaration and box unconditionally), any value type, and only reads that come
**after** the call site in emission order.

### Why it matters

It is the remaining blocker for prettier's `tests/unit/print-doc-to-string.js`
(0/3, #5346). `printDocToString` ends with

```js
const formatted = settledOutput.join("") + output;
```

and `output` is a `let` mutated by the hoisted `function trim()` declared after
the `return`. Instrumented on the reduced upstream tree: `output` is `"hi"`
immediately after the string branch appends to it, and `null` when the loop
exits — the exact signature above. `formatted` then reads `"null"` and all
three tests fail on their assertion.

## What was tried, and why it is not a one-liner

Deleting `if (cap.hasTdzFlag) continue;` fixes every row of the table above and
makes `printDocToString("hi")` return `"hi"` and `printDocToString([])` return
`""` — both correct, both `null` before. It then **miscompiles prettier**: any
array-valued doc turns into a non-terminating loop, with the first popped
command's `doc` reading as `[object Object]` while `getDocType` still answers
`"array"`. So a value is being read out of the wrong slot.

That is the failure class #2692's comment predicted: eager boxing at
function-top races a `let`/`const` whose declaration re-allocates its value slot
later (block scope, shadowing, type reset). prettier's document tree has both
spellings — `generateIndent` has `for (const command of queue)` shadowing its
own `command` parameter, and `printDocToString` has
`const { indent, mode, doc } = commands.pop()` shadowing its `doc` parameter.

The declaration path has become box-aware since #2692 (`boxedForInitStore`
#3396, the "boxed-before-declared" arm #3534, `dropStaleBindingBox`), so the
original invalid-Wasm reason may no longer hold — but the shadowing race
clearly still does.

## Suggested next step

Narrow the eligibility rather than the mechanism: eager-box a TDZ capture only
when the name is **not re-declared anywhere in an inner scope** of the
function being hoisted into. A name-scoped probe is cheap to run first —
enabling eager boxing for exactly the three bindings `trim` mutates
(`output`, `position`, `settledTextLength`) and no others tells you whether
the miscompile comes from a shadowed binding or from something else, before
any analysis is written.

## Acceptance criteria

1. The minimal reproduction above returns `"a"` in Wasm, with a regression
   test covering the dead-branch call, the never-called shape, and the
   number-valued counter — untyped `.js`, failing on the parent commit with
   exact counts both ways, and an anti-vacuity control.
2. The for-await-of / async-dstr family #2692 named stays green.
3. A/B at one head over the 17 dogfood suites: prettier's
   `print-doc-to-string.js` improves, nothing else regresses.

## Implementation Plan

Everything the previous agent measured stands: deleting the
`if (cap.hasTdzFlag) continue;` skip in `emitEagerCaptureBoxes`
(`src/codegen/statements/nested-declarations.ts`) fixes every row of the
table and then miscompiles prettier. The plan is to find out **which** of two
candidate races the miscompile is, by the cheapest experiment first, and fix
that race rather than the eligibility rule if it turns out to be fixable.

1. **Capture the parent** (`.tmp/nested-declarations.orig.ts`) and reproduce
   both ends before touching anything: the minimal `v=null` repro, and the
   prettier miscompile with the skip deleted (array-valued doc →
   non-terminating loop, first popped command's `doc` reads `[object Object]`
   while `getDocType` says `"array"`). Reduce the miscompile to a standalone
   two-file untyped `.js` project via `compileAndRunUpstreamModule` — the
   skeleton is `printDocToString`'s shape: a parameter `doc`, a `const cmds =
   [{ ind, mode, doc }]`, a `while (cmds.length > 0) { const { ind, mode, doc }
   = cmds.pop(); switch (getDocType(doc)) { … } }`, a `let output = ""`
   mutated by a hoisted `function trim() { output = "" }` declared after the
   `return`. A reproduction that loops or reads the wrong `doc` in under 40
   lines is the deliverable of this step; without it the rest is guesswork.
2. **Name-scoped probe** (the previous agent's suggestion, ~20 lines, throw
   away afterwards): allow eager boxing of a TDZ capture only when the
   captured name is declared **exactly once** in the enclosing function's
   scope tree — count `VariableDeclaration` / `Parameter` / `BindingElement`
   / `FunctionDeclaration` / `ClassDeclaration` / catch-clause names with the
   identifier text, walking the parent function but **not** descending into
   nested function bodies (a nested function's own local is a different
   binding). Run prettier's `print-doc-to-string` and the reduction.
   - Miscompile gone, repro fixed ⇒ the race is **shadowing**: a box minted
     at function top for the outer binding, then an inner block-scoped
     declaration of the same name that the declaration path treats as "already
     boxed" (`boxedForInitStore` #3396 / the #3534 boxed-before-declared arm)
     and stores into the outer cell, or re-aims `localMap[name]` so reads in
     the inner scope hit the cell. Fix at the declaration path: an inner
     declaration that **shadows** a boxed outer name must allocate its own
     slot (or its own cell, if it is itself captured by a hoisted function)
     and must **not** consult the outer name's box. `dropStaleBindingBox` is
     the closest existing hook — read it. Then drop the probe's eligibility
     narrowing and re-run: the goal is the general mechanism with shadowing
     handled, not a rule that silently keeps the shadowed shape on the lazy
     path. If the general fix costs more than a day, ship the narrowed
     eligibility with a test that pins the shadowed shape as *still lazy and
     still correct*, and say so.
   - Miscompile persists with unshadowed names only ⇒ the race is the
     **declaration re-allocating the value slot** after the cell exists
     (block scope, type reset, `let` re-declared in a loop body). Reduce to
     that shape (a captured `let` whose declaration follows a differently
     typed assignment, or lives inside a loop) and trace where the
     declaration path allocates a fresh local while the hoisted callee still
     writes the cell. The cell must be minted with the binding's **declared**
     slot type, not the type of whatever value the name holds at function
     top.
3. **Per-iteration semantics**: a `let` captured by a hoisted function
   declaration is not a per-iteration closure binding (the function is
   hoisted once), so one cell per function invocation is correct. Confirm the
   #2692 for-await-of / async-dstr family stays green — run
   `tests/issue-2692*.test.ts` and `tests/issue-2669*.test.ts` and the
   closure equivalence group in `tests/equivalence.test.ts`.
4. **Regression test** per the acceptance criteria: dead-branch call,
   never-called, number-valued counter, **and** the shadowed shape from step
   1 (the miscompile must be pinned so it cannot return). Untyped `.js`
   two-file fixtures, counts both ways, anti-vacuity control.
5. **A/B at one HEAD**, 17 suites, per file. `print-doc-to-string` reaches
   3/3 only together with #5357 — if #5357 has not landed, measure the file
   with and without #5357's branch merged in and report both; do not claim
   the bucket. Closure-heavy packages (jest, hono, prettier) are the ones to
   watch for movement.

Serial with nothing; independent of #5357 (disjoint files:
`nested-declarations.ts` vs `binary-ops-typed-dispatch.ts`). Both must land
for prettier's `print-doc-to-string`.

## Dispatch

Model: **fable** (`feasibility: hard`, `reasoning_effort: max`). The
one-line fix is known and known to miscompile; the work is finding which
race the declaration path has with an eager cell, on a mechanism (#2692,
#3396, #3534) that has already been patched three times. Dispatch after PR
#5665 lands (it carries this file).

## Resolution

Fixed on `50c81e5487` (upstream `main` at dispatch). Regression test:
`tests/issue-5356-eager-capture-box-tdz.test.ts` over the untyped two-file
fixture `tests/fixtures/issue-5356/` — **13 of 16 fail on the parent, 16 of
16 pass with the fix**; the 3 that pass both ways are the never-called shape,
the taken-branch anti-vacuity control, and the `case`-clause shape that only
breaks under the *bare* skip removal (kept as the pin for that race).

### What the measurements said (and where they contradict the plan)

- **The "prettier miscompile" attributed to the one-line fix is not caused by
  it.** With per-test logging in the dogfood worker, `printDocToString(["a"])`
  loops forever on the **parent** compiler too — the array-doc hang exists
  with or without the eager cell. Instrumenting a copy of the real printer
  shows the loop never leaves `commands.push({ indent, mode, doc: doc[index] })`
  in the `DOC_TYPE_ARRAY` arm; hoisting that object literal into a `const`
  before the `push` makes the same file terminate (and then read `output` as
  `null`, i.e. this issue). That is a third, separate defect — filed as
  #5375 — and it is why `print-doc-to-string` stays 0/3 here even though
  every `printDocToString` shape in the reduced skeleton now passes. Neither
  #5356 nor #5357 (`x === false`, also confirmed present: `traverseDoc`
  visits 1 node instead of 2) can lift that file without #5375.
- **The race is real, but it lives in the consumers of the raw slot, not in
  the declaration.** Plan step 2's probe was unnecessary: the bare skip
  removal was A/B'd over the whole prettier suite (105/151 → 105/151,
  per-file identical) and over a battery of shapes; exactly one shape
  regressed — a `let` declared directly in a `case` clause and mutated by a
  clause-level `function` read `"1"` instead of `"6"`. `compileSwitchStatement`
  decides "this clause's own binding" by `localMap.get(name) ===
  record.valueSlot`; once `localMap` points at the cell it hid the binding as
  an outer one, the declaration got a second slot, and the clause's call site
  minted a cell from the stale raw slot. The same raw-slot assumption sits in
  the #2814/#5271 block-`let` re-install (`variables.ts`, `index.ts`) and in
  the lazy call-site mint when a shadowing block hides the name; both were
  already wrong on the parent (a dead call inside a shadowing block hijacked
  the inner binding's name — the inner read `null`; a taken call mutated a
  throw-away cell — the outer never saw it).

### The fix

`emitEagerCaptureBoxes` boxes `let`/`const` captures too and records each
cell in the new `FunctionContext.eagerCaptureBoxes`, keyed by the RAW
pre-hoisted slot it was seeded from — a key that scope hiding cannot lose,
unlike the name-keyed `localMap`/`boxedCaptures`. `src/codegen/statements/
eager-capture-box.ts` resolves it for the four consumers that treated the raw
slot as the binding's storage:

| consumer | before | now |
| --- | --- | --- |
| `compileSwitchStatement` case-scope check | `localMap[name] === record.valueSlot` | …or the cell minted from it (`preHoistedBindingIsLive`) |
| #2814 / #5271 block-`let` re-install | puts the raw slot back | puts the cell + `boxedCaptures` entry back, so the declaration writes through it |
| call-site fresh mint (`call-identifier.ts`) | `struct.new` from the raw slot, re-aims `localMap` | forwards the function-top cell when this frame owns it, no re-aim (`eagerCaptureCellForCall`) |
| array-destructuring element stores | `local.set` into the cell slot → `illegal cast` | value-typed scratch per element, flushed through the cell (`redirectBoxedPatternBindings`) — the object lane already did this (#4618) |

Per-iteration semantics are unchanged by design: a hoisted function is
created once, so one cell per activation is correct (the #2692 loop test pins
that). #2692/#2669 (22 tests) stay green.

### Still wrong on both sides (out of scope, not regressed)

- `for (let x of xs) { function inc() { x += 1 } inc(); … }` — a for-of HEAD
  `let` mutated by a block-level function reads the pre-increment value.
- `let v; set(); String(v)` — a `let` with no initializer (or `= undefined`)
  written by a hoisted function reads `undefined` even for an unconditional
  call. The WAT shows the cell IS read (`struct.get … drop`) and then the
  `"undefined"` string constant is returned: `String(v)` is folded from the
  checker's flow-narrowed type, which cannot see the nested function's write.

### A/B, one HEAD, 17 dogfood suites

See the table below (filled from the runs on this branch's tree with the
seven touched files swapped between their `50c81e5487` and fixed copies).

| package | base | fix | per-file delta |
| --- | --- | --- | --- |
| axios | 200/231 admitted original tests pass in Wasm | 200/231 admitted original tests pass in Wasm | identical per file |
| clsx | 32/32 admitted original tests pass in Wasm | 32/32 admitted original tests pass in Wasm | identical per file |
| cookie | 63740/63740 admitted original tests pass in Wasm | 63740/63740 admitted original tests pass in Wasm | identical per file |
| hono | 229/324 admitted original tests pass in Wasm | 229/324 admitted original tests pass in Wasm | identical per file |
| jest | 335/356 admitted original tests pass in Wasm | 335/356 admitted original tests pass in Wasm | identical per file |
| jsdom | 6/6 admitted original tests pass in Wasm | 6/6 admitted original tests pass in Wasm | identical per file |
| lodash | 58/62 admitted original tests pass in Wasm | 58/62 admitted original tests pass in Wasm | identical per file |
| marked | 9/30 admitted original tests pass in Wasm | 9/30 admitted original tests pass in Wasm | identical per file |
| moment | 10/10 admitted original tests pass in Wasm | 10/10 admitted original tests pass in Wasm | identical per file |
| prettier | 105/151 admitted original tests pass in Wasm | 105/151 admitted original tests pass in Wasm | identical per file |
| redux | 66/82 admitted original tests pass in Wasm | 66/82 admitted original tests pass in Wasm | identical per file |
| styled-components | 9/9 admitted original tests pass in Wasm | 9/9 admitted original tests pass in Wasm | identical per file |
| stylelint | 108/108 admitted original tests pass in Wasm | 108/108 admitted original tests pass in Wasm | identical per file |
| tailwindcss | 13/13 admitted original tests pass in Wasm | 13/13 admitted original tests pass in Wasm | identical per file |
| three | 17/18 admitted original tests pass in Wasm | 17/18 admitted original tests pass in Wasm | identical per file |
| uuid | 75/75 admitted upstream tests passed in Wasm (0 native-incompatible; 75 total) | 75/75 admitted upstream tests passed in Wasm (0 native-incompatible; 75 total) | identical per file |
| webpack | 16/16 admitted original tests pass in Wasm | 16/16 admitted original tests pass in Wasm | identical per file |

Every suite: exit 0 with an `admitted` headline on both sides; 17/17 per-file identical.

`print-doc-to-string`: 0/3 both ways here; the #5357 branch
(`fork/issue-5357-nullish-ref-strict-eq`) was at `50c81e5487` with no commits
when measured, so "with #5357" is the same measurement. The file needs #5375.
