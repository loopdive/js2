---
id: 2906
title: "Standalone: generalize the async drive layer → multi-state, CFG-aware CPS resume machine (unlocks try/finally-across-await, for-await, multi-await)"
status: in-progress
assignee: claude/es6-team-generators
created: 2026-07-01
priority: high
feasibility: hard
model: fable
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2895, 2867, 2864, 2865, 2367]
umbrella: 2860
architect_spec: authored
loc-budget-allow:
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
  - src/codegen/context/types.ts
  - src/codegen/statements/control-flow.ts
---

# Generalize the async drive layer to a multi-state CFG-aware CPS resume machine

## Problem

The landed host-free async **drive layer** (#2895 slices 1a–1c, PRs #2393/#2394)
is **single-await by construction**. It only drives the three canonical shapes
that `async-cps.ts splitBodyAtAwait` accepts and rejects everything else:

```ts
// src/codegen/async-cps.ts:594  splitBodyAtAwait(...)
if (plan.awaitPoints.length !== 1) return null; // L596 — multiple awaits → reject
if (plan.hasTryAcrossAwait) return null; // L597 — try/finally/catch around an await → reject
// supported shapes only: `return await P` | `const x = await P; <rest>` | `await P; <rest>`
```

`asyncFnNeedsCps` (async-cps.ts:292) gates on `splitBodyAtAwait`, so an async
function whose body has **any** richer control flow around an await — a
`try/finally` across an await, a `for-await-of` loop, or simply two awaits — is
**not driven**: it falls back to the synchronous AG0 one-level unwrap, which
returns the pending `$Promise.value` (null/stale) for a genuinely-pending await.

`async-frame.ts ensureAsyncResumeFunction` (L317) hard-codes a **2-state**
machine (entry segment + single continuation) built from that single split — it
has no finally-region routing, no loop back-edge, and no general br_table over N
suspend points.

This blocks the two remaining standalone-async carrier gaps and the count-move:

- **Gap 3** (#2867) — `try/finally`-across-await: the finally region must run on
  the normal continuation AND on the abrupt (throw / rejected-await / return) arms
  after resume.
- **Gap 5** (#2867) — `for-await-of` / async-generator drive: awaits iterated
  inside a loop body (the AG2 generator/async-frame convergence).
- multi-await-in-linear-code (`const a = await p; const b = await q; ...`).

All three need the **same** thing: a general resume machine. They cannot each be
bolted onto the 2-state machine as inert slices without re-deriving the same
generalization three times (a partial machine strands — the #2367 graveyard). So
this is one XL substrate issue that **unlocks Gap 3 + Gap 5 + multi-await
together**, after which those become bounded slices and the slice-1d carrier
widen can finally be measured.

## Root cause / design (the general machine)

Replace the single-await `splitBodyAtAwait` + 2-state resume with a **CFG-numbered
multi-state** lowering, reusing the existing substrate (do NOT fork it):

1. **Suspend-point numbering.** Walk the async body and assign each `await` (and
   each loop-iteration await) a distinct **state id**. State 0 = entry. The body
   is lowered into a `br_table` over `frame.STATE_FIELD` (frame-core ABI), exactly
   the dispatch shape `generators-native.ts ensureNativeGeneratorResumeFunction`
   (L1781) already uses for `yield`. Reuse `frame-core.ts`
   `setStateInstrs`/`storeSpills`/`defaultSpillInstr` verbatim; the `$AsyncFrame`
   struct (`buildAsyncFrameInfo`) already carries `STATE`/`SENT`/`MODE`/`ABRUPT`/
   `ERROR` + params + spills + `result_promise`.

2. **Structured control flow → state transitions.** Lower the async body's
   statement tree to segments split at each suspend point, preserving structure:
   - **sequence**: segment N runs to the next await, suspends (storeSpills + set
     STATE=N+1 + register reaction + return), resumes at segment N+1.
   - **`try/finally`-across-await (Gap 3)**: the finally block is emitted as a
     **shared finally region** reached from (a) the normal end of the try body and
     (b) every abrupt completion that crosses it — a `throw` in the try, a
     rejected-await (`MODE_THROW` arm, already wired by Gap 2), and a `return`
     inside the try (route the `asyncDriveReturn` settle through finally first).
     Model abrupt completion with the frame `MODE_FIELD`/`ABRUPT_FIELD`/`ERROR_FIELD`
     (frame-core already defines them) — finally runs, then the pending completion
     is replayed (re-throw / settle-return). `try/catch` is the same skeleton with
     a catch target instead of/in addition to finally.
   - **`for-await-of` / loops (Gap 5)**: a loop with an await in its body is a
     back-edge in the state graph — the continuation after the body's await branches
     back to the loop-head state. for-await-of additionally drives the async
     iterator protocol (`[Symbol.asyncIterator]()` → `next()` returns a `$Promise`
     of `{value,done}`), each `next()` await being a suspend point. Async generators
     converge the `$Frame` (generators-native) and `$AsyncFrame` (async-frame) — the
     AG2 convergence noted in #2895/#2865.

3. **Settle / reject routing.** Reuse `async-scheduler.ts` `__promise_fulfill`/
   `__promise_reject` + the microtask ring + `$PromiseCallback` reactions verbatim
   (the same primitives Gap 1/2/4 already compose). The step adapters
   (`__async_step_f<name>_{fulfill,reject}`) and the call-site shim
   (`emitAsyncFrameStateMachine`) generalize from 2 states to N with no ABI change.

## Hazards to spec against (cite in the build)

- **funcIdx / type-index stability** (#1677/#1809/#1899): reserve the resume-fn +
  step-adapter funcIdx slots with placeholder bodies BEFORE emitting the body —
  `compileStatement` lazily appends helper functions. The N-segment body emits more
  helpers than the 2-state machine, widening this window. Register all shared types
  (`$Promise`, `$PromiseCallback`, `$AsyncFrame_<name>`) up-front.
- **stack-balance type-repair** (#2895 codegen lesson): narrow an awaited
  `$Promise` into a single typed `(ref $Promise)` local once; repeated
  `local.get externref; any.convert_extern; ref.cast` confuses the repair pass.
- **liveness across multiple awaits**: the spill set must include every local live
  across ANY suspend point (union over states), not just one await's suffix
  (`computeAsyncSpills` currently computes for the single split — generalize to the
  CFG).
- **carrier-gating + the −16/−29 corpus guard**: keep every new path gated on the
  carrier (`isStandalonePromiseActive`, wasi-only until slice 1d) so gc/host and
  still-host-backed standalone stay **byte-identical** (verify by binary hash, the
  discipline Gap 4 / the drain-hook used). The slice-1d widen is a SEPARATE final
  step, measured NET-POSITIVE on the full `merge_group` standalone corpus.

## Suggested slicing (each inert, carrier-gated, independently mergeable)

1. **multi-await-in-linear-code** — generalize numbering + br_table for ≥2
   sequential awaits, no try/loop. Smallest validation of the N-state machine.
2. **Gap 3 — try/finally-across-await** — add the shared finally region + abrupt
   routing on the normal + reject + return arms.
3. **Gap 5 — for-await-of** — loop back-edges + the async-iterator protocol drive.
4. **Gap 5 — async generators** — the `$Frame`/`$AsyncFrame` AG2 convergence.
5. **slice-1d widen** (owned by #2895/#2867) — widen `isStandalonePromiseActive` +
   `isStandaloneThenChainNativeActive` to `standalone`, measured net-positive.

## Predecessors (LANDED)

Drive layer #2393/#2394 (async-frame.ts), carrier Gaps 1/2 (#2867), Gap 4 native
combinators (#2867, PR #2403), the `__drain_microtasks` runner hook (#2895, PR
#2404), the Test262Error native carrier (#2397), and the stored-`Promise<T>`
consumption contract (#2402/#2905) are all on `main` — so the eventual widen sees
the compounded async unlock.

## Test plan

Per slice, host-free wasi tests (`__drain_microtasks`, `result.imports` empty)
covering the new shape, plus the byte-hash inertness proof (gc/host + standalone
unchanged). The slice-1d widen is gated on the full `merge_group` standalone
corpus (sr-pathb's 74-file async-function + the 150-sample for-await/async-gen/
Promise.then/all cluster) measuring NET-POSITIVE — the authoritative gate.

## Slice 1 — multi-await-in-linear-code (LANDED, host-free wasi lane)

**What shipped.** The single-await 2-state resume machine
(`async-frame.ts ensureAsyncResumeFunction`) is generalized to a **general
N-state machine** driving a LINEAR async body with any number of sequential
awaits (no try/finally, no loops — those stay Gap 3 / Gap 5). New surface:

- `async-cps.ts planLinearAwaits(fn, plan)` — the multi-await generalization of
  `splitBodyAtAwait`. Splits a linear body into ordered suspend segments (one per
  await at a canonical top-level position: return-arg / single-var-init /
  expr-stmt). Returns `null` (→ legacy/AG0 fallback) for try-across-await, awaits
  in loops/`if`/expressions, two awaits in one statement, or dead code after
  `return await`. **`splitBodyAtAwait` is left UNCHANGED** so the JS-host CPS
  path + `asyncFnNeedsCps` stay byte-identical.
- `async-frame.ts asyncFnNeedsDrive(ctx, fn, plan)` — drive-layer eligibility.
  For a SINGLE await it returns the same verdict as `asyncFnNeedsCps` (identical
  real-suspension + Promise-combinator gates), so wasi single-await routing is
  unchanged; ≥2 awaits are newly accepted. `function-body.ts` swaps the drive
  branch from `asyncFnNeedsCps` → `asyncFnNeedsDrive`.
- The resume machine is now a `try { block { loop { if-chain } } } catch $exn`
  dispatch (mirrors `generators-native.ts emitTrampoline`): STATE `s` (0..N-1)
  runs await `s` — FULFILLED delivers SENT + `br`s to re-dispatch at `s+1`
  (chaining synchronous fast-path awaits within one call), REJECTED arms
  MODE_THROW + advances (next prelude re-throws), PENDING spills + registers the
  reaction + `return`s. STATE N settles. The advance `br`-to-loop depth is
  `stateId + 2` (validated at runtime).

**Why one machine, no fork (the #2367 graveyard rule).** The two microtask step
adapters are **STATE-agnostic** — they only write SENT/ERROR then call resume,
which routes by STATE — so N states reuse the SAME two adapters with **no ABI
change**. The 2-state `buildEntrySegment`/`buildContinuationSegment` were
**deleted**, not left beside a parallel multi-await path: single- and multi-await
both flow through the one general machine, which is the substrate Gap 3
(finally-regions) and Gap 5 (loop back-edges) extend.

**Spill correctness (the multi-await-specific hazard).** The spill set is now the
UNION over every await `k` of the locals live across await `k`'s suspend, minus
params and minus await `k`'s OWN resume binding (delivered fresh from SENT). A
resume binding from an EARLIER await that survives a later await IS spilled — the
core case `const a = await p; const b = await q; use(a)`. Such a spilled binding
reuses its spill local (no double-`allocLocal`) and is typed via
`resumeBindingValType` so the frame field and local round-trip. Iterating awaits
in order over insertion-ordered Sets + skipping only each await's own binding
keeps a single-await body's spill list byte-identical to pre-#2906.

**Slice-1 scope guard.** A resume binding that must be SPILLED across a later
await is required to have a spill-safe type (`i32`/`f64`/`i64`/`externref`/
`ref_null`); a non-null GC-ref binding would need an invalid `ref.null`
field default, so those fall back to legacy (a later slice can widen this).

**Byte-inertness proof (the −16/−29 discipline).** Compiled 4 representative
programs (single-await, 2×multi-await, plain) under gc(default) / standalone /
wasi and sha256'd the binaries before vs after:

| program      | gc        | standalone | wasi                      |
| ------------ | --------- | ---------- | ------------------------- |
| singleAwait  | identical | identical  | CHANGED (general machine) |
| multiAwait   | identical | identical  | CHANGED (new drive)       |
| pendingMulti | identical | identical  | CHANGED (new drive)       |
| plain        | identical | identical  | identical                 |

gc/host + standalone are **byte-identical** — the drive branch is gated on
`isStandalonePromiseActive` (wasi-only), so neither lane reaches the changed
code. Only wasi (the native-`$Promise` carrier lane) changes, which is the
intended unlock. The slice-1d `isStandalonePromiseActive` widen stays LAST,
after Gaps 3/5, gated on a NET-POSITIVE full `merge_group` standalone corpus.

**Verification.** `tests/issue-2906-async-multiawait.test.ts` (6 host-free wasi
tests: 2/3 sequential fast-path awaits, spilled-binding-across-suspend, bare-await
sequences, `return await` as final segment, and the critical two-genuinely-pending
chain resolving to 4142 via `__drain_microtasks`). All 10 pre-existing
`issue-2895-async-frame` / drain-hook tests still pass (single-await parity). The
2 `issue-2865` + 2 `promise-combinators` failures are **pre-existing on
upstream/main** (verified in a base worktree), not #2906 regressions.

**Unblocks.** Gap 3 (try/finally-across-await) and Gap 5 (for-await-of /
async-gen) now extend this ONE N-state machine instead of re-deriving the
generalization; multi-await-in-linear-code works host-free today. The count-move
carrier widen (slice 1d) remains gated on all resume-machine slices + a
net-positive standalone corpus.

## Slice 2 — Gap 3: try/finally-across-await (LANDED, host-free wasi lane)

**What shipped.** `try { …awaits… } finally { F }` spanning an await is now
driven on the N-state machine (previously `planLinearAwaits` rejected it via the
`hasTryAcrossAwait` gate → AG0). The finally runs on **all four completion
paths**, reusing the generator's `activeFinalizers` model (not a re-derivation):

- **`async-cps.ts`** — `planLinearAwaits` is now **recursive + try-region-aware**
  (`lowerLinearStatements`): it recurses one level into a `try` body carrying the
  finally as the active finalizer, weaving the finally into the post-try lead for
  the **normal path** and tagging every statement with a per-statement
  `leadInTry`/`tailInTry` flag (covers the outer→in-try entry AND the
  in-try→finally exit boundaries within one lead — a `throw` between the last
  in-try await and the finally still runs it).
- **`async-frame.ts`** — a resume-local `inSrcTry` flag records whether control is
  inside the try region (toggled per statement by the `leadInTry` flags; armed in
  the rejected-predecessor `MODE_THROW` prelude). The resume function's outer
  `catch` runs the finally (compiled a SECOND time, fresh Instr[]) before
  rejecting **iff `inSrcTry`** — so a synchronous throw or a rejected await that
  crossed the try runs the finally, while a throw outside it (or in the finally
  itself) does not. Normal completion runs the inline copy woven into the lead.

**Four paths, all verified** (`tests/issue-2906-gap3-tryfinally.test.ts`, 6
host-free wasi tests): normal completion, synchronous throw after the await,
synchronous throw before ever awaiting, pending-then-rejected (finally runs on the
`MODE_THROW` resume via `__drain_microtasks`), pending-then-fulfilled, and
post-try statements ordering (finally before them).

**Bounded slice (everything else falls back — correct-or-legacy).** Single,
non-nested `try/finally`, one per fn, await-free finally, **no `catch`**, **no
`return` in the try body**. `planLinearAwaits` returns `null` for anything richer
(try/catch, nested/second try, await-in-finally, return-through-finally), so those
stay on the legacy/AG0 path — no wrong finally semantics, ever. try/catch and
return-through-finally are the immediate follow-ups (they reuse this same
`inSrcTry` + abrupt-completion machinery).

**Byte-inertness proof.** gc/host + standalone are **byte-identical to `main`**
for every program (single/multi-await/plain via slice 1; `try/finally` verified
directly against a `main` worktree: gc `3e42…`/standalone `116a…` unchanged).
Non-try async **wasi** output is byte-identical to slice 1 — Gap 3 adds **zero
churn** to non-try async; only a `try/finally`-across-await program's wasi bytes
change (the intended unlock). All Gap-3 machine instrs are guarded on
`hasFinalizer`, so the non-try path emits the slice-1 machine unchanged.

**Stacked on slice 1 (#2413)** — branch `issue-2906-gap3-tryfinally` from the
slice-1 branch; enqueue after #2413 lands. Gap 5 (for-await / async-gen) builds on
this same abrupt-completion machinery; the slice-1d widen stays LAST.

## Reconciliation note (shepherd, 2026-07-01)

Landed slices: **slice 1** general N-state async resume machine (PR #2413), **slice 2 / Gap 3** try/finally-across-await on the N-state machine (PR #2416). Issue stays `in-progress` for the remaining slices.

## Reconciliation note (2026-07-04)

Landed since: **slice 3** CFG-aware machine core (PR #2413-follow), **slice 3a** while-with-await loop producer, **slice 3b** for-await-of async-iterator carrier (this PR — `planForAwaitCfg` + `forAwaitPoints` coupling + emit-hook operands). `for await (x of [P.resolve(1),…])` now works host-free (→ 6, imports `[]`). Issue stays `in-progress` for 3b′ (user async iterables / destructuring binding / break-continue via `it.return()`), **3c** (try/catch + return-through-finally + nested regions), and **3d** (async generators — now unblocked, reuses this carrier).

## Slice 3 — CFG-aware machine core (this PR, 2026-07-03)

**What ships.** The drive-layer emitter is generalized from the implicit linear
chain (state `s` always continues at `s+1`; try/finally = one boolean flag) to a
**general CFG plan** — the durable substrate every remaining slice extends
without touching the emitter again:

- **`async-cps.ts`** — `AsyncCfgPlan`: `states` (basic blocks: optional
  `resumeFrom` prelude + handler-annotated `lead` statements + exactly one
  `terminator`) and `handlers` (try-region table). Terminators:
  `suspend {awaited, resumeState, handler}` · `goto {target}` ·
  `condGoto {cond, whenTrue, whenFalse, handler}` · `settleSent` ·
  `settleUndefined`. The **emitter contract** (dense ids; goto/condGoto targets
  have no resume prelude; handler ids 1-based dense, `parent === 0` until 3c) is
  documented in the file's contract block. `linearPlanToCfg(linear)` converts a
  `LinearAwaitPlan` into the trivial chain and is the ONLY producer this slice.
- **`async-frame.ts`** — `ensureAsyncResumeFunction` now drives `AsyncCfgPlan`:
  one generic `buildStateBody(state)` replaces
  `buildAwaitSegment`/`buildFinalSegment`; the slice-2 `inSrcTry` boolean is now
  the **handler-region-id local** (i32, 0 = none — single-region plans emit
  byte-identical 0/1 toggles); the outer catch routes by region id (truthiness
  guard for one region ≡ slice 2, id-equality guards for sibling regions).
  `validateAsyncCfg` hard-fails (compile error, not a miscompile) any future
  planner that violates the contract. **`br`-depth model**: from a state arm's
  top level the re-dispatch loop is at depth `id + 2` (dispatch if-chain nesting
  == id); `goto`/`condGoto` emit `STATE=<target>; br <loop>`, so a **back-edge
  is just a target ≤ the current id** — loops need NO new emitter machinery.
  `condGoto` compiles its condition with `ensureI32Condition` truthiness and
  br's at `loopDepth + 1` (inside its own `if` arm).

**Byte-inertness proof** (`.tmp/hash-async-lanes.mts`, 27 program×lane sha256
hashes): plain / singleAwait / multiAwait / bareAwaits / returnAwait /
tryFinally / syncFulfilledLocal / promiseAllHost / awaitArith, each under
gc(default) + standalone + wasi — **all identical before vs after**, including
the wasi drive lane and the #1042 host-drive lane (`linearPlanToCfg` reproduces
the exact pre-CFG instruction stream; goto/condGoto are producer-unreachable
this slice). Test control: the 10 async test files (89 tests) — 85 pass, the
same 4 pre-existing failures as on `origin/main` (2× issue-2865 AG0 wasi, 2×
promise-combinators host — their compiled binaries hash-identical to main's, so
they cannot be #2906-slice-3 regressions).

**#2980 coordination**: this slice does not touch either carrier gate
(`isStandalonePromiseActive` / `isStandaloneThenChainNativeActive`) and is
byte-identical everywhere, so it neither constrains nor is constrained by the
slice-1d carrier-widen decision — the widen simply flips which lanes reach this
(unchanged-shape) machine.

## Slice 3b — for-await-of: the native async-iterator carrier (LANDED, host-free wasi lane)

**What shipped.** `for await (const x of source)` over a BOXED-element array (the
dominant test262 shape — `for await (x of [P.resolve(1), …])` / object arrays) is
now driven host-free on the 3a CFG machine. `for await (x of [P.resolve(1),
P.resolve(2), P.resolve(3)]) sum += x` → **6, imports `[]`** (was NaN). Both
blockers the 3b grounding (PR #2653) identified — which sat BELOW the drive
machine — are closed:

- **(1) implicit-await coupling.** A `for await` carries no `ts.AwaitExpression`,
  so `analyzeAsyncBody` reported 0 await points and every `awaitPoints`-keyed gate
  treated the fn as non-suspending (→ AG0 unwrap → the loop var held the
  un-awaited Promise → NaN). `AsyncCpsPlan` now also carries **`forAwaitPoints`**
  (`ForOfStatement`s with an `awaitModifier`), and `asyncFnNeedsDrive` recognises
  a bounded for-await-only body as suspending.
- **(2) the async-iterator carrier.** `planForAwaitCfg` (async-cps.ts) lowers the
  loop onto the existing CFG machine as the spec-equivalent
  `it = GetAsyncIterator(source); loop { {done,value} = it.next(); if (done)
break; x = await value; <body> }` (§7.4.3 GetIterator(async) + §27.1.4.4
  AsyncFromSyncIterator: `Await(value)` — a Promise element double-resolves to its
  value). No NEW emitter machinery: the sync `it.next()` step, the `done` test and
  the element are RUNTIME ops on wasm locals — not checker-typed AST — so they are
  injected via two new **emit hooks** (`AsyncCfgStepEmit` / `AsyncCfgValueEmit`)
  threaded through the stock `condGoto` (done → exit) + `suspend` (await value) +
  back-edge `goto(head)` substrate. This deliberately avoids the #2367
  synthetic-AST wall (a synthetic identifier the checker can't type mis-lowers
  element access). The persisted iterator is a synthetic frame spill
  (`FORAWAIT_ITER_SPILL`, reloaded on every resume); the element/done locals are
  transient (recomputed each head, never crossing a suspend).

**This is the reusable substrate async generators (3d) consume** — the same
emit-hook carrier drives an async-gen's `next()` protocol.

**Bounded slice (everything else → legacy/AG0, correct-or-legacy).** Exactly one
top-level `for await`, no bare `await` in the body, simple `const`/`let x`
identifier binding, linear-canonical body with NO `break`/`continue`/`return`/
`try`/nested loop/labeled/`switch`. **Drive gate**: only BOXED-element sources
(the source's `getNumberIndexType()` resolves to externref/GC-ref — Promise/object
arrays). Unboxed-primitive arrays (`number[]`) settle immediately (`Await(v)=v`) so
the legacy sync path is already correct — and their typed WasmGC representation
would trap the vec-based `__iterator`, so driving them is (correctly) rejected.
Non-array / user-iterable sources (unknown index type) stay on legacy — general
`AsyncFromSyncIterator` / user-`@@asyncIterator` is the 3b′ follow-up (abrupt loop
exit via `it.return()` — an async close — is also 3b′).

**Byte-inertness proof (the −16/−29 discipline).** sha256 of 6 programs ×
{gc, standalone, wasi} before (origin/main) vs after: **gc + standalone identical
for ALL programs** (the drive is gated on `isStandalonePromiseActive`, wasi-only,
so neither lane reaches the changed code); **wasi identical for every program
except a for-await** (plainAsync / multiAwait / whileAwait / syncForOf / plain all
byte-identical; only the for-await wasi bytes change — the intended unlock). A
`number[]` for-await is byte-identical to main in BOTH gc and wasi (it stays on
legacy — no regression).

**Verification.** `tests/issue-2906-3b-forawait.test.ts` (7 host-free wasi tests:
the settled-Promise proof → 6; the genuinely-pending drain proof → suspends at 0,
resumes to 23; pre/post statements; zero-element source; bare-body count; a
rejected element rejecting the result promise without trapping; and the
`number[]` legacy-path parity). The full async suite (2895/2906-3a/multiawait/
gap3) shows the SAME pass/fail set as origin/main — the 3 gap3-tryfinally
throw-path failures are pre-existing (a `{}`-instantiation harness gap), verified
identical on a `main` worktree.

**Unblocks 3d (async generators):** the emit-hook async-iterator carrier + the
`forAwaitPoints` suspension coupling are the substrate 3d reuses for the
`next()`-queue protocol; 3d is now a planner-only follow-up (`settleYield`
terminator + result-promise queue) on this same machine.

## Design (banked): how the remaining shapes map onto the CFG machine

The remaining slices are **planner-only** — each produces `AsyncCfgState[]` and
the emitter (validated, byte-stable) does the rest. Written for execution by a
non-Fable dev; read the emitter-contract block in `async-cps.ts` first.

### 3a — while/do-while-with-await (the back-edge validation slice)

Lowering for `while (cond) { body… (≥1 canonical await) }`:

```
state h   (loop head, resumeFrom: null): lead=[], terminator condGoto(cond, b, e)
state b…  (body states, as linear lowering): last body state's terminator
          suspends with resumeState → a continuation state whose terminator is
          goto(h)   ← the back-edge
state e   (exit): the statements after the loop (continues the outer chain)
```

Implementation notes (the hazards a cheaper model must not skip):

1. **New producer, not a `LinearAwaitPlan` retrofit.** Introduce
   `planAsyncCfg(fn, plan, opts): AsyncCfgPlan | null` in `async-cps.ts` that
   subsumes `lowerLinearStatements` but builds states directly (keep
   `planLinearAwaits` delegating to it or converting via `linearPlanToCfg` —
   whichever keeps the linear byte-hash identical; PROVE with the probe).
   Placeholder-patch forward targets (exit-state id unknown until the loop body
   is lowered): build with `target: -1` + a patch list, resolve before
   `validateAsyncCfg`.
2. **Eligibility gates**: `asyncFnNeedsDrive`/`asyncFnNeedsHostDrive` +
   `computeAsyncSpills` all call `planLinearAwaits` today — route them through
   the new planner ONCE, not three divergent copies. Gate loop acceptance to
   the **native drive lane first** (`opts.allowLoops` true only from
   `asyncFnNeedsDrive`) so the gc/host lanes stay byte-identical; widen the
   host lane in a follow-up with its own corpus check (the host lane suspends
   on EVERY await — N iterations = N microtask rounds; correct but must be
   tested with real drains).
3. **Liveness across back-edges (the silent-miscompile trap).** The
   `liveAfterAwait` sets are TEXTUAL-remainder based. For an await inside a
   loop, a local read textually BEFORE the await is read again on the next
   iteration AFTER the resume — so the live set for any await inside a loop
   must be widened to include **every own-local referenced anywhere in the
   loop statement** (∪ the textual remainder). Same rule for the spill set.
4. **Resume bindings in a loop are self-live**: `bindingLiveAcrossLaterAwait`
   must treat the binding's OWN await as "later" through the back-edge (spill
   it; it round-trips the frame each iteration). Simplest correct rule: inside
   a loop, every resume binding is spilled (still subject to the
   spill-safe-type gate).
5. **Reject and fall back (legacy/AG0) on**: `break`/`continue` targeting the
   loop (until 3a′ adds them as `goto exit` / `goto head` — they are trivially
   expressible, but each needs a test), `try` interacting with the loop,
   awaits in the loop CONDITION (needs a condition-eval state — expressible,
   separate follow-up), labeled statements.
6. **Tests**: pending-then-fulfilled across ≥2 iterations via
   `__drain_microtasks`; a binding carried across the back-edge; zero-iteration
   loop (cond false first — straight to exit, no resume ever fires); rejection
   inside iteration k>1 routes to the result promise. Plus the byte-hash probe
   for non-loop programs (must stay identical).

### 3b — for-await-of (async-iterator drive on 3a machinery) — LANDED (see "Slice 3b" above)

> **UPDATE (2026-07-04):** grounding for 3b found this design's `it.next()`→
> `$Promise` step needs the native async-iterator **carrier**, which
> standalone/wasi does not yet have — so 3b is NOT a planner-only slice. See
> **"Slice 3b — … BANKED"** at the end of this file for the measured evidence,
> the two sub-blockers (implicit-await coupling + async-iterator carrier), and
> the concrete carrier contract. The drive machine (3a) is confirmed ready.

`for await (const x of expr) body` lowers to (all on existing terminators):

```
init:  it = GetAsyncIterator(expr)        — [Symbol.asyncIterator] ?? wrap the
       sync iterator (each sync next() result is PromiseResolve'd); spill `it`.
head:  r = it.next()                       — suspend(r, resume → chk)
chk:   resumeFrom binds step (IteratorResult); condGoto(step.done, exit, bodyStart)
body…: bind x = step.value; body states; last terminator goto(head)
exit:  continue the outer chain
```

`step.done`/`step.value` reads go through the existing IteratorResult shape
(`{value,done}` — `RESULT_VALUE_FIELD`/`RESULT_DONE_FIELD` for native frames,
dynamic reads for host results). First slice: no `break`/`continue`/`throw`
inside the body (abrupt loop exit must call `it.return()` — an async close,
itself a suspend — bank as 3b′), no destructuring binding. Converges with the
#2865/#2867 Gap-5 corpus (the −32 for-await/async-gen cluster in #2980).

### 3c — try/catch + return-through-finally + nested regions (completion replay)

The full ES completion semantics on the frame's EXISTING `MODE`/`ABRUPT`/
`ERROR` fields (frame-core reserved them from the start):

1. **Restructure the dispatcher** from `try { block { loop { chain } } } catch`
   to `block { loop { try { chain } catch $exn { route } } }` so an abrupt
   completion becomes a STATE TRANSITION: the catch routes by the region-id
   local — region has a `catchState` → `ERROR=reason; MODE=THROW;
STATE=catchState; br <loop>` (the catch body is ordinary states and MAY
   await); no region → settle-reject + return (today's behaviour). NOTE: this
   moves every arm's `br`-to-loop depth by +1 (the try block wraps the chain)
   — change `loopDepth` in ONE place (`buildStateBody`) and re-prove the
   byte-hash on a `main` control before/after is _expectedly different_ here,
   so instead prove semantics via the full async test files + new tests.
2. **Handler regions generalize**: `{ id, parent, catchState?, finallyState?,
finalizer? }`. A finally that must support replay becomes states
   (`finallyState` entry); its terminator is a new `replay` terminator: read
   MODE — NEXT → goto(normal successor); THROW → set region local to `parent`,
   re-throw ERROR (routes to the next outer region); RETURN → settle the
   result promise with ABRUPT (or route through the next enclosing finally).
   `return` inside a try records `MODE=RETURN; ABRUPT=value; goto(finallyState)`
   instead of settling directly (the `asyncDriveReturn` hook grows a
   per-region indirection).
3. **Nested regions**: `validateAsyncCfg` currently rejects `parent !== 0` —
   lift that ONLY when the catch routing walks the parent chain. Sibling
   regions (two sequential try/finallys, both parent 0) already route
   correctly with the id-equality guards and may ship before full nesting.

### 3d — async generators (AG2 `$Frame`/`$AsyncFrame` convergence)

Sketch (own design pass before execution): an async-gen frame is an
`$AsyncFrame` + a result-promise QUEUE. `yield` is a new `settleYield`
terminator: fulfil the CURRENT `next()`-promise with `{value, done:false}` and
`return`; `next(v)` allocates a fresh pending result promise, stores SENT=v,
kicks resume. `await` inside the gen uses the existing suspend terminator
against the awaited promise (resume writes SENT, NOT the result queue). The
generator trampoline's yield-dispatch and this machine's await-dispatch share
STATE — they compose because both are `br_table`-over-STATE with disjoint
suspend kinds. Reuse `generators-native.ts` result-struct helpers; do NOT fork
the frame ABI (both layouts already share frame-core).

### Integration points (for the owning issues)

- **#2957 phases 2-3 (async arrows/methods/fn-exprs)**: the drive branches in
  `function-body.ts` (~L1163 and ~L1186) gate on `ts.isFunctionDeclaration` —
  activation for other function kinds is a call-site/naming problem
  (`asyncFnName` already synthesizes `anon_<pos>` names), NOT a machine
  problem; the machine is shape-agnostic.
- **#2967 (engine convergence)**: `asyncFnNeedsCps`'s single-tail-await JS-host
  CPS lane can retire onto `asyncFnNeedsHostDrive` once the host lane accepts
  every CPS shape — measure with the #1042 census, then delete
  `emitAsyncStateMachine` (one machine, two settle backends).
- **#2980 slice-1d (carrier widen)**: stays LAST, after 3a/3b land, gated on
  the full merge_group standalone corpus measuring net-positive. This slice
  changed nothing it depends on.

## Slice 3a landed — while-with-await (2026-07-04, opus-2957p2)

**Done** (native host-free drive lane). `while (cond) { …≥1 canonical await… }`
async bodies now drive on the multi-state CFG machine. Measure-first on the
branch base: a while-await wasi fn was host-free-compilable but never completed
(the loop CFG was producer-unreachable). After 3a the canonical loop resolves
across genuine suspensions with the accumulator surviving each spill/restore.

**How** (planner + spill only — the emitter already had goto/condGoto):

- `async-cps.ts` — `planAsyncCfg(fn, plan, {allowLoops})` is now the single CFG
  producer for the drive lane. Linear bodies **delegate** to the byte-identical
  `linearPlanToCfg(planLinearAwaits(...))` path (proven: the 69-test async drive
  blast radius stays green); when `allowLoops` (native lane only) and the body is
  a canonical single-`while`-with-await, `planWhileLoopCfg` builds the loop CFG:
  entry (pre-leads) → head `condGoto(cond, body0, exit)` → body suspend states →
  continuation `goto(head)` back-edge → exit `settleUndefined`. Reuses
  `lowerLinearStatements` for the loop body. `loopAsyncSpillInfo` exposes the
  widened spill set.
- `async-frame.ts` — routed the emitter + `asyncFnNeedsDrive` + `computeAsyncSpills`
  through `planAsyncCfg`/`computeLoopSpills`. **Loop-liveness (the silent-miscompile
  trap, contract rule 3/4):** every own-local referenced anywhere in the loop is
  spilled (a local read before the await is read again after resume next
  iteration); the drive gate falls back to legacy if any such local is not a
  spill-safe type. Host settle backend keeps the linear-only shape (loops =
  N-round follow-up).
- **Emitter fix (latent, uncovered by 3a):** the never-exercised `goto`/`condGoto`
  `br` depths were off by one. The re-dispatch `loop` is at `loopDepth` (id+2)
  from ONE level inside an `if` arm (where the proven suspend fast-path advance br
  sits) → `loopDepth-1` from a state-body top level. `goto` (top level) now uses
  `loopDepth-1`; `condGoto` (br inside its `if(cond)` arm) uses `loopDepth`.

**Scope / bank.** Bounded to a single `while` whose body is linear-canonical with
no `break`/`continue`/`return`/labeled/nested-loop/`switch`/`try` and an
await-free condition; anything richer falls back to legacy. Follow-ups (per the
banked design): do-while, await-in-condition, break/continue as `goto exit`/
`goto head` (3a′), for-await-of (3b), try/catch + return-through-finally (3c),
host-lane loops. Issue stays `in-progress`.

**Tests** `tests/issue-2906-3a-while-await.test.ts` (6): sync-settled full run,
genuinely-pending across 3 iterations (accumulator survives spill), zero-iteration,
prefix-local carried across the back-edge, bare-`await` side effects in order,
and break→legacy-fallback. Blast radius green (async-await / issue-1042 /
issue-1042-host-drive / issue-2895 / async-census + issue-2174/2611/1672); the
2× issue-2865 and 3× issue-2906-gap3 failures are pre-existing on clean
`origin/main`. `tsc --noEmit` clean.

## Slice 3b — for-await-of: drive machine READY, blocked below it on the async-iterator carrier (BANKED, 2026-07-04, opus-2906-3b)

**Verdict: the drive-machine layer for for-await is already done (3a); what
remains is NOT a planner-only slice on the ready emitter — it is the
async-iterator carrier + an analysis-substrate change, the "more than the drive
machine" case flagged at dispatch.** Measured on current main (post-3a); the
attempted synthetic-AST desugar was reverted — a fragile half-machine here is
exactly the #2367 graveyard this issue warns against. No emitter/planner code
lands; this section banks the follow-up with a concrete contract.

### What was measured (host-free wasi, current main)

1. **The drive machine already handles the for-await loop-drive shape.** The
   spec-equivalent index lowering of `for await (const x of arr)`, written as
   real source —

   ```ts
   const __src = arr;
   let __i = 0;
   while (__i < __src.length) {
     const x = await __src[__i];
     __i = __i + 1; /*body*/
   }
   ```

   — compiles host-free (imports `[]`, valid Wasm) and runs correctly on the 3a
   while-with-await machine (`[P.resolve(1),P.resolve(2),P.resolve(3)]` → sum 6,
   both the fast-path advance and the `__drain_microtasks` resume). So the CFG
   emitter needs NO change for for-await; the back-edge + loop-liveness 3a
   shipped are sufficient.

2. **The user-facing gap is real and severe.** `for await (const x of
[Promise.resolve(1), …]) { sum += x }` compiles host-free today but yields
   **NaN** — for-await produces **no `ts.AwaitExpression`** (the per-element
   suspension is implicit in `awaitModifier`), so `analyzeAsyncBody` reports
   **zero await points**, every gate (`asyncFnNeedsDrive` / `asyncFnNeedsCps` /
   spill computation) treats the function as non-suspending, and it falls to the
   AG0 synchronous unwrap that never awaits the element. This is the concrete
   bug 3b must fix.

### The two sub-blockers, both BELOW the drive machine

- **(A) Implicit-await coupling (analysis substrate).** Driving a for-await
  requires the implicit element suspension to become a real suspend point the
  pipeline can see. Today `analyzeAsyncBody` collects only explicit
  `ts.AwaitExpression` nodes (`collectAwaitPoints`, async-cps.ts:441), so the
  whole `awaitPoints`-keyed machinery (`liveAfterAwait`,
  `bindingLiveAcrossLaterAwait`, `computeAsyncSpills`) never engages. This is a
  change to the async-body **analyzer**, not the drive machine.

- **(B) The native async-iterator carrier (standalone runtime).** The general
  for-await — a source with a real `[Symbol.asyncIterator]`, async generators,
  non-array sync iterables via the native protocol (the dominant real + test262
  shape) — needs `GetAsyncIterator` + `AsyncFromSyncIterator` +
  `next()` → **native `$Promise<IteratorResult>`**. Standalone/wasi has NONE of
  this: `ensureAsyncIterator` (destructuring.ts:397) returns the **SYNC**
  `__iterator`, and `next()` on it is synchronous `(i32 done, externref value)`,
  never a `$Promise`. So `it.next()` cannot be a `suspend` terminator's awaited
  operand — the banked 3b design's `it.next()`→`$Promise` step does not exist to
  drive.

### Why the carrier-free array subset did NOT land

The one carrier-free realization is the index lowering above, produced by
**synthesizing** the `const __src = SRC; while (__i < __src.length) { const x =
await __src[__i]; … }` AST from the for-await and threading a synthetic function
declaration through the 3a pipeline. Built and empirically tested
(`desugarForAwaitToWhile` + async-activation wiring); **reverted** because:

- Synthetic nodes have no `parent` pointers → first crash in
  `compileVariableStatement` (`decl.parent.flags`, variables.ts:948). Fixable
  with `ts.setParentRecursive`.
- **But then it silently produces the WRONG value (loop body never runs, sum
  = 0) for every source shape** — plain-number arrays, array literals, and
  promise arrays alike. The synthetic `__src.length` / `__src[__i]` **mis-resolve
  because the checker cannot type a synthetic identifier**: `getTypeAtLocation`
  on `__src`/`__i` returns the error/`any` type, so `.length` and the numeric
  index take the wrong (string-key / non-array) compile path and the condition
  `__i < __src.length` is immediately false. The js2wasm codegen is
  checker-heavy on property/element/index access; making synthetic AST correct
  there would mean auditing every `checker.getTypeAtLocation` in the hot
  property/element-access paths (high blast radius on the gc/host lanes) or a
  full re-bind/re-check pass — both larger than 3b and byte-risky.

Using the REAL identifier source (`arr.length`, `arr[__i]`) removes the `.length`
mis-resolution but leaves the synthetic numeric index `__i` failing
`isNumericIndexExpression`'s checker query → the string-key element path → still
wrong. Each narrowing touches more hot code for a subset (for-await over a plain
array of promises) that is NOT how real for-await / test262 for-await is written.

### Banked follow-up contract (do these two, then 3b is planner-only)

1. **`#26xx` async-iterator carrier (standalone).** Native `GetAsyncIterator(v)`:
   call `v[@@asyncIterator]()` if present; else `CreateAsyncFromSyncIterator`
   over `v[@@iterator]()` where the wrapper's `next(x)` does
   `{value,done}=syncNext(x); return PromiseResolve(value).then(v=>({value:v,done}))`.
   `next()` MUST return a native `$Promise<IteratorResult>` (the `$Promise` +
   scheduler carrier from #2867/#2905 is already on main). Reuse the
   `generators-native.ts` IteratorResult struct
   (`RESULT_VALUE_FIELD`/`RESULT_DONE_FIELD`); do NOT fork the frame ABI. This is
   the same carrier async generators (3d) need for their `next()` queue.

2. **`analyzeAsyncBody` implicit-await recognition.** Teach the analyzer that an
   `awaitModifier` for-of is a suspend point, OR add a dedicated
   `planForAwaitCfg(fn, plan)` producer (parallel to `planWhileLoopCfg`) that
   does not key off `plan.awaitPoints`. With the carrier present, the CFG is
   exactly the banked design's `init/head/chk/body/exit` on existing
   suspend/goto/condGoto terminators — `head: r = it.next()` becomes a `suspend`
   awaiting the native `$Promise`, `chk: condGoto(step.done, exit, body0)` — no
   emitter change (proven by measurement #1 above). `it.next()`/`step.done`/
   `step.value` are emitted as **frame helpers / native reads**, not synthetic
   TS AST, sidestepping the checker wall entirely (the carrier owns the Wasm).

Until (1)+(2) land, for-await stays on AG0 (wrong for genuinely-pending
sources). The 3a drive machine is confirmed ready to carry it.

## Slice 3d — async generators: NOT planner-only; blocked below the machine on a host-free async-gen PRODUCER carrier + an async-iterator for-await CONSUMER (BANKED, 2026-07-04, opus-2906-3d)

**Verdict: 3d is an XL substrate slice, not the "planner-only `settleYield`
terminator + result-promise queue" the 3b landing note optimistically banked.**
Re-grounding against current main (post-#2656 for-await carrier, post-#2646
phase-2 activation) with a direct measurement shows host-free async generators
**do not compile at all today** — so there is nothing for a `settleYield`
terminator to plug into yet. The producer machinery it presupposes (an async-gen
object with a re-entrant `next()` returning `Promise<IteratorResult>`) does not
exist host-free, and neither does the consumer path (`for await` over a real
async iterator whose `next()` returns a promise). Building either is below the
CFG drive machine, exactly the "more than the drive machine" case 3b hit. No
emitter/planner code lands this slice; this section banks the real work with a
measured contract and a de-risked slice plan, mirroring the 3b banking.

### What was measured (current main `ca6d1729c`, `.tmp/probe-asyncgen.mts`)

`async function* g(){ yield await Promise.resolve(1); yield 2 }` consumed by
`for await (const x of g())`, compiled three ways:

| target           | result                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **wasi**         | **compile FAILS** — `function-body.ts:1016` gate: _"native generator lowering currently supports only sequential numeric yields in standalone/WASI targets (#680)."_                                       |
| **standalone**   | **compile FAILS** — same #680 gate.                                                                                                                                                                        |
| **gc (JS host)** | compiles, but imports `__create_async_generator`, `__gen_create_buffer`, `__gen_push_f64`, `__gen_push_ref`, `__async_iterator`, `__iterator_next`, `Promise_resolve`, … — **host-backed, not host-free.** |

Even a _plain-numeric_ `async function*(){ yield 1; yield 2 }` fails in wasi: an
`async function*` routes through the generator-buffer path
(`function-body.ts` `isGenerator` branch, ~L1012), whose standalone arm is the
#680 numeric-only native-generator lowering + the `__create_async_generator`
host wrap. The async-drive machine (`async-frame.ts`) is **never reached** for an
async generator — `maybeActivateAsync` only fires on the non-generator body path,
and `ctx.asyncFunctions` deliberately **excludes** async generators (see the
comment at `function-body.ts:1087`).

### Why "planner-only `settleYield` + queue" is wrong (three missing substrates)

1. **No host-free async-gen PRODUCER object.** The drive machine
   (`emitAsyncFrameStateMachine`) drives an async _function_ to completion,
   settling **one** `result_promise`, and returns that promise. An async
   _generator_ is **called → returns an async-iterator object** (not a promise,
   not driven to completion), whose `next(v)` allocates a **fresh** pending
   promise, drives the frame to the next `yield`, and settles _that_ promise with
   `{value, done:false}`. There is no such object host-free: even **sync**
   generator objects are built by the **host** import `__create_generator`
   (host-free sync generators only work when for-of drives the resume _inline_ via
   `emitNativeGeneratorToVec` — there is no escaping object). So a host-free
   async-gen object is strictly harder than a host-free sync-gen object, which
   itself does not exist. `settleYield` needs _a promise to settle that a
   re-entrant `next()` created_ — that `next()` is the missing piece.

2. **No async-iterator for-await CONSUMER.** The 3b carrier drives a **sync**
   `__iterator` over a **boxed array** and `await`s each _element_
   (`Await(value)`); `it.next()` is synchronous `(done, value)`. Consuming an
   async generator is a **different** protocol: `p = it.next()` returns a
   **Promise**, you `await p` (suspend on the _next()-promise_), then read
   `done`/`value` from the resolved `IteratorResult`. `forAwaitNeedsDrive` gates
   on `oracle.elementFactOf(source)` being a boxed **array** element — `g()`
   (a call returning an AsyncGenerator) is not an array, so for-await over an
   async gen falls to legacy/AG0. A new for-await CFG variant (await the next()
   promise, read IteratorResult fields via emit hooks) is required — a sibling of
   `planForAwaitCfg`, not a tweak to it.

3. **The #680 routing gate.** `async function*` must be _intercepted before_ the
   generator-buffer branch and routed to a new host-free async-gen emitter
   (`function-body.ts` `isGenerator` arm, gated like 3b's
   `isStandalonePromiseActive`), or it errors out before any of the above runs.

### Banked contract — the real slices (each inert, carrier-gated, independently mergeable)

Reuse, do NOT fork: `AsyncFrameInfo`/`buildAsyncFrameInfo` (the frame ABL,
frame-core spill/state helpers), the native `$Promise` + microtask scheduler
(`async-scheduler.ts`), and the native `IteratorResult` structs
(`generators-native.ts` `RESULT_VALUE_FIELD`/`RESULT_DONE_FIELD`,
`isGeneratorResultStruct`). The frame's existing `result_promise` field becomes
the **current-next()-promise** slot (mutable — `next()` overwrites it per call).

- **3d-i — host-free async-gen PRODUCER (the core).**
  - **New CFG terminator** `settleYield { value: AsyncCfgOperand; resumeState; handler }`
    added to `AsyncCfgTerminator` (async-cps.ts) + `validateAsyncCfg`
    (async-frame.ts). Emitter: build `IteratorResult{value, done:0}`, `fulfill`
    the frame's current `result_promise` with it, `STATE = resumeState`, spill,
    `return`. (Do NOT ship it dead — land it _with_ its producer + a test that
    exercises it, per the #2367 graveyard rule; slice-3 only shipped goto/condGoto
    unreachable because 3a exercised them in the same effort.)
  - **New planner** `planAsyncGenCfg(fn, plan)`: number a mixed `yield`/`await`
    body into states — each `await e` → `suspend` (resume writes SENT), each
    `yield e` → `settleYield` (resume-on-next), body completion →
    `settleDone` (a `settleUndefined` sibling that settles `{value:ret,
done:1}`). Bounded first shape: linear body, identifier bindings, the same
    spill-safe-type gate as slice 1/3a.
  - **New call-site** `emitAsyncGenerator`: build the frame parked at STATE=0
    **without** kicking resume; return a native async-gen **carrier** (the frame
    externref itself is sufficient — no prototype methods needed if the consumer
    drives via a runtime helper, exactly as 3b drives the sync `__iterator`).
  - **Per-gen `next` helper** `__async_gen_next_f<name>(frame) -> $Promise`
    (per-generator, like the step adapters — the `$Promise`/frame types are
    per-gen so a single generic helper cannot type them): alloc fresh pending
    `$Promise`, store into `result_promise`, store SENT, call resume, return the
    promise. `return()`/`throw()` variants bank as 3d-iii.
  - **Route** `async function*` (host-free lane only) to `emitAsyncGenerator`
    before the #680 branch, gated like `isStandalonePromiseActive`.
  - **Proof (non-vacuity, host-free):** a direct-drive wasi test — call the gen,
    call the per-gen next helper, `__drain_microtasks`, read
    `IteratorResult.value`/`.done` — shows `yield await P.resolve(1); yield 2`
    delivers `1` then `2` then `done`, `imports [] `. This proves suspend+settle
    without needing the consumer slice. Inject-throw probes on the
    suspend/settle arms (a rejected awaited promise inside the gen must reject the
    _current_ next()-promise).
- **3d-ii — async-iterator for-await CONSUMER.** `planForAwaitAsyncCfg` sibling of
  `planForAwaitCfg`: `it = source` (the async gen IS its own async iterator);
  head emits `p = <per-gen next>(it)`; `suspend(await p)`; resume reads
  `res.done`/`res.value` from the awaited `IteratorResult` via emit hooks;
  back-edge `goto(head)`. Gate for-await on an async-iterator source
  (`oracle` async-iterable fact). This is what makes the _task's_ headline proof —
  `for await (const x of g())` → `[1,2]`, imports `[]` — pass end-to-end.
- **3d-iii — edges (bank):** `return()`/`throw()` on the async gen; `yield*`
  (async delegation); yielded-thenable adoption (`yield await` vs `yield P` —
  §27.6 AsyncGeneratorYield awaits the operand); multi-`next()` **result-promise
  QUEUE** (concurrent `next()` before the prior settles — a single
  current-promise slot suffices for serial for-await drive, which is the
  non-vacuity proof); try/finally across yield.

### Answers to the dispatch questions

- **Does async-gen drive host-free today?** **No.** It does not even compile in
  wasi/standalone (#680 gate); the gc path is host-backed
  (`__create_async_generator` + gen-buffer imports). The async-drive machine is
  never reached for an async generator.
- **Is #2865 (standalone async-gen) unblocked?** **No.** #2865 remains blocked on
  **3d-i** (the host-free async-gen producer carrier). 3d is a real substrate
  build, not a planner-only follow-up — it needs the producer object/`next()`
  carrier and (for the for-await headline) the async-iterator consumer, both
  below the CFG machine. Recommend scheduling **3d-i** first (self-provable via
  direct drive, de-risks the rest), then **3d-ii** for the for-await proof.

## Slice 3d-i — async-generator PRODUCER core (LANDED, host-free wasi lane, 2026-07-05, opus-2906-3di)

**What shipped.** `async function* g(){ yield await Promise.resolve(1); yield 2 }`
now drives **host-free** on the #2906 CFG resume machine. Direct-drive proof
(next-helper → `__drain_microtasks` → read IteratorResult): the sequence
`{1,false}`, `{2,false}`, `{undefined,true}` with **imports `[]`**, and a
genuinely-pending awaited yield **suspends at kick (state=PENDING) and resumes
on the drain**. Previously this hit the #680 native-generator gate
(function-body.ts) and never reached the async machine.

**How (all on the existing emitter substrate — two new terminators, no ABI churn):**

- **`async-cps.ts`** — `planAsyncGenCfg(fn)` + `isBoundedAsyncGenBody(fn)`. Two
  new `AsyncCfgTerminator` kinds: **`settleYield`** (`{value|fromSent,
resumeState}`) fulfils the current `next()`-promise `{value, done:false}` and
  suspends (NO reaction registered — the next `next()` kick is the sole
  resumption driver); **`settleDone`** fulfils `{undefined, done:true}` at body
  end. `yield await P` lowers to `suspend(P) → settleYield(fromSent)`; the await
  is the STOCK suspend terminator (genuine microtask suspension), the yield reads
  the delivered `SENT_FIELD`. A rejected awaited yield re-throws via the resume
  prelude's `MODE_THROW` arm → the outer catch settles the `next()`-promise
  **rejected** (verified: state=REJECTED, not vacuously fulfilled).
- **`async-frame.ts`** — `emitAsyncGenerator` builds the `$AsyncFrame` carrier and
  returns it as a bare externref **WITHOUT kicking** (async gens are lazy — the
  body starts on the first `next()`). The re-entrant driver
  `__async_gen_next_<name>(frame) -> Promise<IteratorResult>` mints a FRESH
  pending result promise per call, stores it into `frame.result_promise` (the
  resume fn re-reads that field at entry, so each `next()`'s promise is the one
  settled at the next yield — the single current-promise slot the 3d contract's
  "serial for-await drive" non-vacuity note calls sufficient), kicks resume,
  returns the promise. The IteratorResult reuses `generators-native.ts`
  `ensureNativeGeneratorResultType` (`{value,done}` — no frame-ABI fork).
  `AsyncFrameInfo.asyncGen` switches `ensureAsyncResumeFunction` to
  `planAsyncGenCfg` and the `settleYield`/`settleDone` emit arms; every other
  async fn is byte-untouched.
- **`function-body.ts`** — intercepts a bounded async gen in the `isGenerator`
  branch BEFORE the #680 gate, gated on `isAsyncGenDriveCandidate`.

**Why one gate, matching the plain drive (the standalone trap avoided).** The
candidate gate is `isStandalonePromiseActive` (currently **wasi-only**), NOT
`isAsyncDriveActive` (standalone+wasi). The plain/for-await drive lanes activate
under the same carrier gate (`decideAsyncActivation`): in non-wasi standalone the
awaited operand does **not** lower to a native `$Promise`, so driving there would
build a broken machine. The widen to `standalone` is the shared slice-1d carrier
move — this slice does not touch it.

**Bounded slice (everything else → legacy gen path / #680, never a wrong
machine).** A FLAT body of `yield <E>` statements where `E` is plain / `await

<P>` / absent; NO own-local declarations (a local crossing a yield needs the
frame-spill widening the linear/loop drives already have — params ARE fine,
captured in frame fields); no `yield*`, no yields nested in expressions/control
flow. `next(v)`/`.throw()`/`.return()` sent-value handling + prototype-method
dispatch + the concurrent-`next()` result-promise QUEUE are **3d-ii** (the
for-await consumer). Own-locals/spills is the immediate 3d-i′ follow-up (reuse
`computeAsyncSpills`).

**Byte-inertness proof (the −16/−29 discipline).** sha256 of 5 representative
programs (plainAsync / multiAwait / forAwait / syncGen / plain) × {gc, standalone,
wasi} — **all 15 byte-identical to origin/main**. The async-gen program itself:
**gc byte-identical** (`cb154a25…`, legacy `__create_async_generator`),
**standalone byte-identical** (still the #680 CE — carrier-gated out), and only
**wasi** changes (`a275a967…`, imports=0 — the intended unlock).

**Verification.** `tests/issue-2906-3di-asyncgen-producer.test.ts` (7 host-free
wasi tests: the 1,2,done proof; genuine pending-then-resume; plain-yield
sequence; laziness; the rejected-await→reject inject-throw proof; param capture;
gc/standalone inertness). Full async+generator blast radius (async-await /
async-census / generators / issue-1042[-host-drive] / 2895[-drain-hook] /
2906-3a/3b/multiawait/gap3 / 2864 / 2865 / 820 / 1672 / 2611 / 2635 / 3032 /
symbol-async-iterator / 2174 / promise-combinators): the ONLY failures (3×
gap3-tryfinally throw-path, 2× promise-combinators host, 2× issue-2865 AG0 wasi,
1× generator-yield-contexts fn-expr, 2× symbol-async-iterator for-await) are
**pre-existing on origin/main** — verified identical failure set in a base
worktree. `tsc --noEmit` clean.

**Answers the 3d dispatch questions.** _Does async-gen drive host-free now?_
**Yes** — for the bounded producer shape, in wasi, imports `[]`, with genuine
suspension. _Is 3d-ii / #2865 unblocked?_ **Yes** — the frame carrier +
`__async_gen_next_<name>` driver + settleYield/settleDone suspend-resume
substrate are exactly what the `for await (x of g())` consumer (3d-ii) drives:
that headline is now a consumer-side wiring slice (dispatch
`g()[Symbol.asyncIterator]().next()` onto this producer) rather than a
producer-machine problem; #2865 shares the carrier widen (slice-1d). Issue stays
`in-progress` for 3d-ii + the own-local/`yield*`/nested-yield widenings.

## Slice 3d-ii — async-generator for-await CONSUMER (LANDED, host-free wasi lane, 2026-07-05, opus-2906-3dii)

**What shipped.** `for await (const x of g())` where `g` is a host-free async
generator (3d-i) now drives **host-free** on the shared CFG resume machine.
Headline proof: `async function* g(){ yield 1; yield 2 }` consumed by
`for await (const x of g()) sum += x` → **3, imports `[]`** (was AG0/NaN — for-await
over an async-gen call previously fell to legacy because the source is not a boxed
array). A genuinely-pending awaited yield **suspends the consumer** (`kick()` → 0)
and **`__drain_microtasks` resumes it** across the producer↔consumer boundary
(→ 23) — the non-vacuity proof.

**How (planner-only — no new emitter/terminator; reuses the 3b emit-hook carrier).**
The async gen IS its own async iterator, so `GetAsyncIterator(g()) === g()` — the
frame carrier the 3d-i producer returns. The DUAL of the 3b sync-iterator carrier:
3b does a synchronous `it.next() → (done,value)` and `await`s the ELEMENT; an async
gen's `next()` returns a **`$Promise<IteratorResult>`**, so the consumer `await`s
the **next()-PROMISE first**, then reads done/value from the resolved
IteratorResult (§27.6.3.4). Lowering (`async-cps.ts planForAwaitAsyncCfg`):

```
entry: it = g()                          (the 3d-i frame carrier; spilled via FORAWAIT_ITER_SPILL)
head:  p = __async_gen_next_<g>(it)       (mint fresh next()-promise + kick; returns $Promise)
       suspend(await p, resume → chk)      (the next()-promise suspension — STOCK suspend)
chk:   {done,value} = SENT IteratorResult ; x = value   (unpack via emit hook + RESULT_*_FIELD)
       condGoto(done, exit, body)          (the done test AFTER the await — the 3b/3dii difference)
body:  <body>; goto head                   (back-edge)
exit:  <post>; settleUndefined
```

`p = next()`, the IteratorResult field reads and the `x` bind are RUNTIME wasm-local
ops (not checker-typed AST — the #2367 wall), so they ride the same
`AsyncCfgStepEmit`/`AsyncCfgValueEmit` hooks 3b introduced. The next()-promise is a
native `$Promise`, so the stock `suspend` arm assimilates it verbatim: a plain
`yield E` fulfils the promise inside `next()` → the consumer's synchronous
**fast-path advance** runs the whole loop within one kick; a genuinely-pending
`yield await P` leaves it pending → the consumer suspends, and the drain drives a
**two-level microtask chain** (P resolves → gen step adapter → settleYield fulfils
the next()-promise → consumer step adapter → consumer resumes at `chk`).

**Why the gate is order-robust (the #2367 graveyard rule).** `forAwaitAsyncNeedsDrive`
drives ONLY when `__async_gen_next_<stem>` is **already in `funcMap`**. Function
bodies compile in **source order** (declarations.ts), so the producer's
`emitAsyncGenerator` has registered that helper iff `g` was declared BEFORE the
consumer — the natural (and only lazily-correct) order. A forward-referenced gen or
a non-async-gen callee leaves the helper absent → the consumer stays on legacy/AG0
(correct-or-legacy). The name is `sanitizeTypeName(callee-identifier)`, matching the
producer's `sanitizeTypeName(asyncFnName(decl))` exactly for a named-function-decl
gen. `planAsyncCfg` gained a `ctx` param and tries `planForAwaitAsyncCfg` **before**
the 3b array carrier; it self-gates to async-gen sources (returns `null` otherwise),
so an array for-await falls through **byte-identically**. The consumer's frame layout
is the SAME as a 3b for-await (own-locals + iterator spill), so `computeForAwaitSpills`

- the spill-safe gate are reused unchanged.

**Byte-inertness proof (the −16/−29 discipline).** sha256 of 6 programs (plainSync /
plainAsync / arrayForAwait / numArrayForAwait / whileAwait / asyncGenConsumer) ×
{gc, standalone, wasi}, origin base (upstream/main `7493947b2`) vs branch: **every
non-async-gen program byte-identical in ALL THREE lanes** (the `planAsyncCfg`
ctx-threading + the planner reorder are fully inert for existing shapes). The
async-gen-consumer program: **gc + standalone byte-identical** (`cc2515a4…` — the
producer helper is wasi-only via `isStandalonePromiseActive`, so the consumer gate
is false off-lane and it stays on legacy), and only **wasi** changes
(`847526e2…` → `84b85a17…` — the intended unlock).

**Verification.** `tests/issue-2906-3dii-asyncgen-consumer.test.ts` (6 host-free
wasi): the headline sum-to-3; the genuine-suspension drain proof (0 → 23); mixed
plain/awaited yields; pre/post ordering; iteration count (settleDone terminates,
no over-run); and `number[]` legacy parity. Async blast radius (async-await /
async-census / issue-1042[-host-drive] / 2895[-drain-hook] / 2906-3a/3b/multiawait /
2865 / 1672 / 2611 / 820 / symbol-async-iterator / 2174 / promise-combinators): the
ONLY failures (3× gap3-tryfinally throw-path, 2× promise-combinators, 2× issue-2865,
2× symbol-async-iterator) are the **pre-existing** set documented in the 3d-i note —
each is a non-async-gen program compiled **byte-identically to base** (proven by the
hash probe), so it cannot be a 3d-ii regression. `tsc --noEmit` clean.

**Answers the dispatch questions.** _Does `for await (x of asyncGen())` work
host-free now?_ **Yes** — bounded shape, wasi, imports `[]`, with genuine
suspend/resume across the consumer↔producer boundary. _What's left for 3d-iii?_
`next(v)` argument delivery into the pending yield's SENT_FIELD; `.throw()`/`.return()`
close-forwarding; the concurrent-`next()` result-promise QUEUE (a single
current-promise slot suffices for the serial for-await drive proven here);
async-gen prototype / `[Symbol.asyncIterator]` object dispatch; own-local spills in
the gen body / `yield*` / nested-yield (shared with 3d-i′); forward-referenced or
const/arrow-held async gens (the gate is bounded to direct named-function calls);
`break`/`continue`/`try` in the consumer loop body (abrupt close via `it.return()`).
Issue stays `in-progress` for 3d-iii + the slice-1d carrier widen.

## Slice 3d-iii(a) — implicit yield-await §27.6.3.8 for PromiseLike operands (LANDED → #3207)

**What shipped (host-free wasi lane).** §27.6.3.8 `AsyncGeneratorYield` awaits ANY
thenable, not only the `Promise` builtin. #3120 landed the static classifier for
`Promise`-typed / union-with-Promise plain `yield E`; #3207 extends
`yieldOperandIsPromiseTyped` (async-cps.ts) to also recognise a `PromiseLike<T>`-typed
operand (a structural thenable), routing it through the same
suspend+`settleYield(fromSent)` lane. Verified: `const t: PromiseLike<number> =
Promise.resolve(5); yield t` delivers `5` (was NaN — the un-awaited thenable object).
Correct-or-inert (a non-native thenable fails the suspend's `ref.test $Promise` and
falls through to the pre-fix raw-yield delivery). Byte-inertness A/B: exactly ONE hash
changed (`promiseLikeYield wasi`); all gc/standalone + every other wasi program
identical. Tests in `tests/issue-3207-asyncgen-yield-promiselike.test.ts`.

**Banked (higher-value, blocked BELOW this lane).** The dominant residual §27.6.3.8
gap is a **native-`$Promise` value-representation bug**, not a classifier issue: a
`$Promise` that flows through a user-function return (`yield mk()`) or a Promise-typed
local (`const pv = mk(); yield pv`) loses its native struct identity (the suspend's
`ref.test $Promise` fails → delivered raw → NaN), while `yield await mk()` → 5 works.
This is the native-`$Promise` identity-preservation family (cf. #3134), below the
async-frame lane — the yield-await classifier cannot reach it. `any`-typed runtime
thenables need a runtime thenable probe in the settle arm (the #3120 follow-up).
Issue stays `in-progress` for the remaining 3d-iii edges + the slice-1d carrier widen.

## Slice 3c-i — try/CATCH-around-await: catch regions as states + the routed dispatcher (LANDED, 2026-07-23, fable dev-laneB)

**Scope shipped (native drive lane — wasi + standalone-carrier; host lane
byte-identical):** `try { …await… } catch (e) { … }` now DRIVES. Verify-first:
the shape previously fell to the AG0 sync unwrap, which read the rejected
`$Promise`'s field 1 — the REASON — as the awaited VALUE (measured `cap=NaN`,
catch never entered, on every rejection probe); now all 12 wasi probes + 2
standalone probes match spec (catch entered with the reason bound: 42/45/50/
142/…; fulfil paths keep the try continuation).

### What landed (the 3c design's step 1 + the catchState half of step 2)

- **Routed dispatcher** — `block { loop { try { chain } catch $exn { route } } }`,
  exactly the design's restructure, but **conditional**: only a plan whose
  handlers carry a `catchState` gets it. Every pre-3c plan (linear, Gap-3
  try/finally, 3a/3b loops, async gens) keeps the old
  `try { block { loop { chain } } } catch` wrap **byte-identically** (proven:
  7-program × 3-lane sha256 matrix unchanged; only the newly-admitted shape
  differs, and only on wasi/standalone — gc is byte-identical even for it).
  The depth shift is the designed single site (`loopDepth = st.id + (routed ?
3 : 2)` in `buildStateBody`).
- **Route** = state transition: for the active region id (the existing
  `__async_in_try` local — the prelude re-throw arm already arms it), bind the
  reason to the catch param (local + spill field, so it survives catch-chain
  suspends), **consume the throw (MODE=NEXT** — without this the stale
  MODE_THROW would re-fire the next prelude's re-throw arm), STATE=catchState,
  `br` the loop. No active region → the pre-3c reject tail (region finalizer
  replay + settle-reject + the #3178 async-gen COMPLETED repoint), now shared
  by both dispatcher shapes. One mechanism covers all three abrupt sources:
  sync-REJECTED classify, pending reject step-adapter delivery (both →
  prelude re-throw), and a synchronous `throw` in an in-try lead.
- **`AsyncHandlerRegion.catchState`/`catchParamName`** (async-cps.ts) +
  `validateAsyncCfg`: catchState in range and NO resume prelude (route enters
  it like a goto).
- **Producer `planTryCatchCfg`** (+ `analyzeTryCatchAsync` / `lowerChunk`):
  bounded shape = flat body, ONE top-level try/catch (no finally, no awaited
  try/finally elsewhere — a nested region would claim the same handler id 1),
  pre/try/catch/post chunks each linear-canonical, awaits allowed in ALL
  chunks (including the catch — its chain suspends/resumes normally; its
  handler is 0, so a throw there rejects the result promise). Catch param:
  plain identifier or absent; a destructured param bails.
- **Spills `computeTryCatchSpills`**: the 3a widened rule (every own body
  local; resume bindings typed via `resumeBindingValType`) + the catch param
  (externref). Gate: `asyncFnNeedsDrive` accepts the shape when every spill is
  spill-safe; `planAsyncCfg` gains `allowTryCatch` (set `!info.host`, like
  `allowLoops`). NOTE: `collectVarDeclsByName` picks up the CATCH clause's own
  variableDeclaration (it IS a `ts.VariableDeclaration`) — the spill/shadow
  logic must exempt it (this initially self-rejected every bound catch).

### Measured

- 14/14 new tests (`tests/issue-2906-3c-trycatch.test.ts`): rejection→catch,
  fulfil-continues, pre-try await + catch-on-2nd, await-inside-catch,
  post-join on both paths, sync-throw-in-lead, throw-in-catch (rejects, no
  loop), unbound catch, widened spills, genuinely-PENDING reject/fulfil, and
  2 standalone-carrier duplicates.
- Async corpus: 243 passing across 31 files; 14 failures ALL pre-existing on
  unmodified main (issue-2906-gap3-tryfinally ×3, issue-2980 ×2 — a
  wasi-import leak on throw paths that predates this branch — plus 1672 ×5 /
  2865 ×2 / symbol-async-iterator ×2). Byte matrix above.

### Remaining (banked, unchanged from the design)

- **3c-ii — return-through-finally + finallyState**: the `replay` terminator,
  `MODE=RETURN; ABRUPT=value; goto(finallyState)` for `return` inside a try,
  `try/catch/finally` combined regions. The routed dispatcher + route are the
  substrate; this is planner + one new terminator.
- **3c-iii — nested regions**: lift `validateAsyncCfg`'s `parent !== 0`
  rejection once the route walks the parent chain; sibling regions (two
  sequential try/catches) need the producer to admit >1 region first.
- The D4 sync-generator convergence (#2864) waits on 3c-ii/iii per the
  alignment decision there.

## Slice 3c-ii-a — return-through-finally + sibling regions (LANDED, 2026-07-23, fable dev-laneB, stacked on 3c-i)

**Scope shipped (native drive lane):**

- **return-through-finally** — `return v` inside `try { …await… } finally { F }`
  was a `planLinearAwaits` reject (→ AG0; measured: the value never surfaced,
  the .then-consumer control also exposed that a `.catch/.then` CHAIN on a
  driven promise is a separate pre-existing gap — probe consumers must await).
  Landed WITHOUT the full finallyState machinery: the await-free finalizer
  (the Gap-3 invariant) is REPLAYED by the return hook — `asyncDriveReturn`
  gains `pendingFinalizer`/`handlerLocal`, armed per-lead by `buildStateBody`
  from the lead's region id; the hook evaluates the operand FIRST (§14.15.3),
  resets the region local (a throw in the finally must not re-enter the
  region), replays, then settles. `pendingFinalizer` clears during the replay
  so a `return` inside the finally settles directly (its completion
  overrides). Admission is native-gated end-to-end: `LowerState.
allowReturnInTry` → `planLinearAwaits(fn, plan, opts)` (default reject —
  every host-lane caller byte-identical) → set by `asyncFnNeedsDrive`,
  `planAsyncCfg` (`AsyncCfgOptions.allowReturnInTry = !info.host`) and
  `computeAsyncSpills` (from `buildAsyncFrameInfo`'s `hostImports ===
undefined`) so gate, producer, and spill computation see the SAME plan.
  `return await P` inside the try landed in the SAME slice (see below).
- **Sibling try/catch regions** — the 3c producer generalizes to ANY number of
  sequential top-level try/catches: `analyzeTryCatchAsync` walks
  `[chunk, try/catch]* chunk` groups, `planTryCatchCfg` rebuilt as a running
  state-counter builder (invariant: after each group's catch chain,
  `states.length === join`), one handler region per group (dense ids, own
  `catchState`; catch params DEDUPED across regions — never live
  simultaneously, they share one externref slot). The routed dispatcher's
  id-equality route needed NO change. A mid-sequence `return await` in a
  non-last try keeps the conservative bail.

**Measured:** 6 new tests (20/20 total in `tests/issue-2906-3c-trycatch.test.ts`):
return-through-finally with the finalizer observed BEFORE settle (1105),
conditional return (finalizer exactly once, 1077), normal (104) + throw (100)
paths unchanged, sibling both-reject (11) and fulfil+reject (142). Byte
matrix: all 8 control programs (incl. the 3c-i try/catch shape) byte-identical
to the 3c-i base across 3 lanes. Async corpus re-run: 89+36 passing, failures
identical to the pre-existing main set.

- **`return await P` inside try/finally** (same PR): the `settleSent`
  terminator replays the state's region finalizer BEFORE fulfilling — the
  delivered value sits stably in SENT (an await-free finalizer cannot
  overwrite it), region local reset first (throw-in-finally rejects without
  re-entering the region). `linearPlanToCfg` already drops the inline tail
  for `isReturnAwait` states, so the replay is the ONLY finalizer run — no
  double-execution. The L653 bail lifts under the same `allowReturnInTry`
  gate. 4 more tests (24/24 total): sync/pending fulfil (finalizer exactly
  once, before settle — 1042), rejection via the reject route (1), leads +
  return-await (1052). Byte matrix still identical on all 8 controls.

## Slice 3c-ii-b — COMBINED try/catch/finally regions (LANDED, 2026-07-23, fable dev-laneB, stacked on 3c-ii)

**Producer-only, as predicted by the two-region model.** A combined
`try { …await… } catch (e) { … } finally { F }` group (F await-free — the
Gap-3 invariant) mints TWO handler regions:

- the **catch region** `r` — `catchState` + `finalizer: F`, covering the TRY
  chunk. Abrupt-in-try → route → catch (F not yet — spec ordering); `return`
  in try → the hook replays F; `return await` in try → the settleSent replay
  runs F (both landed in 3c-ii and index `handlers[id-1]`, so they picked up
  the combined region for free).
- the **finally-only region** `rFin` — `finalizer: F`, NO catchState,
  covering the CATCH chunk (its leads/suspends/resumeFrom all tagged `rFin`).
  A throw / rejected await in the catch → no route branch (no catchState) →
  the reject tail's `inSrcTry == rFin` guard replays F → reject. A `return`
  in the catch → hook replays F.

Normal completions run F as inline handler-0 leads appended at the try-exit
and catch-exit states. Region ids stay dense via a running counter (a
combined group consumes two ids); the route loop skips catchState-less
regions; the reject tail's per-region guard for `r` is unreachable in the
routed dispatcher (the route branches to the catch first) — dead but
harmless, F never double-runs.

**Measured:** 8 new tests (32/32 total): fulfil/reject/throw-in-catch/
return-in-try/return-in-catch/await-in-catch/rejected-await-in-catch/
return-await-in-try — every completion path observes F exactly once in spec
order (104/142/105/1050/1042/150/100/1077). Byte matrix: all 8 controls
unchanged across 3 lanes.

## Slice 3c-iii — NESTED try/catch regions (LANDED, 2026-07-23, fable dev-laneB, stacked on 3c-ii-b)

**The static-tagging prediction held — producer + validator only, zero
emitter/route changes.** The recognizer/builder generalize to a RECURSIVE
region-body model (`RegionBody` = alternating linear chunks and groups;
`lowerRegionBody` recurses into try blocks; `buildBody(region, enclosing)`
tags every chunk with the innermost active region id and recurses with the
group's own id for its try body). An inner group's region carries
`parent = enclosing`; its CATCH chunk is tagged with the ENCLOSING region id
— so an abrupt in the inner catch (sync throw OR rejected await) escalates to
the outer catch through the SAME flat id-dispatch route: the parent chain is
encoded statically in the handler tags, no dynamic walk. Region ids stay
dense via the running counter (inner ids > parent ids; handlers sorted by id
before return since recursion pushes inner-first). `validateAsyncCfg` lifts
`parent !== 0` for FINALIZER-FREE regions only (a nested region with a
finalizer would need innermost-first finalizer-chain replay — the producer
never emits one: combined finally groups stay depth-0 with pure try bodies,
and this gate keeps it that way).

**Measured:** 6 new tests (38/38 total): inner-catch handles (42), throw /
rejected-await in the inner catch escalate to the outer catch (142/142),
post-inner-group abrupt hits the outer catch (105), fulfil-through with
pre/mid/post leads + post await (125), three-level nesting (7). Byte matrix:
all 8 controls STILL identical — the recursive-builder rewrite reproduces
byte-exact output for every single-group shape.

**3c is now COMPLETE for the bounded model.** Still banked beyond it: nested
finalizer chains (multiple enclosing finallys replaying innermost-first on
one abrupt), await-in-finally, destructured catch params, awaited try/catch
inside a CATCH block (lowerChunk bails it). **D4 (#2864 sync-generator
convergence) is now UNBLOCKED** per the alignment decision there — the
catch-region routing + completion replay it needs exist on the async lane.
