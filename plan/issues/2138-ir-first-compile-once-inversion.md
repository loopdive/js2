---
id: 2138
title: "IR-first compile-once inversion: selector decides before compileDeclarations (flag-gated investigation)"
status: done
completed: 2026-07-02
assignee: ttraenkler/dev-2138f
pipeline_unblocked: 1927
spec: ready
sprint: 69
created: 2026-06-12
updated: 2026-07-21
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: compiler
language_feature: compiler-internals
goal: maintainability
related: [1530, 1916, 1927, 2135, 2856, 2945, 2947, 2972, 2973]
loc-budget-allow:
  - src/codegen/index.ts
origin: "2026-06-12 sprint-62 architecture analysis (pipeline workstream N2)"
---

# #2138 — every IR-claimed function is compiled twice by design

## Problem

Legacy compiles ALL bodies (`src/codegen/index.ts:1174`), then the IR
overlay re-compiles claimed ones and overwrites (`:1308`). Wasted compile
time — and the always-available legacy body is _the mechanism_ that makes
silent fallback possible (#1530's root enabler). "Phase out the fallback"
has no destination until the pipeline can skip legacy for claimed
functions.

## Approach

Behind `JS2WASM_IR_FIRST=1`: run `planIrCompilation` before
`compileDeclarations` and skip legacy bodies for claimed functions whose
whole call-graph closure is claimed. Measure test262 delta + compile-time
delta on a full run. File divergences found.

## Acceptance criteria

- Flag exists; default behavior unchanged (byte-identical output without
  the flag).
- One measured test262 + compile-time run recorded in this issue.
- Divergences filed as issues.

## Notes

Fable-routed investigation — the findings shape #1530/#1916-impl
sequencing for sprints 63+. This is the structural endgame the
STRICT_IR_REASONS ratchet feeds into.

## Implementation Plan

> Spec'd against `origin/main @ 8effc04c0` (2026-06-23) — the commit that
> landed #1927's `runPipeline` (PR #1958). Line numbers below are from that
> commit; **re-`grep` the function names before editing** (`generateModule`,
> `generateMultiModule`, `compileDeclarations`, `compileIrPathFunctions`).

### Root cause (confirmed against current main)

The legacy front-end compiles **every** top-level function body, then the IR
overlay re-compiles the claimed ones and _overwrites the just-emitted legacy
body_. The overwrite is literal:

- `generateModule` (`src/codegen/index.ts:1032`) runs the third pass
  `compileDeclarations(ctx, ast.sourceFile)` (`:1333`) — this emits a full
  Wasm body into `ctx.mod.functions[localIdx]` for **every** function.
- Then, guarded by `if (options?.experimentalIR)` (`:1354`), it runs
  `planIrCompilation` + `compileIrPathFunctions` (`:1494`).
- `compileIrPathFunctions` (`src/ir/integration.ts:108`) lowers each claimed
  function AST→IR→Wasm and at `integration.ts:718` does
  `ctx.mod.functions[localIdx] = { …, body: tcoBody, … }` — **discarding** the
  legacy body that `compileDeclarations` already produced for that slot.

So every IR-claimed function is compiled twice by design: once by legacy
(thrown away), once by IR (kept). That wasted legacy compile is also the
_mechanism_ that makes silent fallback free (#1530's root enabler) — because a
working legacy body always exists, an IR throw can be demoted to a warning with
no destination cost. "Phase out the fallback" has no endgame until the pipeline
can **skip legacy for fully-claimed functions**.

`generateMultiModule` (`src/codegen/index.ts:5305`) compiles all bodies
(`:5448-5451`) and has **no** `experimentalIR` overlay block at all — the multi
path never runs IR. #1927 deliberately routes `experimentalIR` through
`buildCodegenOptions` to `generateMultiModule` as a **no-op consumer** (the
`// generateMultiModule ignores the IR fields today, that is the #2138 seam`
comment at `compiler.ts:594-596`). This issue owns wiring that seam live for
`generateModule` first; multi-module is a follow-on slice.

### What "compile-once inversion" means

Today the order is **compile-all-legacy → overwrite-claimed-with-IR**. The
inversion is **plan-IR-first → compile only the un-claimed via legacy → compile
the claimed via IR once**. Concretely, behind `JS2WASM_IR_FIRST=1`:

1. Run `planIrCompilation` (+ the `overrideMap`/`safeSelection` resolution that
   currently sits _after_ `compileDeclarations`) **before** the body pass.
2. Compute the **fully-claimed closure**: a function is skippable by legacy iff
   it AND its whole call-graph closure are in `safeSelection.funcs` (the
   selector already closes the claim set under local call edges — see
   `select.ts:364` "Step 2: call-graph closure"). A function with any
   legacy-compiled callee must NOT be skipped (its `call $idx` would dangle).
3. Have `compileDeclarations` **skip emitting a body** for skippable functions
   (still pre-allocate the funcIdx/typeIdx slot — see below), then run the IR
   overlay to fill exactly those slots once.
4. Flag OFF ⇒ byte-identical to today (acceptance criterion).

This is investigation-flavored: the first deliverable is the flag + a measured
test262 + compile-time run, NOT a finished retirement of legacy. The slices
below are ordered so the structural risk is isolated and each lands green.

### The load-bearing subtlety — slot pre-allocation vs body emission

`compileDeclarations` does **two** things per function that must be teased
apart: (a) it **pre-allocates** the funcIdx/typeIdx slot and records it in
`ctx.funcMap` (the IR overlay relies on this — `integration.ts:672`
`ctx.funcMap.get(name)` and `:677` `localIdx = funcIdx - ctx.numImportFuncs`
expect the slot to already exist), and (b) it **emits the body** into that slot.
The inversion must keep (a) for every function (so funcIdx assignment and
therefore the whole module's index layout is **identical** flag-on vs flag-off)
and only skip (b) for fully-claimed functions. Emitting an empty placeholder
body (e.g. a single `unreachable`) into the skipped slots is the safe shape:
the IR overlay overwrites it exactly as it overwrites a full legacy body today,
so the `ctx.mod.functions[localIdx] = {…}` patch site needs **no** change.

**Why a placeholder, not "remove the slot":** removing/reordering function slots
would renumber every downstream funcIdx and desync `call $idx` ops, the
late-import shifter, and `declaredFuncRefs` — the exact index-fragility class
#1916 exists to kill. Keep the slot, swap the body. This keeps the inversion a
_body-emission_ change, never an _index-layout_ change. Verify with the
byte-identical gate (flag-off) and an index-stability assertion (flag-on, see
tests).

### Decomposition into independently-landable dev slices

Each slice is a separate PR, green on its own, ordered by risk.

#### Slice 1 — hoist IR planning above `compileDeclarations` (refactor, no behavior change)

- **Scope:** move the `planIrCompilation` + `buildTypeMap` + `buildIrClassShapes`
  - `overrideMap`/`safeSelection` construction block (`index.ts:1355-1493`) so it
    runs **before** `compileDeclarations(ctx, ast.sourceFile)` (`:1333`). The
    actual `compileIrPathFunctions` call (`:1494`) stays AFTER `compileDeclarations`
    (it still needs the final funcIdx/typeIdx that `compileDeclarations` assigns).
    Net effect: the _plan_ (which functions are claimed) is known before the body
    pass; the _overlay_ still runs after. No legacy skipping yet.
- **Files:** `src/codegen/index.ts` only.
- **Risk:** LOW. Pure reordering of a side-effect-light planning block. The one
  hazard: `buildIrClassShapes(ctx, …)` reads `ctx.classSet`/`ctx.structFields`/
  `ctx.funcMap` populated by `collectDeclarations`/class collection — confirm
  those still run before the hoisted block (they do: `collectDeclarations` is at
  `:1320`, well before `compileDeclarations` at `:1333`). Does NOT touch
  value-rep / standalone lanes. **Byte-identical** output expected (flag or no
  flag) — assert via `check:ir-fallbacks` (no demotions) + a corpus byte-diff.
- **Acceptance probe:** `pnpm run check:ir-fallbacks` shows zero delta;
  equivalence suite green. Compile a 2-function recursive-`fib` example and
  diff the `.wat` before/after — must be identical.

#### Slice 2 — the `JS2WASM_IR_FIRST` flag + fully-claimed-closure skip (the keystone)

- **Scope:** add the env flag (read once, e.g.
  `const irFirst = process.env.JS2WASM_IR_FIRST === "1"`). When set AND
  `options.experimentalIR`: compute the `skippable` set = functions whose own
  name AND every local callee (transitively) are in `safeSelection.funcs`
  (reuse the selector's call-graph closure result; do NOT re-derive it — expose
  the closure set from `planIrCompilation` if it isn't already on the
  `IrSelection` return). Thread `skippable` into `compileDeclarations` so it
  emits a placeholder body (`[{ op: "unreachable" }]`) for those functions
  instead of compiling them. The IR overlay then fills exactly those slots (no
  change to `integration.ts:718`).
- **Files:** `src/codegen/index.ts` (flag + skippable computation + thread),
  `src/codegen/declarations.ts` (accept a `skipBodies?: ReadonlySet<string>`
  param on `compileDeclarations`; at the top-level FunctionDeclaration
  body-emission site, emit the placeholder when `skipBodies?.has(name)`),
  possibly `src/ir/select.ts` (export the closure set if not already available).
- **Risk:** **HIGH — this is the structural keystone.** It changes which bodies
  legacy emits. Two specific traps:
  1. **`new.target` coarse gate** (`index.ts:1490`): when `ctx.usesNewTarget`,
     `safeSelection` is cleared to empty AFTER planning. The `skippable` set
     MUST be computed from the SAME post-gate `safeSelection`, never the raw
     selection — otherwise a function gets its legacy body skipped but is then
     NOT IR-compiled, leaving a `unreachable` placeholder live. Compute
     `skippable` strictly downstream of every `safeSelection` mutation.
  2. **post-claim resolve/build fallback** (`index.ts:1445`,
     `integration.ts:726`): a function the selector claimed can still fall back
     to legacy at overrideMap-resolve time or at IR-build time (caught, demoted
     to warning). If legacy already skipped its body, that fallback now lands on
     an `unreachable` placeholder — a hard runtime trap, not a graceful demote.
     **Resolution:** only mark a function `skippable` after it survived
     overrideMap resolution (`overrideMap.has(name)`). Because IR-_build_
     failures are only known _after_ `compileIrPathFunctions` runs (which is
     after `compileDeclarations`), gate the skip conservatively: under
     `JS2WASM_IR_FIRST`, if `compileIrPathFunctions`'s `report.errors` names a
     skipped function, that is now a **hard error** (the placeholder is live).
     This is acceptable for a flag-gated investigation — the flag's job is to
     surface exactly these divergences as filable issues (acceptance criterion
     3). Document it: under the flag, a post-claim IR fallback on a skipped
     function fails the compile loudly instead of silently demoting.
  - **Touches the standalone/value-rep lane only indirectly** (it changes which
    path emits a body, not the bodies themselves) — but because a skipped-then-
    failed function traps, this MUST be validated on the **full `merge_group`
    test262 run**, never a scoped sweep (broad-impact rule, see
    `project_broad_impact_validate_full_ci`). Flag-off path is byte-identical
    and safe; the risk is entirely in the flag-on measurement.
- **Acceptance probe:** (1) flag-OFF: full equivalence + `check:ir-fallbacks`
  zero delta + corpus byte-diff identical (proves default unchanged). (2)
  flag-ON: a small all-IR-claimable program (e.g. recursive numeric `fib` +
  typed caller) compiles, runs correct, and `compileDeclarations` emitted a
  placeholder for the claimed funcs (assert via an instrumentation counter or a
  `.wat` inspection that the body came from IR). (3) flag-ON on a program with a
  partially-claimed closure: the un-claimed function keeps its legacy body
  (assert it is NOT a placeholder).

#### Slice 3 — measurement run + divergence filing (closes the issue's acceptance criteria)

- **Scope:** one full test262 + compile-time run with `JS2WASM_IR_FIRST=1`
  vs the baseline (flag off), recorded in this issue. File every divergence
  (test262 regression OR a skipped-function-trap) as its own issue. This is the
  deliverable that satisfies acceptance criteria 2 and 3.
- **Files:** none (data + issue files). Run via the standard
  `pnpm run test:262` worktree runner with the env flag set; capture the
  compile-time delta from the runner's timing output.
- **Risk:** NONE (measurement only). Heavy CPU — run when the box is idle or in
  CI, not alongside the dev pool.
- **Acceptance probe:** the test262 pass delta + compile-time delta are written
  into a `## Measurement (JS2WASM_IR_FIRST)` section here; each divergence has a
  filed issue id.

#### Slice 4 (follow-on, OPTIONAL this sprint) — extend the seam to `generateMultiModule`

- **Scope:** give `generateMultiModule` the same `experimentalIR` overlay block
  that `generateModule` has (it has none today — `index.ts:5448-5451`). Only
  attempt after Slice 2 proves the single-module inversion. This is the larger
  follow-on and may spill to a later sprint.
- **Files:** `src/codegen/index.ts` (`generateMultiModule`).
- **Risk:** MEDIUM — multi-file call-graph closure spans files; the selector's
  closure must be computed across `multiAst.sourceFiles`. Defer unless Slice 2
  lands early.
- **Acceptance probe:** a 2-file program with an IR-claimable function imported
  across files compiles and runs; full test262 net-zero with the multi IR
  overlay OFF by default.

### Dependency order across the IR cluster

`#1927` (the single pipeline driver) is **already landed** (PR #1958) — it is
the technical prerequisite for everything below and it left the
`generateMultiModule` IR seam as a deliberate no-op for this issue to wire.

- **#2138 (this issue) enables / unblocks:**
  - **#2135 (single IR capability predicate)** — the inversion makes the
    selector's claim decision _load-bearing for correctness_ (a wrong claim now
    traps a skipped function instead of silently demoting). That sharply raises
    the value of unifying `select.ts`'s `isPhase1Expr` with `from-ast.ts`'s
    throw sites so selector and builder cannot disagree. #2138's flag-on traps
    are exactly the `select`↔`from-ast` drift #2135 fixes. **Sequence #2135
    right after #2138 Slice 2** — they are mutually reinforcing; #2138's
    measurement (Slice 3) feeds #2135's acceptance metric.
  - **#1916 (symbolic function references)** — independent in _files_
    (`emit/binary.ts`, `late-imports.ts`) but the inversion's placeholder-slot
    discipline depends on funcIdx layout staying stable; #1916's FuncHandle
    indirection makes that stability structural rather than convention. #1916
    can land before OR after #2138; doing #1916 first _reduces_ #2138's
    index-fragility risk. No file conflict (different files).
- **#2138 needs (soft):** nothing hard-blocking beyond #1927 (landed). It reads
  `planIrCompilation`/`safeSelection` (`select.ts`) and the overlay
  (`integration.ts`) as they are today.
- **#2134 (IR effect model)** and **#1930 (TypeOracle)** are **parallel, not
  dependent** — #2134 governs intra-function instruction scheduling, #1930
  governs the checker→codegen type boundary; neither blocks nor is blocked by
  the compile-once inversion. They can proceed independently once unblocked.

**Recommended cluster order:** #1916 (or in parallel) → **#2138 Slices 1-2** →
#2135 → #2138 Slice 3/4. #2134 and #1930 run in parallel on their own tracks.

### Edge cases to preserve (regression traps)

- **Flag OFF must be byte-identical.** The hoist (Slice 1) and the skip logic
  (Slice 2) both gate on `JS2WASM_IR_FIRST`; with it unset, not one emitted byte
  changes. This is acceptance criterion 1 and the only unconditional guarantee.
- **funcIdx layout invariant.** Slot pre-allocation happens for _every_
  function regardless of skip; only the body differs. Never remove or reorder a
  slot. An index-stability test (compile the same source flag-on vs flag-off and
  assert `ctx.mod.functions.map(f => f.name)` is identical) guards this.
- **`new.target` clears `safeSelection`** — compute `skippable` strictly after
  that clear (Slice 2 trap 1).
- **Post-claim fallback on a skipped function** traps under the flag — this is
  intended _investigation_ behavior (surface divergences), not a silent demote;
  fail loud and file it (Slice 2 trap 2).
- **Class members** go through the `classMember` parity guard
  (`integration.ts:704`) and a separate slot pre-allocation in `class-bodies.ts`
  — Slice 2's `skippable` set should cover **top-level FunctionDeclarations
  only** for the first cut (class-method body-skip is a strictly later
  refinement; leave class methods on the always-legacy-then-overwrite path).
- **TCO parity** — `applyIrTailCalls` (`integration.ts:717`) runs on the IR body
  before the patch; unaffected by the inversion (the patch site is unchanged).

### Test / regression plan

1. **Flag-off byte-identity** (`tests/issue-2138.test.ts`): compile a small
   corpus with the flag unset and diff `.wat` against the pre-change baseline.
   Must be identical (assert the flag-reading branch is dead when the env var is
   absent).
2. **funcIdx layout invariant**: same source, flag-on vs flag-off, assert
   `ctx.mod.functions` name order identical.
3. **Flag-on all-claimed**: recursive numeric `fib` with a typed caller —
   compiles, runs correct, the claimed bodies are IR-emitted (placeholder
   skipped by legacy).
4. **Flag-on partial closure**: a claimed function calling an un-claimable one —
   the un-claimable keeps its legacy body; no trap.
5. **Flag-on post-claim-fallback trap** (negative): a function the selector
   claims but that fails IR build — under the flag, the compile fails loudly
   (asserts the "fail loud, don't trap silently" contract).
6. **Full `merge_group` test262** with the flag OFF must be net-zero (this is a
   refactor when the flag is off); the flag-ON run is Slice 3's measurement, not
   a gate.

### Suggested commit / PR sequence

1. `refactor(#2138): hoist IR planning above compileDeclarations (no behavior change)` — Slice 1
2. `feat(#2138): JS2WASM_IR_FIRST flag — skip legacy bodies for fully-claimed closure` — Slice 2
3. `chore(#2138): record IR-first test262 + compile-time measurement, file divergences` — Slice 3 (data only)
4. (optional) `feat(#2138): extend IR overlay to generateMultiModule` — Slice 4

Slices 1 and 2 are the structural work; keep them separate PRs so the
low-risk hoist lands and de-risks the keystone diff. Slice 2 MUST validate on
the full `merge_group` run, not a scoped sweep.

### Status / blocker note (2026-06-23, architect)

This issue's frontmatter blocker is **#2167 (Fable model disabled)**, NOT
#1927. #1927 (the _technical_ prerequisite) has now **landed** (PR #1958), so
the technical path is clear and this spec is dev-ready. But #2167 is still
`in-progress` (Fable unavailable) and gated this issue on `reasoning_effort:
max`. Per #2167's own resolution policy, this issue stays parked on the Fable
gate for _implementation dispatch_; the spec is written now so it is
ready-to-dispatch the moment #2167 closes. The frontmatter therefore keeps
`status: blocked` / `blocked_by: [2167]` but records `pipeline_unblocked: 1927`
to mark that the technical prerequisite is satisfied.

**2026-07-02 update (dev-2138f): #2167 RESOLVED — Fable re-enabled; this
dispatch is the evidence. `blocked_by` cleared, status → in-progress.**

## Implementation Notes (dev-2138f, Fable, 2026-07-02 — Slices 1+2)

### What landed

Behind `JS2WASM_IR_FIRST=1` (default OFF, requires the default-on
`experimentalIR`):

- `planIrOverlay(ctx, ast)` (`src/codegen/index.ts`) — the IR planning block
  extracted **verbatim** from the `experimentalIR` overlay (typeMap →
  `planIrCompilation` → STRICT_IR_REASONS → `buildIrClassShapes` →
  overrideMap → safeSelection → `new.target` gate). Flag OFF it runs at the
  exact pre-#2138 position (after `compileDeclarations`); flag ON it runs
  BEFORE, and `computeIrFirstSkipSet` derives the legacy-skip set.
- `compileDeclarations(ctx, sourceFile, skipBodies?)`
  (`src/codegen/declarations.ts`) — skipped top-level functions get an
  `unreachable` placeholder body (slot/typeIdx untouched — body-emission
  change, never index-layout) and are NOT registered inlinable. Returns the
  actually-skipped names.
- `IrSelection.localCallees` (`src/ir/select.ts`, additive) — the Step-2
  call-graph callee edges, exposed so the skip-set derivation reuses the
  selector's own edges instead of re-deriving them.
- Fail-loud contract: a post-claim IR failure on a _skipped_ function is
  promoted from the warning demote to a **hard compile error**
  (`[IR-FIRST skipped-slot, #2138]`), plus a backstop that errors when a
  skipped function is neither in `report.compiled` nor `report.errors`.
  The placeholder can never ship silently.
- Telemetry: `CompileResult.irFirstSkipped` (present only when the flag is
  on) lists skipped bodies — the compile-once win is directly observable.

### Deliberate deviations from the spec above (and WHY)

1. **The Slice-1 hoist is flag-CONDITIONAL, not unconditional.** The spec
   assumed the planning block was side-effect-light and the hoist
   byte-identical. Code analysis refutes that premise:
   - `resolvePositionType` calls `getOrRegisterVecType` /
     `typedArrayVecStorage` — planning can FIRST-register Wasm types, so
     hoisting it above the body pass can permute type-section index
     assignment (different bytes flag-off);
   - `buildIrClassShapes` reads `ctx.structFields`, which body compilation
     mutates (dynamic field additions, #516) — a hoisted read sees
     pre-body-compile shapes.
     Making the ORDER conditional on the flag turns acceptance criterion 1
     (byte-identical without the flag) into a property that holds by
     construction. Slices 1+2 therefore landed as ONE PR: with no
     unconditional reorder there is no standalone "low-risk hoist" left to
     de-risk separately.
2. **Skip-set closure check is DIRECT-callee, not transitive.** The
   selector's Step-2 closure is already bidirectional (callers AND callees),
   so `selection.funcs` is closed; the only re-opening is overrideMap
   resolve-time drops. A function's own IR build consults only its DIRECT
   callees' signatures (`calleeTypes`; `from-ast.ts` `lowerCall` throws on a
   missing callee), and only the function's own IR success is load-bearing
   for its slot — callees keep working bodies (legacy or IR) in their
   pre-allocated slots either way. Transitivity would add conservatism
   without adding safety; the compiled-set backstop catches everything else.
3. **Generators are excluded from the skip set** (first cut). Legacy
   generator compilation creates auxiliary machinery beyond the slot body;
   IR generator lowering registers its own imports (`addGeneratorImports`)
   but full standalone-ness without the legacy compile's side effects is
   unproven. They stay on compile-twice until measured separately.
4. **Class members are never skipped** (per spec — typeIdx parity contract
   with legacy callers, `integration.ts` parity guard).

### Verification (acceptance criterion 1 — flag-off byte-identity)

233-file corpus (13 `website/playground/examples` + 220 test262 files
sampled across `language/expressions`, `language/statements`,
`built-ins/Array`, `built-ins/String`): compiled flag-OFF on this branch and
on the merge-base compiler (76a92eec923f0) — **SHA-256 identical for all 233**
(188 binaries, 45 error-text hashes). `tests/issue-2138.test.ts` adds:
flag-off default-unchanged, flag-on all-claimed skip+run, partial-closure
legacy preservation, funcIdx-layout invariance (flag-on vs flag-off), the
hard-error trap contract, and flag-off determinism.

### Divergence found (acceptance criterion 3)

- **`%` (modulo) selector↔builder drift** — `select.ts` claims a function
  containing `a % b`; `from-ast.ts` throws `operator '%' not in slice 11`.
  Flag-off: silent legacy demote (post-claim `build` error, warning). Flag-on:
  hard error — surfaced exactly as designed. This is the #2135 drift class;
  filed as **#2945** (`plan/issues/2945-ir-selector-claims-modulo-from-ast-throws.md`).
- Corpus sweep (233 files, flag-on): **0 new compile failures** vs flag-off —
  the corpus' claimed closures all IR-compile. (The corpus is JS-heavy /
  untyped, so the claim rate — and thus skip exposure — is low: 8 skipped
  bodies across 4 files. The playground examples supply nearly all skips.)

## Measurement (JS2WASM_IR_FIRST) — scoped, 2026-07-02 (dev-2138f)

Scoped local measurement per the flag-gated first deliverable; the FULL
test262 + compile-time run is the remaining Slice-3 item (see procedure
below).

- **Correctness delta (scoped)**: 233-file corpus (13 playground examples +
  220 sampled test262 files), flag-ON vs flag-OFF: **0 new compile
  failures**, all executed probes behave identically (fib/partial-closure
  programs return identical results; see `tests/issue-2138.test.ts`).
- **Compile-once effect**: 8 legacy body compiles skipped across the corpus
  (4 files with claims); on claim-dense inputs (e.g. the `fib` probe) 100%
  of claimed top-level functions skip legacy compilation. Directly
  observable via `CompileResult.irFirstSkipped`.
- **Compile-time delta**: NOT reliably measurable this session — the shared
  dev box ran at load ≈ 12–14 on 8 cores; alternating fresh-process runs of
  the 13-example corpus varied ±45% between repeats of the SAME mode
  (12.4s→28.8s flag-off), swamping the per-claimed-function saving. The
  structural saving is exactly one legacy body compilation per skipped
  function. Record a real number in Slice 3 (idle box / CI).
- **Divergences**: one, filed — #2945 (`%` selector↔builder drift).
- **What the FULL run needs (Slice 3)**: `JS2WASM_IR_FIRST=1 pnpm run
test:262` on an idle box or CI, diffed against the current baseline JSONL
  (`scripts/fetch-baseline-jsonl.mjs`) via `/analyze-regression`; compile
  time from the runner's per-run timing in `runs/index.json`. Every
  flag-ON-only failure is by construction a loud selector↔builder/skip
  divergence — bucket by error class, file per class.

## Measurement (JS2WASM_IR_FIRST) — FULL RUN, 2026-07-02 (dev-2138f) — Slice 3, closes the issue

Run: `test262-sharded.yml` workflow_dispatch **28580162377** with
`ir_first: true` (the #2947 lane) on `main@89676d232513` — full 57×2-shard
matrix, `JS2WASM_IR_FIRST: 1` verified in every shard's env, fresh compiles
(no result cache), promote-baseline hard-skipped by design. Diffed
per-test against the honest baseline
(`loopdive/js2wasm-baselines` JSONL, refreshed same day from unflagged main)
via `scripts/diff-test262.ts`.

### (a) test262 delta — js-host lane, 48,088 shared tests (official + proposals)

| status          | baseline (flag OFF) | flagged (IR-first ON) | delta             |
| --------------- | ------------------- | --------------------- | ----------------- |
| pass            | 34,781              | 34,766                | **−15 (−0.031%)** |
| fail            | 12,534              | 12,537                | +3                |
| compile_error   | 576                 | 591                   | +15               |
| compile_timeout | 83                  | 80                    | −3                |

15 regressions, 0 improvements, **0 wasm-identical noise, 0 ct-flakes** —
all 15 are real compiler-output differences, and they collapse into exactly
TWO root causes (attributed, filed):

- **#2972 (14 tests, `pass → compile_error`)** — ONE harness function
  (`decimalToPercentHexString`): selector claims string element access with
  a computed (BinaryExpression) index, from-ast throws `not in slice 12` →
  skipped slot → hard error. **Fail-loud contract working as designed**;
  the fix is #2135 family-2/3 capability work.
- **#2973 (1 test, `pass → fail`, silent)** — `S12.4_A2_T2`: the eval shim's
  in-process sub-compile (`runtime-eval.ts:213` wraps eval strings in a
  claimable `__eval_result` FunctionDeclaration) inherits the env flag, its
  post-claim residual hard-errors, and the shim's `catch` swallows it →
  `undefined` instead of `7`. **The only fail-loud violation found** —
  eval/`new Function` sub-compiles must opt out of the flag (#2973, S).

Additionally, the pre-flip `%` class (#2945) never appears — retired by
#2135 slice 1 before this run, confirming the capability-table mechanism.

### (b) compile-time delta — honestly: not measurable across runs

The diff tool reports **−1.8%** aggregate compile time vs the baseline the
run itself fetched at 09:39 (8,510,718 → 8,356,264 ms over 47,882 shared
tests), and **−27.1%** vs the 11:26-refreshed baseline (11,459,923 ms
baseline side). Those two baseline timing sets describe the SAME unflagged
code and differ by +35% — cross-run CI wall-clock is runner-lottery-
dominated, so neither delta is attributable to the inversion. Verdict:
**no measurable wall-clock change beyond noise** (expected: the structural
saving is one legacy body compile per claimed function, small vs total
front-end cost). A rigorous number needs a same-runner A/B (two dispatches
on the same SHA back-to-back, flag off/on); not worth runner-minutes unless
the inversion becomes default-on policy.

### (c) skipped-body telemetry

Not surfaced per-test by the runner (`CompileResult.irFirstSkipped` is not
recorded into the JSONL rows). Local corpus evidence stands (8 bodies / 13
playground examples; 100% of claimed funcs on claim-dense inputs). Optional
runner extension if a future run wants the aggregate; not needed for the
conclusion.

### Verdict (what this buys #1530/#1916/#2855 sequencing)

The compile-once inversion is **viable**: 99.97% of the js-host suite is
indifferent to skipping legacy bodies for claimed closures; the fail-loud
contract held for 14/15 divergences; the single silent path is an eval-shim
artifact with a one-file fix (#2973); and the flag surfaced exactly the
selector↔builder drift classes #2135 is retiring (one already fixed before
this run, one filed as #2972). Remaining before any default-on discussion:
#2973, #2972, the claim-partial ratchet (#2135 families), and the
generator/class-member skip exclusions. Slice 4 (generateMultiModule seam)
remains open as a follow-on under #2135-family planning.

**Acceptance criteria: all met** — (1) flag + byte-identical default
(proven), (2) full measured test262 + compile-time run recorded here,
(3) divergences filed (#2945, #2972, #2973). → `status: done`.

### Merge reconciliation (dev-2138f, 2026-07-02) — Slice 3 vs gate 4 ordering

The gate-4 notes below (sr-irfirst, landed 2fbdd928) were written in
parallel with the Slice-3 run above. Ordering facts: the measurement ran on
`main@89676d232513`, which does NOT include gate 4 — but per the gate-4
calibration note itself the exclusion is **latent today** (the selector
rejects host receivers wholesale until #2856 lands), so the −15/48,088
result is not affected and the measurement stands. The "Slice 3 plan
(after this lands)" below is therefore **superseded** by the executed run,
EXCEPT its claim-rate ask, which remains open as a runner extension:
`CompileResult.irFirstSkipped` is not recorded into the test262 JSONL, so
the per-run % -of-top-level-functions-skipped stat (the #2949 north-star)
needs a small runner change before it can be measured at suite scale —
re-measure AFTER #2856's host arms land, when gate 4 becomes load-bearing.

## Implementation Notes (sr-irfirst, 2026-07-02 — Trap 4 / gate 4)

**Branch:** `issue-2138-trap4-host-node-skip` (based on upstream/main @
c4ff5a241). Adds the host-node skip exclusion the #2856 extern-in-IR spec
requires ("#2138's skippable-closure computation must exclude any function
whose claim depends on a host node until the lowering is proven" —
lead-confirmed plan, mirrored here per the spec's cross-ref request):

- `src/codegen/ir-first-gate.ts` (NEW) — `irFirstBodyReadsHostNode` +
  `collectModuleTopLevelNames`, pure checker-free AST scan. Own module so
  tests import it without the codegen-entry init cycle (importing
  `codegen/index.js` directly from a test hits a `boolToStringEmitter`
  before-initialization ReferenceError via string-ops/regexp-standalone).
- `src/codegen/index.ts` — `computeIrFirstSkipSet(plan, sourceFile)` gains
  gate 4 (`irFirstBodyReadsHostNode` exclusion) + doc; call site passes
  `ast.sourceFile`.
- `tests/issue-2138.test.ts` — gate-4 unit tests (host property/method/
  element/bare-call positives; Math-whitelist / local / module-binding /
  extern-`new`-chain / nested-scope negatives) + one integration guard
  (FIB skip set unchanged — no over-exclusion collateral).

**Calibration rationale (do not tighten):** the scan allowlists exactly
today's selector ambient accepts — root `Math` (#1371 whitelist) and opaque
`NewExpression` roots (slice-10 extern classes) — so it cannot depress the
#2949 skip rate. It is latent today (selector rejects host receivers
wholesale); it becomes load-bearing when #2856's HostMemberGet/HostMethodCall
arm lands.

**Validation (this branch):** `tsc --noEmit` clean; `tests/issue-2138.test.ts`
14/14 green (6 landed + 8 gate-4); `check:ir-fallbacks` zero delta (the
checker runs flag-off, where gate 4 is unreachable — flag-off behavior is
untouched by construction since `computeIrFirstSkipSet` only runs under
`JS2WASM_IR_FIRST=1`).

**Also in this PR:** `scripts/byte-diff-corpus.mts` — the reusable
byte-identity harness (compiles a fixed corpus — example files default+wasi
plus a stride-N test262 sample — with two compiler checkouts and SHA-diffs
every binary; usage header in the file). Used to prove the superseded
unconditional hoist byte-identical (2,692 compiles, 0 diff) and intended for
Slice 3 / future IR-first ratchet validation.

**Slice 3 plan (after this lands):** flag-on `pnpm run test:262` vs flag-off
baseline via `/analyze-regression` + compile-time delta from
`runs/index.json`, AND (lead request) the **IR claim-rate stat**: % of
top-level functions skipped under the flag at test262 scale — sum
`CompileResult.irFirstSkipped` over the run vs total top-level
FunctionDeclarations; this is the #2949 north-star number, record
before/after pairs. Run AFTER Trap-4 lands so measurements are clean.

**Superseded branch:** `issue-2138-ir-first-slice1` (origin) — my
unconditional-hoist Slice 1, superseded by the landed flag-conditional
implementation (6ac915824). Safe to delete; its issue-file docs were ported.

## Measurement addendum (sr-irfirst, 2026-07-02) — the claim-rate stat, measured

Closes the one item the merge-reconciliation note above left open ("the
claim-rate ask … remains open as a runner extension"): measured at sample
scale WITHOUT a runner change, via `scripts/ir-first-sweep.mts` (committed
with this addendum — compiles each corpus file twice, flag off/on, in one
process, and reads `CompileResult.irFirstSkipped` directly).

**Corpus:** all example files + stride-20 test262 sample = 2,671 files,
compiled on `main@bcea34ed1` (INCLUDES gate 4, unlike the full CI run above —
gate 4 is latent, so results are comparable). Raw JSON:
`.tmp/slice3-sweep-backup.json` on the measurement branch; regenerate with
`STRIDE=20 npx tsx scripts/ir-first-sweep.mts <checkout> <out.json>`.

- **Claim/skip rate: 14 / 437 = 3.2%** of top-level FunctionDeclarations in
  flag-off-compiling files (497 in all files). Low as expected — raw test262
  is untyped sloppy-mode JS, so the TypeMap resolves few signatures. On the
  TYPED corpus the rate is what matters: `benchmarks.ts` skips 4/4 of its
  benchable functions (fib, bench_fib, bench_loop, bench_string).
- **Compile-time: the compile-once dividend is real and visible exactly
  where claims are dense** — same-process A/B (not cross-run CI lottery):
  `benchmarks.ts` 4,977 → 2,499 ms (**−50%**), `fib.ts` 863 → 660 ms
  (**−24%**). Aggregate over all 2,671 files: −1.2% (dominated by unclaimed
  files; consistent with the full run's "no measurable aggregate change"
  verdict).
- **Divergences: ZERO in both directions** (2,258 flag-off-ok files all
  flag-on-ok; no reverse flips). Consistent with the full run's finding that
  the #2945 class is retired; the #2972 harness-function class does not
  appear because this sweep compiles raw files without the test262 harness
  prelude (the full run remains the authority on harness-exposed
  divergences). Nothing new to file.
- **Re-measure trigger:** after #2856's host arms land (gate 4 becomes
  load-bearing) — rerun the sweep; the skip set should stay trap-free while
  the claim rate rises. The suite-scale per-run stat still needs the small
  runner extension (`irFirstSkipped` into the JSONL rows) if wanted.

## Slice 4 M0 — bounded multi-module overlay (2026-07-21)

`generateMultiModule` now runs the WasmGC IR overlay after **all** source
files have emitted their legacy bodies and after `finalizeMethodTrampolines`.
This is deliberately compile-twice only: M0 never supplies a body-skip set,
never patches the graph's shared `__module_init`, and keeps class members on
legacy. Each source is planned without `resolveModuleBinding`, so imported
calls remain selector-external until the cross-module call capability lands.

The flat-name safety boundary is explicit. Cross-file top-level function-name
collisions and their selected local call components stay legacy-owned. The M0
copy of the selection also excludes functions that reference import bindings,
nested/generic bodies whose synthesized names are not graph-unique, and the
remaining cross-file caller ABI hazards, including checker-resolved global
script references with no import syntax (all cross-file targets in
standalone/WASI, callable-parameter or callable-result targets in host mode).
The IR integration report is consumed through the same diagnostic path as
single-source codegen;
`irCompiledFuncs` aggregates genuine emission across source files and every
post-claim failure still reaches `irPostClaimErrors` plus the established
fallback diagnostic.

Measured by `tests/issue-2138-multi-module-ir-overlay.test.ts`:

- `compileMulti` genuinely IR-emits one pure numeric function in the dependency
  (`depPure`) and one in the entry (`entryPure`), while a renamed imported
  caller, module-binding reader, module-init callee, and `<module-init>` remain
  absent from `irCompiledFuncs`.
- IR-on and `experimentalIR: false` both produce runtime values
  `[9, 15, 42]`; the `42` is initialized by the preserved legacy module-init
  body. `irFirstSkipped` remains absent on both multi paths.
- A two-module flat-name collision keeps both colliding declarations and their
  local callers on legacy while unrelated leaves in both files still IR-emit.
- Standalone keeps the cross-file imported target on legacy (caller-side ABI
  closure) while an independent entry function still genuinely IR-emits; the
  same `[9, 15, 42]` runtime values hold.
- Checker-resolved global-script calls follow the same closure: host targets
  with callable parameters/results stay legacy and preserve runtime parity,
  while a scalar target may IR-emit only in host mode; standalone keeps every
  cross-file target on legacy.
- A top-level function that constructs and reads a local class can IR-emit with
  runtime parity while the constructor and method slots remain legacy-owned.
- The same anti-vacuity/import-boundary assertions pass through `compileFiles`
  and `compileProject`.
- All focused probes report **zero post-claim demotions**. Rebasing M0 after
  the builtins component preserves its banked floor: the repository fallback
  ratchet reports exact zero delta (`body-shape-rejected` 12→12,
  module-level 2→2, post-claim none) via `pnpm run check:ir-fallbacks`.
