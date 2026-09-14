# Same-owner staged closure reservation checkpoint

Implementation owner: Hilbert, existing Codex GPT-6 Astra Low agent.
Base: 445f65523b9b8023339ef344e0eed7a62e1a7bcb.
Branch: codex/3518-staged-closure-reservations-20260909.
Authoritative contract SHA256:
`a610a2b9c56a5c0b60c247ea258cdb9d2ef6ec654167523db3155fc4cc3173c4`.

## Explicit ownership transition

Parent relayed Euclid's explicit author handoff of native-closures
(claim 59db64f20b) and native-promise-closure-join (claim 3cdac21441), including
associated tests, to Hilbert for this exact six-file contract. Euclid stated
there were no pending writes or overlap; formatter ownership remains his.
Hilbert explicitly handed off his own completed native-async-resource-declarations
scope (claim 10a32fb328) only where this new six-file contract overlaps.
No old assignment was released, overwritten or force-stolen. Published source
snapshots and donor fixtures remain unchanged in their original worktrees.

Fresh canonical check 37608 found staged-closure-reservations unassigned and
the two old scopes still at the exact handed-off owners/timestamps. Claim99637
exited zero for ttraenkler/codex-staged-closure-reservations. Independent read87269
confirmed that owner and read upstream assignment tip
b5cf3ef275d0edb7bfa65046258f64b35ae9ef56. Its check reports exit3 for a held
claim; the combined command exited zero after the successful remote-tip read.
Worktree creation75847 exited zero. All five existing scoped source/test files
were byte-identical between approved f092bf9 and chosen 445f655.

## Reviewed-source validation snapshot

Six source/test paths only, plus the copied High contract and this handoff.
One owner and generator retain the original cache/observer state and exact pack
through canonical request boundaries. Full metadata population must precede
the first pause. Prefix evidence retains own-property identities, values and
descriptors; complete finalization retains the historical frozen value shape.
Promise reserve and reserving inventory accept the exact settle prefix;
Promise fill still requires full closure completion.

Recovery canonical `--check` first failed with exit6 because sandbox DNS could
not resolve GitHub; the normal escalated read exited3 and confirmed the same
owner, since 2026-09-09T07:20:47Z. No new claim or assignment write occurred.

High statically approved both pinned production files without a correctness
blocker. The original private structuredClone snapshot remains unchanged;
no additional freezing or ledger API was introduced.

Scoped test formatting exited0. TS7 session40649 exited0 with
NODE_OPTIONS=--max-old-space-size=2048, GOMEMLIMIT=2GiB, GOMAXPROCS=1.
First four-suite session33713 exited1: 170/172 passed. Failures were the
physical-only preflight mutant (still rejected by the complete canonical walk)
and an old missing-request diagnostic expectation. The revised test explicitly
retains that independent canonical protection and rejects a combined
prefix-only walk mutant. The Promise expectation names the actual prefix guard.
Rerun4029 exited0: 172/172 in four suites, 26.51 seconds. TS7 precedes those two
test-only repairs; no later TS7 run is claimed. Heavy slot explicitly released.

Actual original/decoded source Promise interleaving covers fresh/cached suffixes
and all three lazy-observer timings, retained infos, canonical combined
reserve/intern order (including implicit unnamed function-signature interning),
and complete final shape. Existing fixed donor receipts remain unchanged.
Additional live mutations and stale caller/prerequisite controls retain
positive-first tests and future-ordinal probes. No full native-async execution
or complete Promise fill is claimed; genuine missing fill dependencies remain
an explicit frontier. Parent relayed final proof-repair static approval after
the 172/172 run. Final TS7 covering the two test repairs, final parent diff
approval was subsequently granted conditionally on final checks. Final TS7
session11727 exited0 after the test repairs and scoped production formatting.
Normal publication hooks remain pending.
No schema, ledger, ABI, runtime body, formatter or parent consumer edits.

## Frozen SHA256

