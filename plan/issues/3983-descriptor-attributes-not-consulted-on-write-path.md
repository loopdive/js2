---
id: 3983
title: Standalone strict [[Set]] never throws — `__extern_set_strict` was an alias of `__extern_set`
status: in-progress
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
assignee: ttraenkler/sendev-descwrite
goal: standalone-gap
created: 2026-08-01
---

# Standalone strict [[Set]] never throws

## Root cause (one line, in-source)

`src/codegen/object-runtime.ts` registered the strict [[Set]] helper as a plain
alias of the sloppy one:

```ts
ctx.funcMap.set("__extern_set_strict", externSetIdx);
```

Every refusal inside `__extern_set` is a silent `return`. So in standalone mode
**every strict-mode write that ES §6.2.5.6 steps 3.d–e require to throw a
TypeError did nothing instead**, silently.

The front end was never the problem. `member-set-dispatch.ts:91` and
`compilePropertyAssignmentExternSet` (`expressions/assignment.ts:4068`) already
pick `__extern_set_strict` vs `__extern_set` from `isStrictContext`, and
`isStrictContext` correctly honours the harness's `inferModuleStrict=false` for
sloppy (`[noStrict]`) script tests. Both names simply resolved to the same
silent function. Host/gc mode has always carried the spec-correct catchable
TypeError through the JS sidecar; only standalone was open.

## Correction to the intake analysis — the mechanism was mis-stated

The task was handed over as *"descriptor attributes are not consulted on the
ordinary write path"*, with a ⚠ that sloppy assignment to a `writable:false`
property *"traps with a raw `WebAssembly.Exception`, which is not a catchable
TypeError"*. Measured on current `upstream/main`, **neither holds as stated**:

1. **The attributes ARE consulted.** `__extern_set` reads `FLAG_ACCESSOR` and
   `FLAG_WRITABLE` off the `$PropEntry` (object-runtime.ts:2401–2470) and
   `__reflect_set` computes the full [[Set]] boolean over the same flags. What is
   missing is not the *consult*, it is the *throw*: the consults only ever
   produce a silent no-op, which is correct sloppy behaviour and wrong strict
   behaviour.
2. **The exception is catchable and is a `TypeError`.** A probe that caught it
   in-module reported `e instanceof TypeError === true`. The
   "raw `WebAssembly.Exception`" observation came from a probe with **no
   `try`/`catch`** — an uncaught standalone throw surfaces to the JS host as an
   opaque `WebAssembly.Exception` by construction, which is a property of the
   probe, not of the defect.
3. **A third mechanism existed and was invisible to a value-only probe.** For a
   receiver that is a plain identifier with a statically-visible
   `Object.defineProperty(o, "p", {writable:false})` in scope, the write is
   **constant-folded at compile time** into an unconditional `throw`
   (`tryEmitNonWritablePropertyWrite`, `assignment.ts:4256`, the #3872 static
   mirror). So a naive inline probe *appears* to prove the runtime path works.
   Reading the emitted WAT is what separated the two — the `$f` body was
   literally `f64.const 2 / drop / global.get … / throw 0`, with no conditional.
   test262 does not use that shape: it writes inside the
   `assert.throws(TypeError, function () { … })` callback, across a function
   boundary the static mirror does not cross.

## Fix

Register `__extern_set_strict` as a genuine native helper, after
`__reflect_set` exists, defined in terms of it:

```
if (!ref.test $Object)      -> __extern_set(o,k,v); return      // no throw
if (__reflect_set(o,k,v)==0) -> throw new TypeError(...)
```

Two deliberate design points, both load-bearing:

- **Layered over `__reflect_set`, not a second flag walk.** `__reflect_set`
  already computes exactly this boolean over the same `$PropEntry` flags and
  delegates a *permitted* write back to `__extern_set`, so an allowed write
  still runs the accessor driver / insert path exactly once. Re-deriving the
  predicate would be a second copy to keep in sync with descriptor semantics.
- **The non-`$Object` receiver short-circuit is required, not defensive.**
  `__reflect_set` answers **false** for any non-`$Object` receiver — arrays
  (`$Vec`), closures, native strings, `$Proxy`, genuine host externrefs. Those
  are routed by `__extern_set` into the #3468 closure / #3537 vec expando side
  tables and are perfectly legal writes. Throwing on `__reflect_set === 0`
  unconditionally would turn `"use strict"; a[0] = 1` on an array into a
  TypeError.

