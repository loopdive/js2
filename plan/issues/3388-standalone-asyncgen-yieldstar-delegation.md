---
id: 3388
title: "standalone: async-gen `yield*` over non-literal sources in NESTED/method producers — runtime delegation with §27.6.3.7 GetIterator error semantics (~600 rows)"
status: done
completed: 2026-07-18
assignee: ttraenkler/fable-dev-2
pr: 3332
sprint: current
created: 2026-07-17
updated: 2026-07-18
priority: high
horizon: l
feasibility: hard
model: opus
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: async-generators, yield-star, iterator-protocol
goal: standalone-mode
umbrella: 3178
related: [3132, 3387, 3389, 2906, 2865, 3075]
origin: "2026-07-17 fable-3178 umbrella decomposition — the yield-star cohort of the standalone host_import_leak baseline (#3132 S3, re-grounded with the nesting-seam finding)."
# (#3102) Intended god-file growth: the rtDelegate segment + planAsyncGenCfg
# 3-state runtime-delegation loop live in async-cps.ts (the async-CPS analyzer/
# planner — the correct subsystem home); the GetIterator §7.4.1 throw-not-trap
# tails + eager TypeError-ctor registration live in iterator-native.ts (the
# native iterator runtime); the __yieldstar_rtiter spill numbering in
# async-frame.ts. All three are the canonical subsystem modules for this logic.
loc-budget-allow:
  - src/codegen/async-cps.ts
  - src/codegen/iterator-native.ts
  - src/codegen/async-frame.ts
---

# #3388 — async-gen `yield*` delegation for nested + method producers

## Problem

~600 official-scope `host_import_leak` rows carry `__gen_yield_star`
(917 total across combos; the pure combo
`__create_async_generator,__gen_create_buffer,__gen_next,__gen_yield_star,__get_caught_exception`
alone is 544). Concentrated in:

- `{expressions,statements}/class/elements` — `yield-star-getiter-*`,
  `yield-star-next-*` private/RS async-gen METHOD files (200-row combo),
- `{expressions,statements}/class/async-gen-method[-static]` (~262 across
  combos — `yield-star-getiter-sync-not-callable-*-throw`, abrupt-path tests),
- `expressions/object/method-definition` (~65).

These are the #3132 S3 banked slice, re-grounded: #3132 closed after S1
(array-literal unroll) + S2 (methods receiver-threading); general `yield*`
never landed for the shapes below.

## Probe matrix (2026-07-17, current main, `--target standalone`)

| shape                                                    | module scope | wrapped / method    |
| -------------------------------------------------------- | ------------ | ------------------- |
| `async function* g() { yield* arr; }` (array ident)      | HOST-FREE    | **LEAKS** (wrapped) |
| `async function* g() { yield* customAsyncIterableObj; }` | HOST-FREE    | **LEAKS** (wrapped) |
| class `async *m() { yield* … }` (the corpus files)       | —            | **LEAKS**           |

Same seam as #3387: `analyzeAsyncGen` (`src/codegen/async-cps.ts:2240`)
returns null for any `yield*` whose operand is not an ARRAY LITERAL
(the S1 gate at ~2266: `if (!ts.isArrayLiteralExpression(src)) return null`),
and the nested-declaration / class-method / object-literal lanes
(`nested-declarations.ts:678/:1104`, `class-bodies.ts:2354` region,
`literals.ts:2974-2982`) all consult that analyzer via
`isAsyncGenDriveCandidate` (async-frame.ts:2073). At module scope some OTHER
arm admits these host-free — #3387 step 1 locates and validates that arm;
coordinate with whoever lands #3387 first and reuse the documented finding
from umbrella #3178.

## Implementation Plan

### Slice 1 — runtime delegation loop (the #3132 S3 design, now actionable)

Extend `analyzeAsyncGen` with a DELEGATION segment kind for `yield* <expr>`
over an arbitrary operand (identifier, call, member, string), lowered as a
runtime CFG loop — the producer-side DUAL of the `planForAwaitAsyncCfg`
consumer (async-cps.ts:1907):

- **head state**: evaluate operand once; GetIterator per §27.6.3.7 —
  try `Symbol.asyncIterator`, fall back to `Symbol.iterator` wrapped in the
  AsyncFromSync equivalent (reuse the existing consumer machinery in
  `iterator-native.ts` — the ITER_KIND dispatch — rather than a parallel
  GetIterator).
