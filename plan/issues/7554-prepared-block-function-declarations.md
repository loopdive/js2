---
id: 7554
title: "Prepared path: Annex B block function declarations, hoisted nested vars, prefix blocks (#7354 L0c part 2)"
status: done
completed: 2026-11-27
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: []
related: [7354]
---

# #7554 — Prepared path: block function declarations and hoisted vars

Part 2 of #7354's slice L0c (ES5 test262 on the IR-only Prepared path): function declarations in blocks (Annex B
B.3.3/B.3.4) in sloppy function code, a `var` declared in a nested statement and read outside it, `{ … }` blocks before
a function's tail, and the leftovers of the L0c part 1 review.

## Implementation Plan (2026-11-27, branch `claude/7354-l0c2` from `claude/7354-l0c` e9ac3bb85c)

Annex B block functions, `var`s reached outside the statement that declares them, `{ … }` blocks in a function
prefix, and the part-1 review leftovers. Every arm is gated on `onPreparedDynamicLane`; ordinary bytes stay identical;
`from-ast.ts` (17160) does not grow.

### Measured at the base (5 probes, all fail)

`{ function f(){} }` read outside the block (abort `f not in scope`), `if (c) { function f(){} }`, the B.3.3
block-scoping shape (abort `unexpected statement before tail (got Block)`), `i` after `for (var i…)` (abort), `{ x = 2; }`
in a function prefix (abort).

### Mechanism (extends part 1's hoisting; no second path)

- **One analysis module, `src/ir/function-hoisting.ts`** (pure AST + checker, no lowering), replacing
  `localDeclarationCaptures`. `hoistedBodyNames(body)` answers the names a function body binds as cells of the carrier at
  entry (§10.2.11 VarDeclaredNames, only where needed): a `var` read or written by a function declaration of the body
  (part 1, now at any block depth), a `var` declared in a nested statement and reached outside that statement or before
  its declaration, and the var name of each Annex B function. `annexBApplies(declaration)` is B.3.3.1's test: sloppy
  function code, a function in a block, `case`/`default` clause or (B.3.4) an `if` arm, whose name is no parameter and
  whose replacement by `var` would collide with no `let`/`const`/`class`/block function of an enclosing scope (a simple
  catch parameter does not collide, B.3.5). The provenance asks the same module (`localNeedsDynamicCarrier`).
- **Lowering (from-ast; the hoisting emission is one helper pair, not a copy):** at function entry the body's names are
  cells (`undefined`) and its top-level declarations get their values (part 1). At the entry of a block, a `switch`'s
  case block (all clauses at once, before the dispatch) and a try/catch/finally block, each function declaration is a
  fresh cell of the block shadowing the outer name, valued through the same closure path; an Annex B one records the
  function's var cell. Evaluating the declaration statement copies the block cell into that var cell (B.3.3.1 step
  b.ii); otherwise it is a no-op. A block function in global code, or whose var cell is shadowed (a catch parameter of
  the same name), keeps refusing.
- **Blocks:** `{ … }` before the tail lowers through the existing body-statement Block arm (lane only).
- **Review leftovers:** a.) the parameter check reads the parameter list, not the scope; b.) the two "not in slice 3"
  diagnostics name the unsupported shape; c.) `bindingHoldsDynamic` looks inside a cell, so the call-site twin
  `heldType(callee)` goes; d.) the whole-program `__new_ReferenceError` failure is narrowed back to the function (or
  made right); e.) only if cheap.

### Still refused / aborting (by design)

Global-code Annex B (the var binding is a script global), block functions in strict code read outside their block
(ReferenceError per spec: the scope miss aborts), a block `let`/`const` shadowing a hoisted name (redeclaration
abort, part 1), `for (var k in …)` heads, implicit globals, `with`, `eval`.

### Tests, proof, quality criterion

- `tests/issue-7354-l0c-function-declarations.test.ts` (and a new `-annex-b` file if it would grow past ~120 lines):
  node agreement for block/if/switch/try/loop functions, B.3.3 block scoping, skip cases (let in an enclosing block,
  parameter, for-let head), existing var/function updates, nested-var reads; aborts for the refused shapes.
- Probes base → head with twins, ≤ 10 compiles per process; the part-1 probe sets; runner sample (411) and targeted
  list, no pass lost, a hand-made wrong twin for each new pass; ordinary bytes identical on both targets.
