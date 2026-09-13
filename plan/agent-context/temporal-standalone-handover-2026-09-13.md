# Handover — standalone Temporal (#5383), session of 2026-09-12 → 2026-09-13

Supersedes `temporal-standalone-handover-2026-09-12.md`. Covers slices S6 → S13
and the infrastructure incidents that shaped the day.

**Scope, unchanged from the owner directive of 2026-09-07:** a real `Temporal`
global for `--target standalone`, standalone only. No host-lane work.

## The one-paragraph state

The `Temporal` global under `--target standalone` is the unmodified
`@js-temporal/polyfill` (+ `jsbi`), compiled by js2wasm to a separately linked
provider; nothing is re-implemented. Every slice fixes the COMPILER so the
polyfill compiles and behaves under standalone — the polyfill is the corpus that
exposes general codegen defects. The linked test262 lane (three families ×
120 rows: `Temporal/PlainDate`, `Temporal/Duration`,
`Temporal/ZonedDateTime/prototype`) went **0 → 177/360** with **0 pass→fail at
every step**. On `main` today: 170/360 (through S11). S12 is open and parked
as collateral of a main-side floor breach (below); S13 is complete and local.
The artifact is still OPT-IN in CI (#5407, link cost → default-on, is not
started). Acceptance criterion 4 of #5383 is therefore still open.

## Slice table (this session)

| slice | root cause fixed | lane delta | PR |
| --- | --- | --- | --- |
| S6 | `Object.prototype.toString` for a value that crossed the link (#5406) | — | #5864 → landed via #5875 |
| S7 | `__to_primitive` early-out lacked the `$Symbol` arm; module with `eval` + provider refused at init (#6432) | 0 → 44 | #5870 → landed via #5875 |
| S8 | composed RegExp patterns (template literal / `[…].join`) folded to the native engine (#5404) | 44 → 85 | #5875 (merged) |
| S9 | table-free `Intl.DateTimeFormat` for UTC / `Etc/GMT±N` in the provider shim (#6442) | 85 → 122 | #5885 (merged) |
| S10 | native `concat`/`sort` arms for `any`-receiver Array calls (#6447) | 122 → 139 | #5896 (merged) |
| S11 | a dynamic class object answers `.prototype` (#6457) | 139 → 170 | #5900 (merged) |
| S12 | static arity for a spread from a `const` array binding into `new` (#6460) | 170 → 170 (bucket moved, rows die one step later) | #5909 (open, held — collateral) |
| S13 | `Object.create(<value>.prototype)` produces a compiled instance (#6464) | 170 → 177 | branch `issue-5383-standalone-temporal-s13`, PR not yet opened (GitHub outage) |

Fix commits also on main: the speculative-rollback gate fix on S2m (9501ffca13),
the `test262` gitlink restoration (#5892), the revert of #5871/#5882 (#5914).

## Attribution lesson (five slices running)

S9→S13 were each handed a bucket attributed to the link boundary (#5406) and
each found the defect in module-local standalone codegen instead, reproducible
in ONE standalone module with no provider. S12 was handed a module-local
attribution and found the residual was cross-module. **The census decides;
reduce in a single module first, cross the link only if that passes.**

## Remaining buckets (post-S13 sample) and the next census targets

- PlainDate `calendar must be string in canonicalizeCalendarEra` **20** — S13
  showed `typeof PlainDate.from(…).calendarId` answers `"string"` inline in the
  consumer but the harness reads it through its own function PARAMETER and still
  sees `undefined`: a second, independent defect on the parameter path. S14 was
  dispatched on it (branch `issue-5383-standalone-temporal-s14`, from local S13).
- Duration `years result … undefined` ~10, `dereferencing a null pointer in
  sn()` 5; ZDT `required property 'timeZone' missing` 7, `reading 'equals'` 6,
  `class field` 6.
- Known residuals pinned by executable expectations: `typeof <provider
  instance>` = `"function"`; dynamic-RHS `instanceof` false; `gOPD(K,
  "prototype")` / `"prototype" in K` miss; spread into a dynamic CALL dropped;
  `new` with arity > 8 (`MAX_NATIVE_CONSTRUCT_ARITY`); `slice/reverse/includes/
  splice/flat` on an `any` receiver.
- Then #5407: link cost (linked/unlinked compile ratio 1.76–1.83×, 60 KB row
  at the 15 s budget) → make the artifact default-on in CI.

## Incidents worth knowing (all resolved unless stated)

1. **`test262` submodule replaced by a symlink** (dfecafa7e9, S6 grounding
   commit; reached main inside #5875 at 02:38 UTC). On runners the corpus path
   dangled and every shard-running merge_group died at collection in ~15 s
   with empty results; docs-only PRs kept main looking green. Fixed by #5892
   (gitlink restored at b363f29d3c). Guard: `git ls-tree HEAD test262` must be
   `160000`; the worktree harness keeps replacing it locally — `rm -rf test262
   && git checkout -- test262` before staging, never stage it.
2. **Two PRs merged unvalidated inside that window** — #5882 (issue-6416,
   `__extras_argv`) broke `super`/`arguments` spread rows; #5871 (issue-6412,
   async Promise carrier) broke 174 `for-await-of` rows with a compile error.
   The standalone high-water floor (#2097) caught the combined −157 only at
   12:34 UTC on S12's group. Reverted by #5914 (merged 13:46). The owning lanes
   must re-land with green shards. S12 (#5909) stays held until re-based and
   released once.
3. **New `speculative-rollback` gate** in `quality` flags raw `fctx.body.length
   = mark`; route through `snapshotSpeculative`/`rollbackSpeculative`.
4. **Provider cache is NOT keyed on the compiler.** `temporalProviderCacheKey`
   fingerprints polyfill source + shim + options only; after a codegen edit use
   a fresh `JS2WASM_TEMPORAL_CACHE` dir — the only tell is `cacheHit=false`.
5. **QuickJS eval provider needs two files**: `.test262-cache/quickjs-artifact-*/
   libquickjs.wasm` AND `.test262-cache/quickjs-eval-adapter-<hash>.wasm`, as
   real files (a `cp -a` of a symlinked cache into a reaped worktree reads as
   present and fails every row with a uniform Temporal-shaped error).
6. **Family samples at load ≲ 2**; concurrent lanes produce spurious
   compile-timeout CEs. Every CE↔fail flip must be re-run solo at 60 s on BOTH
   trees before it is reported.
7. **A backgrounded `git push` wrapper's exit status is not the push's**; a
   pre-push typecheck without `node_modules` fails silently. Verify with
   `git ls-remote`.
8. **GitHub write access expired at 14:25 UTC** (push → 403 with no
   Authorization header; GitHub MCP → "invalid session"). Reads still work.
   Needs a connector reconnect. At handover time S12's re-base, S13's PR, and
   this file are local-only.

## Process that worked

Fable writes the plan/brief, one Opus senior-developer lane at a time in its
own worktree (4-core spawn gate), census-first, one root cause per slice,
base by file-copy revert on the same tree, byte A/B with the `gc` lane
identical, full gate chain before every commit, PR stacked on the previous
slice, coordinator validates the head and opens the PR, queue shepherded
every 40 minutes.