- **loop**: `inner.next()` → await (carrier `$Promise` assimilation, #2865) →
  read `{done, value}` from the `$IteratorResult` struct → if `done` exit with
  the result VALUE as the yield\*'s completion value → else `settleYield value`
  (the outer's pending `next()` promise fulfills `{value, done:false}`) →
  back-edge on outer resume.
- Slice 1 forwards `next()` only. Outer `.return()`/`.throw()` forwarding into
  the delegate (§27.6.3.7 steps 7.b/7.c) is #3389's completion machinery —
  keep those legacy where they cannot be expressed (correct-or-legacy), but
  note that many corpus files here only need the GetIterator ERROR paths (see
  edge cases), which slice 1 fully covers.

### Slice 2 — the method lanes

The class-method (`class-bodies.ts`, after the #3132 S2 receiver-threading
gate) and object-literal (`literals.ts:2974`) lanes admit the widened bodies
automatically once `analyzeAsyncGen` accepts them — the gate is shared. Verify
the S2 exclusions (super/arguments/static-this, `methodBodyRefsShadowedOuterLocal`
#3312 guard, stem dedup) still bail correctly, and run the private-name RS
file family (`same-line-async-gen-rs-*`) — several are already host-free on
main, so measure-first to avoid re-fixing landed rows (the promoted baseline
lags; see #3380).

## Edge cases (these ARE the corpus tests)

- `GetMethod(obj, @@asyncIterator)` returns null/undefined → fall to sync;
  both absent → TypeError at delegation start (getiter-\*-not-callable files:
  boolean/number/string/symbol/object variants).
- `@@asyncIterator` getter throws → propagate (getiter-\*-get-abrupt).
- iterator object not an object / `next` not callable → TypeError
  (yield-star-next-not-callable-\*).
- `next()` result not an object / `done`/`value` getter throws → propagate
  (next-call-{done,value}-get-abrupt, next-call-returns-abrupt).
- All of these must surface through the OUTER driven `next()` promise
  REJECTION (the native `__exn` tag path, `ensureExnTag` in
  `src/codegen/registry/imports.ts`) — never a trap.
- The implicit-await distinction (#3120): delegation does NOT re-await inner
  values on the modeled lane — keep the S1 mode routing
  (`yieldOperandIsPromiseTyped`) consistent.

## Test plan

- Executed probes (wrapped shape) for: value forwarding order, done-value as
  completion value, each abrupt GetIterator path asserting TypeError delivery
  via rejection.
- Construct-sample the `yield-star-*` file family across
  class/elements + async-gen-method dirs; zero pass→fail on the #3132 S1/S2
  suites (`tests/issue-3132*.test.ts`) and the driven-consumer scans.
- Mix-safety: module with one delegating gen + one legacy-only gen keeps
  carrier off coherently (pre-pass ⊆ emit).

## Regression risks

- The delegation loop shares frame/state numbering with #3387's for-await
  states — if both land concurrently, coordinate the CFG segment-kind
  enum/state-allocation in `analyzeAsyncGen` (same function, guaranteed
  conflict; sequence the PRs, second re-merges first).
- `__gen_yield_star` import retirement must not orphan the HOST-lane eager
  buffer which still uses it (host lane byte-identical — SHA probe).

---

## Concrete implementation plan (fable-dev-2, 2026-07-18) — resume-ready

**Branch**: `issue-3388-asyncgen-yieldstar` (worktree
`/Users/thomas/Documents/Arbeit/Startup/Projekte/Mosaic/code/@loopdive/ts2wasm/.claude/worktrees/agent-a843226f60c86c747`).
**Base**: origin/main. **Predecessor**: #3387 (PR #3322, fable-dev-3) lands
first; re-merge before enqueue. Per fable-dev-3, #3387 only touches
`asyncGenBodyHasPatternLocals` + a new `forAwaitHeadPatternAdmissible` — DISJOINT
from the functions below, so the async-cps.ts merge is textual-adjacency only.
Cite #3387's issue-file "Implementation notes": the module-scope host-free arm
is the **lead-statement path**, not `planForAwaitAsyncCfg`'s CFG arms.

### Root-cause / seam (verified)
`analyzeAsyncGen` (async-cps.ts:~2296) rejects any `yield*` whose operand is not
a driven-async-gen CALL (#2570, `delegate`) or an ARRAY LITERAL (#3132 S1) — the
gate at **async-cps.ts:2343** `if (src === undefined || !ts.isArrayLiteralExpression(src)) return null;`.
That single `return null` propagates through `isBoundedAsyncGenBody` /
`isAsyncGenDriveCandidate` (async-frame.ts:2073) so nested/method async-gens with
`yield* <identifier|member|non-drivable-call|string>` demote to the legacy #680
host-buffer lane (the `__gen_yield_star` leak, ~600 rows).

### Reusable machinery (do NOT rebuild)
- **GetIterator**: `ensureAsyncIterator(ctx, fctx)` (statements/destructuring.ts:407)
  → standalone `__iterator` (native, USER arm handles custom iterables via
  `ensureNativeIteratorRuntime`). This is the sync-backed GetAsyncIterator the
  `planForAwaitCfg` CONSUMER (async-cps.ts:1630) already uses.
- **IteratorStep+Value**: `__iterator_next(iter) -> (i32 done, externref value)`
  (iterator-native.ts:474, USER arm = custom `.next()`).
- **The CONSUMER dual to copy**: `planForAwaitCfg` (async-cps.ts:1630) — same
  GetIterator + sync-step + per-element await. #3388 is its PRODUCER dual:
  replace "run body" with "settleYield(value)" + back-edge (the #2570 pump's
  `settleYield ... resumeState: pump` shape, async-cps.ts:2618).

### Design — new RUNTIME-DELEGATION segment (non-call yield*)
1. **`AsyncGenYield`** (async-cps.ts:~2150): add
   `readonly rtDelegate?: ts.Expression;` — the paren-stripped arbitrary operand.
   Mutually exclusive with `delegate`/`awaited`/`plain`. (Distinct from #2570's
   `delegate?: ts.CallExpression`, which stays for driven-gen calls.)
2. **`analyzeAsyncGen` yield\* arm** (async-cps.ts:2310-2363): AFTER the #2570
   call-delegate check and the #3132 array-literal arm, replace the
   `!ts.isArrayLiteralExpression → return null` reject with: paren-strip the
   operand; if it is any expression (identifier/member/call/string/element-
   access), push `{ leads, awaited:null, plain:null, rtDelegate: src }` and
   `continue`. Keep rejecting only genuinely-unhandled shapes (spread — none
   here). Guard: skip when the operand `containsAwaitOrYield` (nested suspend in
   the operand expr — bank as follow-up).
3. **`planAsyncGenCfg`** (async-cps.ts:2496 loop): add a `y.rtDelegate !== undefined`
   branch BEFORE the `y.delegate` branch. Emit the 5-state loop (dual of
   planForAwaitCfg + #2570 back-edge):
   - `init(k)`  : `[leads]` → `iter := GetAsyncIterator(operand)` (compile the
     operand expr, coerce externref, `call ensureAsyncIterator`, store the
     PERSISTED spill slot) → `goto pump`.
   - `pump(k+1)`: `{done,value} = __iterator_next(iter)` (transient locals) →
     `condGoto(done, after, awaitStep)`.
   - `awaitStep(k+2)`: `suspend(await value, resume→yieldStep)` — the
     AsyncFromSync §27.1.4.4 per-element await (only on the not-done path).
   - `yieldStep(k+3)`: `settleYield(<awaited value from SENT>, fromSent:true,
     resumeState: pump)` — the BACK-EDGE (next outer kick re-pumps).
   - `after(k+4)`: next segment's first state (completion value discarded —
     statement position only; `analyzeAsyncGen` only accepts `yield*` as a
     top-level ExpressionStatement, so `yield*` is never in value position).
   `id += 4` (5 states, same accounting as #2570's 4-state `id += 4`).
4. **Frame spill** (async-frame.ts `computeAsyncGenSpills`/`computeAsyncSpills`,
   + `listTopLevelYieldStarCalls` sibling): number a per-rtDelegate spill
   `__yieldstar_rtiter_<i>` exactly like `__yieldstar_iter_<i>` (#2570) /
   `FORAWAIT_ITER_SPILL`. Add a `listTopLevelRtDelegateYieldStars(fn)` walker
   (mirror `listTopLevelYieldStarCalls`, async-cps.ts:2210) so the spill layout
   and the CFG planner number them identically. This is the ONLY async-frame.ts
   touch — a NEW spill name, no renumber of existing states (disjoint from #3387).

### §27.6.3.7 error semantics (the corpus tests — edge cases §"Edge cases")
- GetIterator not-callable / getter-throws → the native `__iterator` USER arm
  already throws a TypeError; it surfaces through the outer driven `next()`
  promise REJECTION via the exn tag (ensureExnTag). Verify `__iterator`'s
  not-an-object / not-callable arm throws (may need an explicit TypeError arm —
  CHECK `buildIteratorBody` USER arm; if it traps instead of throwing, add the
  throw). This is the largest corpus slice.
- `.next()` not callable / result not object / done|value getter throws →
  `__iterator_next` USER arm propagation → same rejection path.

### Slices / checklist
- [ ] S1a: `AsyncGenYield.rtDelegate` field + `analyzeAsyncGen` gate widening.
- [ ] S1b: `planAsyncGenCfg` 5-state runtime-delegation loop.
- [ ] S1c: frame spill numbering (`__yieldstar_rtiter_<i>` +
      `listTopLevelRtDelegateYieldStars`).
- [ ] S1d: verify GetIterator/next error paths reject (not trap); add TypeError
      arm to `__iterator` USER path if it traps.
- [ ] S2: method/object-literal lanes (shared gate — should admit
      automatically once analyzeAsyncGen accepts; verify the #3132 S2
      receiver-threading + #3312 `methodBodyRefsShadowedOuterLocal` guards still
      bail correctly; measure-first on already-host-free `same-line-async-gen-rs-*`).
- [ ] Tests: tests/issue-3388-*.test.ts — value forwarding order, done exits,
      each abrupt GetIterator path → TypeError via rejection; zero pass→fail on
      tests/issue-3132*.test.ts + tests/issue-2570-*.test.ts + driven-consumer scans.
- [ ] Re-merge #3387 (or origin/main once #3322 lands) before enqueue.

### Deferred (correct-or-legacy, NOT this slice)
- Outer `.return()`/`.throw()` forwarding into the delegate (§27.6.3.7
  steps 7.b/7.c) → **#3389** completion machinery.
- yield* in VALUE position (`x = yield* g`) — analyzeAsyncGen only accepts
  statement-position yields.
- Nested await/yield INSIDE the yield* operand expression.
- Genuine @@asyncIterator (async-native, not sync-backed) await-the-result-promise
  model — slice 1 uses the sync-step + await-value (AsyncFromSync) model that the
  reusable `__iterator`/`__iterator_next` provide (the dominant test262 shape).

### Regression-risk notes
- `__gen_yield_star` host import must stay for the HOST lane eager buffer
  (host bytes unchanged — SHA-probe a host-mode async-gen `yield*` before/after).
- Mix-safety: a module with one delegating gen + one legacy-only gen keeps the
  carrier decision coherent (pre-pass ⊆ emit — the shared gate propagation
  above guarantees it).

---

## Progress log (fable-dev-2, 2026-07-18)

**Core rtDelegate machinery IMPLEMENTED + runtime-proven (host-free).** Design
simplified from the plan's 5-state to a **3-state no-await loop** (init → pump →
settleYield-back-edge), consistent with the #3120 mode routing the spec §"Edge
cases" mandates ("delegation does NOT re-await inner values on the modeled
lane") — the reusable `__iterator`/`__iterator_next` are SYNC helpers, so the
dominant sync-backed-iterable shape needs no per-element await.

Landed on branch `issue-3388-asyncgen-yieldstar`:
- `AsyncGenYield.rtDelegate?: ts.Expression` field (async-cps.ts).
- `analyzeAsyncGen` gate widened: `yield* <non-call, non-array-literal>` →
  rtDelegate segment (async-cps.ts:~2354).
- `planAsyncGenCfg` 3-state runtime-delegation loop (async-cps.ts:~2560).
- `listTopLevelRtDelegateYieldStars` walker + `__yieldstar_rtiter_<i>` frame
  spill numbering (async-cps.ts + async-frame.ts `computeAsyncSpills`).

**Verified working (wasi driver harness, imports: [] host-free):**
- `yield* <identifier bound to array>` → yields 11,22,33 then done. ✓
- leading/trailing plain yields around `yield*` → 1,2,3,4 then done. ✓
- method async-gen `yield* arr`, module-scope `yield* arr`, `yield* "str"`
  compile host-free (no `__gen_yield_star` leak). ✓

**REMAINING (the blocking item for a net-positive PR):**
1. **GetIterator TypeError must throw, not trap.** `yield* <non-iterable>`
   (e.g. `yield* (42 as any)`) currently TRAPS with `RuntimeError: illegal cast`
   in the `__iterator` (GetIterator §7.4.1) hard-cast TAIL
   (iterator-native.ts `buildIteratorBody`, the trap tail after all arms). The
   §27.6.3.7 GetIterator-error corpus (getiter-*-not-callable) is a LARGE part
   of the ~600 rows and currently PASSES on the legacy host path — admitting
   those shapes to a native path that TRAPS would REGRESS them (PASS→FAIL). Fix:
   make the trap tail throw a native TypeError via the exn tag (`ensureExnTag` /
   `__new_TypeError`) — this is spec-correct for ALL GetIterator consumers
   (§7.4.1 "If method is undefined, throw a TypeError"), currently a trap. It is
   a SHARED-helper change (sync for-of / spread also consume `__iterator`), so it
   needs its own careful validation (full test262) — do NOT ship the rtDelegate
   admission WITHOUT it, or the error-test corpus regresses. Options: (a) throw
   in the tail (broad, spec-correct, needs test262); (b) a narrower async-gen-only
   pre-check that keeps a KNOWN-non-iterable operand on legacy — but iterability
   is a runtime property, so (a) is the real fix.
2. **String yield* value fidelity.** `yield* "ab"` iterates the right COUNT
   (2 elements then done) but element VALUE fidelity for native strings via
   `__iterator_next` needs a string-value read verification (the probe read
   values as f64 → could not display string chars). Verify with a string-typed
   consumer before claiming string support.
3. **Nested driven+rtDelegate combo** (`outer(){ yield* g() }` where `g` itself
   `yield* arr`) hits the #680 CE — a separate interaction; bank as follow-up.

**Gates confirmed OK**: `isAwaitFreeAsyncGenBody` (rtDelegate has awaited:null →
await-free ✓), `isAsyncGenDriveCandidate` carrier-off standalone lane admits it,
`asyncGenDelegatesRegistered` vacuous for non-call operands ✓.

**Sequencing**: re-merge #3387 (PR #3322) / origin/main before enqueue.

### Throw-not-trap fix — precise approach (for the resumer)

The GetIterator error path (remaining item #1) is tractable via
`buildThrowJsErrorInstrs(ctx, "TypeError", msg)` (src/codegen/js-errors.ts:66),
which returns a raw `Instr[]` that constructs a REAL `TypeError` instance and
`throw`s it (no fctx needed). Splice it into the `__iterator` (and, for
`.next()`-not-callable, `__iterator_next`) HARD-CAST TAIL in `buildIteratorBody`
/ `buildIteratorNextBody` (iterator-native.ts), replacing the `ref.cast` that
traps (`illegal cast`) when a subject matches no arm.

**Index-shift caveat (the real work):** `buildThrowJsErrorInstrs` with
`forceInModuleCtor:true` reads `ctx.funcMap.get("__new_TypeError")`, and the
default path `ensureLateImport`s it. `buildIteratorBody` runs both eagerly
(`ensureNativeIteratorRuntime`) AND at finalize (`fillNativeIteratorLateArms`) —
registering `__new_TypeError` at finalize is the #2043 late-shift hazard. So:
EAGERLY register the WASI TypeError constructor (`emitWasiErrorConstructor(ctx,
"TypeError", 1)`) in `ensureNativeIteratorRuntime` BEFORE the `registerNative`
calls (gated on `ctx.standalone || ctx.wasi`), then have the tail reference
`ctx.funcMap.get("__new_TypeError")` by name (stable, shift-maintained). Bake
the throw instrs into the tail at build time (both the eager vec-only body and
the finalize USER-arm rebuild). Validate: (a) `yield* 42` / `yield* {}` reject
with a `TypeError` instance (not a trap, not null); (b) sync `for (const x of
42)` now throws TypeError too (spec §7.4.1 — a NET IMPROVEMENT, but re-run the
for-of / spread / iterator suites + full test262 to confirm no regression on the
shared helper); (c) the ~600-row error corpus flips host_import_leak → pass.

This is the ONE remaining blocker before opening the PR — without it the
GetIterator-error corpus regresses PASS→FAIL (trap). The value-forwarding core
is done and proven.
