---
id: 4025
title: "`.apply(thisArg)` DROPS the receiver — no `this`-binding thunk is emitted, so `f.apply(o) === o` is false (`.call()` emits one and is correct)"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-04
assignee: "ttraenkler/claude-harvest"
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

# #3983 — `this` is not identity-equal to its receiver (method call, `.apply()`)

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

## 2026-08-04 — root cause, and a correction to this issue's own title

**The title is wrong that `.call()` is correct.** Measured on `main` @ `269c26a80`,
standalone, all four shapes return `NaN`:

| case | result |
| --- | ---: |
| `g.call(o)` where `g` returns a constant | **7** (the call itself works) |
| `o.x` read directly | **42** (the field read works) |
| `g.call(o)` where `g` returns `this.x` | **NaN** |
| `g.apply(o)` / `g.apply(o,[])` / `g.apply(o,[1])` | **NaN** |

So this is not an `.apply`-specific defect and the `.apply`→`.call` reshape
(#3983, `tryReshapeApplyToNamedThisCall`) cannot fix it — it reshapes onto a
path that is broken the same way. Anyone porting an `.apply` fix will find it
already landed and the bug still present; that happened once already.

### Where it actually goes wrong

`resolveNamedThisCallTarget` (`src/codegen/named-this-call.ts:212`) is gated on
`receiverIsAdmitted` (:70), whose non-`this` branch is:

```ts
return oracleProvesNonNullish(ctx.oracle.typeFactOf(inner));
```

An `any`-typed receiver — `const o: any = {x:42}`, and every untyped-JS receiver
in the corpus this matters for — cannot be proven non-nullish, so the gate
refuses, the trampoline is never reserved, and control falls through to the
generic lowering, **which evaluates the receiver and discards it**. The callee
then runs with the ambient `this`, so `this.x` reads a field that is not there
and yields `undefined` → `NaN`. A silent wrong answer, not a refusal.

### Why the gate is probably not the thing to fix

:74 already states the trampoline "runtime-splits a null value to the legacy
unbound call", i.e. it handles a nullish receiver itself at runtime. If that
holds, the static non-nullish requirement is redundant for admission and could
be relaxed to admit `any` receivers. **That was NOT verified** — it needs the
runtime split re-read and exercised against a genuinely null receiver before
anyone leans on it.

The deeper defect is the fallback: refusing the fast arm should not silently
change semantics. Whatever admits the receiver, the non-trampoline path needs to
either install `this` or refuse to compile — dropping it is the bug.

### Repro

```js
function g() { return this.x; }
export function test() { const o = { x: 42 }; return g.call(o); }  // NaN, expect 42
```

## 2026-08-04 — fix, and TWO corrections to the analysis above

### 1. The trampoline's runtime null-split claim HOLDS (this was the gating question)

Verified by reading `ensureNamedThisCallTrampoline` **and** by disassembling an
emitted module (`--target wasi`). The trampoline body really is a runtime split
on the receiver value, with the null arm being the pre-existing unbound exact
call:

```wat
(func $__named_this_call_g_49 (type 57)
  (local $__previous_this externref) (local $__result externref)
  local.get 0
  ref.is_null
  (if (result externref)
    (then call 49)                    ;; null receiver → legacy unbound call
    (else                             ;; live receiver → save/install/restore
      global.get 9  local.set 1
      local.get 0   global.set 9
      (try (result externref) (do call 49)
        (catch_all local.get 1 global.set 9 rethrow 0))
      local.set 2 local.get 1 global.set 9 local.get 2)))
```

So the static non-nullish requirement was redundant for admission, exactly as
:74 suspected. **Fix**: `oracleProvesNonNullish` (a proof no `any` receiver can
ever supply) is replaced by `factIsStaticallyNullish` — admission now refuses
only a receiver the oracle proves is *always* nullish. Every other gate in
`resolveNamedThisCallTarget` is untouched.

Two things make the relaxation safe beyond the split itself:

- The call site (`calls.ts`) compiles `thisArg` with an **externref expected
  type**, and `compileExpression` guarantees exactly one value of the expected
  type on the stack in every path (`VOID_RESULT` → `pushDefaultValue`, `null` →
  `pushDefaultValue`, kind mismatch → `coerceType`). So no stack-shape hazard
  from an unprovable receiver. `void` is still refused anyway, belt and braces.
- Standalone stays host-import-free for `any` receivers holding a number,
  string, boolean, or `unknown` (measured: `imports=[]`, all valid).

**Nullish behaviour is unchanged, measured before and after in BOTH lanes**:
`g.call(null)`, `g.call(undefined)`, `g.call()`, `g.apply(null)`, and an
`any`-typed receiver holding null/undefined at runtime all leave
`this === undefined` (js2wasm compiles TS modules, which are strict — there is
no sloppy-mode global substitution to preserve). The last two now route through
the trampoline and take its null arm; the observable answer does not move.

Also verified byte-identical on the `#3796` negatives corpus: the set of shapes
that get a trampoline, and every one of their runtime values, is unchanged by
this patch.

### 2. The repro in the section above is NOT purely this bug — it is TWO bugs

`const o = { x: 42 }; g.call(o)` conflates the `this`-binding drop with a
**separate, standalone-only defect** that has nothing to do with `this`:

```ts
function h(p: any) { return p.x; }
export function test() { const o = { x: 42 }; return h(o); }  // garbage in standalone, 42 in host
```

No `this`, no `.call`, still wrong. Measured (`--target wasi`):

| receiver binding | dynamic `p.x` |
| --- | --- |
| `const o = {x:42}` inside a function | **wrong** |
| `let o = {x:42}` inside a function | **wrong** |
| `h({x:42})` inline literal | **wrong** |
| `const o = {x:42}` at module scope | 42 |
| `var o = {x:42}` at module scope | 42 |
| `const o: O = {x:42}` (annotated) | 42 |

I.e. a dynamic property read on a **function-local, un-annotated** object
literal returns `undefined` in standalone. The host lane is correct throughout.

**This needs its own issue and this branch could not file one**: `gh` is not
installed in this container, so `claim-issue.mjs --allocate` reports
`PR-scan DEGRADED` and reserving an id under `--allow-unscanned` would risk a
collision with an in-flight PR. Recorded here instead so the finding is not
lost; please allocate an id for it from a checkout that has `gh`.

It is also why the tests below use annotated literals or receiver *identity*
rather than the literal repro text — using the repro as-written would make them
fail for the wrong reason.

### What landed

- `src/codegen/named-this-call.ts` — `factIsStaticallyNullish` replaces
  `oracleProvesNonNullish`; module doc records that the runtime split is what
  makes admission safe.
- `tests/issue-4025-apply-call-this-binding.test.ts` — 15 standalone rows +
  2 host-lane equivalence rows. Mutation-checked against the pre-fix compiler:
  **11 of 17 fail** without the change. The 6 that pass on both sides are the
  deliberate regression guards (statically-typed receiver, and the five
  nullish-convention rows) — they exist to pin behaviour that must NOT move.

Fixed shapes (all previously silently wrong): `.call(o)` / `.apply(o)` /
`.apply(o, [])` / `.apply(o, [a])` / `.apply(o, [a, b])` with an `any` receiver,
receiver identity (`g.call(o) === o`), constructor-function (`new O()`)
receivers, class instances behind `any`, and ambient-`this` restore across
consecutive calls with different receivers.

### Still dropping the receiver after this fix (NOT regressions — measured)

The argv shapes that `tryReshapeApplyToNamedThisCall` and
`resolveNamedThisCallTarget` deliberately refuse still take the
evaluate-and-drop lowering. Measured on the JS lane (`.mjs`,
`skipSemanticDiagnostics`), `function g(a) { return this.x + a }`,
`var o = {x:42}`:

| shape | result |
| --- | --- |
| `g.apply(o, [5])` | 47 ✅ |
| `g.apply(o, arr)` — dynamic argv | wrong, no trampoline |
| `g.apply(o, [...a])` — spread in argv | wrong, no trampoline |
| `g.call(o, ...a)` — spread call | wrong, no trampoline |

These need a dynamic-argv lowering (the trampoline ABI is fixed-arity), which is
a bigger change than admission. They were equally broken before this fix; naming
them here so nobody reads #4025 as covering them.

### Pre-existing failures NOT caused by this change

Confirmed identical with and without the patch (A/B by file copy):
`tests/issue-2773-arraylike-call-thisarg.test.ts` (9 failures) and one row of
`tests/issue-3796-named-this-call.test.ts` ("keeps unstable identity … off the
trampoline" — `readsThis` gets a trampoline via the #3983 `.apply` reshape, which
postdates that assertion), plus one row of `tests/issue-2166.test.ts`. Worth a
separate look; they are red on `main` today.
