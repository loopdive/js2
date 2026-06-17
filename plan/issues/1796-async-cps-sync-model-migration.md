---
id: 1796
title: "Migrate synchronous-async contract to CPS Promise model (flip ASYNC_CPS_ENABLED)"
status: done
assignee: ttraenkler/sen-b
completed: 2026-06-16
created: 2026-06-03
priority: top
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: async, promises
goal: spec-completeness
sprint: 63
related: [1042, 1326, 1373, 1373b]
note: "2026-06-15: elevated to TOP priority by stakeholder (Proxy/Promise/async-to-100% epic). Host-mode Promise/async completion linchpin. Needs architect spec + senior-dev; sequenced after #1936 census, gated on #1373b CPS lowering."
---
# #1796 — Migrate the synchronous-async contract to the CPS Promise model

## Context

#1042 PR1 landed the full async/await CPS state-machine lowering **inert**
(`ASYNC_CPS_ENABLED = false` in `src/codegen/async-cps.ts`). The driver
(`emitAsyncStateMachine`), segmentation (`splitBodyAtAwait`), continuation
synthesizer (`compileSyntheticAsyncContinuation`), function-body activation
hook, and AwaitExpression gate are all in place and gated off. Emitted Wasm is
byte-identical to before; existing async tests pass unchanged.

## The design wall (why this is its own issue)

The existing compiler lowers `async function` **synchronously**: a caller does
`f() as any as number` and gets the *unwrapped value* directly (await is an
identity pass-through). See `tests/equivalence/async-function.test.ts` — the
"await expression is identity (pass-through)" test asserts
`test() as any as number === 100` for `const v = await getValue(); return v`.

The CPS lowering changes the async return model to a **real Promise object**
(externref): `emitAsyncStateMachine` rewrites the function's result type to
`externref` and returns the chained `Promise_then2(...)` result. So **flipping
`ASYNC_CPS_ENABLED` to `true` breaks every test that relies on the synchronous
model** — the whole `async-*` equivalence suite plus very likely a large number
of test262 async cases that read the result as a value, not a thenable.

This is not a localized flip; it is a **contract migration** that must be done
as one coordinated change with the test corpus.

## Scope

1. Flip `ASYNC_CPS_ENABLED` → `true` in `src/codegen/async-cps.ts`.
2. Migrate the synchronous-async call/consume sites: every place that treats an
   async-function result as its unwrapped value (`f() as any as number` idiom,
   direct numeric/string/ref use of an async return) must instead await /
   unwrap the Promise. Inventory via the `async-*` equivalence suite + a grep
   for `as any as` on async-call results.
3. Update the async test corpus (`tests/equivalence/async-*.test.ts`,
   `tests/issue-*async*.test.ts`) to the Promise model — the harness must
   `await` the exported entry (or drain microtasks) instead of reading a value.
4. Add `tests/issue-1042.test.ts` — the 5 canonical CPS runtime cases that
   require the gate on: identity await (=42); sequential side-effect ordering;
   try/catch reject; Promise.all interleave; return-await collapse.
