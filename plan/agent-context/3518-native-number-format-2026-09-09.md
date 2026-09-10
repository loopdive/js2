# Native number formatter D2 checkpoint

Status: formatted and validated worker checkpoint; final post-validation High
approval relayed by parent. Normal publication is authorized and in progress.
The validation slot was explicitly released after every worker process was
terminal; parent granted a separate exclusive normal-publication hook slot.

## Provenance and scope

Worker: `/private/tmp/js2-3518-native-number-format-20260909`, branch
`codex/3518-native-number-format-20260909`; upstream claim
`3518:native-number-format-D2`, owner `ttraenkler/codex-native-number-format`.
Original donor base: `efe352fee8afc3feb6a28c34d00fc658dc1fb205`.
Authorized fast-forwards to `7291f717833e3dba676b9f719f865a3eab9aaff3`
and then `57b4ee9ebd67f04251fe467d708e4990202b6ca7` preserved every
existing draft hash. The latter supplies the real published-prerequisite Ryū
implementation; inherited consumer/declaration changes are not formatter-owned.

Seven production paths, two tests and one authenticated donor fixture implement
the frozen D2 contract. This handoff and the issue appendix are the subsequently
authorized documentation scope. Parent additionally authorized exactly three clean
boundary classifications for the two formatter runtime modules and resource owner.
No allowed edges, histories, roots, ledger, source-admission, allowance or paused
P/C path was edited by this worker.

## Implementation and proof boundary

Canonical formatter builders serve both retained legacy callers and issued
resources. The resource recipe preserves finalizer; new/get/set/trap/fin;
prepared radix-body slot; thunk; nested Ryū mulShift/type/inverse/powers/digits/
toBuffer; decimal formatter; native adapter order. The nested Ryū pack is reserved
once in place, never reconstructed from public token shapes. Named signature
interning uses the composed declaration API. Completion requires canonical fills
and a sealed transaction; the resource owner never installs a radix placeholder.

Preservation checks authenticate complete canonical module envelopes, original
donor files, retained adapters, private-helper inverses and return boundaries.
Real donor and candidate module/registration/cache observations match for both
integer-before-scratch settings and partial-family expansion. Descriptor and
missing-fill failures have separate transactions. Callable/type resolution uses
canonical binding identity followed by complete contract comparison, including
codec-replayed references and foreign-owner/same-name negatives.

The execution tests produce the unchanged actual async example through D1,
retain its separate support body, and run the canonical intrinsic preparation
before actual WasmGC lowering. The production consumer must perform this same
preparation: the raw support body contains semantic math.floor without a frozen
provider. This is not permission to hand-assign providers or alter source IR.
Original/decoded support, both integer options, two instances, nonfinite/zero
boundaries, exact issue1537 generation order (20,000 raw draws, scaled magnitudes,
historical subnormal-labelled draws), supplemental raw bits, issue3305's 21 cases
and radices 2–36 execute against actual emitted Wasm. The guarded fresh process
uses the same live test harness and rejects source/compiler loads. Its child is
awaited asynchronously with PID/progress/terminal reporting, never auto-killed.

These are formatter resource/support execution proofs, not full async consumer
acceptance, public default cutover, ABI30 closure or direct-codegen retirement.
Parent owns final consumer composition and boundary activation.

## Actual serialized receipts, including failures

- Formatting `a46654`: exit 0; nine source/test paths, donor excluded.
- Initial unfiltered TS7 `29323`: exit 0.
- Full tests `4555`: exit 1, 27/35, 18.68 seconds. Three preservation-boundary
  failures; five executions rejected missing frozen math.floor provider.
  Replay child PID 29965 exited 1, signal null; no process was killed.
- Full tests `49767`: exit 1, 32/35, 21.75 seconds. All four in-process execution
  variants passed. Remaining failures: two formatting-sensitive inverses and
  prototype-sensitive comparison of decoded null-prototype values in the child.
  Replay child PID 30082 exited 1, signal null.
- Ownership-only `64487`: exit 1, 12/13, 9.54 seconds. A standalone scanner
  mishandled a template literal and swallowed subsequent source as template text.
- Final full tests `15960`: exit 0, 35/35 (13 ownership, 22 resources),
  22.67 seconds. Guarded replay child PID 30246 exited 0, signal null.
- Final unfiltered TS7 `50495`: exit 0. `git diff --check` passed.
- Normal commit `32091`: exit 1 before creating a commit. Biome rejected two
  literal spaces in the inline-reconstruction regex. Changed only their spelling
  to ` {2}`; post-repair validation is pending. No push ran. The publication slot
  was explicitly released after the failed hook was terminal.
