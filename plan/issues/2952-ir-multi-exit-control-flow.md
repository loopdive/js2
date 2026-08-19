---
id: 2952
title: "IR multi-exit control flow: labeled break/continue, switch (br_table), do-while, for-in adoption"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-07-02
updated: 2026-08-18
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: ir
language_feature: statements
goal: ir-full-coverage
related: [2949, 2135, 2134, 2856]
origin: "2026-07-02 July Fable audit §1 (all six '(future)' direct-only statement rows share one structural blocker)"
# Slices 3+4 necessarily grow the three IR core files: new statement arms
# live in the from-ast dispatchers + selector walks; the ctrlStack frames,
# switch ladder and iterClose obligation in the lowering driver — the same
# files slices 1/2 extended. All feature-intrinsic (no barrel/driver code).
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - src/ir/lower.ts
  # Slice 4's two new IR kinds (switch / labeled.block) + their walker and
  # builder arms live in the node/union + builder files by design.
  - src/ir/nodes.ts
  - src/ir/builder.ts
  # Slice 5 threads the checker-backed carrier capability from production
  # selection and pre-registers the existing #2964 runtime before lowering.
  - src/codegen/index.ts
  - src/ir/integration.ts
  - scripts/gen-ir-adoption.mjs
# The ctrlStack frames, resolveBrLabel iterClose obligation and forof.iter
# frame changes necessarily live inside the closure-based lowering driver
# (they share its emitter/resolver/slot state): +31 / +6 lines.
func-budget-allow:
  - src/ir/lower.ts::lowerIrFunctionBody
  # Slice 6a/6b: the tail-switch admission (all-clauses-terminate + default)
  # and string-literal case tests are new arms of the phase-1 expression /
  # tail walker itself (+13 lines) — they cannot live outside it.
  - src/ir/select.ts::isPhase1Expr
  - src/ir/lower.ts::emitInstrTree
  # Slice 4: renameInstrOperands legitimately grows with every new
  # buffer-bearing IR kind (+30 for the switch/labeled.block deep-rename
  # arms — same per-kind pattern as if.stmt/try). verifyBlock/walkBuffer
  # were NOT granted: the per-instr structural checks were split out into
  # `verifyInstrStructure` instead (see the slice-4 notes).
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::makeFromAstResolver
  # Slice 6c: the dynamic-move-only scan needs a LabeledStatement arm — a
  # label wraps a statement without changing its value flow, and without the
  # arm `lbl: for (var k in dyn)` fell into the conservative
  # `!subtreeTouchesDynamic` tail and was rejected as
  # `param-type-not-resolvable` BEFORE the for-in shape check ran. The arm
  # belongs in this per-statement-kind dispatcher (+8 lines incl. comment).
  - src/ir/select.ts::dynamicUsesAreMoveOnly
branch: codex/2952-acorn-for-in
---

# #2952 — six direct-only statement kinds share one structural blocker

## Problem

`plan/log/ir-adoption.md` lists SwitchStatement, BreakStatement,
ContinueStatement, DoStatement, LabeledStatement, and ForInStatement as
direct-only with "(future)" tracking — i.e. no issue. The July audit found
the shared root cause: the IR's hybrid control flow (top-level blocks with
return/br/br_if/unreachable terminators, but if/try/loop as instructions
with **nested buffers** — `forEachNestedBuffer`, `src/ir/nodes.ts:2057`)
has **no br_table and no multi-level labeled exit**. A `break lbl` from two
nested buffers deep, or a switch dispatch, cannot be expressed, so these
kinds are structurally unadoptable regardless of bucket work. Every pass
also pays a double-traversal tax (blocks + nested buffers).

Note: current fallback-bucket counts do NOT measure this (zero body-shape
rejects contain these kinds on the ratchet corpus) — this is a test262-scale
adoption blocker, not a playground-bucket one.

## Approach

Two candidate designs — pick in an architect-spec slice first:

- **A (incremental): exit-label depth on nested-buffer nodes.** Give
  `IrInstrIf`/`IrInstrLoop`/`IrInstrTryCatch` an optional label id; add
  `IrInstrBrLabel {label, depth}` + `IrInstrBrTable`; verifier rule: label
  targets must lexically enclose. Lowering maps to Wasm block/br depths
  (WasmGC and linear identically — core Wasm both).
- **B (structural): true CFG for these kinds** — larger, interacts with
  #2134 (effect model) and the passes' double-traversal tax; only if A's
  verifier rules turn out unsound for finally-interaction.

