---
id: 4602
title: "Acorn standalone-dynamic residual ~1.9x vs pre-#4658 baseline: dynamic-set machinery"
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
assignee: loopdive/claude
priority: high
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen, standalone, npm-compat
language_feature: property assignment
goal: performance
sprint: current
horizon: m
related: [4578, 4586, 4504, 2175, 4556]
origin: "Same-machine A/B while verifying the published acorn/clsx npm-compat collapse: after the #4578 and #4586 fixes, clsx is fully recovered but acorn standalone-dynamic sits at ~52% of its pre-#4658 throughput."
files:
  - src/codegen/array-holes.ts
  - src/codegen/inherited-set-gate.ts
  - src/codegen/member-set-dispatch.ts
  - src/codegen/fnctor-typed-reads.ts
  - tests/issue-4602-inherited-set-per-key-gate.test.ts
loc-budget-allow:
  # One import line per consumer file of the new per-key gate (the gate logic
  # itself lives in the new src/codegen/inherited-set-gate.ts); types.ts gains
  # the documented `inheritedSetDirtyKeys` context field.
  - src/codegen/context/types.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/object-ops.ts
  - src/codegen/object-runtime.ts
  - src/codegen/proto-index-store.ts
  - src/codegen/typed-this.ts
func-budget-allow:
  # A two-line comment on the per-key gate swap inside the existing dispatcher
  # and the one-line context-field init; no new logic in either function.
  - src/codegen/member-set-dispatch.ts::fillMemberSetDispatch
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #4602 — acorn standalone-dynamic residual ~1.9x: dynamic-set machinery

## Problem

The published acorn/clsx standalone-dynamic collapse (dashboard run
`0d87f216`, 2026-08-20) had two stacked causes, both since fixed on main:

1. `536a3c0` strict-`arguments` poison accessors (~120–1,400x hot-path
   collapse) — fixed by #4578 / PR #4669.
2. Standardized `try_table` EH aborting Binaryen O4 `Flatten`, shipping
   UNOPTIMIZED binaries — fixed by #4586 / PR #4677 + #4678.

clsx standalone-dynamic is fully recovered. **Acorn is not**: it sits at
roughly **52% of its pre-#4658 throughput**, stable across repeated runs,
and the loss is concentrated in the dynamic property-set machinery.

## Measurements (all same machine, same command, 2026-08-21)

