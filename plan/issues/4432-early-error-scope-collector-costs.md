---
id: 4432
title: "early-error scope-collector costs — TDZ per-name re-traversal, var/lexical conflict re-walks, ancestor-walk predicate memoization"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
goal: velocity
loc-budget-allow:
  - src/compiler/early-errors/tdz.ts
  - src/compiler/early-errors/duplicates.ts
  - src/compiler/early-errors/predicates.ts
---

# #4432 — early-error scope-collector costs (the tail left by #4431)

Follow-up to #4425 (dispatch, merged PR #4525) and #4431 (check-body top-2,
PR #4529). Per-block instrumentation on 2026-08-15 (pre-#4431 shares of
in-block time; these grow proportionally once #4431's top-2 shrink):

- `checkTDZInStatements` (SourceFile/Block/CaseClause/DefaultClause): **10.1%**
- `checkVarLexicalConflicts` (Block/SourceFile): **6.7%**
- `checkDuplicateLexicalDeclarations` (Block/SourceFile): **3.0%**
- `isInsideClassStaticBlock` / `isInsideAsyncFunction` /
  `isInsideGeneratorFunction` ancestor walks (await/yield identifier blocks):
  **~3.4%** combined

## Hard constraint (same ship gate as #4425/#4431)

**Byte-identical differential.** `.tmp/ee-diff.mts` in the worktree
`/home/user/js2wasm/.claude/worktrees/compiler-speedup` runs
`detectEarlyErrors` over test262 `language`+`annexB` + `src/**/*.ts`
(25,862 files, 23,983 diagnostics, 0 exceptions) and dumps one JSONL row per
diagnostic in deterministic order. Baseline vs optimized must `cmp` equal.
Every optimization below is designed to preserve **error text, node,
count (one row per reference occurrence), and emission order** — read the
order notes carefully; they are where naive rewrites break.

## Implementation Plan (Fable, 2026-08-15)

### 1. `checkTDZInStatements` — one traversal per statement, not one per pending name

`src/compiler/early-errors/tdz.ts:18`. Current shape: for each
non-declaration statement, the loop `for (const [name] of letConstDecls) {
if (!declaredSoFar.has(name)) checkForTDZRef(ctx, stmt, name) }` re-traverses
the statement subtree **once per pending name** — O(pending × subtree).

Replace with one traversal per statement that collects matches for ALL
pending names, then emits grouped by name:

- Compute `pending = [...letConstDecls.keys()].filter(n => !declaredSoFar.has(n))`
  (keep **Map insertion order** — it is the emission order).
- Single visitor over the statement subtree, exact port of `checkForTDZRef`'s
  logic generalized to a name set: at an Identifier whose text is in
  `pending`, apply the two parent exclusions (PropertyAccessExpression name,
  PropertyAssignment name) and record the node into
  `matches: Map<string, ts.Node[]>` (encounter order per name); do NOT
  recurse into Identifier children (there are none — the original returns
  after the match check, same effect). Stop descent at the same five
  boundaries (FunctionDeclaration/FunctionExpression/ArrowFunction/
  ClassDeclaration/ClassExpression). Non-matching identifiers fall through
  to recursion exactly as before.
- Emit AFTER the traversal, iterating `pending` in order and each name's
  recorded nodes in order, pushing the same
  `Cannot access '${name}' before initialization` warning rows via
  `ctx.pos(node)`.

**Order rationale**: the original emits grouped by name (outer loop = map
order) then by node encounter (inner traversal). A single-pass
emit-at-the-identifier rewrite interleaves names in node order and BREAKS the
differential whenever one statement references two pending names. The
grouped-collect-then-emit shape above reproduces the original order exactly.

The initializer self-reference arm (`checkForTDZRef(ctx, decl.initializer,
varName)`) is single-name — either leave it calling the original
`checkForTDZRef` (keep the function; other callers may exist — grep first)
or route it through the generalized visitor with a one-element set.

### 2. `checkVarLexicalConflicts` — per-var-scope-root var-declaration index

`src/compiler/early-errors/duplicates.ts:364` +
`collectVarDeclaredNamesInBlock`. Current shape: EVERY Block/SourceFile with
≥1 lexical name re-walks its entire subtree (stopping at function/class
boundaries) hunting `var` statements — nested blocks make this
O(depth × nodes).

Build, once per **var-scope root**, a DFS-ordered index of var-declared
identifiers, then answer each block's query by position range:

- Var-scope root of a Block = nearest ancestor that is a SourceFile, a
  function-like body owner, or a ClassStaticBlockDeclaration (the roots at
  which `var` hoisting stops — mirror `collectVarDeclaredNamesInBlock`'s
  boundary list exactly: FunctionDeclaration, FunctionExpression,
  ArrowFunction, MethodDeclaration, ConstructorDeclaration, Get/Set accessor,
  ClassDeclaration, ClassExpression).
