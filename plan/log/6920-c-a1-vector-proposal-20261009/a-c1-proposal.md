> **Published copy (Session C, 2026-10-09).** The commits `5f77adb3`/`29302414` named below exist only in C's ephemeral container and are not on GitHub. Apply `a-c1-proposal.patch.txt` in this directory instead: `git apply plan/log/6920-c-a1-vector-proposal-20261009/a-c1-proposal.patch.txt` on base `dbf5b4f7` (sha256 `f996f77c…b977`, 81,471 bytes). Verified by C on publish: patch sha matches, `npm run typecheck` exit 0, new test 13/13, `issue-3518-lowering-cycle` fails exactly as described in gate 1. This is a private proposal; no source file on any branch was changed.

# A-C1 private proposal — generic vector representation contract (#6920)

Author: Session C Opus implementer (Claude Opus 5.5, High). Private, unpushed. Spec: Session A's adopted plan (`.tmp/a-c1-plan.md`, author Codex Astra), scope = "C implementation hunks" + "Necessary frontend compatibility joins" + "C contract and shared-lowering tests". A-C caller work (program-consumer / program-native-invocation / program-physical-plan / B resources) is NOT implemented.

- Base: canonical main `dbf5b4f74b37d67e525b2af36fd1fe49803b1348`.
- Worktree/branch actually used: `/home/user/js2/.claude/worktrees/agent-a774506d6593a2d93`, branch `worktree-agent-a774506d6593a2d93`. The harness isolated this agent there and refused git operations against `c-a1-vector-proposal-private`. Both are in the same repo, so ROOT can `git cherry-pick 5f77adb3 29302414` or apply the patch.
- Commits: `5f77adb3` (contract + joins + test), `29302414` (makes the new module a type-only value-graph leaf).
- Patch: `.tmp/proposal-out/a-c1-proposal.patch` = `git diff origin/main..HEAD`, 81,471 bytes, sha256 `f996f77cecef909b4da59e5bc7118af379390b6cdc32763212b7ec423020b977`. 16 files, +1076/−141.

## What is implemented, and where