Then adopt kinds in order of test weight: do-while (rewrites to while —
cheapest), labeled break/continue, switch (br_table over dense i32 keys,
if-chain otherwise), for-in last (needs `__object_keys` iteration — pairs
with #2964).

## Acceptance criteria

- Architect spec recorded here (A vs B decision + verifier rules).
- do/labeled/switch rows move direct-only → mixed/ir-owned in
  ir-adoption.md (regenerated); claim-row-backed-by-lowering tests per kind.
- No new demote channel usage: kinds are claimed only when fully lowerable
  (capability.ts rows, not select.ts predicates — #2135 discipline).

## Implementation Plan (architect spec — 2026-07-03, sr-multiexit)

### Decision: **Design A (incremental exit-label depth), not B.**

Design B (a true multi-exit CFG for these kinds) is rejected as the primary
path. The measured shape of the IR (below) shows A is sound including the
finally-interaction case that the issue flagged as B's only justification,
and B would force the double-traversal-tax rewrite (#2134) as a prerequisite
— a far larger, higher-risk change for the same test262 yield. B stays on
the table ONLY as a fallback if a future kind needs a non-lexical exit
(none of the six do — JS `break`/`continue`/`switch` are all _lexically_
scoped, so a lexical label resolver is complete for them).

### What the IR actually is (measured, not assumed)

The IR is a **two-layer hybrid**, and the layers matter for this design:

1. **Basic-block CFG layer** — `IrBlock { instrs, terminator }` with
   `return | br | br_if | unreachable` terminators and `IrBranch{target,args}`
   block-args-as-phi. This layer ALREADY supports arbitrary forward/back
   branches between top-level blocks. `from-ast.ts` uses it for tail-position
   `if`/early-return.
2. **Nested-buffer layer** — `IrInstrIf` (short-circuit), `IrInstrWhileLoop`,
   `IrInstrForLoop`, `IrInstrForOf*`, `IrInstrTry` each carry self-contained
   `readonly IrInstr[]` buffers (`then`/`else`, `cond`/`body`/`update`,
   `catchClause.body`/`finallyBody`). The lowerer emits these to **structured
   Wasm** (`block`/`loop`/`if`/`try`) by recursion, WITHOUT touching the block
   CFG. `forEachNestedBuffer` / `mapNestedBuffers` (`nodes.ts`) are the single
   traversal/rewrite primitives; a `never`-check keeps every pass in parity.

**The structural blocker, precisely.** A loop already lowers to exactly the
frame shape break/continue need (`src/ir/lower.ts` `case "while.loop"`):

```
block            ;; Wasm depth d+1  ← `break` target
  loop           ;; Wasm depth d    ← `continue` target
    <cond>; i32.eqz; br_if 1        ;; normal exit
    <body>
    br 0                            ;; normal continue
  end
end
```

The frames exist. What is missing is any **IR instruction inside a nested
buffer that can branch to an enclosing structured frame**. A nested buffer
is emitted by recursion and does not know its own Wasm nesting depth, so a
`break` two buffers deep (e.g. inside an `if` inside the loop body) cannot
compute the relative `br` immediate. That — not the CFG layer — is the gap.

### Design A — the three pieces

**A1. Loop-carried label identity.** Add an optional `loopLabel?: IrLabelId`
to `IrInstrWhileLoop` / `IrInstrForLoop` / `IrInstrForOf*`, and a
`blockLabel?: IrLabelId` to a NEW `IrInstrLabeledBlock { kind:"labeled.block";
label; body: IrInstr[] }` used only for `LabeledStatement` wrapping a
non-loop (rare; a labeled `{ }` block that `break lbl` exits). `IrLabelId` is
a per-function-fresh branded number allocated by the builder from the source
`LabeledStatement`. Unlabeled loops carry no id; the from-ast layer
synthesises an internal id for the innermost loop so unlabeled
`break`/`continue` resolve through the same mechanism.

**A2. The branch instruction.** Add
`IrInstrBrLabel { kind:"br.label"; label: IrLabelId; mode:"break"|"continue" }`.
It is a **buffer-terminating** instruction (like `throw`): the verifier
requires it to be last in its buffer, or followed only by dead code it
prunes. NO `depth` is stored in the IR — depth is a _lowering-time_ artifact
(storing it in the IR would rot under any pass that re-nests buffers). This
is the key correction to the issue's sketch (which wrote
`IrInstrBrLabel{label, depth}`): **label is semantic, depth is derived.**

**A3. Lowering-time label→depth resolver.** Thread a `ctrlStack` through the
nested-buffer emitter in `lower.ts`. Each entry records the label(s) bound by
the Wasm frame the emitter is currently inside and its frame KIND:

```ts
type CtrlFrame =
  | { kind: "loop-block"; label: IrLabelId } // the outer `block` — break target
  | { kind: "loop-body"; label: IrLabelId } // the inner `loop`  — continue target
  | { kind: "plain" }; // if / try / labeled-block frame
```

Every structured frame the emitter opens (`block`, `loop`, `if`, `try`, and
each `catch`/`finally`) pushes one `CtrlFrame`; on close it pops. To lower
`br.label{label, mode}` the resolver scans `ctrlStack` from the top (depth 0
= innermost) and counts frames until it finds the entry matching `label` with
the frame kind the mode wants (`mode==="break"` → `loop-block`/labeled-block;
`mode==="continue"` → `loop-body`). That count is the Wasm `br` immediate.
This is O(depth) per branch, computed once at emit, and is IDENTICAL for
WasmGC and linear backends (core-Wasm `br` in both — no backend-specific
lowering, satisfying the #1852/#1527 axis rule).

**Verifier rule (A, sound — the finally caveat resolved).** `br.label` is
valid iff its `label` is bound by an enclosing loop/labeled-block **in the
same buffer nesting chain**, checked by a lexical walk that mirrors the
lowering `ctrlStack`. The finally-interaction the issue worried about is
handled WITHOUT a CFG: a `break`/`continue` that lexically crosses a `try`
with a `finallyBody` must run the finally first. Because `IrInstrTry`
lowering ALREADY inlines `finallyBody` at every abrupt-exit path (see
`nodes.ts` `IrInstrTry` doc — "inlined at every abrupt completion path"), the
resolver simply treats a crossed `finally` frame as an extra emission point:
when a `br.label` target lies OUTSIDE an enclosing `try/finally`, the lowerer
emits the finally buffer inline immediately before the `br`. This is the same
inlining the try lowering already does for normal completion — no new
control-flow machinery, which is exactly why A is sufficient and B is not
needed. (If a future construct required a finally to run on a branch that is
_not_ lexically nested — impossible for JS break/continue — only then would B
be forced.)

### Per-kind adoption order (each its own follow-up slice)

1. **do-while** — DONE this PR (slice 1). Reuses `while.loop` + `postCond`;
   needs none of A1–A3 because its body claims only the break/continue-free
   subset (same gate as the already-adopted `while`). This banks the cheapest
   row immediately and proves the selector↔lowering parity discipline.
2. **unlabeled break/continue** (A1 synth-id + A2 + A3) — unblocks the common
   loop-with-early-exit shape; by far the highest test262 weight. Selector:
   add a `break`/`continue` arm to `isPhase1BodyStatement` that accepts them
   only when an enclosing loop is in scope (track loop-depth in the walk).
3. **labeled break/continue** (A1 real ids + `labeled.block`) — extends #2 to
   named targets; `LabeledStatement` selector arm.
4. **switch** — `IrInstrSwitch { disc; cases:{test?,body}[]; default? }`
   lowering: `br_table` over dense i32 keys (fall-through = shared block
   tail), if-chain for sparse/string keys. `break` inside a case reuses the
   A2/A3 machinery targeting the switch's outer block.
5. **for-in** — last; needs `__object_keys` iteration, pairs with #2964.

Each slice flips its `ir-adoption.md` row and adds a
claim-row-backed-by-lowering test, exactly as slice 1 does here.

### Slice 1 (this PR) — do-while, implemented

- `src/ir/nodes.ts` — `IrInstrWhileLoop.postCond?: boolean` (post-test flag;
  no new kind → zero `forEachNestedBuffer`/`mapNestedBuffers`/verify/effects/
  propagate churn; every pass treats do-while as a while).
- `src/ir/builder.ts` — `emitWhileLoop({..., postCond?})`.
- `src/ir/from-ast.ts` — `lowerDoStatement` (builds a `postCond` `while.loop`),
  wired into both the top-level and body-statement dispatchers.
- `src/ir/lower.ts` — `case "while.loop"` post-test branch: emit body → cond
  → `i32.eqz; br_if 1`, then `br 0`; same `block{loop{}}` wrapper.
- `src/ir/select.ts` — `isPhase1DoStatement` (same shape rules as `while`;
  break/continue bodies rejected by `isPhase1BodyStatement`, so only the
  multi-exit-free subset is claimed — no post-claim demote).
- `plan/log/ir-adoption.md` — `DoStatement` direct-only → mixed (#2952).
- `tests/issue-2952.test.ts` — selector-claim + runtime tests, incl. the
  defining post-test semantic (`do{x++}while(false)` ⇒ 1, not 0) and the
  break-rejection boundary.

**Safety note (why sharing `while.loop` is sound).** The verifier walks a
loop's `cond` buffer before its `body` only to register `condValue`'s def
ahead of its use. A do-while body never has a cross-buffer SSA dependency on
the cond buffer (each buffer's SSA values are buffer-local; the only shared
state is outer-scope slots/locals), so the cond-first walk order is correct
for both pre-test and post-test loops. Only the lowering emission order
differs.

## Slice 2 — unlabeled break/continue, implemented (2026-07-04, fable-2952s2)

Full A1+A2+A3 machinery per the Design-A spec above, plus one discovery the
spec missed: **the loop-body statement grammar had no statement-`if` at all**
(top-level `if` uses the block-CFG layer, which nested buffers cannot reach),
so `if (c) break;` — the canonical multi-exit shape — was unclaimable without
a new void statement-if node. Slice 2 therefore ships TWO instr kinds:

- **`IrInstrBrLabel { label, mode }`** (A2) — buffer-terminating, no stored
  depth. Verifier rules: label must be bound by an enclosing loop in the same
  buffer-nesting chain (walk mirrors the lowering ctrlStack), and the instr
  must be last in its buffer (from-ast stops emitting after break/continue).
- **`IrInstrIfStmt { cond, then, else }`** — void statement-if; `else` may be
  empty (encodes as bare `if…end`). Both arms are body-statement buffers.

**A1**: `loopLabel?: IrLabelId` on `while.loop` / `for.loop` / `forof.vec` /
`forof.iter` / `forof.string`; from-ast always synthesises one per loop
(`IrFunctionBuilder.freshLoopLabel`) and threads it as `LowerCtx.loopLabel`
(innermost wins; lifted-closure ctxs are built fresh so it never crosses a
function boundary).

**A3 (the depth resolver)**: `lower.ts` keeps a `ctrlStack: CtrlFrame[]` —
one frame per structured Wasm frame the emitter opens (block/loop/if/try are
each exactly one Wasm label). `resolveBrLabel` scans from the top counting
frames until it finds `{kind: mode, label}` and emits `br <depth>`. Continue
targets per loop shape:

- pre-test `while`, `forof.iter` → the `loop` frame itself (br re-runs
  cond / `__iterator_next`);
- `for`, do-while, `forof.vec`, `forof.string` → a dedicated body-wrapping
  `block` that falls into the update / cond / counter-advance — emitted
  ONLY when `bufferHasBrLabel(body, label, "continue")` (labels are
  per-function unique, so the deep scan is exact), keeping continue-free
  loops byte-identical.
- `forof.iter` break lands exactly at the `__iterator_return` call after
  the wrapping block — spec-correct IteratorClose (§14.7.5) for free.

**Finally interaction (the reason A is sound)**: a try frame carries its
`finallyBody` while the try-body buffer is emitted; `resolveBrLabel` inlines
each crossed finally (innermost first) before the `br`, masking the frame
during its own inline so a finally never re-runs itself. The catch path's
obligation is owned by the existing inner-try wrap (its frame carries the
finally while the catch body emits). `try { break } finally { continue }`
resolves correctly by construction: the finally's `br` (continue) is emitted
before the break's `br`, which becomes dead code — ECMA-262 completion
overriding without any CFG.

**Exhaustiveness** (slice 1 dodged this via postCond; slice 2 could not) —
every switch extended: `forEachNestedBuffer` / `mapNestedBuffers` /
`directUses` (nodes.ts), `effectsOf` (br.label = full-barrier control like
throw — `effectsConflict` only consults heap/slot facets; if.stmt =
arm-buffer union) + `isSideEffecting` (both — keeps deep use-walks alive in
DCE), verify.ts `collectUses` + label-env walk, lower.ts `collectIrUses` +
`-1` use recording + `allocLocalForInstr`, monomorphize `collectUses`,
inline-small `canInline` (conservative skip) + `renameInstrOperands` (honest
deep rename), backend legality (linear allow-list — core-Wasm `br`/`if`,
backend-identical per the #1852/#1527 axis rule; bytecode stays rejected).

**Selector** (`select.ts`): `inLoop` flag threaded through
`isPhase1BodyStatement` / `isPhase1TryStatement`; loop shape-checkers pass
`true` for their bodies. New arms: statement-`if` (arms recurse as body
statements; cond is Phase-1 shape + i32/f64 at lowering — ref/string conds
demote, same discipline as loop conds per #2136) and unlabeled
break/continue (labeled → `body-labeled-break-continue`, outside a loop →
`body-break-continue-outside-loop`). Claims are backed by
`lowerBreakContinueStatement` + `lowerIfBodyStatement` — parity holds.

**Byte-inertness (measured)**: 13/13 playground examples byte-identical
(sha256) main↔branch with identical claim sets; 8 already-claimed loop
shapes (while/for/do/forof/nested/try-in-loop/forof-string) byte-identical.
Ratchet: `body-shape-rejected` 23→22 but `call-graph-closure` 10→11 — ONE
function (`joinNums` in js/algorithms.ts) reclassified because the shape
gate no longer binds on its loop-body `if`; the later call-graph gate does.
Bytes unchanged (still legacy); baseline banked in this PR.

**Deliberately NOT taken (slice-3 bank, with what slice 2 taught us)**:
labeled break/continue and switch. Labeled is NOT nearly-free: a labeled
break crossing an inner `forof.iter` must run that loop's
`__iterator_return` (the close call sits after the loop's wrapping block, so
a crossing `br` skips it) — the for-of break frame needs a finally-like
`iter.return` obligation on its CtrlFrame, exactly the mechanism the try
frames already use. That plus `labeled.block` for non-loop labels and
`IrInstrSwitch`/`br_table` are their own slice.

## Slice 3 — labeled break/continue on labeled LOOPS, implemented (2026-07-25, fable-2952)

Scope: `lbl: while/do/for/for-of` + `break lbl` / `continue lbl`, at
top-level and body-buffer statement positions, incl. multi-label
(`a: b: while`) and labels bound by loops nested inside other loop bodies.
**No new IR kind** — the design insight is that a labeled loop's label IS
the loop's existing `loopLabel`:

- **from-ast** (`lowerLabeledStatement`): pre-allocates the id and hands it
  to the loop lowerer via `cx.pendingLoopLabel` (consumed exactly once per
  loop; cleared on inner ctxs so nested unlabeled loops mint fresh ids —
  two loops sharing an id would mis-resolve). The name→id map travels on
  `cx.labelEnv`, scoped to the labeled statement's own lowering.
  `lowerBreakContinueStatement` resolves labeled forms through it and emits
  the SAME `br.label{label, mode}` as slice 2 — the A3 depth resolver,
  verifier label-env walk, `bufferHasBrLabel` continue-block scan, effects/
  DCE/monomorphize/inline handling all apply unchanged (labels were already
  semantic ids, not depths — exactly why A2 stored no depth).
- **selector** (`isPhase1LabeledStatement` + a `labels: ReadonlySet<string>`
  param threaded alongside `inLoop` through body/try/loop walks): labeled
  break/continue claimable iff the name is bound by an enclosing CLAIMED
  labeled loop. Labeled NON-loop statements (`lbl: { break lbl; }`) reject
  (`labeled-non-loop`) — they need `labeled.block`, banked for the switch
  slice (a switch `break` targets exactly that frame shape). Out-of-scope
  labels reject (`body-labeled-break-continue`, unchanged reason string).
- **lower.ts — the ONE new lowering obligation** (exactly the hazard the
  slice-2 bank predicted): a labeled branch CROSSING an inner `forof.iter`
  loop skips the loop's own `__iterator_return` call (it sits past the
  frame the br jumps over). The forof.iter break frame now carries
  `iterCloseSlot`; `resolveBrLabel` emits `local.get <iterSlot>; call
__iterator_return` for every such frame it crosses without matching.
  Scan order = inside-out, so a finally inside the for-of body inlines
  before the close and one outside inlines after — ECMA-262 §14.7.5.7
  interleaving by construction. A br that TARGETS the forof frame (break
  of the for-of itself) matches before the cross-check and lands AT the
  existing close call — no double close (tested). Unlabeled code can never
  cross a loop frame (innermost binds), so existing output is untouched.

**Byte-inertness (measured)**: all 13 `website/playground/examples` files
byte-identical (sha256) main↔branch. Ratchet unchanged (no labeled
statements in the corpus); `check:ir-fallbacks` OK.

**Pre-existing failure noted (NOT this slice)**: `tests/issue-1169n.test.ts`
"`??` with non-null lhs" fails identically on pristine main (`'??' on
non-reference lhs (f64) is not supported in IR [IR-FALLBACK]` as a hard
error instead of a demote) — reproduced byte-identically via
`.tmp/probe-1169n.mts` against `/workspace` main. Unrelated to labels.

**Remaining (slice 4+)**: `IrInstrSwitch` + `br_table` (+ `labeled.block`
for both switch-break and labeled non-loop blocks — one new-kind
exhaustiveness sweep covers both), then for-in (`__object_keys` iteration,
pairs with #2964 — deliberately split out: it is host-import/substrate
work, not control-flow, and belongs with the keys-iteration design).

## Slice 4 — switch + labeled.block, implemented (2026-07-25, fable-2952)

Two new IR kinds (the full exhaustiveness sweep this time — slice 3 needed
none):

- **`IrInstrSwitch { disc, discSlot, tests, bodies, breakLabel }`** — the
  disc is evaluated ONCE into `discSlot` (§14.12.9 step 1; slot idiom like
  forof.\*); `tests[k]` is clause k's numeric literal (null = default, any
  position); bodies lay out in source order in a block-per-case ladder so
  fallthrough is the natural block exit. Dispatch: i32.eq/f64.eq chain
  `br_if k`, no-match `br` to the default clause (or past everything);
  **br_table** for a dense-int i32 disc (span ≤ 128, ≥ 2 cases, min-bias
  via i32.sub; first-clause-wins on duplicate tests). NaN matches nothing
  and -0 === 0 under f64.eq — §7.2.16 for free. The arm is out-of-subset
  (`requireInstrSink`, same as forof.\*): allowed on the WasmGC + linear
  backends (LinearEmitter's sink IS Instr[]), rejected on porffor/bytecode.
- **`IrInstrLabeledBlock { label, body }`** — one Wasm `block` binding its
  label BREAK-ONLY; the verifier walk now carries a second `breakOnly` env
  (loop labels bind both modes; block/switch labels reject continue).
- **`br_table` got its real payload** (`{targets, defaultDepth}`) in the
  core Instr union + binary encoder + WAT printer — it had been a
  payload-less stub the encoder failed loud on (#1939); field names match
  the pre-existing depth-bump walker in codegen/statements/exceptions.ts.
- **§14.8/§14.9 split**: new `cx.breakTargetLabel` (nearest loop OR
  switch) vs `cx.loopLabel` (nearest loop). Loop lowerers set both;
  `lowerSwitchStatement` sets only the break target — so `continue`
  inside a switch crosses the switch frames to the loop, and unlabeled
  `break` in a case exits the switch. Selector mirror: a `BreakScope`
  {inSwitch, names} threaded alongside `inLoop`/`labels`.
- **Labeled statements complete**: `lbl: switch` aliases the label onto
  the switch's breakLabel (via `pendingLoopLabel`); every other labeled
  non-loop statement claims via `labeled.block`. Switch clauses admit the
  early-return arm (`case 1: return x` — a Wasm return unwinds the case
  blocks natively; barriers still bar it).
- Exhaustiveness: nodes (union/forEachNestedBuffer/mapNestedBuffers/
  directUses), effects (clause-union + isSideEffecting seed), verify
  (BOTH collectUses copies + breakOnly env + switch structural rules:
  numeric disc, parallel tests/bodies, ≤ 1 default), lower (emit arms +
  collectIrUses + recordUse −1 + allocLocalForInstr), monomorphize deep
  uses, inline-small (canInline skip + honest deep rename), legality ×3.

**Gotcha for future kinds (cost a full local run):** `verify.ts` has its
OWN local `collectUses` switch with NO exhaustiveness never-check — a
missing case falls off the end returning `undefined` and surfaces as a
runtime `TypeError: collectUses is not a function or its return value is
not iterable` at claim time, not a compile error. Candidate follow-up:
fold it onto nodes.ts `directUses` or add the never-check.

**Deliberately NOT taken before slice 5:**

- **Tail-position switch** — a function ENDING in a switch (`switch … case
0: return 1; default: return 2;` as the last statement) is a
  tail-position shape `isPhase1StatementList` doesn't claim (tails are
  return/block/if). Needs a `thenArmTerminates`-style all-paths-return
  analysis over clauses; the non-tail form (switch + trailing return)
  covers most real code.
- **String-literal case tests** — need string.eq dispatch; if-chain over
  `string.eq` is straightforward once wanted.
- **for-in** — split out because its runtime substrate pairs with #2964,
  rather than the switch/control-flow machinery.

## Slice 5 — runtime-dynamic for-in (2026-07-29)

The exact Acorn runtime-dynamic driver identified one #2952-owned residual:

```js
function hasProp(obj) {
  for (var _ in obj) return true;
  return false;
}
```

This slice claims that function without adding a new IR node:

- `for (var id in receiver)` lowers to the existing `for.loop` instruction.
- The receiver must be checker-certified `any`/`unknown` and use the non-fast
  dynamic carrier, which is already externref. Fast `$AnyValue`, typed
  object/array receivers, other head forms, any use of the enumerated head
  value, post-loop use of the `var` head, and labeled for-in remain on the
  direct path.
- Host mode calls `__for_in_keys/len/get/has`; standalone/WASI calls
  `__object_keys_forin`, `__extern_length`, `__extern_get_idx`, and
  `__extern_has`. Both are the existing #2964 ABI: snapshot ordered keys once,
  then re-check liveness immediately before each body visit.
- Runtime registration happens before Phase 3 symbolic-call resolution, so
  host import shifts and standalone helper creation cannot invalidate an
  in-flight lowered body.
- The selector capability is checker-backed and fail-closed. Bare selector
  callers must opt in explicitly; fast and unproven receivers never claim.

Exact unchanged Acorn outcome after the slice: **15/43 emitted**, the previous
14 plus `hasProp`, with **zero withdrawals**. Remaining outcomes are 18
body-shape, 3 logical-value, 2 RegExp-constructor, 2 parameter-type, 2
call-graph-closure, and 1 constructor-resolution blockers.

### #3796 integration and parity requirements

PR #3796 remains the direct-backend performance baseline; this slice does not
touch its direct codegen files. The sound named runtime-dynamic measurement is
48.970 ms/op versus Node 4.406 ms/op (11.11x), checksum 422, zero Wasm imports,
and zero reachable IR-emitted functions. The stripped measurement is
50.114 ms/op versus 4.424 ms/op (11.33x), 1,765,609 bytes.

IR retirement must preserve these direct-backend wins:

1. A switch discriminant proven to be a real f64 local skips boxing and type
   dispatch.
2. Only a twin-exclusive, unguarded trampoline may omit the
   `__current_this` frame. Guarded twins retain it because the legacy miss arm
   observes ambient `this`; retained generic-closure paths retain it too.
3. A direct trampoline may omit the argc frame only when `arguments`,
   overapplication, and parameter initializers are absent and omitted formals
   are padded.
4. The native RegExp brand arm precedes the field/user-method ladder because
   `$NativeRegExp` and user closed structs are disjoint.

## Test Results (slice 5)

- Exact unchanged Acorn outcome driver: `hasProp` flips to emitted; 15/43
  emitted total; zero withdrawals.
- `tests/issue-2952-slice5.test.ts`: 5/5 pass — fail-closed selector boundary,
  wider-head negatives, host runtime over empty/own/inherited keys, fast
  carrier pre-claim fallback, and standalone native-helper registration plus
  instantiation.
- `pnpm run typecheck`: clean.

## Test Results (slice 4)

- `tests/issue-2952-slice4.test.ts` — 27/27: selector claims (switch with
  breaks/fallthrough/returns, labeled block; negatives: non-literal test,
  string tests, `continue` against a block label), runtime semantics
  (per-case dispatch incl. non-integer/no-match, fallthrough accumulation,
  mid-position default fallthrough, no-default no-match + empty switch,
  NaN/-0 under f64.eq, clause returns, dead code after break), interplay
  (break-in-switch-in-loop exits the SWITCH, continue targets the LOOP,
  loop-in-clause break binds the loop, labeled break from a clause exits
  the outer loop, `lbl: switch` break lbl), labeled.block (break/fall/
  loop-inside-block), **dual-run legacy↔IR value equality on 5 shapes ×
  all args** (the #3566/#3567/#3568 divergence guard — each shape asserts
  the IR claim first so it can't silently compare legacy to legacy), and
  **br_table**: builder-IR i32-disc function through the REAL pipeline
  (verify → lower → encode → instantiate) asserting the br_table op is
  chosen AND dispatch/fallthrough/out-of-range/below-min all run right.
- All #2952 suites re-run together (slices 1–4 + the two linear
  control-flow suites): see final validation record below.
- `pnpm run check:ir-fallbacks` — OK (no unintended/post-claim growth).
- `npx tsc --noEmit` clean.
- **Byte-inertness**: all 13 `website/playground/examples` files sha256-
  identical main↔branch (no switches/labels in the corpus).
- **Scoped test262 sweep** (labeled/break/continue/do-while/while +
  `statements/switch`, **253 files** via `runTest262File`, main↔branch
  outcome diff): **ZERO lines** — 202 pass / 51 fail identical on both
  sides (the 51 are pre-existing on main), so the newly-IR-claimed switch
  shapes are behavior-equivalent to legacy across the whole switch dir.
- **Linear capability flip #2**: switch fallthrough (non-empty body) used
  to FAIL LOUD on linear (#1937); the ladder is core Wasm, so linear now
  compiles + runs it — probes 6/6, fail-loud tests flipped to positive
  runs in both linear suites. Final combined re-run of all six suites
  (slices 1–4 + linear break-continue + linear controlflow): **130/130**.

## Test Results (slice 3)

- `tests/issue-2952-slice3.test.ts` — 17/17: selector claims (labeled
  break/continue, multi-label, body-nested labeled loop; negatives:
  labeled non-loop block, out-of-scope label), runtime semantics (nested
  break with exact counts, continue-outer skips rest + runs update /
  re-runs while cond, do-while labeled break, multi-label `break b`
  exits the while — verified against V8, break across try/finally with
  exact finally counts, labeled break crossing for-of vec, dead code
  after labeled break), and IteratorClose (crossing break closes the
  inner iterator exactly once mid-iteration; crossing continue closes
  per outer iteration — 3 iterators/3 closes; break TARGETING the
  for-of closes exactly once — no double close).
- Slice-1/2 suites re-run: 44/44 (two slice-3-boundary negatives flipped
  to positives, as designed).
- Loop-heavy blast radius: issue-1280 / issue-2136 / issue-1169n /
  issue-1169h / issue-1182 / issue-1183 — 85/86; the 1 fail is the
  pre-existing `??` hard-error above, identical on pristine main.
- Scoped test262 sweep (labeled/break/continue/do-while/while dirs, 142
  files via `runTest262File`, main↔branch outcome diff): **ZERO lines** —
  125 pass / 17 fail identical on both sides (the 17 are pre-existing on
  main), so the newly-IR-claimed labeled shapes are behavior-equivalent
  to legacy across the whole labeled-statement surface.
- `npx tsc --noEmit` clean (pre- and post-merge of upstream/main).
- **Linear target capability flip**: the linear backend used to FAIL LOUD
  on labeled break/continue (#1937 fail-loud lists); the IR path now
  claims labeled loops and `br.label` lowers to core-Wasm `br`
  (backend-identical), so linear compiles AND runs them — verified by
  probe (4/4) and the flipped tests in `tests/linear-break-continue.test.ts`
  / `tests/linear-controlflow.test.ts` (59/59 post-flip).

## Test Results (slice 2)

- `tests/issue-2952-slice2.test.ts` — 21/21 (selector claims incl. both
  negative boundaries; runtime semantics for break/continue across all five
  loop kinds; continue-target placement incl. the for-update infinite-loop
  hazard; break/continue across try/finally with exact finally counts;
  dead-code-after-break; verifier rules via builder-constructed IR).
- `tests/issue-2952.test.ts` — 6/6 (slice-1 break-rejection test flipped to
  claim+run per the lifted boundary; labeled-break negative added).
- Loop-heavy blast radius: `issue-1280` + `issue-2136` + `issue-1169n` +
  `issue-1169h` (try) + `issue-1182`/`issue-1183` (for-of iter/string) +
  `issue-1169e-bridge` — 108/108.
- `npx tsc --noEmit` clean (pre- and post-merge of origin/main);
  `pnpm run check:ir-fallbacks` OK after bank.
- test262 loop-statement dirs (break/continue/while/do-while/for/for-of,
  **1254 files**): compile+run outcome diff main↔branch = **ZERO lines** —
  every file's CE/OK/EXN outcome identical, so the newly-IR-claimed loop
  shapes are behavior-equivalent to legacy across the whole surface.
- Standalone target (`target: "standalone"`): break / continue-with-update /
  try-finally-break probes all pass (core-Wasm `br` is backend-identical).
- Wider equivalence sweep (11 loop-relevant suites, 158 tests): 87 pass;
  all 71 fails verified PRE-EXISTING on current origin/main (70 × the
  `__unbox_number` harness import-stub gap in tests/ir-\*-equivalence — the
  same gap slice 1 documented; 1 × arguments-capture `expected 30 to be
33` in arguments-nested-and-loops) — reproduced identically on main.

## Test Results (slice 1)

- `tests/issue-2952.test.ts` — 5/5 pass (selector claim, post-test-once,
  counted bound, nested-in-while, break-rejection).
- `tests/issue-1280.test.ts` (while/for) + `tests/issue-2136.test.ts`
  (numeric-truthiness loops) + `tests/issue-1169n.test.ts` — 35/35 pass (no
  regression to existing loop adoption).
- `pnpm run check:ir-fallbacks` — OK (no unintended/post-claim bucket growth).
- `npx tsc --noEmit` — clean (no exhaustiveness breakage; shared kind).
- Pre-existing unrelated failure `tests/ir-if-else-equivalence.test.ts`
  (`env "__unbox_number" requires a callable` — a harness import-stub gap)
  confirmed identical on clean `origin/main`; not touched by this slice.

## Merge-park investigation (PR #2596, 2026-07-03, sr-multiexit-2)

PR #2596 was bot-parked (`hold` + `auto-park-bot:merge-group-failure`) after
the merge_group re-validation reported **net -4 pass (33369→33365)**, 4
regressions / 0 improvements, bucket signature `eecf8e25208aade6`, failed run
`28670066683` (`test262-sharded.yml`), js-host lane.

**Verdict: NOT a real regression — a CI shared-worker flake. The PR is
correct; no code fix needed.**

### The 4 flagged tests (all js-host lane; standalone lane = 0 regressions)

- `test/built-ins/DataView/prototype/setFloat16/length.js`
- `test/built-ins/DisposableStack/length.js`
- `test/built-ins/Promise/try/return-value.js`
- `test/built-ins/SuppressedError/newtarget-is-undefined.js`

### Why it cannot be this PR (structural)

Every line #2596 changes is guarded by `ts.isDoStatement(...)` (from-ast.ts,
select.ts) or `instr.postCond === true` (lower.ts). The non-`postCond`
`while.loop`/`for.loop` emission is byte-for-byte the original code path, and
the builder's `postCond` spread adds nothing when the flag is absent. **All 4
flagged tests contain no loops at all** (and their harness includes —
propertyHelper.js / asyncHelpers.js — contain no do-while). So none exercises
a single changed path.

### Empirical proof (see `.tmp/repro-2596.mjs`, `.tmp/run-2596.mjs`, `.tmp/dowhile-outcome.mjs`)

1. **Byte-identical wasm** for all 4 tests across three commits — merge-base
   `bc8a1d4` (pre-PR), PR-head `a53cacd0`, current `origin/main` `6b71c93`:
   `dfd62ae67a556df2` / `b8938d4451e6acec` / `0ece0241fc27df9c` /
   `1689c19edf1aef7b`. The PR does not change these tests' output; neither
   does any commit currently on main.
2. **All 4 pass in isolation** at HEAD (compile + instantiate + run test()).
3. **Real test262 runner** (`pnpm run test:262`, gc target, the same worker
   path the merge_group uses) scoped to the 4 files at HEAD: **4 pass / 4
   (100%)**.
4. **Full do-while blast radius neutral**: 113 drivable test262 do-while tests
   have _identical outcomes_ at merge-base vs HEAD (24 COMPILE_FAIL, 56 OK, 25
   WASM_EXN — all pre-existing break/continue/negative cases, unchanged). No
   do-while test's status flips, so the IR do-while lowering is
   behaviour-equivalent to the direct path and does not poison any worker.
5. **Standalone lane**: 0 regressions.

### Mechanism of the flake

The gate's baseline recorded these newer-feature tests as `pass`; the
merge_group shard recorded `fail` with a wasm_sha bookkeeping delta but the
actual compiled+run behaviour is identical and passing. These four
newer-feature tests (setFloat16 / DisposableStack / Promise.try /
SuppressedError) are exactly the kind that get collateral-failed by
shared-worker built-in poisoning (adjacent prototype-mutation tests in the
same shard fork), a known class the worker recycles for but can leak. Per
auto-park rule (c), a confirmed flake/collateral may be re-admitted.

### Recommendation

Remove the `hold` and let `auto-enqueue` re-admit #2596 (do NOT re-enqueue by
hand). No branch change is required. Escalated to the tech lead for the
label removal per auto-park protocol.

## Review (Fable, 2026-07-24)

Priority escalation recommended (2026-07-24 IR-migration review,
`plan/agent-context/fable-ir-review-2026-07-24.md` §4): this issue is on the
**critical path of #3518's R9 fail-closed flip** — a compiler that hard-fails
`switch`, labeled break/continue, and `for-in` cannot flip IR-only — yet it
is `ready`/unstarted since 2026-07-02 and is NOT in the R1–R8 dependency
spine. Its structural work (Design A: label ids on nested-buffer nodes +
`IrInstrBrLabel`/`IrInstrBrTable`) depends on neither R1 (#3520) nor R2
(#3521), so it can proceed **now, in parallel** with the spine. Note that
slices 1–2 have partially landed (unlabeled break/continue + do-while are
`mixed` in the adoption matrix); the remaining scope is labeled forms
(slice 3), `SwitchStatement`, and `ForInStatement`. Suggested first step:
the architect-spec slice picking Design A vs B, then dispatch.

## Slice 6 — Implementation Plan (fable, 2026-08-15 — IR-path-only migration session)

Slices 1–5 are merged. Live-verified residuals on main @ `7add6938`
(`src/ir/select.ts`): `shapeNo("nontail-switch")` (:3326) — a function
ENDING in a switch is still rejected; string-literal case tests still
reject (numeric-literal tests only, slice-4 note); for-in remains the
narrow slice-5 carve-out — `forin-head-value-used` (:4010),
`forin-receiver-not-dynamic-externref` (:3986), single `var` head only,
labeled for-in direct. Three sub-slices, each independently landable:

### 6a. Tail-position switch

`isPhase1StatementList` tails admit return/block/if only. Add an
all-paths-terminate analysis over switch clauses (mirror
`thenArmTerminates`): a tail switch is claimable iff every clause body
terminates (return/throw/break-to-switch-exit followed by nothing live)
and a `default` exists, OR treat no-match fallthrough as function-tail
(needs the trailing-return shape). Lower via the existing
`IrInstrSwitch` ladder — no new IR kind; the clause `return`s already
unwind natively (slice-4 evidence).

### 6b. String-literal case dispatch

`IrInstrSwitch.tests` today are numeric literals. Extend tests to carry
`{kind:"num", v} | {kind:"str", v}` (or a parallel `strTests` field —
pick whichever keeps `verifyInstrStructure` rules simplest); selector
claims a switch whose disc is string-typed and every non-default test is
a string literal. Lowering: disc into `discSlot` once, then an eq-chain
`br_if` ladder calling the existing abstract string-equality op (the
same string.eq the IR already lowers per mode — host `string_equals` /
native `__str_equals`); `br_table` never applies. Mixed numeric/string
tests reject (JS strict-equality dispatch cannot match across types
except never — actually just reject the mixed shape for now).

### 6c. For-in widening — head value used

The #2964 runtime ABI already materializes the key
(`__for_in_keys/get_idx`): the restriction is selector-side. Allow the
body to READ the head `var` (the key string, externref/host-string rep):
drop the `forin-head-value-used` rejection for read-only uses (writes to
the head stay rejected), bind the head as a loop local assigned from the
per-iteration key. Then labeled for-in: thread `pendingLoopLabel`
exactly as slice 3 did for the other loop kinds (the `for.loop` reuse
means the label machinery already exists — verify IteratorClose is N/A
for for-in, no iterator to close). Typed-receiver widening stays OUT
(fast `$AnyValue` carrier is #2949-adjacent).

### Discipline (all sub-slices)

- Selector claim ⇔ lowering capability parity (no new demote usage);
  each sub-slice flips/annotates its `ir-adoption.md` row via
  `scripts/gen-ir-adoption.mjs` + `pnpm run gen:ir-adoption`.
- Tests per sub-slice in `tests/issue-2952-slice6.test.ts`: claim +
  runtime semantics + negative boundaries + dual-run legacy↔IR equality
  (the slice-4 pattern).
- Gates: `check:ir-fallbacks` no growth; `tsc --noEmit`; scoped test262
  sweep over `language/statements/switch` + `language/statements/for-in`
  main↔branch outcome diff = zero lines.

## Slice 6 Implementation Notes (2026-08-15, fable)

All three sub-slices landed. Base `7add6938`. Residuals re-verified LIVE
before implementing — one plan detail was wrong and is corrected here:

- **6a's reject arm is `tail-unhandled`, not `nontail-switch`.** `select.ts`
  `:3326` (`shapeNo("nontail-switch")`) fires only for a switch in a NON-tail
  position whose own shape check fails — slice 4 already claims that form. A
  function ENDING in a switch never reaches it: `isPhase1StatementList` hands
  the last statement to `isPhase1Tail`, whose arms are return/block/if/throw
  (+ the void ExpressionStatement arm), so a tail switch fell off the end as
  `shapeNo("tail-unhandled", …)`. Measured with `JS2WASM_IR_SHAPE_DIAG=1`.
- 6b (`switch-case-test-nonliteral` on a `StringLiteral`) and 6c
  (`forin-head-value-used`) reproduced exactly as the plan described.

### 6a — tail-position switch

`isPhase1Tail` gained a `SwitchStatement` arm, and `lowerTail` the mirror.
**No new IR kind and no new lowering machinery**: the switch lowers through
the identical slice-4 `IrInstrSwitch` ladder; only the block TERMINATOR is
new.

Two claim paths, matching the existing `tail-if-noelse` precedent:

- **void function** → claim unconditionally (subject to the switch's own shape
  gate) and terminate `return []`. Control may legitimately fall out of the
  ladder into the implicit empty return, so no analysis is needed.
- **non-void** → `switchAllPathsTerminate` must hold, then terminate
  `unreachable` (the same terminator the throw-tail arm uses; Wasm's
  polymorphic `unreachable` satisfies the function result type).

`switchAllPathsTerminate` has exactly two obligations, both forced by §14.12
fallthrough: (1) **coverage** — a `default` must exist, else the no-match
branch jumps past the whole ladder; (2) **per-clause termination** — a clause
body either terminates (last statement return/throw, or an if/else whose arms
both do — `thenArmTerminates` reused verbatim, the same helper the
early-return rewrite uses) or is EMPTY, in which case it falls through and the
NEXT clause carries the obligation. Consequences that fall out for free and
are tested: the last clause may not be empty, and a clause ending in `break`
is not terminating — `break` exits the switch, which IS the fall-out being
rejected.

### 6b — string-literal case dispatch

**Deliberately NO new IR node, field or kind — and therefore no exhaustiveness
sweep.** The plan offered `{kind:"num"|"str"}` tests or a parallel `strTests`
field; the representation that keeps `verifyInstrStructure` simplest turned
out to be *not changing the IR at all*.

A string-tested switch computes a **dispatch INDEX** first and feeds it to the
existing numeric ladder as an i32 discriminant. `lowerStringSwitchDispatch`
emits, into the CURRENT buffer:

```
<disc>                                  ;; evaluated exactly ONCE (§14.12.9)
match := -1
if (string.eq(disc, lit[n-1])) match := n-1     ;; REVERSE source order
…
if (string.eq(disc, lit[0]))   match := 0
→ slot.read(match)                              ;; i32 discriminant
```

`tests[k]` is then simply the clause index `k` (null for `default`), so the
ladder, `br_table` fast path, fallthrough layout, `break` frame and every
verifier rule are byte-for-byte the slice-4 code. Preparation also keeps
working unchanged: the string consts and `string.eq` are ordinary IR
instructions, so mode resolution (host `string_equals` / native
`__str_equals`) and provider binding need no special case — verified running
on all three carriers (host js-string, `nativeStrings`, standalone).

**Why reverse order + unconditional writes instead of a short-circuiting
chain.** A short-circuit chain must evaluate the next comparison inside a
NESTED if-buffer, and nested buffers cannot reference the enclosing buffer's
SSA values (the slice-1 invariant). It would therefore need a string-typed
SLOT, whose ValType is mode-dependent (`(ref $AnyString)` vs externref) —
exactly the complexity this design avoids. Emitting every comparison flat in
one buffer and letting the FIRST source-order clause win by writing LAST is
observationally identical: both operands are strings, so `string.eq` is total,
pure and cannot throw, and evaluating a comparison JS would have skipped is
unobservable. First-clause-wins on duplicate literals is preserved (tested).
Cost: `n` comparisons instead of up to `n`. A short-circuiting variant is a
pure optimisation, banked.

The `-1` sentinel is outside `[0, n)`, so it reaches the no-match target
through the SAME slice-4 code — including `br_table`, whose min-biased index
goes out of range for `-1`.

**The disc-carrier gate is the load-bearing part (and the one real hazard
found).** `declaredExpressionHasExactFamily(disc, "string")` — the checker
family — is necessary but NOT sufficient: an element read off a string array
(`keys[i]`) is checker-`string` yet lowers to the externref VEC-ELEMENT
carrier (`IrType.val`), which `string.eq` cannot consume. And under IR-first
(#2138) a post-claim build throw is an `unexpected-internal-throw` INVARIANT —
a **hard compile failure**, not the "clean legacy demote" the slice-4 notes
assumed. Measured: claiming that shape turned `success=true` into
`success=false`. So `switchDiscHasIrStringCarrier` rejects it PRE-claim
(`switch-disc-not-string-carrier`), following a same-function local alias to
its initializer so `const s = keys[i]` is caught too.

That carrier gap is **pre-existing, not introduced here**: `const s = keys[i];
return s === "a";` fails identically on pristine main
(`mixed string/non-string operand for '==='`). This slice keeps the switch
ladder OUT of it rather than widening it. The from-ast mirror was also
upgraded from a bare `throw` to
`IrUnsupportedError("operand-coercion-unsupported")`, so if the selector gate
is ever out-drifted the result is a clean demote instead of a compile error.

Mixed numeric/string test sets reject (`switch-case-test-mixed`): §14.12.9
dispatch is strict equality, so a numeric test can never match a string disc,
and a mixed set would need both mechanisms in one ladder for no real benefit.

### 6c — for-in head value + labeled for-in

The #2964 ABI already wrote the enumerated key into the head slot on every
visit (slice 5 simply had no reader), so the widening is selector-side plus a
one-line binding tag:

- **Lowering**: the head binding gains `asType: { kind: "string" }` when
  `resolver.resolveString()` is `externref` — the same `asType` idiom
  `lowerForOfString` uses for its `(ref $AnyString)` element slot. Identifier
  reads then compose with the ordinary string ops (`+`, `===`, `.length`).
- **Capability**: a new `forInHeadValueIsHostString` selection option, wired
  as `!ctx.nativeStrings`. On a native-strings lane the key externref is NOT
  the string carrier, so head-value uses are refused BEFORE the claim
  (fail-closed, exactly as strict as slice 5's receiver certificate) — never
  claim-then-demote.
- **`classifyForInHeadUse`** replaces the blanket `headUsed` reject and names
  the actual blocker: `written` (assignment/`++`/`--` — the slot is re-written
  from the key each visit, so a body write would be DISCARDED rather than
  carried, which is not `var` semantics), `captured` (a closure over the head
  needs the ref-cell capture path), `redeclared` (an occurrence may not refer
  to the head at all). The `forin-head-value-used` reason string is retained
  for the not-capable case so the existing bucket name is stable.

**Labeled for-in** needed three edits, one of which the plan did not
anticipate. `for.loop` reuse means `pendingLoopLabel` → the loop's own
`loopLabel` already works, and there is no iterator, so the slice-3
`iterCloseSlot` obligation is N/A. But `lbl: for (var k in dyn)` was rejected
with **`param-type-not-resolvable`** — a gate that runs BEFORE the for-in
shape check — because `dynamicUsesAreMoveOnly`'s `scanStmt` had no
`LabeledStatement` arm and fell into the conservative `!subtreeTouchesDynamic`
tail. A label wraps a statement without changing its value flow, so the arm
just recurses.

### Descoped (deliberate)

- **Typed / fast-carrier for-in receivers** — out of scope per the plan
  (`$AnyValue` is #2949-adjacent).
- **Short-circuiting string dispatch** — see the WHY above; the flat form is
  semantically exact, the chain is a pure optimisation.
- **String discs that are indexed reads** (`switch (keys[i])`) — blocked by the
  pre-existing `IrType.val` vec-element carrier gap, which is a
  string-representation issue, not a control-flow one. Worth its own issue.
- **A `switch` inside a clause as the termination proof** — `thenArmTerminates`
  covers return/throw/block/if-else only; a nested all-terminating switch
  rejects. Rare; no new machinery spent on it.

## Test Results (slice 6)

- **`tests/issue-2952-slice6.test.ts` — 44/44.** 6a: selector claims (tail
  all-return + default, empty-clause fallthrough, terminating if/else clause,
  void tail switch), negatives (no default, clause ending in `break`, empty
  last clause, empty switch), runtime semantics (dispatch/fallthrough/default,
  NaN and `-0` under f64.eq, void tail), dual-run ×4. 6b: claims (string tests,
  tail string switch), negatives (MIXED numeric/string, non-literal test,
  vec-element-carrier disc asserted against the REAL checker-backed compile),
  runtime (per-clause dispatch, strict equality, duplicate literals
  first-wins, mid-position default fallthrough, all three string carriers),
  dual-run ×5 over 7 args. 6c: claims (head read, labeled for-in), negatives
  (head written / captured / redeclared, native-strings lane, unproven
  receiver), runtime (key concat over empty/own/inherited, `=== "a"`,
  `.length`, labeled `break lbl` / `continue lbl`), dual-run ×6 over 4
  receivers. Every dual-run asserts the IR claim FIRST so it can never compare
  legacy to legacy.
- **All #2952 suites + both linear control-flow suites re-run together:
  180/180.** One slice-4 boundary test was deliberately FLIPPED
  (`does NOT claim a switch with string case tests` → claims, per 6b) and
  replaced with the boundary that actually remains (mixed numeric/string sets).
- **Scoped test262 outcome diff, main↔branch: ZERO flips / 133 files** —
  `language/statements/for-in` (86) + `language/statements/switch` (47), run
  via `runTest262File`. Identical on both sides: 83 pass / 46 fail / 4
  compile_error (all pre-existing on main).
  - Harness note: a single long-lived sweep process starts throwing `EISDIR`
    out of `test262-original-harness.ts`'s loader after a handful of files
    (`harnessSource("assert.js")` — an environment artifact; every affected
    file passes in isolation). Chunking the sweep to 4 files per process, then
    re-running the last 3 stragglers one-per-process, resolved all 133 on both
    sides. Not a compiler signal, but it silently ate 84/133 files on the first
    attempt, so future scoped sweeps should chunk.
- **Byte-inertness**: all 13 `website/playground/examples` compile to
  sha256-identical binaries main↔branch (the corpus has no switch/for-in
  shapes this slice touches).
- `pnpm run check:ir-fallbacks` — OK (no unintended / **post-claim** /
  module-level growth).
- `pnpm run check:ir-only` — single-host lane **READY**, 37/37 emitted, 0
  unsupported, 0 invariants.
- `npm run typecheck` (the real gate, `tsconfig.ts7.json`) — clean. A bare
  `npx tsc --noEmit` reports only pre-existing `Cannot find name 'process'`
  @types/node noise, present on unmodified files too.
