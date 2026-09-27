# PR5748 pinned integration: first validation, slot returned

2026-09-27. Exclusive grant after parent10538 terminal0. All seven granted processes ran sequentially and are terminal. Compiler/static-gate slot explicitly returned after final terminal f4c3b8. No source fixes, fixture changes, retries, killed/restarted processes, commits, pushes, hooks, policy/config changes, or parent-tree writes. Subsequent activity was source inspection, receipt writing and completing dependency links only. New execution requires a new grant.

## Subject and dependencies

Tree `/Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927`, branch `codex/5748-main7443-integration-20260927`.
HEAD `60fb42a20c0c71e1f273527571170e38da9e5d1e`, uncommitted MERGE_HEAD `7443ab4826fde65b72f875e0af12337a35520932`. Source resolution remains the five-file frozen patch in the preceding source handoff. Node v22.23.2; Vitest3.2.4.

Provisioned local node_modules symlink to `/Users/thomas/Code/js2/node_modules`, no install. **Provisioning omission:** test262 remained an empty submodule directory during the first runs. Two original generator controls failed opening its yield-star fixture. This is my setup omission, not evidence of a compiler regression. Only after all tests terminated, added `test262/test` and `test262/harness` symlinks to the existing canonical directories, retaining the submodule directory. No rerun performed. Canonical Test262 HEAD and candidate gitlink both `b363f29d3c43c626dc852744ad64a0b48a003693`. Original `test/language/expressions/dynamic-import/assignment-expression/yield-star.js` SHA256 `4ceab6c267bea8f1adc3dd076eafe2a59628ce2ae667971dc5e43650c04407bb`.

`.tmp/5748-validation-before.sha256` records five resolution sources, eleven test files, vitest.config.ts and tsconfig.ts7.json. Terminal verification `.tmp/5748-validation-terminal-check.log` reports all18 unchanged. `.tmp/5748-fixture-parent-provenance.jsonl` proves each original test is identical to its owning pinned parent and explicitly records absence from the other parent. No inference of parent test pass from file equality.

## Exact commands and terminal results

All commands in the tree above. Each executable command used `set -o pipefail` and `2>&1 | tee .tmp/<name>.log`; names below are exact. No run was restarted after observation timeouts.

1. `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`: session90345, terminal424d83, exit1; `5748-ts7-first.log`.
2. `node node_modules/prettier/bin/prettier.cjs --check scripts/compiler-boundaries.json src/codegen/bindings/initializer-carriers.ts src/codegen/expressions/calls.ts src/codegen/expressions/extern.ts src/codegen/index.ts`: session3977, terminal2956d6, exit1; `5748-format-first.log`. Only initializer-carriers.ts and extern.ts flagged. No formatter write.
3. `node scripts/check-compiler-boundaries.mjs --mode inventory`: session46910, terminal57a7c1, exit0; `5748-inventory-first.log` retains complete JSON output despite tool-output truncation. Inventory valid,1560 modules; architectureComplete:false, graphComplete:false. No closure claim.
4. `node scripts/check-ir-layering.mjs`: terminal91736b, exit0; `5748-layering-first.log`.87 import lines/15 files against baseline90;6 linear-backend imports ungated. Baseline not updated.

The three test commands used this exact prefix and suffix, with the literal file lists below:

```sh
VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run FILES --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/REPORT.json
```

This is an explicit per-process2048MB worker heap cap, not CI configuration or a claimed CI reproduction. No parallel file/case execution.

5. FILES: `tests/issue-5396-rest-spread.test.ts tests/issue-1058-captured-rest-call.test.ts tests/issue-1058-closure-rest-host-dispatch.test.ts tests/issue-1058-binder-symbol-table.test.ts`; REPORT `5748-rest-first`; same log basename. Session72788, terminale4e6f3, exit0. **24/24 passed**,4files; respective denominators16,1,2,5.
6. FILES: `tests/issue-5198-global-match-result-shape.test.ts tests/issue-1914.test.ts tests/issue-6603-standalone-nullable-native-string-element-binding.test.ts`; REPORT `5748-regexp-first`; same log basename. Session67332, terminal267154, exit0. **18/18 passed**,3files; respective denominators5,11,2.
7. FILES: `tests/issue-6651-js-defaulted-param-slot.test.ts tests/issue-5398-generator-call-planning.test.ts tests/issue-5398-planning-extraction.test.ts tests/issue-5398-host-delegation-completion.test.ts`; REPORT `5748-default-generator-first`; same log basename. Session63097, terminalf4c3b8, exit1. **123/125 passed,2failed**,4files; respective denominators9,64,13,39. Host-delegation37pass/2fail; other three all pass.

Aggregate original first rows: **165passed/167total,2failed,0pending,0todo**. `.tmp/5748-first-counts.jsonl` independently counts every JSON file's assertion statuses; all original per-case rows and full logs retained. Two failing cases are O0/O2 “compiles and executes the unchanged original assembly, primary and strict (not normal admission)”, both ENOENT on the exact Test262 path above at test line155. Two passing KNOWN LIMIT rows intentionally retain null/undefined pending-throw losses; diagnostic-only observations are not semantic-conformance credit.

## TS7 clean-merge interaction: read-only comparison of both parents

First error preserved verbatim in the log: `src/codegen/expressions/call-identifier.ts(1530,11): error TS2367` — narrowed union has no overlap with `"i64"`.

Compared base `aafae4c03c1fe2811d6ccfd30008326157281cca` to EACH pinned parent using `git diff <base> <parent> -- src/codegen/expressions/call-identifier.ts`, and candidate staged diff against main. The PR independently adds an early unconditional i64 arm after String(void): `return emitToString(ctx, fctx, argType, { kind: "bigint" }, "string")` (#5399). Main independently adds the late i64 arm at the end of String conversion: `emitI64ToStringCall` then `emitStringBuiltinNumberResult` (#6656). Each parent has only its own new arm; Git cleanly combines both. The first return excludes i64 from the later comparison, causing TS2367. This file is automatically merged, not among the five manual resolution paths. No parent compiler execution occurred.

Main also introduces `compileStringConversionArgument`, requesting externref for proven standalone native BigInt before narrowing. Its `emitI64ToStringCall` distinguishes branded BigInt from native numeric i64 and preserves narrowed wide-carrier formatting. Therefore merely casting away TS2367 or deleting main's late arm would hide a semantic composition decision. Smallest candidate follow-up is reconcile the duplicate early PR arm with main's existing branded/wide-aware conversion route, checking original PR BigInt controls plus native numeric-i64 and wide-BigInt controls before acceptance. Not implemented or measured. No gate weakening proposed.

## Remaining boundary

TS7 and scoped formatting currently fail. Two original generator controls remain unmeasured past fixture load; a newly granted bounded rerun after provisioning is needed. Original effect-order gap from array-literal spread lowering remains a separate unresolved concern, unchanged by the passing literal/rest controls. This receipt does not establish PR admission, removal of HOLD, effect-order correctness, architecture closure, CI success or a merge-ready state. No commit or push authorized.
