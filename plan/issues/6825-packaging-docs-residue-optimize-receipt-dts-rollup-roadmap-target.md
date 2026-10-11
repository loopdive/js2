---
id: 6825
title: "packaging/docs residue from #6794/#6795: `src/optimize.ts` is receipt-pinned so parts 7 (#6794) and 3 (#6782) wait on a human re-sign; the `<100 files` package target needs a `.d.ts` rollup; ROADMAP's ≥80 % conformance target is already met and needs a new target"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: low
horizon: s
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: tooling
language_feature: n/a
goal: maintainability
related: [6794, 6782, 6795]
requested_by: ttraenkler/claude-review
origin: "carve-outs named by the #6794, #6782 and #6795 implementations (2026-10-01/02)"
---
# #6825 — three decisions a human has to make

1. **`src/optimize.ts` receipt.** `scripts/compiler-extension-boundaries.json`
   pins the file; the #6794 part 7 change (wasm-opt invocation) and the #6782
   part 3 change (optional Binaryen under plain ESM) were both left out
   because an agent may not re-sign the receipt. A maintainer re-signs, then
   both parts land as one small PR.
2. **Package file count.** PR 6419 took the package from 1,844 to 224 files;
   159 of the rest are `.d.ts` files reachable from the entry points. Getting
   under 100 means a declaration rollup (`@microsoft/api-extractor` or
   `rollup-plugin-dts`), which is a new devDependency — decide whether the
   target is worth the dependency, or restate the target as "≤ 250 files".
3. **ROADMAP target.** `ROADMAP.md` still states a ≥ 80 % test262 target
   while `benchmarks/results/test262-current.json` reports 81.3 %. The
   product owner sets the next milestone (per-edition completion is the
   natural successor given #6786).

## Acceptance

- Each decision recorded in this file with a date; the receipt PR merged;
  `ROADMAP.md` names a target that is not yet met.
