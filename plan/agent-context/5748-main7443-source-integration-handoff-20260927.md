# PR5748 + pinned main7443: source integration, NOT validated

2026-09-27. Original plan read completely: protocol-get tree `plan/agent-context/5748-main7443-conflict-resolution-plan-20260927.md`. User then authorized implementation in a new isolated tree, without compiler/typecheck/format/hooks/commit/push. This handoff reports only that implementation. Parent push1269 is terminal; no compiler slot was granted here. New PR6189 and shared config locks were not touched.

## State and exact inputs

- Tree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927`.
- Branch: `codex/5748-main7443-integration-20260927`.
- HEAD remains PR5748 `60fb42a20c0c71e1f273527571170e38da9e5d1e`.
- MERGE_HEAD is pinned main `7443ab4826fde65b72f875e0af12337a35520932`.
- Merge base: `aafae4c03c1fe2811d6ccfd30008326157281cca`.
- Actual merge AUTO_MERGE tree: `f141c1a41d4d4ed3b8afb2f0c3e72678b3a811d5`. It differs from the earlier simulation tree because conflict labels use HEAD, rather than the first commit hash.
- Merge is still **uncommitted**. Five source/inventory resolutions are staged; `git ls-files -u` is empty. Review artifacts are untracked and not staged.
- No original checkout was modified. No remote write or PR hold/queue change. No locks removed and no persistent Git configuration changed.

Creation and merge commands (cwd/branch printed immediately before each mutating operation):

```sh
GIT_LFS_SKIP_SMUDGE=1 git -c core.hooksPath=/dev/null worktree add -b codex/5748-main7443-integration-20260927 /Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927 60fb42a20c0c71e1f273527571170e38da9e5d1e
GIT_LFS_SKIP_SMUDGE=1 git -c core.hooksPath=/dev/null merge --no-commit --no-ff 7443ab4826fde65b72f875e0af12337a35520932
```

Hooks were disabled only for these two commands to honor the explicit no-hooks authorization; no commit hook bypass occurred because no commit occurred. LFS smudge was skipped during checkout/merge, retaining tracked pointers instead of initiating payload downloads. No dependencies were installed and no test262/provider build was launched.

First sandboxed worktree creation failed before creation: terminal1e8211 exit255, ref-lock permission denied. Approved escalation created the worktree, session83050 terminal5fa26b exit0. The authorized merge ran as session62079, terminalf047d8 exit1 with the same four expected conflict paths. No live process remains.

## Reviewable exact delta

`plan/agent-context/5748-main7443-resolution-only-20260927.patch` is the exact staged five-file diff against **actual AUTO_MERGE**, including removal of conflict markers. SHA256:

`0f2d73f14b606e3bed80b48f966c789b4558f509c536670af38d90e0e90f3d2d`

This patch is for the same pinned uncommitted merge, not a stand-alone patch against clean main. Main's automatically merged changes are not mislabeled as manually authored resolution. To inspect the complete integration against either parent, use `git diff --cached <parent>` in this tree; do not apply the resolution patch to another base blindly.

Manual resolution paths and current SHA256:

- `scripts/compiler-boundaries.json`: `e78e6b1f69c591f288cb57c354ab04ebc33ce4228acf747ead68107bf4b9ad45`.
- `src/codegen/bindings/initializer-carriers.ts`: `b1ca30b0b3b50cd25609bb4b7489890ef375e1c9f12dc3d4ec92940691feb662`.
- `src/codegen/expressions/calls.ts`: `cc13fc0f9f2411946e2aee928552e265fcb3889e9a38df6cbb92bf1977532db9`.
- `src/codegen/expressions/extern.ts`: `8b2afcb08ee5fb68aff12cdc5436e1d1891319968d991fc222be413e23538da7`.
- `src/codegen/index.ts`: `c59fabf5dc45f315b6dadb63c1908c70734985e35503fe8819f1c69287380184`.

Resolution-only diff: 24 insertions, 236 deletions across five files (includes deleting marker lines and obsolete/duplicate inference code, not deleting compiler functionality).

## Applied decisions

1. Calls keeps both the dynamic-import lowering import and both default-parameter widening imports; real consumers remain.
2. Index keeps generator-completion forcing and main interface/fnctor imports, plus main's last-stage nullable-string post-filter. It imports one initializer helper, not a duplicate local copy.
3. Moved initializer helper now delegates the standalone RegExp decision to `inferStandaloneRegExpMatchResultType(ctx, declaration)`. Old expression-only recognizers and obsolete match-vector import were removed. Generic-factory/declaration-carrier planning and typed-view/subview handling remain; `stripRegExpInferenceWrapper` remains for subarray/slice inference.
4. Rest/spread keeps fresh array materialization and scoped finally restoration from the PR. Final expected type comes from `paramTypes?.[paramOffset + restInfo.restIndex]`, falling back to the prior restInfo vec type only when unavailable. No direct forwarding or cast-only substitute was added. Existing fixed-prefix refusal and non-rest lowering remain.
5. Inventory retains independent complete records for both sides, not marker-fragment concatenation. Data-only jq comparison reports all upstream records present and byte-value-equal, all non-file metadata equal, 17 additional PR-owned entries; total1560 records, no duplicate paths. This is NOT a compiler-boundary gate run or architecture closure proof.

## Rest element / declared ABI source evidence and limits

The final coerce was NOT assumed to repair arbitrary metadata. Source read covered actual writers and consumers:

- `declarations.ts:1830–1843` and `:2953–2969`: ordinary top-level declarations derive elemType, use it to register the vec, push that same vec into the parameter signature, and store all three rest fields together.
- `resolved-rest-param.ts:19–33`: generic call-site-resolved signatures derive elemType and backing array directly from `getVecInfo(params[restIndex].typeIdx)`; this is the TypeScript binder prerequisite already on main.
- `statements/nested-declarations.ts:1443–1454`: nested declarations similarly derive rest metadata from the lowered parameter vector, not a second element-type guess.
- `class-bodies.ts:1480–1497` and `:1690–1705`: constructor/method registration produces the vec parameter and rest metadata together. Wrapper/alias paths retain the existing metadata copying; this merge does not redesign their prefix rules.
- `expressions/call-identifier.ts:4331–4341`: capturing nested calls pass their capture prefix as paramOffset; method callers pass their receiver prefix. The final declared-slot lookup retains this existing offset.
- `literals.ts:6188,6212–6216`: forcedElementType feeds vec registration; `:6678–6684` builds an actual element-coercion template between source and destination backing types during spread copying. It is not a raw cast between unrelated vecs.
- `type-coercion.ts:1825–1843`: final vec conversion recognizes both differing element kinds and differing referenced element heap types; `emitVecToVecBody:2062` performs element-wise conversion. Its sidecar copy is from the newly constructed rest vec, not direct reuse of the original spread array.

These establish the normal metadata-to-parameter and projection route in source, not universal equality under all alias/replay/substitution paths. `registerResolvedRestParam` preserves an already-existing name entry, and constructor wrappers/capturing callers have separate prefix rules. The original binder plus captured-rest/method controls remain necessary; no full-program metadata invariant or run is claimed. If those reveal a mismatch, retain it as an ABI source-proof gap rather than adding a retry or changing admission.

**A separate existing effect-order gap was discovered and left unchanged:** the array-literal spread route first compiles spread sources (`literals.ts:6286` onward), then fills non-spread elements later (`:6730` onward). Consequently, the earlier plan's blanket source-order proof obligation is NOT established by merely choosing this path. Example needing a future diagnostic is a side-effecting explicit rest element preceding a side-effecting spread source. The original PR already used this path; the main merge did not introduce the algorithm. No test was added/run and no runtime failure is claimed from inspection alone. Do not count unchanged literal-only sum/freshness controls as proof of effect ordering. Repairing literals/spread sequencing would exceed this conflict resolution and requires a separate bounded decision.

The `_forOfPreserveUndefElem` override after forcedElementType is another existing scoped caller condition; the final projection route is retained, but this merge does not assert all ambient flag interactions have been measured.

## Preservation and checks actually performed

- No remaining markers in the five files; no unmerged index entries.
- Targeted staged whitespace check passed. No formatter was run.
- `git diff --cached --name-only AUTO_MERGE` returns exactly the five paths above.
- `git diff --cached --quiet AUTO_MERGE -- tests plan/audit benchmarks .github` exits0. Thus no resolution edits to original fixtures, evidence, failure expectations, admission/floor infrastructure or CI. Upstream's own automatic merge content is preserved, not claimed byte-identical to the old PR across all paths.
- Both inference consumers were inspected. The automatically merged regexp file differs from main only in the PR's boolean result branding at the inspected hunks; declaration-aware main authority remains available. No unrequested edits to neighboring files.
- Broad `git diff --check` initially encountered the existing LFS clean-filter sandbox restriction on `plan/agent-context/5883-array-length-base608-refusal.log` (terminal49fdb2). It did NOT establish a clean whole-tree result. Inspection switched to the five explicit source paths; no LFS config/locks were changed.
- Initial jq inventory comparison had a query-syntax error (42c8f7 exit3); corrected read-only query (2f260a exit0) gave the record/metadata results above. This was data inspection, not repository compiler/test execution.

## Next review / validation boundary

Source frozen pending parent review. The prior narrow validation plan remains applicable, with the effect-order limitation explicitly added above. Before validation, obtain a compiler slot and arrange existing dependencies in this dedicated tree without changing fixture bytes. Run the original rest/binder, RegExp shape/nullable-element, default-parameter and generator extraction controls with first failures retained, then authorized static checks. No denominator or pass claim exists yet for this integration.

Do not commit/merge-finalize, push, alter HOLD, relax refusal/floors, close another PR, or retire legacy code from this handoff. PR5748's actual array prototype/ownership runtime prerequisite remains separate. Parent's active constructor prerequisites and other branches were not modified.
