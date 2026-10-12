---
id: 6934
title: "IR design spike: optimistic specialized track + generic boxed track with runtime guards instead of compile-time demotion"
status: ready
sprint: Backlog
created: 2026-10-10
updated: 2026-10-10
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: research
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [6920, 2855]
---

# #6934 — Optimistic track + generic track with runtime guards (design spike)

Follow-up from [`plan/log/nightmonkey-analysis.md`](../log/nightmonkey-analysis.md)
lesson 1. This is a **spike**: the deliverable is a written design plus one
measured prototype on one construct. It authorises no architecture change on
its own. Anything below marked **[confirmed]** was read in source at the cited
location on 2026-10-10; anything marked **[proposed]** is design, not fact.

## Problem

**[confirmed]** When the IR cannot prove a fact about a function, js2 gives
the *whole unit* up: the selector declines it with an `IrFallbackReason`
(`src/shared/contracts/ir-preparation-failure.ts` L10–55), or a post-claim
stage (`build`/`verify`/`lower`/`backend-legality`) throws a typed
`unsupported` outcome and the unit demotes to the direct AST→Wasm front end
through the warning channel (`src/codegen/index.ts`, the `STRICT_IR_REASONS` /
`STRICT_IR_POSTCLAIM_CODES` block, ~L2290–2420; `docs/architecture/codegen-axes.md`
§"The fallback-to-warning escape hatch"). The demotion is binary and
compile-time: one unprovable property access or one `dynamic` operand type
costs the unboxed lowering of everything else in the function.

**[confirmed]** The optimism already in the pipeline is resolved the same way.
`src/ir/propagate.ts` L60–73 treats `unknown` as f64-compatible at operator
sites to break recursive fixpoints; `src/ir/type-evidence.ts` L3–6 then
certifies recursive SCCs conservatively "so the linear IR selector does not
treat that optimism alone as an ABI proof". An uncertified SCC is demoted, not
guarded.

## Motivation (NightMonkey evidence)

NightMonkey (DESIGN.md §5 "Versions, predictions, and tracks") emits every
function in two tracks: **OPT** carries unboxed values and facts proved by
dominating guards; **GEN** carries boxed values and calls runtime helpers and
is the correctness floor. A failed guard *offramps* to GEN; a GEN path that
re-proves the facts *onramps* back. Its ablation on Octane (VMIL 2026 slides)
puts the whole optimistic-type apparatus at **0.44×** when removed — the
single largest lever — and that apparatus is only usable because a wrong
prediction costs a guard, not a function. A compile ladder ("rung": retry with
less specialisation) sits above the tracks for shapes the translator cannot
close.