- **Quality:** one analysis module answering both lowering and provenance; one cell/value emission for body and block
  hoisting; Annex B is one field on the block's cell binding and one evaluation arm; no `func-budget-allow`, no
  `loc-budget-allow`; `from-ast.ts` ≤ 17160.

## Result (2026-11-27, branch `claude/7354-l0c2`)

### Built

- **Analysis module `src/ir/function-hoisting.ts`** (pure AST + checker), replacing part 1's `localDeclarationCaptures`:
  `hoistedBodyNames(body)` answers the names a function body binds at entry and their storage — a cell where a
  function inside the body reaches the name, else a dynamic slot (a cell needs the native closure setup, so a program
  with no closure would fail its physical construction) — and `annexBApplies` is B.3.3.1's test. The provenance
  (`hoistedBodyVar`) asks the same function.
- **Lowering (from-ast):** `hoistFunctionBody` at function entry (part 1's, now with slots and the parameter list
  instead of the scope, review 4a); `hoistBlockFunctions` at the entry of a block, try/catch/finally block, `with` body
  and a case block (all clauses, before the dispatch); one `bindHoistedCell`/`assignFunctionValues` pair for both;
  `lowerBlockFunctionEvaluation` copies the block cell into the var cell (B.3.3.1 b.ii), and wraps an `if`-arm
  function as a block of its own (B.3.4). The Annex B var cell is one field (`annexB`) on the block cell's binding.
  `lowerStatementList` hoists only for a function body; the early-return rest lowers through `lowerStatementSequence`.
  A `{ … }` block and a block function's evaluation are body statements before the tail; a block function ending a
  block is a tail that falls out. `bindUndefinedDynamicSlot` is shared with `lowerUninitializedVar`.
- **Review leftovers:** 4a parameter list; 4b the diagnostics say what is unsupported (the closure-capture one keeps
  its tested prefix); 4c `bindingHoldsDynamic` looks inside a cell, the conditional join's `heldType` twin is gone;
  4d a TDZ check on the lane refuses its function (the lane has no ReferenceError to throw) instead of the whole
  program at the physical plan; 4e not done (still the abort, never a wrong value).
- **Size:** the dense-array plans (pure AST) moved unchanged to `src/ir/dense-array-plans.ts`; `from-ast.ts`
  17160 → 16992.

### Still refused or aborting

Global-code Annex B (block function in `<module-init>`: "block function f is not hoisted"); a block function whose var
binding a catch parameter of the name shadows (the `*-no-skip-try` rows); strict block functions read outside their
block; a block `let`/`const` of a hoisted name (redeclaration); `for (var k in …)` heads; `with`; implicit globals.

### Proof

- Probes (node agreement, wrong twin for every right one, ≤ 10 compiles per process), head 82f713d3d7:
  part 1's 404 programs: 361 right, 14 abort, 25 refused, 4 node-throws; against part 1's `l0c4` outputs 4 abort→right
  (`empty-block@fn`, `cap-read-later-decl`, `redecl-var-fn`, `hoisted-var-use-fn`), nothing else changed. The 105
  L0c/reviewer programs: 67 right, 31 abort, 7 refused. 57 new programs (Annex B, nested vars, hazards: let shadowing,
  TDZ, globals of the same name, catch params, `with`): 38 right, 16 abort, 3 refused. Wrong 0, invalid 0, exceptions
  0 (one exception found by the runner — a `var` in a `with` body has no checker symbol — fixed in 82f713d3d7 and probed).
- Runner (`.tmp/myrun.sh`, IR path, standalone, honest oracle; base = part 1's `c1` results, 2026-11-27 01:09, same
  lists): targeted 44 → **62**, sample 87 → **90**; 21 new passes, all `annexB/language/function-code/*`, 0 lost. Each
  new pass has a wrong twin (the first `assert.sameValue` compares `'twin' + actual`): 21/21 fail.
- Ordinary pipeline bytes identical, base e9ac3bb85c vs head: 42 programs (part 1's 33 + blocks, block functions,
  nested vars, a TDZ module write, dense fill/reduction) × default/standalone, and 92 test262 files (part 1's 62 + 30
  Annex B) × default/standalone.
