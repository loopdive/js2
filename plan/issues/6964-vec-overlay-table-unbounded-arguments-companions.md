---
id: 6964
title: "standalone: the vec-overlay companion table is append-only and every sloppy `arguments` object adds an entry, so indexed reads get linearly slower per run (Octane earley-boyer 1.5 s -> 13 s over five runs)"
status: done
completed: 2026-10-11
assignee: ttraenkler/claude-session-d
sprint: current
goal: standalone-gap
area: compiler
priority: high
horizon: m
feasibility: medium
depends_on: [6963]
# 2026-10-11: the numeric-only companion table, its lookup and the mark helper
# live with the overlay core they mirror (vec-overlay.ts ensureOverlayCore);
# the fresh-arguments define natives live with the arguments brand
# (arguments-length-brand.ts). Both are the plan's owner files.
loc-budget-allow:
  - src/codegen/vec-overlay.ts
  - src/codegen/arguments-length-brand.ts
func-budget-allow:
  - src/codegen/vec-overlay.ts::ensureOverlayCore
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
---

# Problem

Octane **earley-boyer** on `--target standalone` validates but each
`octane_run(1)` on one instance is slower than the last. Measured 2026-10-11
on `c-octane-integ` (load ~6 on 4 cores, so absolute numbers are noisy; the
trend is not):

| build | octane_run(1) x5 (ms) |
|---|---|
| c-octane-integ | 1479 / 2355 / 8000 / 10770 / 13284 |
| c-octane-integ + #6963 Stage 1 | 1534 / 4625 / 12635 / 19667 / 24632 |

