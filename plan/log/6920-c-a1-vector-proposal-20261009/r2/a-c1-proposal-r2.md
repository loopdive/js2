> **Published copy (Session C, 2026-10-10).** Revision 2. Commits `5f77adb3`/`29302414`/`2944307a` exist only in C's container; apply `a-c1-proposal-r2.patch.txt` on base `dbf5b4f7` (sha256 `6b803921…4ec6`, 89,600 bytes; `git apply --check` passes). Layout changes vs `SHA256SUMS.txt` (which hashes the original files): `*.patch` are stored as `*.patch.txt`; every file over 500 KB (listed in `raw-large.MANIFEST.txt`, mostly 11 MB compiler-boundaries dumps and 2 MB test logs) is inside `raw-large.tar.gz` (sha256 `3b9159de…7ff4`), so `tar -xzf raw-large.tar.gz && sha256sum -c SHA256SUMS.txt` reproduces the full check after renaming the patches back. Verified by C on publish: cumulative/delta patch hashes match `git diff`, `sha256sum -c` passed on the original directory, new test 18/18, `npm run typecheck` exit 0.

# A-C1 private proposal, revision 2 — generic vector representation contract (#6920)

Private and unpushed: no PR, no claims, no edits to `scripts/*.json`, `tests/issue-3518-*` pins or out-of-scope files. The scope is unchanged from r1 (`raw/r1/a-c1-proposal.md`). This revision applies the two bounded corrections from Session A's Astra review of the r1 patch (sha256 `f996f77c…b977`). The r1 commits are kept unchanged and one commit is added on top.

| Item | Value |
|---|---|
| Worktree / branch | `/home/user/js2/.claude/worktrees/agent-a774506d6593a2d93`, branch `worktree-agent-a774506d6593a2d93`. The harness isolated this agent there; it shares the repo with `c-a1-vector-proposal-private`. |
| Base | `dbf5b4f74b37d67e525b2af36fd1fe49803b1348` |
| Commits | `5f77adb3` (r1), `29302414` (r1 leaf), **`2944307a` (r2)** = HEAD `2944307a4a1291a74893c346f46f128e27e176b2` |
| Cumulative patch | `a-c1-proposal-r2.patch` = `git diff dbf5b4f7..HEAD`. 89,600 bytes, sha256 `6b80392132d71e5fb4bf15c23334867aa0607ee85535eae80cc44648b0fd4ec6`. 16 files, +1247/−140. |
| r2 delta | `a-c1-r2-delta.patch` = `git diff 29302414..HEAD`. 14,519 bytes, sha256 `a3646d120041718a7d335caf0d8b52545af87b8e70d96bdae3bc1099dc8d2508`. 3 files, +181/−9. |
| Environment | `raw/environment.txt`: node v22.22.0, pnpm 10.30.2, vitest 3.2.7. pnpm-lock sha256 `6a8b59fd…f2ac`, identical at base and HEAD. |
| Exact commands | `raw/commands.txt`. Harness scripts are copied verbatim in `raw/harness/`. |

## Revision 2 — the two corrections

### 1. All four GC-only fields are rejected on a linear handle

- **`src/ir/backend/vector-representation.ts::requireLinear`** now loops over a new module constant, `GC_ONLY_FIELDS = ["vecStructTypeIdx", "arrayTypeIdx", "lengthFieldIdx", "dataFieldIdx"]`.
  - Any of these fields on a linear-memory handle throws `ir/lower: vec representation mismatch: linear-memory vector handle carries WasmGC field '<name>' (<where>)`.
  - In r1 only the first two fields were checked.
- **Test** `"linear rejects each single GC-only field grafted onto the genuine handle"`:
  - It starts with the positive control: the genuine handle resolves to `linear-memory`.
  - It then builds separate mutants of the genuine handle with only `lengthFieldIdx`, only `dataFieldIdx`, only `vecStructTypeIdx`, and only `arrayTypeIdx`. Each must throw naming its field.
  - The existing intersection-handle assertion now expects the field-specific message.

### 2. One shared outer preflight runs before element conversion

- **New `src/ir/backend/vector-representation.ts::preflightIrVecRepresentation(backend, type, where)`.**
  - This is the single outer-representation policy. It returns `null` when the backend has no vector representation.
  - It throws rule 4 (`<backend> backend received a WasmGC-prepared vector layout`) when a vec carrying a GC layout reaches a linear-memory backend.
  - It performs no resolver calls.