- Inventory `49547`: exit 1 after adding exactly the three formatter records;
  inventoryValid=false, graphComplete=false, architectureComplete=false. The
  remaining six inherited Ryū modules lack classifications in base 57b4, producing
  29 inventory errors. These are already repaired in published parent 445f65523b;
  parent authorized a normal worker commit followed by normal merge of that exact
  dependency, not duplicate classifications or allowed-edge edits. Composed
  inventory, TS7 and formatter/boundary validation were subsequently completed below.
- Normal checkpoint commit `24543`: exit 0, creating `f4536c6fd6`; lint, LOC,
  function budget and oracle gates passed. Changed-root explicitly skipped 102
  files; that skip is not a test pass. Parent 445f65523b merged cleanly as
  `acf37ffbeb`, preserving all ten formatter files exactly.
- Composed inventory `36367`: exit 0, no errors, inventoryValid=true,
  graphComplete=false, architectureComplete=false, status
  inventory-valid-architecture-incomplete.
- Composed unfiltered TS7 `98290`: exit 0.
- Composed formatter and boundary validation `16745`: exit 0, 131/131 across
  three files (35 formatter, 96 boundary), 74.09 seconds. Guarded replay child
  PID 47709 exited 0, signal null. No restart or termination occurred.

Repairs after the approved static checkpoint were confined to tests: canonical
intrinsic preparation matching the existing legacy wrapper, AST-based import and
token traversal, actual exponential comment boundary, formatter-only trailing
comma normalization preserving separators/elisions, and canonical lossless data
comparison for decoded prototypes. Production changed only through formatting;
the donor fixture did not change. Earlier failures are not acceptance receipts.

Final replay artifacts remain at
`/private/var/folders/cv/0b_qldpn6ddcw_1md64v39700000gp/T/js2-number-format-replay-YOb1F6/`
(`program.json`, `execute.mjs`, `loads.jsonl`).

Commands, executed sequentially from the worker:

```sh
NODE_OPTIONS=--max-old-space-size=2048 GOMEMLIMIT=2GiB GOMAXPROCS=1 node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
NODE_OPTIONS=--max-old-space-size=2048 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 GOMEMLIMIT=2GiB GOMAXPROCS=1 node node_modules/vitest/dist/cli.js run tests/issue-3518-native-number-format-ownership.test.ts tests/issue-3518-native-number-format-resources.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose
```

## Frozen SHA256 manifest

```text
0788bfe42e17bad04a769df3913f23c40dc04b0d777c379250d3ed6c9bd94bfe  src/runtime/wasmgc/values/number-format-radix-bodies.ts
6268ee0d445466f8641f8791f4a24328b7ae3d36f529da515f6f276951b91cc6  src/runtime/wasmgc/values/number-format-bodies.ts
c5cd6dad450a3eaffa4d07c5864ec89bd09b2170d544c0373faa2773a42fcafa  src/runtime/wasmgc/values/string-literal-bodies.ts
19952b62d0c36e3a0b70b09faf344f550342cc7ebbfab60a72aa407187d49fff  src/backend/wasmgc/resources/native-number-format.ts
92b5a64afc25a63e3b35ec41dbd1ddb8730980824d0f6ab73dd4ad11b83943e1  src/codegen/number-format-native.ts
a5fa5c8199c0f573de4a19382407628623bb9182e3191c45cd76f79db1f9a90d  src/codegen/number-format-selfhost.ts
a76af5f3c54a4551dcb79fd0be21c0c0a51aa36a89689fde50c2188178142b01  src/codegen/stdlib-selfhost.ts
a72826f73ab9ed3a690aae1837bba59c9a56bfc3a5d7b372cb5a1a521703d7c1  tests/issue-3518-native-number-format-ownership.test.ts
0e706eff4fc50ffc217399708c97a630bff16f22b7ddada74a1c7d7bb1bfc311  tests/issue-3518-native-number-format-resources.test.ts
b657df49432294d2b90cb591b89287788452af2e76602fab9221985ec0e905e1  tests/fixtures/issue-3518-native-number-format-donor.json
```

Next: normal commit/push hooks and a non-draft PR stacked on the published
consumer/Ryū prerequisite #5798. Preserve Thomas Tränkler authorship, Codex co-author and actual-model
trailer. No force push, bypass, baseline reseeding or silent failed-proof removal.
