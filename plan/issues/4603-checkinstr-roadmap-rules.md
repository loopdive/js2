---
id: 4603
title: "checkInstr roadmap: implement type rules for the 17 rule-worth-adding kinds"
status: in-progress
sprint: current
created: 2026-08-21
# id 4603 reserved via claim-issue.mjs --allocate --allow-unscanned on 2026-08-21 (gh CLI offline; pr_scan=degraded). MCP open-PR scan at reservation: open PRs 4681/4682 introduce no issue ids near 4603; book's highest reservation was 4601.
# The 16 new rule arms and their two helpers live NEXT TO `checkInstr` and
# `TYPE_RULE_STATUS` for the same reason #4523 put the map there: the map and
# the switch are two halves of one contract, and a sibling module reintroduces
# the drift the default-arm backstop exists to catch. +351 lines, 0 deletions
# to existing rules.
loc-budget-allow:
  - src/ir/verify.ts
priority: medium
horizon: m
feasibility: medium
task_type: hardening
area: ir
goal: backend-agnostic-ir
related: [4523, 4070]
parent: 3518
files:
  - src/ir/verify.ts
  - tests/issue-4603-checkinstr-roadmap-rules.test.ts
  - tests/issue-4523-type-rule-coverage.test.ts
---

# #4603 — implement the 17 `rule-worth-adding` type rules

## Problem

#4523 (PR #4690) classified all 78 `IrInstr` kinds in `TYPE_RULE_STATUS` and
found **17** kinds with no type rule anywhere in `src/ir/verify.ts` and a real,
derivable one available from data already on the instruction:

`const`, `call`, `global.get`, `global.set`, `select`, `if`, `object.new`,
`closure.new`, `class.new`, `class.super_init`, `class.instanceof`,
`coerce.to_externref`, `iter.done`, `forof.vec`, `forof.iter`, `forof.string`,
`early.return`.

That bucket is the roadmap denominator, not a permanent state. Until it is
emptied, an IR producer can emit — for example — a `select` over an f64
condition, or a `class.new` with the wrong constructor arity, and the verifier
passes it through to a Wasm validation failure at instantiate time instead of
demoting the function cleanly.

The risk runs the other way too, and it is the one that governs this issue:
**a verify error demotes the function to the legacy path** (`integration.ts`
skips functions with verify errors). An over-strict rule therefore does not
fail loudly — it silently costs IR coverage. So each rule must fire only on a
*provable* contradiction, and each must be measured against a real corpus
before it lands.

## Approach

1. Derive each rule from the actual producers (`src/ir/builder.ts`,
   `src/ir/from-ast.ts`) and consumers (`src/ir/lower.ts`), not from #4523's
   skip-reason text.
