---
id: 4579
title: "Instrument standalone IR physical-route cutover"
status: done
created: 2026-08-20
updated: 2026-08-20
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler, codegen, ir
goal: ir-full-coverage
sprint: current
parent: 3518
assignee: ttraenkler/codex
horizon: s
related: [2856, 3518, 3520, 3521, 3522, 3523, 4577]
origin: "The 37/37 terminal census proves emitted ownership, but public standalone routes still physically enter legacy codegen before overlay."
files:
  - package.json
  - scripts/check-standalone-ir-cutover.mjs
  - src/codegen/audited-declarations.ts
  - src/codegen/audited-function-body.ts
  - src/codegen/class-bodies.ts
  - src/codegen/closures.ts
  - src/codegen/context/body-route-audit.ts
  - src/codegen/context/create-context.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions.ts
  - src/codegen/function-body.ts
  - src/codegen/index.ts
  - src/codegen/legacy-body-audit.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/statements.ts
  - src/codegen/statements/nested-declarations.ts
  - src/compiler/ir-cutover-invocation.ts
  - src/compiler/output.ts
  - src/compiler.ts
  - src/index.ts
  - src/ir/standalone-route-manifest.ts
  - tests/check-standalone-ir-cutover.test.ts
  - tests/issue-objemit-abstract-heaptype.test.ts
  - tests/issue-4579-standalone-object-route.test.ts
  - tests/standalone-cutover-audit.test.ts
  - tests/standalone-cutover-public-routes.test.ts
  - tests/standalone-route-subprocess.test.ts
  - plan/issues/4579-standalone-ir-cutover-route-audit.md
---
# #4579 — instrument standalone IR physical-route cutover

## Problem

The terminal ownership census can report 37/37 IR while standalone generation
still enters legacy declaration, function, class, closure, statement, and
module-initializer code paths before overlaying IR bodies. Removing those paths
without an exact physical-route denominator would turn missed support and
derived units into silent omissions.

## Scope

Add an observational, compiler-owned route audit. It records every successful
WasmGC generator invocation, exact source/class/source-unit and Program-ABI
derived-unit inventories, and each physical legacy entry with coherent source,
class, unit, owner, route, and location identities. An opt-in JSONL sink lets
CLI/provider subprocesses contribute records without changing ordinary builds.
This slice does not switch routing or delete a legacy backend.

## Acceptance criteria

- [ ] Every public WasmGC route reports its actual invocation route and target.
- [ ] Successful records are structurally complete: exact source/class/unit
      inventories, coherent joins, no unresolved terminal/derived ownership,
      and no masked poison/failure entrypoints.
- [ ] Module-init, empty/poisoned class members, nested closures, and derived
      Program-ABI units retain exact entry evidence.
- [ ] JSONL mode is inert when unset/empty, uses original source locations, and
      fails loudly when explicitly requested without a synchronous filesystem.
- [ ] The collector rejects malformed/cross-wired records. Strict mode requires
      explicit exact successful/source/unit floors and rejects failed records,
      legacy physical entries, and non-IR dispositions.
- [ ] `compileToObject` fails closed for standalone where the object route still
      ignores required target/options.
- [ ] Normal compiler output is unchanged when route auditing is disabled.

## Follow-up boundary

The next cutover issue consumes this audit over a pinned corpus, supplies exact
denominator floors, then switches one public route at a time to IR-first/no-
legacy generation. This issue alone is not the physical retirement claim.

## Completion evidence

- The four focused audit/collector/public-route/subprocess files pass 39/39.
- TypeScript 7 typecheck, Prettier, lint, diff-check, LOC, function, oracle,
  dead-export, and IR-fallback gates pass.
- The collector requires explicit exact successful/source/unit floors in
  strict mode, rejects failed standalone rows, and validates every redundant
  source/class/unit/owner join rather than accepting set membership alone.
- The opt-in audit does not change emitted binary or WAT bytes.
- Four unrelated relocatable-object assertions fail identically on the clean
  `79febab` base and are not claimed green; the new standalone fail-closed
  object-route assertion passes.
