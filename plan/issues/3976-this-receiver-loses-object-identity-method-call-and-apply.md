---
id: 3976
title: "`this` loses object identity through a method call and through `.apply()` — `o.m() === o` and `f.apply(o) === o` are both false (`.call()` is correct)"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: this-binding
goal: core-semantics
related: [3507, 3220, 3396, 2015]
origin: "2026-08-01, working the es5-standalone-90% goal: the 200-test language/function-code/10.4.3 family fails in BOTH lanes (116 standalone / 114 host); minimised to a 6-line identity control set."
---

# #3976 — `this` is not identity-equal to its receiver (method call, `.apply()`)

## TL;DR

`this` inside a method — and inside a function invoked via `Function.prototype.apply` —
is **not `===` to the object that was passed as the receiver**. Plain object
identity is fine everywhere else, and `.call()` is fine, which makes this a
narrow carrier bug rather than a broken `===`.

This is **core `this` semantics**, not an edge case: `o.m() === o` is false.

## Minimal repro (measured on `b09a07b`, host lane, via `tests/equivalence/helpers.ts`)

| # | Source (`main` returns the comparison) | JS | Wasm |
| --- | --- | --- | --- |
| 1 | `var o = {}; o === o` | true | **1 ✅** |
| 2 | `function id(x){return x} id(o) === o` | true | **1 ✅** |
| 3 | `var o = { m: function(){ return this } }; o.m() === o` | true | **0 ❌** |
| 4 | `function f(){ return this } f.apply(o) === o` | true | **0 ❌** |
| 5 | `function f(){ return this } f.call(o) === o` | true | **1 ✅** |
| 6 | `function f(){ "use strict"; return this } f.apply(o) === o` | true | **0 ❌** |

Controls 1 and 2 are the important ones: object identity survives a plain
function carrier, so `===` and the object representation are both sound. Only
the **receiver** carrier loses identity.

The `.call()` vs `.apply()` asymmetry (5 vs 4, same function, same receiver,
same strictness) is the sharpest lead — the two lowering paths must differ in
how they materialise the receiver, and `.call()` is the one that is right.

Reproduce with `tests/probe-*.test.ts` (gitignored) using
`compileToWasm` from `tests/equivalence/helpers.ts`.

## Impact

`language/function-code/10.4.3-*` is a **200-test** family; it fails
**116/200 in standalone and 114/200 in the host lane** — near-identical, which
confirms this is lane-independent front-end/codegen behaviour, not a standalone
gap. 41 of those carry the bare `'this' had incorrect value!` signature; the
rest fail through `assert.sameValue`.

The tests that **pass** today are exactly the ones asserting `this === undefined`
(`f.apply()`, `f.call(undefined)`) — i.e. the cases that never have to preserve
an object identity. That split is itself strong evidence for the diagnosis.

True blast radius is almost certainly wider than 10.4.3: any code doing
`this`-identity comparison, receiver caching, or `this`-keyed lookup is exposed,
and a silent wrong answer here is far worse than a refusal. Worth measuring
before/after rather than assuming 200.

## Likely mechanism (to confirm)

This repo already has a recognised bug family of *identity loss through a
carrier* — #3507 (native RegExp values lose identity across function/object/array
carriers), #3220 (native `$Promise` loses struct identity through a
Promise-returning call carrier), #3396 (closure-env struct type A used where B).
The receiver path looks like the same class: the object is probably being
re-boxed / round-tripped (e.g. `extern.convert_any` → `any.convert_extern`, or
copied into a fresh struct) when installed as `this`, producing an equal-shaped
but non-identical reference.

Start at the `.call()` lowering and diff it against `.apply()`; whatever
`.call()` does to keep the reference intact is likely the fix for both `.apply()`
and the method-call path.

## Acceptance criteria

- [ ] All six repro rows above return the JS answer.
- [ ] `o.m() === o` and `f.apply(o) === o` hold for plain objects, class
      instances, and object literals with typed and untyped receivers.
- [ ] The `language/function-code/10.4.3-*` family improves materially in
      **both** lanes; report measured before/after per lane (do not assume 200).
- [ ] A regression test lands under `tests/` covering the method-call and
      `.apply()` identity cases (the `.call()` case as a guard against
      regressing the currently-correct path).
- [ ] Net official pass count does not regress in either lane.
