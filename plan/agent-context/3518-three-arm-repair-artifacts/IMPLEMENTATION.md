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
40 synthetic/extraction/CLI controls passed with no compiler invocation.

The driver records separate O/C and R/C equality, complete receipts and terminal
status. R/C comparison retains bytes, WAT, resource ordering, all unknown row
fields and all values. Late-import remains an additional exact three-way control.
Original failures are not relabelled. Population remains 48 artifacts and93
executions across six fresh arms; zero of those arms has been run here.

## Before execution approval

Finish independent driver/admission review and the remaining admission-mutation
controls. Prepare a REVIEW-ONLY execution manifest with all six arm entries,
full source inventories, fixture file pins, original evidence paths/digests,
driver/helper and adapted-child hashes, exact parent argv and environment, Node
binary identity and full dependency-tree census. This is still outstanding.
No manifest marked REVIEWED_FOR_EXECUTION has been created or supplied.

The parent and children deliberately use different invocation shapes. Parent
argv is independently pinned; children require fixed flags plus each suite's
exact source-program hash. Both require NODE_OPTIONS=--max-old-space-size=2048.
The full dependency census rejects external symlink escapes rather than silently
omitting dependencies. Any such failure requires explicit review, not relaxation.

Do not run the three-arm driver until the completed manifest and implementation
have been reviewed and execution separately approved. Do not waive issue5807,
normal PR checks or merge-group regression checks. No merge is authorized here.
