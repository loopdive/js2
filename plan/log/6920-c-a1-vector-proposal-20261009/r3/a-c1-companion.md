> **Published copy (Session C, 2026-10-10).** Companion to A-C1 r2. Commit `cccd8c08` exists only in C's container. Apply `a-c1-composed-r3.patch.txt` on `dbf5b4f7` (sha256 `f2738b50…b86a`, 96,090 bytes; `git apply --check` passes), or `a-c1-companion.patch.txt` (sha256 `69acd811…2aae`, 6,490 bytes) on top of r2. `SHA256SUMS.txt` hashes the original layout: patches are stored as `.patch.txt`, files over 500 KB are in `raw-large.tar.gz` (sha256 `13682b9e…d922`). Verified by C on publish: both patch hashes, `sha256sum -c`, lowering-cycle + 6920 tests 43/43, compiler-boundaries inventory `--base dbf5b4f7` exit 0, typecheck exit 0.

# A-C1 companion: the three Session A-owned gaps (private proposal)

This patch closes the three gaps A-C1 r2 left open, so Session A can review one composition with every gate green.

| Item | Value |
|---|---|
| Status | Private, unpushed: no PR, no claims, no posts. All three files belong to **Session A**; this is a proposal for A to apply, not an authorized edit. |
| Commit | `cccd8c08` on top of r2 `2944307a`. Branch `worktree-agent-a774506d6593a2d93`. |
| HEAD | `cccd8c087fa90e21860959ddf7ce5decfb556983` |
| `a-c1-companion.patch` | `git diff 2944307a..HEAD`. 6,490 bytes, sha256 `69acd8110632602b5e9eaf84aafbcd1111d53448e7d3193a9f59f21096752aae`. 3 files, +19/−25. |
| `a-c1-composed-r3.patch` | `git diff dbf5b4f7..HEAD`. 96,090 bytes, sha256 `f2738b50c3832989d4f0c338b048037c9d3bcaa54922493cd3fcf9205765b86a`. 19 files, +1266/−165. |
| Environment | `raw/environment.txt`: node v22.22.0, pnpm-lock sha256 `6a8b59fd…f2ac` |

## Hunks (owner: Session A)

| File :: test / row | Change | Evidence |
|---|---|---|
| `tests/issue-3518-lowering-cycle.test.ts` :: "resolves the real transitive value graph without a wrapper/emitter/facade cycle" | One comment line naming the predecessor pin (33 modules / 13 generic out-edges, 6920 A-C1). Adds module `src/ir/backend/vector-representation.ts` after `src/ir/backend/legality.ts`, in sorted position. Adds edge `src/ir/lower-generic.ts -> src/ir/backend/vector-representation.ts` after `src/ir/core/types.ts -> src/ir/core/binding-key-primitives.ts` (actual closure index 6). Changes `toHaveLength(13)` to `toHaveLength(14)`. No other row or test touched. | Lists derived from the real `valueClosure()` output, `raw/valueClosure-head.json`, captured by a gitignored copy of the test (`raw/harness/r3-mkprobe.py.txt`). Pin-vs-actual diff: `raw/pin-diff-before-edit.txt` (34 vs 33 modules, 38 vs 37 edges, 14 vs 13) and `raw/pin-diff-after-edit.txt` (all equal). |
| `scripts/compiler-boundaries.json` :: `files[]` | Exactly one row, inserted textually after its sibling `src/ir/backend/string-contract.ts` and before the `wasm-*` rows: `path src/ir/backend/vector-representation.ts`, `state unmigrated`, `layer mixed-needs-split`, `destination ir-core`, `owner 3518-coordinator`, plus a `nextBoundary` sentence. `allowedEdges` and all other rows are unchanged; the JSON stays prettier-clean. | Field values match the 13 `unmigrated / mixed-needs-split / ir-core / 3518-coordinator` sibling rows and the checker's vocabulary (`scripts/check-compiler-boundaries.mjs`: `state` ∈ unmigrated/clean/compatibility-adapter; `mixed-needs-split` needs owner, nextBoundary and a known destination layer). |
| `tests/issue-3299.test.ts` :: `linearResolver().vec`, `resolveVec`, `resolveVecForElement`, `instantiateLinearProof` locals, handles import | The fake GC fields are dropped and `valueType: { kind: "i32" }` added, so the fixture returns a genuine `LinearVecLowering`. The `getVecScratchLocalIndices()` retyping is deleted and locals are flattened verbatim. `IrVecLowering` import removed. | See the 3299 notes below. |

## 3299 notes

