---
id: 5246
title: "Cross-module struct WRITES not decoder-aware — _safeSet resolves __sset_ from the running module; untested surface after #5225 fixed the read paths"
status: ready
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5246 — cross-module write paths still resolve `__sset_` from the running module

## Problem

#5225 (PR #5365) made the runtime resolve a struct's DECODER
(`__struct_field_names` / `__sget_*` / `__shas_*`) from the module that
MINTED the value instead of the module that is RUNNING, at every READ path.
The WRITE paths were deliberately not changed: `_safeSet` still resolves
`__sset_<field>` from the running module's exports.

Bound stated by dev-5225 (measured, not assumed): nothing in the measured
Temporal set needs it — `with({year: 2021})`, which writes into a record
across the seam, answers correctly — so this is **untested surface, not
known-good**. The #5225 mechanism (`_decoderExportsFor` /
`cross-module-struct-owners.ts`) exists and is one call away from the write
sites; the risk profile is the same silent-plausible-zero family #5225
measured on reads (a writer whose own shapes reuse the field name reports
success while the write lands in the wrong module's `ref.test`-miss path or
the JS sidecar).

Related bound, same registry, worth probing in the same lane:
**structurally-identical shapes across modules arbitrate to whichever module
answers first** (local-first). dev-5225 tried and FAILED to reproduce a
mis-attribution (provider owning its own `{year,month,day}` and `{days}`
shapes still read the consumer's values correctly) — not reproduced at that
scale, not proven impossible.

## Direction

Reduce non-Temporal, linked pair: provider `set(o) { o.x = 9; return o.x }`
(and a computed-key variant) with the consumer passing `{x: 7}`; also the
mirror direction (consumer writes into a provider-minted struct). Establish
whether the write lands (compiled `struct.get` read-back, not just a host
read). If broken, apply `_decoderExportsFor` at `_safeSet` and any sibling
write dispatchers (`__extern_set_strict` family) — names, presence bit,
getter AND setter must come from the same module (#5225's load-bearing
finding). If NOT broken, pin why (e.g. writes always route through the
owner's mirror) with a test so the surface stops being untested.

## Acceptance criteria

1. Linked write reduction measured both directions with a single-module
   control; either a fix at the general site with base-failing tests, or a
   pinned proof of why writes cannot mis-resolve.
2. A shape-collision probe for the local-first arbitration bound (two modules
   owning structurally-identical shapes, writes and reads interleaved).
3. No regressions in the issue-5221…5244 + #5225 family + linker family;
   equivalence at baseline; gates green.

## Notes

- Filed from PR #5365's "Reported, NOT fixed" (dev-5225), so the surface is
  tracked rather than presumed covered. Blocked on #5225 landing (uses its
  registry); probe on top of `issue-5225-consumer-literal-seam`.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
