# WeakMap upsert registry rejection

Worktree: `/private/tmp/js2-5753-weakmap-registry-20260915`, branch
`codex/5753-weakmap-registry-20260915`, base
`cb07815129e65312bc8f02675644146318e1ce49`. No push or publication.

## Change

Only production owner changed: `src/codegen/collections-es2025.ts`.
Keep the correct Symbol.for brand. Before cached kernel publication and helper
index capture, prepare the actual symbol carrier and registry only when both
native-provider policy and standalone/WASI apply. The weak-key predicate tests
the canonical Symbol carrier, reads its ID, calls the existing keyFor helper,
and accepts only registry absence (`ref.is_null`). Empty registered keys reject.
Other primitive/object checks and the existing AnyValue tag-6 arm are unchanged.
No new production module or inventory entry is needed.

## Paired original corpus evidence

Exact base source: `e9b43d3325352435aa7f84185ccb308c52ab909b`, privately archived
under `.tmp/e9`, with its own generated bundles. Unmodified candidate: the
worktree base above, whose bundles are retained in `.tmp/cb-bundles`.
Corpus comes from git object `b363f29d3c43c626dc852744ad64a0b48a003693`, privately
extracted (not linked to the shared corpus). Original files:

- `test/built-ins/WeakMap/prototype/getOrInsert/throw-if-key-cannot-be-held-weakly.js`
- `test/built-ins/WeakMap/prototype/getOrInsertComputed/throw-if-key-cannot-be-held-weakly.js`

Their SHA256 values are respectively
`19a1f34edb1ee1cd94ab1123d7c73ddc144f8f2dce2b1896ae7681d8c901b913` and
`b78de9b1fcaf95d5aaf2c8a3c2a78ed4ff57f901030f0c6c63d4b8ebfc63366f`.

Default-policy actual CI-worker command, run in each subject directory:

```sh
TEST262_TARGET=standalone TEST262_SEMANTIC_PROVIDERS=auto \
TEST262_INCLUDE_PROPOSALS=1 TEST262_CHUNK_INDEX=0 TEST262_CHUNK_TOTAL=1 \
node_modules/.bin/vitest run tests/test262-chunk-dynamic.test.ts --maxWorkers=1
```

Each private corpus contains exactly these two test files plus the original
harness. Actual totals: e9 2/2 pass; unmodified cb 0/2 pass; fix 2/2 pass.
Candidate errors are the registered-symbol TypeError assertion, not import or
compile failures. Both fixed rows reach the test. Original import refusal and
diagnostic handling remain enabled. Default local worker count was 7.

Additional diagnostic: `TEST262_STRICT_RERUN=always node --import tsx
.tmp/weakmap-originals.mts <subject>` uses original assembly and CompilerPool
unified worker, a 300000ms outer request budget, and no fixture changes. The e9
equivalent was executed from stdin in `.tmp/e9` with an explicit count==4 check.
Totals: e9 4/4 pass; cb 0/4 pass; fix 4/4 pass. Primary/strict assembly hashes
match across all subjects. The `always` setting is extra coverage, NOT CI config
parity. Default assembly elides strict-neutral reruns; report `strict: both`
does NOT establish two executions. The initial driver that rejected this
elision remains unchanged, with its failed log retained.

All runs used Node22.23.2, not CI25.9.0. These are local paired results, not a
replacement full CI sweep or a claim about all 48,735 rows.

## Controls and retained receipts

All paths below are relative to the worktree, and remain on disk:

- `.tmp/weakmap-originals-e9-default.log`: e9 default 2/2.
- `.tmp/weakmap-originals-cb-default-valid.log`: cb default 0/2.
- `.tmp/weakmap-originals-fix-default.log`: fix default 2/2.
- `.tmp/weakmap-originals-{e9,cb-before,fix}-always.log`: four variants each.
- `.tmp/weakmap-controls-third.log`: 30/30 focused tests, no diagnostic skips;
  symbols, empty key, aliases/parameters, primitives, ordinary and boxed objects,
  distinct same-description symbols, well-known symbol, first Map/object then
  symbol, callback identity/suppression, standalone and WASI, import checks.
- `.tmp/weakmap-controls-second.log`: existing issue-3172 tests 33/33 pass;
  also retains four failures of an earlier synthetic positive expression shape.
- `.tmp/weakmap-host-body-equivalence.log`: gc/nativeStrings=true Map probe
  compiles byte-identically cb/fix under both host-assisted and native-first.
  This is a bounded two-probe host preservation control, not a full host sweep.
- `.tmp/weakmap-typecheck.log`: TypeScript7 clean.
- `.tmp/weakmap-{loc,func}-budget.log`: normal budget checks pass, no waiver.
- `benchmarks/results/test262-standalone-results-20260915021557.jsonl`: cb originals.
- `benchmarks/results/test262-standalone-results-20260915021738.jsonl`: fixed originals.

The initial bad dynamic shard index command ran zero tests and failed; its log
is retained and is not counted. The initial strict-elision driver failure is
also not counted as a complete baseline run.

## Explicit limitations

Two synthetic positive shapes exposed pre-existing candidate bugs: two computed
upserts inside a loop hit an out-of-range-local invariant; immediate `if` tests
around the calls leave a stale callback counter. Both were reproduced using
the unmodified cb bundle; receipts are `.tmp/weakmap-positive-loop-baseline.log`
and `.tmp/weakmap-inline-counter-baseline.log`. Focused tests instead capture
call results in locals before checking them, preserving the same value/count
assertions. Neither unrelated compiler bug was repaired or suppressed.

No claim covers arbitrary AnyValue tag-6 payloads; tested aliases are genuine
compiled inputs, not proof of every carrier. Legacy WeakMap.set/WeakSet.add
dynamic-key handling, host registry bridging, and argument evaluation ordering
were not broadened. No original fixture edits, gate waivers, or baseline refresh.
An unrelated checkout/LFS status for `website/public/acorn/acorn.wasm` was left
untouched; do not include it in integration.