2. Implement it as a `checkInstr` arm, flip its `TYPE_RULE_STATUS` entry, and
   add BOTH a positive fixture (producer-shaped IR verifies clean) and a
   negative fixture (synthetic bad IR yields that rule's exact message) — the
   #4070 method.
3. Compare carriers at `ValType.kind` level and skip whenever either side is
   unknown or not a single `val` — the conservative contract every existing
   rule in this file already uses.
4. Measure on a real corpus after each batch: the `JS2WASM_IR_POSTCLAIM_LOG`
   JSONL sink records every post-claim demotion across a whole test run, so a
   new rule firing on valid IR is directly observable.

## Results

**16 of 17 landed as `checkInstr` arms. The 17th needed no arm — it was a
misclassification.** Checked-kind count 16 → **32**; `rule-worth-adding` bucket
17 → **0**.

| kind | outcome | rule |
| --- | --- | --- |
| `const` | landed | `resultType` must match the literal's carrier (`bool` → i32, per `emitConstInstr`); reference-shaped `null`/`undefined` skipped |
| `select` | landed | condition i32; both arms agree with `resultType` |
| `if` | landed | cond i32; `thenValue`/`elseValue` agree with `resultType` (the value dual of `if.stmt`'s existing cond rule) |
| `object.new` | landed | `values` arity + per-field carrier vs `shape.fields[].type` |
| `closure.new` | landed | `captures` arity + per-capture carrier vs `captureFieldTypes` |
| `class.new` | landed | `args` arity + carriers vs `shape.constructorParams` |
| `class.super_init` | landed | same, vs `parentShape.constructorParams` |
| `class.instanceof` | landed | `resultType` must be i32 (bool) |
| `iter.done` | landed | `resultType` must be i32 (done flag) |
| `coerce.to_externref` | landed | `resultType` must be externref **or** the `callable` spelling the closure-boundary pack uses |
| `forof.vec` | landed | all five loop-state slot indices in `func.slots` bounds; `elementType` vs the vec's element type |
| `forof.iter` | landed | iter/result/element slot indices in bounds |
| `forof.string` | landed | counter/length/str/element slot indices in bounds |
| `call` | landed, **narrower than #4523 sketched** | intra-function coherence, not signature-matching — see below |
| `global.get` | landed, **narrower than #4523 sketched** | same |
| `global.set` | landed, **narrower than #4523 sketched** | same |
| `early.return` | **no arm — reclassified `checked-elsewhere`** | the rule already existed; see below |

### Two findings that changed the shape of the work

**1. `call` / `global.get` / `global.set` cannot be checked against a declared
signature — there is no declaration in scope.** #4523's skip reasons said
"vs the target's resolved signature" and "must match the global's declared
IrType". Neither record exists anywhere the verifier can reach: `IrFuncRef`
and `IrGlobalRef` carry only a debug `name` plus a structural *binding*
(`src/ir/value-references.ts`), the IR resolves both lazily at lowering, and
`IrModule` holds **only** `functions` — no globals table, no signature table.
`verifyIrFunction` takes a single `IrFunction`, which carries neither.

What *is* in scope is every other reference to the same binding in the same
function, and those must agree. So these three got an intra-function
**coherence** rule: a `call` whose arity or result carrier contradicts another
call to the same binding, or a `global.get`/`global.set` pair that disagrees on
the global's carrier, is a producer bug and is now reported. This catches the
same defect class the skip reason named, minus module-wide reach. Getting the
full rule needs a module-level declared-type table for globals and callables —
that is a separate change to the IR, not to the verifier, and is left open.

**2. `early.return` was never a gap.** `verifyIrFunction` has walked every
`early.return` since #2856 and applied exactly the rule the skip reason
described: arity vs `func.resultTypes`, then `returnTypeAssignable`. Adding a
`checkInstr` arm would have double-reported every violation, and — more
importantly — would have *lost the `demote` flag*. That flag (#3565) marks the
#1798 return-value gate as a **designed demote-to-legacy signal** rather than a
compiler invariant; a `checkInstr` arm has no way to set it, so the duplicate
would have promoted a demotion into a hard invariant. Its entry is now
`checked-elsewhere` with that reasoning recorded in place. The category count
moves 12 → 13, and the checked-kind ratchet floor moves 16 → 32 (not 33).

### Validation — no rule fires on real IR

Every measurement below was run on this branch. The instrument is
`JS2WASM_IR_POSTCLAIM_LOG=<path>`, which appends one JSONL record per
post-claim demotion (the population a new verify error would join).

| run | result |
| --- | --- |
| `check:ir-fallbacks` | OK — no unintended / post-claim / module-level increases; **0** post-claim demotions |
| `check:ir-only` | READY — both lanes 38/38 IR bodies, 0 legacy, 0 unsupported, 0 invariants |
| `check:linear-ir` | OK — compiled 8 (baseline 8), buckets unchanged |
| `tests/equivalence/` — **215 of 216 files** | **133** post-claim demotion records, **zero** carrying any new rule's message |
| IR test surface (`tests/ir-*`, `issue-3519`, `issue-4523`, `issue-4603`) | 380 passing, demotions unchanged vs the pre-change baseline |

The decisive check is the middle one. A new rule can only cost coverage by
demoting a function, and every demotion is recorded in that sink — so a rule
that never appears in 104 records over the whole equivalence corpus never
fired on valid IR.

An accidental mid-refactor window supplied the counterfactual for free: with
the arms cut out but `TYPE_RULE_STATUS` still reading `"checked"`, the #4523
`default:` backstop fired on hundreds of real corpus compiles within one shard.
The instrument does see these errors when they exist.

### Not fixed here

- **A module-level declared-type table for globals and callables.** Without
  it, `call`/`global.*` can only be checked for intra-function coherence
  (finding 1). A follow-up should decide whether `IrModule` should carry one.
- **`switch.discSlot` and `try.payloadSlot` slot-bounds**, the two residual
  gaps #4523 noted in place. They belong to kinds that already have rules and
  were deliberately outside the 17-kind denominator, so they stay open.
### Pre-existing failures confirmed by A/B, NOT caused here

Each was re-run with `origin/main`'s `src/ir/verify.ts` copied over the
branch's (the file-copy A/B pattern) and failed identically:

| test | before | after |
| --- | --- | --- |
| `tests/ir-scaffold.test.ts` — selector claims `withVar`, expectation does not list it | 1 failed | 1 failed |
| `tests/ir-bytecode-proof.test.ts` — `call` fixture with no `binding`, crashes in `lower.ts:1376` | 1 failed / 22 passed | 1 failed / 22 passed |
| the 11 `tests/equivalence/` files that failed anywhere in the shard run, re-run together | 24 failed / 102 passed | 24 failed / 102 passed |

The 11-file A/B compared the exact failure *names*, not just the counts: the
two sorted lists are byte-identical.

Two environment constraints, neither a signal about this change:
`tests/ir-bytecode-wasmgc-vm.test.ts` hit the 35 s test timeout before and
after; and several vitest workers died to a V8 heap-limit OOM (~510 MB), which
`CLAUDE.md` already documents for local full-suite runs. The OOM'd slices were
re-run file-by-file until only **one** equivalence file
(`multi-file-compilation.test.ts`) remained uncoverable on this container — it
OOMs on its own with a single worker. So 215 of 216 files were measured.
