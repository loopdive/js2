# Approved diagnostic deletion: execution receipt, slot returned

2026-09-27. Parent approved the exact five-line deletion in the preceding proposal and granted exclusive validation after push54966 terminal0. Applied with apply_patch; no other semantic edit. Source remains pinned to PR `60fb42a20c0c71e1f273527571170e38da9e5d1e` plus uncommitted main `7443ab4826fde65b72f875e0af12337a35520932`. No merge, commit, push, hold change, fixture rewrite, suppression, speculative fix or parallel compiler execution. Hume independent acceptance review remains separate.

Tree `/Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927`, branch `codex/5748-main7443-integration-20260927`; both verified before the patch. Node v22.23.2, Vitest3.2.4. Existing dependency links reused; Test262 test/harness links now present as documented in first receipt.

## Applied source and preservation

Only deleted the early unconditional i64 `emitToString` block in call-identifier.ts, leaving upstream operand preparation and late formatter intact. Original staged five-file resolution is preserved; the diagnostic deletion and prior two formatting-only changes are unstaged. No unresolved index entries.

Current SHA256:

- call-identifier.ts: `8341e693cb4d3e96c4dd553486eb718cd91a0682e2341e7ded5a41b1a07ee087`.
- initializer-carriers.ts: `34f3194ad3fb9f03fc819d50a9d35617d930fab3ba72d3229f24c76c643b9a4c`.
- extern.ts: `0ba8936765955ff8aa00a47a1ae1048dbfe5d95dfda24ae3f54eae850eccf668`.

`.tmp/5748-fix-validation-before.sha256` seals these three sources, all nine test files and the original Test262 yield-star fixture. `.tmp/5748-fix-validation-terminal-check.log` confirms all13 unchanged through execution. `.tmp/5748-original-evidence-preserved.log` verifies every first receipt/log/JSON against the original artifact manifest, including first TS2367, formatting errors and missing-fixture123/125. No original evidence overwritten.

## Sequential commands and actual terminal results

Each command ran in the tree above, with `set -o pipefail` and `2>&1 | tee .tmp/<basename>.log`. No interruptions/restarts on observation timeouts. All processes are terminal; slot explicitly returned immediately after final terminal165944. Only read-only receipt assembly followed.

1. `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`: **exit0**, session61485, terminal334b1f. Basename `5748-ts7-after-deletion`; empty log with positive terminal exit. Prior TS2367 remains separately preserved.
2. `node node_modules/prettier/bin/prettier.cjs --check scripts/compiler-boundaries.json src/codegen/bindings/initializer-carriers.ts src/codegen/expressions/calls.ts src/codegen/expressions/extern.ts src/codegen/index.ts src/codegen/expressions/call-identifier.ts`: **exit0**, session8003, terminal58f827. Basename `5748-format-after-deletion`; six matched files pass.

Both test commands used:

```sh
VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run FILES --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/BASENAME.json
```

3. FILES: `tests/issue-5399-javascript-runtime-safety.test.ts tests/issue-6656-string-call-bigint.test.ts tests/issue-5883-bigint-string.test.ts tests/issue-5883-bigint-string-comma.test.ts tests/issue-6656-bigint-wide-carrier.test.ts`. BASENAME `5748-bigint-after-deletion`. **76passed/77total,1failed,0pending**, session53942, terminal5982f0, **exit1**. All five full files, no name filters.
   - Original5399:30/30, including both exact stdout O0/O2 rows.
   - String-call:1/1.
   - Original6182 String:13/13.
   - Original6182 comma:8/8.
   - Wide-carrier:24/25; exact failure below.
4. FILES: `tests/issue-6651-js-defaulted-param-slot.test.ts tests/issue-5398-generator-call-planning.test.ts tests/issue-5398-planning-extraction.test.ts tests/issue-5398-host-delegation-completion.test.ts`. BASENAME `5748-default-generator-provisioned`. **125/125passed,0failed,0pending,0todo**, session15226, terminal165944, **exit0**. Respective denominators9,64,13,39. Both original assembly O0/O2 rows now execute and pass with fixture provisioned. Diagnostic-only and KNOWN LIMIT rows remain diagnostics, not new conformance acceptance.

Full per-test JSON and text logs preserved for both runs. Separate `5748-bigint-after-deletion-counts.json` and `5748-default-generator-provisioned-counts.json` derive file-level denominators from every assertion row. No earlier rest/regExp batches repeated or counted as post-deletion executions.

## Exact outstanding failure and next proposed paired control

File `tests/issue-6656-bigint-wide-carrier.test.ts`, suite `#6656 slice 4 — standalone BigInt past 64 bits`, case **narrowedString**, assertion line170: `expected +0 to be 1 // Object.is equality`.

Original source:

```js
function LoS(t) {
  let n = t;
  if (typeof n === "bigint") return String(n);
  return "other";
}
export function narrowedString() {
  return LoS(2n ** 64n) === "18446744073709551616" ? 1 : 0;
}
```

The unchanged file compiles the complete mixed-call fixture with `compileMulti`, standalone, hostBridge off, allowJs and skipSemanticDiagnostics; the test reports only boolean equality result0. It does **not** reveal the actual returned text or establish truncation by itself. Initial compilation/control case and the other24 cases passed, including narrowedToString and dynamicString. No causal attribution to the deletion, PR parent, or main is established from this single candidate run.

Read-only `git show 7443ab4826fde65b72f875e0af12337a35520932:tests/issue-6656-bigint-wide-carrier.test.ts | shasum -a 256` gives `2a39e92b3f86823b15d75a0f4dd49098003bd17271d7f57efec8d392c27712cf`, exactly the candidate fixture hash.

Next proposed measurement, requiring NEW grant: isolated owning-main checkout at exact `7443ab4826fde65b72f875e0af12337a35520932`, existing dependencies, same Node/heap/worker options, run the **full25-case original wide-carrier file** with separate JSON/log. Preserve every row and compare to candidate24/25. No current process restart, no fixture extraction, no name-filtered single-row run. If main reproduces, that establishes reproduction on main, not complete root cause; if main passes, investigate integration difference without assuming which change caused it. No new checkout or execution started here.

## Native numeric-i64 coverage and acceptance limits

These five files contain ordinary JS number controls but no explicit `type i64 = number`/unbranded native-i64 String control. BigInt values within signed64 and a BigInt arithmetic row called foldBackIntoI64 are not native numeric-i64 controls. The wide-carrier fixture intentionally uses mixed-call reference slots; its comments explicitly distinguish that coverage from the raw i64 lane. Thus unbranded native numeric-i64 behavior remains **unmeasured**, despite source evidence for upstream's numeric fallback. No broad extra fixture authored/run.

TS2367 is resolved and scoped formatting passes. The five-file BigInt population is not fully green. Original5399 and6182 selected files pass on this candidate, but no general BigInt equivalence, hold release, PR acceptance or compiler retirement follows. Original rest effect-order gap stays separate. Compiler slot returned; no active process, no speculative fix.
