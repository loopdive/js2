---
id: 4305
title: "RuntimeError: illegal cast — a succeeding direct eval followed by a throwing one with an `instanceof` catch traps in caller-side codegen (engine-independent)"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
assignee: ttraenkler/senior-dev
priority: high
# The fix adds three statements to `compileTryStatement` (a save call, a restore
# call, one comment): the catch parameter's ref-cell metadata must be cleared
# where the parameter's LOCAL is allocated and re-imposed where that local is
# restored, so the two sites are fixed by the shape of the surrounding function.
# All of the reasoning lives in the two module-scope helpers this delegates to.
# Splitting the 406-line function is #3399's job and is deliberately not
# attempted inside a correctness fix.
func-budget-allow:
  - src/codegen/statements/exceptions.ts::compileTryStatement
horizon: m
feasibility: medium
model: opus
reasoning_effort: high
task_type: bug
area: codegen
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4238, 4242, 4245]
# ids 4262/4263/4264/4265 were reserved and ABANDONED before this file was
# written: claim-issue.mjs --allocate resolves "main" against `origin`, which in
# this checkout is the FORK, and the fork's main was ~90 commits stale, so the
# allocator minted ids already used upstream (4262/4264/4265 all exist on main;
# true max was 4304). Fixed by fast-forwarding the fork's main to upstream and
# re-allocating -> 4305. See the "allocator reads the fork" note in #4242.
# Open-PR scan DEGRADED (no gh in this container) and GitHub code search was
# returning 503, so this id is verified against upstream main + the assignment
# ref only; the required check:issue-ids gate is the backstop.
---

# #4305 — `illegal cast` after a succeeding direct eval, when a later eval throws

## Discovered by

#4238 slice 3 (direct-eval scope snapshot). This was **unreachable before slice
3** because direct eval always returned the typed refusal, so no direct eval
ever *succeeded* and the two-eval sequence below could not occur.

## The defect

Within a single function:

1. a **direct** `eval(...)` that **succeeds**, then
2. a later `eval(...)` that **throws**, caught by a handler that does an
   `instanceof` test

traps with `RuntimeError: illegal cast`.

**It is caller-side codegen, not the eval engine.** The slice-3 author
reproduced it with a **six-line stub adapter** substituted for the real
provider — no QuickJS, no interpreter — so it is engine-independent and will
reproduce against any provider that can make a direct eval succeed.

## Why this is priority: high

It **will bite #4242's Phase-1 parity run**: the test262 harness wraps
assertions in `assert.throws(...)`-shaped code with `instanceof` catches, and
slice 3 has now made direct eval succeed under the quickjs engine, so the
precondition is satisfied across a large slice of `language/eval-code/`. A
parity measurement that trips this trap attributes engine-independent codegen
failures to the engine under test — exactly the mis-attribution #4242's gate
is designed to prevent, and it would land in the `unattributed` bucket (which
always blocks).

## Repro

The precise repro is recorded in the `## Slice 3 — implementation record`
section of `plan/issues/4238-quickjs-runtime-eval-provider-flag.md`, including
the six-line stub adapter that removes the engine from the picture.

## Acceptance criteria

- [ ] Minimal repro lifted into a permanent test (`tests/issue-4305-*.test.ts`)
      that fails on current main and passes after the fix, using the stub
      adapter so the test needs no provider artifact.
- [ ] Root cause identified in `src/codegen/` — name the cast site and why the
      value's static type diverges from its runtime type on the
      succeeded-then-threw path.
- [ ] Fix does not regress the refusal path (eval that always throws) or the
      no-eval path; default-path suites green.
- [ ] Confirm the fix under BOTH engines (`JS2WASM_EVAL_ENGINE=quickjs` and
      `TEST262_FULL_RUNTIME_EVAL=1`) — it is engine-independent, so both must
      clear.
