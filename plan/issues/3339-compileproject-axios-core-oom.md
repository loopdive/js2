---
id: 3339
title: "compiler: bound compileProject graph expansion on axios core instead of OOM"
status: backlog
created: 2026-07-17
updated: 2026-07-17
priority: high
feasibility: hard
model: fable
reasoning_effort: max
task_type: bugfix
area: compiler, resolver, codegen
language_feature: multi-module-compilation
goal: npm-library-support
sprint: Backlog
horizon: l
es_edition: multi
complexity: L
related: [1032, 1571, 1693, 1927]
needs_architect_spec: true
origin: "2026-07-17 stronger-model current-origin/main audit: compileProject on axios/lib/core/Axios.js exhausts a 512 MB heap after about 85 seconds"
---

# #3339 - Bound `compileProject` expansion on Axios core

## Problem

`compileProject("node_modules/axios/lib/core/Axios.js", { allowJs: true })`
does not return. On current main it consumes a CPU core, grows to the V8 heap
limit, and terminates with an out-of-memory fatal error instead of producing a
compile result or bounded diagnostic.

This is the dominant unresolved Axios Tier 1 blocker: every surveyed entry that
reaches the core Axios graph exhibits the same nontermination class.

## Evidence on current `origin/main`

- A fresh isolated probe against installed `axios@1.16.1` reached
  `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of
memory` after about 84.5 seconds with a roughly 510 MB V8 heap. A Vitest
  timeout could not interrupt it because compilation is synchronous.

  ```ts
  import { compileProject } from "./src/index.ts";
  compileProject("node_modules/axios/lib/core/Axios.js", { allowJs: true });
  ```

- `package.json:170` pins Axios as `^1.16.1`; the installed audited package is
  1.16.1.
- `tests/stress/axios-tier1.test.ts:23-30` still labels this blocker `#TBD-1`,
  and `tests/stress/axios-tier1.test.ts:164-183` keeps Tier 1e skipped because
  `compileProject` never returns.
- `plan/issues/1571-axios-tier1-survey.md:78-144` documents four affected entry
  points and explicitly proposes a follow-on issue, but the survey is not an
  implementation owner.
- `node_modules/axios/lib/core/Axios.js:3-11` imports `utils`, `buildURL`,
  `InterceptorManager`, `dispatchRequest`, `mergeConfig`, `buildFullPath`,
  `validator`, `AxiosHeaders`, and transitional defaults before defining
  `Axios` at line 22. This is the shared graph root identified by the survey.

  ```js
  import utils from "../utils.js";
  import InterceptorManager from "./InterceptorManager.js";
  import dispatchRequest from "./dispatchRequest.js";
  import mergeConfig from "./mergeConfig.js";
  import AxiosHeaders from "./AxiosHeaders.js";
  ```

- #1693 treats Axios full-graph nontermination as out of scope and points back
  to #1571's proposed new issue. No dedicated canonical issue was filed.

## Impact

An unbounded compiler process is worse than an unsupported-library diagnostic:
it can kill editor services, CI workers, build daemons, and user processes. It
also prevents progress on four Axios survey entries and makes the Tier 1 test
unsafe to enable in-process. A bounded architecture fix may improve other large
or cyclic package graphs even if Axios exposes the first known trigger.

## Root cause / unknowns

The root cause is not yet established. #1571 records three hypotheses:
module-resolution cycles, repeated IR/type/lowering work, or unbounded object
method trampoline emission. The OOM confirms growth rather than a passive
deadlock, but does not identify the responsible phase. An architect must first
specify phase instrumentation, graph invariants, and the correct ownership of
deduplication or cycle detection before implementation is dispatched.

## Proposed approach

1. Produce an architect-approved diagnostic spec that timestamps phases and
   counts resolved modules, lowered declarations/functions, generated
   trampolines/helpers, and revisits by stable source/symbol identity.
2. Run the real probe in a child process with explicit heap and wall-clock
   limits so diagnosis and CI can fail without taking down the test worker.
3. Bisect `Axios.js` imports or generate a reduced cyclic/dynamic-dispatch graph
   that preserves the unbounded counter.
4. Add the missing visited-set, memoization, or fixed-point convergence
   invariant at the phase identified by evidence. Do not add a
   package-name-specific bailout.
5. Turn Tier 1e into a bounded compile-and-validate regression test and replace
   `#TBD-1` references with this issue ID.

## Non-goals

- Making `axios.get()` perform real HTTP I/O; Tier 1f also depends on async and
  Node host APIs.
- Fixing the separate `AxiosHeaders_set` and `isBuffer` validator failures from
  #1571.
- Raising V8 heap limits or extending timeouts as the fix.
- Special-casing Axios paths, source text, or package identity.
- Dispatching implementation before the architecture/phase-attribution spec.

## Dependencies / related issues

- No code prerequisite is known, but implementation is blocked on the
  architect spec required by this issue.
- #1032 is the Axios support parent.
- #1571 is the verified survey and historical hypothesis source; its own scope
  assigns follow-on issue creation to PO triage.
- #1693 explicitly leaves this full-graph blocker out of scope.
- #1927 unified compile entry-point options but does not bound project graph
  expansion.

## Why this is not already covered

#1571 names the defect as `NEW issue 1` and #TBD-1, but remains a survey issue;
it provides no independently dispatchable acceptance contract. #1032 is a
product goal, while #1693 and the other Axios blockers explicitly exclude this
nontermination path. Searches for the four affected entry points, `#TBD-1`, and
the reported hang found no canonical implementation issue.

## Acceptance criteria

- [ ] An architect-approved implementation spec identifies the growing phase,
      stable identity key, convergence invariant, and safe ownership boundary.
- [ ] A reduced reproducer or phase-counter trace proves the root cause; the
      issue implementation notes reject or confirm each #1571 hypothesis.
- [ ] The real Axios core probe runs in an isolated child process and cannot OOM
      the main test runner even on regression.
- [ ] With a 1 GB child-process heap limit, compiling
      `node_modules/axios/lib/core/Axios.js` returns within 120 seconds without
      a heap OOM.
- [ ] The child process returns a serialized `CompileResult` instead of being
      killed for timeout or heap exhaustion. Success and binary validity are
      recorded, but independently scoped Axios validator defects do not expand
      this nontermination issue.
- [ ] Axios Tier 1e's bounded-completion rung is enabled, `#TBD-1` is replaced
      with `#3339`, and any remaining compile/validation assertion is split
      behind its exact independently filed blocker.
- [ ] A reduced cycle/memoization regression guards the responsible compiler
      phase.
- [ ] Existing React, ESLint, and lodash project-compilation stress tests do not
      regress materially in time, memory, or output validity.

## Validation plan

- Run the reduced phase-invariant test under the normal Vitest worker.
- Run the Axios probe through a child process with `--max-old-space-size=1024`
  and a hard 120-second parent watchdog.
- Run `pnpm test tests/stress/axios-tier1.test.ts` and the existing React,
  ESLint, and lodash Tier 1 compile tests.
- Capture before/after phase counters and peak RSS in implementation notes.
- Run standard typecheck, lint, format, and issue-specific gates.