There is in-tree precedent for the shape: `ensureDynMemberSet`
(`dyn-read.ts:837–844`) already does `__reflect_set` + throw-on-false for the
standalone/wasi *dynamic* member-set path. This applies the same rule to the
static-name path, which is where the test262 shapes live.

### Explicitly out of scope

A non-writable data property inherited from the **prototype**. `__obj_find`
walks the own table only, so `__reflect_set` returns true and the write lands as
a new own property. That is pre-existing behaviour and is **unchanged** by this
fix — closing it needs a proto-chain walk inside `__reflect_set`, which risks
the ordinary shadowing write, so it is scoped separately. Population in this
goal scope: `language/expressions/assignment/8.14.4-8-b_2.js`, 1 file.

## Population — measured, with denominators

The intake called this a **117-file family**. Re-derived deterministically (all
four instrument checks reproduce exactly: 43,106 official rows / 25,460 pass /
59.1% → 8,545 in-scope / 6,004 pass / 70.3% → 158 signature → 117 family, 48
outside `built-ins/Object/`). But classifying the 117 **by what each test body
actually does** shows it is *not one mechanism*:

| sub-family (by test body)                                | files | owner                            |
| -------------------------------------------------------- | ----: | -------------------------------- |
| throw expected from an **assignment / compound-assign**   |  **37** | **this issue**                 |
| throw expected from `Object.define*`/`create`, Array recv |    35 | `g-arraylen` (out of scope)      |
| throw expected from `Object.define*`/`create`, non-Array  |    31 | unowned                          |
| `Function.prototype.caller` poisoning (`15.3.5.4_2-*gs`)  |    11 | unrelated mechanism              |
| `Object.getOwnPropertyNames(undefined/null)`              |     2 | argument validation              |
| `arguments.callee` poisoning                              |     1 | unrelated mechanism              |

**So the honest gate for this fix is 37, not 117** — 36 non-Array
(all 22 `compound-assignment`, 8 `assignment`, 2 `built-ins/global`, 2
`Function/15.3.5.4_2`, `types/reference/8.7.2-4-s.js`,
`arguments-object/10.6-14-c-4-s.js`) plus 1 Array-receiver write
(`defineProperty/15.2.3.6-4-243-2.js`). Of those, 1
(`8.14.4-8-b_2.js`, inherited non-writable) is explicitly out of scope, leaving
**36 gated**. 37 is a *gate*, not a flip forecast; the measured flip count is
recorded under Test Results.

The remaining **31 non-Array define-path files are unowned** and are a real
follow-up: `Object.create`/`defineProperties` descriptor-argument validation
(`8.10.5` steps 1/7.b/8.b/9.a) and `8.12.9 step 1` redefine-over-an-inherited-
property. They are a different defect and should not be folded in here.

## Attribution evidence (kill-switch by removal)

A 14-case no-regression battery covering array element / past-end / expando
writes, closure expandos, Proxy set traps, class fields, sealed objects,
accessors *with* setters, computed keys and a hot loop was run in both arms by
swapping `src/codegen/object-runtime.ts` between the base and the patched copy
(file copies — never `git stash`, `refs/stash` is shared across worktrees).

**Signatures identical, 14/14.** The one non-`1` row
(`redefine clears writable:false` → throws) is present in **both** arms: it is
the #3872 static mirror never un-recording `nonWritableExternKeys` on a
re-define, a pre-existing defect this change neither causes nor fixes.

## Instrument artifacts caught while doing this

Recorded because each one produced a confident, wrong answer:

1. **Path root mismatch → a clean zero.** The re-derivation resolved test262
   frontmatter against `<worktree>/<file>` instead of `<worktree>/test262/<file>`.
   Step 1 matched the expected 43,106/25,460 exactly and steps 2–4 returned
   `0 / 0 / 0`. A passing first check does not validate the later ones.
2. **String returns do not marshal out of a standalone module.** A probe
   returning `string` from an exported function reported `undefined` for every
   arm *including the positive control* — which is the only reason it was caught.
   Numeric return codes only.
3. **A compile-time fold impersonating a runtime feature** — see Correction 3
   above. The value-level probe said "writable:false already throws"; the WAT
   said the write had been replaced by an unconditional `throw`.

## Test Results

(filled in below)