- **`resolveIrVecRepresentation`** calls it first. The duplicated rule-4 check that used to sit inside the layout branch is removed, so the policy exists in exactly one place.
- **`src/ir/lower-generic.ts`, `lowerIrFunctionBody` → `resolveVecType`**: calls the preflight before `toValType(type.elementType)`. A `null` result keeps the caller's established "resolver cannot lower vec" error.
- **`src/ir/lower-generic.ts::lowerIrTypeToValType`, vec arm**: calls the preflight before the recursive element conversion. A `null` result throws the existing `ir/lower: resolver cannot lower vec IrType (<fn>)`.
- No per-operation callbacks were added. The GC paths and their lookup order are unchanged.

**Tests**, in `describe("#6920 vector representation — outer preflight precedes element conversion")`. The fixture is a linear vec whose outer IrType carries a GC layout and whose element is a ref-typed `support-ref`. The resolver throws on every method and counts each call.

| Test | Route | Result |
|---|---|---|
| public converter | `lowerIrTypeToValType(…, "linear")`, `wasmValueTypeConverter("linear", …).convertType`, and `lowerIrTypeToValType(…, "porffor")` | each throws the preflight message; recorded calls `[]` |
| generic body route, f64 element | `lowerIrFunctionBody` with a `vec.len` on a parameter whose type is that GC-layout vec but with an f64 element; asserts `verifyIrBackendLegality(func,"linear")` is `[]`, so lowering really reaches `resolveVecType` | preflight message; calls `[]` |
| generic body route, support-ref element | `lowerIrFunctionBody` on the support-ref-element vec | rejected with calls `[]` (see note) |
| GC positives | `wasmValueTypeConverter("wasmgc")` on a layout-backed vec, then `resolveIrVecRepresentation(…, "operation")` | carrier route: exactly `["carrier"]`; operation route: `["carrier","carrier","data"]` |

The earlier GC carrier-order and operation-order tests are still present and pass.

**Note on the body route (a precise limitation, not a gap in the fix).** Linear backend legality (`analysis/backend-legality.ts::backendTypeError`) rejects every non-f64 vec element before lowering begins. So on the generic body route, a ref-typed support element cannot reach element conversion. The zero-call assertion there is the observable guarantee. The f64 body test proves the preflight fires inside `resolveVecType`. However, an f64 element never calls the resolver, so on this route the ordering cannot be told apart from r1 behaviour. The ordering difference is only observable on the public converter route.

**Non-vacuity A/B** (`raw/ab-r1-source-with-r2-tests.txt`): r1's `vector-representation.ts` and `lower-generic.ts` were run under the r2 test file and then restored (cmp-verified). Result: 3 failed, 15 passed.
- Failed: the single-field mutant test, the public-converter preflight test (r1 calls `resolveType` for the support-ref element first), and the intersection test (new message text).
- Both body-route tests pass on r1 as well, for the reason in the note above.

## Results — every number points to its raw record

| Measure | Base `dbf5b4f7` | HEAD `2944307a` | Raw record |
|---|---|---|---|
| typecheck (TS7 lane) | exit 0 | exit 0 | `raw/{base,head}-gates/typecheck.txt`, `gate-exits.txt` |
| GC binaries, 16 fixtures + 13 playground examples | 29 | **29/29 identical sha256** | `raw/probe-identity.tsv`, `raw/probe-identity-summary.tsv` |
| standalone binaries | 29 | **29/29 identical** | same |
| linear binaries | 15 binaries + 14 NOBINARY | **15/15 identical**; same 14 NOBINARY | same |
| IR-path witness: binary differs from `experimentalIR:false` (head) | gc 25, standalone 22, linear 0 | identical to base | `probe-identity.tsv` `ir_vs_legacy_head`, `witness_same_as_base` = 29/29 per target |
| `$vec_data_` / `$linear_vec_ptr_` present in WAT | gc 18, standalone 18, linear 8 | identical | `scratch_head` column |
| irOutcomes for vector fixtures (gc/standalone) | 12 fixtures `run:emitted` (forOfParam: `sum:emitted,run:emitted`); closureVec, nestedVec, nullableVec, stringVec `unsupported` | identical | `ir_outcomes_head` column |
| 6920 test, verbose + JSON | n/a | **18/18 passed** | `raw/head-6920-verbose.txt`, `raw/head-6920-tests.tsv`, `raw/head-6920-results.json` |
| Required 32-file set, failing tests | 14 | 14, identical names (diff empty) | `raw/{base,head}-required-32/failing-tests.txt`, `raw/diff-failing-required-32.txt`, `raw/diff-summary-required-32.txt` (empty) |
| 23 source-reading suites, failing tests | 158 | 159 = the same 158 + `issue-3518-lowering-cycle` (pin, below) | `raw/{base,head}-source-reading-23/failing-tests.txt`, `raw/diff-failing-source-reading-23.txt` |
| loc-budget (merge-base / `LOC_GATE_BASE=dbf5b4f7`) | exit 0 / 0 | exit 0 / 0; net +283 src LOC; `lower-generic.ts` 4247→4245 | `raw/head-gates/loc-budget*.txt` |
| func-budget (both bases) | exit 0 / 0 | exit 0 / 0 | `raw/head-gates/func-budget*.txt` |
| coercion-sites / oracle-ratchet / dead-exports | 0 / 0 / 0 | 0 / 0 / 0 | `raw/{base,head}-gates/*.txt` |
| check:ir-fallbacks | exit 0 | exit 0, report identical | `raw/{base,head}-gates/ir-fallbacks.txt` |
| compiler-boundaries `--mode inventory --base dbf5b4f7` | exit 0 | **exit 1** (open, below) | `raw/{base,head}-gates/compiler-boundaries-inventory-base.txt` |
| 3518 lowering-cycle | exit 0, 25/25 | **exit 1**, 1 failed / 24 passed (open, below) | `raw/{base,head}-gates/lowering-cycle-3518.txt` |

