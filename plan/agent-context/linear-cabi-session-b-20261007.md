# Session B: Linear C array-return boundary

Branch: `codex/6893-linear-cabi-array-forwarding-20261007`.
Diagnostic baseline/current unchanged source HEAD:
`91e519587ec2d383a96cfc7d06f48bac04d2c286`, authenticated canonical main.
Issue: `plan/issues/6893-linear-cabi-array-forwarding.md`.
Reviewed Astra High plan commit: `efa7a96d605914961f0ea2d106093fc967bcd80a`.
Sol6.1 Medium implementation writers were released only after the full plan
review and canonical claim effect verification.

## Claims and partition

Canonical claims use `CLAIM_ASSIGN_REMOTE=upstream`, effect-verified at
`b47b8f0ad3573909851c08d5a0acaa592bae3fe1` with936 active records:

- `6893:linear-cabi-plan-20261007`, owner
  `ttraenkler/codex-linear-b-cabi-astra-20261007`, branch
  `codex/6893-linear-cabi-plan-20261007`: only the new issue Markdown file.
- `6893:linear-cabi-evidence-20261007`, owner
  `ttraenkler/codex-linear-b-cabi-evidence-20261007`, integration branch above:
  only this handoff and `plan/log/6893-linear-cabi-20261007/`.

Released production ownership is only
`src/codegen-linear/c-abi.ts::emitCabiWrappers`'s array-return marshaling.
Source claim `6893:linear-cabi-source-20261007`, owner
`ttraenkler/codex-linear-b-cabi-sol61-20261007`, branch
`codex/6893-linear-cabi-source-20261007`; tests claim
`6893:linear-cabi-tests-20261007`, owner
`ttraenkler/codex-linear-b-cabi-tests-sol61-20261007`, branch
`codex/6893-linear-cabi-tests-20261007`, only the new
`tests/issue-6893-linear-cabi-array-forwarding.test.ts`.
Both sole owners were read from upstream held records at
`7297c073fdf351bc2b365ba7038151be70def5c8` with939 active records, after a
fresh check also found no active1650 string-argument wrapper claim.
Existing import/ownership annotation
functions remain with their owners. The complete20-open-PR file inventory had
no `c-abi.ts` edits. Live4542 owns imported engine-handle annotations/refcount;
4540 owns linked/standalone allocator assembly. Neither published scope releases
their functions to B. A's verified5a4b64e1d637ab253c2d2107d45142f021c217c4
publication excludes this leaf from its45 prepared paths but retains all shared
compiler/index/emitter/preparation/provenance/source-map ownership.

## Measured baseline observations

Commands execute actual `compile` and public exports using `target: "linear"`,
`abi: "c"`, `optimize: false`, `JS2WASM_LINEAR_IR=1`, no host imports supplied.
No source edit was made. Results are retained in
`plan/log/6893-linear-cabi-20261007/baseline-probes.json`.

- Returning the original/aliased array after setting index31 yields length2,
  not32, and payload `[1.5, -2.25]`. Both binaries validate and execute.
- Filling every index2..31 before returning the array yields the old length16
  and only16 values, not the32 fully initialized values required. This dense
  fixture avoids claiming zero-filled JS holes as exact JS value equality.
- These array-return functions are currently **not IR admitted**: report
  `compiled: []`, rejection `missing type annotation and no override (return
  type of run)` despite explicit `number[]`. They exercise current legacy
  source emission and the real public C boundary. Do not call them IR proof.
- The scalar `run(): number` with an aliased array grown at index31 **is IR
  admitted** (`compiled: ["run"]`, no rejections) but returns0 instead of3.75.
  This is a separate shared IR read-forwarding failure, not fixed by the C
  array-return wrapper. Runtime `__arr_get` already follows `__arr_resolve`;
  current Linear emitter length/data-pointer lowering uses the raw header.
  Source attribution is not a completed repair or a full proof of cause.

The earlier index7 experiment did not force growth and was not a reproduction
of this defect. It cannot establish the forwarding behavior.

Working-candidate diagnostic, not final test acceptance: the +10-line scoped
source insertion has SHA256
`d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f`.
Provenance records HEADefa7a96d605914961f0ea2d106093fc967bcd80a with that
kernel still uncommitted, Node22.23.2/V8 12.4.254.21-node.56 and identical
compile flags. All three array-return diagnostics now report length32 and
the required first/last elements; dense32 returns all32 exact initialized
values. Their source IR admission refusal is unchanged. The separate admitted
scalar read still returns0, preserving its outstanding positive3.75 obligation.
Full observations are retained in `working-candidate-probes.log.gz`.
Astra's read-only review found no concrete blocker or out-of-scope source diff.

