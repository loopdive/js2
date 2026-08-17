---
id: 4543
title: "Object frontier: tainted-allocation vs live exotic wrappers, decided by a measured A/B on an eval-heavy fixture"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
parent: 4538
depends_on: [4541]
related: [2929, 3927, 4236]
# id 4543 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the sole open PR was
# 4638 (hooks-only; adds no issue file), so the id space was clear.
---

# #4543 — The object frontier

Slice 5 of #4538. Closes the open acceptance box #4236 identified as "the hard
half" of the design.

## The question

#4541 gives dynamic values an engine representation. This slice decides **which
objects get it** — the representation rule is: *a binding or object is
engine-represented iff it is reachable by dynamic code; everything else stays
native.* The scope half of that rule is cheap and already computed. The object
half is not.

**Scope frontier (syntactic, cheap, already ours).** A function textually
containing direct `eval` (or `with`) taints all its locals — the same rule
mainstream engines use to force context allocation. Sloppy indirect `eval` and
`new Function` see only the global object. We already compute exactly this
taint: it drives `$Frame` reification, the direct-eval state cells, and the
global-lexical-cells carrier from the #2929 work. Same analysis, different box.

**Object frontier (the hard half), two candidate mechanisms:**

1. **Tainted allocation sites** — instances that can flow into an eval-visible
   slot are allocated as engine objects from birth. Structurally the same
   analysis as #3927's escape gate / receiver flow.
2. **Live exotic wrappers** — engine classes with exotic get/set over an opaque
   payload, trampolining eval-side property operations into compiled accessors
   over the native struct. One wrapper per object via a handle table, so
   identity and two-way mutation hold, and the trampoline cost lands only on
   cold eval-side access.

A hybrid is explicitly in scope: tainted sites for known-escaping types,
wrappers for the residue.

## Why this must be measured, not argued

The two mechanisms have opposite cost profiles. Tainted allocation pays at
every access to a tainted object (it is engine-represented even in hot compiled
code), but nothing at the frontier. Wrappers keep compiled code native and pay
per cold eval-side access — plus a handle table. Which wins depends on how much
tainted data is hot, which is a property of real programs, not of the design.

The program-level performance promise rests on **frontier-analysis precision**,
not on the representation choice — so an imprecise analysis that taints too
much silently gives back the measured 4× AOT win. That makes over-tainting the
failure mode to measure for, explicitly.

## Acceptance criteria

- [ ] A decision between tainted-allocation, exotic wrappers, or a stated
      hybrid, backed by an **A/B measurement on an eval-heavy fixture** — with
      both arms run by the author, on the same container, against a base copy
      captured before the first edit.
- [ ] Object identity holds across the frontier in both directions: an object
      mutated by eval'd code is observed mutated by compiled code, and the same
      object always presents as the same identity.
- [ ] Precision is reported, not just correctness: what fraction of allocation
      sites the analysis taints on the fixture corpus, and what that costs.
- [ ] A stated, tested answer for prototype identity at the frontier — #4236's
      split-brain audit names it as the sharp case.

## Validation

- Differential execution against Node on eval-heavy fixtures.
- The identity/mutation probes from #4236 (R3), re-run through real codegen
  rather than a hand-written peer module.

## Non-goals

- The WasmGC lane's frontier — unaffected; that lane keeps the self-hosted
  interpreter and its own membrane work.
- Replacing the Tier-0 compile-away splice: sites that never need a runtime
  tier should keep never needing one, and must not be tainted by this analysis.
