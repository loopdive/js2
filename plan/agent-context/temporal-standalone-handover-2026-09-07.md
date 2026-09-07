---
agent: fable-lead (Temporal → standalone lane)
session: session_01K6r5kd3zWKXZrhsqALWVdk
session_end: 2026-09-07
next_session_entry_point: >
  Read this file, then plan/issues/5383-standalone-temporal-provider.md (the
  S1–S5 plan; S1 landed, S2 half-done in PR #5723) and
  plan/issues/5384-standalone-exn-render-exports-missing.md. In flight: PR
  #5723 (release path), #5712, #5704. No lane is running.
---

# Temporal for `--target standalone` — handover 2026-09-07

Owner's direction (2026-09-07 ~14:00 UTC): **standalone only**. Everything
Temporal before that was the JS-host lane (compiled `@js-temporal/polyfill`
linked as a provider under `--target gc`). Process: Fable writes the
`## Implementation Plan`; Opus senior-dev lanes implement in isolated
worktrees; every claim below names its artifact.

## Where the number stands

| lane | Temporal rows pass | source |
| --- | --- | --- |
| JS-host (`--target gc`) | 2,925 / 4,611 | baselines jsonl, 2026-09-07 morning |
| **standalone** | **170 / 4,603** | `test262-standalone-current.jsonl`, sha d4258c82 |

Standalone failure shape: 1,506 `Temporal is not defined`; 454 compile errors
`standalone target emitted host imports: env::__temporal_*` (the #661
compile-time lowering in `src/codegen/temporal-native.ts`); 361 `called value is
not a function`; 460 `Cannot read properties of undefined (reading 'since'|'until'|'toString')`.

## Slices (#5383) and their state

| slice | state | evidence |
| --- | --- | --- |
| S1 polyfill validates under standalone, import-free | **landed** (#5721, bbb0bbaa2e) | 2,956,918 B, `WebAssembly.Module` accepts, import list EMPTY; gc provider sha unchanged |
| S2a provider links separately host-free | **done** in #5721's measurement | `buildTemporalProvider({target:"standalone", hostBridge:"off"})` → plan=separate, `Temporal` getter, `__module_init` exported, 53 s |
| S2b provider `__module_init` returns | **open** — PR #5723 fixed R3/R4/R5, still throws | `TypeError: Cannot access property on null or undefined at 1:4117` — jsbi `static subtract(i,_){const t=i.sign; …}` reached with a NULL argument; first reached at top-level statement 224 of the linked source. **Suspect first**: a property write on a `class … extends Array` instance (`this.sign = s`) throws on this lane (measured by dev-5384, unfixed) |
| S3 runner + CI wiring | not started | plan in #5383: `scripts/test262-temporal.mjs` gate is host-only; `scripts/prewarm-temporal-provider.mjs` one artifact; `test262-sharded.yml` `temporal-provider` job gated on `run_host`; the worker's #2961 guard must not count provider namespaces |
| S4 retire the #661 lowering under standalone | not started | 454 compile errors; gate on a linked `Temporal` binding |
| S5 measure | not started | drivers: `.tmp/bucket-run.mts` + `ensure-test262-fn.mts` + `family-123.txt` (copies in `/home/user/js2/.claude/worktrees/agent-a5a33516fa53a63fe/.tmp/` and `agent-a9358fd8ef7d92d39/.tmp/`) |

Measured facts a new lane must NOT re-derive (all 2026-09-07):
- The linker's "deferred export unavailable for WASI" note is about `--target
  wasi`, not standalone: providers compile with `deferTopLevelInit: true`
  (`src/package-linker.ts` L1882) and standalone exports `__module_init`.
- `new Intl.DateTimeFormat(...)`, `typeof Intl`, `BigInt(3)` compile under
  standalone with ZERO env imports. Only 66 of 4,603 Temporal rows reference
  `Intl.`/`toLocaleString`; 0 use a non-ISO calendar literal.
- The polyfill's host-only surface: `Intl.DateTimeFormat` ×14 (non-ISO calendar
  helpers), `Intl.DurationFormat` ×9, `Intl.supportedValuesOf` ×1.
- `#4035`'s `stripHostBridgeExports` deletes `__exn_render_*` AND `__stdout_*`
  from every standalone binary (`hostBridge:"auto"` → `"off"`); #5723 keeps the
  exception renderer iff the source has a `throw`. `__stdout_*` is still
  stripped outside the test262 lane (which pins `hostBridge:"always"`).
- Two pre-existing red size guards, not required gates: `tests/issue-4034-*`
  asserts < 5,000 B and measures 31,592; `tests/issue-4035-*` asserted
  < 20,000 B and measured 33,136 (rewritten in #5723 as a policy delta).
  ~13–27 kB of standalone growth landed unnoticed — needs an owner.

## Open PRs and how to release them

| PR | state | action |
| --- | --- | --- |
| #5723 (#5384 + S2 R3/R4/R5, `issue-5384-standalone-exn-render`) | open, main merged, PR CI pending | if BEHIND: fetch branch, `git merge origin/main`, re-measure `maximumRuntimeTsLines` (`wc -l src/runtime.ts`) on conflict, push. Bot `hold` → read the cited job first |
| #5712 (#5380, `issue-5380-fdiv-loop`) | released 17:45 UTC | same |
| #5704 (#5379, `issue-5379-stale-export-map`, draft) | 0 delta; pins that #5364 closed the cross-instantiation channel | recreate a worktree from the branch, merge main, push, un-draft after #5712 |

Queue rules that bit this window: two runtime.ts-growing PRs in one merge group
exceed either's ceiling — release one at a time; a queued branch rejects pushes
("protected branch hook declined") — convert the PR to draft to dequeue, push,
un-draft; auto-park labels but does not dequeue; every CI bot push to main
(npm-compat, benchmark refresh) drops open PRs to BEHIND.

## Next lane (in order)

1. **S2b** — reduce the jsbi `subtract(null)` init throw. Start from the
   suspect above; bisect the linked source's top-level statements (statement
   224 is the first that reaches it); add each reduction to
   `tests/issue-5383-standalone-temporal-provider.test.ts`; then the smoke test
   (`Temporal.PlainDate.from("2024-01-01").day === 1`,
   `Duration.from({hours:1}).total("minutes") === 60`) host-free via
   `instantiateLinkedProject(result, {})`.
2. **S3** wiring, **S4** lowering retirement, **S5** measurement — plan text in
   #5383.
3. File the standalone size-growth owner issue (#4034/#4035 guards).

## Environment notes

- `/home/user/js2/test262` is now a REAL submodule checkout at the pinned sha
  b363f29d (a worktree cleanup on 2026-09-07 deleted the previous symlink
  chain box-wide). Never symlink one worktree's `test262/` into another.
- Old worktrees' `node_modules` may be symlinks into removed worktrees:
  `ln -sfn /home/user/js2/node_modules <wt>/node_modules`.
- No `gh` in the container; GitHub via the MCP tools. `claim-issue.mjs
  --allocate` needs `--allow-unscanned` (PR scan degraded) — hand-check open PRs.
- Disk: keep removing landed worktrees; one `JS2WASM_TEMPORAL_CACHE` per
  revision, deleted after.