- **The full optional linear+Porffor-C proof was NOT executed.** This environment has no `vendor/Porffor` and no C toolchain, and neither was installed. In `tests/issue-3299.test.ts` it reports as skipped: `raw/head-gates/issue-3299.txt`, 1 passed / 1 skipped.
- **The linear-Wasm half was executed through a probe.** `.tmp/probe-3299-linear.test.ts` (source in `raw/harness/`) is a verbatim copy of the edited test plus one test that runs `instantiateLinearProof` with the edited `linearResolver`. It needs no Porffor and expects the JS-oracle values `[911, 309, 300, 300]`.
  - Edited fixture: passes (`raw/probe-3299-linear-head.txt`).
  - Negative control, the same probe built from the unedited r2 test: fails with `TypeError: emitter.getVecScratchLocalIndices is not a function` (`raw/probe-3299-linear-unedited-fixture.txt`).
- **Typecheck of the test files.** These were checked with `tsconfig.ts7.json` plus the three test files, since the project lane excludes `tests/`.
  - Edited (`raw/typecheck-tests-head.txt`): the two 3299 errors from r2 are gone, namely `getVecScratchLocalIndices` does not exist, and the intersection type is not assignable.
  - Unedited (`raw/typecheck-tests-r2-unedited.txt`): has both of those errors.
  - Both sides keep the same pre-existing errors: `WebAssembly.instantiate` `.instance` typing in 3299 and in the 6920 test, plus three in lowering-cycle at the old lines 392/400/508 (395/403/511 after the 3 inserted lines).
  - The project typecheck lane itself exits 0.

## Gates: base `dbf5b4f7` vs HEAD `cccd8c08`

All exits are in `raw/{base,head}-gates/gate-exits.txt` and side by side in `raw/gate-exits-base-vs-head.txt`.

| Gate | Base | HEAD | Raw |
|---|---|---|---|
| typecheck (project lane) | 0 | 0 | `*/typecheck.txt` |
| loc-budget (merge-base / `LOC_GATE_BASE=dbf5b4f7`) | 0 / 0 | 0 / 0 (net +283) | `*/loc-budget*.txt` |
| func-budget (both bases) | 0 / 0 | 0 / 0 | `*/func-budget*.txt` |
| coercion-sites | 0 | 0 | `*/coercion-sites.txt` |
| oracle-ratchet | 0 | 0 | `*/oracle-ratchet.txt` |
| dead-exports | 0 | 0 | `*/dead-exports.txt` |
| check:ir-fallbacks | 0 | 0 | `*/ir-fallbacks.txt` |
| compiler-boundaries `--mode inventory --base dbf5b4f7` | 0 | **0** (r2: 1) | `*/compiler-boundaries-inventory-base.txt` |
| compiler-boundaries `--mode inventory --base HEAD^1` (CI's `quality` job form) | 0 | 0 | `*/compiler-boundaries-inventory-headparent.txt` |
| compiler-boundaries `--mode inventory` (`check:compiler-boundaries:inventory`) | 0 | 0 | `*/compiler-boundaries-inventory-nobase.txt` |
| compiler-boundaries default/complete mode (`check:compiler-boundaries`; not run by CI) | 1 | 1, same verdict `inventory-valid-architecture-incomplete` | `*/compiler-boundaries-complete-default.txt`, `raw/diff-compiler-boundaries-complete-default.txt` |
| 3518 lowering-cycle (full file) | 0 (25/25) | **0 (25/25)** (r2: 1) | `*/lowering-cycle-3518.txt` |
| issue-3299 | 0 (1 pass, 1 skip) | 0 (1 pass, 1 skip) | `*/issue-3299.txt` |
| 6920 test | n/a (file absent at base) | 0 (18/18) | `head-gates/issue-6920.txt` |

The complete-mode diff (`raw/diff-compiler-boundaries-complete-default.txt`) differs only by revision/hash fields, file count 1899→1900, and the new module's import rows.

## Test sets: failing-test diff against base

| Set | Base failing | HEAD failing | Diff |
|---|---|---|---|
| 23 source-reading suites (`raw/list-source-reading-23.txt`) | 158 | 158 | empty: `raw/diff-failing-source-reading-23.txt`, `raw/diff-summary-source-reading-23.txt` |
| 33 tests that read `compiler-boundaries.json` (`raw/list-boundaries-json-readers.txt`) | 2785 in 26 files | 2785 | empty: `raw/diff-failing-boundaries-json-readers.txt`, `raw/diff-summary-boundaries-json-readers.txt` |

Per-test records are in `raw/{base,head}-*/` and `failing-tests.txt`.

**Does anything pin this JSON's hash?** 25 of the 33 reader tests mention a hash, sha256 or blob. None of them goes from pass to fail with the new row: the failing sets are identical, and every reader test that passes on base also passes on HEAD. The 2785 failures fail identically on unmodified base. So I found no executable test that pins the JSON hash, and there was no failure to record.

## Remaining

- The full linear+Porffor-C proof in 3299 remains unexecuted here.
- The equivalence gate was not re-run; this companion changes no `src/`. The r1 result is in `../proposal-out-r2/raw/r1/after-equivalence.txt`.
- The A-C caller work (plan items 1–6) is unchanged and out of scope.
