# Three-arm implementation checkpoint

User approved implementation of the bounded plan, not comparison execution or
merge. Existing PR5798 remains held. No original comparator or fixture changed.

## Delivered artifacts

- `frame-repairs.patch`, SHA256
  `0f599134535848034b5dc43a14721a443a724dabad763a87b8910db13ed8f880`.
- `delay-repairs.patch`, SHA256
  `5c4c6c9e53e2cb4fb6a4c9dc5b64c02284c1d20796b8b89a549416bf3fdda83c`.
- `postimage-manifest.json`, SHA256
  `daba0e6d864187ee81f7f75a1a9cec2fcf6385b2e359df9e097b28d2821ec196`.
  Contains the complete literal P7 replacement and all pre/postimage pins.
- Additive driver: `scripts/verify-frame-delay-three-arm.mjs`.
- Admission/equality contract: `scripts/lib/frame-delay-three-arm-contract.mjs`.
- Two matching `.test.mjs` files: synthetic and syntax-only controls, not runtime
  or migration acceptance evidence.

The original plan remains a historical review record. P7 is no longer missing
as an implementation artifact. It has NOT been runtime-validated or approved
as execution evidence. No full IR or historical byte-preservation claim follows.

## Independently materialized copies

The parent applied the literal patches via apply_patch to NEW detached copies,
then recomputed complete source inventories using the driver contract:

- `/private/tmp/js2-three-arm-review.NBgQsY/frame`: HEAD0194b64c, exactly four
  changed existing source files, 1306 total, source SHA256
  `b58c7e57596e5f2fce3a2798c6564cdf42108d81779623d6dbd97b353234bce1`.
- `/private/tmp/js2-three-arm-review.NBgQsY/delay`: HEAD1cb0f5c7, exactly four
  changed existing source files, 1311 total, source SHA256
  `4a0c50c7fe09e175ee3c07def8197921034999e8b6d87c38756473e99815be7c`.
- `/private/tmp/js2-three-arm-review.NBgQsY/candidate`: detached63079597, not
  patched. Do not substitute current integration HEAD for this candidate pin.

Both computed repaired hashes exactly match the independently constructed
postimage manifest. Protected original source roots remain clean. No compiler,
Wasm execution or historical comparison ran in any of these new roots. They
must not be cleaned, reset, or treated as disposable unpublished work.

## Validation scope

Agent static evidence: eight syntax parses, eight exact in-memory unified-patch
roundtrips, and two read-only git apply checks. Parent reviewed the frame patch,
materialized both patches and verified the complete source postimages.
The driver retains every original child byte except one explicit pre-import
admission insertion; syntax-only Node checks parse both adapted programs.
103 synthetic/extraction/CLI controls passed with no compiler invocation.
Static review found and fixed two pre-execution admission gaps: root package.json
is now mandatory, and every fixture-file pin must exist before any child launch.

The driver records separate O/C and R/C equality, complete receipts and terminal
status. R/C comparison retains bytes, WAT, resource ordering, all unknown row
fields and all values. Late-import remains an additional exact three-way control.
Original failures are not relabelled. Population remains 48 artifacts and93
executions across six fresh arms; zero of those arms has been run here.

## Before execution approval

The REVIEW-ONLY `execution-manifest-review.json` now contains all six arm entries,
full source inventories, fixture file pins, original evidence paths/digests,
driver/helper and adapted-child hashes, exact parent argv and environment, Node
binary identity and full dependency-tree census (31,789 entries). Its SHA256 is
`ffc56c483ec1b4fb503fa868b2c51fbc1959cdb274233a2056abd49c0a8b85c2`.
The read-only `check-frame-delay-review-manifest.mjs` checks the same admission
contract without changing its REVIEW_REQUIRED_NOT_AUTHORIZED status or launching
an arm. Initial real-root preflight passed; this is not compiler parity evidence.
The 36 additional admission tests cover early rejection paths, not all late
Git-index, alias, patch-drift and historical-evidence mutations. Independent
static/data review found no actionable blockers in capture or authorization
separation; those remaining negative controls are still outstanding.
No manifest marked REVIEWED_FOR_EXECUTION has been created or supplied.

The parent and children deliberately use different invocation shapes. Parent
argv is independently pinned; children require fixed flags plus each suite's
exact source-program hash. Both require NODE_OPTIONS=--max-old-space-size=2048.
The full dependency census rejects external symlink escapes rather than silently
omitting dependencies. Any such failure requires explicit review, not relaxation.

Do not run the three-arm driver until the completed manifest and implementation
have been reviewed and execution separately approved. Do not waive issue5807,
normal PR checks or merge-group regression checks. No merge is authorized here.

## Post-push dependency drift (2026-09-10)

