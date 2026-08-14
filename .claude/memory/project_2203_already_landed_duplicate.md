---
name: project_2203_already_landed_duplicate
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#2203 (standalone closure-capturing native generator emits invalid funcidx) was
**already fixed and merged on `loopdive/js2wasm:main`** by another agent before my
PR could land. Their fix: `generatorCapturesOuterScope` wired into
`sourceNeedsGeneratorHostImports` (`src/codegen/generators-native.ts`) — the
exact same root cause and mechanism I independently implemented as
`generatorCapturesEnclosingScope`. Pass 74→86 on the standalone elision cluster;
the eager-generator over-consumption VALUE bug was split to **#2566** (needs lazy
*capturing* generators, a #680-class feature).

**Why this happened / how to apply:** my fork's `origin/main` was 1165 commits
behind `upstream/main`, and I branched + first-merged from the stale fork
`origin/main`, so the duplicate wasn't visible until I merged `upstream/main`
(which surfaced the add/add then content conflict on the issue file showing the
other agent's Resolution). **Before starting a hard issue: fetch `upstream/main`
and grep the issue file's status + the target source for an existing fix** — the
claim script even warned "no issue file for #2203 found on origin/main", a signal
the fork was stale. Branch from `upstream/main`, not `origin/main`, when the fork
lags. Closed PR #1808 as duplicate, released the claim. See
[[feedback_reground_spec_against_current_main]], [[feedback_no_duplicate_issue_dispatch]].
