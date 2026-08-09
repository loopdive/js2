# Issue Dependency Graph

Issues organized by dependency order -- work items at the top are ready now,
items below unlock when their dependencies complete. No sprint batching needed:
pick any "ready" item and start.

## TOP PRIORITY — IR-only default and direct-front-end retirement (stakeholder directive, 2026-07-21)

Tracking epic **#3518** remains `in-progress`. R0a **#3529** and R0b **#3519**
completed on 2026-07-21; **#3520 is ready** as the next executable R1 slice.
R2–R8 remain blocked on that dependency spine. The compiler is still
default-on hybrid: class/module/M0/linear ownership is incomplete, and 59,676
frontend-only fn-lines remain reachable.

```text
#3143 (done) ──> #3529 R0a (done) ──> #3519 R0b (done)
                                             |
                                             v
                              #3520 R1 identity/ABI (ready)
                                             |
                                             v
                              #3521 R2 Prepared program (blocked)

#3521 ──> #3522 R3 ──> #3523 R4
#3520 + #3521 + #3522 + #3523 ──> #3525 R5 whole program
#3521 ──> #3526 R6 runtime contract
#3522 + #3525 + #3526 ──> #3527 R7 async plan
#3525 + #3526 + #3527 ──> #3528 R8 shared linear
#3522 + #3523 + #3525 + #3526 + #3527 + #3528 ──> R9 fail-closed
R9 ──> R10 #3090 deletion
```

| Issue / slice | Priority | Status      | Dependency / decision                                                                                    |
| ------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| #3518         | critical | in-progress | Tracking epic; R0 complete, retirement continues                                                         |
| #3529 / R0a   | critical | **done**    | 1,608 passing / 35 failing; 36 known baseline, one known case now passes, zero new regressions           |
| #3519 / R0b   | critical | **done**    | Hybrid 5/5, 37 terminal, 31 IR, 6 Unsupported, 0 Invariants, 37 legacy; strict intentionally remains red |
| #3520 / R1    | critical | **ready**   | Next executable slice: source-qualified `IrUnitId` and whole-program `ProgramAbiMap`                     |
| #3521 / R2    | critical | blocked     | Depends on #3520; Prepared free-function compile-once ownership                                          |
| #3522 / R3    | critical | blocked     | Depends on #3521; exhaustive classes, members, closures, support units                                   |
| #3523 / R4    | critical | blocked     | Depends on #3521/#3522; ordered module-init and startup ownership                                        |
| #3525 / R5    | critical | blocked     | Depends on #3520–#3523; whole-program single/multi Prepared ownership                                    |
| #3526 / R6    | critical | blocked     | Depends on #3521; frozen typed semantic runtime contract                                                 |
| #3527 / R7    | critical | blocked     | Depends on #3522/#3525/#3526; AST-free async plans and canonical ABI                                     |
| #3528 / R8    | critical | blocked     | Depends on #3525–#3527; linear consumes the exact shared program                                         |
| #3517         | high     | in-progress | Measured module `Map` residual; closes a corpus count, not R4                                            |
| R9            | critical | blocked     | Requires R3–R8; removes hybrid and all escape hatches                                                    |
| #3090 / R10   | high     | blocked     | Requires R9 plus a refreshed reachability audit                                                          |

#2855 is **done** as the narrow function-corpus ratchet. #2950 is **done** as a
historical default-flip milestone; neither owns the remaining retirement.

## PROTECTED PARALLEL PRIORITY — close the standalone-vs-js-host test262 gap (directive 2026-06-30)

Umbrella **#2860**. The honest metric (#2879 via #2360) re-based the gap to
**~20,500 host-free tests** (js-host ~34,052 vs host-free standalone ~12,883).
This remains a protected correctness lane and final IR-retirement acceptance
gate. New pulls prioritize #3518's dependency spine; available non-overlapping
capacity may continue this ordered queue:

**Carriers (the biggest lever — architecture-scale, ~2,476 combined).** Share a
common Wasm-native suspendable **frame substrate** (arch-frame spec in
#2860/#2864). Sequence: **frame substrate → #2864 → #2867 → #2865**.

| Issue | Cluster                             | Est. | Priority | Horizon | Status / dep                       |
| ----- | ----------------------------------- | ---- | -------- | ------- | ---------------------------------- |
| #2860 | umbrella / arch-frame spec          | —    | high     | xl      | ready                              |
| #2864 | sync generator carrier              | 697  | high     | xl      | ready — first carrier on the frame |
| #2867 | Promise / microtask carrier         | 375  | high     | l       | ready — microtask scheduler        |
| #2865 | async-generator / for-await carrier | 986  | high     | xl      | ready — `depends_on: [2864, 2867]` |
| #2866 | Symbol carrier                      | 418  | high     | l       | ready — independent track          |

**Substrate + de-masked real-failure clusters (parallel track).**

| Issue | Cluster                                             | Est. | Priority | Horizon | Status                       |
| ----- | --------------------------------------------------- | ---- | -------- | ------- | ---------------------------- |
| #2861 | built-in static/proto value-read glue               | ~882 | high     | l       | ready — start now            |
| #2863 | dynamic-shape `__get_builtin` read codegen          | 365  | high     | m       | ready                        |
| #2878 | invalid-Wasm residual (`__str_flatten`/body shapes) | —    | high     | m       | ready                        |
| #2872 | TypedArray.prototype.\* cluster                     | 294  | high     | m       | ready (de-masked from #2862) |
| #2873 | language/expressions cluster                        | 276  | high     | m       | ready (de-masked from #2862) |
| #2875 | String.prototype.\* cluster                         | 159  | high     | m       | ready (de-masked from #2862) |
| #2876 | RegExp cluster                                      | 125  | high     | m       | ready (de-masked from #2862) |
| #2877 | exception message readability (triage enabler)      | —    | medium   | s       | ready                        |

**Done / blocked children:** #2868 (invalid-Wasm, via #2350) · #2874
(getOwnPropertyDescriptor key coercion, via #2354) · #2879 (honest metric, via
#2360) all **done**. #2862 (ToPrimitive built-in exotics) **blocked** —
superseded; the de-masked clusters carry the tractable residual.

**Demoted to `priority: low`** (kept `sprint: current` as tail-filler): acorn
remnants **#2850/#2853** and ES/spec umbrellas **#2669** (ES2015
destructuring), **#2803** (callsite param-type inference), **#1042** (async
state-machine epic). In-progress non-standalone work is left at its current
priority (already claimed — not competing for the next pull).

## Current-origin/main PO audit findings (2026-07-17) - ready, not current-sprint focus

These are verified untracked gaps from the July 17 audit. They do **not**
displace the #3518 dependency spine or the protected #2860 lane, but remain
high-leverage backlog candidates because each removes a planning or correctness
risk that can otherwise misdirect larger implementation work.

