---
id: 4487
title: "IR: adopt SPREAD in array literals (`[...a, x]`) for statically-provable source lengths"
status: done
completed: 2026-08-15
assignee: ttraenkler/opus-4487
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: fix
area: ir
language_feature: arrays
goal: ir-full-coverage
parent: 2855
related: [3518, 3583, 1804]
loc-budget-allow:
  - src/ir/array-spread-shape.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# #4487 — IR: adopt spread in array literals

`SpreadElement` is the only remaining hard reject inside the otherwise
IR-owned array-literal shape. Measured on `origin/main`
(793b5c0, `.tmp/spread-probe.ts`, `JS2WASM_IR_SHAPE_DIAG=1`): **every**
spread shape rejects at one arm, `expr-arraylit-spread`, regardless of what
the source is:

| shape | reject arm (before) |
| --- | --- |
| `[...a]` | `expr-arraylit-spread:SpreadElement` |
| `[...a, x]` | `expr-arraylit-spread:SpreadElement` |
| `[x, ...a, y]` | `expr-arraylit-spread:SpreadElement` |
| `[...a, ...b]` | `expr-arraylit-spread:SpreadElement` |
| `[...p]` (param) | `expr-arraylit-spread:SpreadElement` |
| `[...g()]` | `expr-arraylit-spread:SpreadElement` |
| `[..."ab"]` | `expr-arraylit-spread:SpreadElement` |
| `[1, 2, 3]` (baseline) | CLAIMED |

So one uniform arm hides two very different situations, and the matrix row
records "spread" as if it were a single feature.

## Why only *some* spreads can be adopted