The following are the reviewed 172/172 snapshot. Final Prettier changed only
production formatting; publication source SHA256s are
`a6475adb14b6bc72acc81f7afa25fe41c828d71178e56ef026ff24c969ba1372`
(native-closures.ts) and
`c463a607a35166e7bc33f2d0e6fc66902741352bf012cb8c48a7f6893ba0d8f5`
(native-promises.ts). All four test hashes remain unchanged. Final TS711727
passed this formatted source/test snapshot; 172/172 belongs to preformat4029.

```text
dcfa171c916359d26eed08b7f4c9967792d23c753bf16ed46bc77d908ae7baaa  src/backend/wasmgc/resources/native-closures.ts
2dd5ba7bce742dc8c11b8b35c011d4665efa450472a4011a868ffc5f74dd92b8  src/backend/wasmgc/resources/native-promises.ts
b7d38ece7a11e46fc777db09a04a5348e5b612f28604a7ced4b3394dfff14b01  tests/issue-3518-native-closure-staged-reservations.test.ts
f812c61fee324c6737877f5a6edab25678b9e1d97404ba91ef9348aa15d6ad35  tests/issue-3518-native-closure-resources.test.ts
0b4b7e31a2ed7377f28f5304db7c94923e170d28082fd71224a42ec612f523e3  tests/issue-3518-native-promise-resources.test.ts
ae6f66fbe90de9be05d059ac05dd74339d7acc6bd6e7de816f4b612655b193f9  tests/issue-3518-native-async-resource-declarations.test.ts
```

Focused command (both invocations):

```sh
NODE_OPTIONS=--max-old-space-size=2048 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/dist/cli.js run tests/issue-3518-native-closure-staged-reservations.test.ts tests/issue-3518-native-closure-resources.test.ts tests/issue-3518-native-promise-resources.test.ts tests/issue-3518-native-async-resource-declarations.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
```

## Publication preparation (not executed)

Worktree-local `.tmp/staged-closure-commit-message.txt` and
`.tmp/staged-closure-pr-body.md` contain the proposed message and held-PR body.
Author configuration was read back as Thomas Tränkler
<git@thomas.traenkler.com>; it must be verified again before committing.
The message includes Codex co-author and Model: Codex GPT-6 Astra Low.
Parent owns the heavy slot for E1 publication. No staging, commit, push or
PR creation has occurred for this checkpoint. Its stack base must be confirmed
with parent before publication; no merge or main update is implied.

## Subsequent publication and integration preparation

The preparation statement above records the earlier state, not current status.
Normal commit 88977 and push 31714 subsequently exited zero, including 18/18
numeric push-hook tests. Published commit
`7482ce3d2fc68588ff594e911a6d3a83ff493f13` is held, non-draft PR #5803,
targeting the formatter integration branch rather than main.

Parent prepared its merge onto published string-output/formatter checkpoint
`b96257280d026df7fd5a4951d6e4aa8b31764eab`. Production and tests merged
without conflicts; the issue-log append conflict was resolved by preserving
both histories. The combined tree has not yet been tested or committed.
The shepherd owns the serialized heavy-validation slot during preparation.
The 172/172 receipt above belongs to the worker snapshot, not this combined tree.
TS7 includes source files only and does not typecheck the test-only repairs.
Full native async execution and direct-codegen retirement remain unproven.

## Combined integration validation

Parent session 17294 exited zero: source TS7 followed by 275/275 tests across
seven suites (64.89 seconds). These were the four staged-closure/Promise/resource
declaration suites plus formatter requirements, string-output bodies and
string-output preservation. This is the combined b962572 + 7482ce3 working tree,
not just the original worker snapshot. All six production/test files remain
byte-identical to the published closure checkpoint. No tests were weakened.

The first launch exited one before typechecking/tests because it referenced an
uninstalled native-preview compiler path. The successful retry used the actual
package script's typescript7/lib/tsc.js. TS7 covers source, not test-only typing.
Normal commit/push hooks and remote verification are still pending at this entry.
