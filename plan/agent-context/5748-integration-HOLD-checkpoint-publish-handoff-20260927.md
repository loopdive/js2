# PR5748 integration checkpoint for parent publication — HOLD retained

2026-09-27. All agent compiler/test processes terminal; exclusive slot returned. **No staging, commit, push, new merge, hold change or production repair performed by this agent.** Parent requested this exact checkpoint manifest, then intends normal commit/hooks and a later main45626 integration. This is a handoff, not authorization beyond the parent's stated workflow.

## Exact checkout/index state

Tree `/Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927`, branch `codex/5748-main7443-integration-20260927`.

- HEAD `60fb42a20c0c71e1f273527571170e38da9e5d1e`.
- MERGE_HEAD `7443ab4826fde65b72f875e0af12337a35520932`.
- AUTO_MERGE `f141c1a41d4d4ed3b8afb2f0c3e72678b3a811d5`.
- Existing staged main merge is legitimate and must remain. Do not replace it with just this list or discard auto-merged upstream content. No unmerged entries.
- Five initial resolution paths already staged; formatting in two paths plus call-identifier five-line deletion remain unstaged. New v2.1 test and review artifacts untracked. Parent must stage current working bytes explicitly to include final formatting/deletion/test, not just commit the older staged resolution.
- The historical `5748-main7443-resolution-only-20260927.patch` remains the ORIGINAL five-file staged resolution versus AUTO_MERGE, NOT a final complete patch including formatting/deletion/test. It must not be presented as the final current diff.

## Exact incremental stage paths

Run only after parent verifies cwd/branch. These are additions/updates to the existing legitimate merge index, not an instruction to replace it. No wildcard or `git add -A`:

```text
scripts/compiler-boundaries.json
src/codegen/bindings/initializer-carriers.ts
src/codegen/expressions/calls.ts
src/codegen/expressions/extern.ts
src/codegen/index.ts
src/codegen/expressions/call-identifier.ts
tests/issue-5748-branded-string-binary-routes-v2.test.ts
plan/agent-context/5748-main7443-resolution-only-20260927.patch
plan/agent-context/5748-main7443-source-integration-handoff-20260927.md
plan/agent-context/5748-main7443-first-validation-receipt-20260927.md
plan/agent-context/5748-bigint-string-resolution-proposal-20260927.md
plan/agent-context/5748-approved-bigint-deletion-validation-20260927.md
plan/agent-context/5748-main7443-wide-carrier-paired-receipt-20260927.md
plan/agent-context/5748-numeric-i64-additive-probe-handoff-20260927.md
plan/agent-context/5748-numeric-i64-first-pair-instrument-failures-20260927.md
plan/agent-context/5748-branded-binary-routes-v2-source-handoff-20260927.md
plan/agent-context/5748-branded-v2-first-pair-receipt-20260927.md
plan/agent-context/5748-branded-v21-maintenance-pair-receipt-20260927.md
plan/agent-context/5748-frozen-numeric-v1-705b.test.ts.txt
plan/agent-context/5748-frozen-branded-v2-f635.test.ts.txt
plan/agent-context/5748-integration-HOLD-checkpoint-publish-handoff-20260927.md
```

The first5 are reviewed conflict resolutions; sixth is the approved diagnostic5-line deletion. No brand gate or other new coercion-engine edit. Source hashes are in the execution receipts; final test SHA **daa4b42dfb4dd54ec176dc8a1244ae46cba780320e63e2b9b68996ce3c8d6677**. Filename remains v2 but bytes are documented v2.1.

## Failed manual diagnostic preservation

The failed additive v1 is NOT left in tests discovery and was never an old original fixture. Full byte-identical archives are publishable outside discovery:

- `5748-frozen-numeric-v1-705b.test.ts.txt`: **705bc72f648b977aed9aac6c3702710c2400701df34297cbb717352805d69184**.
- `5748-frozen-branded-v2-f635.test.ts.txt`: **f635cd069727e3125c7b6c29b3327a9d3fedec324c37f6e1b762e234dc7dda74**.

