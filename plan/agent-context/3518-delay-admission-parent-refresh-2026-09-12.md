# Certified native-delay admission parent refresh

## 2026-09-12: certified native-delay admission queue refresh

Refresh existing PR5756, “feat(ir): admit certified native delay through source
preparation”, from published e3a01efa44f68da1b93c16b1a728d0ba099183f9 onto
signed and published frame parent b6f1dba796d71e045a80d18b219ccc6d42adbca0.
The isolated branch is `codex/5756-queue-drain-20260912`. Do not push stale
fea8c3f413. No child push or queue action is authorized by this local validation
record before confirmed parent delivery to main; the user's existing ordered
delivery authorization remains in force.

Only appended issue history conflicted. Both complete sections are retained,
with their original bytes recorded separately in the merge receipt. All five
published production files and two authored test files remain byte-identical
to e3a01efa. The policy retains every parent record and rule and adds only the
unmigrated frontend planning-sites record. No implementation or failure fixture
was changed during this refresh.

The independent test262 checkout pins b363f29d3c43c626dc852744ad64a0b48a003693.
All 53,889 test and 44 harness files match raw Git blob hashes, exact file and
directory sets and modes; no extras, alternates or shared object hardlinks.
The existing corpora remain preserved. Manifest SHA256:
fcaaff56a78c134e3875a00b743d5e6435939c38f304eeec1ffb35bc3c611ffb.

Fresh serialized Node25.9.0/macOS ARM64 validation passed **158/158**, with no
failures or skips: admission (41), identity/relocation (45), typed preparation (30),
data-contract replay (8), public native family (14), native delay (12), closure
compile-once (4) and plan identity (4). The source typecheck, explicit-parent-base
LOC/function gates, coercion, oracle and preservation-v1 dead-export checks
passed. Conformance synchronization updated zero files. Strict graph closure
remains OPEN for the existing two nonliteral dynamic imports; the preservation
witness pass is not retirement certification.

The behavior remains deliberately limited. Explicit certified native-delay
source selection preserves three original units, one terminal, one IR body,
zero derived units and the native delay call. Whole-program preparation still
refuses the real missing `__ir_promise_delay_native` declaration with
invariant / unknown-function-ref / resolve on the original owner. Omitted or
disabled projection retains unsupported / unknown-class-construction / build.
The complete five-function playground retains its located
unsupported / type-resolution-unsupported / build at fetchAllSequential.
No placeholder declaration, fabricated support body or later-chain repair was
introduced to make those controls pass. All four historical relocation
receipts remain unchanged.

The default pre-commit selector sees 30 root test changes from its older
merge base 535ee6b6ba19239394ee50f8235e6c528212688b; its existing >20-file self-skip must be reported as such.
The 158 scoped tests were run directly and are not a claim that this inherited
population ran. Normal signed commit and push hooks remain mandatory; their
actual outcomes and parent delivery will be recorded on the existing PR.
Detailed local receipts are in `.tmp/5756-queue-drain/` in the owned worktree.

Delivery order remains 5755→5756→5757→5758→5759→5760. At PR5759 retain the signed
standard-EH delay repair 561853c00d76c72eb44dbee14340dc15e9841e41 with both tagged
and foreign catches. New migration scope remains paused.
