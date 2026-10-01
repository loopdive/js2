---
id: 6780
title: "codegen: `await` of a statically-resolved operand (`await null`, `await Promise.resolve()`) does not suspend — the async body runs synchronously past the await"
status: done
completed: 2026-10-01
assignee: "ttraenkler/claude-dev-6780"
branch: "claude/issue-6780-await-static-resolved"
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: async-await
goal: async-model
related: [1373, 2895, 1313, 3587]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C5"
---

# #6780 — an `await` whose operand is "statically resolved" is compiled away

## Problem

```ts
let shared = 0;
const af = async (): Promise<number> => { shared = 1; await null; shared = 2; return shared; };
const p = af();
log("after-call shared=" + shared);   // wasm: 2   JS: 1
await p;
```

Every `await` must yield to the microtask queue, whatever its operand. The
compiled body runs straight through `await null`, so code after the call
observes state that in JS is only reachable after the continuation ran.
Sibling ordering diverges the same way (`af1, af3, af2` vs JS `af1, af2, af3`
in the review's `g5` probe); `await Promise.resolve()` behaves identically.

Reproduced 2026-09-30 with the review harness (`compile()` + `buildImports`,
JS-host lane, default options) and compared against Node.

## Root cause

`src/codegen/async-activation.ts:225-227` declines the async lane when every
`await` in the body passes `awaitIsStaticallyResolved`
(`src/ir/async-static.ts`: literals, `null`, `undefined`, unary). The body
is then compiled as a plain function that returns a resolved promise.
`:228-239` documents that declined shapes "run the sync fallback acceptably" —
they do not: the sync fallback changes observable interleaving.

## Correction

- Remove the "statically resolved ⇒ no suspension" shortcut. A statically
  resolved operand may skip the *thenable check*, never the continuation
  deferral: lower `await <static>` to "enqueue continuation as a microtask;
  return to caller".
- Where the async lane cannot lower a body, **refuse** (compile error, as
  #3587 does for other async shapes) instead of emitting the sync fallback.
- Keep the optimisation that matters: an async function with **zero** awaits
  may still run synchronously and wrap its result, because that is what JS
  does.

## Acceptance

- The probe above logs `after-call shared=1` then `resolved v=2 shared=2`.
- Ordering probe: three async functions each with one `await null` interleave
  exactly as Node (`af1, af2, af3` first halves, then second halves).
- `tests/equivalence/` gets the two cases plus `await undefined`,
  `await 1`, `await Promise.resolve(1)`, `await (async () => 1)()`.
- No test262 `language/expressions/await` or `statements/async-function`
  regression; report the delta in the PR.

## Implementation Plan

The code at the issue's cited lines had moved: the all-static decline now
lives in `asyncFnNeedsHostDrive` (`src/codegen/async-frame.ts`), not in
`async-activation.ts`. Steps taken:

1. **Drive settled awaits on the host lane.** `asyncFnNeedsHostDrive` no longer
   returns `false` when every await passes `awaitIsStaticallyResolved`. The host
   machine already suspends every await through `Promise_resolve` +
   `Promise_then2` (one microtask turn, whatever the operand), so no new
   lowering was needed — only the decline had to go. A ZERO-await body still
   declines (`awaitPoints.length === 0`) and keeps the synchronous fast path.
   No thenable-check shortcut exists on the host carrier (a host Promise is
   opaque), so there was none to keep.
2. **Refuse what the engine still cannot drive.**
   `reportDeclinedAsyncBody` (`src/codegen/async-activation.ts`) runs the
   existing #3587 try-scoped guard plus a new #6780 guard: a host-lane body
   with ≥1 await, every await settled, no `for await`, that the engine declines
   for its SHAPE (e.g. an await inside a loop) gets a source-located compile
   error instead of the inline-continuation fallback. Wired into the same
   three decline points as #3587 (`asyncEngineWouldActivate`,
   `maybeActivateAsync`, `closures.ts::compileArrowAsClosure`). Scope is a
   named subset, as #6504 round 30 requires: host lane only; only bodies with
   no real suspension; only engine entry points (top-level declarations,
   arrows, function expressions). Nested declarations and methods are NOT
   refused — the engine never claims them at any operand (policy decline in
   `nested-declarations.ts`, #2957), so they run the pass-through for real
   awaits too.
3. **Register the Promise result at declaration time.** `maybeActivateAsync`
   rewrote a driven declaration's result to `externref` only when its body
   compiled, so a caller compiled earlier (a forward reference — `main` above
   its helpers) baked the unwrapped `T` and the stack repair unboxed the
   Promise to NaN. That bug pre-dates #6780 for real awaits, but step 1 would
   have pushed every settled-await helper into it (measured: `await af(3)`
   with `af` declared below its caller went 7 → NaN in JS mode).
   `widenAsyncDeclarationResults` (async-activation.ts) — the #5371 thenable
   widening plus the same activation decision — now registers `externref` up
   front for a top-level async declaration the host engine will drive.
   `declarations.ts` calls it at its two registration sites (line count
   unchanged).
4. **Standalone / WASI: left unchanged, deliberately (neither fixed nor
   refused).** Their carrier is the native `$Promise` + in-module microtask
   ring. Closures (parked in `planAsyncClosureActivation` on the native lanes) and methods (#2957) are never driven there; their
   AG0 await pass-through reads `$Promise.value` synchronously, so it depends
   on callees settling synchronously. Measured with an experimental patch
   (drop the static decline for standalone + `alwaysAsyncAwait` on direct
   native frames): the sibling/`await 1` probes became correct, but an async
   arrow awaiting a driven helper went from 9 to 2 and a method from 8 to NaN.
   Refusing instead would turn currently-working standalone programs into
   compile errors. Fixing standalone needs the closure park and method residue
   lifted first.

## Resolution

### Before → after (JS-host lane, default options; wasm vs the same TS in Node)

Measured with a `compile()` + `buildImports` probe harness on the branch base
(`3d3dfda3`) and on the fix.

| probe | before | after |
|---|---|---|
| issue probe — arrow, `await null` | `after-call shared=2` ✗ | `after-call shared=1,resolved v=2 shared=2` ✓ |
| 3 sibling decls × `await null` | `af1-a,af1-b,af2-a,af2-b,af3-a,af3-b,sync-end` ✗ | `af1-a,af2-a,af3-a,sync-end,af1-b,af2-b,af3-b` ✓ |
| `await undefined` (declaration) | ran synchronously ✗ | ✓ |
| `const x = await 1` (typed declaration) | compile error (IR: "no valid async plan owner") ✗ | ✓ |
| `await Promise.resolve(1)` (typed declaration) | compile error (same) ✗ | ✓ |
| `await Promise.resolve()` | ran synchronously ✗ | ✓ |
| `await (async () => 1)()` (a real suspension) | ✓ | ✓ |
| function expression `await 0` | ran synchronously ✗ | ✓ |
| settled await inside `if` / inside `try` (typed declarations) | compile error ✗ | ✓ |
| zero-await async fn | ✓ synchronous to its return | ✓ unchanged |
| forward-referenced callee (`main` above helper), real await | `NaN` ✗ | ✓ |
| settled await inside a loop (arrow / top-level declaration) | silently ran synchronously | compile error (#6780 refusal) |

### Tests added

- `tests/issue-6780-await-static-suspends.test.ts`: 16 cases. Each runs the
  same TS in Node and asserts the wasm log order equals Node's, plus the
  literal expected string. 11 fail on the base, and all 16 pass with the fix.
- `tests/equivalence/await-settled-operand-yields.test.ts`: the issue probe
  and the sibling-ordering case.

### Gates run (all on the final tree after `git merge origin/main`)

| gate | exit |
|---|---|
| `check-loc-budget` / `check-func-budget` (merge-base and `LOC_GATE_BASE=origin/main`) | 0 / 0 / 0 / 0 |
| `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports` | 0, 0, 0 |
| `typecheck`, `format:check`, `lint` | 0, 0, 0 |
| `check-compiler-boundaries --mode inventory --base origin/main` | 0 (`errors: []`) |
| `check:ir-dialect`, `ir-kind-neutrality`, `jstag-seam`, `ir-layering`, `codegen-fallbacks`, `any-box-sites`, `speculative-rollback`, `stack-balance`, `pushraw`, `host-import-policy`, `ir-only`, `ir-adoption`, `issues`, `done-status-integrity`, `issue-spec-coverage`, `harness-compile-budget`, `verdict-oracle` | all 0 |
| `check:ir-fallbacks` | 0 (no unintended / post-claim / module-level increase) |
| `test:guard` | 0 (20 files, 255 tests) |
| new tests (`issue-6780-…`, `equivalence/await-settled-operand-yields`) | 18 / 18 pass |
| all 50 `tests/*async*` + `tests/equivalence/*async*` files, single-fork | 36 failures, the **identical** set on the base (pre-existing: absent test262 checkout, source-preservation pins, WASI consumers); 0 new |
| full `tests/equivalence` (222 files) | 22 failures in 10 files (TDZ, null-deref, reflect, …), the **identical** set at the merge base; 0 new |

### Left out, and why

- **Standalone / WASI / gc native-first:** unchanged; see Implementation Plan
  step 4. This needs a follow-up once closures and methods drive on the native
  carrier.
- **Async methods and non-conditional nested `async function` declarations:**
  the engine never drives them, for real awaits either (#2957; the policy in
  `nested-declarations.ts`). Their awaits remain a synchronous pass-through.
  One behavior shift follows from this. Such a caller that awaits a helper
  whose awaits are all settled now receives the helper's Promise object
  instead of a synchronously computed value, because the helper now really
  suspends. Before this change, such callers already got the Promise object
  for helpers with real awaits (`await helperWithRealAwait()` inside a method
  read `NaN` on main).
- **Real-suspension declines** (for example `await g()` in a loop) still use the
  synchronous fallback. Widening the refusal to that whole population was
  measured in #6504 round 30 to cost 402 rows.
- **Pre-existing, not touched:** a zero-await async declaration called from
  a top-level-invoked async `main` (`main();` at module level, not exported)
  fails to compile on main with "IR async runtime attachment … has no valid
  async plan owner". This is the same on the base and with the fix.

### test262 implications (inferred; test262 was not run locally)

- **Expected gains:** ordering-sensitive tests whose settled-await function is
  an arrow, a function expression, or a top-level declaration that the engine
  drives, in `language/expressions/await`, `async-arrow-function`,
  `async-function` and `statements/async-function`. Also gains where a
  top-level helper is called before its declaration and its awaited value is
  used.
- **Limited reach in the honest lane:** the runner wraps the test body inside
  `export function test()`, so test-declared `async function`s are nested
  declarations. Those are only driven when they have conditional suspension,
  so most declaration-based tests keep their current behavior.
- **Regression risk:** a nested declaration or method that awaits an async
  arrow or function expression whose awaits are all settled, and then uses
  the value, now sees the Promise object. A body of only settled awaits inside
  a loop, in an arrow, function expression or top-level declaration, is now a
  compile error. Both populations are expected to be small; the merge-group
  shards measure them.
