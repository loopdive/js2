---
id: 2865
title: "Standalone: no Wasm-native async-generator / for-await carrier — leaks __create_async_generator + Promise_* host imports"
status: ready
model: fable
fable_role: implement
created: 2026-06-30
updated: 2026-07-17
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2860, 2864, 2867]
umbrella: 2860
architect_spec: candidate
depends_on: [2864, 2867]
---

# Standalone: async-generator / for-await-of carrier

## Problem

`async function*`, `for await...of`, and async-generator destructuring have no
standalone carrier. They leak `__create_async_generator`, the `__gen_*` family,
and the `Promise_*` microtask imports.

### Impact (measured 2026-06-30) — ~986 standalone-only failures

The largest single cluster by my classifier. Proximate errors are
`illegal cast [in __iterator() ← fn]` / `[in __obj_find() ← __extern_set]`
inside async destructuring + for-await machinery (867 fail, 119 CE).

## Root cause

Async generators compose two missing standalone substrates: the **generator
state machine** (#2864) and the **Promise/microtask** runtime (#2867). An async
generator's `next()` returns a Promise of `{value, done}`; `for await` drives it
through the microtask queue. Neither exists natively in standalone.

## Implementation Plan

**Architecture-scale — `architect_spec: candidate`; depends on #2864 (generator
state machine) and #2867 (Promise carrier).** Do NOT start before both land.

Design sketch (for the architect):

- Reuse #2864's `$GenFrame` state machine; the resume function returns a Promise
  built on #2867's capability instead of a bare `{value,done}`.
