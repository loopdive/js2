# `r2-linked-parser-ab-collection-v2` — static validation adapter (#3521)

Status: **static contract only. No collection has been run.**

This directory holds the STATIC half of the R2-v2 collector specified by
`plan/issues/3521-ir-r2-prepared-program-free-function-compile-once.md`
(sections "2026-08-27 R2-v2 validation plan — replace the stale switch oracle",
"Versioned R2-v2 collection", "Relock, run, and interpretation gates").

It validates a collection **report object**. It never spawns a child, never
invokes the compiler and never touches a runtime. Per the issue, the 24-child
collection may only be run after an independent read-only audit and an approved
relock; nothing here authorises that run.

## Files

| file                 | role                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.mjs`       | the fail-closed oracle: canonical 16+8 matrix, pins, census states, exact physical-row/outcome joins, host-scoped normalized ABI descriptors, digests |
| `fixtures.mjs`       | canonical 24-child report fixture plus every mutation operator                                                                         |
| `baseline-naive.mjs` | **reconstructed pre-repair baseline** — see caveat below                                                                               |
| `selftest.mjs`       | static selftest, five audit non-vacuity proofs, and four production-model relock proofs                                               |
| `relock.mjs`         | manifest relock and `bundle/` byte-equality gate                                                                                       |
| `manifest.json`      | relocked source digests, pins, expected census, root hash                                                                              |
| `bundle/`            | byte-for-byte mirror of every source above                                                                                             |

Run: `node scripts/r2-linked-parser-ab-collection-v2/selftest.mjs` and
`node scripts/r2-linked-parser-ab-collection-v2/relock.mjs`.

## The five audited false passes

The 2026-08-28 independent audit proved five FALSE PASSES. Each is now a
fail-closed check with a runnable two-sided mutation in `selftest.mjs`:

| #   | false pass                                                                  | repair                                                                                                           | failure code                            |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| D1  | an arbitrary extra unitless `compileDeclarations` call passed               | the physical-row census is CLOSED: every row joins an inventory unit or is the one sanctioned unitless exception | `declaration/unsanctioned-unitless-row` |
| D2  | a wrong-file direct-legacy module-init outcome passed                       | outcomes join their inventory unit on every field, not by key presence                                           | `outcome/join-mismatch`                 |
| D3  | a duplicate outcome key passed                                              | the outcome index detects duplicates instead of `map.set` overwriting                                            | `outcome/duplicate-key`                 |
| D4  | `stringToNumber`'s second WAT parameter `i32`→`f32` passed with hashes recomputed | the exact expected ABI is carried structurally, not only as a hash                                               | `wat/abi-mismatch`                      |
| D5  | attempted/spawned/completed collapsed when a spawn threw                    | the three states are derived separately per child and cross-checked against the reported counters                | `census/state-collapse`                 |

## Caveat: `baseline-naive.mjs` is a RECONSTRUCTION

The original R2-v2 collector was **never committed to this repository**. It
existed only in an uncommitted working tree on the codex host, alongside the
119-line repair plan that was also lost. There is therefore no original
pre-repair code path to run a mutation against.

`baseline-naive.mjs` reconstructs the five pre-repair check shapes the audit
described. It reuses every unrelated check from `contract.mjs` and replaces
only the five audited strategies, so a mutation's PASS/FAIL split isolates
exactly one defect. This makes each mutation demonstrably non-vacuous — but
evidence produced against it is evidence about the reconstruction, **not an
observation of the original collector**, and must never be reported as one.

## Relocked production model

The independent production readout closes the former placeholders:

- `standalone` pins `stringToNumber(ref null $AnyString,i32)->f64`,
  `readNumber(ref null $__fnctor_Parser)->f64`, and `run()->f64`.
- `host` pins `stringToNumber(externref,i32)->f64`,
  `readNumber(externref)->f64`, and `run()->f64`. The descriptors contain named
  physical references, never numeric type indexes.
- Every child contains exactly two physical rows: one owned
  `empty.mjs::__module_init` direct-legacy row and exactly one immutable,
  unitless graph-global `entry.mjs` exception. The outer `prepared` tuple does
  not convert that module-init body into a Prepared terminal.
- Every child records the owned module-init as direct legacy with the exact
  `body-shape-rejected` terminal outcome. The fixture therefore reflects the
  same physical row and outcome on both outer direct and prepared routes.

`P1`–`P4` in the static selftest mutate the host ABI, module-init route,
physical row, and terminal outcome. Each still passes the reconstructed
hash/presence baseline but fails the repaired contract, proving the new checks
are non-vacuous. No runtime collection is run by these scripts.