| Issue | Area                          | Priority | Horizon | Status  | Dependency note                                                                                                                              |
| ----- | ----------------------------- | -------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| #3336 | planning / IR / linear memory | high     | s       | ready   | No code deps. Must be done before dispatching target-neutral `LinearMemoryPlan` work as Porffor-only work. Related: #3288/#3298/#3300/#2956. |
| #3337 | WASI argv correctness         | high     | m       | ready   | No hard deps. Validity now passes, but argv is an empty import-free vector; #1482 is the env precedent and #1532 is tests-only.              |
| #3338 | CLI artifact validation       | high     | s       | ready   | No code deps. Protects users from every malformed-Wasm producer while #3024 and related emitter issues fix individual families.              |
| #3339 | Axios project nontermination  | high     | l       | backlog | Architect spec required: identify the unbounded resolver/lowering/emitter phase before dispatch; parent #1032, survey #1571.                 |
| #3340 | Root baseline classification  | high     | s       | ready   | No hard deps. Ratchets stale #2143 and WASI expected-pass IDs; coordinates with #3337 but does not implement argv.                           |

## Historical IR fallback-corpus ratchet (#2855, completed 2026-07-21)

The bucket gate remains a useful regression ratchet, but its retirement role is
closed and transferred to #3518. Corpus zero is neither a strictness rule nor a
compile-once/deletion gate.

| Issue | Bucket                      | Count | Priority | Horizon | Status                                                                        |
| ----- | --------------------------- | ----- | -------- | ------- | ----------------------------------------------------------------------------- |
| #2855 | function-corpus epic        | —     | high     | xl      | **done** — narrow ratchet milestone; superseded by #3518 for retirement       |
| #2856 | `body-shape-rejected`       | 0     | high     | l       | **done** — playground function corpus zero; generic reason remains non-strict |
| #2857 | `class-method`              | 0     | low      | m       | **done** — measured corpus residual retired                                   |
| #2858 | `call-graph-closure`        | 0     | low      | m       | **done** — measured corpus residual retired                                   |
| #2859 | `param-type-not-resolvable` | 0     | low      | s       | **done** — measured corpus residual retired                                   |

The final R0 lane records six typed Unsupported units: `async-function` (2),
`call-graph-closure` (1), `body-shape` (1), and static class members (2).
These explicit strict blockers do not change the structural facts that class
members and module init compile twice and M0/linear remain incomplete.

## Sprint 65 landings (2026-06-23 session — value-rep substrate spine)

> **Sprint 65 CLOSED 2026-06-24** (user-approved): 58 done, 34 carried to s66
> (reassigned `sprint: 65 → 66`) + #2637 pulled from backlog. The parent epics
> below now carry on s66 — see [`plan/issues/sprints/66.md`](../issues/sprints/66.md).

This session's merged architecture slices (all 0-regr vs the `merge_group`
standalone floor #2097 + per-process test262 floor). These advance — but do
not close — their parent epics; the parent issues stay carried.

| PR                      | Issue / parent epic                | What landed                                                                                               |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| #1975                   | #2580 M3 Stage A (value-rep)       | standalone inline-literal `[[Prototype]]` link — `Object.create({...}).foo` resolves                      |
| #1977                   | #2623 → Promise epic (#1042/#2614) | class-extends-Promise value-read identity unified w/ capability ctor (+1 row)                             |
| #1981                   | #2623-A → async epic (#1042)       | single-box nested capture of an already-boxed var (`alreadyBoxed`); fixes `illegal cast in Constructor()` |
| #1984                   | #2618 Slice 1 → Proxy epic (#1355) | Proxy START-timing bridge + callable-target wrap; apply/construct 14→15 (+1)                              |
| #1986 _(open, BLOCKED)_ | #2580 M3 B-pre                     | re-resolve `__is_truthy` funcidx after callback compile (some/every/filter invalid-Wasm)                  |