Matching `.tmp/5748-numeric-i64-v1-705b-frozen.test.ts` and `.tmp/5748-branded-string-v2-f635-frozen.test.ts` retained. Do NOT stage `.tmp` broadly or restore failed v1 into default discovery. First raw logs/JSON remain in their exact candidate/baseline .tmp locations with hashes in receipts; this stage manifest publishes receipts and frozen source, not every raw log. If durable remote archival of all raw outputs is required, parent should stage an explicit additional evidence manifest/copy set, never silently imply local .tmp reports were committed.

All original tests unchanged: no resolution delta to tests versus AUTO_MERGE in the staged merge, and no working changes to tracked original tests. Existing upstream automatic fixture changes are retained from the main merge. Current added passing test is a separate diagnostic; no original failure expectations removed.

## Final execution/slot summary

Latest complete grant:

- V2.1 fullsrc+additive TS7 **36426 →17c63a exit0**.
- Exact7443 v2.1 baseline FIRST **21931 →e35de6 exit1**, constructor fails, direct passes: **1/2**.
- Integration v2.1 SECOND **11635 →7b977d exit0**, **2/2**.
- Binary copy verified byte-for-byte on all4case compilations; each subject's compiled binary, native/actual values and routes identical to its executed v2 records. No decoder rewrite.

Earlier bounded integration controls: rest24/24, regexp18/18, provisioned default/generator125/125. BigInt original5-file batch76/77; sole wide-carrier narrowedString failure reproduced on exact owning main with25/25 matching names/outcomes (both24/25). Original5399 full30/30 and6182 String13/comma8 pass. Prior TS2367 fixed by reviewed five-line deletion, prior format2files corrected. First missing-fixture125batch123/125, v1instrument0/2each, v2 BufferSource TS7failure remain preserved and explicitly superseded only by their specified later checks, not erased.

**Limits retained:** native numeric-i64 source unsupported/unmeasured (alias lowers f64); branded v2 direct-graph decoder ignores indirect/quoted helper edges and does not prove runtime branch coverage. The constructor has actual binary i64 ABI and concrete number-vs-bigint formatter evidence; this is not general BigInt acceptance. Four original array blockers, rest/spread effect-order gap, other semantic blockers, Hume final acceptance review, full IR equivalence/retirement and PR HOLD are NOT cleared.

## Parent formatting and verification before publication

Parent applied pinned Prettier to the new test and new Markdown receipts. The
published test SHA is now `80d3861d83fe97ae7a89bccee27682526efd8748face49cee0985cce6e5d68ea`.
It was verified byte-identical to canonical formatting of the executed
V2.1 source retained in the untouched baseline overlay; no semantic edit.
The original execution hashes above remain historical identities, not hashes
of the formatted publication copies. Raw logs, JSON, and frozen source archives
were not reformatted or overwritten.

Parent reran the complete two-case test after formatting: session77619,
terminalc27674, exit0,2/2 passed. Report `.tmp/5748-v21-parent-formatted.json`.
Source/test/script whitespace checks pass against pinned main. The whole merge's
whitespace check reports existing upstream patch/TSV/issue-document whitespace;
those inherited evidence files were retained unchanged rather than rewritten.

## Parent next boundary

Review exact incremental staged content and normal attribution/hooks before committing this merge checkpoint. Keep author Thomas Tränkler <git@thomas.traenkler.com> and actual Codex co-author per repository instructions. No no-verify/config bypass. This agent has NOT committed it. Only after completing/reviewing existing merge should parent merge its chosen pinned latest main45626 (landed immediate constructor prerequisite); do not silently relabel7443measurements as45626validation. Publish as HOLD checkpoint with bounded evidence, not merge-ready/full acceptance. New compiler/hook work belongs to parent after explicit slot return already delivered.