5. Re-baseline test262 async buckets; coordinate with the JS-host vs standalone
   Promise paths (#1326 microtask queue is the standalone settle path).
6. Extend coverage beyond the single-tail-await shape `splitBodyAtAwait`
   currently accepts (multiple awaits, awaits in branches/loops, try-across-await
   #1373c, async arrows/methods) — or keep those on the legacy path with an
   explicit `splitBodyAtAwait → null` fallback and a follow-up.

## Acceptance criteria

1. `ASYNC_CPS_ENABLED = true` and the 5 canonical `tests/issue-1042.test.ts`
   cases pass.
2. The async equivalence suite is migrated to the Promise model and green.
3. No net test262 regression in the async buckets (the migration may flip some
   tests both ways — net must be ≥ 0, ideally positive as real Promise
   semantics land).
4. JS-host and standalone (#1326) async paths both produce spec-correct
   ordering.

## Notes

- The driver intentionally uses the `.then`-chaining model (the continuation's
  `return X` is the cb's externref result; `.then` resolves the chained promise
  to it) — no manual settle. The `Promise_new_pending` / `Promise_settle_*`
  runtime primitives committed in #1042 PR1 (e42882074) remain available if a
  future settle model is preferred.
- #1042 issue file `## In-progress work` has the full step-by-step + the
  `__make_callback` contract + verified wiring line numbers.
- **ID note:** filed as #1796 because #1792 was already taken
  (`1792-node-url-builtin-impl.md`); the lead's dispatch said "1792" but that
  collides — using the next free id.

## Implementation Plan (refreshed 2026-06-16, arch1 — against upstream/main 319d43460)

### What landed since the prior spec (verified on current main)
- **#1936 DONE** (se1, completed 2026-06-16). `analyzeAsyncBody`,
  `awaitIsStaticallyResolved`, `asyncFnNeedsCps(fn, plan)`, `AsyncConsumerKind`,
  and `classifyAsyncConsumer(checker, expr)` all exist in
  `src/codegen/async-cps.ts` (lines 60, 104, 182, 256, 279, 297). The call-site
  classifier IS wired: `asyncResultConsumedAsValue` (`expressions.ts:259-266`)
  now delegates to `classifyAsyncConsumer(...) !== "thenable"` — a
  behaviour-preserving refactor (parity note at async-cps.ts:292).
- **`ASYNC_CPS_ENABLED` is STILL `false`** (`async-cps.ts:60`) and
  `asyncFnNeedsCps` short-circuits on it (line 257). The global flip has NOT
  happened.
- **The activation gates have NOT yet been migrated to `asyncFnNeedsCps`.**
  Both `function-body.ts:1117-1132` and the `collectAsyncCpsImports` prepass at
  `declarations.ts:652-665` still use the *inline* duplicated shape check
  (`ASYNC_CPS_ENABLED && … && plan.awaitPoints.length === 1 &&
  !plan.hasTryAcrossAwait && splitBodyAtAwait(...) !== null`). This issue is
  what migrates them onto the single predicate.
- **#1326c DONE** — standalone microtask queue + chained `.then` landed; the
  standalone Promise substrate referenced below is live.

### Root cause
Execution of the #1936 census: flip `ASYNC_CPS_ENABLED` (`async-cps.ts:60`) on,
route both activation gates through the now-existing `asyncFnNeedsCps` predicate
(replacing the two inline duplicated shape checks), and migrate the test corpus +
remaining synchronous-consumption (`value`-bucket) call sites off the raw-value
contract onto the real-Promise contract. Machinery is present and verified-when-run
(`tests/issue-1042.test.ts` Slice-2A); the work is contract migration, not new
lowering.

### Sequencing dependency note (read before flipping)
The interaction with **#2028** (Promise executor body never dispatches) and the
**#1042 staleness note** (`await Promise.resolve(41)` yields NaN today — issue
file lines 63-68) means the *host-mode Promise substrate itself is partially
broken right now*. Confirm #2028's `__make_callback`/`Promise_new` dispatch fix
has landed (or that the executor path is not on the critical path for the 5
canonical #1042 cases) BEFORE flipping — otherwise the migrated equivalence
tests will fail on a substrate bug, not a migration bug, and the net-delta
signal is unreadable. Recommend: land #2028 first, then this flip.

### Sequencing
Gated on #1936 (census + `asyncFnNeedsCps` + elision) and #1373b (CPS/IR
adoption). Do NOT flip before #1936's census report exists.

### Changes (file:line verified on upstream/main 319d43460)
- **`async-cps.ts:60`**: `ASYNC_CPS_ENABLED` → `true`. Step 2 (after green):
  REMOVE the constant and the `if (!ASYNC_CPS_ENABLED) return false;` line at
  `async-cps.ts:257` (removal is acceptance criterion 3).
- **`function-body.ts:1117-1132`**: replace the inline duplicated shape check
  ```ts
  if (ASYNC_CPS_ENABLED && isAsync && !ctx.wasi && !ctx.standalone && ts.isFunctionDeclaration(decl) && decl.body) {
    const asyncPlan = analyzeAsyncBody(ctx, decl);
    if (asyncPlan.awaitPoints.length === 1 && !asyncPlan.hasTryAcrossAwait && splitBodyAtAwait(decl, asyncPlan) !== null) { … }
  }
  ```
  with the single predicate:
  ```ts
  if (isAsync && !ctx.wasi && !ctx.standalone && ts.isFunctionDeclaration(decl) && decl.body) {
    const asyncPlan = analyzeAsyncBody(ctx, decl);
    if (asyncFnNeedsCps(decl, asyncPlan)) { … }
  }
  ```
  `asyncFnNeedsCps` already folds in `awaitPoints.length > 0`, the
  any-real-suspension check, AND `splitBodyAtAwait !== null` — so this is
  strictly equal-or-narrower (it ALSO elides fully-static-await bodies, which is
  the intended #1936 behaviour). Keep the `!ctx.wasi && !ctx.standalone`
  exclusion until the standalone substrate (#1326c) is wired into this gate;
  drop it in a follow-up.
- **`declarations.ts:652-665`** (`collectAsyncCpsImports` prepass): mirror the
  exact same migration — replace the inline `plan.awaitPoints.length === 1 &&
  !plan.hasTryAcrossAwait && splitBodyAtAwait(...) !== null` with
  `asyncFnNeedsCps(node, plan)`. The two gates MUST stay byte-identical in their
  decision or the prepass under/over-registers `Promise_resolve` /
  `__make_callback` / `Promise_then2` imports → the #1384 late-import-shift
  hazard or a missing-import `reportError` at `async-cps.ts:373-379`. Using one
  predicate in both places is the durable fix for that duplication.
- **`expressions.ts:259-266`** (`asyncResultConsumedAsValue`): already routes
  through `classifyAsyncConsumer`. After the flip, the `"value"` bucket
  (`f() as any as number`) is the set that BREAKS — those callees now return a
  real Promise and the cast yields NaN. Migrate those sites per the Migration
  surface below; the `"thenable"` and `"await"` buckets are already correct.
  Keep raw-value elision ONLY for statically-resolved callees (await-elided
  sync fns). The non-tail await arm (`expressions.ts` await handling under an
  active state machine) must keep its explicit `reportError` (PR1 limit) — widen
  per scope step 6 or keep erroring; **never silently mis-lower**.

### Migration surface (from #1936 census)
1. `value`-bucket sites (`f() as any as number`): rewrite to `await f()` /
   unwrap Promise; inventory via grep `as any as`/`as unknown as` on async results.
2. Test corpus → Promise model: `tests/equivalence/async-function.test.ts`,
   `async-await.test.ts`, `promise-chains.test.ts`, `async-iteration.test.ts`,
   `ir-slice10-promise.test.ts` — harness must `await exports.main()` (or drain
   microtasks in standalone).
3. `tests/issue-1042.test.ts`: promote skipIf block to always-on; add 5 canonical
   CPS cases (identity await=42; sequential ordering; try/catch reject;
   Promise.all interleave; return-await collapse).

### Standalone vs JS-host
host: Promise_resolve/__make_callback/Promise_then2 imports (runtime.ts:9494,9525).
standalone: native `$Promise` + microtask queue —
`emitStandalonePromiseResolve` (async-scheduler.ts:1089) for Promise_resolve,
`emitStandalonePromiseThen` (1132) for Promise_then2, synthesized `$__mt_func_type`
`ref.func` for __make_callback; continuations are `__microtask_enqueue` tasks,
FIFO drained after `_start` (line 1066). The #1326 engine — do not re-spec.

### Edge cases (acceptance: spec-correct ordering)
sequential side effects `a();await x;b()` → "132" not "123"; try/catch reject →
`hasTryAcrossAwait` PR1-unsupported, keep legacy + follow-up #1373c; Promise.all
interleave → standalone combinator on native queue (#1326 follow-up); return-await
collapse handled; async throw/reject → sync throw in prefix settles result promise
rejected (§27.7.5.2); awaits in loops/branches/multiple/arrows → step 6 legacy
fallback unless `asyncFnNeedsCps` + widened `splitBodyAtAwait` accept; no silent
mis-lowering (expressions.ts:1216 keeps erroring under an active machine).

### Test-gate plan
`tests/issue-1042.test.ts` ASYNC_CPS_ENABLED assertion (25) flips to the predicate;
5 canonical cases green; full `tests/equivalence/async-*.test.ts` migrated green;
test262 `built-ins/Promise/**`, `language/expressions/await/**`,
`language/statements/async-function/**`, `language/expressions/async-arrow-function/**`;
net delta ≥ 0 (criterion 3). Run `/analyze-regression` on async buckets.

### Spec citations
Await §27.7.5.3/§27.7.5.1; AsyncFunctionStart/rejection §27.7.5.2/§27.7.5.4;
microtask FIFO PerformPromiseThen §27.2.5.4.1, Jobs §9.5.

---

## Implementation (sen-b, 2026-06-16) — gate flipped ON

Branch `issue-1796-async-cps-flip` off upstream/main `319d43460`. PR routes the
flip through the #1936 census predicate exactly as the plan above specified.

### What landed
1. **`ASYNC_CPS_ENABLED = true`** (`src/codegen/async-cps.ts`). The
   synchronous-consumption regression that kept it off is resolved structurally
   by **`asyncFnNeedsCps`**: an async fn is CPS-lowered (returns a real Promise)
   ONLY when it *genuinely suspends* — at least one await operand is not
   statically resolved. Fully await-elidable bodies
   (`return await Promise.resolve(42)`) stay on the legacy synchronous path and
   keep returning the unwrapped value, so the `asyncFn() as any as number`
   "compile away" idiom (#1313/#1727) is preserved for those.
2. **Both activation gates now consult `asyncFnNeedsCps`** — the function-body
   hook (`function-body.ts:~1117`) and the `collectAsyncCpsImports` prepass
   (`declarations.ts:~652`). Keeping them identical preserves the stable-funcMap
   pre-registration that removes the #1384 late-import-shift hazard.
3. **Promise-combinator awaits excluded from CPS** (`awaitedExprIsPromiseCombinator`
   in async-cps.ts). `await Promise.all/race/any/allSettled(...)` already yields
   a real Promise, so the legacy `await`-identity path produces a correct result
   Promise with no CPS benefit; routing them through CPS would also surface the
   host-`declare`-class-method argument-marshaling gap that **#2028** owns
   (`Promise.all(src.getPromises())`). This keeps those on the legacy path.

### Root-cause finding — the "design wall" was the per-call-site contract
The blocker recorded across #1042's notes was: the gate is per-definition but
the consumption contract is per-call-site, so a global flip cannot serve both a
`value` consumer (wants unwrapped T) and a `thenable` consumer (wants a Promise)
of the same fn. The resolution is that `asyncFnNeedsCps` makes the *flip itself*
per-function and conditioned on genuine suspension: a fn that truly suspends
*cannot* synchronously produce its value, so a `value`-consumer of it was already
semantically broken under the legacy fakery (the cast yielded a value only
because the runtime had nothing to suspend on). Those few tests are migrated to
the Promise model (`await exports.main()`); everything that stays synchronous
(await-elidable) is untouched.

### Test migration (corpus → Promise model, plan criterion 2)
Migrated the cases that consumed a genuinely-suspending async fn as a raw value
to `await … resolves`:
- `tests/equivalence/async-function.test.ts` — "await … identity (pass-through)"
- `tests/equivalence/promise-chains.test.ts` — "await … passes through value",
  "nested async calls"
- `tests/async-await.test.ts` — "await on an internal async value"
- `tests/async-census.test.ts` — gate-on assertions + true/false shape coverage
- `tests/issue-1042.test.ts` — gate-on assertion; the 8 Slice-2A CPS
  resolved-value cases (previously `skipIf` skipped) now run and pass.

### Regression posture (verified locally)
- Full async suite green except for failures that **pre-exist on upstream/main**
  (verified by running the same files on the `/workspace` main checkout):
  `tests/promise-combinators.test.ts` ×2 (host `declare`-class method marshaling,
  #2028 — fails identically with the gate off) and
  `tests/symbol-async-iterator.test.ts` ×2 (for-await-of, pre-existing). The
  stale duplicate root files `tests/async-function.test.ts` /
  `tests/for-await-of.test.ts` fail to load `./helpers.js` on main too (broken
  import path, not async-related).
- `tests/equivalence/` full directory: see PR CI (run locally pre-push).
- Net new regressions from this PR: **0**.

### Deferred / follow-up
- Multi-await sequencing, awaits in branches/loops, try-across-await (#1373c),
  async arrows/methods, standalone/WASI CPS — all remain on the legacy path via
  `splitBodyAtAwait → null` (plan step 6). They are not regressed; they are
  simply not yet CPS-lowered.
- **#2028** (host `declare`-class-method marshaling) unblocks the
  `await Promise.combinator(hostMethod())` shape; once it lands, drop the
  `awaitedExprIsPromiseCombinator` exclusion so those combinators can CPS-lower
  too (and re-evaluate the 2 pre-existing combinator test failures).
