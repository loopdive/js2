---
id: 4751
title: "Combine open ES6 conformance fixes into one integration PR"
status: done
created: 2026-08-26
updated: 2026-08-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: integration
area: conformance, test262
es_edition: es2015
goal: test262-conformance
related: [4684, 4688, 4691, 4699, 4702, 4705, 4707, 4709, 4710, 4715, 4716, 4717, 4718, 4719, 4720, 4721, 4722, 4723, 4724, 4725, 4727, 4731, 4732, 4733, 4735, 4736, 4737, 4738, 4739, 4740, 4741, 4742, 4743, 4744, 4745, 4746, 4747, 4748, 4749, 4750, 4752, 4753]
oracle-ratchet-allow:
  - src/codegen/expressions/call-builtin-static.ts
---

# #4751 — Combined ES6 conformance integration PR

## Scope

Combine the currently open ES6 Test262 implementation PRs into one upstream
integration branch so GitHub runs the expensive quality and conformance suites
once for the whole wave. Each implementation remains tracked by its own issue
file and retains its original commits and focused evidence.

## Implementation plan

1. Start from the latest `loopdive/js2:main` and merge the component head
   branches in ascending dependency/PR order without rebasing or squashing.
2. Resolve only true integration conflicts, preserving the behavior and tests
   from every component issue. Run issue integrity, TypeScript, formatting,
   budget, native-first, oracle, coercion, and changed-root gates.
3. Run the combined focused issue tests, then push one head branch to the fork
   and open a single PR against `loopdive/js2:main`.
4. Mark the component PRs as superseded by the combined PR. Future ES6 agents
   deliver clean branch tips to this integration branch instead of opening
   additional PRs.

## Acceptance

- Every component issue file, production change, and focused regression test
  is present on the combined branch.
- The combined branch passes repository integration gates with no untracked
  conflict resolution or loss of component semantics.
- Exactly one active upstream PR represents this ES6 wave.

## Test Results

The umbrella branch integrates issues #4684 through #4750 listed above,
including the final #4749 Proxy-source fix. Integration validation passed:

- TypeScript 5 and TypeScript 7 typechecks.
- Host-import policy (`runtimeTsLines: 18062`), LOC, function-size, oracle,
  coercion-site, formatting, and issue-integrity gates.
- All 37 pre-#4749 focused suites reported 251/251 passing tests. Vitest then
  emitted one worker RPC timeout after the completed pass set; no test failed.
- The post-merge #4749 host/standalone pins and controls passed 10/10.
- The late-discovered open #4707 component PR was incorporated before
  supersession; its focused suite and both typechecks passed on the umbrella.
- CI's first combined quality run exposed one superseded, unreferenced native
  generator close helper. Issue #4752 removed it; the dead-export gate and
  #4716/#4718 suites (26/26) pass on the repaired branch.

Component branches retain their individual issue files and commits. The
combined branch is the sole upstream review and CI surface for this wave.
Issue #4753 carries the authoritative 11,704-row host/standalone close-out
handoff; this integration issue does not claim that final conformance proof.