| Plan hunk | Where (file :: function) | What changed |
|---|---|---|
| handles.ts vector declarations | `src/ir/backend/handles.ts` :: `IrVecLowering`, `LinearVecLowering`, new `IrI32ValType`, new `IrVecBackendLowering` | GC handle unchanged (doc only). `LinearVecLowering` now has a required `valueType: IrI32ValType` and no GC fields. `IrVecBackendLowering = IrVecLowering \| LinearVecLowering`. |
| New vector-representation.ts | `src/ir/backend/vector-representation.ts` (new, 240 lines, type-only imports) | `IrVecRepresentation` (`wasmgc` / `linear-memory`), separate `IrVecCarrier`, one `resolveIrVecRepresentation(input, "carrier" \| "operation")` implementing rules 1–6, backend-kind mapping (`wasmgc`→wasmgc; `linear`, `porffor`→linear-memory; `bytecode`→none), GC/linear guards, and frontend helpers `irVecHandleCarrier`, `irVecHandleDataType`, `irVecGcLowering`. |
| lower-contracts.ts 132–150 | `src/ir/backend/lower-contracts.ts` :: `IrLowerResolver.resolveVec`, `.resolveVecForElement`; import + reexport | Return type widened to `IrVecBackendLowering`, plus docs. No other fields touched. ROOT's dirty primary copy must take only these hunks. |
| emitter/contract/conformance/lower.ts aliases | `backend/emitter.ts` (`VecLayout` alias + `emitVecNewFixed` scratch doc), `backend/contract.ts` + `lower.ts` (reexport), `backend/contract-conformance.ts` (`StubVecLayout`) | Type-only. No new dispatcher. |
| lower-generic.ts `resolveVecType` | `src/ir/lower-generic.ts` :: `lowerIrFunctionBody` → `resolveVecType` | Delegates to the helper with `purpose: "operation"` and `emitter.backend`. GC layout-backed order is unchanged: carrier, carrier, data. |
| lower-generic.ts scratch helpers | `lowerIrFunctionBody` → `ensureVecDataScratch` | Allocates from `newFixedScratchType`, keyed by `kind:type.kind:typeIdx`. GC keeps `$vec_data_<arrayTypeIdx>`, one local per array. Linear uses one i32 local named `$linear_vec_ptr_<localIndex>`, the exact name the deleted rewrite produced, so linear binaries stay byte-identical too. |
| lower-generic.ts vector arms | `vec.len/get/set/set_length/new_fixed`, `forof.vec` | Pass `representation.lowering`. Operand order and the integer-length conversion are unchanged. |
| lower-generic.ts `lowerIrTypeToValType` + internal calls | `lowerIrTypeToValType(t, resolver, funcName, backend = "wasmgc")` and a local `toValType` in `lowerIrFunctionBody` | The vec arm uses `purpose: "carrier"` and does not add a data-array lookup. All 6 internal calls go through `toValType` and pass `emitter.backend`: local allocation, `resolveVecType` element, the null-vec const, `if` result, box operand, and `vec.new_fixed` element. Nested element recursion passes the backend. |
| wasm-lowering.ts | `wasmValueTypeConverter` | Passes its `backend`. |
| linear-emitter.ts | `LinearEmitter` | Removed `vecScratchLocals` and `getVecScratchLocalIndices()`. The vector algorithms are unchanged. |
| linear-integration.ts | `makeLinearIrResolver` → `f64VecHandle`, `resolveVec`, `resolveVecForElement`; `linearValueTypeConverter`; `compileLinearIrFunctions` locals | Genuine `LinearVecLowering`. The vec arm of the converter uses shared carrier resolution. The post-hoc scratch rewrite is deleted and locals are flattened verbatim. Producer, planner and lifetime logic are untouched. |
| porffor assembler + sink | `backend/porffor/assembler.ts` :: `f64VecHandle`, `resolveVec`, `resolveVecForElement`; `backend/porffor/sink.ts` :: `VecLayout` alias | Genuine linear handle. The `__vec_elem_set_<n>` compatibility parser and `PORFFOR_LINEAR_F64_VEC_TYPE_INDEX` are kept: `tests/issue-3501` pins that rejection, and only the comment changed. |
| from-ast.ts joins | `ResolvedIrVecType`, `resolveIrVecType`, `vecElemSetProviderSymbol`, `vecNewSizedProviderSymbol`, `IrFromAstResolver.resolveVec/resolveVecForElement`, `lowerArrayLiteral` (2 carrier sites), `lowerForOfVec` data slot | Shared union and helpers. GC struct-suffixed names are used only for an authenticated GC handle. Linear physical handles use `irVecElemSetSymbol(irVal(element))`, which the linear resolver already maps to `__arr_set`. The for-of data slot is GC `ref $array` or linear i32. The resolver-absent heuristic fallback is unchanged. No `as IrVecLowering` casts. |
| array-element-lowering.ts joins | `ArrayElementResolver`, `isNarrowedI32Vec`, `tryLowerVecPush` symbol | Same treatment as from-ast. The 401–411 carrier read works unchanged on the union. |
| prepared-vector-support.ts / integration.ts GC resolvers | not touched | They stay GC-only with their narrower annotations. |

## Where the plan was wrong or underspecified, and what I did

1. **Linear scratch name.** The plan says "real i32 local from the start" but gives no name. I used `$linear_vec_ptr_${locals.length}`, which equals the old rewrite's index. With it, all 15 linear probe binaries are byte-identical, not just the GC ones.
2. **Porffor scratch slot.** The vec scratch logical type is now `irVal(i32)`, as the plan specifies, so `PorfforTypeConverter` gives the unused scratch local an `"i32"` slot instead of the `"ptr"` it got through its `ref/ref_null` arm. Porffor's `emitVecNewFixed` ignores the scratch. All Porffor tests are unchanged, but the C-side declared local type differs. If ROOT wants `ptr`, the alternative is `logicalType: <vec IrType>`, which deviates from the plan.
3. **Linear allocation checks.** The plan says to bind "exactly that row" for native and to keep the overlay's first-allocation policy. The helper enforces: if the handle carries an allocation, it belongs to the layout, and when `alloc` is requested it is that row. It does not require `alloc`, so the overlay policy keeps working. Requiring the native construction ID is A-C's resolver job (program-consumer).
4. **Converter strictness.** `linearValueTypeConverter` used to map every `vec` to i32. It now goes through the resolver capability (f64 only) and throws the existing `cannot carry` error for other elements or a GC layout. No test or probe changed.
5. **Bytecode backend.** It has no vector representation, so the helper returns null and callers throw their established "resolver cannot lower vec" errors. Legality already rejects vec ops there.
6. **`program-native-invocation.ts:242`** (out of scope) already calls `wasmValueTypeConverter(backend, …)`. Because the backend now reaches vec conversion, a native Linear body with vector types will hit a representation mismatch against program-consumer's GC handles instead of quietly producing GC ref types. That fails closed. The A-C caller patch replaces it. No test in the measured set reaches it: `issue-3518-prepared-native-main-lowering` 14/14 before and after.

