---
id: 3501
title: "Infer typed linear vectors from empty-array read/write evidence"
status: done
completed: 2026-07-23
sprint: 75
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: bug
area: ir, codegen-linear, porffor, benchmarking
language_feature: evolving-empty-arrays
es_edition: multi
goal: backend-agnostic-ir
depends_on: [3497, 3499]
related: [1804, 1977, 2956, 3478]
origin: "2026-07-20 explicit user request: run the exact landing array-sum source through shared linear IR and Porffor native"
files:
  - src/codegen-linear/runtime.ts
  - src/ir/analysis/linear-memory-plan.ts
  - src/ir/array-element-inference.ts
  - src/ir/from-ast.ts
  - src/ir/backend/porffor/assembler.ts
  - tests/issue-3501-empty-array-element-inference.test.ts
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/backend/porffor/assembler.ts
---

# #3501 — Infer typed linear vectors from empty-array evidence

## Problem

The exact public landing program
`website/public/benchmarks/competitive/programs/array-sum.js` declares
`const values = []`, then establishes its element type through indexed numeric
writes and reads. After #3497 lands its JSDoc signature, the selector claims
`run`, but AST lowering rejects the initializer because the empty literal has
no vec-typed hint.

TypeScript reports the initializer itself as `never[]`, the declaration as
`any[]`, the early write receiver as `any[]`, and the later read receiver as
`number[]`. Lowering the initializer in source order therefore cannot infer the
element representation from the literal or declaration alone.

## Root cause and failed approaches to avoid

The existing #1804 path intentionally requires a vec hint before emitting
`vec.new_fixed([])`. Supplying a hard-coded f64 default would silently
miscompile mixed, escaping, or genuinely unresolved arrays. Rewriting the
source with a `number[]` annotation would bypass the shared front end and would
not solve aliases or branch joins. Building a benchmark-named IR module would
also evade the source-to-IR contract and allocation registry.

The evidence has to be closed before lowering while preserving the existing
allocation site. The backend must continue consuming that same source-derived
IR and `LinearMemoryPlan`; it must not introduce a Porffor-only array carrier.

## Implementation design

1. Add a function-local, path-insensitive array evidence pass. Build a
   may-alias graph for empty/non-empty literals, declarations, assignments,
   aliases, and conditional joins before collecting evidence.
2. Gather concrete element facts from the checker oracle, indexed writes,
   indexed reads, joined literals, and `.push`. Resolve only the currently
   supported `number -> f64` vector representation.
3. Reject conservatively when evidence contains multiple concrete kinds, an
   alias escapes through a return/call/capture/aggregate, a binding joins an
   external or non-array value, or no supported element fact closes the group.
   Diagnostics are stable and identify the source binding and rejection class.
4. Feed a resolved element type into the existing `vec.new_fixed` builder path
   and use the same inference fact at scalar linear-pointer read/write/length
   gates. Do not mutate the AST or mint a second allocation.
5. Bind the already-emitted grow-store/read/length operations in the Porffor
   adapter using the canonical vector layout and plan operations. The helper
   suffix must be the linear backend's supported f64 vector sentinel and the
   plan must contain exactly one matching allocation site; helper/layout or
   allocation ambiguity rejects instead of selecting the first site. Growth
   mirrors #1977 forwarding so aliases holding an old header continue to
   observe the relocated vector. Emit ordinary Porffor
   `Alloc`/`Load`/`Store`/control-flow nodes only; no `RawC`, native Porffor
   arrays, or benchmark cases.
6. Keep the relocation tag and replacement-pointer offset in one shared linear
   forwarding contract consumed by both direct linear Wasm and Porffor. Assert
   that the forwarding record fits before the planned vector fields. Inferred
   linear reads must carry the existing counted-loop in-bounds proof; otherwise
   they demote instead of choosing a backend-specific OOB sentinel. The
   generated getter still uses NaN defensively for OOB f64 reads.
7. Prove the helper independently with alias/join and mixed/escape/unresolved
   tests, prove planned growth/forwarding with a small source-derived vector
   program, then run the untouched public source through Node, WasmGC, linear
   Wasm, source-derived Porffor IR, C, ASan, and UBSan.

