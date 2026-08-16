---
id: 4168
title: "`.apply(thisArg)` DROPS the receiver — no `this`-binding thunk is emitted, so `f.apply(o) === o` is false (`.call()` emits one and is correct)"
status: wont-fix
# 2026-08-16 lead sweep: PHANTOM DUPLICATE of #4025 (identical defect), which
# is `done` since 2026-08-04. Do not dispatch.
sprint: current
created: 2026-08-01
updated: 2026-08-07
# assignee cleared 2026-08-07 (W22): `ttraenkler/claude-harvest` is a dead lane
# and the claim had been stale since 2026-08-01.
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: this-binding
goal: core-semantics
related: [3507, 3220, 3396, 2015]
loc-budget-allow:
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
origin: "2026-08-01, working the es5-standalone-90% goal: the 200-test language/function-code/10.4.3 family fails in BOTH lanes (116 standalone / 114 host); minimised to a 6-line identity control set."
---

# #4168 — `this` is not identity-equal to its receiver (method call, `.apply()`)

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

## Root cause — CONFIRMED by WAT diff (not an identity/boxing bug)

The first framing of this issue guessed "identity loss through a carrier"
(the #3507 / #3220 family). **That is wrong — do not go looking for a boxing
round-trip.** Emitting the WAT for the two forms shows the receiver is not
mis-boxed, it is **never installed at all**.

`f.call(o)` — correct. Codegen emits a dedicated receiver-binding thunk:

```wat
(func $__named_this_call_f_0 (param externref) (result externref)
  (local $__previous_this externref)
  local.get 0
  ref.is_null
  (if (result externref)
    (then call 3)                  ;; null receiver → plain call
    (else
      global.get 4                 ;; save current `this`
      local.set 1
      local.get 0
      global.set 4                 ;; install receiver as `this`
      (try (result externref)
        (do call 3)
        (catch_all                 ;; restore on unwind
          local.get 1
          global.set 4
          rethrow 0)))))
```

`f.apply(o)` — broken. `$main` is simply:

```wat
(func $main (result i32)
  call 3          ;; <-- calls f DIRECTLY; `this` global never set
  global.get 3    ;; o
  call 2          ;; ===
  return)
```

So `.apply()` invokes the target with whatever the `this` global already holds
(null/undefined), and `thisArg` is silently discarded. Everything downstream
follows from that one omission.

Probing for the binding (`/__named_this|global\.set 4/` in the emitted WAT):

| Shape | receiver binding emitted? | runtime result |
| --- | --- | --- |
| `f.call(o)` | **yes** | correct |
| `f.apply(o)` | no | wrong |
| `f.apply(o, [1])` | no | wrong |
| `f.apply(o, [])` | no | wrong |
| `var o = {m: function(){return this}}; o.m()` | no | wrong |

The `.apply()` arity makes no difference — with args, with an empty array, or
with none, the binding is absent. So the fix is not about argv spreading.

### Fix direction

`src/codegen/expressions/calls.ts:6380` handles `call`/`apply` through a shared
arm (`const isCall = propAccess.name.text === "call"`), and several downstream
special cases are explicitly `isCall`-only — e.g. the comment at the #3390 arm
notes "`.apply` is not intercepted (rare; the corpus uses `.call`)". The
receiver-binding thunk appears to sit behind one of those `isCall` guards.
Locate the emitter for `__named_this_call_*` and make the `.apply()` path reach
it, threading `thisArg` identically.

**The object-literal method row is listed separately on purpose** — it may be a
distinct mechanism (class/struct methods generally pass `this` as a parameter
rather than through the global, and plenty of `this`-in-method tests pass
today). It reproduces as wrong at runtime, but do not assume one fix covers
both; confirm the method-call path independently.

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


## Measurement note (2026-08-04) — value confirmed, original lane label was wrong

The delta first reported here ("+4 standalone, +4 host") came from a harness
that silently ran the HOST lane for both runs: `runTest262File` takes
POSITIONAL args and my script passed `{ target }` as `timeoutMs`, leaving
`target` undefined. The two lanes agreeing exactly was the tell, and I
misread it as evidence of lane-independence.

Re-measured on the fixed harness (201 files, `language/function-code/10.4.3`):

| lane | reshape disabled | with #4168 | delta |
| --- | --- | --- | --- |
| standalone | 64 | **68** | **+4** |
| host | 65 | **69** | **+4** |

So the +4 stands and the lane-independence claim happens to hold — but it was
right by accident, not by measurement. Anyone re-running this must pass the
target as the FOURTH positional argument and verify the two lanes actually
differ before trusting a lane-specific number.

## Re-measured 2026-08-07 (W22, on `origin/main` @ `b28970e206` + #4203)

**The title is now WRONG and the issue is nearly closed.** Five of the six
repro rows pass, on **both** lanes:

| # | row | standalone | host |
| --- | --- | --- | --- |
| 1 | `o === o` | ✅ | ✅ |
| 2 | `id(o) === o` | ✅ | ✅ |
| 3 | `var o = { m: function(){return this} }; o.m() === o` | **❌** | **❌** |
| 4 | `f.apply(o) === o` | ✅ | ✅ |
| 5 | `f.call(o) === o` | ✅ | ✅ |
| 6 | strict `f.apply(o) === o` | ✅ | ✅ |

Row 4/6 — the headline — was closed by **#3983**'s `.apply` → `.call` reshape
onto the `named-this-call.ts` trampoline, not by anything in this issue.

**Row 3 is the whole remainder, and it is not an `.apply` bug at all**: an
object literal whose property value is a function EXPRESSION, invoked as a
method. This issue already flagged it as "listed separately on purpose … may
be a distinct mechanism" — that instinct was right. It is the *same* row #4192
sized independently as its rows 3/6 and measured at **~2–4 ES5 files**, with
the explicit conclusion "do not staff it as a lever; fold it in
opportunistically if someone is already inside `call-receiver-method.ts`".

So: **retitle or close-and-fold into #4192.** Do not dispatch this as a
200-test `10.4.3` lever — that framing is three fixes out of date.
