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
