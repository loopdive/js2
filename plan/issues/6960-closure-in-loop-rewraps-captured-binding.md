---
id: 6960
title: "codegen: a closure constructed INSIDE a while/do-while/for body that captures a parameter (or, for while/do-while, any outer var) the loop mutates re-wraps the RAW slot into a fresh ref cell every iteration — the loop condition never sees the write and spins forever (Octane earley-boyer `deriv_trees` loop2/sc_loop1; the #1589 for-loop pre-box skips params and does not exist for while/do-while)"
status: ready
sprint: current
created: 2026-10-11
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: closures, loops, capture-boxing
goal: standalone-gap
related: [874, 1589, 1617, 996, 2118, 6958]
---

# Closure in a loop body re-boxes a loop-mutated captured binding from the raw slot each iteration

Found by the Octane standalone triage (Session D, 2026-10-11). Second (and last) blocker of
`earley-boyer` on standalone; exposed only once the 9-argument dynamic-call defect
(`.tmp/#6959`) is fixed — with that fix simulated
at source level the Earley computation spins at 100 % CPU (killed after 14 CPU-minutes; node: 0.3 s).

## Minimized repro (`.tmp/m4.js` G / `.tmp/m5.js`; node `30`, standalone `-1` = guard hit)

```js
function G(k) {                       // `k` is a PARAMETER, mutated in the loop, captured by a closure built in the body
  var g = 0; var f = null;
  while (k > 0) { if (++g > 50) return -1; f = function () { return k; }; k = k - 1; }
  return g * 10 + f();                // node 30; standalone -1 (the loop never terminates without the guard)
}
```

| variant (`.tmp/m4.js`, `.tmp/m5.js`) | node | standalone |
|---|---|---|
| G: param, `while`, closure in body | 30 | **-1** |
| Lw: `var k = n` local, `while`, closure in body | 30 | **-1** |
| Mp: param, `for (; k > 0; k = k - 1)` | 30 | **-1** (the #1589 pre-box skips params) |
| Np: param, `do { … } while (k > 0)` | 30 | **-1** |
| K: `for (var i = 0; …; i++) fs.push(function(){return i})` | 33 | 33 (#1589 pre-box handles the for-head var) |
| H: closure built BEFORE the loop, loop mutates `k` | 30 | 30 |
| Op: write `k = k - 1` BEFORE the closure site in the body | 30 | 30 (by ordering luck, see below) |
| E/F: no loop, write after closure | 22 | 22 |

Same result in strict (module) and sloppy (`inferModuleStrictArguments: false`) mode.

Octane shape (earley-boyer, driver lines ~4654-4712, `deriv_trees`): `sc_loop1_98 = function(l1, l2) { while (true) { … loop2 = function(k, l2) { while (true) { … loop3 = function(l3, l2) { … return loop2(ender_set[k+5], l2); }; … k = ender_set[k+5]; … return sc_loop1_98(l1.cdr, l2); } }; … l1 = l1.cdr; } }`.
`k` (param of loop2) is captured by `loop3` and mutated by the loop; `l1` (param of `sc_loop1_98`) is
captured by `loop2` and mutated by the loop. The working twin `nb_deriv_trees` has the same loops with NO inner
closure — which is why `nb-trees*` = 132 while `trees*` hangs.

## Root cause (WAT of `G`, `.tmp/m4.js.wat`, `node --import tsx .tmp/sa.mjs .tmp/m4.js --script --no-eval --wat G`)

```wasm
(loop
  local.get 0            ;; while (k > 0) — RAW param slot, emitted BEFORE the body (loops.ts:297-305)
  f64.const 0  f64.gt  i32.eqz  br_if 1
  …
  ref.func 529  i32.const 0  ref.null extern
  local.get 0            ;; closure site: re-wrap the RAW slot …
  struct.new 329         ;; … into a NEW cell …
  local.tee 3            ;; … and make it the binding's storage (`__boxed_k@cell`)
  …
  local.get 3  local.get 5  struct.set 329 0   ;; k = k - 1 → writes the cell only
)
```

Two compounding defects in the construction-site boxing path,
`src/codegen/closures/arrow-phases.ts` L1404-1424 (the `else` of `if (fctx.boxedCaptures?.has(cap.name))`):

1. The site runs **every time the closure expression is evaluated**. On each iteration it executes
   `local.get <raw>; struct.new; local.tee <cell>` — minting a fresh cell seeded from the raw slot, which
   no longer holds the current value (writes since the first iteration went to the previous cell). The
   previous iteration's `k = k - 1` is lost. (Op "works" only because its write is emitted before the
   closure site in the same iteration and therefore still targets the raw slot.)
2. Even with a single cell, reads emitted **before** the site in compile order but executed **after** it
   at runtime — the `while` condition (`compileWhileStatement`, `loops.ts:297-305`), the `for` condition
   (`loops.ts:879-887`) — were compiled against the raw slot and never see cell writes.

`canBoxBindingInDominatingParent` (`arrow-phases.ts:199-259`) / `eagerDominatingBox` (L1367-1384) does not
rescue this: it only moves the mint "immediately before the conditional instruction" by appending to
`activationEntryBody` — the condition instructions already exist. And it is disabled outright for sloppy
functions (`fctx.sourceFunctionStrict === false`, L209), which is every Octane function.
`emitConditionalCaptureBoxRepair` (`closures/conditional-capture-box.ts`) repairs a *never-minted* cell;
it has no say over a cell that is re-minted.

**#1589 already solved exactly this for `for` statements** (`compileForStatement`, `loops.ts:746-828` +
write-back at L1028-1055): before compiling the condition it scans the loop for names referenced inside
nested closures (`findAllNamesCapturedByClosuresInForLoop`, `src/ir/analysis/loop-shape.ts:495`) and
pre-boxes each plain local into a `__pre_box_<name>` cell registered in `boxedCaptures` + `localMap`, so
condition/body/incrementor/closure all share one cell; on exit it writes the cell back to the raw slot.
Two gaps make the Octane shape fall through:
- L784: `if (oldLocalIdx < fctx.params.length) continue; // params get boxed by closure construction itself`
  — that assumption is the per-iteration re-wrap above; **parameters are precisely the case the
  construction site cannot handle inside a loop** (Mp).