- [ ] Re-run the scoped `language/eval-code/` measurement and record whether
      the `unattributed` bucket shrinks (#4242 gate input).

## Non-goals

- The membrane (#4245) and the parity flip (#4242) — separate issues.

## Implementation record (2026-08-09)

### Root cause — one line

`fctx.boxedCaptures` is keyed by **name** but describes one specific **slot**;
a catch clause rebinds its name to a fresh plain local without invalidating the
entry, so the catch parameter is READ through a ref-cell access shape it does
not have.

### The cast site

`src/codegen/expressions/identifiers.ts:633-661` — the identifier-read path:

```ts
const boxed = fctx.boxedCaptures?.get(name);
if (boxed) {
  fctx.body.push({ op: "local.get", index: localIdx });
  emitNullGuardedStructGet(ctx, fctx, { kind: "ref_null", typeIdx: boxed.refCellTypeIdx }, …);
```

which lowers to `any.convert_extern` + `ref.cast (ref null $cell)` +
`struct.get $cell 0`. Disassembled from a failing module, the second catch
handler reads:

```wat
(catch $tag$0
  (local.tee $197 (ref.cast (ref null $3)          ;; $3 = the direct-eval (mut externref) cell
    (any.convert_extern (local.tee $196 (pop externref)))))
  … (struct.get $3 0 (local.get $197)) …
```

`pop externref` is the **exception payload** (a `TypeError`), not a cell, so the
`ref.cast` traps: `illegal cast`. V8 reports `ref.cast`/`ref.as_non_null`
failures with that exact wording, which is why the symptom looked like a
type-system problem rather than a scoping one.

### Why the value's static type diverges from its runtime type

Three facts compose, and all three are needed:

1. `collectDirectEvalBindingNames` (`direct-eval-environment.ts:95`) counts
   **catch-clause parameters** as eval-visible bindings — correctly: eval'd code
   can name them.
2. `reifyCurrentDirectEvalBindings` promotes every such binding whose name is in
   `fctx.localMap` to a `(mut externref)` cell at each direct-eval call site, and
   records `boxedCaptures[name] = { refCellTypeIdx: <cell>, valType: externref }`.
3. A catch parameter **leaks in the flat `localMap` past its own scope** (the
   pre-existing leak the #4182 comment in `exceptions.ts` documents), so the
   promotion in (2) fires on the *previous* catch's dead slot — and the *next*
   catch of the same name then allocates a brand-new plain `externref` local via
   `allocLocal` while `boxedCaptures` still advertises the cell.

So the static type is "ref cell" (from step 2) and the runtime value is the raw
payload (from the catch prologue's `local.set`). Only a **read** of the catch
parameter observes it, which is why a catch that ignores its parameter — and
therefore, in the reported repro, the `instanceof` — looked load-bearing. It is
not: `typeof e === "object"` traps identically. `instanceof` was simply the
first thing anyone wrote that read the binding.

The "succeeded-then-threw" framing is likewise incidental. Compilation is
static, so the sequencing that matters is `catch` → direct eval → `catch`
reading its parameter. What the *runtime* eval outcome decides is merely whether
the second catch handler is entered at all: with a first eval that throws and a
second that succeeds, the trapping handler is never reached, which is exactly
why `throw`-then-`succeed` appeared to pass.

### The fix

`src/codegen/statements/exceptions.ts` — save + delete every catch-bound name's
`boxedCaptures` entry before the catch parameter's local is allocated, restore it
paired with the existing `localMap` restore.

`saveBlockScopedShadows` (`statements/shared.ts:145-147`) already does precisely
this save/delete/restore for block-scoped `let`/`const` shadows, and `loops.ts`
does it for per-iteration bindings (#1453). The catch parameter was the one
binding form that rebinds a name to a fresh slot without it.

**The restore is deliberately paired with the `localMap` restore rather than
unconditional.** The two describe the same binding and must move together:

- prior slot exists ⇒ restore both (the reported case: the prior "slot" is the
  eval-promoted cell, so the pair is consistent again after the catch);
- no prior slot ⇒ restore neither, keeping whatever the catch body established.
  This matters because a direct eval **inside** a catch body legitimately
  promotes the parameter to a cell and updates both maps; re-imposing a stale
  entry there would make a later eval site box the cell it had already made.

### Test

`tests/issue-4305-catch-param-cell-metadata.test.ts`, five cases against a
js2wasm-compiled six-line stub adapter over the frozen 4-import seam — no
provider artifact, no engine. On `main` **3 of 5 fail with `RuntimeError:
illegal cast`**; all 5 pass after the fix. The two that already passed are the
controls (no-eval; eval inside the catch body).

Notably the **refusal path was already broken** by this bug, not just the
succeeded-then-threw one: two consecutive always-refusing direct evals whose
catches both read the parameter trap on the second. Any corpus that wraps
assertions in `instanceof` catches hits it regardless of engine.

Liveness is asserted in-band — the module must carry the
`__runtime_direct_eval` import (a literal eval argument would be folded by
`tryStaticEvalInline` and prove nothing), and the expected values are only
reachable if the `[ok, value]` envelope really surfaced.

### Both engines, against the REAL seam (acceptance box 4)

The committed test is stub-linked on purpose. Separately, the same shape was run
through `selectCachedRuntimeEvalProvider()` under each engine — sources composed
at runtime (`"4"+"2"`, `"null"+".x"`), catch reads via `instanceof TypeError`:

| engine (as reported by `selection.engine`) | on `main` | with the fix |
| --- | --- | --- |
| `INTERPRETER (… TEST262_FULL_RUNTIME_EVAL=1 …)` | `RuntimeError: illegal cast` | **142** — `eval("42")` = 42, then the TypeError branch |
| `QUICKJS (artifact 21b8f62e9199, adapter key 1f0737c57ed6cfe3)` | `RuntimeError: illegal cast` | **99** — both direct evals refuse on `main` (#4238 slice 3 is not merged), so −1 + the TypeError branch |

Engine-independent, as claimed: identical trap on `main`, identical repair after,
and the quickjs column is a real-engine instance of the **refusal** path this
also broke.

### Not fixed here (deliberate)

The underlying `localMap` leak of a catch parameter past its own scope is left
alone — the #4182 comment states other resolution paths lean on it, and the
metadata pairing above is sufficient and far narrower. A general cure belongs
with proper block scoping, not a trap fix.

`scripts/equivalence-baseline.json` is untouched: the gate reports 12 baseline
entries now passing, but those come from `main`, not from this change.
