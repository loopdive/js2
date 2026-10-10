---
name: standalone-only — the JS host (gc) lane is being sunset
description: Project-lead decision 2026-10-10. Only `--target standalone` is relevant; prioritize, measure and plan for standalone only.
type: project
---

# Only standalone is relevant — the JS host lane is being sunset

**Decision (project lead, 2026-10-10):** the JS-host lane (`gc` target, host
imports via the JS runtime) will be sunset. Only `--target standalone` (pure
WasmGC, no JS host) matters.

**How to apply:**

- **Pick and rank work by standalone impact.** A fix that only helps the host
  lane is low value: do not start it, and park host-only halves of existing
  issues.
- **Measure standalone.** Octane (#874), test262 and benchmarks are reported
  for the standalone lane. A host-lane pass is not progress.
- **Do not regress the host lane while it still exists.** The equivalence gate
  and the existing gc tests must stay green, because CI still gates on them.
  New tests need no host-lane cases.
- **Do not add a new host import as the only implementation of a feature.**
  This tightens the "Dual-mode: JS host optional" principle in `CLAUDE.md`
  until that text is updated.

Status when the decision was made (Session D, #874): standalone Octane passes
0 of 9 runnable benchmarks. Blockers are #6949 (richards, crypto), #6950
(splay), #6951 (deltablue), #1472 (raytrace), and untriaged regexp,
navier-stokes, box2d and earley-boyer.
