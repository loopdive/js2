---
id: 6448
title: "Investigate landed BigInt TypedArray regressions (migrated GitHub 5807)"
status: ready
sprint: current
created: 2026-09-09
updated: 2026-09-13
priority: high
horizon: now
feasibility: medium
reasoning_effort: max
task_type: bug
area: runtime
goal: correctness
assignee: "ttraenkler/codex-5807-migration"
---

# Investigate landed BigInt TypedArray regressions

## Corrected status

The regression investigation remains unresolved. GitHub #5751 had already merged
as `efa0908e09998c73da592fba32708c7ecca8d6e5`; the original title's
unmerged-landing premise was corrected by the final comment. The authoritative
CI report still contains two regressions. Retrieved JSONL rows omit `wasm_sha`,
so the comparator's hash-change label is not independent evidence of unequal
Wasm bytes. The bounded macOS 3/3 paired runs and six identical same-variant
binary pairs do not clear the original Linux/four-worker failure. No causal
fix, flakiness claim, or gate waiver follows from this migration.

This allocated issue is the canonical destination for the original body and
three comments from [GitHub #5807](https://github.com/loopdive/js2/issues/5807).
The separately [held #5798 branch](https://github.com/loopdive/js2/pull/5798/files)
includes the older local issue `5807-bigint-typedarray-landing-regressions.md` and later diagnostic
artifacts; this migration preserves that owner's work and does not adopt or
reinterpret its additional evidence. Issue numbers in the historical record
below refer to GitHub unless explicitly described as local plan issues.

## Implementation Plan — tracking migration and creation guard

1. Preserve the exact GitHub title/body and all three comments below, including
   their URLs and timestamps. Keep this issue open for the underlying diagnosis.
2. Add one dependency-free `.claude/hooks/block-github-issue-create.py` decision
   hook and register it in the existing `.claude/settings.json` and
   `.codex/hooks.json` PreToolUse lists. Preserve every unrelated hook.
3. Test literal `gh issue create`, issue-creation REST and GraphQL commands and
   structured GitHub tool calls for `loopdive/js2` and its verified `js2wasm`
   alias. Block before execution; allow PR creation, normal issue reads/closure,
   other explicitly named repositories and quoted documentation. Test command
   token boundaries, malformed input, and the actual registered hook commands
   with local stubs; never send a real create-issue request.
4. Document the precise supported routes and limits of local hook enforcement.
   Project trust/activation is required; do not modify global trust or pretend
   that registration proves this current desktop session runs the hook.
5. Run the focused root test file and normal quality/commit/push hooks. Publish
   the signed migration/guard on one ready PR, verify the remote plan file,
   then close GitHub #5807 as migrated with that durable link. Closure does not
   mark the compiler defect fixed.

Owned files: this issue, the one new hook, the two existing hook registrations,
and `tests/issue-6448-github-issue-creation-guard.test.ts`. No compiler, fixture,
collection-brand, boundary-policy, or integration source changes are included.

## Guard enforcement and limits

The guard is registered as a `PreToolUse` command in both repository hook
configurations. It recognizes literal `gh issue create` (including repository
selectors, basic `env`/`command` wrappers and `sh`/`bash`/`zsh -c`), `gh api`
POSTs to the issue collection (including the implicit POST from fields/input),
explicit curl REST POSTs, visible GraphQL `createIssue` calls, and structured
GitHub `create_issue`/`issue_write` inputs. Both names `loopdive/js2` and
`loopdive/js2wasm` resolve to repository ID `1218952664` in the migration read.
Unqualified creation defaults to this repository; an explicit different
repository or `GH_REPO` is allowed. Visible GraphQL creation with an opaque
repository ID is refused because the guard cannot prove a different target.
Malformed hook input or unsupported quote/here-document syntax fails closed.

A supported hook host consumes the deny decision/exit 2 before dispatch. The
focused test executes each registered command and demonstrates that a denied
call never reaches a local `gh` stub, while an allowed PR call reaches it. This
is protocol/decision testing, not proof of current desktop activation.
[Codex's documented hook contract](https://learn.chatgpt.com/docs/hooks) supports
project `.codex/hooks.json`, shell/unified-exec calls under `Bash`, and MCP names;
project trust and hook activation are prerequisites. The current session's
trusted legacy entries do not establish trust or execution of this new entry.
[Claude Code's hook contract](https://code.claude.com/docs/en/hooks) supports the
repository settings registration and the same deny response. No global trust,
account permission, or GitHub repository feature is changed.

This is a local accidental-creation guard, not a GitHub-side security boundary.
It does not interpret arbitrary programs, aliases, computed/expanded commands,
backticks, shell substitutions, `eval`, sourced scripts, or opaque GraphQL
payload files/stdin. It does not inspect later interactive `write_stdin` input,
browser actions, or tools the host does not deliver to PreToolUse. Here-document
bodies are treated as data, not evaluated as shell expansions. Other HTTP
clients and custom API wrappers require additional adapters. The existing
unrelated hook entries are preserved. PR creation, existing issue reads,
comments/closure, and quoted shell documentation remain available.

## Migration implementation evidence

Local ID 6448 was atomically allocated and claimed for
`ttraenkler/codex-5807-migration` on `origin/issue-assignments` with a successful
open-PR collision scan, starting from main
`6aac84c0b6ef418bbfa6a97cceca25960db7a3f6` in an isolated worktree. The 38-open-PR
file snapshot contained no overlapping hook/configuration writer. This slice
implements only the tracking migration and guard; the underlying compiler
investigation retains `status: ready`.

The first focused run passed **44/44** controls with one Node 24 worker and
4 GB limits, including all command allow/deny rows, malformed input, structured
GitHub calls and both registered hook commands. Tests use only local stubs;
there were zero real GitHub issue-creation attempts. Raw original issue/comment
API snapshots and the focused log/JSON report are preserved in the isolated
worktree's `.tmp/5807-migration/`. The historical text below is copied exactly
from the body and three-comment snapshot; corrections appear above it rather
than rewriting the originals.

## Original GitHub record (verbatim historical text)

Source: https://github.com/loopdive/js2/issues/5807

Original title: fix(ir): bisect two BigInt TypedArray regressions blocking #5751 landing

Author: `ttraenkler`; created `2026-09-09T16:32:21Z`; last updated `2026-09-09T18:52:56Z`.

State at migration snapshot: `open`; comments: `3`.

### Original body

```text
Queue-drain landing blocker; new migration scope remains paused.

Actual merge-group Test262 run https://github.com/loopdive/js2/actions/runs/34374533493 failed regression job 102551653768 on candidate efa0908e09998c73da592fba32708c7ecca8d6e5 (PR #5751 head 1330f172f78ed794915ffabeacbf2c39cf5bea07). The gate compared 48,735 baseline and candidate rows: 38,384 to 38,382 passes, two regressions, zero improvements; both regression Wasm hashes changed. Compile timeouts stayed 16 to 16 and no quarantine transitions were excluded.

Affected paths:
- test/built-ins/TypedArray/prototype/set/BigInt/array-arg-src-values-are-not-cached.js: pass to fail, RangeError offset out of bounds.
- test/built-ins/TypedArrayConstructors/ctors-bigint/object-arg/new-instance-extensibility.js: pass to fail, cannot marshal opaque compiled value to host BigInt64Array constructor.

The out-of-bounds category grew 11 to 12. These paths also appear in unresolved historical N1 evidence; repetition does not establish flakiness or authorize a waiver. The current baseline is content-current. PR #5751 is held and the queue is empty; cumulative #5798 must not land over this failure.

Implementation/diagnosis plan:
1. Preserve exact donor/candidate JSONL rows, hashes, shard logs and process/retry provenance from the actual run.
2. Reproduce through the CI CompilerPool/worker path against clean known-good donor and exact candidate, with the same corpus, options, runtime and a known-good control. Local helper error classifications are not interchangeable with CI.
3. Bisect and trace the source-to-Wasm/host-marshalling difference; have an independent agent review the minimal blocker fix.
4. Add focused regression coverage and verify the original failure conditions, then push the fix to the existing landing PR. No gate, quarantine, baseline or test weakening.
5. Re-run genuine protected-queue conformance only after cause/fix evidence; refresh #5798 and affected dependents after actual main delivery.

Parent owns integration and public updates. Parallel agents own evidence collection and independent cause analysis. No fix or completion is claimed.
```

### Comment 5605367333

Source: https://github.com/loopdive/js2/issues/5807#issuecomment-5605367333

Author: `ttraenkler`; created `2026-09-09T16:38:01Z`; updated `2026-09-09T16:38:01Z`.

```text
Evidence refinement: the comparator labels both rows as Wasm-hash changes, but the retrieved authoritative baseline and candidate JSONL rows contain no wasm_sha fields. Therefore actual byte/hash inequality is not independently established; do not treat that comparator label as an artifact hash comparison. Both exact rows do establish baseline pass and candidate fail under oracle 13, honest lane, semantic providers auto, official standard scope and strict both. Both candidate import lists omit baseline env::__extern_set_strict; this is a diagnostic observation, not a proven cause. Exact failed candidate and passing donor worktrees are now available for paired CI-path reproduction. The simple run-test262-paths helper uses runTest262File and is not the CI CompilerPool classifier; that proposed shortcut has been rejected.
```

### Comment 5605517261

Source: https://github.com/loopdive/js2/issues/5807#issuecomment-5605517261

Author: `ttraenkler`; created `2026-09-09T16:49:58Z`; updated `2026-09-09T16:49:58Z`.

```text
Paired diagnostic update: exact donor 129e3efd4530ae1be56dbf5fdea54ddbbd87443e and failed merge candidate efa0908e09998c73da592fba32708c7ecca8d6e5 each passed 3/3 selected rows through the existing dynamic-chunk/shared CompilerPool CI path on Node 25.9.0, honest gc lane, providers auto. Both shard receipts record exactly three registered/settled canonical rows. The third row, non-BigInt constructor object-argument extensibility, is independently PASS/PASS in both original CI artifacts. Local runs used macOS ARM64 and one worker, not Linux x64/four-worker shard history, so this does not clear the original failure.

A separate fresh-per-row artifact diagnostic produced six primary/strict variants in each root; parent independently compared every emitted Wasm file and found all six same-variant binary pairs byte-identical, with six passes in each root. That older capture driver has limited admission hardening, so this is bounded diagnostic evidence, not a replacement for the authoritative CI gate. Source-to-runtime worker history/environment remains to investigate; no source fix or flakiness claim is established.

The shared CI caller replaces the primary result with the strict-rerun result after a primary pass. Thus passing-row imports and primary-failure imports can describe different variants; the missing strict-set import is not by itself causal evidence.
```

### Comment 5607080067

Source: https://github.com/loopdive/js2/issues/5807#issuecomment-5607080067

Author: `ttraenkler`; created `2026-09-09T18:52:55Z`; updated `2026-09-09T18:52:55Z`.

```text
Landing-state correction: #5751 merged at 2026-09-09T16:31:32Z as efa0908e09998c73da592fba32708c7ecca8d6e5. Its exact head and merge commit are verified ancestors of main96c4970002. Actual Test262 run34374533493 still reports failure; no causal fix or regression clearance has been established. This issue therefore concerns landed code, not an unmerged PR. The cumulative #5798 remains held while the evidence is reconciled and remaining composed validation runs. No bypass or flakiness claim is authorized by the merge itself.
```