- `WeakMap<ts.Node /*root*/, Array<{ name: string; node: ts.Identifier }>>`,
  built lazily on first query by ONE walk from the root using the SAME
  boundary rules, recording each var-declaration Identifier in DFS order
  (only `var` lists: neither Let nor Const flag — port the flag test
  verbatim).
- A block's conflicts: iterate the root's index entries whose
  `node.getStart()`… wait — use `node.pos`/`node.end` **containment in the
  block's [pos, end)** (binary-search the DFS-ordered array for the range
  start; entries are position-sorted because the walk is DFS over a single
  file). For each entry in range with `lexicalNames.has(name)`, emit
  `ctx.addError(node, "Cannot redeclare block-scoped variable '<name>'")`.
- **Order rationale**: the original emits in DFS order of the block's
  subtree, names interleaved. The DFS index filtered by range IS that order.
  Note the original starts its walk AT the block node itself
  (`collectVarDeclaredNamesInBlock(ctx, block, …)` — a SourceFile/Block is
  never a VariableStatement, so starting from the block vs. filtering the
  root index by the block's range is equivalent).
- **Correctness subtlety**: entries inside a nested function under the block
  are already excluded from the root's index (the index walk stops at
  boundaries), and a nested function's own blocks resolve to a DIFFERENT
  root — so range-filtering never leaks across scopes. Assert this in a test
  with `{ let x; function f() { var x; } }` (no error — verify against
  current behavior first) vs `{ let x; { var x; } }` (error).

### 3. `checkDuplicateLexicalDeclarations` — same index idea, measure first

`duplicates.ts:82` (3.0%). Re-run the per-block instrumentation AFTER #4431
lands (see "How to measure" below) and only restructure if it still ranks;
its internals differ (it also reads `isStrictMode`, now memoized, so its
residual cost may already be small). Do not force it into the pattern
blindly.

### 4. Ancestor-walk predicates — memoize like `isStrictMode`

`predicates.ts`: `isInsideClassStaticBlock` (line ~216),
`isInsideAsyncFunction` (~675), `isInsideGeneratorFunction` (~692) are pure
ancestor-chain functions called per await/yield identifier. Apply the exact
`strictModeCache` pattern #4431 added (WeakMap + chain backfill). Read each
function first: memoize ONLY if the function is a pure function of the node
(no extra params); any predicate taking a second argument does not fit the
single-key WeakMap shape.

### How to measure (before/after, in the worktree)

