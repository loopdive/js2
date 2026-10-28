---
id: 7143
title: "Deletion plan: retire the legacy (direct AST→Wasm) twins kind by kind as the IR arm is promoted, and delete the JS-host-mode-specific code once nothing consumes it"
status: in-progress
created: 2026-10-25
updated: 2026-10-28
assignee: ttraenkler/opus-7143-b0
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: refactor
area: compiler, runtime, cli, ci, docs
language_feature: compiler-internals
goal: architecture
sprint: current
parent: 3518
depends_on: [6979, 7106]
related: [3090, 3341, 5385, 6708, 6978, 7112, 7113]
---

# #7143 — Deletion plan: legacy codegen twins and JS-host-mode code

Stakeholder ask (2026-10-25): *"IR arm promoted → legacy twin deleted; also
delete the JS host mode specific code after making sure it is not needed any
more in the playground or other places."* This issue is the plan. It is a
**program** (two tracks, ordered slices, each slice its own PR); it does not
itself delete anything. Every number below was measured on `origin/main` =
`b8f8ce0513` (2026-10-25) with the command named next to it; re-measure before
scoping a slice, because the before-picture moves (the `ctx.standalone` arm
count rose +69 in the 11 days since #6979 was written).

Two tracks:

- **Track A — JS-host-mode code.** Scope ruled by the stakeholder on
  2026-10-25 (D1): the browser-side `gc` environment stays; what goes is the
  `host-assisted` rollback and everything only it reached. Execution is #6979
  S7-a…e; this issue adds the consumer audit (A0) and the arm ratchet (A1)
  #6979 lacks.
- **Track B — legacy twins.** A per-construct protocol: measure whether any
  unit containing kind X still reaches the legacy body on the standalone
  corpus; when zero, fail closed on demote for X, delete the twin, bank the
  decrease. Order given below. #3090's objection ("adoption labels do not prove
  whole-unit reachability") is answered by the measurement, not argued away.

## 1. What the census found (2026-10-25)

### 1.1 Track A — the host *semantic* lane is already gone; what is left is three things

`compile(src, {target: "gc"})` reports `semanticProviders = native-first,
nativeRegime = true`; `docs/architecture/codegen-axes.md` says since #6708 "JS
host vs standalone semantics is not an axis"; host test262 CI was retired
2026-10-12 (`ae7991db21`: 8 `if: false # JS-host` steps). What still exists:

| # | Thing | Size (command) | Status |
| --- | --- | --- | --- |
| A-1 | `host-assisted` rollback profile: `semanticProviders: "host-assisted"`, `--semantic-providers`, `JS2WASM_NATIVE_REGIME_JS` kill switch, `TEST262_SEMANTIC_PROVIDERS` | ~25 target-profile sites, 3 CLI sites, 23 legacy imports in the `check:host-import-policy` compatibility probe, 80 kill-switch hits, 45 `TEST262_SEMANTIC_PROVIDERS` hits (`rg -c` over `src scripts tests .github`) | **deletable now** — #6979 S7-a (PR #6701, held) / S7-b |
| A-2 | `gc` target in a JavaScript environment: native core + value adapter (`__boundary_object_*`, `__str_*`) + platform capabilities (console, DOM externs, timers, `__date_now`) + opt-in accelerators (#6978) | still the default target (`src/index.ts:531` "gc (WasmGC, default)"); every consumer in §1.2 depends on it | **stays — out of deletion scope (D1, 2026-10-25)** |
| A-3 | dead `else` arms of `ctx.standalone` in codegen | `ctx.standalone` 1,728 lines / 513 files; 604 `!ctx.standalone` else-arms; 282 `noJsHost(`; 987 `ctx.wasi` (`rg -c`); was 1,659 on 10-14 | #6979 S7-c; **ratchet `check-standalone-arms.mjs` does not exist yet** |
| A-4 | `src/runtime.ts` | 20,241 lines; `resolveImport` 7,868 lines / 15 cases (`wc -l`, `awk`) | #6979 S7-d |

### 1.2 Track A — consumers of A-2 (what "not needed anymore" has to be shown for)

| Consumer | Evidence | Needs for standalone-only |
| --- | --- | --- |
| Playground `website/playground/main.ts` | 0 mentions of `standalone`; no target selector; 11 of 13 examples use `document` / `Date.now` / `setTimeout`; a standalone build of `calendar.ts` still imports 11 DOM/clock externs | a browser **capability embedder** (platform imports without the value bridge) — none exists |
| `equivalence-gate` (required) | 235 files via `tests/helpers/compile.ts` → default gc + `buildImports`, run under Node host objects | a host-free run harness (console sink, no `wrapCompiledExports`) or re-target with a documented loss of value-boundary coverage |
| `quality` → `check:ir-fallbacks` (required) | `jsHostExterns: true`, re-compiles with `target: "gc"` | re-target to standalone; baseline `scripts/ir-fallback-baseline.json` is gc-measured |
| `tests/playground-example.test.ts`, dogfood floor | 171 / 179 dogfood tests non-standalone | same as above |
| `check:host-import-policy` | 33 probes, 452 imports, all value-adapter, 0 legacy / unknown; `compatibility.minimumLegacySemanticImports: 1` | the `compatibility` section goes with S7-a (the one baseline S7 may lower) |
| npm-compat lane | `perf.lanes.jsHost` / `jsHostNative`, `optimizationLevels.js-host*` in `benchmarks/results/npm-compat*.json` | #6979 entry condition 4 |
| Published figures | README conformance line and `test262-current.json` still carry the retired host lane's figures; `playground-benchmark-sidebar.json[].semanticProviders`; `report.html` Host/Standalone switch; `docs/ci-policy.md` §7 "both lanes" | D2 (decided): standalone only, host figures dropped — #6979 S7-e |

### 1.3 Track B — twins, reachability, demotes

- `node scripts/audit-legacy-reachability.mjs` on main: frontend bucket **165
  files / 90,953 legacy-only fn-lines** (2026-09-03: 85,609 / 107; July:
  59,676 / 35 — growing, not shrinking); 27 bucket conflicts (16,849 shared
  lines inside the deletion scope).
- `plan/log/ir-adoption.md`: 20 `ir-owned`, 1 `direct-only`, 5 `deferred`
  rows. The named legacy-only twins of the 20 ir-owned kinds total **≈2,124
  LOC = 2.3 %** of the bucket (`compileDeleteExpression` 569,
  `compileTypeofExpression` 428, `compileReturnStatement` 370,
  `compilePostfixUnary` 236, `compileConditionalExpression` 198,
  `compileIfStatement` 147, `compileWhileStatement` 63,
  `compileThrowStatement` 59, `compileRegExpLiteral` 54). `compileIdentifier`,
  `compileStringLiteral`, `compileFunctionBody` are **shared** with IR/backend
  emission — re-homes, not deletions. The bulk (calls.ts 9,051, new-super
  6,686, assignment 6,074, call-receiver-method 4,630) belongs to **mixed**
  kinds (`CallExpression`, `NewExpression`, `BinaryExpression`,
  `PropertyAccessExpression`).
- Demotes: `check:ir-fallbacks` unintended = 0, **but it measures the gc
  corpus**. Standalone sample (13 playground examples, `target: "standalone",
  trackIrOutcomes: true`): 73 units, 48 IR-emitted, **14 `legacyBodyEmitted`**
  (12 `host-surface-unavailable`, 1 `call-graph-closure`, 1
  `body-shape-rejected`). The demoted bodies contain ReturnStatement ×5,
  PostfixUnary ×4, StringLiteral ×79 — ir-owned twins are still reached today.
  test262-wide IR-only is `unavailable` (`ir_only_pass 2 / 42,436`). **No twin
  is provably dead today**; #3090's conclusion stands until the measurement in
  §3.1 says otherwise for a specific kind.

### 1.4 Gates a pure deletion trips (read from the scripts)

| Gate | Trips on deletion? | How / what the PR must carry |
| --- | --- | --- |
| `check:dead-exports` (`preservation-v1`) | **yes** | (a) a stranded helper → delete it too; (b) removing any of the 27 baseline entries fails until `scripts/dead-export-baseline.json` is refreshed in the same PR — **decision D3** (CLAUDE.md: main is the sole baseline writer) |
| `check-compiler-boundaries.mjs --mode inventory` | **yes** | every deleted file must leave `scripts/compiler-boundaries.json` (1,985 entries) in the same PR; no `--update` flag, hand edit |
| `check-host-import-policy.ts` | **yes, S7-a** | `compatibility.minimumLegacySemanticImports: 1` — drop the section with the profile |
| `check-claude-md-paths.mjs` | **yes** | CLAUDE.md edit for every removed flag / path in the same PR |
| `equivalence-gate` | **yes** | gc bytes must stay identical for Track A slices; Track B slices may change only standalone / native-regime gc output and must say so |
| `gen-ir-adoption.mjs --check` | possibly | deleting an `IrFallbackReason` forces a regen |
| loc / func budgets, oracle-ratchet, coercion-sites, import-cycles, flat-dir, kind-neutrality (0 of 113 cites in `src/codegen`), dialect pin | no | decreases pass; do not merge arms into one function (func budget 300) |

## 2. Stakeholder decisions

Recorded (stakeholder, 2026-10-25):

- **D1 — scope of "JS host mode": the browser side is NOT in deletion scope.**
  A-2 (the `gc` target in a JavaScript environment: value adapter, platform
  capabilities, named accelerators) stays, as #6979 already states. Deletable
  are A-1 (the `host-assisted` rollback and everything only it reached) and A-3
  (the dead `ctx.standalone` arms). Consequences: the §1.2 consumers keep
  compiling `gc`; no capability embedder, host-free equivalence harness or
  re-targeting of `check:ir-fallbacks` / playground / dogfood is needed; A0
  shrinks to confirming that nothing in §1.2 reaches the `host-assisted`
  profile (none does today — `check:host-import-policy` reports zero
  legacy-semantic imports on the default probe).
- **D2 — published figures: the README does not mention the JS-host numbers.**
  The conformance line reports standalone only; the retired host lane's
  figures are removed, not labelled. #6979 entry condition 5 is thereby met;
  S7-e implements it (README, `test262-current.json` summary, `report.html`
  switch, `docs/ci-policy.md` §7).

Still open:

- **D3 — baseline edits in deletion PRs**: may a deletion PR run
  `audit-legacy-reachability.mjs --update` on `scripts/dead-export-baseline.json`
  and hand-edit `scripts/compiler-boundaries.json`? Both gates fail otherwise.
  Proposed: yes, for a decrease only, with the diff shown in the PR body.
- **D4 — the S7-a playground IR-coverage baseline waiver** (38/0 → 26/12):
  #6899 (replaces #6701, same change re-homed on the upstream branch) is
  parked on it.

## 3. Track B — per-construct retirement protocol

Applies to every kind in `plan/log/ir-adoption.md`. Four steps per kind, each
measured; a kind advances only when the previous step's number is zero.

### 3.1 Measure: units containing X that still emit the legacy body

Tool to add (slice B0): `scripts/measure-legacy-reach.mjs --kind <SyntaxKind>
--corpus <list>`. Compiles every source in the corpus with `target:
"standalone", experimentalIR: true, trackIrOutcomes: true`, walks each unit's
AST, and reports **units that contain X and have `legacyBodyEmitted = true`**,
grouped by `IrFallbackReason`, plus the same for `target: "gc"` native-first.
Corpus = `website/playground/examples/**`, `scripts/standalone-ir-cutover-corpus.json`,
the `tests/equivalence/**` sources (extract from the vitest bodies once —
slice B0 adds the extractor), and the test262 `language/` subset the issue
tests already compile. Output is committed as
`scripts/legacy-reach-baseline.json` (per kind: `units`, `demoted`, reasons)
so the trend is visible and the count can only ratchet down.

### 3.2 Prove: zero demotes containing X ⇒ fail closed on X

When `demoted(X) = 0` on the full corpus: the selector's refusal reasons that a
unit containing X can still produce are promoted to `STRICT_IR_REASONS`
(`src/codegen/index.ts`, bar in #3341: "the IR always claims and lowers that
construct, so a rejection is a bug") **for units containing X only** — a
typed compile error naming the kind and the reason, never a silent demote.
This is per-construct fail-closed, a bounded form of #3518 R9. It lands as its
own PR with the legacy twin still present, and must survive one standalone
nightly with the per-edition ratchet green (ES5 `completed`: zero non-passing
rows) and the standalone floor unchanged.

### 3.3 Delete: the twin and only the twin

Delete the handler and the dispatcher arm (`compileStatementInner` /
`compileExpressionInner` case), run `check:dead-exports` to find stranded
helpers and delete them too, remove deleted files from
`scripts/compiler-boundaries.json`, refresh `scripts/dead-export-baseline.json`
(decrease only, D3). `audit-legacy-reachability.mjs` must show the frontend
bucket shrink by at least the twin's fn-lines; the PR body quotes before /
after. gc host-assisted bytes identical (equivalence-gate); native-regime
output may change only if §3.2's error path is the sole difference.

### 3.4 Bank

`check-loc-budget` / `check-func-budget` baselines refresh on main (post-merge
job, no action); `plan/log/ir-adoption.md` row gets `twin: deleted` + PR;
`scripts/legacy-reach-baseline.json` row is removed.

### 3.5 Order (prepare in this order; §3.1 decides when each is ready)

| # | Kind | Twin, LOC | Position because |
| --- | --- | --- | --- |
| 1 | `ThrowStatement` | `compileThrowStatement` 59 | 0 hits in demoted sample units; self-contained in exceptions.ts |
| 2 | `WhileStatement` | `compileWhileStatement` 63 | 0 hits; loops.ts otherwise mixed (For/Do) |
| 3 | `RegularExpressionLiteral` | `compileRegExpLiteral` 54 | 0 hits; dual-backend dispatch already IR-owned |
| 4 | `IfStatement` | `compileIfStatement` 147 | 0 hits in the sample but ubiquitous — needs the full corpus |
| 5 | `ConditionalExpression` | `compileConditionalExpression` 198 | 0 hits |
| 6 | `TypeOfExpression` | `compileTypeofExpression` 428 | 0 hits; largest clean win |
| 7 | `DeleteExpression` | `compileDeleteExpression` 569 | 0 hits; largest twin |
| 8 | `PostfixUnaryExpression` | `compilePostfixUnary` 236 | **4 hits** (host-surface `for` loops) — the demoting units touch `document` under a host-free target; with the browser side kept (D1) those units are the IR's to claim via the capability imports, so this row waits on that IR work |
| 9 | `ReturnStatement` | `compileReturnStatement` 370 | **5 hits**; also Annex-B / ctor paths |
| 10 | `StringLiteral`, `Identifier` | shared helpers 31 + 30 | re-home into the shared emitter layer, not deletions |
| 11 | inline literal / paren / void / as / block arms | ≈90 LOC in dispatchers | go with the dispatchers |
| 12 | `FunctionDeclaration` + dispatchers (`compileExpressionInner` 625, `compileStatementInner` 385, `compileExpressionBody` 298, `compileFunctionBody` 638 shared) | ≈1,950 | last — this is #3518 R9/R10 proper |

The mixed kinds (calls, new/super, assignment, property access — the 88 % of
the bucket) enter this table only after their IR arms are promoted in
#7106 / #7112 / #7113 and successors; each gets a row when `ir-adoption.md`
flips it to `ir-owned`.

## 4. Track A — slices

| Slice | Content | Gate | Horizon |
| --- | --- | --- | --- |
| **A0 consumer audit** (this issue's deliverable, docs-only) | §1.2 table re-measured; per consumer: confirm it never selects the `host-assisted` profile (D1 keeps the `gc` environment, so "keep" is the default answer) | none | s |
| **A1 arm ratchet** | add `scripts/check-standalone-arms.mjs`: counts `ctx.standalone`, `!ctx.standalone`, `noJsHost(`, `ctx.wasi` per directory against a committed baseline; growth fails `quality`. Lands **before** any S7 deletion so the +69 drift stops | #6979 S7-c prerequisite | s |
| **A2 = #6979 S7-a** (PR #6899, replaces #6701) | remove `host-assisted` | D4 waiver; round-2 verdict on head 489b674b51 | m |
| **A3 = #6979 S7-b** | `legacy-semantic` imports → compile error; emitters deleted by prefix family | A2 | l |
| **A4 = #6979 S7-c** | collapse `ctx.standalone` arms, directory by directory, ratchet from A1 banks each PR | A1, A2 | xl |
| **A5 = #6979 S7-d** | `runtime.ts` → adapters + capabilities (≤ 8k lines) | A3 | l |
| **A6 = #6979 S7-e** | docs / dashboards / README line: standalone only, host figures removed (D2) | none | s |

## 5. Acceptance (program level)

- Track B: every row 1–7 of §3.5 has a `legacy-reach-baseline.json` entry of
  0 demotes and its twin deleted; `audit-legacy-reachability.mjs` frontend
  legacy-only fn-lines ≤ 88,800 (90,953 − 2,124) with the per-slice before /
  after quoted; standalone per-edition ratchet green throughout; gc
  host-assisted bytes identical throughout.
- Track A: A1 ratchet on main; #6979 S7-a…d landed; `ctx.standalone` arm count
  = 0 in the directories S7-c covers; D3/D4 recorded in this file (D1/D2 are).
- Nothing deleted ahead of its measurement: a slice PR without the §3.1 number
  (Track B) or the §1.2 consumer row (Track A) in its body is not mergeable.

## 6. Open questions (from the census, for the stakeholder or the lead)

1. D3–D4 above.
2. Why did the frontend bucket grow 85,609 → 90,953 fn-lines / 107 → 165
   files since 2026-09-03 — direct-front-end growth or `BUCKET_PREFIX`
   membership drift (158 of 165 files are prefix-bucketed)? The 2026-09-03
   JSON is committed; a per-file diff is a one-command follow-up.
3. `report.html`'s Host/Standalone switch: D2 says the host figures go, so
   the switch goes with S7-e unless the lead wants the historical runs kept
   behind it.

## Implementation Plan — dispatch notes (Fable, 2026-10-25)

- **B0 first** (measurement tool + corpus extractor + `legacy-reach-baseline.json`),
  horizon m, Opus. Without it every Track B slice argues instead of measuring.
  Acceptance: the tool reproduces the §1.3 sample numbers (14 / 73 demoted on
  the 13 playground examples) and runs on the full corpus in < 15 min.
- **A1 second** (arm ratchet), horizon s, Opus. Acceptance: `quality` fails on
  a synthetic +1 `ctx.standalone` site; baseline equals the §1.1 counts.
- Then B rows 1–3 as one PR each (prove PR, then delete PR), in order; D3 is
  needed before the first delete PR.
- Track A slices A2–A6 are #6979's; this issue adds no work there beyond A0
  and A1 and the D3/D4 decisions.
- Every slice PR body: the measurement it rests on (number + command), the gc
  byte-identity statement, and the gate exit codes run bare.