## Files mapped to the plan's ownership regions

| File | Plan region / owner (per plan table) | Release needed |
|---|---|---|
| `src/ir/backend/handles.ts` | C row "backend/handles.ts vector declarations" | exact hunks @181, @438, @446, @461 |
| `src/ir/backend/lower-contracts.ts` | C row (preserve ROOT's dirty fields) | import/reexport @25/@37, resolver docs/types @136–@152 |
| `src/ir/backend/vector-representation.ts` | C row "New" | new file; boundary row owned by ROOT policy owner (see below) |
| `src/ir/backend/{emitter,contract,contract-conformance}.ts`, `src/ir/lower.ts` | C row "type-only aliases/reexports" | type-only hunks |
| `src/ir/lower-generic.ts` | C rows 950–972, 843–868, 2316–2370/2514, 4016–4027 (shared vector 2956:l2-vec region) | hunks listed in the patch (resolveVecType, scratch, arms, forof.vec, lowerIrTypeToValType, internal calls, `toValType` @342) |
| `src/ir/backend/wasm-lowering.ts` | C row 21–30 | 1 line |
| `src/ir/backend/linear-emitter.ts` | C row 160–167, 349 | 2 hunks |
| `src/ir/backend/linear-integration.ts` | C row 1605–1618, 1915–1939, 2175–2183, 2362–2378 (inside Broad Linear 4540 owner's file) | 6 hunks, none outside those functions |
| `src/ir/backend/porffor/assembler.ts`, `porffor/sink.ts` | C row Porffor 1291–1315, 522–526 + sink alias | 5 + 2 hunks |
| `src/ir/from-ast.ts` | frontend joins (companion owner) | 8 hunks at 197/288/318/350/559/5436/5611/12135 |
| `src/ir/array-element-lowering.ts` | frontend joins | 3 hunks |
| `tests/issue-6920-vector-representation.test.ts` | C contract tests | new file |

No changes to `program-consumer.ts`, `program-native-invocation.ts`, `program-physical-plan.ts`, B's `src/backend/linear/program/{contracts,memory}.ts`, `src/codegen-linear/runtime*`, `prepared-vector-support.ts`, any `scripts/*.json`, or any test other than the new one. No JS-host imports, no new dispatcher, no copied provider bodies.

## Measured before / after (this run)

Before = pristine `dbf5b4f7` tree. HEAD was moved to base for the git-reading suites. After = final HEAD `29302414`, except where noted.

| Check | Before | After |
|---|---|---|
| `npm run typecheck` (TS7 lane, tsconfig.ts7.json) | exit 0 | exit 0 |
| GC byte identity: 16 vector fixtures + 13 playground examples, target gc | 29 binaries | 29/29 identical sha256 |
| standalone (same 29 sources) | 29 binaries | 29/29 identical |
| linear (same 29 sources) | 15 binaries, 14 no-binary | 15/15 identical, same 14 no-binary |
| probe determinism (base run twice) | identical | — |
| probe non-vacuity (IR on vs `experimentalIR:false`) | 12/16 fixtures differ in gc and standalone; `$vec_data_` scratch present; 9 linear fixtures contain `$linear_vec_ptr_` | — |
| Required test set (32 files incl. ir-vec-new-fixed, ir-vec-two-backend, 2956, 6893×2, 6921, Porffor 3297/3299/3300/3478/3482/3499/3500/3501/3502, vec/handle consumers) | 14 failing tests in 7 files | identical failure set and counts (measured at `5f77adb3`; the final commit only inlines `asVal`) |
| Re-run at final HEAD (11 files) | — | same as above; 6920 13/13 |
| Source-reading suites (23 files) | 158 failing tests in 7 files, plus 6915 exit 1 with all 36 skipped | identical except the one new failure below (measured at `5f77adb3`; that failure re-confirmed at final HEAD) |
| New `tests/issue-6920-vector-representation.test.ts` | n/a | 13/13 pass |
| `check-loc-budget` (merge-base and `LOC_GATE_BASE=dbf5b4f7`) | — | exit 0. lower-generic 4247→4237 (−10), linear-integration 2376→2374 (−2), from-ast 16761→16760 (−1); net +253 src lines, all in the new module plus small joins |
| `check-func-budget` (both bases) | — | exit 0. An earlier draft put `emitInstrTree` at 2330 > 2329; fixed |
| `check-coercion-sites` | — | exit 0 |
| `check:oracle-ratchet` | — | exit 0 |
| `check:dead-exports` | — | exit 0 |
| `check:ir-fallbacks` | exit 0 | exit 0, report identical |
| `check-compiler-boundaries --mode inventory` | exit 0 (no `--base`) | **exit 1** (with `--base dbf5b4f7`, CI's mode): new module unclassified |
| `node scripts/equivalence-gate.mjs` | not run on base | exit 0: 22 failing = 22 known baseline failures, 1748 passing (floor 1740), "No new equivalence regressions" |

Failures present on base and unchanged after (not caused by this change):
- `issue-2956` ×3
- `issue-3499` ×2
- `issue-3500` ×3
- `ir-backend-emitter` ×1 (Promise struct.new)
- `issue-3518-logical-vector-lowering` ×1
- `issue-3518-vector-grow-store-donor` ×3
- `issue-4566` ×1
- `issue-2856-builtins-component` ×3
- `issue-3497` ×1
- `issue-3518-native-family-source-contract` ×8
- `issue-3518-native-string-no-demand-emitter-forward` ×8
- `issue-3518-typed-async-preparation` ×3
- `issue-3518-wasmgc-helper-policy-evolution` ×134
- `issue-6915` (36 skipped, exit 1)

## Gates and pinned tests deliberately left unfixed (Session A / ROOT)

1. **`tests/issue-3518-lowering-cycle.test.ts` › "resolves the real transitive value graph without a wrapper/emitter/facade cycle"** (passes on base, fails after). Verbatim:
   ```
   AssertionError: expected [ …(34) ] to deeply equal [ …(33) ]
   +   "src/ir/backend/vector-representation.ts",
    ❯ tests/issue-3518-lowering-cycle.test.ts:199:27  expect(graph.modules).toEqual([
   ```
   Required pin successor, not applied: add module `src/ir/backend/vector-representation.ts`; add edge `src/ir/lower-generic.ts -> src/ir/backend/vector-representation.ts` after the `-> src/ir/backend/legality.ts` edge, in import order; change the generic out-edge count from 13 to 14. Commit `29302414` makes the module a type-only leaf so this is the whole delta.
2. **`check-compiler-boundaries --mode inventory --base <main>`** exit 1:
   ```
   compiler-boundaries: invalid-inventory (mode=inventory, exit 1)
     unclassified-module: src/ir/backend/vector-representation.ts
     unclassified-target: src/ir/backend/vector-representation.ts   (×4: lower-generic, linear-integration, from-ast, array-element-lowering)
   ```
   Needs a `scripts/compiler-boundaries.json` row from ROOT's policy owner. A suggestion consistent with its siblings: `{ "path": "src/ir/backend/vector-representation.ts", "state": "unmigrated", "layer": "mixed-needs-split", "destination": "ir-core", "owner": "3518-coordinator", "nextBoundary": "Pure vector representation contract (type-only imports); consumed by generic lowering, linear overlay and frontend joins." }`. Not edited.
3. **`tests/issue-3299.test.ts`**: the optional linear+Porffor proof (`optionalIt`, skipped here because there is no `vendor/Porffor` or C toolchain) still builds fake `IrVecLowering & LinearVecLowering` handles without `valueType`, and calls the removed `emitter.getVecScratchLocalIndices()`. When enabled it will fail with a representation mismatch or TypeError. Suggested fixture hunk, not applied:
   - drop the GC zero fields and add `valueType: { kind: "i32" }` in `linearResolver().vec`;
   - delete the `vecScratch` retyping, since locals are now correct.

## Remaining A-C work (not implemented here)

The plan's "Required A-C caller implementation" items 1–6 remain:
- accepted source/projection (A1/A2/J3);
- `program-consumer.ts::physicalSignatureConverter` and `::physicalBodyResolver` backend-specific vector views, with exact-allocation authentication on construction;
- `fillPrimaryBody` / `program-native-invocation.ts::fillPreparedPrimaryUnit` carrying a bound Linear emitter;
- `program-physical-plan.ts` resource gap;
- B lifetime joins.

The Gate 2 public native execution tests are also not done. This proposal covers the representation contract and the C-scope readers only. It does not claim native program support or the complete source handoff.