- `compileWhileStatement` (L271) and `compileDoWhileStatement` (L1093) have **no pre-box pass at all**
  (G, Lw, Np). (`for-of`/`for-in` not measured; check `compileForOfStatement` L1161 / `compileForInStatement`
  L4002 for the same omission.)

## Implementation Plan

### 1. Extract the #1589 pre-box into a helper and apply it to every loop kind

**File: `src/codegen/statements/loops.ts`**
- Lift L746-828 (`preBoxedNames` construction) and L1028-1055 (write-back + `localMap` restore) into two
  helpers in the same file: `preBoxLoopCapturedBindings(ctx, fctx, stmt: ts.IterationStatement): PreBoxed[]`
  and `writeBackPreBoxedBindings(fctx, preBoxed)`. Keep the `savedForBoxedCaptures` restore exactly as the
  for-loop does it today.
- `compileWhileStatement` (L271): call `preBoxLoopCapturedBindings` **before** `pushBody`/condition
  compilation (i.e. right after `arenaReset`, L286, in the OUTER body — same position the for-loop uses,
  before its own `pushBody` at L859); call `writeBackPreBoxedBindings` after `popBody` + `fctx.body.push(blockLoop(...))`.
- `compileDoWhileStatement` (L1093): same — pre-box before `pushBody` (L1109), write back after the loop
  is pushed (after L1141).
- `compileForStatement`: replace the inline block with the helper call (behaviour-preserving for vars).

**File: `src/ir/analysis/loop-shape.ts`**
- Generalize `findAllNamesCapturedByClosuresInForLoop(stmt: ts.ForStatement)` to
  `findAllNamesCapturedByClosuresInLoop(stmt: ts.IterationStatement)`: visit `stmt.statement` always;
  additionally `condition`/`incrementor` for `ts.isForStatement`, `expression` for `while`/`do`,
  `expression`+`initializer` for `for-in`/`for-of`. Keep the old name as a thin alias or update the two
  importers (`loops.ts:77`, and `src/ir` callers — grep).
