# Handoff — TS7 migration lane, oracle adjudication, compile performance

Session 2026-08-14 → 08-15. Branch `claude/typescript-7-migration-9kperg`.
Everything below is **merged** unless marked otherwise.

## What landed

| PR | What |
| --- | --- |
| #4500 / #4501 | Conflict sampling in the oracle ledger + `src/checker/divergence-classifier.ts` — a four-way structural verdict (`same-meaning` / `inhouse-weaker` / `checker-weaker` / `genuine-conflict`) |
| #4503 | A local scoped test262 run could append to the committed trend index — guarded (`scripts/should-publish-run-history.mjs`) |
| #4516 | Compile hot path **−17%** (#4415) — three allocation/env-read fixes |
| #4517 | Unit-suite parallelism — `vitest.config.ts` unpinned from `maxForks: 1` |
| #4518 | Three ES early-error false positives (#4417) — 130 → 0 across our own `src/**` |
| #4519 | Compile was **quadratic** in program size — **4.7×** at 512 functions (#4423) |
| #4521 | *(open)* corrects a wrong claim in #4423's note — see "Corrections" |

## The headline findings

### 1. The "908 oracle conflicts" number was mostly a broken classifier

Corrected split: **136** same-meaning, **318** in-house-weaker, **366**
checker-weaker, **88** genuine. `signatureOf` — 374 of the original 908, once
quoted as a "95.9% conflict rate" — has **zero** genuine conflicts.

### 2. TypeScript is not ground truth (#4410)

Adjudicated against ECMAScript, the checker is **wrong** for: a local `let`
resolved to a lib.dom global, a shadowed `var eval`, an unanswered `let`, and
any program reached through `eval` (its `ts.Program` excludes it). The in-house
backend is **wrong** for `with`-scoped lexical resolution and `declaredNameOf`
inventing `ArrayConstructor` (#4409).

**Consequence for #4218:** parity with the checker is the wrong retirement
gate. The restated gate is in #4410.

### 3. #4218's retirement gate is NOT met

Scoped standalone test262 A/B, 3,137 tests in the divergence areas: checker
**1891** vs inhouse **1854** = **−37**. 42 regressions (27 `with`, 12 annexB
B.3.3, 3 undiagnosed), 5 improvements.

### 4. "TypeScript is 90% of compile time" is false on the path that matters

True only with semantic diagnostics ON (one `getSemanticDiagnostics()` = 365 ms
of a 404 ms compile). test262's production path already passes
`skipSemanticDiagnostics: true`, so TS is ~1% there. **The compiler itself is
the cost**, and it was quadratic.

### 5. Self-hosting: three concrete walls

730 files / 23.7 MB resolve in 4.6 s and the early-error gate now passes.
Codegen does not finish. Largest validating subgraph is `src/interp/**`
(10 files → 366 KB of valid Wasm).

## Corrections worth carrying forward

**The `runNodeChecks` early-out is fixable — the note in #4423 said otherwise
and was wrong.** The first attempt lost 1,185 diagnostics not because the kind
set was incomplete, but because the recursion is the *last statement of the
function*, so an early `return` pruned whole subtrees. Done correctly
(traverse/check split) it loses **0**. It is still reverted, on measurement:
1295 → 1285 ms, i.e. noise. That also weakens the `switch (node.kind)`
follow-up — the Set gate is a proxy for half the switch's benefit and that half
measured zero. #4521 lands the corrected text.

**Do not read a green PR-level `check for test262 regressions` as conformance
evidence.** It is a designed no-op on `pull_request`.

## Open, in priority order

| # | What | Size |
| --- | --- | --- |
| **4421** | `{ ...spread, method() {} }` → `Missing __make_getter_callback import`. Blocks `src/ts-api.ts` → **657 of 768 files**. The thing that actually unblocks self-hosting past 10 files. | m |
| **4419** | `compileFiles` silently binds `node:*` to `ref.null extern` and reports success. Small, localized. | s |
| **4420** | Gate scoreboards on `WebAssembly.compile`, not on "no exception"; root-cause the `encodeInstr` struct.get/f64 mismatch. | s |
| 4422 | Module-object externals. | Backlog |
| 4418 | Dominator tree / dominance frontier — **another lane has PR #4520 open on this**, check before starting. | xl |
| 1029 / 4411 | The TsFacade — one interface over TS5 and TS7. TaskList item #9, still pending. | m |
| 4410 | Adjudicate the remaining `checker-weaker` rows into A/B/C. | m |

## Loose ends

- **GC is ~10% of compile time** and has never been heap-profiled
  (`--heap-prof` was never run). The CPU profile cannot attribute allocation.
- **`shiftGlobalIndices` is quadratic**, still 1.5% — 32 calls walking 89,281
  instructions per compile. Batching is *provably* equivalent (see #4415); what
  blocks it is the flush protocol across 259 scattered call sites.
- Next profile candidates: `canonicalProgramAbiValType` 2.1%, `fixupInstrs`
  1.4%, `locateOperandProducers` 1.4%. `src/codegen` is still ~56%.

## Reproduce

`.tmp/` is gitignored and did not survive; the drivers are described in #4415
("Reproduce") and #4423. The one non-obvious step: burn a distinctive frame
before the measured loop, or ~22% of CPU samples are tsx module loading.