`benchmark:octane --only earley-boyer --lanes node,standalone` times out
(180 s run budget) on both builds. `node --cpu-prof` (3 runs): `__extern_get_idx`
self 71 % (base) / 83 % (with #6963), `__vec_overlay_ensure` 7 % / 3.5 %.
The `__extern_get_idx` self time is the inlined `__vec_overlay_lookup` scan.

# Root cause

1. **Every sloppy function that touches `arguments` adds a companion.**
   `seedArgumentsIteratorProperty` / `seedArgumentsCallee`
   (`src/codegen/arguments-callee.ts` ~L183-226,
   `arguments-callee-poison-accessor.ts`) define the own `@@iterator` and
   `callee` properties through `__defineProperty_value`. For a vec receiver
   that is `__vec_dp_value` -> `__vec_overlay_ensure`, which APPENDS a
   `(vec, $Object companion)` pair to the global `__vec_overlay_state` table.
   earley-boyer calls `sc_list` / `sc_append` (both `arguments`-based) on
   every cons-list build, so the table gains thousands of pairs per run.
2. **The table is never pruned** (`ensureOverlayCore`, vec-overlay.ts
   ~L257-420: "append-only (identity pairs, no eviction)"). The pairs hold the
   vec STRONGLY, so every arguments object ever created is also retained
   (a memory leak, not only a time leak).
3. **Indexed reads scan it on every miss.** Once any companion holds a
   numeric key (`__vec_overlay_numeric` = 1 — earley-boyer still sets it via
   out-of-bounds dynamic stores, which keep the `__vec_dp_value` route after
   #6963), the `__extern_get_idx` READ prologue calls `__vec_overlay_lookup`
   for EVERY vec read. A vec without a companion — the normal case — walks the
   whole table newest-first before missing. Cost per read is O(arguments
   objects created so far), hence the per-run growth.

Why #6963 Stage 1 makes it look worse: before it, the hot vectors themselves
got a companion (their element stores went through `__vec_dp_value`), and the
newest-first scan found them after a short walk. #6963 stops creating those
redundant companions, so the same reads now MISS and pay the full walk. Repro
(`eb-probe.js`, 3000 `sc_list(1,2,3)` per run + one OOB store + 300 sums of a
100-element vec, five runs): base 67/117/59/143/275 ms; with #6963
295/652/756/1736/1904 ms.

# Implementation Plan

### Step 1 — index the READ scan by "has a numeric entry" (fixes the read cost)

The `__extern_get_idx` prologue only ever asks the companion for a NUMERIC key
(`__obj_find(comp, number_toString(idx))`); a companion with no numeric entry
always misses and falls through to the vec. So restrict that scan to
companions that have held a numeric entry — semantically exact.

- `ensureOverlayCore` (vec-overlay.ts): mint a second state global
  `__vec_overlay_num_state` of the SAME `$__overlay_state` type, and build the
  lookup through one helper parameterised by the state global
  (`__vec_overlay_lookup` / `__vec_overlay_lookup_num`), so no body is
  duplicated by hand.
- Every site that sets `numericFlagGlobalIdx` (vec-overlay.ts: the value
  define ~L1650, the accessor define ~L1930, `buildVecDeletePrologue` in
  vec-bag-seed.ts) also registers `(vec, comp)` in the numeric table once.
  "Once": test-and-set an unused `$Object.flags` bit on the companion
  (object-runtime.ts flag table: pick a free `OBJ_FLAG_*`, document it next to
  SEALED/FROZEN) instead of scanning.
- The `__extern_get_idx` READ prologue (vec-overlay.ts ~L2808) calls
  `__vec_overlay_lookup_num`. Leave `__extern_get` / gOPD / has / keys on the
  full table (they ask string keys too).
- The #6963 WRITE prologue i31 front door can then drop its
  `numericFlag == 0` gate in favour of `__vec_overlay_lookup_num(vec) == null`
  (a missing companion in the numeric table means no numeric entry for THIS
  vec) — that keeps stores fast in modules where some unrelated array has a
  real numeric descriptor.

Expected: earley-boyer per-run time flat (no growth from `arguments`);
eb-probe flat at the base's first-run cost or better.

### Step 2 — stop minting companions for arguments objects (fixes the leak)

`callee` / `@@iterator` on an arguments object are fixed-shape, per-object
properties. `$__arguments_vec` (arguments-length-brand.ts) already carries
per-object `length` override state in struct fields; give it `callee` and an
"own @@iterator present / deleted / redefined" slot the same way, answer them
from the `$__arguments_vec` arms of `__extern_get` / gOPD / `__extern_has` /
`__delete_property` / own-keys, and only fall back to a real companion when
user code redefines them with `Object.defineProperty`. Then no arguments
object enters the table unless the program itself defines a property on it.
Owner files: arguments-callee.ts, arguments-callee-poison-accessor.ts,
arguments-length-brand.ts, arguments-object-mop.ts.

### Step 3 (optional) — bounded table

With Steps 1-2 the full table only holds vecs the program explicitly
`defineProperty`'d or deleted from. If that still grows in a real workload,
replace the linear array with an identity hash keyed on a per-vec id: the only
viable key in WasmGC standalone is a field, so this needs an `id` slot on
`$__vec_base` (every vec `struct.new` site) — large, do only with evidence.

### Out-of-bounds appends (related, may be folded into #6963 follow-up)

An ordinary append `a[a.length] = v` on an extensible array with a writable
`length` and no inherited setter is the ArraySetLength-free path of
§10.4.2.1; it does not need `__vec_dp_value` either. Routing it to the
`fillExternSetVecArms` grow arm (checks: `__object_isExtensible_obj`, no
non-writable "length" companion entry, the existing inherited-set decision)
would stop most programs from ever setting `__vec_overlay_numeric`.

# Acceptance

- `eb-probe.js` (five runs) shows no per-run growth; each run ≤ the base's
  first run.
- earley-boyer `octane_run(1)` x5 flat within noise;
  `pnpm run -s benchmark:octane -- --only earley-boyer --lanes node,standalone
  --timeout 600` -> standalone `pass` at node-calibrated reps.
- No change in `tests/equivalence/`, the arguments-object tests
  (`grep -l "arguments" tests/issue-4243* tests/issue-4658* tests/issue-6651*`)
  and the #2666/#2668/#3251/#6963 overlay tests.

# Implementation notes (2026-10-11)

Stacked on #6963 (PR #6640, `claude/standalone-element-store-index`).

**Step 1 (as planned).** `ensureOverlayCore` mints a second `$__overlay_state`
global, `__vec_overlay_num_state`, and builds both lookups from one helper
(`__vec_overlay_lookup` over the full table, `__vec_overlay_lookup_num` over
the numeric one). `__vec_overlay_mark_num(vec, comp)` replaces every bare
`global.set __vec_overlay_numeric` (value define index arm + canonical-numeric
named key, accessor define index arm + named key, `buildVecDeletePrologue`):
it arms the flag and registers the pair once, test-and-setting
`$Object.flags` bit `0x100` (`OBJ_FLAG_OVERLAY_NUMERIC`) on the companion.
`markNumericLikeNamedKey` (vec-overlay-high-index.ts) now takes the mark
instructions instead of the flag global — the one edit outside the plan's file
list, a signature change of a helper only vec-overlay.ts calls.
The `__extern_get_idx` READ prologue and the `__extern_has_idx` presence
prologue use the numeric lookup (both only ever ask a numeric key, so a
companion absent from that table always misses — exact). The #6963 WRITE fast
path now asks "does THIS vec have a numeric entry" (`flag == 0 ||
lookup_num(vec) == null`) instead of the module-wide flag.

**Why Step 1 alone did not flatten eb-probe** (measured: 63/196/820/476/1034
ms). Profiling showed the per-call cost was not the read scan but the SEED:
`__defineProperty_value(arguments, "callee")` runs the vec define preamble —
`__vec_overlay_ensure` (a full newest-first MISS scan for a brand-new vec) and
the §10.1.6.3 extensibility guard, whose `__integrity_bag` →
`__vec_bag_ensure` walks the expando-bag list and prepends a bag per arguments
object (39 % self time in `__vec_bag_ensure`).

**Step 2 (variant).** The seeds (`@@iterator`, sloppy `callee`, strict poison
`callee`) call `__args_own_define_value` / `__args_own_define_accessor`
(arguments-length-brand.ts; placeholder = forward to the generic define). The
finalize fill resolves the companion with `__vec_overlay_ensure_newest` (the
newest pair if it is this vec, else an append — never a scan) for the branded
`$__arguments_vec`, which is always freshly built, and the scanning `ensure`
for an unbranded vec (a non-observable arguments object may alias the extras
vec), then runs the ordinary `$Object` define on the companion. Same result as
the vec preamble for a fresh, extensible arguments object with a non-index,
non-`length` key. The sloppy `callee` seed is now also gated on the #4578
observability proof (it already gated `@@iterator` / strict poison): an
arguments object used only via `.length` and proven-numeric indices cannot
reach `callee`.

**Deviation from the plan's Step 2.** The plan asks for `callee`/`@@iterator`
slots on `$__arguments_vec` so no arguments object enters the companion table.
That needs new struct fields, and the only `struct.new $__arguments_vec` is in
`arguments-vector-tail.ts`, outside the plan's file list — so it is not done.
Consequence: each OBSERVABLE arguments object still appends one companion
(memory is retained, and a string-key overlay probe on a vec WITHOUT a
companion still scans the table). The per-call time no longer grows: eb-probe
and earley-boyer are flat (numbers in the PR report).

## Remaining

- Plan Step 2 proper (callee / @@iterator in `$__arguments_vec` fields,
  companion only on user redefinition) to stop the table/memory growth; needs
  `arguments-vector-tail.ts` (`struct.new` operands).
- Step 3 (bounded/hashed table) not attempted.
- Pre-existing, unchanged: `delete args.callee; "callee" in args` answers
  `true` on standalone (node `false`), base and head alike.
