# V6 paired diagnostic terminal receipt

Compiler slot explicitly released. No further execution planned.

Archive: /private/tmp/js2-5883-main-6eac-20260927/.tmp/V6-pair-5OkPw2
Structured receipt: /private/tmp/js2-5883-main-6eac-20260927/.tmp/V6-pair-5OkPw2/terminal-summary.json
Comparison: /private/tmp/js2-5883-main-6eac-20260927/.tmp/V6-pair-5OkPw2/comparison.json
Full logs: /private/tmp/js2-5883-main-6eac-20260927/.tmp/V6-pair-5OkPw2/B.log and C.log; corresponding JSON test reports and B/C raw artifact directories retained.
Frozen executed harness/comparator and original authority bytes are in package/ and original/.

B handle 79055 terminal exit1; C handle25699 terminal exit1; comparator terminal exit1. Each arm Vitest 0/5 pass, 5/5 fail at missing decline-control assertions. Across both arms: compile10/10, native1 10/10, Wasm1 10/10, zeroimports10/10, no observer errors10/10. All five source hashes in each arm equal the preserved original hashes.

Comparator correspondence5/5 EXACT, observerValid0/5, coverage0/5. No B/C residual/graph/WAT/binary mismatch. Both arms report exactly the two missing real-decline controls per fixture; runtime and rollback remain UNOBSERVED.

Receipt-level controls: all70/70 output-control rows report passed;20/20 seed-kind slots OBSERVED;20/20 decline-kind slots INCONCLUSIVE. IMPORTANT: comparator asserts contract.failures empty BEFORE subsequent control checks, so these counts are direct recorded outcomes, not a claim the comparator reached and validated every later contract assertion.

Scoped counts per arm, ordered cold / controlled-reserved / already-emitted / all / race:
- seedPublications: 3 / 3 / 2 / 1 / 1.
- committedOutputs: 30 / 30 / 20 / 10 / 10.
- publishedCompilerReads: 1 / 1 / 0 / 0 / 0.
- scopedDeclineEvents and verifiedDeclineRollbacks: all zero.
- nonempty positive counts:31 /31 /20 /10 /10.

Restoration: original drive19e15af... and protocol d3dcae... restored by apply_patch during B-to-C staging, then byte-compared post-C with pre-run archives. No further edit needed. All shared pins unchanged. Removed only newly staged tests/issue-5883-real-constructor-observer-v6.test.ts and .tmp/5883-compare-real-constructor-observers-v6.mjs via apply_patch after archived bytes matched. They remain recoverable in package/. Parent production untouched beyond the authorized temporary arm swap, now exactly restored.

Process-list inspection was sandbox-denied; actual B/C handles and comparator independently returned terminal exit statuses. No restart, kill, harness revision, typecheck, other tests, commits or pushes. V1–V6 own originals and original five fixtures preserved.
