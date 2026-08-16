# opus-es5-a — ES5-standalone lane, session 2026-08-16

Identity `ttraenkler/opus-es5-a`. Worktree
`/workspace/.claude/worktrees/agent-a27de72bf013ce6fb`, branch
`issue-2668-defineproperty-fidelity`. Mission was: drive the ES5-standalone
test262 gap to zero, starting from #2668 (86-row defineProperty family), then
#4515.

## What landed

**PR #4631 — `fix(#2668): standalone ordinary indexed set must create an
all-true data property`.** One flag constant in
`src/codegen/vec-overlay.ts::fillVecOverlayHelpers`, plus
`tests/issue-2668-vec-ordinary-set-creates-default-data.test.ts` and the
implementation record in the #2668 issue file.

`__extern_set`'s vec prologue routed an indexed write on an `any`/externref
array receiver to `__vec_dp_value` with `HOST_HAS_VALUE` (`1 << 7`) — the
`hasValue` bit and nothing else. That specifies none of
writable/enumerable/configurable, so on a key that did not yet exist
CompletePropertyDescriptor defaulted all three to **false**. Every ordinary
`a[i] = v` that grew the array minted a non-writable, non-enumerable,
non-configurable own property, and the next legal redefine threw
"configurable attribute of a non-configurable property" and aborted the module.

Control reaches that site only with **no** companion descriptor entry — every
non-null-entry arm above it returns — so the index is either an implicit dense
element (effective W/E/C all true, which `__vec_dp_value`'s own seed
materialises) or brand new (CreateDataProperty ⇒ all true). All-true is correct
in both cases, so the fix is `SEED_FLAGS`, not a new branch.

**Measured +4 / −0 standalone**, two ways that agree on the same four files
(`defineProperty/15.2.3.6-4-210`, `-4-212`, `defineProperties/15.2.3.7-6-a-206`,
`-6-a-208`): a local matched-timeout A/B over the 86-file family, and the
merge-group full-corpus improvement delta against a co-parked unrelated PR.

## The thing that cost the most time, and how to not repeat it

**Four independent probes said "this works" and all four were right and
useless.** `a.length = 1; a[0] = 101`, the `[101]` literal, `push`, and a typed
`number[]` grow each make the index *backed* before the write, and a backed
index gets seeded with all-true attributes inside `__vec_dp_value`. Only the
create-through-`__extern_set` shape was wrong. Those four are now CONTROLS in
the test file rather than deleted — a probe that made the defect look impossible
is worth keeping next to the row that exposes it.

## Family classification — 39 array / 47 not (do not lose this)

Of the 86 rows in the census's `defineProperty-family` cluster, classified by
receiver shape before any code was touched:

- **39 array-receiver** — this issue's vec-index MOP scope.
- **47 non-array**, largest sub-clusters: mapped-`arguments` exotics (~8,
  explicitly out of #2668's scope), plain-object accessor attributes (~6, owned
  by **#4479**'s lane), built-in function descriptors (3), prototype-internal
  updates (4), String-object index properties (2).

Cluster size is a ceiling, never a flip forecast. Classify by receiver before
claiming a row.

## Still open in standalone, measured on current main (next lane, in this order)

1. **Unbacked-tail enumeration.** `[0,1,2]` with `length = 6` reports
   `Object.keys` 6 and `getOwnPropertyNames` 7; expected 3 and 4. This is the
   enumeration half of M1's four-state contract (#2668 M1 §4) and is the
   biggest remaining coherent array cluster. Start here.
2. **`delete` on a vec returned by `Object.keys`/`getOwnPropertyNames`** is not
   observed by the reader — `15.2.3.14-5-a-4`, `15.2.3.4-4-b-6`. Two rows, one
   mechanism, probably cheap.
3. **uint32 array length.** `defineProperty(a, "length", {value: 4294967294})`
   leaves `length` at `0` (6 rows: `15.2.3.6-4-154/-155/-183`,
   `15.2.3.7-6-a-150/-151/-179`). The vec length field is a **signed i32**, so
   this needs a representation change, not a validation fix — do not start it
   as a "small" task.
4. Host `_vecDefineOwnProperty`'s "in-bounds index with no sidecar is a first
   definition" workaround — host-side #2668 residue, untouched here.

#2668 M1 itself (four-state classifier, absence ranges, IR seam) is **not
started**. The slice above sits underneath M1's contract; landing it first
removes noise from every later M1 measurement.

## A/B state (reproducible)

- Local arms: `.tmp/2668-base180-standalone.jsonl` and
  `.tmp/2668-head-standalone.jsonl`, both
  `npx tsx scripts/harness-flip-probe.ts --files .tmp/dp-family.txt --target
  standalone --timeout 180000`, base `d38224d53`. Partition verified 86 == 86,
  `fail→pass 4 · pass→fail 0 · unchanged 82`.
- Mechanism probe: `.tmp/probe4.mts` — 11 rows, both lanes, prints per-row
  got/want. Swap `src/codegen/vec-overlay.ts` between `.tmp/vec-overlay.base.ts`
  and the committed version to re-run either arm. (Everything under `.tmp/` is
  gitignored and dies with the worktree; re-derive rather than trusting it.)
- A broad local `built-ins/Array|built-ins/Object` two-arm sweep was **started
  and abandoned deliberately**: >1 h per arm on a loaded box, and the
  merge-group run delivers a full-corpus standalone measurement in ~19 min. Do
  not redo it; read the merge-group numbers instead.

## Instrument traps hit this session — all three cost real time

1. **The QuickJS eval provider cannot be built in this container** — no
   `clang-18`, no `cmake`, no cached artifact anywhere on the box. Every
   eval-shaped row then reports a manufactured
   `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` failure,
   which is **unmeasured, not failing**. `pnpm run test:262` *aborts outright*
   on it; `JS2WASM_EVAL_ENGINE=interpreter` gets past that.
2. **`harness-flip-probe`'s default 60 s timeout is too short under box load** —
   it turned 20 of 86 rows into `compile_error: compilation timeout (91 s)`. I
   discarded that entire base arm rather than diff it against a 180 s head arm,
   which would have manufactured ~20 phantom flips. Use `--timeout 180000` and
   keep both arms on the same setting.
3. **A probe receiver annotated `: any` routes onto the open-`$Object` path, a
   different lowering than real test262 code takes — and it is wrong in BOTH
   directions.** My `: any` probe reported
   `Object.defineProperty(a, 4294967295, …)` fully correct while the real runner
   fails `15.2.3.6-4-184`: a false *negative*, not merely an optimistic false
   positive. Treat `: any` probes as hypothesis generators only; the verdict
   comes from `harness-flip-probe`.

Fourth, smaller: a lint-staged pre-commit failure leaves `lint-staged automatic
backup` entries on the **shared** stash stack. Two of mine are there; I did not
drop them because ownership is not provable on a shared stack and a wrong drop
loses another agent's work.

## Merge-queue episode worth remembering

PR #4631's first merge-group run auto-parked with 42 standalone / 44 host
regressions. They were **inherited from main**: `ef1a41d0d fix(#1888):
Array.isArray static fast path claimed every ref is an array` landed after the
baseline snapshot. Three checks established it, and the cheapest one is the best
— **an unrelated co-parked PR (#4627) reported the identical bucket signature
`37d9311a9cb806e4` and the identical 42 files.** The guard prints that signature
precisely so two PRs can be compared; check it before reconstructing anything
locally. The second check is nearly free too: the edit is inside a
`ctx.standalone` early-return, so a **host** regression is structurally
impossible from it.

The by-product is the cleanest measurement of the session: the two parked PRs
shared the drift, so the *difference* in their improvement counts (8 vs 4) is
this PR's own effect — +4, full-corpus, matching the local arm file-for-file.
Resolved by revert PR #4634. The bot `hold` was left in place throughout;
diagnosing the cited run before touching the label is what made the
exoneration provable rather than asserted.
