---
id: 3120
title: "Standalone async-generator: plain `yield <promise>` skips the §27.6.3.8 implicit Await(operand) — yields the promise object (NaN) instead of awaiting; a rejecting operand doesn't reject"
status: done
completed: 2026-07-10
assignee: ttraenkler/fable-3120
pr: 2841
sprint: current
model: fable
created: 2026-07-09
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, standalone
language_feature: async-generators, iterators
goal: standalone-mode
umbrella: 2860
related: [2906, 2865, 2980]
origin: "2026-07-09 fable-3100s4 — split from the #2906 3d-iii premise-check. Found while root-causing the #2980 async-gen −4 (which turned out to be the Promise-lane, not the drive). This is a genuine, orthogonal async-gen-drive conformance gap."
---

# #3120 — async-gen implicit AsyncGeneratorYield await of the operand

## Problem (verified against main, 2026-07-09, wasi direct-drive)

§27.6.3.8 AsyncGeneratorYield(value) performs `Await(value)` on the yield
OPERAND before suspending. The native async-gen drive (#2906 3d-i) handles
`yield await P` (explicit await → suspend+settleYield, rejection routes to a
rejected next()-promise), but a plain `yield E` skips the implicit await and
yields the operand DIRECTLY. When `E` is a promise this is wrong:

Direct-drive proof (`__async_gen_next_g` → drain → read IteratorResult):

```ts
async function* g() {
  yield Promise.reject(99);
} // next1 = FULFILLED value=NaN  (want REJECTED)
async function* g() {
  yield Promise.resolve(7);
} // next1 = FULFILLED value=NaN  (want value=7)
async function* g() {
  yield await Promise.reject(99);
} // next1 = REJECTED  ✓ (explicit await works)
async function* g() {
  yield 5;
} // next1 = FULFILLED value=5  ✓ (non-promise)
```

The promise operand is coerced to f64 → NaN and fulfilled; a rejecting
operand fulfills-NaN instead of rejecting + closing the generator.

## Root cause

`analyzeAsyncGen` (async-cps.ts ~L2175) classifies `yield E` into
`awaited: P` (from `yield await P` → suspend+settleYield) vs `plain: E`
(from `yield E` → settleYield directly, NO await). A plain `yield <promise>`
takes the `plain` path and never awaits.

## Fix

Classify a `yield E` whose operand `E` is statically a Promise/thenable type
(or `any` that could be a thenable) as `awaited: E` — routing it through the
EXISTING, proven `suspend(E) → settleYield(fromSent)` machinery (which already
rejects the current next()-promise + closes the gen on a rejected operand,
per the landed 3d-i `yield await Promise.reject` test). Keep genuinely-non-
promise operands (`yield <number>`) on the fast `plain` path so
`isAwaitFreeAsyncGenBody` (the standalone-off carrier gate, #2865) stays valid
for non-promise bodies. Needs `ctx.checker` at the classification site (route
via `const { checker } = ctx`), or thread the promise-typed decision from a
checker-having caller into `analyzeAsyncGen`.

## Acceptance

1. `yield Promise.reject(e)` rejects the current next()-promise + closes the
   gen (done=true on the next next()); `yield Promise.resolve(v)` yields `v`.
2. Host-free wasi direct-drive tests (mirror `issue-2906-3di-asyncgen-producer`).
3. `yield <number>` (non-promise) stays byte-identical (await-free fast path).
4. Byte-inert on gc/host/normal-standalone.

## Scope / non-goals

Orthogonal to the #2980 flip — the async-gen −4 flip-blocker is the Promise
lane (native construction × host `.then` × legacy async-gen), NOT the drive;
the −4 files are legacy function-expression gens the drive never touches. This
is a pure host-free async-gen conformance win. `yield*` async delegation +
method-form async-gen producers are separate (their own follow-ups).

## Implementation Notes (fable-3120, 2026-07-10)

**Repro confirmed on main first** (wasi direct drive, `.tmp` probe): all four
proof shapes reproduced exactly as pinned — `yield Promise.reject(99)` →
FULFILLED NaN, `yield Promise.resolve(7)` → FULFILLED NaN, explicit
`yield await` control REJECTED ✓, `yield 5` control ✓. Also reproduced for a
Promise-typed local (`const p = ...; yield p`) and a `.then()` chain.

**The fix — WHY it is shaped this way:**

1. `analyzeAsyncGen` (async-cps.ts) gained an `implicitYieldAwait` mode
   (`{oracle} | null`, `ImplicitYieldAwaitMode`). Non-null mode classifies a
   plain `yield E` whose operand is statically Promise-typed
   (`ctx.oracle.builtinReceiverOf(operand) === "Promise"`, or a union with a
   builtin-Promise part — the #1930 oracle boundary; a raw-checker first cut
   failed the quality gate's oracle ratchet and was migrated, verified
   byte-identical) as an `awaited: E` segment — riding the SAME proven
   suspend+settleYield(fromSent) lane as `yield await E` (which already
   rejects the current next()-promise on a rejected operand). No emitter
   changes at all; the fix is pure classification.

2. **The mode is carrier-lane-scoped — this is the load-bearing decision.**
   The first cut classified unconditionally and immediately broke the #2980
   fallback vitest (`tests/issue-2980-carrier-fallback.test.ts`): on the
   carrier-off standalone drive lane, flipping a promise-yield body to
   "has awaited segment" demotes it from the (compiling, driven) await-free
   lane to the legacy path = #680 CE — a whole-module compile regression, and
   a violation of this issue's own byte-inert-on-normal-standalone acceptance.
   So the awaited classification fires ONLY where the suspend arm can
   actually assimilate the operand: `isStandalonePromiseActive` (wasi today).
   Both the admission gate (`isAsyncGenDriveCandidate`) and the planner
   (`ensureAsyncResumeFunction` → `planAsyncGenCfg(decl, mode)`) derive the
   mode from that same predicate, so gate and planner always see the same
   segment split. Carrier-off standalone keeps the pre-#3120 plain
   classification byte-identically; its value gap is the #2980 carrier
   widen's to close, not a reason to stop compiling.

3. `any`-typed operands stay on the plain fast path (deliberate): routing
   every untyped operand through a suspend state would change bytes and
   microtask timing for the huge untyped-non-promise yield population that
   provably delivers correctly today. A runtime thenable behind `any` needs a
   runtime thenable probe in the settle arm — follow-up, not static
   classification.

**Known inherited trait (pre-existing, NOT this issue):** after a rejected
(implicitly or explicitly) awaited yield, the NEXT `next()` promise is also
REJECTED rather than fulfilled `{undefined, done:true}` — the landed 3d-i
machine behaves this way for `yield await Promise.reject` too (verified on
main). Acceptance 1's "done=true on the next next()" parenthetical is
therefore a property of the 3d-i settle machinery, tracked as its own
follow-up if wanted; this fix makes the implicit form exactly match the
explicit form (parity-tested in tests/issue-3120.test.ts).

**Proofs run:**

- `tests/issue-3120.test.ts` (new, 8 tests): reject→REJECTED, resolve→7,
  promise-typed local, genuine suspension on a pending `.then` chain, mixed
  promise+plain body, non-promise fast path settles synchronously
  (pendingBeforeDrain=false), implicit≡explicit parity on reject, and
  gc-legacy + standalone-compiles lane checks.
- `scripts/prove-emit-identity.mjs`: 39/39 (file,target) sha-identical
  across gc/standalone/wasi corpus (baseline from main's async-cps/async-frame).
- Targeted 8-shape byte-diff (gc/standalone/wasi × promise-yield, await-yield,
  plain, any-typed, mixed-leads, non-gen async): ONLY the three wasi
  promise-yield shapes differ (the fix); everything else byte-identical.
- Async suites green: 2906-3di producer, 2906-3dii consumer, 2980
  carrier-fallback (the first-cut breaker), 2865 unwrap (its 2 failures
  pre-exist on main — verified by control run).
- test262 async-gen cluster (1008 files: expressions/statements
  async-generator + AsyncGeneratorFunction/Prototype + AsyncIteratorPrototype)
  A/B main-vs-branch on both CI lanes (host + standalone) — see Test Results.

## Test Results (fable-3120, 2026-07-10)

**wasi direct-drive (the fix):** `yield Promise.reject(99)` → next1 REJECTED
(was FULFILLED NaN); `yield Promise.resolve(7)` → 7 (was NaN); Promise-typed
local → 7; `.then`-chained pending operand → suspends at kick, resumes to 8;
`yield await` and `yield 5` controls unchanged.

**test262 async-gen cluster A/B (1008 files), standalone lane** (the only CI
lane where async-gen drive codegen runs): main-vs-branch runs of
`runTest262File(..., "standalone")` are **line-for-line IDENTICAL — every
status AND every per-file wasm_sha** (639 pass / 353 fail / 16 CE on both
sides). Zero flips, zero byte drift.

**Host lane:** structurally inert — `isAsyncGenDriveCandidate` is false on
gc/host, so the classification code is unreachable; confirmed by the
39/39 emit-identity corpus + the 8-shape byte-diff. (A full in-process host
A/B is infeasible locally: test262 dstr tests poison shared globals —
`Array.prototype[Symbol.iterator]` — which kills any single-process loop;
the sharded CI gate with fork isolation is the authoritative host-lane check.)

**Vitest:** tests/issue-3120.test.ts 8/8; 2906-3di producer, 2906-3dii
consumer, 2980 carrier-fallback all green post-merge of origin/main
(incl. #3125 native-resolve assimilation). The 2 failures in 2865 unwrap
(`await a sync-fulfilled local promise`, `await over an arithmetic
expression`) fail IDENTICALLY with main's async-cps/async-frame — verified
pre-existing by control runs on both the old and post-#3125 base.

**Conformance delta on current CI lanes: 0 by design** — the win is wasi-lane
correctness today, and it banks automatically for standalone the moment the
#2980 carrier widen turns `isStandalonePromiseActive` on there (the bounded
gate + awaited classification then activate for standalone too).