Docs/staging this session: #1973 (M3-A spec mis-attributed → DEFER), #1976/#1979
(M3 Stage B scoping + cluster-composition re-ground), #1974 (#2618/#2623-C Slice
C → CONFIRM DEFER, #56-zone). The corrected M3 sequence is **accessor cluster
(`Object.defineProperty`, 181/266 files) first → functor `.prototype=` lap
(51 files, escape-analysis-gated, #1888-eject risk) last** — not a row-count lap.

## Sprint 57 — acorn dogfood + backend-agnostic IR (added 2026-05-29)

Architectural sprint. Two tracks; conformance guard is zero-regression.

**Track 1 — self-hosting-dogfood** (compile + run acorn correctly):

| #    | Title                                                                | Priority | Feasibility | Status                                    | Depends on   |
| ---- | -------------------------------------------------------------------- | -------- | ----------- | ----------------------------------------- | ------------ |
| 1710 | acorn dogfood harness (compile + validate + diff-AST vs node-acorn)  | high     | medium      | Done (s57)                                | —            |
| 1711 | triage harness surface → file sized child issues                     | high     | medium      | Done (s57)                                | #1710        |
| 1712 | acceptance: compiled acorn AST == node-acorn on a representative .js | high     | hard        | Carried to sprint 58 (unblocked by #1745) | #1710, #1711 |

Prior acorn blockers #1679 / #1690 / #1690b are **done** (regression-guarded by #1710).

**Track 2 — backend-agnostic-ir** (decouple IR from WasmGC):

| #    | Title                                                             | Priority | Feasibility | Status                                 | Depends on            |
| ---- | ----------------------------------------------------------------- | -------- | ----------- | -------------------------------------- | --------------------- |
| 1713 | BackendEmitter trait: audit WasmGC bias + seam + WasmGcEmitter    | high     | hard        | Ready — **needs architect spec first** | —                     |
| 1714 | lower one IR node kind to BOTH WasmGC + linear via the trait      | high     | hard        | Backlog→ready after #1713              | #1713 (**arch spec**) |
| 1715 | minimal bytecode emitter + dispatch loop for an IR subset (proof) | medium   | hard        | Backlog→ready after #1713              | #1713 (**arch spec**) |

Feeds #1584 (in-Wasm bytecode interpreter) — gated on both tracks + #1712.

## Sprint 50 Extension (added 2026-05-07)

Pulled into S50 alongside the original closure/dispatch cohort. Direct-dispatch items have no architect dependency; spec items wait on architect.

| #    | Title                                                            | Priority | Feasibility | Status    | Type                                         |
| ---- | ---------------------------------------------------------------- | -------- | ----------- | --------- | -------------------------------------------- |
| 1267 | Optimizer drops side-effectful method calls in stmt position     | high     | medium      | Sprint 50 | Direct dispatch                              |
| 859  | Map.forEach callback captures are immutable snapshots            | high     | medium      | Sprint 50 | Direct dispatch                              |
| 1268 | obj[key] ??= value returns NaN on index-signature types          | medium   | medium      | Sprint 50 | Direct dispatch                              |
| 1020 | await-using TDZ tests null_deref crash in assert_throwsAsync     | medium   | medium      | Sprint 50 | Direct dispatch                              |
| 1155 | test262 worker classifies WebAssembly.Exception as compile_error | medium   | easy        | Sprint 50 | Direct dispatch (quick win)                  |
| 837  | Map/WeakMap upsert getOrInsert/getOrInsertComputed               | low      | easy        | Sprint 50 | Direct dispatch (stretch)                    |
| 1239 | Object literals with get/set accessors → JS host object          | medium   | hard        | Sprint 50 | **Needs architect spec**                     |
| 1158 | destructureParamArray fallback eagerly consumes iterators        | medium   | hard        | Sprint 50 | **Needs architect spec (bundle with #1159)** |
| 1159 | Nested empty array pattern with initializer iterator semantics   | medium   | hard        | Sprint 50 | **Needs architect spec (bundle with #1158)** |

## Legend

- **Ready** -- no blockers, can start immediately
- **Blocked by #N** -- requires #N to be done first
- **Coordinates with #N** -- touches same code, should not run in parallel
- File icons show which codegen file is primarily touched:
  `[E]` = expressions.ts, `[S]` = statements.ts, `[I]` = index.ts, `[T]` = test262-runner.ts

## Destructuring-lane sweep follow-ups (added 2026-05-24)

From the dev-1553b destructuring-lane verification sweep. #1659 (CI equivalence
coverage) gates #1658 in the sense that #1658 is only CI-visible once #1659 lands.

| #    | Title                                                                               | Priority | Feasibility | Status                                     |
| ---- | ----------------------------------------------------------------------------------- | -------- | ----------- | ------------------------------------------ |
| 1659 | CI does not run tests/equivalence/ (OOM) — equivalence regressions land silently    | high     | medium      | **Ready** (gates CI-visibility of #1658)   |
| 1658 | Destructured/scalar function-parameter default not applied (returns 30, expects 40) | high     | medium      | **Ready** (depends on #1659 for CI gating) |

## Sprint 55 — docs (added 2026-05-25)

| #    | Title                                                                                                       | Priority | Feasibility | Status                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1661 | README programmatic-API example fails — `instantiate(binary, {})` vs default-mode host imports (guest #601) | high     | easy        | **Ready** (sprint 55, docs, plan-only)                                                                                   |
| 1667 | DX: `compile()` returns a ready-to-pass import object for default/JS-host mode (guest #601)                 | medium   | medium      | **Ready** (Backlog, feature). Complements #1661 — adds the JS-host convenience; standalone stays the recommended default |

## WASI Native Messaging — AssemblyScript-reference alignment (added 2026-05-24)

Compiler gaps blocking full convergence of `examples/native-messaging/host.ts`
(#1530) on the AssemblyScript reference `nm_assemblyscript.ts`.

**Direction (2026-05-24):** host capabilities are exposed as **standard Node.js
APIs** (`process.stdin` / `process.stdout`), never bespoke builtins. The
example is being rewritten onto `process.stdin.read()` (#1653) + already-shipped
`process.stdout.write()` (#1651), with `Buffer`/`DataView` framing.

| #        | Title                                                                                   | Priority | Feasibility | Status                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1654     | DataView/ArrayBuffer-backed TypedArrays emit an invalid wasm module under --target wasi | high     | medium      | **Ready** (root)                                                                                                       |
| 1653     | process.stdin.read(buffer, offset?) — binary incremental stdin read (keystone)          | high     | hard        | Blocked by #1654                                                                                                       |
| 1655     | process.stdout.write(ArrayBuffer) — accept ArrayBuffer arg, not only Uint8Array literal | medium   | easy        | Blocked by #1654                                                                                                       |
| 1530     | Native Messaging host example — Node-style rewrite (no bespoke builtins)                | medium   | medium      | **Reopened** (`in-progress`); Blocked by #1653 + #1654                                                                 |
| ~~1628~~ | ~~raw-byte stdout builtin `writeStdout(bytes)`~~                                        | —        | —           | **wont-fix** — superseded by `process.stdout.write` (#1651), the standard Node API; bespoke builtin is the wrong shape |

```
#1651 (process.stdout.write) -- DONE (standard Node write API; supersedes #1628/#1617)
#1654 (ArrayBuffer/DataView valid standalone) -- root, unblocks both
  ├── #1653 (binary stdin read, process.stdin.read) -- keystone
  │     └── #1530 (Native Messaging example, Node-style rewrite) -- also needs #1654 directly
  └── #1655 (stdout write ArrayBuffer)

#1530 depends on #1653 + #1654.
#1628 (a.k.a. "#1617" in the #1530 history) -> wont-fix (superseded by #1651).
```

## Governance / legal — CLA gate (added 2026-05-24)

Gates merges of **external** PRs (including guest271314's PR #589, which is
attached to #1530). The current `cla-check` workflow is a no-op placeholder that
records no acceptance, so external contributions land with no auditable CLA
sign-off.

| #    | Title                                                                 | Priority | Feasibility | Status                                                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1660 | Replace placeholder cla-check with a real CLA signature/approval gate | high     | medium      | **Done** — self-hosted in-repo signature gate (`.github/cla/`); internal/bot authors exempt, external humans sign by comment. Promotion to a _required_ check deferred to an admin (see issue follow-up). |

```
#1660 (real CLA gate) -- DONE: gates external-PR merges once promoted to required
  └── PR #589 (guest271314, attached to #1530) -- HOLD until guest's CLA acceptance is recorded
```

## Sprint 55 — repo structure / website (added 2026-05-24)

| #    | Title                                                                           | Priority | Feasibility | Status                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1656 | Consolidate all website/frontend files under website/                           | medium   | medium      | **Ready — specced** (`## Implementation Plan` in issue file). Dev-claimable; one PR. NOTE: site config is `playground/vite.config.ts` (NOT root `vite.config.ts` = library build); wide `..`→repo-root fan-out in playground plugins + scripts. `deploy-pages.yml` edit needs CODEOWNERS review. Related: #1583, #1590 |
| 1657 | Skip merge_group test262 shards for non-src changes (keep required check green) | medium   | medium      | **In review** — `changes` job + conservative path detector gates the merge_group shard matrix; "merge shard reports" always green. Related: #1656                                                                                                                                                                      |

---

## TOP PRIORITY: Highest-impact runtime failures `[E][S][I]`

These are the biggest bang-for-buck issues. Pick from here first.

```
#822 (Wasm type mismatch CE -- 907 CE) -- BLOCKED (needs architect, repair-pass approach failed)
~~#826 (illegal cast -- 1,294 FAIL) -- DONE (0 illegal_cast remaining, 255 tests fixed)~~
~~#851 (iterator close protocol -- 147 FAIL) -- DONE (sync paths fixed, break/throw/continue call return())~~
~~#839 (return_call stack/type mismatch -- 158 CE) -- DONE~~
```

### Done (sprint-30)

~~#852~~ ~~#846~~ ~~#848~~ ~~#847~~ ~~#827~~ ~~#825~~ ~~#860~~ ~~#857~~ ~~#850~~ ~~#824~~

| #           | Title                                                 | Impact            | Status                                                                 |
| ----------- | ----------------------------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| **822**     | Wasm type mismatch compile errors                     | **907 CE**        | **Blocked** — needs architect (repair passes caused +6K CE regression) |
| ~~**826**~~ | ~~Illegal cast failures (sub of #820)~~               | ~~**~489 FAIL**~~ | **Done** (0 illegal_cast, 255 tests fixed)                             |
| ~~**851**~~ | ~~Iterator close protocol~~                           | ~~**~100 FAIL**~~ | **Done** (sync fixed, break/throw/continue call return())              |
| ~~**839**~~ | ~~return_call stack/type mismatch in constructors~~   | ~~**158 CE**~~    | **Done**                                                               |
| ~~**854**~~ | ~~Iterator protocol: null next/return/throw methods~~ | ~~**126 FAIL**~~  | **Done** (sub-issue 4: 32/64 iterable tests fixed)                     |
| ~~**862**~~ | ~~Empty error message failures~~                      | ~~**212 FAIL**~~  | **Done** (generator throw deferral)                                    |
| **865**     | Console wrapper for fd_write in JS environments       | —                 | **Ready** (MEDIUM)                                                     |
| ~~**866**~~ | ~~Regression: NaN sentinel + ToPrimitive (71 tests)~~ | ~~**71 FAIL**~~   | **Done**                                                               |

---

## Umbrella issues (analysis/tracking -- sub-issues above are the actionable work)

| #   | Title                                     | Impact      | Notes                                                  |
| --- | ----------------------------------------- | ----------- | ------------------------------------------------------ |
| 820 | TypeError / null dereference failures     | 6,077 FAIL  | Sub-issues: #825, #826, #852, #854                     |
| 779 | Assert failures: wrong values             | 10,099 FAIL | Sub-issues: #846, #847, #848, #849, #850, #1116, #1117 |
| 786 | Multi-assertion failures (returned N > 2) | 2,142 FAIL  | In-progress                                            |
| 696 | Classify "other fail" runtime errors      | 4,649 FAIL  | Analysis                                               |

---

## Cluster A: Compiler Correctness -- CE reduction `[E][S][I]`

All independent -- can run in parallel (different codegen paths).

| #       | Title                                                   | Impact         | Ready?                                    |
| ------- | ------------------------------------------------------- | -------------- | ----------------------------------------- |
| 822     | Wasm type mismatch compile errors                       | **907 CE**     | **Ready**                                 |
| ~~839~~ | ~~return_call stack args / type mismatch~~              | ~~**158 CE**~~ | **Done**                                  |
| ~~828~~ | ~~Unexpected undefined AST node in compileExpression~~  | ~~**149 CE**~~ | **Done** (already fixed by prior changes) |
| 829     | Unsupported assignment target compile errors            | **141 CE**     | **Ready**                                 |
| 845     | Misc CE: object literals, RegExp-on-X, for-in/of edges  | **340 CE**     | **Ready**                                 |
| 844     | Unsupported new expression for built-in classes         | **85 CE**      | **Ready**                                 |
| 840     | Array concat/push/splice 0-arg support                  | **31 CE**      | **Ready**                                 |
| 835     | Unknown extern class: Error types                       | **32 CE**      | **Ready**                                 |
| 836     | Tagged templates with non-PropertyAccess tags           | **20 CE**      | **Ready**                                 |
| 843     | super keyword in object literals and edge cases         | **20 CE**      | **Ready**                                 |
| 842     | new Array() with non-literal/spread args                | **14 CE**      | **Ready**                                 |
| 831     | Negative test gaps: expected SyntaxError but compiled   | **242 FAIL**   | **Ready**                                 |
| 927     | Missing early/parse error detection (umbrella for #831) | **840 FAIL**   | **Ready**                                 |
| 926     | Fixture tests not supported in unified mode             | **172 CE**     | **Ready**                                 |
| 764     | Immutable global assignment error                       | **240 CE**     | **Ready**                                 |
| 736     | SyntaxError detection at compile time                   | 316 FAIL       | **Ready**                                 |

---

## Cluster B: Runtime Semantics -- Wrong values `[E][S]`

```
#849 (mapped arguments) -- independent
#1116 (promise/async errors) -- DONE (s55, merged PR #436)
#1117 (wrong error type) -- coordinates with #846
#1118 (worker/timeout/eval null deref) -- independent
#853 (opaque Wasm objects) -- independent
#737 (undefined edge cases) -- independent
#821 (BindingElement null guard) -- independent
```

| #       | Title                                                 | Impact           | Ready?     |
| ------- | ----------------------------------------------------- | ---------------- | ---------- |
| ~~849~~ | ~~Mapped arguments object sync with named params~~    | ~~**200 FAIL**~~ | **Done**   |
| 855     | Promise resolution and async error handling           | **210 FAIL**     | **Ready**  |
| 856     | Expected TypeError but got wrong error type           | **136 FAIL**     | **Ready**  |
| 858     | Worker/timeout exits and eval-code null deref         | **182 FAIL**     | **Ready**  |
| 853     | WebAssembly objects are opaque (for-in/Object.create) | **58 FAIL**      | **Ready**  |
| 737     | Undefined-handling edge cases                         | 276 FAIL         | **Ready**  |
| 778     | Illegal cast errors (ref.cast wrong type)             | 135 FAIL         | **Ready**  |
| 821     | BindingElement null guard over-triggering             | 537 FAIL         | **Review** |
| 928     | Unknown failure tests with empty error message        | **209 FAIL**     | **Ready**  |
| 929     | Object.defineProperty called on non-object            | **53 FAIL**      | **Ready**  |
| 930     | Not-a-constructor detection for built-in methods      | **68 FAIL**      | **Ready**  |

---

## Cluster C: Built-in Methods `[E]`

| #   | Title                                                   | Impact    | Ready?                       |
| --- | ------------------------------------------------------- | --------- | ---------------------------- |
| 733 | RangeError validation in built-ins                      | 442 FAIL  | **Ready** (coordinates #846) |
| 763 | RegExp runtime method gaps                              | ~400 FAIL | **Ready**                    |
| 739 | Object.defineProperty correctness                       | 262 FAIL  | **Ready**                    |
| 841 | Unsupported Math methods (sumPrecise, cosh, sinh, tanh) | **19 CE** | **Ready**                    |

---

## Cluster D: Iterator / Generator / Async `[E][S]`

```
#766 (Symbol.iterator for custom iterables)
  ├── #851 (iterator close protocol)
  └── #854 (null next/return/throw)

#680 (pure Wasm generators) ──► #762 (generator .next() args, blocked)
#681 (pure Wasm iterators) -- independent

#735 (async iteration) -- blocked by generator work
```

| #   | Title                                             | Impact                     | Ready?          |
| --- | ------------------------------------------------- | -------------------------- | --------------- |
| 766 | Symbol.iterator protocol for custom iterables     | ~500 FAIL                  | **Ready**       |
| 851 | Iterator close protocol not implemented           | **147 FAIL**               | **Ready**       |
| 854 | Iterator protocol: null next/return/throw methods | **126 FAIL**               | **Ready**       |
| 680 | Pure Wasm generators (state machines)             | Eliminates 10 host imports | **Ready**       |
| 681 | Pure Wasm iterators (struct-based)                | Eliminates 5 host imports  | **Ready**       |
| 762 | Generator .next() argument handling               | ~50 FAIL                   | Blocked by #680 |
| 735 | Async iteration correctness                       | 329 FAIL                   | Blocked         |

---

## Cluster E: Property Model / Prototype Chain `[E][I]`

| #    | Title                                                                                                                              | Impact         | Ready?               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------- |
| 797  | Property descriptor subsystem (Phase 3 remaining)                                                                                  | ~5,000 FAIL    | **Ready** (CRITICAL) |
| 799  | Prototype chain (remaining: #802 for dynamic)                                                                                      | ~2,500 FAIL    | **Ready** (CRITICAL) |
| 802  | Dynamic prototype support (conditional **proto**)                                                                                  | property-model | **Ready**            |
| 678  | Dynamic prototype chain (reverted)                                                                                                 | 625 FAIL       | **Ready**            |
| 2126 | computed-key object construction: runtime key dropped, key side-effect skipped (#1971 residual of #140)                            | property-model | **Ready**            |
| 2127 | object spread of accessor source drops property (getter never fires) (#1971 residual of #492/#1112)                                | property-model | **Ready**            |
| 2128 | object-literal `set` accessor not invoked on assignment (#1971 residual of #1239)                                                  | property-model | **Ready**            |
| 2129 | duplicate object-literal keys: first-wins instead of last-wins (#1971)                                                             | property-model | **Ready**            |
| 2130 | `delete`/`in` resolved against static struct shape — post-delete/dynamic-key/rest wrong (#1971 residual of #1821; mirror of #1991) | property-model | **Ready** (hard)     |
| 2131 | JS-host enumeration ignores integer-keys-ascending (#1971 residual of #1837 standalone-only fix)                                   | property-model | **Ready**            |
| 2132 | method call on null receiver = uncatchable trap, not catchable TypeError (#1971 residual of #785)                                  | core-semantics | **Ready**            |

---

## Cluster F: Class Features `[E][S]`

| #   | Title                                          | Impact         | Ready?                       |
| --- | ---------------------------------------------- | -------------- | ---------------------------- |
| 848 | Class computed property / accessor correctness | **1,015 FAIL** | **Ready**                    |
| 793 | Infinite compilation loop on private methods   | 5 hang         | **Ready** (coordinates #848) |
| 334 | Private class fields and methods               | --             | **Ready**                    |
| 377 | Getter/setter accessor edge cases              | --             | **Ready**                    |
| 329 | Object.setPrototypeOf support                  | --             | **Ready**                    |

---

## Cluster G: Destructuring / Assignment `[E]`

```
#852 (destructuring params -- 1,525 FAIL) -- TOP PRIORITY
#847 (for-of destructuring -- 660 FAIL)
#761 (rest/spread dropped -- ~200 FAIL)
```

| #       | Title                                               | Impact             | Ready?                                                |
| ------- | --------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| ~~852~~ | ~~Destructuring params: null_deref + illegal_cast~~ | ~~**1,525 FAIL**~~ | **Done** (arrow-function/dstr +34, type mutation fix) |
| 847     | for-await-of / for-of destructuring wrong values    | **660 FAIL**       | **Ready**                                             |
| 761     | Rest/spread silently dropped in destructuring       | ~200 FAIL          | **Ready**                                             |
| 142     | Assignment destructuring failures                   | --                 | **Ready**                                             |
| 328     | OmittedExpression (array holes/elision)             | --                 | **Ready**                                             |
| 379     | Tuple/destructuring type errors                     | --                 | **Ready**                                             |
| 404     | Compound assignment on unresolvable property type   | 88 CE              | **Ready**                                             |

---

## Cluster N: Codegen Performance (WAT pattern elimination) `[E][S]`

Discovered via `scripts/analyze-wat-patterns.ts` (#948) — corpus of 3,619 modules.
All independent, can run in parallel.

| #   | Title                                                              | Impact    | Ready?           |
| --- | ------------------------------------------------------------------ | --------- | ---------------- |
| 954 | Eliminate duplicate locals (57% modules, 3,366 extra locals)       | Size/perf | **Ready**        |
| 955 | Eliminate redundant ref.test + ref.cast pairs (35.7%, 8,642 cases) | Size/perf | **Ready**        |
| 956 | Emit i32.const directly vs f64.const + trunc (8.8%, 673 cases)     | Size/perf | **Ready** (easy) |
| 957 | Eliminate local.set + drop dead-store pattern (4.8%, 272 cases)    | Size/perf | **Ready** (easy) |
| 958 | Batch string concat chains into multi-arg call (4.8%, 531 chains)  | GC allocs | **Ready** (hard) |

### String-hash warm-perf levers (carved from #1746 umbrella, 2026-05-31)

Native differential (PR #997) found the string **build** loop, not the hash loop, is
~99% of warm wall time (the i32 hash path #1746 lever #1 is DONE and already ~3.8×
faster/char than V8). The two remaining levers are now sized, dispatchable issues:

| #    | Title                                                                                           | Impact                        | Ready?                                   | Deps                                 |
| ---- | ----------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------- | ------------------------------------ |
| 1761 | Presize string-build buffer from static loop trip count (kill reallocs + per-append cap-check)  | Warm perf — top AOT win       | **Ready** (medium)                       | — (related #1746, #1580, #1744)      |
| 1762 | Linear-memory string backing for build/hash hot path — drop the WasmGC `(array i16)` GC barrier | Warm perf — strategic ceiling | **Ready, likely needs arch spec** (hard) | — (related #1746, #679, #682, #1714) |

#1746 stays the umbrella tracking issue.

---

## Cluster H: Type Inference / Performance `[E][I]`

```
#743 (whole-program type mapper) ──► #744 (monomorphize specialized copies)
#773 (monomorphize with call-site types) -- independent
#745 (tagged union types) -- independent
#684 (any-typed variable inference) -- independent
#685 (interprocedural return type) -- independent
```

| #       | Title                                       | Impact             | Ready?                  |
| ------- | ------------------------------------------- | ------------------ | ----------------------- |
| 743     | Whole-program type mapper                   | High pass impact   | **Ready** (critical)    |
| 773     | Monomorphize functions with call-site types | High pass impact   | **Ready** (critical)    |
| 745     | Tagged union types for WasmGC               | Type precision     | **Ready**               |
| 684     | Any-typed variable inference from usage     | Many CE            | **Ready**               |
| 685     | Interprocedural return type flow            | Perf + correctness | **Ready**               |
| 686     | Closure capture type preservation           | Perf               | **Ready**               |
| 744     | Monomorphize: specialized function copies   | Perf               | Blocked by #743         |
| 746     | Hidden class optimization                   | Perf               | Blocked                 |
| ~~747~~ | ~~Escape analysis / stack allocation~~      | Perf               | **DONE** (s55, PR #545) |

---

## Cluster I: Proposals and Standards `[E]`

All independent -- low priority, can be picked up opportunistically.

| #    | Title                                                                | Impact      | Ready?        |
| ---- | -------------------------------------------------------------------- | ----------- | ------------- |
| 661  | Temporal API via polyfill                                            | 1,128 tests | **Ready**     |
| 674  | SharedArrayBuffer / Atomics                                          | 493 tests   | **Ready**     |
| 834  | ES2025 Set methods (union, intersection, etc.)                       | 216 skip    | **Ready**     |
| 837  | Map/WeakMap upsert (getOrInsert/getOrInsertComputed)                 | ~110 skip   | **Sprint 50** |
| 838  | BigInt64Array / BigUint64Array typed arrays                          | 19 skip     | **Ready**     |
| 830  | DisposableStack extern class missing                                 | **38 CE**   | **Ready**     |
| 1036 | DisposableStack/AsyncDisposableStack property-chain → Wasm null trap | **94 FAIL** | **Ready**     |
| 1037 | Symbol.dispose / Symbol.asyncDispose not accessible                  | **30 FAIL** | **Ready**     |
| 1038 | Function.prototype.bind not implemented                              | **70 FAIL** | **Ready**     |
| 675  | Dynamic import()                                                     | 471 tests   | **Ready**     |

---

## Cluster J: Test Infrastructure `[T]`

| #   | Title                                                  | Impact       | Ready?          |
| --- | ------------------------------------------------------ | ------------ | --------------- |
| 824 | Compilation timeouts (10s limit)                       | **548 CE**   | **Ready**       |
| 687 | Live-streaming report with run selector                | Developer UX | **Ready**       |
| 699 | Shared compiler pool for test262                       | Perf         | **Ready**       |
| 700 | Reuse ts.CompilerHost across compilations              | 25% speedup  | Blocked by #699 |
| 832 | Upgrade to TypeScript 6.x for Unicode 16.0 identifiers | 82 skip      | **Ready**       |
| 833 | Consider sloppy mode support for legacy octal escapes  | 16 skip      | **Ready** (low) |

---

## Cluster K: Architecture / Refactoring `[E][S][I]`

### Compiler hardening (from external review, 2026-04-12)

All independent — can run in parallel.

| #        | Title                                                                  | Impact                    | Ready?            |
| -------- | ---------------------------------------------------------------------- | ------------------------- | ----------------- |
| 1094     | Shrink runtime.ts host boundary — compile-away JS semantics            | Standalone/WASI readiness | **Ready** (H)     |
| 1095     | Eliminate `as unknown as Instr` casts (273 sites)                      | IR type safety            | **Ready** (L)     |
| 1096     | Isolate env adapters — remove top-level await from core                | Embedding/determinism     | **Ready** (S)     |
| ~~1097~~ | ~~Remove stale import-helper generator in output.ts~~                  | Dead code                 | **Done** ✓ PR#142 |
| 1098     | Audit and reduce patch-layer accumulation in codegen (155 workarounds) | Code quality              | **Ready** (M)     |

### Standalone execution & Wasm-native APIs

```
#1094 (shrink runtime.ts) ──→ #1099 (standalone demo on Wasmtime, zero JS host)
#1035 (WASI hello-fs) -- DONE (sprint 45)
#680 (pure Wasm generators) -- enables broader standalone coverage
#681 (pure Wasm iterators) -- enables broader standalone coverage
#682 (RegExp standalone) ──→ #1105 Tier 2 string methods (match, replace, search)
#1101 (WeakRef) ──→ #1103 WeakMap/WeakSet (strong-ref fallback available without #1101)
#1666 (invalid-wasm cluster) ──→ #1664 (residual object/extern leaks), #1665 (native generators)
#1662 (audit) -- empirical --target wasi host-import map; spawned #1663–#1666
```

| #    | Title                                                                           | Impact                       | Ready?                                 |
| ---- | ------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------- |
| 1662 | Audit: standalone (--target wasi) host-import leaks per construct               | Standalone gap map           | **Done** (audit record)                |
| 1666 | Bug: --target wasi emits invalid wasm (class/closure/number→string/typed-array) | Standalone correctness       | **Ready** (H)                          |
| 1663 | Pure-Wasm parseInt / parseFloat / Number(string)                                | Standalone numerics          | **Ready** (M, #1471 closed without it) |
| 1664 | Residual **extern\_/**register*/**iterator/**array* leaks after #1472           | Standalone objects/iterators | **Ready** (H, after #1666)             |
| 1665 | Wasm-native generators (retire **gen\_/**create_generator)                      | Standalone generators        | **Ready** (H, after #1666)             |
| 1099 | Standalone execution demo — FizzBuzz on Wasmtime, zero JS                       | Production credibility       | **Ready** (H, depends on #1094)        |
| 1103 | Wasm-native Map, Set, WeakMap, WeakSet                                          | Standalone collections       | **Ready** (H)                          |
| 1105 | Wasm-native String methods on i16 arrays                                        | Standalone string ops        | **Ready** (H)                          |
| 1104 | Wasm-native Error construction                                                  | Standalone errors            | **Ready** (M)                          |
| 1100 | Wasm-native Proxy meta-object protocol                                          | Standalone Proxy             | **Ready** (H)                          |
| 1102 | ~~Wasm-native eval (AOT compilation)~~                                          | Standalone eval              | **Done** (PR #3113)                    |
| 1101 | Wasm-native WeakRef / FinalizationRegistry                                      | Standalone weak refs         | **Ready** (H)                          |

### Module extraction sub-tasks of #688. All independent, can run in parallel.

| #   | Title                                              | Ready?               |
| --- | -------------------------------------------------- | -------------------- |
| 803 | Extract call dispatch -> calls.ts                  | **Ready**            |
| 804 | Extract new expressions -> new-expression.ts       | **Ready**            |
| 805 | Extract assignment/destructuring -> assignments.ts | **Ready**            |
| 806 | Extract increment/decrement -> unary-update.ts     | **Ready**            |
| 807 | Extract Date/Math/console -> builtins.ts           | **Ready**            |
| 808 | Extract string/import infra -> imports.ts          | **Ready**            |
| 809 | Extract native string helpers -> native-strings.ts | **Ready**            |
| 810 | Extract class compilation -> class-codegen.ts      | **Ready**            |
| 811 | Extract fixup passes -> fixups.ts                  | **Ready**            |
| 741 | Extract string/any helpers from index.ts           | **Ready**            |
| 788 | Modularize src/ into focused subfolder structure   | **Ready**            |
| 638 | Reverse typeIdxToStructName map                    | **Ready**            |
| 652 | Compile-time ARC / static lifetime analysis        | **Ready** (research) |
| 682 | RegExp Wasm engine for standalone mode             | **Ready**            |

---

## Cluster L: Platform Support

| #   | Title                                        | Ready?    |
| --- | -------------------------------------------- | --------- |
| 639 | Full Component Model adapter (canonical ABI) | **Ready** |
| 640 | WASI HTTP handler                            | **Ready** |
| 644 | Integrate report into playground             | **Ready** |
| 641 | Shopify Functions template                   | **Ready** |
| 642 | Deno/Cloudflare loader plugins               | **Ready** |

---

## Cluster M: Symbol / Well-known `[E]`

```
#481 (Symbol.iterator) ──┬──► #482 (Symbol.toPrimitive)
                         ├──► #484 (Symbol.species)
                         ├──► #485 (Symbol RegExp protocol)
                         ├──► #486 (Symbol.toStringTag/hasInstance)
                         └──┬─► #487 (user Symbol as property key)
                            |
#483 (Symbol() narrow filter) ──┘
```

| #   | Title                              | Ready?                |
| --- | ---------------------------------- | --------------------- |
| 481 | Symbol.iterator                    | **Ready** (critical)  |
| 483 | Symbol() constructor narrow filter | **Ready**             |
| 482 | Symbol.toPrimitive                 | Blocked by #481       |
| 484 | Symbol.species                     | Blocked by #481       |
| 485 | Symbol RegExp protocol             | Blocked by #481       |
| 486 | Symbol.toStringTag/hasInstance     | Blocked by #481       |
| 487 | User Symbol as property key        | Blocked by #481, #483 |

---

## Older clusters with remaining active items

### Generators / Yield `[S][E]`

| #   | Title                                                   | Tests   | Ready?                |
| --- | ------------------------------------------------------- | ------- | --------------------- |
| 287 | Generator function compile errors -- yield in loops/try | ~119 CE | **Ready**             |
| 288 | Try/catch/finally compile errors -- complex patterns    | ~40 CE  | Coordinates with #287 |

### Property / Element access `[E]`

| #   | Title                                             | Ready?    |
| --- | ------------------------------------------------- | --------- |
| 239 | Element access on struct types (bracket notation) | **Ready** |
| 274 | Property access on function type (.name, .length) | **Ready** |

### Scope / Identifiers `[I][S]`

| #   | Title                                         | Ready?    |
| --- | --------------------------------------------- | --------- |
| 146 | Unknown identifier / scope issues             | **Ready** |
| 266 | Unknown identifier -- multi-variable patterns | **Ready** |
| 380 | Unknown variable/function in test scope       | **Ready** |

### Loops / Iteration `[S]`

| #   | Title                                       | Ready?     |
| --- | ------------------------------------------- | ---------- |
| 353 | For-of with generators and custom iterators | **Review** |

### Wasm validation `[E][I]`

| #   | Title                                                         | Tests   | Ready?    |
| --- | ------------------------------------------------------------- | ------- | --------- |
| 401 | Wasm validation errors (call args, struct.new, type mismatch) | 3672 CE | **Ready** |
| 405 | Internal compiler errors -- undefined properties              | 64 CE   | **Ready** |
| 406 | 'base' is possibly null errors                                | 81 CE   | **Ready** |

### Functions / Closures `[E]`

| #   | Title                                             | Ready?    |
| --- | ------------------------------------------------- | --------- |
| 356 | Closure-as-value in assert and array-like objects | **Ready** |
| 368 | Global/arrow `this` reference                     | **Ready** |
| 382 | Spread argument in super/function calls           | **Ready** |

### Built-ins / Runtime `[E]`

| #   | Title                                | Ready?    |
| --- | ------------------------------------ | --------- |
| 359 | Object.freeze/seal/preventExtensions | **Ready** |
| 369 | globalThis support                   | **Ready** |
| 385 | Array method argument count errors   | **Ready** |

### Modules / Imports `[I]`

| #   | Title                                  | Ready?    |
| --- | -------------------------------------- | --------- |
| 332 | Export declaration at top level errors | **Ready** |
| 333 | Dynamic import modifier syntax errors  | **Ready** |

---

## Backlog (long-term / blocked)

| #   | Title                                       | Blocked by              |
| --- | ------------------------------------------- | ----------------------- |
| 130 | Shape inference Phase 4 -- hashmap fallback | large scope             |
| 149 | Unsupported call expression patterns        | #232 is Phase 1         |
| 153 | Iterator protocol for destructuring         | #268                    |
| 173 | Computed property names in classes          | Ready (#242, #265 done) |
| 79  | Gradual typing -- boxed `any`               | large scope             |
| 339 | Async function and await support            | large scope             |
| 340 | Error throwing and try/catch/finally        | large scope             |
| 343 | Prototype chain support                     | large scope             |
| 351 | Async iteration (for-await-of)              | depends on #339         |
| 376 | Decorator syntax support                    | low priority            |

---

## Quick reference: File contention

When picking parallel work items, avoid pairing issues that touch the same
function in the same file.

| Function                         | Issues                                 |
| -------------------------------- | -------------------------------------- |
| `compileCallExpression`          | 382, 409, 489, 827, 857                |
| `compileNewExpression`           | 344, 412, 432, 842, 844                |
| `compileDestructuringAssignment` | 142, 328, 379, 420, 761, 847, 852      |
| `compileAssignment` (compound)   | 404, 424, 426, 829                     |
| `coerceType`                     | 411, 431, 444, 448, 822, 839           |
| class codegen                    | 329, 334, 377, 427, 793, 843, 848      |
| null guard emission              | 789, 820, 825, 852                     |
| ref.cast / type narrowing        | 778, 826                               |
| loop codegen                     | 353, 417, 436, 847, 851                |
| built-in runtime                 | 359, 369, 385, 421, 733, 840, 841, 846 |
| generator codegen                | 287, 288, 415, 422, 439, 680           |
| iterator protocol                | 481, 766, 851, 854                     |
| scope resolution                 | 146, 266, 380, 429, 443                |
| template literals                | 836                                    |
| module/import handling           | 332, 333, 440                          |
| return_call / tail call          | 839                                    |
| AST node handling                | 828, 845                               |
| promise / async                  | 735, 855                               |
| arguments object                 | 849                                    |
| property descriptor              | 739, 797, 856                          |
| prototype chain                  | 678, 799, 802                          |
| Array methods                    | 827, 840, 857                          |
| diagnostic suppression           | 381, 831                               |

## 2026-06-12 — Sprint 62 (Fable architecture sprint) dependency spine

See `plan/issues/sprints/62.md` for the full graph. Key edges:
A1(#1917 amendment) → #1917 Step0 → Steps 1-3 → symptom closures;
#2072/#2080 → #2104 → #2105/#2106 → #2107; #2142 → #2051/#2106 dispatch;
#2009 → #1989(eqref); A2(#1916+#1899) → #1899 impl → #1983; #1923 → #1922
→ #1924+#2134 → #1804 → STRICT ratchet flips; #1921 → #1927; #1917 Step0 →
#2140; #2139 → #1854 → #2144(63); #2141 spec → 63 impl.

## 2026-06-25 — Sprint-66 ES3/ES5/ES6 edition-gap clusters (PO grooming)

Edition-gap issues with their sub-dependencies (umbrella → concrete slices):

- **≤ES3 (top priority, base language)**
  - #2666 member-ref `base[prop]` eval order (compound-assign + ++/--) — standalone.
  - #2667 mapped-arguments non-config/delete — residual of #1511 (done).
- **ES5 (largest: descriptor fidelity)**
  - #2668 Object.defineProperty/defineProperties fidelity — residual of #1460/#1462/#929 (done); JSON reviver (#2671) sequences AFTER this.
- **ES2015 (largest clusters)**
  - #2669 destructuring umbrella → slices #1642 (IteratorClose), #2566 (generator over-consume), #1556 (param struct mismatch). Prior: #1454/#2203/#2032/#796/#2587 (done).
  - #2670 Array.prototype generic-receiver/holes/length → coordinates with #2580 (length on dynamic receiver, in-progress). Residual of #2177/#2151/#473 (done).
  - #2671 Date/RegExp/Promise/JSON/super tracker → reopen-or-child #1343/#1440 (Date), #1444/#1439 (RegExp), #1465/#1368 (Promise), #1551 (super eval order). JSON deps #2668.

Edges: #2668 → #2671(JSON); #2580 ↔ #2670(length); #1642+#2566+#1556 ⊂ #2669.
Deprioritized (eval/dynamic-code): #1066 #1240 #1263-#1266 — not scheduled. (#1102 done 2026-07-16, PR #3113.)

## 2026-07-12 — #2860 standalone-gap method-family slices (PO grooming)

Nine fresh, independently-claimable slices of umbrella #2860 (lane-baseline
remeasure 2026-07-12: honest gap 12,801). All `sprint: current`,
`priority: high`, `feasibility: hard`, `umbrella: 2860`:

- **#3169** Array.prototype callback HOFs over array-like receivers (519, L) —
  mechanism-twin of host-lane #2670 (in-progress, test sets disjoint).
- **#3170** Array indexOf/lastIndexOf/includes as-value + array-likes (125, M)
  — value-read side; sequences with #3169's receiver ladder.
- **#3171** Map/Set/WeakMap/WeakSet receiver brand-check protocol (~142, M).
- **#3172** Set-algebra set-like protocol + getOrInsert(Computed) (120, M) —
  shares #3171's brand gate.
- ~~**#3173** DataView get*/set* spec semantics (230, L)~~ — DONE (217/230
  flipped; 7 residual rows blocked on the #3179 any-array index-read family).
- **#3174** Date brand + ToPrimitive coercion order (107, M) — slices #2671.
- **#3175** Number.prototype toString(radix)/toFixed/valueOf (74, M).
- **#3176** JSON parse/stringify residual (67, M) — slices #2671; array-holder
  reviver arm extends #3046.
- **#3177** TypedArrayConstructors internals + ctor protocols (356, L) — the
  #3027-recommended "~350" slice; MUST NOT touch #2872's TypedArray/prototype
  arms without owner sync.

Edges: #3169 → #3170 (receiver ladder before/alongside value-read);
#3171 → #3172, #3174 (shared brand-preamble helper); #2992 (in-progress)
owns the defineProperty/create descriptor cluster — deliberately not sliced.

## 2026-07-12 — #3178 host async-machinery retirement family (architect)

Umbrella **#3178** (sprint: current, XL): the 4,467-leaky-pass generator/
async/Promise host-import family — the largest standalone lever (~10.3 pts).
Native substrate exists (microtask ring / $Promise / #2906 N-state machine);
the family is admission-coverage slices:

- **S1 = #3164** sync gen fn-expressions (~1,741 leaky, plan ready, fable-now)
- **S2 = #3132** async-gen methods/yield\*/return (~2,408, in-progress)
- **S3** capturing generators → ref-cell capture slots (NEW child at staffing;
  opus-design; coordinate #3032)
- **S4** for-await-of dstr legacy async lowering (90; NEW child; overlaps #2602)
- **S5/S6 = #2903** R1–R4 (non-inline executor, extends-Promise, lazy Iterator
  helpers, TypedArray callbacks — all fable-now, re-grounded 2026-07-12)
- **S7** `__get_caught_exception` zero-assert (mechanical, last)

**#2040** re-grounded + restaffable (`ready`, sprint: current): slices 1–4
(lazy defaults 198 / obj-rest ToPrimitive 190 / abrupt step-err 115 / gen
brand-check 48) fable-now; A1 rest-identity (382) stays BLOCKED on
#2580 M2/#3032/#3053 — do not re-attempt the tag-5 classifier. **#2723**
(RegExp linear) plan confirmed adequate; stays Backlog below the async family.

Edges: #3164 → #3178-S3 (same admission seam); #3132 ∥ #3164 ∥ #2903-R;
#2040 slices ⊥ all of the above; #3178-S7 after S1+S2.

## Umbrella decompositions filed 2026-07-12 (claimable slices)

Three filed umbrellas decomposed into individually-lockable slices so multiple
devs can work them in parallel without colliding.

**#3182 bloat-elimination epic** (tracking umbrella stays open):

- #3191 S1 — unify 4 JS-error-throw templates on `buildThrowJsErrorInstrs` [M, high]
- #3192 S2 — DataView+RegExp brand → `receiver-brand.ts` [M, high, `depends_on: 3191`]
- #3193 S3 — delete 5 shape-path `Array.prototype.*.call` clones [M, medium — array-methods.ts hot]
- #3194 S4 — extract shared super-dispatch core (new-super.ts) [S, high]
- #3195 S5 — one parameterized closure-iterable drainer (runtime.ts) [S, high]
- #3196 S6 — de-inline standalone dynamic-HOF onto #3098 steppers [L, medium — array-methods.ts hot]
- Edges: #3191 → #3192 (stacked); #3193 ∥ #3196 claim serially (both array-methods.ts).

**#3184 async-vacuous cluster** (tracking umbrella stays open):

- #3197 — for-await-of / async-dstr drive (383 vacuous) [M, high]
- #3198 — Promise-combinator vacuous callbacks (218) [M, medium — overlaps blocked #2614 + active Promise work; likely shares #3197 root cause]

**#3185 default-lane Array.prototype generics** (tracking umbrella stays open;
disjoint from standalone #3169/#3180 by lane):

- #3199 — fold/predicate: reduce/reduceRight/every/some (~283) [M, high]
- #3200 — iteration/producer: forEach/map/filter/flatMap (~204) [M, high]
- #3201 — search+structural: indexOf/lastIndexOf/slice/splice/sort/concat/pop (~312) [M, high — owns 30 trap-class fails, land first]
- All three share array-methods.ts (hot: dev-array-hof, #3193/#3196) — behavioral fixes, re-anchor by symbol.

Frontmatter hygiene: **#3056** set `status: blocked` + `blocked_by: [3055]`
(human-gated standalone-floor re-baseline — was mis-claimed twice from the
auto-pick pool while tagged `sprint: current` + high).
