# IR migration handoff — 2026-10-07

User requested wrap-up, handoff and PR publication. Stop after publishing this
checkpoint; do not start another implementation or test run. No PR was merged
in this work period. Legacy code remains: replacement implementation and exact
equivalence are not complete.

## Publication and ownership

- Publish this documentation branch through existing non-draft PR
  https://github.com/loopdive/js2/pull/5748. Local branch is
  `codex/5748-main7443-integration-20260927`; push target is
  `fork HEAD:refs/heads/codex/5387-unsoundness-audit`. Before this checkpoint the
  remote head was `9057d39c5cf594940f3e57035c3b965dce7297f2`.
- Candidate PR https://github.com/loopdive/js2/pull/5883 already contains
  `b9bb743c0b3cbc0370807b2f85a9a6bff4d21b33`. Keep HOLD. Its evidence-only
  publication did not change the frozen candidate input map.
- Authoritative implementation/review plans are in repo issue
  `plan/issues/5197-es2015-standalone-promise-r2.md`. Fresh held-PR audits are
  in issues1058 and6440. Do not confuse these repo issues with GitHub issues.
- Parent owns plans, acceptance and integration; use native `gpt-6.1-sol`
  agents at medium effort for bounded independent work. Avicenna
  `01a112aa-f27d-78c0-adfc-4faa8482b096` owns custody preparation; Erdos
  `01a11307-fbae-7dc2-88a1-93db81c3487f` prepared the comparator.

## New terminal result: repaired baseline B failed

Full run ended at `2026-10-06T22:53:42.395Z`, exit1. There is no still-running
baseline job to resume or poll. Original run directory, relative to this docs
worktree:
`.tmp/erdos-5883-full-b-execution-20261006-01a03e4f-run-JVPkM7`.
Root terminal SHA256:
`20c0e59350ea2037707dcbde9325a04a9d5e9f891ea5c2e7ed4b02efcfa04d33`.

Canonical validation succeeded. Compiler-readers176, text-readers240 and
runtime351 passed. Incoming23 then recorded 2396passed/3failed/0pending out of
2399. Thus attempted native tests total3166: 3163passed and3failed. The runner
correctly stopped on this first failed stage. Repair-controls125,
imported-main117, additional18's narrowed17files/2000, and separate
baseline-projection-controls102 were **not executed** (2344 scheduled cases).
All before/after A/B/E maps remained unchanged; `accepted:false`.

All three failures are 35000ms timeouts in
`tests/issue-3518-historical-runtime-reconstruction.test.ts`:

1. `keeps current 6/21/7/82/75/37 populations separate from historical receipts`
   (line101).
2. `accepts original unchanged receipt src/ir/runtime/contracts/manifest.ts
   (67 declarations/0 functions)` (parameterized case at line853).
3. `retains the three overload records with their individual source-qualified
   ordinals` (line860).

Native report SHA256:
`1933e77757b7496a26a87f6751d9e2138884dd5e99282d95077beddfad2d5a7c`.
Raw stderr SHA256:
`9c11bba391c9ac5278259ea9e400238226fab64fa9302ab374386151b48fab29`.
Native messages contain generic stack traces; raw stderr supplies the timeout
diagnosis. Preserve both. Peer heavy jobs appeared after this run began; this
does not prove contention caused any failure. Do not silently raise timeouts,
drop cases, rerun over these receipts or claim the failed run passed.

Published custody artifact in this checkpoint:
`plan/agent-context/5883-full-b-terminal-custody-20261006.json`,31372949bytes,
SHA256 `3d1a0b224d7b903a94851b4afa4beed495f31a7959a2d32e47dd152cccc3d6f5`.
The normal commit formatter changed only outer JSON whitespace; parent verified
deep equality with the31373035-byte packager output whose SHA256 was
`cfba79344490cde519961ce130b4ace0bf75ec8862528a5e7bb330469e385cc6`.
Reviewed packager exited0; parent independently verified all168payloads against
source bytes and decompressed hashes (81run records,86child records,1manifest).
Nine explicitly referenced child directories are preserved. Missing conditional
delay stderr is recorded. Possible unreported child outputs in failed incoming23
remain unresolved: `childCustodyComplete:false`, never implicit completeness.
Manifest SHA256:
`37738144ddc41558daf7602f9ba33a0250216a7727202af659b6fbed7c41e818`.

## Frozen comparison, not current-main certification

- A: `/Users/thomas/.codex/worktrees/5883-original-main4bff-a/js2`, detached
  `4bffef14505f26558556a707931c711105a968af`,7735inputs.
- B: `/Users/thomas/.codex/worktrees/5883-repaired-main4bff-b/js2`, same base,
  31 intentional test/support changes,7740inputs. Preserve this dirty tree.
- E: `/Users/thomas/.codex/worktrees/5883-main4bff-composition/js2`, published
  b9bb above,7772inputs validated at source
  `112cea8e5a413eee1bec7ed955c14f73fc90bcdc`.

E completed6795 passing executions/6739unique identities/87files, including
56 declared repeats. E success does not override B failure. Shared B/E
population is5406; B's full schedule is5510 across70files. Earlier A/B failed
collections and first focused B failures remain preserved in the already
published E archives. Focused repaired B518/518 and B69collection5408 are not
substitutes for the incomplete full B execution.

Tracked reviewed tools:

- `plan/agent-context/5883-exact-terminal-be-comparator-20261006.txt`, SHA256
  `63d830bd6abe5d5ba459e856be2e6ea1571e32537a70e44381ac47835e18ecd8`.
  Not executed; no equality conclusion. Original `.tmp` executable is
  `erdos-5883-exact-terminal-be-comparator-20261006-01a03e4f.mjs`.
- `plan/agent-context/5883-full-b-terminal-custody-packager-20261006.txt`, SHA256
  `04edccb7d60147d2b05093c2fdb37f84f8e76e8e93d1c3c4bd6187b54fc13424`.
  Archives original run bytes and explicitly inventoried child evidence, not
  acceptance. Unreported child outputs from a failed stage must remain explicit
  unresolved custody, never inferred absent.

## Next session's order

1. Read this handoff and issue5197; verify remote PR heads and local ownership.
   Preserve main checkout's unrelated changes and every frozen evidence tree.
2. Inspect the three retained B timeouts before proposing any narrowly scoped
   repair/re-execution. Retain all original assertions, fixtures, identities,
   original failed receipts and separate acquisition-versus-semantic proof.
3. Complete exact duplicate-aware shared-identity outcome comparison only when
   evidence supports it. Keep completeness, outcome equality and cleanliness
   separate. No missing stages counted as zero failures.
4. Only then refresh candidate/main in a separate composition. The documented
   acquisition-only projection plan was audited for main410cc7da; newer main
   requires a fresh delta audit. Do not mutate this frozen comparison epoch or
   reuse its baseline as proof for a newer composition.
5. Shepherd existing held PRs dependency-first, with one integration owner.
   #5753 is conflicting and not superseded (42 added modules absent on main);
   issue1058 records ownership and historical176-case regression evidence.
   #5911 is conflicting, not superseded, and needs selected-constructor-only
   integration/realm isolation (issue6440). #6195 needs a real construction
   owner boundary, not cosmetic line removal. #5784 remains owner-held;
   #5942 remains do-not-merge. Recheck all states before acting.

Use one heavy job at a time, including normal push hooks. Never kill peers or
bypass gates. No old-code retirement, HOLD release, merge or end-to-end IR
completion is justified by this checkpoint.
