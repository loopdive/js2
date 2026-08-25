---
id: 4203
title: "Standalone substrate: codegen cannot distinguish an EXPLICITLY-null receiver from an absent one — `f.bind(null)()` / `f.call(null)` in strict code answer `undefined` where the spec says `null` (12 measured files, §10.4.3)"
status: done
created: 2026-08-07
updated: 2026-08-18
completed: 2026-08-07
assignee: ttraenkler/W22
# The mechanism lives in the new leaf module src/codegen/explicit-null-receiver.ts.
# What is left in the god-files is irreducible: one reader hook in the
# ThisKeyword arm (+4 incl. its comment), one reshape call at the immediate
# bind-and-call site (+9), the ctx field the global-shift pass reads (+6), and
# that shift-pass entry itself (+4). None of the four has a subsystem module
# that could host it.
loc-budget-allow:
  - src/codegen/expressions.ts
  - src/codegen/registry/imports.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/context/types.ts
func-budget-allow:
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
priority: high
task_type: bug
area: codegen
goal: es5
feasibility: hard
reasoning_effort: max
sprint: 78
horizon: m
related: [4196, 4192, 3140, 2106]
origin: "W21 (§10.4.3 residue census) handed the file list to W19 (#4196); W19 measured it on branch issue-4196-bind-construct, 2026-08-07"
---

# #4203 — "no receiver" and "receiver is `null`" are the same value in standalone

## The gap

`__current_this` holds `ref.null.extern` for **both** "no receiver was
installed" and "the caller explicitly passed `null`". The callee body's
`ref.is_null` guard therefore answers `undefined` in both cases. §10.4.3 says a
**strict** callee must observe the receiver **exactly as passed** — `null` stays
`null` — while a sloppy callee substitutes the global object. Without a
boundness signal the two are indistinguishable and the strict rows cannot pass.

This is a **substrate** defect, not a `bind` defect. It sits under at least
three surfaces (`.bind`, `.call`, `.apply`) and two clause families.

## Measured (standalone, INTERPRETER runtime-eval tier, 2026-08-07)