The 32-file required set: `raw/list-required-32.txt`. The 23 source-reading suites: `raw/list-source-reading-23.txt`.

Probe side notes:
- `examples/js/async.ts` on gc produces a different binary when `trackIrOutcomes:true` is set. This happens identically on base and HEAD (`tracking_binary` column). It does not affect the default-compile sha256 comparison.
- Linear compiles report no irOutcomes, and the linear overlay ignores `experimentalIR`. On linear, the witness is therefore the `$linear_vec_ptr_` scratch in 8 fixtures. r1 said 9; that was a miscount, and the correct number is 8.

The equivalence gate was not re-run for r2. The r1 result is in `raw/r1/after-equivalence.txt`: exit 0, 1748 passing, 22 failing = 22 known.

## Gaps still open (acknowledged by A; left for ROOT / Session A)

1. **`tests/issue-3518-lowering-cycle.test.ts` › "resolves the real transitive value graph without a wrapper/emitter/facade cycle"**:
   ```
   AssertionError: expected [ …(34) ] to deeply equal [ …(33) ]
   +   "src/ir/backend/vector-representation.ts",
    ❯ tests/issue-3518-lowering-cycle.test.ts:199:27
   ```
   The pin successor needed (not applied):
   - add the module `src/ir/backend/vector-representation.ts` (it has type-only imports);
   - add the edge `src/ir/lower-generic.ts -> src/ir/backend/vector-representation.ts` after the legality edge;
   - change the generic out-edge count from 13 to 14.
2. **compiler-boundaries inventory**:
   ```
   compiler-boundaries: invalid-inventory (mode=inventory, exit 1)
     unclassified-module: src/ir/backend/vector-representation.ts
     unclassified-target: src/ir/backend/vector-representation.ts  (×4)
   ```
   This needs a ROOT-owned row in `scripts/compiler-boundaries.json`. The suggested row is in `raw/r1/a-c1-proposal.md`.
3. **`tests/issue-3299.test.ts`, optional linear/Porffor proof** (skipped here because there is no `vendor/Porffor` or C compiler). Its fixture still builds GC/linear intersection handles without `valueType`, and calls the removed `getVecScratchLocalIndices()`. Under r2 those handles are rejected even more strictly. The fixture hunk is suggested in r1 and not applied.

Everything else in r1 still holds, including:
- the ownership mapping per file and hunk;
- the underspecified-plan decisions: the linear scratch name, the Porffor `ptr`→`i32` scratch slot, the allocation-row checks, the stricter linear converter, and the fail-closed mismatch at `program-native-invocation.ts:242`;
- the remaining A-C caller items 1–6.

r2 adds two files to the ownership map, both within the regions already listed in r1:

| File | Region |
|---|---|
| `vector-representation.ts` | C, new file |
| `lower-generic.ts` | C: the `resolveVecType` and `lowerIrTypeToValType` vec-arm hunks, plus the import |

## Files

- `a-c1-proposal-r2.patch`, `a-c1-r2-delta.patch`, this document
- `raw/`: r2 raw records (`.txt`/`.tsv`/`.json`)
- `raw/r1/`: the first run's raw records, renamed from `.log`/`.err`
- `SHA256SUMS.txt`: covers every file under this directory except itself
