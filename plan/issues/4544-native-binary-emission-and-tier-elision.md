---
id: 4544
title: "Native binary emission: size/startup baseline, and pay-for-what-you-use elision of the dynamic tier"
status: in-progress
sprint: current
created: 2026-08-17
updated: 2026-08-19
priority: high
horizon: l
feasibility: medium
model: fable
reasoning_effort: high
task_type: feature
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
parent: 4538
# Part B (tier elision) depends on 4541; Part A (AOT an existing linear module
# and record size/startup) depends on NOTHING and is the evidence gate for
# ADR-0021. The blanket depends_on was wrong and would have parked the one
# measurement that should run first — corrected 2026-08-17.
depends_on: []
related: [2776, 4236, 4541]
# id 4544 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the sole open PR was
# 4638 (hooks-only; adds no issue file), so the id space was clear.
---

# #4544 — Native binaries, measured; and not paying for the tier you don't use

Slice 6 of #4538. Delivers the actual goal — a binary — and the property that
keeps the tier from taxing programs that never touch it.

## Sequencing — Part A is unblocked, Part B is not

**Part A can start today.** AOT-compiling an existing linear-target module and
recording size/startup depends on no other slice, and it is the evidence gate
for [ADR-0021](../../docs/adr/0021-native-backend-targets-c.md): if these
numbers are adequate, the direct C backend stays deferred indefinitely, which
is worth learning before anyone invests in it. Part B (tier elision) genuinely
needs #4541.

## Part A — native binary emission

The linked module is a standalone WASI module (five `wasi_snapshot_preview1`
imports, no JS host). Turning it into a native executable is an
ahead-of-time-compile step over output we already produce, not new lowering:
`wasmtime compile`, `wasm2c` + a C compiler, and WAMR AOT are the candidate
routes.

Pick one as the supported default by measuring, and record the others as
evaluated with their numbers. This route is deliberately chosen over writing a
native backend: it reuses fully-covered output and adds no second lowering path
to maintain. If binary size or startup later proves inadequate, that is the
evidence that would justify revisiting — and this slice's baseline is what makes
that argument possible.

## Part B — pay-for-what-you-use

The engine artifact is **measured** at 1,011,134 bytes raw / 350,017 gzipped at
`-O2` (`-Oz` gives 626,104 / 261,243, at a measured ~23% cost on both eval and
per-property time, which is why `-O2` is the default — the boxed tier is by
definition running code we could not compile).

That is a fixed cost, and it must be **conditional**. A program whose dynamic
residue is empty must link none of it and emit exactly what it emits today. Two
consequences worth designing for, not discovering:

- Whether a program has a residue is a **whole-program property**, so the
  decision belongs where the link is decided, not per function.
- Feature-subset builds of the artifact are already measured in #4236 (including
  a split regex module) — the elision decision should compose with those rather
  than being all-or-nothing.

## Acceptance criteria

- [ ] A native binary is produced from a linear-target program and runs, with
      the exact command recorded so it is reproducible.
- [ ] Size and startup are recorded as a **committed baseline artifact**, with
      the measurement command and container shape named — a number without its
      provenance is attribution, not measurement.
- [ ] A typed-only program links **none** of the engine and is byte-identical
      to today's output (emit-identity proof).
- [ ] A program with a residue links the tier automatically, with no flag
      required, and the size delta between the two is reported.
- [ ] The AOT route chosen is justified against at least one alternative with
      both sets of numbers.

## Validation

- Emit-identity proof for the typed-only path, against a base copy captured
  before the first edit.
- Startup measured as a distribution over repeated runs, not a single sample.
- The binary runs the differential fixture set with output matching Node.

## Non-goals

- A native (C or LLVM) code-generation backend. If the AOT route's numbers
  prove inadequate, that is a separate, evidence-backed proposal — the
  measurement this slice produces is its precondition.
- Component Model / WASI P3 packaging (#2776) — adjacent, separately tracked.
