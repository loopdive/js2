# Historical Promise reader acceptance checkpoint

Subject: working tree on5c63aae46653370f5a2169dd08947d5c69b568e8,
including main2b8101b9bc9a1910ce32a26e5b74e8a503f5b471. Test infrastructure
only; no production, historical fixture, classification, allowance or gate edits.

## Evidence and preserved failures

The original pre/post-relocation176 rows and two collection failures remain in
5883-relocation-validation-exact-20261002.json.txt. Original91 failures are not
erased. The first successor run66222/83787 had836 passing assertions but exited1
on an unhandled onTaskUpdate RPC timeout. Preserve its complete raw/native
outputs, terminal and before/after manifests; it is not accepted as green.

Independent review identified a flat-only reader contract conflict. The repair
keeps that public reader and its unchanged56 controls; a separate historical
reader supplies the older authenticated view. The earlier suite now yields
between cases to avoid starving the worker's RPC. No timeout increases, skipped
cases, swallowed errors or changed assertions. New receipt formatting preserves
deep JSON equality; original receipt hashes are unchanged.

## Measured acceptance

- Second run79147/85931:892/892 across six suites, exit0, no unhandled errors,
  all7183 source/test/config pins unchanged. Original176 identities match exactly:
  layout31 and native145. Earlier216 and export24 now execute, not merely
  collect. New successor controls420 and unchanged flat controls56 pass.
- Runtime1025/86619:183/183 across thirteen suites, exit0, unchanged pins:
  original104 runtime,56 relocation and23 incoming built-in tests. Incoming
  S16's removed own-name assertion is still not certified by this population.
- Parent verified118 Git source/dependency/provenance pins, seven operands,
  47 spans,54 retained regions,27 dependencies and14 producing commits.
- Independent Sol-6.1 Medium review clears the amended reader boundaries,
  original assertions/mutants, scheduling-only yield and formatting-only receipt.

- Gates74842/86825: canonical, inventory-only, cycles, flat directory, LOC,
  function budget, coercion and oracle all exit0; frozen inputs unchanged.
  No allowance, gate or compiler baseline changes.

The reproducible exact archive includes initial failure and accepted results;
each gzip+base64 stream records length and SHA256, checked after decoding.

This reconstructs historical source obligations while authenticating current
owners. It does not claim current semantics equal the initial extraction,
complete-mode architecture acceptance, full IR equivalence or legacy retirement.
PR5883 remains held until remaining landing obligations and current protected
queue evidence justify removing that hold. No work is counted as delivered
until verified on loopdive/js2 main.

## Recovery verification, 2026-10-06

The former process handles 18842 and 99170 are absent. Their absence is not
treated as a test failure or a reason to rerun. The retained main-e357 runtime
report proves 330/330 tests passed across 22 files, with zero failures and exit
0, finishing 2026-10-02T11:03:53.025Z. Before/after input manifests are identical.
The canonical check also terminated with exit 0 and no changed pins.

Evidence remains under `.tmp/5883-maine357-runtime-incoming-20261002/`:

- `invocation.json`: SHA256 `89d05615ff3e4b3d9fe3d98ef7262322817ba5c69cc1a61b3135144b2ce96186`
- `terminal.json`: SHA256 `5d818db811fc1492f65034df1ea98f61c93db2d954ac77ceccc5b675d5cfb0c9`
- `native-results.json`: SHA256 `9ae5ddefc72504454c2d11ead9a4874690071d3b92315a2644fff5e2db7e4df9`
- `before.json` and `after.json`: SHA256 `dd47cba779ba95bd111c98a0ffd49c6c95f0e88b242759f6942780e9af200c5e`
- `raw.log`: SHA256 `38d092cae9981a21d241030b62efee269cd83a7ee6cd79de4d968b310cc525ec`

Fresh GitHub state confirms published head 6f73c8edd15a2fb88f3f7c34166ec5ce0337ae80
has successful quality, issue-tests, smoke and equivalence-gate checks. The PR
remains OPEN with hold. PR Test262 stubs do not establish conformance. Local
MERGE_HEAD remains e357d6080ef03f61a3a8359afbc467e29858749e, without unmerged
index entries; it is not committed or published. Current upstream main is
5f953c8e05919a304d5d3b8e3811e882962a9f33, so this evidence is specifically for
the e357 composition, not today's main.

Remaining landing work: preserve this exact evidence in the next archive;
complete reader and boundary acceptance for the composition; reconcile newer
main without losing either side; run normal hooks; publish to the existing PR;
use protected-queue evidence and verify the actual content on main. No legacy
retirement or completed IR-program claim follows from these preservation tests.
Heavy local tests have not been restarted while the ES6 census owns that slot.

The eleven exact streams are now retained in
`5883-maine357-validation-exact-20261006.json.txt`, SHA256
`716a798b912391f9cbb7e034b7e62589c7a1c456adb5eb69e2cbe4dc03928dc0`.
Every saved stream was decoded and compared byte-for-byte to its retained input.

### Next-main integration review

Fetch verified upstream/main at 5f953c8e05919a304d5d3b8e3811e882962a9f33.
Against the pending e357 merge, incoming source/test/inventory changes cover
309 paths. The checkpoint's 34 paths (relative to shared base 2b8101b9) overlap
four: compiler-boundaries.json, context/create-context.ts, context/types.ts,
and expressions/call-namespace-static.ts. This is a path-overlap measurement,
not a claim that Git will report four conflicts.

Preserve incoming class accessor and ambiguous-class-name sets in both context
initialization and types, new.target snapshot fields, ArrayBuffer.isView's
static-decision helper, Reflect.defineProperty's rejection-to-boolean result,
and Reflect prototype-method dispatch. Preserve the checkpoint's Promise
service ownership and call paths at the same time. Review inventory as the
union of actual owners, not by selecting one side wholesale. Current compiler
composition also includes newly landed Prepared/zero-suspension work; old
e357 test results cannot certify that integration.

### Static validation continuation

Parent rehashed all 7,199 runtime-run input pins on 2026-10-06: zero changes.
Fresh GitHub review query returned zero unresolved threads with no next page;
the published PR now reports CONFLICTING against newer main. Do not enqueue.

Static-only continuation runs in session 50828 via
`.tmp/5883-maine357-static-20261006.mjs`, with fresh logs and per-command exits
under `.tmp/5883-maine357-static-20261006/`. Inventory (base e357), cycles, flat,
LOC (base e357), function (base e357), coercion and oracle have each exited 0.
The preservation dead-export check and orphaned-script check then both exited
0; session 50828 is terminal with exit 0. All nine checks passed. No compiler
tests or typecheck were started in this continuation, and no gate/baseline was
modified. Preservation acceptance does not certify strict graph closure.