`node --import tsx scripts/generate-npm-compat-report.mjs --only acorn
--perf-only --lane standalone-dynamic`, ratio = js/wasm (higher is better).
Rows marked `+skip` had `--skip-pass=flatten` grafted into `optimize.ts` so
the O4 abort (pre-#4677 revisions) cannot mask the codegen signal — the same
graft measured **0.140** at the baseline revision, i.e. skipping Flatten
itself costs nothing.

| revision | state | acorn sa-dyn |
| --- | --- | --- |
| `6049c004` (pre-#4658 baseline) | full O4 | 0.1451 / 0.1373 |
| `6049c004` +skip | flatten skipped | 0.1402 |
| `1d0fc43` (mid-#4658) +skip | pre-unmask | 0.1333 |
| `dc188a3` (= `1d0fc43` + `6d18505`) +skip | first bad | 0.0010 |
| `0d87f216` (#4658 merge, dashboard rev) +skip | end of window | 0.0007 |
| `7b2a1f94` (post-#4665) +skip | before #4669 | 0.0010 |
| `f6ebb57` (first rev with #4677) | O4 retry | 0.0806 |
| `bc588f2` (HEAD 2026-08-21) | current | 0.0752 / 0.0757 |

Notes on the bisect: `git bisect` over `6049c004..0d87f216` (probe = the
`+skip` measurement, threshold 0.11) lands on `dc188a3`, whose only content
vs the good parent is `6d18505` (#4556: `arrayIndexConstantKey` restricted
to literal keys). `6d18505` is a CORRECTNESS fix — before it, `nums[i]`
folded to `nums[0]`, wrong-but-fast — so it did not *cause* the slow path,
it **unmasked** a slow dynamic path introduced earlier in the branch. #4578
(PR #4669) then recovered most of it (0.0010 → 0.0806). This issue is about
what is still left.

clsx same-machine for contrast: baseline 0.1387, HEAD 0.1313 — recovered.

## Profile evidence (HEAD, optimized O4 binary, `--preserve-debug-names --profile-runtime wasm`)

Top self-time, excluding the `node:inspector` frame (`post`, profiler
overhead):

| function | share of total |
| --- | --- |
| `__str_equals` | 13.2% |
| `__extern_set` | 8.5% |
| `__extern_get` | 1.5% |
| `__extern_strict_eq` | 1.2% |
| `__protoidx_brand_off` | 0.7% |

Dynamic-property machinery is ~35% of wasm self-time, spread across many
call sites (dozens of distinct profile nodes for `__extern_set` /
`__str_equals`). Eliminating it entirely would be worth ~1.5x, i.e. most of
the observed 1.9x gap.

## Candidate causes, with what is already measured

1. **`__extern_set` inherited-descriptor chain walk (#4504 / PR #4665)** —
   prime suspect, unquantified. Every dynamic [[Set]] now performs the
   nearest-descriptor walk across the receiver chain and native companions;
   acorn's parser mutates `this.pos` / `node.*` in its innermost loops. A/B
   of the walk alone is still missing (reverting #4665 at HEAD conflicts;
   needs a targeted fast-path prototype instead).
2. **`ec33d32` (#2175) seeded-companion routing on builtin-proto method
   reads** — measured: reverting it at HEAD moves 0.0757 → 0.0869, ~+15%.
   Every seeded data-method read goes through `__protoidx_get_r` instead of
   the singleton shortcut, even though prototype mutation is rare.
3. Other #4658 residue on the paths `6d18505` unmasked (dynamic element
   reads with non-literal keys).

## Fix (landed with this issue)

The isolation A/B settled the attribution: forcing `inheritedSetDescriptorDirty`
off at HEAD measured **0.1297** — the whole residual is the #4504 machinery's
**module-wide activation**, not the chain walk's own cost on genuinely dirty
keys. Acorn trips the flag through the standard buble/rollup ES5 accessor
shape (`var prototypeAccessors = {…}; prototypeAccessors.inFunction.get = fn;
Object.defineProperties(Parser.prototype, prototypeAccessors)`), and the
module-wide boolean then demoted every presence-tracked member write (and
absent-slot read) in the 226KB bundle — dominated by `node.start = …` FIRST
writes during Node construction, which all fell to `__extern_set`'s string
ladder + descriptor decision.

Landed change — **per-key precision, no semantics change**:

- `ctx.inheritedSetDirtyKeys` (new): the scan (`array-holes.ts`) collects the
  statically-known trigger key names — accessor declaration names, literal
  `defineProperty`/`defineProperties`/`create`/`__defineGetter__` keys — and
  reserves the module-wide flag for triggers whose key set is unknowable
  (freeze, captured define builtins, computed names, dynamic code).
- Identifier Properties bags (the buble shape) resolve through a dedicated
  conservative walk (`resolveBagIdentifierKeys`): declaration-literal keys ∪
  direct `bag.k = …` writes; ANY other occurrence of the identifier (aliasing,
  argument passing) is an escape → module-wide flag.
- Consumers with a static property name gate via `inheritedSetAffectsKey`
  (member-set/get dispatch, fnctor typed read/write, typed-this, assignment,
  member-set-f64): a clean key emits byte-identical pre-#4504 code. Key-dynamic
  machinery (`__extern_set` runtime, proxy, tombstones, vec overlays,
  proto-index store) activates on `inheritedSetAnyDirty`, so a dynamic set of a
  dirty key still reaches the shared decision (`src/codegen/inherited-set-gate.ts`).

Measured after (same machine, same command): **acorn standalone-dynamic
0.1381** (pre-#4658 baseline band 0.137–0.145, was 0.075), **clsx 0.1414**
(was 0.131, no regression). The remaining candidates below (ec33d32
seeded-companion routing) turned out not to be needed for the acorn target and
are left as-is.

## Fix directions (original analysis)

- **Fast path for the common [[Set]]:** a cheap monomorphic guard before
  the chain walk — e.g. a module-global (or per-prototype) "an inherited
  accessor/read-only data descriptor exists somewhere" flag, set by
  `__defineProperty_accessor` / companion mutation, checked once per
  `__extern_set`. Clean receivers skip the walk entirely; conformance is
  preserved because the flag is raised before any observable mutation.
- **Dirty-flag gate for `ec33d32`:** same shape — route seeded-member reads
  through `__protoidx_get_r` only after a builtin prototype data method has
  actually been assigned/deleted (a per-brand or global i32), otherwise
  return the pre-minted singleton as before.
- Reduce `__str_equals` ladder cost on hot keys (first-char/length guard is
  presumably already there — verify; consider key interning for extern-set
  paths).

## Acceptance criteria

- [x] acorn standalone-dynamic within noise of 0.14 same-machine (or its
      pre-#4658 band 0.10–0.15 on the dashboard) at O4 — measured 0.1381.
- [x] clsx standalone-dynamic does not regress (≥ 0.13 same-machine) —
      measured 0.1414.
- [x] #4504 conformance pinned tests stay green (inherited setter/read-only
      data descriptor honored after the fast path).
- [x] #2175 pinned tests stay green (untouched — the seeded-companion gate
      turned out not to be needed for the acorn target).
- [x] New pinned suite `issue-4602-inherited-set-per-key-gate.test.ts`:
      poisoned keys observe their descriptors through every collection route
      (literal key, buble identifier bag, alias escape) while clean-key writes
      stay correct. Two shapes are pre-existing gaps verified IDENTICAL on
      main `26a1801` and deliberately not pinned: a bag grown from `{}` by
      direct writes (module does not instantiate standalone), and
      frozen-prototype inherited-write refusal (never implemented); the gc
      lane does not honor ctor-prototype accessors at all (also pre-existing).
