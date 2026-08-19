---
id: 3983
title: Standalone strict [[Set]] never throws — `__extern_set_strict` was an alias of `__extern_set`
status: done
completed: 2026-08-01
sprint: 78
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

### Scoped standalone test262 A/B (the CI worker path, not `runTest262File`)

Both arms: `TEST262_TARGET=standalone`, `--official-scope-only`, same
`TEST262_PATH_FILTER` (117 family + a 220-file in-sweep control sampled from
currently-passing files in the same directories). Arms differ only by
`src/codegen/object-runtime.ts` (base copy vs patched copy — file copies, never
`git stash`, `refs/stash` is one shared stack across every worktree). The
run script rebuilds `scripts/compiler-bundle.mjs` per arm and the disk-cache key
hashes that bundle, so the arms cannot serve each other's results.

**Arm A is current `upstream/main` (e240e7525), not the committed baseline jsonl** —
the baseline predates today's merges.

| bucket                                            |  n  | flips | regressions |
| ------------------------------------------------- | --: | ----: | ----------: |
| descriptor-enforcement family                     | 117 | **+24** |       **0** |
| in-sweep control (must not move)                  | 220 |   **0** |       **0** |

**Net +24, zero regressions.**

Floored, because the raw arms had **different denominators** (BEFORE 323 rows,
AFTER 337 — vitest kills a pool-timed-out test without writing a jsonl row, so
the run silently under-reports its own denominator). The aggregate pass counts
are therefore *not* comparable and were not used. All 14 missing rows were
accounted for individually:

- 13 of the 14 **pass in AFTER**, so they cannot be regressions regardless of
  their BEFORE status.
- The 1 that fails in AFTER (`defineProperties/15.2.3.7-6-a-4.js`) was re-run
  solo in the BEFORE arm and **fails there too** — not a regression.
- `language/types/reference/8.7.2-4-s.js` was missing from BEFORE and passes in
  AFTER; re-run solo in BEFORE it **fails**, so it is a genuine 24th flip.

**The control's 5 apparent flips were instrument noise, not results.** The
paired diff first showed `ctl +5 / −0`. Every one of the five carried
`error_category: compile_timeout` (`timeout (10s)`) in the BEFORE arm — fork-pool
contention, the #1589 flake class. Re-run solo in the BEFORE arm: **5 pass / 5
total.** They are excluded. Reporting them would have inflated the result to
+29 and, worse, would have claimed movement in a bucket whose entire purpose is
to prove nothing moved.

### Re-measured after the LOC-gate refactor

The `#3102` LOC-regrowth ratchet rejected the first shape (the builder sat
inline in `object-runtime.ts`, +94 lines over an 8,322 budget). Rather than take
a `loc-budget-allow:` grant, the builder was moved into its own subsystem
module, `src/codegen/object-runtime-strict-set.ts`, leaving a 3-line call site —
which is what the gate is actually asking for. The gate now passes with **no
allowance**.

Because that is a refactor of measured code, the AFTER arm was **re-run from
scratch** against the same BEFORE arm: **244 pass / 337 — identical**, and the
per-file diff is identical (`fam +23/−0`, plus the same floored 24th, and the
same 5 already-de-bunked control flakes). The refactor is behaviour-identical.

One discarded run is worth recording: the first re-measure was started
concurrently with the local quality-gate sweep and returned **119 rows instead
of 337**. Under load, vitest kills pool-timed-out tests without writing a jsonl
row, so the run silently truncates its own denominator — and 52/119 would have
looked like a catastrophic regression. It was discarded on the row count alone,
before any pass ratio was computed, and re-run on an idle box.

### Which 24 flipped, and why the other 13 did not

The 24: all **22** `language/expressions/compound-assignment/11.13.2-{34..55}-s.js`,
`language/expressions/assignment/11.13.1-2-s.js`, and
`language/types/reference/8.7.2-4-s.js`.

Of the 37 gated write-path files, **13 did not flip**, each for a named reason
that is *not* this defect:

- **6** `assignment/11.13.1-4-*` — strict assignment to a read-only **built-in
  global** (`Number.MAX_VALUE`, `Math.PI`, `Global.Infinity`, `Function.length`).
  Those are builtin statics, not `$Object`s carrying `$PropEntry` descriptors,
  so they never reach `__extern_set_strict`.
- **2** `built-ins/global/10.2.1.1.3-4-1{6,8}-s.js` — same mechanism
  (`NaN` / `undefined` value properties of the global object).
- **2** `Function/15.3.5.4_2-{19,20}gs.js` — `Function.prototype.caller`
  poisoning; unrelated.
- **1** `arguments-object/10.6-14-c-4-s.js` — `arguments.callee` poisoning;
  unrelated.
- **1** `assignment/8.14.4-8-b_2.js` — inherited non-writable, explicitly out of
  scope above.
- **1** `defineProperty/15.2.3.6-4-243-2.js` — Array receiver, `g-arraylen`'s area.

So the residual is fully attributed; there is no unexplained shortfall.

### Unit tests

`tests/issue-3983.test.ts` — 14/14 pass. Five throw-cases (setter-less accessor,
compound-assign to a setter-less accessor, `writable:false`, frozen,
non-extensible-new-key) and **nine must-not-throw cases** (array element, array
past-end, array expando, closure expando, accessor *with* a setter, sealed
object, Proxy set trap, computed key, `writable:true`). Every case also asserts
the standalone module has **zero host imports**, so the TypeError is constructed
natively.

The throw-cases put the write inside a nested callback on purpose — the
test262 `assert.throws(TypeError, function () { … })` shape. A write in the same
function as a statically visible `Object.defineProperty(o,"p",{writable:false})`
is constant-folded by the #3872 static mirror into an unconditional `throw`, so
an inline-shaped test would pass with the runtime path completely broken.

### Local gates

`tsc --noEmit` · `biome lint src tests scripts --diagnostic-level=error` ·
`prettier --check` on both changed files · `check-speculative-rollback-sites` ·
`check-oracle-ratchet` (+0/+0) · `check-issue-ids --against-main` — all green.

## Follow-ups (deliberately not folded in)

1. **31 unowned non-Array define-path files** in the same signature —
   `Object.create`/`defineProperties` descriptor-argument validation (§8.10.5
   steps 1/7.b/8.b/9.a) and §8.12.9-step-1 redefine-over-an-inherited-property.
   Different defect, no owner.
2. **Inherited non-writable data property** (`__obj_find` is own-only) — 1 file
   here, but it is the correct place to also fix inherited-accessor [[Set]].
3. **The #3872 static mirror never un-records on a re-define.**
   `Object.defineProperty(o,"p",{writable:false})` followed by
   `Object.defineProperty(o,"p",{writable:true})` leaves `p` in
   `ctx.nonWritableExternKeys`, so a subsequent write is still folded to a
   throw. Present in **both** arms of the A/B, so this change neither causes nor
   fixes it — but it is a real, silent, compile-time wrong answer.
