---
id: 3400
title: "R-FUNC: per-function LOC ceiling ratchet (check:func-budget) — enforce the 300-LOC function criterion (#3102 slice 2)"
status: done
completed: 2026-07-24
sprint: 76
created: 2026-07-18
updated: 2026-07-24
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
model: opus
task_type: refactor
area: codegen, tooling
goal: maintainability
related: [3102, 3131, 3399, 3111, 3108]
implements: 3102
---

# #3400 — R-FUNC: per-function LOC ceiling ratchet

**Implements #3102 slice 2** (explicitly deferred there: _"Optional slice 2
(per-function ceilings) left as a follow-up; the change-scoped [file] gate
ships first"_). Roadmap parent: **#3399** phase E0.

## Problem

`check:loc-budget` (#3102/#3131) enforces a **file**-size ceiling (1,500 LOC,
shrink-only ratchet). Nothing enforces a **function**-size ceiling. The
2026-07-18 census (#3399 §2) finds **166 top-level functions over 300 LOC**,
including five call-shape functions of 1,800–3,100 LOC that #742's split of
`compileCallExpression` _produced_ (a 12,210-LOC god function fractured into
five smaller gods, each still an order of magnitude over the criterion).

The elegance criterion "no function > 300 LOC" is therefore true nowhere and
enforced nowhere. Every decomposition PR (#3108, #3111) shrinks functions,
but without a ratchet the shrinkage is not banked and the next feature PR
regrows them — the exact dynamic #3102's own header documents for files
(`index.ts`: 14,344 → 6,368 → 16,565). R-FUNC is the function-granularity
twin that banks #3108/#3111's work permanently.

## Design — mirror `check-loc-budget.mjs` at function granularity

R-FUNC reuses `check-loc-budget.mjs`'s proven shape verbatim; the ONLY new
piece is the measurement (functions instead of files). Read
`scripts/check-loc-budget.mjs` and `scripts/lib/change-scope.mjs` first — the
change-scoping, grandfathering, banking, and allow-key logic transfer 1:1.

### What is measured

A **function unit** = any of these TS AST nodes with a body:
`FunctionDeclaration`, `FunctionExpression`, `ArrowFunction` (block body only),
`MethodDeclaration`, `GetAccessor`, `SetAccessor`, `Constructor`. Size =
`sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line -
getLineAndCharacterOfPosition(node.getStart()).line + 1` (1-based line span,
matching how humans read "how long is this function"). Nested functions are
measured **independently**, and a parent's span is NOT reduced by its
children's (an outer 800-LOC function with a 400-LOC inner arrow is TWO
violations) — this is intentional: both are over the reading budget.

**Use the TypeScript compiler API, not a regex.** `typescript` is already a
dependency; the crude `awk` heuristic used for the #3399 census mislabels
data-literal blocks (e.g. `runtime.ts`'s embedded JS string) as functions.
The AST walk is exact and is the same `ts.forEachChild` recursion the
compiler already uses. Suggested key: a stable identifier
`"<relpath>::<functionName>@<startLine>"` (name from the node, or
`getContextualName` for anonymous arrows: the assigned variable/property).
Using `@startLine` in the key would make it churn on every edit above the
function — instead key on `"<relpath>::<qualifiedName>"` and, for overload/
duplicate-name collisions within a file, disambiguate with an ordinal
(`#2`), the way source-map name resolution does.

### Threshold

`THRESHOLD = 300` (the #3399 elegance criterion). Like loc-budget's 1,500,
the number is a ratchet floor, not a claim that 300 is magic — the point is
"shrink-only, no new over-limit function." Grandfather every function already
over 300 at the change base.

### Change-scoped gate semantics (copy loc-budget exactly)

- **FAILS** when the change-set (a) grows a function that was already over 300
  at its base, (b) newly pushes a function over 300, or (c) adds a brand-new
  function over 300.
- **GRANDFATHERS** every function at its base size — blocks _growth of what
  you touch_, never demands shrinkage; a decomposition PR that only shrinks
  passes with zero ceremony.
- **BANKS** shrinkage automatically: the next change-set's base already has
  the smaller function.
- **INTENTIONAL over-limit** is granted per change-set via a
  `func-budget-allow:` frontmatter key in the change-set's own
  `plan/issues/*.md` (visible in the diff, no shared-file conflict — the same
  design decision #3131 made for loc-budget to kill cross-PR baseline
  churn). Value = list of `"<relpath>::<name>"` keys.
- The committed baseline `scripts/func-budget-baseline.json` is the whole-tree
  snapshot for the `--all` audit + the no-git fallback ONLY; PRs must NOT
  commit changes to it (post-merge `promote-baseline` reseeds it, same as
  loc-budget — wire it into the same writer).

### Files

- **`scripts/check-func-budget.mjs`** — new. Reuse `scripts/lib/change-scope.mjs`
  for base resolution; reuse loc-budget's frontmatter-allow parser (extract a
  shared helper if it isn't already one, else copy the ~15 lines). Flags:
  `--all` (whole-tree audit against baseline), `--update` /
  `--update-on-decrease` (post-merge reseed, same semantics as loc-budget).
- **`scripts/func-budget-baseline.json`** — new, generated by
  `check-func-budget.mjs --update`. Seed it in this PR from current main.
- **`package.json`** — add `"check:func-budget": "node
scripts/check-func-budget.mjs"`.
- **`.github/workflows/ci.yml`** — add `pnpm run check:func-budget` to the
  `quality` job right next to `check:loc-budget` (line ~152).
- **`scripts/*` post-merge writer** — whichever job runs
  `check:loc-budget --update` post-merge (promote-baseline / baseline-summary-
  sync) also runs `check:func-budget --update-on-decrease`. Grep the
  workflows for the loc-budget `--update` call site and add the twin.

### Unit test

`tests/` fixture with a `.ts` file containing a 250-LOC function (passes), a
350-LOC function (grandfathered when in baseline / fails when new), a nested
400-LOC arrow inside a 200-LOC parent (one violation), and an anonymous
arrow assigned to a const (named via the binding). Assert the gate's
pass/fail decision against a synthetic baseline + a synthetic change-set.
Follow whatever test pattern `check-loc-budget` already has (if none, add a
minimal vitest that imports the measurement function directly).

## Rollout: baseline is BIG — do NOT block existing code

Seeding a baseline with 166 grandfathered entries is the whole point (like
loc-budget's ~40-file baseline). The gate is **shrink-only from day one**;
it demands zero refactoring to land. #3108/#3111 then shrink entries and the
post-merge `--update-on-decrease` banks each drop. Over time the baseline
drains toward zero; when it hits zero, flip to empty-baseline (enforcing) —
same lifecycle as loc-budget and the ir-fallback ratchet.

## Test plan

1. `node scripts/check-func-budget.mjs --all` prints the 166-entry census
   (spot-check the top entries against #3399 §2 — `compileReceiverMethodCall`
   ~3,102, `compileBuiltinStaticCall` ~3,054, etc.; small deltas from the
   AST-vs-awk measurement are expected and the AST count is authoritative).
2. Unit test (above) green.
3. Byte-inert by construction — no compiler-source (`src/`) change ⇒ zero
   test262 delta, zero equivalence delta. `prove-emit-identity` not needed.
4. `tsc --noEmit` + biome/prettier clean on the new script.

## Acceptance criteria

1. `check:func-budget` wired into `quality`; fails a synthetic PR that adds a
   350-LOC function; passes a synthetic PR that only shrinks.
2. `scripts/func-budget-baseline.json` seeded from main (the grandfathered
   set); PRs do not commit to it; post-merge writer reseeds via
   `--update-on-decrease`.
3. `func-budget-allow:` frontmatter escape hatch works (per-change-set, no
   shared-file churn) — proven by a fixture.
4. Measurement uses the TS AST (not regex); nested functions counted
   independently; documented THRESHOLD=300 with the ratchet rationale in the
   script header (mirror loc-budget's header).
5. Zero compiler-source change; zero conformance delta.

## Why opus (mechanical)

The design is fully specified above and is a structural copy of an existing,
battle-tested script (`check-loc-budget.mjs`) with one new measurement
function. No open design questions remain — the only judgment call
(AST-node set + key stability) is decided here. Suitable for Opus execution.

## Resolution (2026-07-24)

Shipped as specified — a structural copy of `check-loc-budget.mjs` at function
granularity, reusing `scripts/lib/change-scope.mjs` 1:1.

- **`scripts/check-func-budget.mjs`** — measures every function unit via the TS
  AST (`collectFunctionSizes`: FunctionDeclaration/Expression, block-bodied
  ArrowFunction, Method/Get/Set/Constructor; 1-based inclusive line span; nested
  counted independently; `"<relpath>::<qualifiedName>"` keys with `#N` ordinal
  disambiguation). Change-scoped gate (`classifyFunctionChanges`, exported +
  unit-tested): grandfathers the base, fails on regrowth / newly-over-300 /
  brand-new-over-300, honors the `func-budget-allow:` frontmatter hatch, banks
  shrinkage. `--all` / `--update` / `--update-on-decrease` mirror loc-budget.
- **`scripts/func-budget-baseline.json`** — seeded from main: **185** functions
  > 300 LOC (the AST count is authoritative; the #3399 awk census of ~166
  undercounted nested/method units). Top entries match the spot-check
  (`resolveImport` 7098, `ensureObjectRuntime` 3513, `compileReceiverMethodCall`
  3127, `compileBuiltinStaticCall` 3096).
- **`package.json`** — `check:func-budget`.
- **`.github/workflows/ci.yml`** — wired into `quality` next to `check:loc-budget`.
- Post-merge writer twin (`--update-on-decrease` + `git add -f
  func-budget-baseline.json`) added beside every loc-budget `--update` site in
  `test262-sharded.yml` and `baseline-summary-sync.yml`.
- **`tests/issue-3400-func-budget.test.ts`** — 12 tests (measurement + verdict).

Verified live: a synthetic 350-LOC new function FAILS the gate (exit 1,
`__probeGiant__: 351 (> 300, +51)`); a 200-LOC function and a shrink PASS.
Byte-inert (no `src/` change) ⇒ zero conformance/equivalence delta.
</content>
