# Native async prerequisite composition

Isolated branch: codex/3518-native-async-integration-20260909.
Base: published consumer PR #5793, commit
`9ccad45c62a29d3e314448f80da1e5a70e92e8a9`.
Claim `3518:native-async-integration` verified upstream for
`ttraenkler/codex-native-async-integration`; terminal 50758 exited zero.

The pending merge is live-verified published Promise/closure join #5779,
`9bfd01b2674b97da8c99b2d9a2822911972a196e`, including closure #5778 at
`27d15c6f1adef787bb119538ced6e722a2cd29aa` and argument-vector #5776 at
`e3beb06321582908aba303fbcdf236d4c7a468c2`.

Production files merged without conflicts. The append-only issue conflict is
resolved preserving both sides. Boundary manifest and its test still require
explicit union of mandatory populations and both activation histories, without
relaxing allowed edges or reseeding historical digests. Parent delegated sole
writing of the manifest, semantic-provider boundary test, and this handoff to
Codex; all production and Git merge/index operations remain parent-owned.
The prior published checkpoint remains unchanged; no async refusal is removed.

## Boundary composition

Three-way base: `bfe31c8bd96d748e867562e3e9b78343b72d1877`.
The complete parsed manifests agree on every top-level policy field other than
files, layer entries/minima, and activation history. The composed classification
is their exact 1,351-file union. All other policy, including allowed edges,
external packages/assets, moves, and held evidence, is unchanged.

Independent test population: 102 modules (98 consumer plus four closure/argument
owners). Native runtime has 22 entries; backend WasmGC has 11. Their two new union
activation records precede seven original consumer records, four original
closure/argument records, then the common 43-record history. Total: 56 records.
Both complete parent histories remain exact ordered subsequences, independently
verified against their committed JSON. Original suffix digests remain unchanged;
only their offsets move to 32 and 38. Added full-parent history digest controls
also reject mutations in each branch prefix, not only the new union prefix.

Full-parent history SHA256 (JSON serialization, not raw file bytes):

- consumer 50 records: `4040a7108cfae3cc4746d38c1f68167d51556ba84d9a8f2f6fb44534ccb08680`
- closure/argument 47 records: `dfd3286a35182705e7d692244e756c3b592803831013232a5c0f2f71cdf8e9ac`
- common base 43 records: `52d7f4cd679071065e6aa845a4c7f55924df19e2b40b1f904a392732fd9115eb`

## Validation receipts

All runs use `NODE_OPTIONS=--max-old-space-size=2048`,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=2048`, `GOMEMLIMIT=2GiB`, and `GOMAXPROCS=1`.
Vitest uses `--pool=forks --poolOptions.forks.singleFork=true
--no-file-parallelism --reporter=dot`; no concurrent heavy invocation.

Initial bounded census terminal 46528 exited 1: 1 passed, 1 failed, 282 skipped
of 284 collected. The history/policy positive passed. The only failure was the
old parent edge-count expectation: actual 102 modules, 391 edges, 248 type-only,
143 runtime, with zero boundary errors. The measured expectation was updated;
no historical digest was reseeded.

Full boundary terminal 70325 exited 0: 284/284 passed, no skips, 169.24 seconds.
Command: `node node_modules/vitest/dist/cli.js run
tests/issue-3518-semantic-provider-boundary.test.ts` with the flags above.
The initial census used the same command plus
`-t 'pins the original|loads the complete actual'`.

Full unfiltered TS7 terminal 58123 exited 0, no diagnostics:
`node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`.

The 13-edge increase over the consumer's measured 378 is source-accounted:
argument-vector bodies and closure layouts each import two model types;
argument-vector resources import one physical type and three runtime modules;
closure resources import two types and two runtime modules; native Promise
adds one runtime import of native closures. Thus +7 type-only and +6 runtime.

Resource/caller terminal 9776 exited 0: 201/201 passed across five files, no skips,
329.49 seconds. Vitest used the same environment/flags and these exact files:

- `tests/issue-3518-native-promise-resources.test.ts`
- `tests/issue-3518-native-closure-resources.test.ts`
- `tests/issue-3518-native-argument-vector-resources.test.ts`
- `tests/issue-3518-type-reservation-auth.test.ts`
- `tests/issue-3518-native-string-value-consumer-execution.test.ts`

High approved the exact manifest/test hashes below. Both remain unchanged after
review. All validation processes are terminal; the worker explicitly released
the heavy slot after terminal 9776. No further tests or hooks are authorized or
running in this worker. These results validate prerequisite composition, not
new native async consumer execution or removal of the async refusal.

Frozen SHA256:

- `scripts/compiler-boundaries.json`: `cd0a37a6a08db91abd8412c16b155773659d3ebed4efecbac0131a18fe701f27`
- `tests/issue-3518-semantic-provider-boundary.test.ts`: `d63fcd18d3869862d17f48654eb7594185fdf33e3296c836e5930610e405c202`

No commit, staging, merge continuation, push, or hooks were run by this worker.
Index conflict status intentionally remains for parent finalization after High
review; the two working files contain no conflict markers.
