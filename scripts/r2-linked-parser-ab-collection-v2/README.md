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

| file | role |
| --- | --- |
| `contract.mjs` | the fail-closed oracle: canonical 16+8 matrix, pins, census states, declaration census, outcome joins, exact WAT ABI carriers, digests |
| `fixtures.mjs` | canonical 24-child report fixture plus every mutation operator |
| `baseline-naive.mjs` | **reconstructed pre-repair baseline** — see caveat below |
| `selftest.mjs` | static selftest and the five non-vacuity proofs |
| `relock.mjs` | manifest relock and `bundle/` byte-equality gate |
| `manifest.json` | relocked source digests, pins, expected census, root hash |
| `bundle/` | byte-for-byte mirror of every source above |

Run: `node scripts/r2-linked-parser-ab-collection-v2/selftest.mjs` and
`node scripts/r2-linked-parser-ab-collection-v2/relock.mjs`.

## The five audited false passes

The 2026-08-28 independent audit proved five FALSE PASSES. Each is now a
fail-closed check with a runnable two-sided mutation in `selftest.mjs`:

| # | false pass | repair | failure code |
| --- | --- | --- | --- |
| D1 | an arbitrary extra unitless `compileDeclarations` call passed | the physical-row census is CLOSED: every row joins an inventory unit or is the one sanctioned unitless exception | `declaration/unsanctioned-unitless-row` |
| D2 | a wrong-file prepared module-init outcome passed | outcomes join their inventory unit on every field, not by key presence | `outcome/join-mismatch` |
| D3 | a duplicate outcome key passed | the outcome index detects duplicates instead of `map.set` overwriting | `outcome/duplicate-key` |
| D4 | the parser's second WAT parameter `i32`→`f32` passed with hashes recomputed | the exact expected ABI is carried structurally, not only as a hash | `wat/abi-mismatch` |
| D5 | attempted/spawned/completed collapsed when a spawn threw | the three states are derived separately per child and cross-checked against the reported counters | `census/state-collapse` |

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

## Open items for the independent auditor

1. **`EXPECTED_WAT_ABI` values are pinned placeholders.** The repair is that the
   ABI is carried *exactly* rather than by hash; the specific parameter and
   result types must be confirmed against the landed L3 production ABI and
   re-pinned under the approved relock before any collection.
2. **The sole exception is enforced per child.** The issue says "each side must
   retain exactly one copy" of the graph-global unitless `compileModuleInitBody`
   row against `entry.mjs`. Each child is a separate compilation of the graph,
   so the contract requires exactly one per child record. Confirm this reading.
3. **The fixture is synthetic.** `fixtures.mjs` hand-builds a canonical report;
   it is not a captured collection. The inventory shape (one owned module-init
   unit in `empty.mjs`) follows the issue's description of the current bounded
   multi-source exception and needs confirming against a real frozen inventory.
