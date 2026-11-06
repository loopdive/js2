---
id: 6977
title: "Provision standalone Temporal in baseline refresh to prevent the 87.2% to 78.3% regression"
status: in-progress
assignee: ttraenkler/codex-temporal-baseline
priority: high
horizon: s
goal: conformance
requested_by: Thomas Tränkler
created: 2026-10-13
---

## Problem

Scheduled and emergency baseline refresh runs omit the standalone Temporal
provider job and cache environment used by canonical sharded Test262 CI.
The d2321851 canonical baseline has 42,064 official passes out of 48,232;
the 3af3ca8d refresh has 37,748. The only intervening commit changes five
generated JSON files. Both JSONL populations contain the same 48,735 paths
and use oracle 15, honest standalone semantics, and automatic providers.
Exactly 4,313 Temporal paths lose PASS (3,867 FAIL; 446 compile errors).

## Repair

Build and stamp the standalone provider once with the maintained prewarm CLI.
Require artifact delivery to every refresh shard at `.test262-cache/temporal`.
Before measurement, use the maintained lane, stamp and compiler-fingerprint
APIs to refuse missing or mismatched eligibility. Preserve verdicts, baseline
promotion gates, compiler semantics and population.

## Acceptance

- [x] Refresh shards depend on a hard-failing standalone Temporal producer.
- [x] Each shard receives the artifact and selects the same Temporal cache.
- [x] Exact workflow eligibility code rejects missing and mismatched stamps.
- [x] Fresh provider builds and passes the eligibility check.
- [x] Same-code unlinked sample reproduces the baseline failure signatures.
- [x] Linked sample passes all six originals, including five Temporal rows.
- [ ] Protected CI checks pass and the workflow repair lands on public main.
- [ ] A complete linked refresh publishes current standalone conformance.

Local proof uses Node 24.19.0 on macOS arm64; Actions uses Node 25 on Linux.
A focused sample is not a full-census score or a claim of restored 87.2%.

## Verification receipts

At public source `be9b173052c92f77710066e4e5a61a1e7b3a5ec1`, the cold
standalone provider built in 24.489 s (4,324,263 B). The worker linked it with
`cacheHit=true`. The exact workflow eligibility program exited 1 for an absent
stamp, 1 for a wrong compiler key, and 0 for the matching current provider.
The one-worker linked shard passed 6/6 original files with oracle 15.

A first attempt linked Temporal but lacked QuickJS: 1 PASS and 5 setup FAIL.
It used the ignored `TEST262_POOL_SIZE` setting and thus the default seven
workers. That attempt is retained and provides no semantic validation credit.
The completed linked rerun uses maintained `COMPILER_POOL_SIZE=1`.

QuickJS core acquisition: public run 38328327117, artifact 11782371162.
The archive's core key is `04a9abfac8350642`; core SHA-256 is
`95333826e7c8c8ed7398203891db713dc44368c86a24dae6fe6da7d3004fa36c`.
The build-info/ABI checksums and current shim/build/patch recipe matched.
The historical adapter was omitted. A fresh adapter `a3b8778e4685b1bb`
was built for current bundle fingerprint `d4b7c2cbd2cff04c`, passed its canary
and the maintained `--require-cache` linked-pair verification.

On the same source and bundles, the unlinked control has 1 PASS, 3 FAIL and
2 compile errors; linked has 6 PASS. All five Temporal rows reproduce the
historical failure text exactly without the provider. The Math/sign control
passes in both. Both selections use the exact same six original identities,
honest oracle 15 and auto providers; compiler path records remain legacy,
configured hybrid and execution unknown. No IR score is inferred.

The workflow YAML parses and all job dependency names resolve. Prettier and
`git diff --check` pass. Full refresh/publication acceptance remains pending.
