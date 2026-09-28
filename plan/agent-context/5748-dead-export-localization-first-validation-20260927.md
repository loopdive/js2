# Dead-export localization: first validation, slot returned

2026-09-27. Sequential execution in the owned integration tree at HEAD
`d6f4da7029f06ea81ac20f6271a285fa6179d9a9` with the reviewed two-file patch.
No source/test edits during validation; original fixtures and first failures
preserved. No baseline/gate edits, commit, push, retries or killed processes.
All handles are terminal and the exclusive slot was explicitly returned after
formatting. Supplemental test typecheck is NOT green.

## Exact commands and terminal results

All commands used `set -o pipefail` and `2>&1 | tee .tmp/<log>` in
`/Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927`.

1. `pnpm run check:dead-exports`
   - Session `5081`, terminal `a25618`, exit 0.
   - Log `5748-dead-export-localization-gate-first.log`.
   - Expands to `node scripts/audit-legacy-reachability.mjs --check --moved-reference-contract=preservation-v1 --require-core-types --require-core-nodes`.
   - Core-node 12/12 and core-type 10/10 pass; preservation-only 6/6 full and
     6/6 cut source witnesses pass. The original two nonliteral-import findings
     remain: graph OPEN, strict modeled closure FAIL, retirement/deletion NOT
     CERTIFIED. This is the exact configured gate's exit 0, not closure proof.
2. `VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-5399-vec-own-index-export.test.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/5748-own-index-localization-first.json`
   - Session `57694`, terminal `6d45bc`, exit 0: **26/26 pass**.
   - Log `5748-own-index-localization-first.log`, complete per-case JSON above.
   - Includes optimize=0/2, collision/repeat identities, independent instances,
     wrong-instance controls, and all five corruption cases. No identity check
     failed or was weakened; this is bounded fixture evidence only.
3. `pnpm run typecheck`
   - Session `33999`, terminal `f0a746`, exit 0.
   - Log `5748-own-index-localization-source-ts7-first.log`.
   - Canonical package script invokes `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`.
4. `node node_modules/typescript7/lib/tsc.js --noEmit -p .tmp/5748-own-index-localization-tsconfig.json`
   - Session `43138`, terminal `ab103b`, exit 1.
   - Log `5748-own-index-localization-test-ts7-first.log`.
   - Config extends `../tsconfig.ts7.json`, rootDir `..`, includes full
     `../src/**/*.ts` and `../tests/issue-5399-vec-own-index-export.test.ts`,
     overrides exclude to `[]`.
5. `pnpm exec prettier --check src/codegen/vec-own-index-export.ts tests/issue-5399-vec-own-index-export.test.ts`
   - Terminal `a81737`, exit 0, both files match formatting.
   - Log `5748-own-index-localization-format-first.log`.

## Preserved first supplemental errors and source provenance

```text
tests/issue-5399-vec-own-index-export.test.ts(73,63): error TS2322: Type '0 | 2' is not assignable to type '1 | 2 | 3 | 4 | boolean | undefined'.
  Type '0' is not assignable to type '1 | 2 | 3 | 4 | boolean | undefined'.
tests/issue-5399-vec-own-index-export.test.ts(78,11): error TS2339: Property 'instance' does not exist on type 'Instance'.
tests/issue-5399-vec-own-index-export.test.ts(263,30): error TS2683: 'this' implicitly has type 'any' because it does not have a type annotation.
```

Read-only `git show d6f4da7029f06ea81ac20f6271a285fa6179d9a9:tests/issue-5399-vec-own-index-export.test.ts`
confirms all three statements were present before this patch at lines 33, 38,
and 223 respectively. The observer insertion shifts them by 40 lines. This is
source provenance, NOT a paired baseline typecheck (none run). No type waiver,
unsafe cast, optimize-option conversion or binary-copy change was applied.
Any harness correction requires review; preserve this failed receipt.

## Unchanged reviewed subjects and retained artifacts

Source/test SHA256 matched before and after all commands:

- Production `vec-own-index-export.ts`: `8812aafce8326c6fd4d2f26d40136fb9e221b3bdc8818a97d6efe757ce657f69`
- Test `issue-5399-vec-own-index-export.test.ts`: `2453d4b30f0b2433fdab4016c78bac7c441b903a659b402b5ec798ebfac3f3c4`
- Gate log: `3195936498c181857f522c263bd693c1bf9f63b310777121cf7b75faa82a68ce`
- Test JSON: `29d4f44018413cd6beb7617a63eee321759a1faf0a7ca9c8eab2f532b0452e1c`
- Test log: `6570091411321019c9e64b91815f2bc91b0c426dbfc6d3c9c5fc7022e6b8a93d`
- Canonical source TS7 log: `465318e76b5643bde93c98293ea361342e3d84233095da7971096b93e8e23c94`

No gate/baseline diff. Quality's original dead-export finding is locally resolved
under its unchanged command, but no remote CI rerun/publish or full acceptance
claim. The unused internal exported accessor was removed, not legacy compiler
machinery. Historical BigInt evidence and all separate HOLD limitations remain.