The earlier real-root preflight PASS is historical, not current clearance.
After checkpoint 92c145720a passed normal push hooks, the next real preflight
rejected the shared dependency census: count remains 31,789, but SHA256 is now
`a0fd4dada69bc1989a89ae492d76cd9722a5d5a1d503b2be21b1f867f5e33711`
instead of the pinned `3eb0bbaa82a6b0a85d47598abfa35f78696e95048ea41048246b03e8d6faab65`.
Zero late negative controls executed. The proposed scratch controls are unvalidated.

The only regular dependency file found modified in the preceding 40 minutes was
`.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json` at 00:05:04
local time. It contains the push hook's numeric-local test duration 6109.210792ms,
consistent with the successful 18-test hook. This is strong evidence of mutable
test-cache contamination, not an exact per-file comparison: the original dependency
census recorded only the aggregate hash, so exclusive attribution is unproven.
Do not silently refresh the digest or exclude the cache to obtain PASS. Preserve
the published manifest and failed evidence; isolate dependencies for a separately
reviewable recapture before running the remaining admission controls.

An isolated complete copy now exists at
`/private/tmp/js2-three-arm-dependencies.jxi7WC/node_modules`. All 2,204 copied
symlinks were relocated to their equivalent canonical targets inside that copy;
the source tree was not modified. Independent full censuses of shared and isolated
trees both returned 31,789 entries and `a0fd4dada69bc1989a89ae492d76cd9722a5d5a1d503b2be21b1f867f5e33711`.
The cache remains included. No comparison roots have been re-pointed yet.
Next: prepare fresh O worktrees at the exact historical pins (leave protected O
roots untouched), connect all measurement arms to this isolated copy, and capture
a new review-only manifest while preserving the published manifest and failure.

That preparation is now complete: fresh `frame-original` and `delay-original`
worktrees under `/private/tmp/js2-three-arm-dependencies.jxi7WC` retain the exact
O pins. They and the existing isolated R/C measurement roots resolve to the
isolated dependency copy. Protected originals retain their original links.
`execution-manifest-isolated-review.json` has SHA256
`bab290d12b0ea78fd773c4bf3c5e7343eeac71be58dfcde2def82027f605c161`.
The parent real-root review preflight passed with zero compiler invocations and
zero comparison runs. The published old manifest remains intact. The subagent
is rerunning the proposed late negative controls against this replacement.

Parent and subagent subsequently completed all 30 late admission controls:
one live preflight, two unchanged frozen-snapshot positives and 27 expected
rejections. `isolated-admission-validation.json` records the parent's measured
result; `shared-dependency-drift-failure.json` preserves the earlier failed run.
These are additional to the 103 synthetic/extraction/CLI checks. Late negatives
replay observed file digests/metadata and Git outputs with no host IO; Git dirty
and untracked states are simulated, not actual index mutations. Final cross-role
alias guards are not independently reached because earlier defenses reject first.
No compiler comparison or execution-approved manifest exists. The isolated
review-only manifest is ready for separate execution review; approval must not
be inferred from any of these preflight results.

## Explicit execution approval and launch

The user subsequently approved running the six-arm historical comparison;
merging remains unauthorized. Fresh review preflight passed. The separate
`execution-manifest-approved.json` differs from the isolated review manifest
only in status, verified by deep equality after restoring the review status.
Approved digest: `1037fab89ef9857f3d8417186a50d1c5bcd7cd682a7a412b556549c6a6721f64`.
Run evidence directory: `.tmp/frame-delay-three-arm-IEjZ6b`.
Coordinator session 21989 launched frame/original PID 50324. This is RUNNING,
not a parity result. Retain all evidence and wait for terminal state before
considering any retry; no parallel duplicate or automatic repair expansion.

### Terminal result: PASS

Coordinator 21989 finished EXIT0. All six children finished EXIT0 without signals:
frame 5 artifacts/12 executions per arm, delay 11/19 per arm, total **48/93**.
Complete repaired-baseline/candidate fixture arrays and rows are exactly equal
for both suites. Original/candidate equality remains false for both; original
failures are preserved, not reclassified. Frame late-import equals across O/R/C.
Parent independently compared complete saved R/C rows and fixture arrays; the
subagent independently confirmed all frame evidence and pins without rerunning.

`comparison-terminal-evidence.json` contains the verdict, six terminal summaries,
and SHA256/size inventory of every retained run artifact. Raw receipts/logs total
318MB and remain at the recorded local evidence directory; they are not embedded
in this small review checkpoint. This establishes only the approved frame/delay
preservation gate against bounded repairs. Closure, physical acceptance and full
direct-codegen retirement remain uncertified; Linux issue5807 is not waived.
No merge was performed or authorized by the execution approval.
