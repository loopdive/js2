---
id: 5356
title: "A hoisted inner function that mutates an outer `let` gets its ref cell minted at the first CALL site — a conditional call leaves every later read null"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
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