`vec.new_fixed` (#1804) is the IR's only array-allocation node and its count
is a **compile-time** number — the WasmGC emitter lowers it to
`array.new_fixed` / `array.new_default` with an `i32.const` length
(`src/ir/backend/wasmgc-emitter.ts` `emitVecNewFixed`), and the linear
emitter realises the same fixed `[header][len][cap][elements…]` intent.
There is no `vec.new(n)` taking a runtime length, and no bulk-copy
primitive. A runtime-length spread therefore needs a genuinely new IR node
kind plus matching lowerings in every backend — out of scope here.

What *is* in scope: sources whose element count is provable at compile time.
Those expand **element-wise** into the existing fixed literal, which also
buys the two JS semantics that matter for free:

- **copy, not alias** — `vec.new_fixed` allocates a fresh backing array, so
  mutating either side afterwards is not observable through the other.
- **left-to-right evaluation** — elements, spread reads included, are
  lowered in source order.

## Scope

Adopted (`src/ir/array-spread-shape.ts`):

1. `inline-literal` — the operand is itself a dense array literal
   (`[...[1, 2], x]`). Elements are inlined verbatim; the operand is never
   allocated. This mirrors the call-argument spread expansion that already
   ships (`isStaticSpreadSource`, slice 8a).
2. `fixed-const-vec` — the operand is an identifier bound by a
   function-local `const` whose initializer is a dense array literal, **and**
   whose length is provably invariant across the enclosing function. The
   lowerer emits one `vec.get` per index against the source lowered once.

The invariance proof is a name-text scan of the declaring function scope.
Every occurrence of the name must be a length-preserving, non-escaping read:
an element read `a[i]`, a `.length` read, `for (… of a)`, or a spread into an
array literal. Refused: any write position (`a[i] = v` extends the array when
the index is out of range, so index writes are refused too), `a.length = n`,
any method call (`a.push(…)`), passing `a` anywhere it could be aliased and
resized, and any competing binding of the same name. Module-level `const`s
are excluded — a module global can be mutated from any function, so a
whole-function scan proves nothing.

Still rejecting, now under their own arm `expr-arraylit-spread-dynamic-source`
so the residual is legible: spread of a parameter, of a call result, of a
`let` binding, of a string (the iterator protocol), and of a `const` array
that could be resized or escape. Sparse literals keep `expr-arraylit-sparse`.

A non-scalar (string/externref-carrier) spread source demotes at build time
through `IrUnsupportedError` rather than a bare `Error`: `vec.get` on a
string vec yields the STORED `externref` while a sibling string literal
lowers as `IrType.string`, and the two cannot share one `vec.new_fixed`
element type. A bare throw reads as an unexpected internal throw under
IR-first and fails the compile instead of falling back — measured, see the
test file.

## Acceptance criteria

- `[...a]`, `[...a, x]`, `[x, ...a, y]`, `[...a, ...b]` over same-typed
  numeric/boolean `const` vecs are selector-CLAIMED and IR-emitted, and agree
  with both legacy codegen and Node.
- Element order, length and copy (non-aliasing) semantics are asserted
  claim-backed, not vacuously.
- Dynamic-length sources still reject, with the typed arm preserved.
- `check:ir-fallbacks` shows no bucket growth; `gen:ir-adoption --check`
  clean; `check:ir-only` host 37/37 and the standalone floors unchanged.

## Test Results

Measured shapes, before → after (`.tmp/spread-probe.ts`, `JS2WASM_IR_SHAPE_DIAG=1`;
`legacy`/`ir` columns are the compiled-and-run values, equal in every row):

| shape | before | after |
| --- | --- | --- |
| `[...a]` (const vec) | `expr-arraylit-spread` | **CLAIMED** |
| `[...a, x]` | `expr-arraylit-spread` | **CLAIMED** |
| `[x, ...a, y]` | `expr-arraylit-spread` | **CLAIMED** |
| `[...a, ...b]` | `expr-arraylit-spread` | **CLAIMED** |
| `[...a, ...a]` | `expr-arraylit-spread` | **CLAIMED** |
| `[...[1, 2], x]` | `expr-arraylit-spread` | **CLAIMED** |
| `[...a, true]` (bool vec) | `expr-arraylit-spread` | **CLAIMED** |
| `[...p]` (parameter) | `expr-arraylit-spread` | `expr-arraylit-spread-dynamic-source` |
| `[...g()]` (call result) | `expr-arraylit-spread` | `expr-arraylit-spread-dynamic-source` |
| `[..."ab"]` (string) | `expr-arraylit-spread` | `expr-arraylit-spread-dynamic-source` |
| `[...a]` with `let a` | `expr-arraylit-spread` | `expr-arraylit-spread-dynamic-source` |
| `[...a]` with `a` mutated/escaping | `expr-arraylit-spread` | `expr-arraylit-spread-dynamic-source` |
| `[...a, , x]` (sparse) | `expr-arraylit-spread` | `expr-arraylit-sparse` (more specific) |
| `[...a, "r"]` (mixed family) | `expr-arraylit-spread` | `expr-arraylit-mixed-primitive-family` |
| `[1, 2, 3]` (control) | CLAIMED | CLAIMED |

`tests/issue-4487.test.ts` — 54 cases, all green. Positives are claim-backed
(selector claims AND `irOutcomes` reports `irBodyEmitted`) and each is checked
against Node running a JS twin as well as legacy codegen.

**Aliasing / copy proof.** `const a = [1,2,3]; const b = [...a]; b[0] = 100;`
→ `a[0]` is `1` and `b[0]` is `100`, on Node, legacy and IR, with the function
claim-backed. Two spreads of one source are independent (`b[0] = 50` leaves
`c[0]` and `a[0]` at `1`). The mirror probe (write the SOURCE, read the copy)
cannot be claim-backed — a write through the source is exactly what the
length-invariance analysis refuses — so it is pinned as a negative instead.

**Review finding, fixed before landing.** The first cut searched the whole
function for a declaration by NAME, which bound

```ts
const a = [1, 2, 3];
function f() { { const a = [1, 2]; g(a); } const b = [...a]; }
```

to the block-local `a` (length 2) while the spread refers to the module-level
`a` (length 3) — a miscompile. The competing-binding check could not catch it
(within the function there is exactly one `a`). Fixed by requiring the spread
to be a descendant of the declaration's own block scope and to follow it in
source order; both are pinned as unit tests.

**The string-carrier hard-fail was ONE instance of a general defect, and the
other two instances were live on the branch.** Adopting the spread makes the
selector CLAIM units that then reach a bare `Error` inside `lowerArrayLiteral`;
under IR-first a bare throw is an *unexpected internal error*, so the compile
FAILS rather than demoting to the (correct) legacy body. Found by A/B against
the branch base with the file-copy pattern (base `src/ir/{from-ast,select}.ts`
restored, `.tmp/probe-4487b.ts` / `-4487c.ts`); both shapes compiled fine on
base, because base rejected them at `expr-arraylit-spread` and never claimed
them:

| shape | base | branch (first cut) | now |
| --- | --- | --- | --- |
| `[...a]`, `const a: number[] = []`, no hint | reject → legacy, compiles | CLAIMED → `IR path failed` **CE** | demotes, compiles |
| `[...a]` over a `number[][]` const | reject → legacy, compiles | CLAIMED → `IR path failed` **CE** | demotes, compiles |
| `[...[[1], [2]], [3]]` (binding-free) | reject → legacy, compiles | CLAIMED → `IR path failed` **CE** | demotes, compiles |
| `[...a]` over a string-carrier const | reject → legacy, compiles | fixed in the first cut | demotes, compiles |

The zero-element throw is this branch's own; the non-scalar element-type throw
is **pre-existing** (it fires for `const a = [[1], [2]]` with *no spread at
all* — the literal-construction twin of #4486), and adoption newly routes
claimed units into it. All three now raise `IrUnsupportedError`
("array-representation-unsupported"), like the string-carrier arm. The general
rule this leaves behind: **any throw inside `lowerArrayLiteral` reachable from
a newly-claimed shape must be typed-unsupported, never a bare `Error`.**

**Binding resolution is pinned end-to-end.** Because the source binding is
resolved by a name-text scan, any shape where `a` at the spread could resolve
to a *different* declaration than the scan finds is a potential silent
wrong-LENGTH miscompile. Pinned as behaviour (not just as reject arms): an
inner function-scope `const` shadowing a module `const` reads the INNER length;
a `const` declared inside a loop body is re-bound per iteration and stays
exact; a source also iterated by a `for…of` still binds; and a
**catch-clause parameter** sharing the source's name is a competing binding
that must refuse the claim (it does).

**Measured non-issue.** A mixed-type spread cannot reach the pre-existing bare
`Error` mixed-type throw: `[...a, t]` (f64 vec + bool) and `[...a, x]` (bool
vec + number) both compile fine, and the annotated `const b: number[] = [...a]`
over a bool vec fails as an ordinary TypeScript type error, not a compiler
crash (`.tmp/mixed-hardfail-probe.ts`). The one hard-failure path that WAS
reachable — a string-carrier source — is fixed via `IrUnsupportedError` and
pinned by a regression test.

**Gates** — all re-run on this branch AFTER merging `origin/main` at `6f59633a`
(#4589 value-discard selector, #4592 native-map both touch `src/ir` and merged
cleanly):

- `tests/issue-4487.test.ts` — 54/54.
- `check:ir-fallbacks` — OK, no unintended/post-claim/module-level increases.
- `gen-ir-adoption.mjs --check` — up to date.
- `check:ir-only` — verdict READY. Host (single-host) lane 37 terminal units /
  37 emitted / 37 IR bodies / 0 unsupported. Standalone lane 19 emitted / 18
  unsupported, per-code breakdown **identical** to
  `scripts/ir-only-baseline.json`, floors unchanged. (The 17/20 recorded in the
  first cut was against the older base; `main` moving to `6f59633a` shifted the
  standalone lane *and* its committed baseline together.)
- `check:func-budget`, `check:loc-budget`, `check:oracle-ratchet`,
  `check:pushraw`, `check:test-vacuity-shapes`, `check:ir-adoption`,
  `check:issue-spec-coverage`, `check:done-status-integrity`,
  `check:issue-ids:against-main`, `check:issues`, biome (`lint`), prettier
  (`format:check`) — all exit 0.
- `equivalence-gate.mjs` — exit 0, **no new equivalence regressions**; 24
  failing / 1,661 passing against 36 known-failures in the baseline, and 12
  baseline failures now pass (from work landed on `main`, not from this branch
  — deliberately NOT ratcheted here). Note the run must not overlap an A/B
  source swap; the first attempt was discarded and re-run on stable sources.
- Adjacent suites (`array-capacity`, `array-methods`, `fast-arrays`,
  `ir-algorithms-cluster`, `issue-3583`): 7 failures, and the **same 7 test
  names fail on the branch base** (file-copy A/B, base
  `src/ir/{from-ast,select}.ts` restored) — pre-existing, untouched.
- `tsc --noEmit` — 486 errors, every one the documented symlinked-`node_modules`
  `@types/node` artifact (`TS2591`/`TS2304` on `process`/`require`/`__filename`);
  **zero** in any file this branch changes.

**Not attributable to this branch** (measured, both backends identical, unit
not claimed either way): `const a = [1,2,3,4]` at module level plus a *shadowed*
block-local `a` inside the function traps at runtime with "dereferencing a null
pointer" on legacy AND IR, on the branch base too (`.tmp/probe-4487e.ts`). A
legacy-side module-const defect, unrelated to spread.
