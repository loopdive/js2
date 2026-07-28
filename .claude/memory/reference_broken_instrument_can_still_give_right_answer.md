---
name: reference-broken-instrument-can-still-give-right-answer
description: "A faulty measuring instrument does not make its conclusion false — discredit the instrument, then RE-MEASURE; never use \"their harness was broken\" as grounds to dismiss a finding"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-25T22:17:49.347Z
---

**Discrediting the instrument is not the same as refuting the result.** Observed
2026-07-25 on #3642: one agent's probe channel was genuinely broken (it had
correctly diagnosed its own failed `return 7` control), and its **conclusion was
right anyway**. The reviewing agent nearly dismissed a true finding because the
instrument that produced it was faulty — and the lead had actively offered that
prior ("weight the refutation, their channels are suspect"). **The prior was
wrong and should not have been offered.**

Rule: a broken instrument lowers confidence to *unknown*, not to *false*. The
only resolution is a **shared repro run verbatim on both sides**, not an
adjudication from narrative or from whose harness looks healthier.

## The second half: "refuted" is scoped to what you actually varied

The same reconciliation showed both parties were wrong because **neither varied
the dimension that mattered**. The defect was **declaration-shape dependent**:

| declaration | `a.fill == null` (host) |
| --- | --- |
| `const a: any = [1,1]` | 0 — not null |
| `var a: any[] = [1,1]` | **1 — NULL** |
| `(a as any).fill` cast at use | **1 — NULL** |
| `const a: number[]` read via `b: any` | 0 |

"Refuted on host" was true only for the one shape that happened to be picked.
Correct headline: **unconditional on standalone, conditional on host**. Before
writing "refuted", state which dimensions were varied — and prefer a small
matrix to a single spelling.

## Related trap — a throw that renders as nothing

On standalone, a thrown payload can be a non-stringifiable
`[object WebAssembly.Exception]` (#2862), so `(e as Error).message` is
`undefined`. A harness that renders throws via `.message` shows the row as
**empty/undefined rather than as a throw**, and `.message.slice()` crashes the
probe. That is a plausible route to reading a throw as a value — i.e. to a
"broken channel" in the first place.

## Lane-selection hazard (guarded, but check historical data)

`compile(src, { standalone: true })` was never a real lane selector — the regime
is `target: "standalone"`. #86 added a **loud `throw`** in `src/compiler.ts`
(~L749) because the boolean previously **silently ran the gc-host lane**,
producing host rows wearing a standalone label. Current runs are protected by
that guard; **measurements predating it, and any path that never reaches it,
are suspect**. If a standalone figure looks like a host figure, check how the
lane was selected before trusting it.

Related: [[feedback_measure_never_extrapolate]],
[[reference_valid_wasm_is_not_correct_verify_by_value]],
[[reference_verifyproperty_vacuous_both_lanes_two_root_causes]],
[[reference_label_evidence_by_source_before_reasoning]].