- `findBodyLocalLexicalNames(stmt: ts.ForStatement)` (L~520) → same widening to `ts.IterationStatement`
  (it only reads `stmt.statement`).

### 2. Admit parameters to the pre-box (the Mp / earley `loop2(k, …)` case)

`loops.ts:784` — delete the `oldLocalIdx < fctx.params.length` skip. For a param the raw slot is
`fctx.params[oldLocalIdx]` (type from `fctx.params[oldLocalIdx].type`, not `fctx.locals[...]` — fix the
L785 lookup accordingly). Everything else (mint `__pre_box_<name>` from the raw slot, re-aim `localMap`,
write back on exit) is identical. The value-type whitelist at L791-800 already admits `externref`/`ref_null`/
`f64`/`i32`; a struct-typed param (`ref`) is still skipped — note that the #6958 inference now withdraws
struct typing for a param the body writes, so earley's `l1`/`k` are `externref`/`f64` and qualify
(verify with `--wat`).

### 3. Make the construction site idempotent (defence in depth, closes the `Op`-style ordering luck)

**File: `src/codegen/closures/arrow-phases.ts` L1404-1424** — when minting the first cell for a capture at
a construction site, emit it as *mint-if-null*:
```wasm
local.get $cell  ref.is_null
if  local.get $raw  struct.new $Cell  local.set $cell  end
local.get $cell
```
instead of the unconditional `local.get $raw; struct.new; local.tee $cell`. The cell local is already
`ref_null`, and `emitConditionalCaptureBoxRepair` already emits exactly this sequence for the frame's own
accesses — reuse it (`emitConditionalCaptureBoxRepair(fctx, cap.name, boxedLocalIdx)` after registering
`boxedCaptures` with `rawLocalIdx`, then `local.get boxedLocalIdx`). Steps 1-2 are what fix the loop
condition; this step stops a re-executed site from discarding the live cell on the paths steps 1-2 do
not reach (a closure site inside a nested block of a loop that the scanner excluded, labelled loops, …).

### Order / blast radius
- Steps 1-2 only add cells where a closure inside the loop references the name — loops without closures are
  byte-identical (the scanner returns an empty set). `K`-style for-loops keep their current lowering.
- Pre-boxing a param in a sloppy function: `arguments[i]` aliasing of params is already not modelled for boxed
  captures (the closure path boxes params today); no new gap.
- `let`/`const` per-iteration bindings are untouched: the scanner skips `bodyLocalLexical` names and the
  for-head `let` pass runs first (L641-744) and marks them `boxedCaptures` → skipped at L781.
- Watch `check-loc-budget`/`check-func-budget` (helper extraction should be LOC-neutral or negative).
- No overlap with the 9-arg call fix (different files) or #6949/#6958.

### Acceptance
- `tests/issue-<id>.test.ts` (public `compile()`, `allowJs`, `skipSemanticDiagnostics`; run both
  `target: "standalone"` and gc, both `inferModuleStrictArguments` true/false): `.tmp/m4.js` → `"22,22,30,30,3,3"`,
  `.tmp/m5.js` → `"33,30,30,30,30"`, `.tmp/m3.js` → `"6,6,6,6"`; plus a post-loop read control
  (`while (k > 0) { f = function(){return k}; k--; } return k;` → `0`) and a closure-observes-final-value
  control (`fs[0]()` after the loop → final `i`, var semantics).
- Together with the 9-arg fix: `pnpm run -s benchmark:octane -- --only earley-boyer --lanes standalone --timeout 600`
  → pass. Measured with both fixes simulated at source level (`.tmp/patch-d10-simfix2.mjs`: per-iteration
  copies `k0`/`l1c` read by the inner closures): `octane_run -> 2`, `teardown ok`, ~6 s wall after a 20 s
  compile — so the Boyer half has NO further standalone blocker.
- `tests/issue-1589*`, `tests/issue-1617*`, `tests/issue-2120*`, `tests/issue-5109*` stay green (for-loop pre-box twins).

Size: **S/M** — ~40 lines moved into helpers + 2 call sites + 1 deleted guard + 1 scanner signature; step 3 ~10 lines.