## Downstream note

The first exact Porffor probe exposed typed JS bitwise composites
(`js.shr_u`, `js.bitxor`, `js.bitand`, `js.bitor`) as an independent legality
gap. That work belongs to #3499 and its owned files; #3501 does not duplicate or
modify that lowering. #3499 landed in `origin/main` at `946ec0e8`; the final
exact-source native validation below ran only after merging that commit.

## Acceptance criteria

- [x] One numeric element type is inferred from checker/read/write evidence
      across local aliases and joins.
- [x] Mixed, escaping, externally joined, and unresolved empty arrays remain
      conservative with stable diagnostics.
- [x] The inferred literal uses the allocation registry and canonical
      `LinearMemoryPlan` vector layout/operations.
- [x] WasmGC and linear Wasm execute the exact public source with Node-equal
      results, including vector growth beyond initial capacity.
- [x] Focused source-derived Porffor tests prove allocation, indexed growth,
      alias forwarding, reads, and length independently without `RawC`.
- [x] Non-f64 helper suffixes, a second same-layout allocation, and unproven
      OOB reads reject conservatively with focused coverage.
- [x] Direct linear Wasm and Porffor consume the same asserted forwarding
      record contract; the adapter contains no duplicated tag/offset literals.
- [x] The exact public source renders through landed #3499 Porffor lowering and
      executes Node-equal native C under ASan/UBSan.
- [x] Focused/regression checks, typecheck, lint, formatting, and repository
      policy checks pass on the final merge of `origin/main`.

## Test results

- Final implementation base: merged `origin/main@946ec0e8` (#3499) in branch
  merge `aedc71500` with no conflicts or edits to #3499-owned files.
- Queue syncs: merged `origin/main@0f1a599e8` (#3448) in `e0d9a5521`,
  `origin/main@2c68ef348` (#3437) in `8c7bf544e`, and
  `origin/main@f5ce10d05` (#3450) in `7c2414713`; none conflicted with or
  changed the seven-file #3501 delta, and the exact acceptance suite remained
  green after the final adjacent IR-selection change.
- `JS2WASM_PORFFOR_ROOT=../3482-direct-porffor-ab/vendor/Porffor
PORFFOR_NATIVE_REQUIRED=1 PORFFOR_NATIVE_SANITIZERS=1 pnpm exec vitest run
tests/issue-3501-empty-array-element-inference.test.ts --pool=forks
--poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose`
  — 10/10 passed. The source-derived vector probe and the untouched public
  `array-sum.js` (441 bytes, SHA-256
  `61affa6e44688788cfdb50f5186078cb55c171f19df2bb104e2dcb9f331cd59c`)
  both rendered to C and exited cleanly under combined ASan/UBSan with no
  sanitizer diagnostics. Exact Node/WasmGC/linear-Wasm/Porffor-native outputs
  were `0 -> 0`, `17 -> 2314`, `2000 -> 1018392`, and
  `1000000 -> 511492320`.
- Adjacent vector/linear/Porffor regression command covering 11 focused files
  — 81 passed, 6 optional-native tests skipped.
- `pnpm run typecheck`, `pnpm run lint`, and `pnpm run format:check` — passed.
- `pnpm run check:ir-fallbacks` — passed with no unintended/post-claim increase.
- `pnpm run check:linear-ir` — passed; compiled units improved from 8 to 10.
- `pnpm run check:loc-budget` and `pnpm run check:issues` — passed.

## Landed-main baseline observed

The broad adjacent run also included `tests/issue-1977.test.ts`; two landed-main
relocation-value assertions failed (`69` expected / `24` received and `40`
expected / `16` received). The same two failures reproduce on the clean landed
#3499 worktree at `2a0e9da29`, without any #3501 files. #3501 therefore records
the upstream baseline and does not broaden into the independently owned direct
linear lowerer/runtime behavior. Its own source-derived forwarding/growth probe
passes in linear Wasm and sanitized Porffor native execution.