js2 has the optimistic analysis (propagate.ts) and the correctness floor (the
direct front end, soon the IR's own boxed lowering once #3518 retires it) but
no mechanism between them finer than per-function demotion.

## Current js2 state (cited)

| Piece | Where | What it does today |
| --- | --- | --- |
| Selector rejection | `src/ir/select.ts` (header L1–40), reasons in `src/shared/contracts/ir-preparation-failure.ts` | Pre-claim decline, whole function |
| Post-claim demote | `src/codegen/index.ts` ~L2290–2420, `formatIrPathFallbackDiagnostic` | Whole function to legacy, warning severity |
| Optimistic TypeMap | `src/ir/propagate.ts` L60–73 | `unknown ⊔ arithmetic → f64`, falls to `dynamic` on conflict |
| Conservative certifier | `src/ir/type-evidence.ts` | Recursive-SCC ABI proof; `accepted: false` ⇒ demote |
| Dynamic value carrier (WasmGC) | boxed `$AnyValue` family, tag field 0–6 (`src/codegen/dyn-read.ts` L14–21, #1852) | Interchange form for the dynamic residue |
| Dynamic carrier (linear) | #1852 f64-value + i32-tag scheme; ADR-0020 quickjs `JSValue` for the eval-reachable tier | Two different answers, by backend |
| Boundary guard | ADR-006: `ref.test` + `br_on_cast` at host-import sites | The one place js2 already guards-then-narrows at run time |
| Control flow | ADR-018: nested instruction buffers, single-block envelope | Reducible by construction; no CFG-level versioning |
| Effects authority | `src/ir/analysis/effects.ts` (#2134) | Single table consumed by scheduler, DCE, verifier |
| Telemetry | `JS2WASM_LOG_IR_FALLBACKS=1` (`src/codegen/index.ts` ~L3038); `irPostClaimErrors` (`src/index.ts` ~L398–409); `pnpm run check:ir-fallbacks` | Counts demotions; `unintended`/`postClaim` buckets empty on the 13-file playground corpus (baseline dated 2026-08-03) |

**[confirmed]** The playground baseline being empty does **not** mean real
code does not demote: the #3341 comment block in `src/codegen/index.ts`
records a test262 stride-40 sweep (1340 files) and names reasons such as
`external-call`, `call-graph-closure`, `param-type-not-resolvable`,
`type-resolution-unsupported`@resolve and `unboxed-number-local-unprovable`
as legitimate, reachable demotes. The prototype must pick its construct from a
fresh sweep, not from the baseline.

## Implementation Plan

### Scope

A design document plus one prototype. Out of scope: object stamps as header
words (a typed WasmGC struct already is its own stamp via `ref.test`), fuses,
bytecode-level versioning, any change to the linear or Porffor emitters beyond
stating what they would need.

### Part A — design document (`docs/architecture/ir-two-track.md`) [proposed]

Must answer, with a decision or a measured open question each:

1. **Granularity.** NightMonkey versions basic blocks; js2's IR has nested
   buffers (ADR-018). Candidates: (a) per-*instruction* side arm — a guarded
   `if` whose else-branch is the boxed lowering of just that instruction,
   joining through a boxed carrier; (b) per-*region* — duplicate the enclosing
   buffer (loop body, `if` arm) in a boxed form and branch once at region
   entry; (c) per-*function* (OPT clone + GEN clone, offramp = tail call to the
   GEN clone at the same program point with slots boxed). Rank by code size
   and by how many `slot.write`s must be re-materialised at the offramp.
2. **Reducibility.** With (a) or (b) the CFG stays structured because the
   offramp joins inside the same buffer. With (c) an offramp *into the middle
   of a loop* in the GEN clone is a side entrance; NightMonkey solves this with
   loop-header tokens in the version identity (DESIGN.md §5). State the js2
   equivalent: an offramp may only target a GEN clone whose entry is the loop
   header of the innermost loop containing the offramp site, re-executing the
   header's condition with boxed slots. Prove it keeps every loop
   single-entry.
3. **Generic-track value representation.** WasmGC: boxed `$AnyValue`
   (#1852) vs raw `externref` (host lane only) — the standalone target has no
   host to box into, so `$AnyValue` is the only candidate there. Linear:
   #1852's f64+i32 parallel locals; the ADR-0020 `JSValue` tier is for
   eval-reachable residue and must **not** become the offramp target for
   ordinary typed code. Record which `IrType` the GEN carrier is and which
   existing instrs (`coerce.to_externref`, `tag.test`, `refcell.*`,
   `src/ir/core/nodes.ts`) already express the box/unbox edges.
4. **Interaction with WasmGC structs.** A class instance is a
   `(ref $Class)`; the OPT fact "receiver is `$Point`" is one `ref.test`. The
   GEN path for a dynamic receiver is the `__dyn_get`/`__dyn_has` family
   (`src/codegen/dyn-read.ts`), today legacy-owned — the design must say
   whether the IR GEN track calls those helpers or waits for their IR-owned
   twin under #3518.
5. **Guard placement and effects.** Guards are new instrs; they must be
   classified in `effectsOf` (`src/ir/analysis/effects.ts`) so DCE and the
   scheduler treat them as control effects. A guard that fails must still
   observe JS semantics (throws at the right point) — the GEN arm, not the
   guard, raises.
6. **Code size budget.** Per-construct bytes before/after, measured with the
   existing module-size reporting; a hard cap (proposal: ≤ 1.3× on the
   construct's function, ≤ 1.05× on the module) above which the compile
   ladder's lowest rung — today's demotion — is taken instead.
7. **Retirement path.** Once #3518 lands, the "legacy" floor disappears; the
   GEN track *is* the floor. State how the spike's prototype survives that
   (it must only depend on IR-owned boxed lowerings).

### Part B — prototype on one construct [proposed]

1. Run `JS2WASM_LOG_IR_FALLBACKS=1` over a test262 stride sweep (same method
   as the #3341 block) and `pnpm run check:ir-fallbacks -- --verbose` on
   `website/playground/examples/`; pick the single most frequent
   **unintended** reason whose fix is a value-level guard (candidates:
   `unboxed-number-local-unprovable`, `type-resolution-unsupported`@resolve
   for an f64-vs-dynamic parameter, `recursive-type-evidence`). Record the
   count and the sweep command.
2. Implement granularity (a) or (b) for that one construct only, behind a
   compile option (`experimentalIrGuards`, default off) so default output is
   byte-identical.
3. Where the code changes [proposed, exact owners to be confirmed by Session A]:
   `src/ir/from-ast.ts` (emit guard + two arms instead of throwing the
   `unsupported` outcome), `src/ir/core/nodes.ts` (one new instr kind or a
   reuse of `tag.test` + `if.stmt`), `src/ir/analysis/effects.ts` (classify),
   `src/ir/runtime/verify.ts` (verify both arms produce the join type),
   `src/ir/lower-generic.ts` (lower the boxed arm), `src/ir/backend/legality.ts`
   (declare which backends accept the new kind), `src/index.ts` (option).
4. Verify with fallback telemetry: the chosen reason's count drops on the
   sweep, `irPostClaimErrors` is empty for the construct, and the equivalence
   gate stays green.

### Owner implications

These files are in the shared IR scope that Session A integrates and
publishes (see `plan/issues/6920-native-linear-shared-source-handoff.md`,
"Session A must supply one reviewed, coherently tested source dependency"; and
#3518, `lane: ir-retirement`). **Needs Session A acknowledgement before
implementation**; Part A (the document) can proceed without it.

## Acceptance criteria

- [ ] `docs/architecture/ir-two-track.md` answers the seven questions above,
      each with a decision or a named measurement that would decide it.
- [ ] One construct's demotion replaced by a guarded two-arm lowering, behind
      an option; default output byte-identical (equivalence gate green).
- [ ] Before/after counts for that reason on the same sweep command, plus
      bytes per function and per module.
- [ ] Runtime effect measured (see below); the result is reported whether it
      is a win or not.
- [ ] A recommendation: proceed to a feature issue, or stop, with the numbers.

## Measurement plan

- **Primary:** the Octane harness from
  [#874](874-benchmark-compare-all-js-to.md) once landed (Richards and
  DeltaBlue are the dispatch-heavy subtests that NightMonkey's ablation moves
  most); until then `benchmarks/cross-engine/` (#3684, checksum-matched axes,
  min-of-5, all three engines re-run together per its README) and
  `benchmarks/harness.ts`.
- **Control:** same source, `experimentalIrGuards` off, same container
  session (`uptime` recorded — the cross-engine README documents a 2× swing
  across restarts).
- **Telemetry:** `JS2WASM_LOG_IR_FALLBACKS=1` sweep count before/after;
  `check:ir-fallbacks` buckets unchanged or lower.

## Risks

- **Code size:** two arms per guarded site; the ladder rung (fall back to
  today's demotion above the cap) is the mitigation and must be in the
  prototype, not deferred.
- **Semantic drift between arms:** the GEN arm must be the *same* lowering the
  direct front end / IR boxed path uses, not a third implementation. Reuse
  `lower-generic.ts` arms; do not hand-write slow paths.
- **Effects misclassification:** a guard classified pure lets DCE drop it;
  #6921 showed the pass pipeline already misjudged `dyn.to_number`. Classify
  in `effectsOf` first, test with the #2134 drift tripwire.
- **Scope creep into BBV:** the spike must stop at one construct; a
  per-block versioning scheme is explicitly out of scope.
- **Standalone mode:** no host boxing; if `$AnyValue` cannot represent the
  construct's GEN values, the standalone lane keeps demoting and the design
  says so.