All 12 fail on `origin/main` and on `issue-4196-bind-construct`
(#4196 slice 1 is [[Construct]]-only and does not touch this):

| files | shape | observed |
| ---: | --- | --- |
| 4 | `test/language/function-code/10.4.3-1-77{-s,gs}.js`, `-79{-s,gs}.js` | `f.bind(null)() !== true`; `f.bind(o)() !== true` |
| 2 | `…/10.4.3-1-80{-s,gs}.js` | `f.bind(this)()` → `SameValue(«undefined», «[object Object]»)` |
| 2 | `…/10.4.3-1-98{-s,gs}.js` | sloppy declaration bound by a strict caller |
| 2 | `…/10.4.3-1-67{-s,gs}.js` | `f.apply(null) !== true` |
| 2 | `…/10.4.3-1-72{-s,gs}.js` | `f.call(null) !== true` |

The `gs` twins all report the harness's `'this' had incorrect value!`, i.e. the
same defect surfaced through the global-scope variant.

Canonical minimal case (`10.4.3-1-77-s.js`):

```js
function f() { "use strict"; return this === null; }
assert(f.bind(null)());
```

## The substrate is CLOSER than "no signal exists" suggests

Two representations already in the tree do most of the work:

1. **There is already a distinct externref `undefined`** — the `#2106`
   `undefinedSingleton` regime (`undefinedSingletonActive`,
   `emitUndefinedExtern`, `__extern_is_undefined` in `src/codegen/any-helpers.ts`),
   active exactly when `ctx.standalone || ctx.nativeStrings`. So the
   externref plane can distinguish `undefined` from `null` **today**; the two
   collapse only because `__current_this`'s "absent" state is spelled
   `ref.null.extern` rather than the singleton.
2. **The bound carrier already has a slot for the answer** — `$__bound_fn`'s
   `thisArg` field (#3140, `getOrRegisterBoundFnType`). `emitBoundFnValueFromLocals`
   (`src/codegen/expressions/calls.ts:2096`) writes `ref.null.extern` when no
   `thisArg` was supplied, which is the *same* value `bind(null)` produces —
   that single line is where boundness is currently thrown away on the bind
   path.

So the likely shape of the fix is **"absent" ⇒ the `$undefined` singleton;
`null` ⇒ `ref.null.extern`**, rather than a new companion global. Verify that
before committing to a design — the sloppy-mode global-object substitution
(`src/codegen/helpers/sloppy-this-global.ts`) and every `ref.is_null`-on-
`__current_this` reader have to agree on the new spelling, and that reader set
is the real blast radius.

## Why it needs its own slice

- It is **not** `bind`-specific: 4 of the 12 are `.call`/`.apply`.
- Its blast radius is every `this` read in standalone, so it needs a
  base-vs-head sweep far wider than the clause set above — nothing like the
  contained, gated change #4196 slice 1 could get away with.
- It **collides** with in-flight work: W21 is editing
  `src/codegen/named-this-call.ts` + `src/codegen/helpers/sloppy-this-global.ts`
  for the separate top-level-`this`-as-receiver admission fix (measured
  FIXED 4 / BROKE 0 on `10.4.3-1-{70,75}{-s,gs}`). Land that first; this issue
  should start from a tree that already contains it.

## Acceptance

- The 12 files above go fail → pass on `--target standalone`.
- A strict callee observes `null`, `undefined`, and a real object receiver as
  three distinct values; a sloppy callee still substitutes the global object for
  the first two.
- Verify-first (RED on the base commit), committed vitest, and zero regressions
  in a sweep sized to the `this`-reader population — not to `10.4.3`.

## Adjacent, explicitly NOT in scope

The **IsCallable-TypeError** family W21 also handed over — 18 files
(`language/expressions/call/11.2.3-3_{1..8}.js`, `S11.2.3_A2`,
`S11.2.3_A3_T{1..5}`, `S11.2.3_A4_T{1..4}`) plus
`built-ins/Function/prototype/{call,apply}/S15.3.4.{4,3}_A1_T{1,2}.js` — is a
different mechanism (calling a non-callable must throw TypeError; standalone
returns `undefined`/`null`). Verified still failing on
`issue-4196-bind-construct`. It shares a root with #4196's own 1-file IsCallable
row (`built-ins/Function/prototype/bind/15.3.4.5-2-1.js`) and should be sized
and sliced together with it, separately from this issue.

## Handoff from the #4202 lane — three things NOT to re-derive

Contributed by the lane that owns `named-this-call.ts` (issue #4202), after it
withdrew its own "this needs a new signal" conclusion. Recorded here because
they were established by measurement and would otherwise have to be found again.

### 1. Two states suffice, not three — and that is not obvious

The reader must answer for `f.call(null)`, `f.call(undefined)`, and a bare
`f()`. That looks like three spellings. It is not: **"absent" and "explicit
`undefined`" are observationally identical** under §10.4.3 — strict binds
`undefined` for both, sloppy binds the global object for both.

So `$undefined` can carry **both**, and `ref.null.extern` can mean **only**
explicit-null. That collapse is what makes the re-spelling tractable. Without
noticing it, the natural conclusion is that a third sentinel is required, which
is where the previous lane stalled.

### 2. The reader becomes a THREE-way branch, not a flipped two-way

Today the arm in `src/codegen/expressions.ts` (the `fctx.readsCurrentThis`
block, ~line 1135) reads the global, tests `ref.is_null`, and routes null to
`emitUnboundThis`, which itself splits strict/sloppy per #4190.

After the re-spelling it needs:

| observed | binding |
| --- | --- |
| `$undefined` | `emitUnboundThis` as today (strict → `undefined`, sloppy → global) |
| `ref.null.extern` | strict keeps `null`; **sloppy still binds the global object** |
| anything else | the value |

**The sloppy row is the trap.** Sloppy `f.call(null)` must still be the global
object, so this is emphatically *not* "stop coercing null".

### 3. Availability gate — the host lane has no non-null `undefined`

`undefinedSingletonActive` is `ctx.standalone || ctx.nativeStrings`, so the
JS-host lane has no non-null `undefined` in the externref plane. The
re-spelling therefore **cannot be unconditional**, and the host lane keeps
today's answer unless something else is arranged.

These rows fail on **both** lanes, so that is a decision to take deliberately
rather than discover in CI.

### File ordering

#4202's diff touches `named-this-call.ts` (3 lines in `receiverIsAdmitted`) and
`sloppy-this-global.ts` (one appended predicate). Once it lands, this issue's
edit to `receiverIsAdmitted` is a clean one-line addition beside it — the
`factIsStaticallyNullish` refusal is exactly the line to relax, and #4202 did
not move it.

---

## RESULT (W22, 2026-08-07) — shipped, FIXED 12 / BROKE 0

`--target standalone`, INTERPRETER runtime-eval tier
(`TEST262_FULL_RUNTIME_EVAL=1`), both arms re-cut on `origin/main` @ `b28970e206`
(post-#4201/#4202/#4196-slice-1). **The provider cache file was DELETED before
each arm's rebuild** — 3,995,550 B (base) vs 4,141,601 B (head) under the
*identical* cache key `854c120ce015d507`, which is the proof the instrument was
live on both arms and also a second confirmation that the key tracks neither
input nor output.

| population | base | head | |
| --- | ---: | ---: | --- |
| lever — the 12 files above | 0 | **12** | FIXED 12 |
| exposure — 489 files: `10.4.3-*` ∪ `Function.prototype.{call,apply,bind}` ∪ `expressions/call` | 301 | **313** | FIXED 12 / BROKE 0, and **zero error-signature changes among the 176 still failing** |
| control — 1,364 files: Array HOF `thisArg` ∪ `expressions/this` ∪ `statements/function` | 859 | 859 | FIXED 0 / BROKE 0 |

Two-sided: the base reproduces the published **standalone** jsonl file-by-file
(489 rows, 470 agreeing; of the 19 that do not, 12 are #4201's `bind/15.3.4.5.2-4-*`
which landed after that baseline was cut, 4 are CI `compile_timeout`/`compile_error`
rows that pass or fail identically here, and 1 —
`expressions/call/S11.2.4_A1.3_T1` — is a stable pre-existing local/CI
divergence present on both arms). The control at 859/859 shows the runner can
see a pass, so `BROKE 0` means something.

### The 12 files were TWO mechanisms, not one

The issue framed all 12 as the boundness substrate. Measured, only half are:

| n | files | mechanism |
| ---: | --- | --- |
| 6 | `-67`, `-72`, `-77` ×`{-s,gs}` | **boundness** — `f.{call,apply,bind}(null)` in strict code |
| 6 | `-79`, `-80`, `-98` ×`{-s,gs}` | **`.bind` dropped the receiver entirely** — the receivers are `o` / top-level `this`, never null |

`-79`/`-80`/`-98` need no boundness at all: `f.bind(t)()` reshaped to a direct
`call $f` and evaluated `t` only for its side effects. That is the
evaluate-and-DROP wrong answer #4025 removed for `.call` and #3983 for
`.apply`, still standing for the third surface
(`call-tail-dispatch.ts`, the `identifier.bind(…)(…)` arm). Anyone sizing this
issue from its title would have over-attributed the substrate by 2×.

### Design — the marker, and why NOT the re-spelling the issue proposed

The issue's lead was "absent ⇒ the `$undefined` singleton; `null` ⇒
`ref.null.extern`". That was rejected after reading the reader set, for a
reason that is about landability rather than elegance: `ref.null.extern` is the
**initial value** of `__current_this`, so re-spelling ABSENT flips the meaning
of every `ref.is_null`-on-`__current_this` reader in the tree simultaneously,
and there is no incremental way to land it or to attribute a regression.

The implemented direction is the inverse. "Absent" keeps its spelling exactly;
the explicitly-null receiver gets a distinct NON-null marker
(`__this_explicit_null`), and the change is purely additive.

**The marker is a second tag-1 `$AnyValue` instance**, distinguished from the
#2106 `$undefined` singleton only by reference identity (`ref.eq`). That is a
choice about the FAILURE mode, not about economy: the marker's reach is not
statically bounded — a callee entered through the trampoline can call further
functions that read `__current_this` without installing anything — so some
reader will eventually see it untaught. A reader that inspects the tag sees 1
and answers `undefined`, i.e. **exactly today's answer**. A dedicated struct
type would have failed every existing `ref.test` and surfaced as an opaque
object instead. (Those nested reads are already wrong for a non-null receiver
today — the global is not cleared across a direct call — so this adds no defect
class; it just refuses to make the existing one louder.)

Where it is produced: `named-this-call.ts`'s trampoline null arm, and **only
when the TARGET is strict**. A sloppy target's answer for null is already
correct (the global object, via the body's own `ref.is_null` arm), so its
trampoline is emitted byte-identically. Because the trampoline splits on the
receiver's RUNTIME value, this also fixes `f.call(x)` where `x` is dynamically
null — not just the literal.

Where it is consumed: one new arm in the `ThisKeyword` reader —
marker ⇒ `null` in strict code, **the global object in sloppy code**. That
sloppy row is the trap the #4202 lane flagged and it is load-bearing: §10.4.3
does not say "stop coercing null". Half of `tests/issue-4203-explicit-null-receiver.test.ts`
is that guard, green on both arms.

### Gates

- **Lane**: `ctx.standalone || ctx.nativeStrings` only, per the issue's
  availability note. Off that lane `undefined` has no guaranteed non-null
  externref form, so "the trampoline's null arm means the caller passed null"
  is not a safe reading, and a marker escaping into a JS host would be an
  opaque object rather than `null`.
- **Byte-neutrality**: the reader arm is gated on a per-SourceFile predicate —
  the file contains a `.call(`/`.apply(`/`.bind(` call AND contains strict code
  at all. Both conjuncts are *sound*, not heuristic: the marker is only ever
  installed by a trampoline whose target is a strict declaration in the **same**
  source file (`resolveDeclaration` enforces same-file), so a file failing
  either test can never observe one. Files that fail it are byte-identical.
- Measured cost where the gate does fire: the runtime-eval provider (a compiled
  JS interpreter, a module ⇒ strict throughout, `.call`/`.apply` everywhere) grew
  3,995,550 → 4,141,601 B, **+3.7 %**. That is the honest worst case for a
  `this`-heavy strict module.

### Note for #4192 / #4196

- **#4192's remaining `.bind` third is CLOSED by this PR for the
  function-DECLARATION form** — `tryReshapeBindToNamedThisCall`. Its
  *variable-held function-expression* form (`var fe = function …; fe.bind(o)()`)
  is NOT: that callee has a `closureMap` entry, so it takes the `closureInfo`
  branch and never reaches the trampoline. The reshape is deliberately gated on
  `!closureInfo`, mirroring #4192 slice 1's own gate.
- **#4196 row 4 ("`this` not applied through the bound call", 3 files) was
  already CLOSED before this PR, by something else.** `15.3.4.5-{11-1,6-2,6-6}`
  measured `pass` on the re-cut base *and* the head — so #4196's census row is
  stale and should be struck, not re-attributed to #4203. Do not count these 3
  toward either issue. The `$__bound_fn` carrier path (a bound value stored and
  called later, as opposed to immediate bind-and-call) is untouched by this PR
  either way; it remains #4196's.

### The 6-file `ToObject` seam is NOT subsumed — and putting it here would be WRONG

The census (`plan/log/es5-standalone-lever-census-20260807.md` §8) left
`10.4.3-1-{1,2,4}-s` + `10.4.3-1-{103,104,106}` unfiled pending this decision.
It is two seams, neither of them this one:

1. `bar.call(1)` with a **sloppy** `bar` must bind `ToObject(1)`. That is a
   transformation of the receiver VALUE, and it has an identity requirement my
   reader cannot satisfy: `ToObject` must run **once per call**, at the install
   site, or two `this` reads in one body mint two wrappers and `this !== this`.
   Doing it in the reader — the only place this PR touches — is therefore not
   merely out of scope, it is incorrect. The right home is the trampoline's live
   arm, gated on a sloppy target, using the existing standalone
   `__new_Number`/`__new_Boolean`/`__new_String` internals plus #4201's
   `WRAPPER_PRIMITIVE_KEY` slot so `valueOf` reads back.
2. `(5).x` through an `Object.prototype` accessor never reaches a `.call` site
   at all; its receiver install is in the property-access/accessor dispatch.

So: 3 files at the `.call` install site, 3 at the accessor install site. Both
compose with #4201 rather than colliding with it. Left unowned, deliberately,
and not silently absorbed.

### Residual gap, stated rather than hidden

A **strict** callee entered with an explicit null that then calls a further
function **directly** leaves the marker installed, so that callee reads `null`
where §10.4.3 wants `undefined`/the global object. This is the pre-existing
"`__current_this` is not cleared across a direct call" leak, which today
produces the *previous* receiver in the same position; the marker makes it
produce `null` instead. Not a new defect class, not measured as a regression in
either sweep, and the fix for it is to clear the global at direct calls — a
separate, much wider change.
