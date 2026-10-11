# Shared native async declarations — implementation handoff

Base: a024d9c048b620bef2c4a95f89f09f23de44c938.
Branch: codex/3518-native-async-resource-declarations-20260909.
Worktree: /private/tmp/js2-3518-native-async-resource-declarations-20260909.
Claim: 3518:native-async-resource-declarations, owner ttraenkler/codex-native-async-resource-declarations. Canonical claim35098 exit0; independent upstream verification69730 confirmed the same owner. No implementation commit or push.

## Scope and interfaces

The frozen contract's seven production and five test files only, plus this owned handoff. No ledger, ABI catalog, consumer, physical-plan, canonical body algorithm, boundary inventory, or peer worktree edits.

All three existing reserve functions accept an optional expected declaration plan. Pure plans use resource keys, never guessed indices. Closure requirements instantiate actual authenticated type prerequisites; the live observer/cache loop consumes a checked recipe cursor. Argument vectors retain fresh/adopted array ordering and real fills. Promise retains 25 owned declarations, 26 operations, the actual borrowed argument array, and fresh inherited field records retaining metadata type identities.

Inventory accessors require the exact supplied plan and issued pack through existing private owners. They return declaration-order owned reservations, excluding external/adopted dependencies and keeping alias mappings separate. They do not attest successful body completion or whole-program/provider authorization.

Shared executor preserves declaration-list-as-lookup semantics; reservation steps determine execution order. Unnamed interning keeps exactly two arguments; named interning passes three. Signature observations capture the one actual operation's result. Self-indexed metadata is exclusively supported by the closure cursor's existing checked append frontier: generic execution refuses that shape before any allocation.

## Borrowed exception-tag limitation

The ledger exposes only reserve-phase assertTypeReservation. It does not expose a tag assertion, and physicalIndex rejects reserving. Promise retains the original tag association, rejects later substitution, and authenticates its actual ledger token after freeze. Parent remains responsible for genuine preallocation tag issuance. Existing fill still validates the tag descriptor/signature. Tests distinguish association currentness from initially foreign/copied tag provenance after freeze. No new ledger API or claimed reserve-phase tag authentication.

## Validation receipts

- First focused run97518: exit1,186/190 tests, five suites,18.49s. Three closure inverse mutation-target/attribution failures and one two-versus-three-argument unnamed interning failure. Retained, not relabeled as success.
- First TS710756: exit1. Owned closure/Promise declaration typing errors from scalar constructors annotated with broad ValType. Repaired by precise scalar annotations; exact donor-header inverse retained.
- Repaired focused run77955: exit0,194/194 tests, five suites,21.20s. Four added controls retain late physical rejection, actual signature mutation, inherited metadata type identity, and source-plan staleness.
- Repaired TS743844: exit0. Exclusive heavy slot released after this terminal result; no worker heavy process remains.

No original donor hash was changed. Original live controls remain individually present. Argument-vector factoring pins the complete pre-factoring canonical source hash 5be0cba6648fd0c6eee5ff66fdca78c318b6f1d28b7c2901b0a171930a3bd166 in addition to unchanged historical extraction receipts. Closure proof reconstructs complete live shape implementations and precise numeric delegates, with live mutation controls.

## Frozen R2 source/test SHA256

```text
ff7714e126ef320ff5ae8b26b3b135aaee65dc29d3dc92c4642ff016ff03e173  src/runtime/wasmgc/values/native-resource-declaration-types.ts
29fbb5476909236863201bc15f04f56ade29fbc50c47705eed3a74a426b06bfa  src/backend/wasmgc/resources/native-resource-declarations.ts
0f9e1fe72f60e7f24577bf12ef194629e0b77815339f335c37df5784950a5543  src/runtime/wasmgc/values/closure-layouts.ts
19b9f7e8e265df20997f8c3e40cd0bdf37d5723419575cd87536d8f7a5de1118  src/runtime/wasmgc/values/argument-vector-bodies.ts
e76ff3a42cb04f1b60e3320f019e15af640f857c2fc1d8d80eb5a77d328c1830  src/backend/wasmgc/resources/native-closures.ts
c39011af32edb14dd0db42aebaa0a62e9fe2957b333d2606696004ff73f0c07c  src/backend/wasmgc/resources/native-argument-vectors.ts
6ed23305d64b18890910954afaee436af0944371da6c0c8c7799250ec2fc15c7  src/backend/wasmgc/resources/native-promises.ts
1c7c617be4aa989db2c48ee936fabbc0d987568433c765a4aa6555b1079a6def  tests/issue-3518-native-async-resource-declarations.test.ts
6d0aca37aed5dc85ff393b2155c2768df9bb1e9c98c6279918727add06e84621  tests/issue-3518-native-resource-declarations.test.ts
e8d33e1797d0829acfa172b8ebd86eb7742e9a253c840dc82eca020a300b76ba  tests/issue-3518-native-closure-resources.test.ts
f9d44c89ac8490abcc1bcc8fef26616b7955384bd2715663fa129183fe06634b  tests/issue-3518-native-argument-vector-resources.test.ts
b93ca6a413e0e8af4c222442ea8ec61e65a21642a2a7b80cebea813a57c18d18  tests/issue-3518-native-promise-resources.test.ts
```

## Exact bounded commands

Run from the worktree above, serially:

```sh
NODE_OPTIONS=--max-old-space-size=2048 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/dist/cli.js run tests/issue-3518-native-async-resource-declarations.test.ts tests/issue-3518-native-resource-declarations.test.ts tests/issue-3518-native-closure-resources.test.ts tests/issue-3518-native-argument-vector-resources.test.ts tests/issue-3518-native-promise-resources.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
NODE_OPTIONS=--max-old-space-size=2048 GOMEMLIMIT=2GiB GOMAXPROCS=1 node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

High reviewed all twelve frozen R2 hashes and approved the scoped declaration/reservation checkpoint. The review verified operation order, cache observations, metadata type identities, adopted arrays, exact plan association and historical inverses. It does not cover full async fill/execution, aggregate integration or retirement.

Unrun at this handoff: broad suites, boundary activation, full async/frame consumer execution, normal implementation commit/push hooks. Parent is publishing after High approval. This lane does not claim native Promise full materialization from deliberately incomplete dependency fixtures.
