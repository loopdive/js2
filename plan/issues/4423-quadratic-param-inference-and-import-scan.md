---
id: 4423
title: "Compile scaling: param inference was quadratic (4.4x at 512 functions) + per-call O(imports) scan"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
goal: velocity
---

## The scaling bug

Compile time was **super-linear** in program size. Measured (warm process, one
compile per row, synthetic 2-function units):

| units | bytes  | before  | ms/KB | exponent vs half |
| ----: | -----: | ------: | ----: | ---------------: |
|    32 |  3,663 |   226ms |  63.1 |                — |
|    64 |  7,375 |   385ms |  53.5 |             0.77 |
|   128 | 14,940 |   688ms |  47.2 |             0.84 |
|   256 | 30,428 | 1,930ms |  65.0 |         **1.49** |
|   512 | 61,404 | 6,041ms | 100.8 |         **1.65** |

ms/KB *falls* then *rises* — the signature of a quadratic term taking over
above ~128 functions.

**Cause:** `inferParamTypeFromCallSites(ctx, funcName, paramIndex, sourceFile)`
walked the **entire source file** looking for calls to one function, and is
invoked once per (function, parameter). That is
O(functions × params × programSize). Instrumented:

| units | calls | AST nodes visited |
| ----: | ----: | ----------------: |
|    32 |   128 |           184,448 |
|   128 |   512 |         2,949,632 |
|   512 | 2,048 |    **47,187,968** |

4× the input, 16× the work — 47 million node visits for 61 KB of source. A CPU
profile put that single `visit` at **25.2% of a large compile**, with
TypeScript's `forEachChild` underneath it accounting for most of the rest.

**Fix:** bucket call sites by callee name in ONE walk per source file
(`WeakMap<SourceFile, Map<string, CalleeSite[]>>`), then look up. The match was
already `(isCallExpression || isNewExpression) && isIdentifier(expression) &&
text === funcName` — perfectly indexable. Buckets keep document order so an
order-dependent `agreed`/`conflict` accumulation resolves identically, and the
index holds exactly the nodes `forEachChild(sourceFile, …)` reached, so
coverage is unchanged. Keyed on the `SourceFile` object, so a new program (or a
cjs-rewritten file) gets a fresh index with nothing to invalidate.

## The per-call import scan

`callTargetFuncType` (`src/codegen/call-arg-producers.ts`) ran per call
instruction and did **two O(imports) passes** each time: a `.filter()` that
allocated a whole array merely to *count* func imports, then a second linear
scan to find the n-th one. 2.4% of a large compile.

Cached per module, keyed on `mod.imports.length` — sound because imports are
**append-only** (`addImport` pushes; the index fixups renumber operands without
adding or removing entries), so an unchanged length means an unchanged list.

## Result

| units | before  |  after | speedup |
| ----: | ------: | -----: | ------: |
|   128 |   688ms |  380ms |   1.81× |
|   256 | 1,930ms |  677ms |   2.85× |
|   512 | 6,041ms | 1295ms | **4.7×** |

Scaling exponent **1.65 → 0.94**, and ms/KB now *falls* monotonically
(63.1 → 21.6) instead of rising. Linear.

Small inputs are unchanged (~420ms on the 3-source test262 benchmark) — a
test262 file has too few functions for the quadratic to bite. This is a win for
**real-world code**, which is where the previously-measured 51 KB/s throughput
was hurting, and it directly attacks the self-hosting blocker in #4417's
follow-up (`src/ir/lower.ts` took 97.9s inside a 71-file graph vs 18.4s alone —
a 5.3× in-graph inflation that is exactly this shape).

## Verification

Two independent test sets, run on this change AND on `origin/main`, identical
both ways:

- 22 param-inference / fnctor / #743 / #3548 / #3961 files: 131 passed / 19 failed
- 18 call-arg / stack-balance / import / linker / component / closure files:
  144 passed / 21 failed

All those failures are **pre-existing on `origin/main`**.

## Rejected: an early-out in `runNodeChecks`

`runNodeChecks` is a sequential chain of ~95 guarded checks run for every AST
node, at 4.4% **self** time. The obvious fix is to bail immediately for kinds
no check can act on. I derived the kind set mechanically from the function body
— every `ts.isX(node)` guard and every `node.kind === ts.SyntaxKind.X` test,
57 kinds, all resolving cleanly.

**First attempt lost 1,185 diagnostics** in a differential over 7,854 files
(test262 `language` + `annexB` + `src`): **2,571 → 1,386**.

**My first diagnosis of that loss was wrong, and it is worth recording why.** I
concluded that checks keying off `DoStatement`/`WhileStatement` never appear as
a literal `ts.isX(node)` guard, so "no text-derived list can be complete". That
is false — *"Function declarations are not allowed in statement position"* is
guarded by `ts.isFunctionDeclaration(node)`, kind 263, which **was** in the
derived set. The real bug was structural: the recursion
`forEachChild(node, (child) => runNodeChecks(ctx, child))` is the **last
statement of the function**, so an early `return` pruned entire subtrees rather
than skipping one node's checks.

Re-implemented correctly — `runNodeChecks` traverses unconditionally,
`runNodeChecksSelf` holds the 95 guards and is called only for kinds in the
set — the same differential loses **0 diagnostics**.

**Reverted anyway, on measurement.** 512 units 1295 → 1285 ms; small inputs
~424 → ~421 ms. Both inside noise. A 57-element parallel list that drifts
silently and disables conformance checks when it does is not worth zero
measured gain.

**This also argues against the `switch (node.kind)` refactor**, which was the
recommended follow-up in the first version of this note. The Set gate is a
cheap proxy for *half* of what a switch buys — skipping nodes no check handles.
That half measured zero. The other half (dispatching directly to the handful of
checks for a handled kind, instead of running all 95 guards) is the remaining
upside, but the structure is favourable for it: 95 guards, exactly one non-`if`
top-level statement (the recursion), no shared state between guards, no union
predicates, and every guard leads with a kind test (30 bare `ts.isX(node)`,
65 that plus a further condition). So a switch is *mechanically feasible* — it
just has a much smaller expected payoff than the profile line suggests, and
should be measured on a prototype before anyone commits to the refactor.

## Reproduce

`.tmp/scaling2.mts` (exponent table), `.tmp/prof-big.mts` + `--cpu-prof`
(attribution), `.tmp/ee-diff.mts` (the early-out differential).
