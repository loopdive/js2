---
id: 4169
title: "ES5 standalone crash cluster — four diagnosed root causes recovered from a destroyed worktree (fixups arg-walk / string += externref / RegExp ToString / var-redecl shape)"
status: ready
sprint: current
created: 2026-08-05
updated: 2026-08-05
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: n/a
goal: es5
related: [4163, 4165, 4166]
origin: "2026-08-01 es5-crashes subagent, working the 366-test ES5 standalone crash bucket. Its worktree was destroyed mid-A/B (stopped while files were swapped to base; the harness auto-removed the 'unchanged' worktree). The diffs are unrecoverable; these findings are reconstructed from the agent's progress reports so the diagnosis is not lost with them."
---

# #4169 — ES5 standalone crash cluster: four recovered root causes

## Provenance — read before trusting

The diffs for these fixes are **gone**. The authoring agent was stopped while
its A/B had source files swapped to the base state, the harness saw an
"unchanged" worktree and auto-removed it, and nothing was pushed (no branch
ref, no dangling commits — recovery was attempted and failed the same day).
What follows is reconstructed from the agent's own mid-flight reports. Root
cause 1 was described precisely enough to re-implement; 2–4 are one-line
diagnoses that need re-derivation. **All four need fresh implementation.**

Its baseline measurements, for calibration: the ES5 standalone crash bucket
was **0/366** on its base; a passing-sample regression guard ran 694/700. Its
full AFTER measurement never completed.

## Root cause 1 — `src/codegen/fixups.ts` backward call-arg walk (the precise one)

The backward walk that locates a call's argument producers treats
`extern.convert_any` as an **argument producer**. When an argument is an inline
function expression, the emitted sequence contains
`ref.func` / `struct.new` / `extern.convert_any`, and the extra "producer"
shifts **every earlier argument onto the wrong parameter**. Observed corruption:
a legitimate `ref.null.extern` argument rewritten into a struct null.

The agent's fix for this cluster alone took **24/28** ES5 standalone tests from
0/28. Trigger shape: any call with an inline function-expression argument in
standalone mode.

## Root causes 2–4 (one-line diagnoses, need re-derivation)

2. **String `+=` into an externref slot** — a string compound-assignment whose
   target holds an externref-typed local/field crashes at compile or emits
   invalid Wasm.
3. **RegExp constructor ToString on dynamic pattern/flags** — `new RegExp(p, f)`
   where pattern/flags are not string literals misses a ToString step.
4. **Module-scope `var` redeclaration with a conflicting shape** — a second
   `var x` at module scope whose initializer implies a different representation
   than the first crashes codegen instead of unifying/widening.

## Acceptance criteria

- [ ] Root cause 1 re-implemented: the fixups walk skips `extern.convert_any`
      (and audits for other non-producer ops treated as producers), with a unit
      test compiling a call with an inline function-expression argument.
- [ ] Root causes 2–4 reproduced (each is a small repro), fixed or re-filed
      individually with measured counts.
- [ ] A/B over the ES5 standalone crash bucket (`null_deref` +
      `wasm_compile` + `illegal_cast` ES5 rows, ~366 files on the 2026-08-01
      baseline) with before/after pass-sets — expect the cluster-1 fix alone to
      recover ~24 of its 28-test slice.
- [ ] Process note stands: never stop an agent mid-A/B without checking whether
      its worktree holds swapped files — the "unchanged worktree" auto-cleanup
      is what destroyed the originals.
