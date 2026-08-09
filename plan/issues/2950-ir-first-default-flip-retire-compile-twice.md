---
id: 2950
title: "IR-first default flip (historical milestone; retirement moved to #3518)"
status: done
sprint: 71
created: 2026-07-02
updated: 2026-07-21
completed: 2026-07-13
priority: high
horizon: l
complexity: L
feasibility: hard
reasoning_effort: max
model: fable
task_type: refactor
area: codegen, ir
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
depends_on: [2138, 2135, 2951, 2945]
related: [2855, 2947, 1916, 3090, 3143, 3518]
superseded_by: 3518
origin: "2026-07-02 July Fable audit §1; default flip delivered by #3143"
---

# #2950 — IR-first default flip (historical milestone)

## Reconciled disposition (2026-07-21)

The default-on portion of this issue shipped through **#3143** on 2026-07-13.
The compiler now enables the IR overlay by default and computes a conservative
compile-once allowlist unless `JS2WASM_IR_FIRST=0` disables it.

The original title also promised deletion of the flag and compile-twice path.
That work did **not** ship and cannot be treated as a small follow-up to the
flip:

- the latest measured compile-once ceiling is 441/1,568 functions (28.1%);
- class members and module init remain compile-twice;
- multi-source/M0 and linear do not have whole-program IR-only ownership;
- runtime/builtin emission still needs IR-owned semantic entry points;
- a selector/body corpus reading zero does not make fallback globally
  unreachable.

The undelivered retirement scope is superseded by **#3518 R1–R10**. Do not
re-open or dispatch #2950 as “remove the flag”: #3518 first establishes typed
outcomes, program ABI/preparation, classes/module/multi/runtime/linear
ownership, then removes escape hatches in R9 and deletes the direct front-end
in R10.

## Delivered outcome

- [x] IR-first is the default compilation mode under `experimentalIR`.
- [x] A positive lowerability allowlist prevents skipped-slot hard-error
      regressions; non-allowlisted units retain compile-twice behavior.
- [x] The equivalence-inline corpus and merge-group gates validated the flip.
- [x] Gate G1 was cleared for the allowlisted population.

## Explicitly not delivered here

- [ ] Whole-program prepare-before-emit compilation.
- [ ] Class member, module-init, multi-source, and linear compile-once ownership.
- [ ] Removal of `experimentalIR`, `JS2WASM_IR_FIRST`, `disableIrFirst`, or the
      demote-to-legacy channel.
- [ ] Direct front-end reachability deletion.

Those unchecked outcomes are acceptance criteria of #3518, not open work under
this completed historical milestone.