## Requests to Session A / unresolved migration requirements

Please take the admitted scalar read-forwarding failure in your designated
`src/ir/backend/linear-emitter.ts` / shared lowering scope, preserving the
original positive result3.75 and the exact source fixture. Also retain the
supported source array-return admission requirement in shared IR/frontend/ABI
preparation; a hard refusal is not the final equivalent IR path.

B will neither change those functions nor fabricate source ownership from a
manually constructed provider export. A C export-wrapper fix can improve the
target boundary used by eventual IR emission independently, but cannot claim
array-return IR admission or fix the scalar read. No shared wiring dependency
is silently adopted, no fixtures/failures are removed, and no legacy is retired.
A remains final integration/queue owner.

Independent prior deliverables remain PR6561 (stack-arena correctness) and
held PR6563 (repeat performance evidence). This issue has no source dependency
on either. The full migration goal remains incomplete.

## Recorded implementation and validation witnesses

Initial Sol implementation: `867c74ac7aa962f0412e37d842b077a96c6283da`.
String-instrument repair: `880e9eaa288861eeadc7a6e5936d89bc4d2c35c1`.
Definition-only containment implementation:
`608edfabf404aba0e69691eeccbda7518ca7988d`.
Astra amendment publication / final validation witness:
`f23aa8afd7d8cc483b3ec92cfde45b525d6d13ae`.
Source SHA-256:
`d303abd67069493c08dedc6cd124482f80675c06e0ca1748cea168098fc82d46`.
Final regression-test SHA-256:
`7612ec537bd3876f3a872e029629601442b7593b1150c30cd25d49db7351be62`.
Only production write remains ten lines inside the owned array-return arm.

V1 measured baseline 6/16 versus candidate 14/16. V2, after the identical
string-fixture repair, measured baseline 7/16 versus candidate 15/16.
Eight same-instrument boundary failures improved; one extra pass on both
sides belongs to the instrument repair, not production credit. Both v2 logs
contain28 structured records. Public compile routes, public strings/scalars,
runtime no-growth and both resolver-free controls compare deeply equal.
V1/V2 complete instruments and gzip logs are retained, not replaced.

V3 adds two controls without changing the original16 cases: public namesake
import execution and rejection of an import-only runtime substitute. Exact
baseline measures8 pass/10 fail out of18. The public namesake is present,
executes with zero host calls and returns `[1.5, -2.25]`; actual IR admission
remains absent. Source-derived shadowing risk in the initial K lookup is
not reported as a measured regression on that superseded candidate.

Exact baseline unchanged controls measure78 pass/2 fail out of80. Existing
issue1977 scalar tests produce24 instead of69 and16 instead of40. They do
not request C ABI and cannot exercise this array-return wrapper. A should
investigate them with the preserved scalar0-versus3.75 IR failure. No test
expectation or existing file was altered. A preliminary control execution
overlapped the containment source edit; its log is retained but is not an
exact-commit acceptance witness. Final committed candidate is rerun separately.

No allocator/provider ownership transfer, shared compiler edits, queue
submission, legacy retirement or complete-IR-equality claim is implied.

Final committed candidate:17 pass/1 fail out of18 new regressions;
unchanged controls78 pass/2 fail out of80; combined95 pass/3 fail out of98.
The three failing requirements are identical to the baseline's scalar
obligations, with values0 instead of3.75,24 instead of69,16 instead of40.
Final same-instrument improvement is nine boundary cases (including
import-only refusal), not completion of shared IR source semantics.
Both final paired logs contain33 structured records. All ten recorded
control/route kinds compare deeply equal; every runtime-growth observation
except the intentionally repaired oldest-alias return pair/payload is equal,
including full snapshots, allocation usage, forwarding links and current
pointer output. `final-comparison.json` records exact hashes/environment.

Integration instructions: consume this branch without weakening the three
positive scalar assertions; fix them in A's explicitly owned shared scope,
then rerun all98 cases. Separately prove actual source-IR array returns—today
they still use legacy fallback. Keep the PR on hold until coordinated
integration acceptance. The branch has no source dependency on B's other PRs.