- Root test files the branch modifies, each alone, exit 0: d1 42, fa 41, h2-written 31, l0a-loose 5, l0a-relational
  9, l0b-expressions 6, l0b-statements 7, l0c-annex-b (new) 11, l0c-captured-writes 5, l0c-function-declarations 8,
  m-refusals 42, o-objects 13, p 25, r-provider-census 117, str 17, t 105, ty 61, w 8, x-dynamic-throw 59,
  h2-hoisted-var-declaration 32. Lifted refusals rewritten to node agreement: fa (a closure reading a later `var`),
  h2-hoisted (10 repeated/nested `var` shapes); h2-written's global-code Annex B refusal and x-dynamic-throw's two TDZ
  cases name the new refusal. The other 58 `issue-7354-*`/`7372` files and 3525 also run alone: all exit 0 except
  `str2c-dynamic-add` "refuses the results of untyped calls", which fails identically at the base e9ac3bb85c (the
  program compiles there too; not this change).
- Gates exit 0: typecheck (ts7), loc, func, coercion-sites, oracle-ratchet, dead-exports (merge-base). With
  `LOC_GATE_BASE` = origin/main 2e75c932fd: func OK; loc reports `src/runtime.ts` +1, which this branch does not touch
  (main changed it after the merge-base; the merge preview has no such growth).

## Review round 1 (2026-11-27)

- **Blocker fixed.** `function t(){ if (false) { function f(){} } return typeof f; }` threw
  `native closures: missing first signature/root` out of `compile()`: f's var binding was a cell, and the only closure
  (f) sat in the folded-away arm, so the program issued a cell type with no closure root. Root causes, both fixed:
  1. A hoisted name is a cell only where a function inside the body *names* it (a function's own name does not
     count); an Annex B var binding with no such reader is a slot (`lowerBlockFunctionEvaluation` writes a slot or a
     cell). The repro now gives node's `"undefined"`.
  2. A cell whose capturing closure is dead code still has no root; the physical plan now names that gap
     (`a mutable capture cell needs a closure root, and the program creates no closure`) instead of throwing.
  - Dead-code sweep, 20 programs (constant true/false arms in statement and tail position, `while (false)`,
    `for (;false;)`, after `break`/`continue`/`throw`/`return`, a non-matching `switch`, `0 && fn`, `false ? fn : 2`, a
    never-called block function, a hoisted declaration used only in dead code, function expressions only in dead
    code): 13 right, 4 abort, 3 refused (the new gap: a dead closure that names a hoisted var or itself), 0 exceptions.
    The repro shapes are in `tests/issue-7354-l0c-annex-b.test.ts` ("block functions in dead code").
- **Q2.** `isHoistedVar` (function-hoisting.ts) is the one predicate; the provenance calls it. `hoistedBodyNames` is
  memoised per body (`WeakMap`); the lists are appended in place.
- **Q3.** `HoistedStorage`'s doc and code agree: a cell where a function inside the body names the binding, else a
  slot — for vars and Annex B names alike.
- **Q4.** Every block function is bound by `hoistBlockFunctions` at its scope's entry; for an `if` arm (B.3.4) the
  arm's entry is the statement itself, so `lowerStmt` opens the arm's scope, hoists, then evaluates.
  `lowerBlockFunctionEvaluation` only copies (or refuses an unbound function statement).
- **Q5.** `ScopeBinding.hoisted`/`annexB` are replaced by `bodyVar` (a `var` of this function body, on a cell or a
  slot) and `blockFunction: { scope, varBinding? }`.
- **Q6 (rebutted).** The two message rewrites are review item 4b of the slice brief (the "not in slice 3" texts must
  say what is unsupported); the closure-capture one keeps the prefix its tests match.
- **Proof after the fixes** (code at 9d480c1e77):
  - Probes: part 1's 404 identical to round 0 (361 right, 4 abort→right vs part 1, nothing else changed); the 105 L0c
    and reviewer programs identical to round 0; 77 own programs (Annex B, nested vars, hazards, `with`, h2 shapes, the
    dead-code sweep): 51 right, 21 abort, 5 refused. Wrong 0, invalid 0, exceptions 0.
  - Runner, **base run by me this round** (`origin/claude/7354-l0c` e9ac3bb85c as `.tmp/basefull`, same lists, same
    runner): targeted 44 → 62, sample 87 → 90; 21 new passes (all `annexB/language/function-code/*`), 0 lost; the 21
    wrong twins all fail.
  - Ordinary bytes identical to e9ac3bb85c: 42 programs and 92 test262 files, each × default/standalone.
  - The 20 root test files the branch modifies, each alone: all exit 0 (annex-b now 13 tests).
  - Gates exit 0; with `LOC_GATE_BASE` = origin/main 2e75c932fd only the inherited `src/runtime.ts` +1 (not touched by
    this branch). `from-ast.ts` 16992 → 17007 (≤ 17160).