- Per-block ranking: apply the instrumentation patch to `on()` in
  `node-checks.ts` (wrap each check with a `performance.now()` accumulator —
  see `.tmp/ee-blocktime.mts` header + the session notes in #4431), run
  `npx tsx .tmp/ee-blocktime.mts 9`, then RESTORE the file (`git checkout` /
  file copy). Never commit the instrumented file.
- Wall/CPU A/B: `npx tsx .tmp/ee-time.mts <label> 3` with file-copy swaps of
  the touched files (HEAD copies vs optimized copies), interleaved rounds.
- Ship gate: `npx tsx .tmp/ee-diff.mts .tmp/ee-<label>.jsonl` + `cmp` against
  a baseline regenerated from unmodified HEAD **in the same tree state**.

### Acceptance criteria

1. Differential byte-identical (the ship gate) — HEAD vs optimized.
2. Measured per-block or A/B numbers in the PR body (no predicted ranges).
3. Early-error suites green modulo the 2 known pre-existing issue-3632
   standalone failures (`js2wasm:runtime-eval` import — environmental).
4. `pnpm run typecheck` clean; prettier clean.
5. No behavior flags, no new exports beyond what the index/caches need.

## Results (measured 2026-08-15, worktree `compiler-speedup`, HEAD `1fe631e` = #4431)

### Ship gate

Byte-identical. `.tmp/ee-diff.mts` over test262 `language`+`annexB` +
`src/**/*.ts`: **25,862 files, 23,983 diagnostics, 0 exceptions** on both sides;
`cmp .tmp/ee-4432-base.jsonl .tmp/ee-4432-opt-final.jsonl` exits 0. The baseline
was regenerated from unmodified HEAD in the same tree, via file-copy A/B (no
`git stash`).

### CPU A/B (`.tmp/ee-time.mts`, 8,621-file sample, iter0 discarded as cold-JIT)

Interleaved base/opt rounds; each cell is the mean of the iter1+iter2
steady-state samples across all runs of that variant.

| variant | runs | wall | cpu | vs HEAD (wall) |
| --- | --- | --- | --- | --- |
| HEAD | 3 | 2.270 s | 2.387 s | — |
| **optimized (all four items)** | 4 | **1.938 s** | **2.058 s** | **−14.6 %** |
| tdz + duplicates only (no predicate memo) | 3 | 1.900 s | 2.027 s | −16.3 % |
| predicate memo only | 1 | 2.270 s | 2.385 s | −0.0 % |

Run-to-run spread within a variant is ±0.08 s, so the optimized vs
tdz+duplicates-only difference (0.038 s) is inside the noise band.

### Per-block ranking (`.tmp/ee-blocktime.mts 3`, 8,621 files)

| block | HEAD | optimized | delta |
| --- | --- | --- | --- |
| `checkTDZInStatements` (SourceFile/Block/CaseClause/DefaultClause) | 375.5 ms (8.9 %) | 214.7 ms (5.4 %) | **−42.8 %** |
| `checkVarLexicalConflicts` (Block/SourceFile) | 314.2 ms (7.5 %) | 278.7 ms (7.0 %) | **−11.3 %** |
| `checkDuplicateLexicalDeclarations` (Block/SourceFile) — untouched | 126.4 ms (3.0 %) | 141.4 ms (3.5 %) | +11.9 % (noise) |
| `yield` identifier block (`isInsideClassStaticBlock`/`isInsideGeneratorFunction`) | 75.8 ms (1.8 %) | 79.3 ms (2.0 %) | +4.6 % (noise) |
| `await` identifier block (`isInsideClassStaticBlock`/`isInsideAsyncFunction`) | 74.1 ms (1.8 %) | 78.2 ms (2.0 %) | +5.5 % (noise) |
| total in-block | 4,213 ms | 4,001 ms | −5.0 % |

The untouched control block moved ±12 % between runs, which sets this harness's
resolution floor — its `performance.now()` pair is charged per invocation, so
high-frequency low-cost blocks are inflated (the strict-reserved-word identifier
block reads as ~47 % of in-block time for that reason). Treat the CPU A/B as the
headline and the block ranking as attribution.

### Per item

1. **`checkTDZInStatements` — one traversal per statement.** Implemented as
   planned: `collectTDZRefs` records matches for all pending names into
   `Map<string, ts.Node[]>` in node encounter order, and emission iterates the
   `letConstDecls` key order and each name's node list afterwards. `pending`
   (a Set) replaces `declaredSoFar` as the complement, so both call sites read
   the same state. −42.8 % on its block; the largest single contributor.
2. **`checkVarLexicalConflicts` — per-var-scope-root index.** Implemented as
   planned: lazy `WeakMap<root, VarDeclIndex>`, DFS walk with
   `collectVarDeclaredNamesInBlock`'s boundary list ported verbatim, block
   queries answered by binary search over the DFS-ordered positions plus a
   `[pos, end)` containment filter. Parallel arrays (`names`/`nodes`/`poss`/
   `ends`) instead of objects. `varScopeRootOf` returns `null` — routing to the
   original direct walk — if the upward walk meets a VariableStatement before a
   boundary, since the index walk never descends into one. −11.3 %; smaller
   than item 1 because the corpus is dominated by small files where the block
   IS the root and the index build costs the same walk it replaces (the win is
   in nested blocks, which no longer re-walk what their parents already did).
3. **`checkDuplicateLexicalDeclarations` — SKIPPED after measuring.** It still
   ranks (126.4 ms, 3.0 %), but the plan's index idea does not apply: it never
   re-traverses a subtree. It iterates `block.statements` once, and every
   statement belongs to exactly one block, so the work is already linear in the
   file. What remains is per-statement work plus the three collections and one
   closure it allocates for every Block/SourceFile — a hoisting/lazy-allocation
   change in the #4431 style, i.e. a different optimization than this issue
   describes, and worth ~1 % of in-block time at best. Left for a follow-up
   rather than forced into the pattern.
4. **Ancestor-walk predicates — implemented, measured NEUTRAL.** All three are
   pure single-node functions, so all three were memoized. The cache is keyed by
   the ancestor the walk STARTS from (`node.parent`), not by the queried node,
   because these predicates — unlike `isStrictMode` — do not test the node
   itself; the terminal node belongs in the backfilled chain, the queried node
   does not. Measured on its own it is a 0.0 % wall / −0.1 % CPU change, and the
   per-block numbers move inside the noise band: the ancestor chains in this
   corpus are 1–3 nodes deep, so a WeakMap lookup costs about what the direct
   `ts.isX` tests cost. Kept because it is behaviour-identical (it is inside the
   byte-identical differential), it matches the pattern already in the file, and
   it bounds the deep-chain case that the corpus does not exercise — but it is
   **not** where this issue's speedup comes from, and a reviewer who wants the
   diff smaller can drop it at no measured cost.

### Tests

- `tests/issue-4432-scope-collectors.test.ts` (new, 8 tests) — pins the two
  things a byte-identical corpus run could still hide if the corpus lacks the
  shape: var-scope leak boundaries (`{ let x; function f() { var x; } }` clean
  vs `{ let x; { var x; } }` flagged, plus class-static-block and sibling-block
  cases) and TDZ emission order when one statement references two pending names
  (`a, a, b, b` — not the interleaved `a, b, a, b` a naive single-pass rewrite
  produces). All 8 pass on HEAD too, i.e. they pin existing behaviour.
- `issue-4417` / `issue-1931` / `issue-2929` / `issue-3632`: **65 / 67**. The
  two failures are the known pre-existing `issue-3632` `js2wasm:runtime-eval`
  import failures (host + standalone), unrelated to this change.
- `pnpm run typecheck` exits 0; prettier clean.