- `for await (x of g)`: lower to a microtask-driven loop — `await g.next()`,
  unwrap `{value,done}`, run body, repeat — using the same await-lowering as
  async functions (verify async functions are already native in standalone; if
  they too leak `Promise_*`, that work is #2867).
- Async `yield*` delegates to the inner async iterator with await between steps.

## Test plan

Standalone fail/CE → pass:

- `test/language/statements/for-await-of/**`
- `test/language/statements/async-generator/**`,
  `test/language/expressions/async-generator/**`
- `test/built-ins/AsyncGeneratorFunction/**`, `AsyncFromSyncIteratorPrototype/**`
- `test/built-ins/Array/fromAsync/**`

Full `merge_group` + standalone high-water. Largest cluster but gated on two
predecessors — schedule after #2864/#2867.

## AG0 — host-free `await` unwrap (landed WASI-only; standalone deferred to #2895)

**Scope shipped:** under **`--target wasi`**, `await` now reads the resolved
value from the native `$Promise` carrier host-free; `async f(): Promise<number>
{ return await Promise.resolve(5) }` and async methods run with **zero host
imports** and return the correct value (was NaN, the identity-passthrough bug).

> **#2895 reconcile (2026-06-30) — standalone widening REVERTED, net-neutral.**
> AG0 originally widened `isStandalonePromiseActive` to
> `ctx.wasi || ctx.standalone`, activating the native `$Promise` carrier for
> `--target standalone` too. Ground-truth measurement on the #2384 frame-core
> base proved that widening is a **net regression** on standalone, **not** a
> gain: async standalone sample 134→103 pass (−31); the await+async-function
> area itself 71→42 (−29); **zero** offsetting await win. Root cause: the
> `flags:[async]` test262 harness uses _synchronous settlement_
> (`asyncTest(fn)` calls `fn()` then `$DONE()` with no microtask drain), so an
> async fn returning a native `$Promise` is observed as an undrained struct,
> not a value. The host-free standalone await gain is **coupled to a real async
> drive layer** (result `$Promise` + harness-drainable microtask settlement) =
> **PATH B (#2895)**, and is not bankable by a bounded gate flip. So
> `isStandalonePromiseActive` is reverted to `ctx.wasi` only: standalone returns
> to baseline (net-0, zero regression), WASI keeps the genuine native-`$Promise`
> behaviour + the await NaN-fix. PATH B re-widens the gate (and
> `isStandaloneThenChainNativeActive`) once the drive layer lands.

### Why these decisions (root-cause, not symptom)

Verify-first found the task's starting assumptions were stale on main: the
async-CPS state machine (`async-cps.ts`) is gated **off** for BOTH standalone
and WASI (`function-body.ts`), so async fns are compiled **synchronously** with
their unwrapped return type (`function-body.ts:668`), and `await` was a pure
**identity passthrough** (`expressions.ts`). So `await <a fulfilled $Promise>`
returned the promise OBJECT (externref) where the consumer expected the resolved
value → coerced to f64 = **NaN**.

- **`isStandalonePromiseActive` returns `ctx.wasi`** (`async-scheduler.ts`).
  For WASI (host-free), `Promise.resolve/reject`, the async-fn return wrap, and
  the await unwrap use the Wasm-native `$Promise` carrier instead of the host
  imports. Standalone is intentionally NOT widened here — see the #2895 reconcile
  note above (the harness can't drain native standalone async results without
  PATH B's drive layer).
- **`await` unwraps ONE level of the native `$Promise`** at runtime
  (`emitStandaloneAwaitUnwrap` in `expressions.ts`): a `ref.test (ref $Promise)`
  (non-null) discriminates — a `$Promise` operand yields its `value` field
  (field 1), anything else (a plain value, a null, a non-Promise thenable) passes
  through unchanged. The operand is compiled to its **natural** type (NOT forced
  to `expectedType` — that would coerce a `$Promise` externref to f64/NaN before
  it can be read); non-externref operands (an async call that already returns the
  unwrapped number) pass through.

### Deferred — genuinely-pending awaits → #2895 (AG1 / PATH B)

One-level unwrap does not serve a promise that only settles on a _later_
microtask/timer (async executor, `.then` observed synchronously, `Promise.all`
of pending). Those need true frame suspension (await-on-`$Frame` + microtask
resume) — filed as **#2895**. They were already wrong pre-AG0, so deferring is
not a regression. arch-asyncgen's AG0–AG5 spec lives on `origin/async-gen-2865-spec`.

### Files (AG0)

- `src/codegen/async-scheduler.ts` — `isStandalonePromiseActive` gate extension.
- `src/codegen/expressions.ts` — `emitStandaloneAwaitUnwrap` + the standalone/WASI
  `await` arm.
- `tests/issue-2865-standalone-async-await-unwrap.test.ts` — 7 standalone cases
  (zero-host-import asserted, correct values).


## Reconciliation note (shepherd, 2026-07-01)

Landed slice: **AG0** host-free await unwrap on native `$Promise` (PR #2380), reconciled net-neutral and **scoped to WASI**; the standalone async-generator drive is deferred to PATH B (#2895). Issue stays `in-progress`.

## Standalone carrier landed (fable-2865, 2026-07-09) — the #2906 3d machinery activated for `--target standalone` + the real test262 shapes

**What shipped (branch `issue-2865-standalone-asyncgen-carrier`).** The wasi-only
3d-i/3d-ii async-gen machine now serves the STANDALONE lane and the shapes real
test262 files are written in. Verify-first grounding: on main, `async function*`
under `--target standalone` was a #680 CE (decls) or a null-returning fn-expr,
and the 3d machinery was unreachable (`isStandalonePromiseActive` = wasi-only)
AND unreachable for the real test shapes even on wasi (the runner wraps every
test body inside `export function test()`, so gens are NESTED declarations /
fn-exprs compiled by nested-declarations.ts / closures.ts — never the
function-body.ts interception; and driving is `f().next().then(cb,$DONE)`, not
for-await).

### Layers (each probed on both lanes, host-free where noted)

1. **Standalone activation, carrier-independent subset.** `isAsyncGenDriveCandidate`
   accepts await-FREE bounded bodies under `isAsyncDriveActive` (standalone+wasi);
   `yield await P` bodies stay legacy under standalone (with the carrier off the
   awaited operand is not a native `$Promise` — driving would yield the un-awaited
   promise object). `decideAsyncActivation` gains a standalone arm accepting ONLY
   the for-await-over-async-gen consumer (every suspension awaits the machine's own
   `__async_gen_next_*` promise — carrier-independent). This is deliberately NOT
   the #2980 carrier widen (rule 2): `Promise.resolve`/statics/await lowering are
   untouched. `__drain_microtasks` lowers to the real drain when the module
   registered the native queue (still a no-op for machinery-free modules).
2. **Producer body generalization.** `analyzeAsyncGen` accepts suspend-free lead
   statements around top-level yields, ZERO-yield bodies (the forbidden-ext shape),
   and own identifier locals — spilled into the frame under the 3a loop rule (every
   yield is a suspend), typed via `resolveSpillLocalValType`, spill-safe-gated.
   Rejected (correct-or-legacy): `yield*`, nested yields/awaits, `return`
   statements (need a settleReturn terminator — 3d-iii), destructuring locals,
   binding-pattern/rest PARAMS (pattern bindings live in lifted-prologue locals the
   resume fn never sees — was invalid wasm on async-generator/dstr).
3. **Nested + fn-expr producers.** Interception in nested-declarations.ts (both
   capture branches) and closures.ts, before the `__create_async_generator` buffer
   arms. Capture support: nested decls thread `boxedCaptures` (per-capture cell
   params); closures record `selfCaptureLayout` (the `__self` struct layout) and
   the resume prologue RE-MATERIALIZES capture locals from the frame-captured
   `__self` — without this, capture resolution fell back to stale outer-scope
   local indices (`call $f (ref.cast nullref (local.get $0))` — a miscompile).
   TDZ-flagged captures stay legacy (their `boxedTdzFlags` store param indices).
   Stem-collision guard: a second same-named gen rejects (would share the first's
   typed next-helper → cast trap). `ctx.asyncGenProducers` registry added.
4. **Closure-context consumer.** `planAsyncClosureActivation` narrowly admits the
   for-await-over-async-gen drive through the #2646 phase-2 park (validated here;
   every other drive/host-drive closure shape stays parked). Const-held fn-expr
   producers resolve via the registry by INITIALIZER NODE (the anon stem never
   matches the binding name).
5. **`.next()` dispatch + `.then` bridge (the driving pattern).**
   `tryEmitAsyncGenNextDispatch` ref.tests each producer frame → per-gen driver,
   wired at the typed-AsyncGenerator site AND the any-receiver site. Miss arm:
   standalone keeps the original `__gen_next` behavior; wasi bakes it only when a
   legacy buffer gen exists (`ctx.asyncGenLegacyBufferEmitted`) so all-driven
   modules stay ZERO-IMPORT (tests/issue-1326 green). `isStandaloneThenChainNativeActive`
   widens to standalone WHEN the module registered the native scheduler: `.then`/
   `.catch` compile the #3035 ref.test receiver bridge (native receivers chain
   natively; host receivers keep the host path). Any-typed receivers route through
   the bridge too; wasi uses a new `nullMiss` variant (no host-import registration).

### Measured

- forbidden-ext decl files (stmt+expr async-generator): **2 (partially-vacuous)
  → 5 honest passes** under `runTest262File(..., "standalone")`; the distilled
  `f().next().then(cb, done).then(done, done)` shape runs host-free on wasi
  (`imports=[]`) and correct on standalone.
- 145-file construct-sampled standalone sweep (stmt/expr async-gen, for-await-of,
  AsyncGeneratorPrototype, AsyncGeneratorFunction, fromAsync): **zero per-file
  regressions** vs the pre-change baseline (before/after jsonl diff); the sample
  is dominated by shapes still out of scope (dstr, awaited yields, .throw/.return).
- Byte-inertness: 8-program × 3-lane sha256 matrix vs main — identical everywhere
  except the intended standalone async-gen cell (COMPILE_FAIL → host-free).
- Blast radius: 137 async/generator/closure unit tests green; the 7 failures in
  2865-AG0/2867-gap2/promise-combinators reproduce identically on clean main.

### Residuals (filed forward, all fail→fail vs baseline)

- **Self-referencing fn-expr producers** (`var f; f = async function*(){ ...f... }`
  — 10 forbidden-ext fn-expr files): `f()` returns null via the pre-existing
  void-trampoline dynamic-dispatch discard (#2939-family; the dispatch arm
  `call_ref $void; ref.null` swallows the frame). Fix belongs to the
  closure-value dispatch cluster (#2963/#3080), not the carrier.
- **Async-gen METHOD producers** (class + object-literal — class-bodies.ts:~2328,
  literals.ts:~2788 buffer arms): same interception pattern applies; needs
  `this`-receiver threading. ~25 remaining forbidden-ext method files.
- **`next(v)` sent-value delivery, `.throw()`/`.return()`** on driven gens
  (#2906 3d-iii; AsyncGeneratorPrototype cluster).
- **for-await INSIDE async-gen bodies** (the for-await-of dstr family) — needs
  loop states in `planAsyncGenCfg` + dstr bindings.
- **Awaited yields under standalone** — gated on the #2980 carrier widen
  (measured decision; do NOT flip piecemeal).

### #2895 / #2978 boundary

No new frame-suspension mechanism was needed — the carrier composes the landed
#2895/#2906 machine (suspend/settleYield/settleDone) unchanged; #2895's slice-1d
widen remains the only blocker for awaited-yield bodies under standalone. #2978
(for-await over a REJECTED promise, boxed-array source) stays blocked on the
carrier widen: the 3b array for-await is deliberately NOT activated under
standalone (its `Await(element)` operands are host promises with the carrier
off — the suspend arm would mis-classify them as settled values).
