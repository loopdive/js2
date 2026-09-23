# String-admission scanner prerequisite refresh — September 13, 2026

Existing PR 5787, “feat(ir): admit native string numeric source lowering”.
Owned branch/worktree: codex/5787-queue-drain-20260913.
Published head: bda70f02b1ac9043975b312d7300218a3e2ebfd1.
Actual scanner prerequisite: 1ce5d0575c890d640bc3ef9958c32d662bea9e98.

The merge conflicts only in appended issue history; both sections are retained.
Three original production files and the 36-case source-admission test remain
byte-identical. Twenty incoming source/test files match the exact scanner
parent. The new work here is limited to the vector donor test and a new
independently pinned forward-layout provenance fixture; no production change.

Initial 21-file validation: 1,063 passed / 1,064, zero skips. The observed
registry receipt mismatch predates this refresh: both published parents have
the same canonical Error/string extraction. The second affected registration
was found by static inspection after the first assertion stopped execution.
Original failed report: .tmp/5787-queue-drain/scanner-cohort.json.
Four original closure source-caller files: 43/43 passed, zero skips.

The repair reconstructs both original registry declarations from live canonical
return payloads under exact import/header/population/call/binding guards.
Original receipt hashes, counts and twenty controls remain unchanged. The
independent old string/Error donor fixture remains byte-identical. Review
closed free-context substitution and differently quoted duplicate-import gaps.
Final targeted result: 67/67 (38 donor + 29 original string/Error controls),
zero skips. The intermediate 65-case run is retained without claiming an
uncaptured intermediate source hash. Final exact source pins are retained.
The other 1,044 original core cases and 43 source cases passed on unchanged
files. This is composed local evidence, not a single rerun of all 25 files.

Independent pinned Test262 b363f29d3c43c626dc852744ad64a0b48a003693 verified
53,889 tests + 44 harness files, exact bytes/modes/directories, no extras or
shared object files. Canonical manifest:
fcaaff56a78c134e3875a00b743d5e6435939c38f304eeec1ffb35bc3c611ffb.
Original corpora, failures and dirty root remain preserved.

The scanner's prior three-arm comparison is historical, not fresh composition
credit. Final source gates and normal signed hooks precede publication. Next,
merge the prepared/delivered main lineage with the signed standard-EH repair;
then refresh existing PR 5789. The Promise-closure join remains separate.
Do not publish until actual predecessors reach main. Existing PRs only; no
new migration implementation, public cutover or retirement claim.

Final pre-commit source TS7, LOC/function budgets against scanner1ce5d057,
coercion, oracle and preservation-v1 dead-export gates passed. Conformance
synchronization changed zero files. Strict whole-compiler closure and physical
acceptance remain open; these gates are preservation/inventory evidence.
