# Native realm infrastructure checkpoint handoff — 2026-10-01

This checkpoint adds native realm catalog/requirements, authenticated realm state and carrier layouts, shared source-closure state, declaration/bootstrap owners, and mixed ordinary/String/native/source object structural access. It does not complete the public native realm or retire legacy code. Mixed Get, general Call, source execution authority, full intrinsic population and the public Number provider remain unavailable and refuse completion.

## Integration and ownership

Integration branch: `codex/3518-native-realm-mixed-main-20261001`, based on freshly verified loopdive/js2 main `4c5a334669d3d9ac4db29e850f73d65965ba89f6`. The initial validation base was `25ee5b64b883b6d735b1072272a24d8740256e0b`; the later fast-forward changed only six npm benchmark JSON artifacts, with compiler/tests/configurations identical. The prior graph tree is preserved at `/private/tmp/js2-ir-public-native-object-number-graph-20260930`, branch `codex/3518-public-native-object-number-graph-20260930`, original HEAD `8a730516ced8ace5da216cbb8f5b5c54c064d421`.

Three additive metadata conflicts were resolved by preserving main's issue record, compiler entry ordering and delivered Function runtime leaves before appending graph entries. No source conflicts occurred. Inventory has 1,749 file records; native-runtime minimum is 97, preserving its existing floor offset. Signed historical composition receipts are retained, not rehashed.

Issue claim: `3518:public-native-object-number-graph-20260930`, owner `ttraenkler/codex-public-native-object-number-graph-20260930`. Claims live on upstream `issue-assignments`, issues in `plan/issues`. Release this claim on stand-down; do not mark the whole migration complete.

## Evidence and original failures

The original nine-row public Number acceptance suite is preserved verbatim alongside this handoff as `issue-3518-public-number-object-712.test.ts.txt` (SHA-256 `afc3885f51522cec10d5eccac536636b104b9a01b8c5e5c139b8dbd5fef35d37`). It was an unlanded diagnostic in the preserved graph tree. It is not included as a discovered test in this separately scoped infrastructure checkpoint. No assertion was edited, skipped or changed to expect failure. Its fixture remains `tests/fixtures/issue-3518-native-object-access-712.ts.txt` (SHA-256 `c0550b99175c0eb61afa7d5d110a287f3fe90e9fc8e581c6d58a19fe0a971ba9`). Restore the exact suite into `tests/issue-3518-public-number-object-712.test.ts` and run Vitest there when implementing public completion. It must pass unchanged before claiming that coverage.

Restore and execute from the repository root (this intentionally reproduces the unresolved acceptance bar):

```sh
cp plan/log/3518-native-realm-checkpoint-2026-10-01/issue-3518-public-number-object-712.test.ts.txt tests/issue-3518-public-number-object-712.test.ts
node node_modules/vitest/vitest.mjs run tests/issue-3518-public-number-object-712.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
```

Last measured public result is **5/9**: oracle plus four legacy controls passed; four original/decoded UTF16/UTF8 public rows failed with `runtime feature js.number.from-value has no provider`. `public-number-original-baseline.json` preserves every row and original failure. This is historical measured evidence, not a new integrated-head run.

On the preserved old base, new genuine literal-authentication controls passed 24/24, mixed structural controls 37/37, boundary/requirements 375/375, TS7 and seven preservation gates passed without input drift. The formerly timed-out mixed row improved from 40.134s to 23.271s under the unchanged 35s limit after obtaining one fresh original String inventory per builtin literal list. Original timeout and repair results are retained in adjacent JSON files. Historical broad 1,390/1,417 and 808/839 results plus collection failure remain separate in the issue record; never aggregate them into green evidence.

First fresh integration cohort (`integration-first-cohort.json`) measured 1,012/1,106: all ten non-later-main files passed (literal24, closure-state71, delivered Function245, mixed37, catalog declarations26, layouts32, requirements26, source integration24, wrapper24, boundary349). All 94 failures are in the 248-row later-main suite: 92 current-donor hash mismatches and two missing-span failures after main's real TypedArray dispatch change. No input drift or skips occurred. The scoped repair adds a separate exact outer TypedArray composition receipt; old receipts, raw readers and production dispatch remain unchanged. The repaired historical cohort measured 607/680, with new TypedArray29, original later-main248, array73, builtin metadata28, closure-source27 and closure-state71 all passing. Its 73 failures are in two unchanged suites: argument-vector59 and resume-main14. An isolated exact-main checkout, with only eight identical test-input adapters and no production overlay, reproduced all 204 rows with identical statuses and first failure messages (131/204 passing, 73 failing, zero candidate differences). See `integration-repaired-historical-cohort.json`, `current-main-paired-attribution.json` and the exact test-only overlays in `current-main-attribution-inputs.json`. This establishes those specific row failures under that historical test view; it does not certify every main test. The 14 resume rows include generator4, native String6 and prototype-store4. Preserve their failures; no predicates or receipts were weakened. Seven fresh gates passed (LOC, function, oracle, coercion, JS-tag, inventory, dead-export preservation), with zero source/test/script drift. TS7 passed on the frozen repair. The legacy reachability audit's preservation result is not architectural closure: graph OPEN, strict modeled closure FAIL, retirement/deletion NOT CERTIFIED.

## Verified delivery and pending work

Function call/apply algorithm PR6369 delivered as `6383d2187cac76626dd04c1a37e1733997c79c00` from exact head `5dd3fc53264ecd0f8503ca8af133730d35844465`; actual 82 standalone and 20 host merge-group shards plus CI/CLA/differential passed. Both head and merge are ancestors of the fresh integration base; source/test contents were verified. This infrastructure checkpoint is not delivered until its own protected merge is verified on main.

The complete next Get/Call implementation brief is appended to `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`. It requires genuine per-source identity and original-slot authority, the same source emission/all-source association/lowering completion join, reciprocal pending Get/Call ports before the sole freeze, and explicit full-catalog completion. Do not infer source identity from transport shape or trust mutable headers. Never treat a visited cycle, caller-populated counters or ready flag as completion.

Full scope remains all 45 intrinsic identities, 44 Call algorithms plus lifted entries, two Construct entries and transitive dependencies; source modes, Function/bound/Construct/newTarget, dynamic Function/eval/with, original public nine-row parity, and equality on both backends remain open. Retire old code only after all IR behavior is implemented, tested and equal.

## Preserved parallel work

Number integration remains at `/private/tmp/js2-ir-number-current-main-20260930`; realm/source integration at `/private/tmp/js2-ir-native-realm-source-integration-20260930`; later-main preservation at `/private/tmp/js2-ir-later-main-preservation-layer-20260930`. Their dirty prepared work is untouched. The canonical root remains owned by a parallel Deno session and is untouched. Do not overlay these branches wholesale. Claim the next implementation slice before edits.

Detailed local receipts, raw claim record, source pins, validation commands, composition review, hook logs and publication state are under this integration tree's `.tmp/graph-delivery/`. All Git actions use normal signing/hooks and fork publication; no force push or protected-main bypass.
