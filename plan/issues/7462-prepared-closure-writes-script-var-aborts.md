---
id: 7462
title: "Prepared path: a closure that writes a script var aborts; `new X` as a direct `+` operand refuses"
status: done
completed: 2026-11-26
created: 2026-11-23
updated: 2026-11-26
priority: medium
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7462 — Prepared path: a closure that writes a script var aborts; `new X` as a direct `+` operand refuses

## Problem

Two shapes found during #7354 G1, both present on main: (1) a closure that writes a script-level `var` (`var n = 0; var f = function(){ n++; }; f();`) ends in the run-time abort ("nondefaultable reference widening"); (2) a `new` expression used directly as an operand of `+` (`"" + new TypeError("m")`) refuses, although the same value through a variable works.

## Acceptance criteria

- Both programs give node's answer.
- Each with a wrong twin that fails.

## Implementation Plan

Revision 2 (2026-11-26), after the plan review of `95213f48894`. Measured 2026-11-26 on main `6694a8b8391` through the
strict Prepared entry (`prepared-program-required`, `standalone`, `wasmgc`), each program against `node`. Probes:
`.tmp/probe-7462*.mts`, `.tmp/prelude-sha.mts` (not committed).

### Gap 1 — a write to a script var from inside a function

**Reproduction.** The issue's "nondefaultable reference widening" does not appear; that text is a compile-time
presentation gap (`src/compiler/ir-program-presentation.ts:710`). On main each program compiles and validates; the
function's body becomes an abort body (#7354 U: the body is replaced by a trap), and `__module_init` traps
`RuntimeError: unreachable`. node returns in every row.

| Program (then `if (n !== 1) throw 1;`)                          | Abort body on main                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `var n = 0; var f = function(){ n++; }; f();` (also in a `for`)  | `ir/from-ast: increment/decrement of undeclared "n" in <module-init>__closure_0`   |
| `var n = 0; var f = function(){ n += 1; }; f();`                 | `ir/from-ast: compound assign to undeclared identifier "n" in <module-init>__closure_0` |
| `var n = 0; function g(){ n++; return; } g();` / `{ n += 1; }`   | the same two messages, `in g`                                                       |
| **1b:** `var n = 0; function g(){ n++; } g();`; `function g(){ var i = 0; i++; }` | `ir/from-ast: unsupported expression kind PostfixUnaryExpression in g` |

`n = n + 1` and `n = 1` in the closure, `n = n + 1` in `g`, a closure reading `n`, and top-level `n++` / `n += 2` all
pass.

**Root cause (1a).** A function nested in module-init, or declared at top level, does not have the script `var` in
`cx.scope`. A read falls back to the resolver (`src/ir/identifier-read.ts:58`), and so does plain `=`
(`lowerIdentifierAssignment`, `src/ir/from-ast.ts:13218-13243`). `lowerCompoundAssignment` (`13343-13349`) and
`lowerIncrementDecrement` (`13519-13525`) look only at the scope. Their `binding → capturedCell → storage` prologue
is a verbatim copy (`13343-13353` and `13519-13530`). Their `moduleGlobal` read and write code already exists.

**Root cause (1b).** A discarded `x++` that is not a statement of a statement walker reaches `lowerDiscardedExpression`
(`2651`). Three places get there: the void-tail arm (`2826-2870`), a comma, and a ternary arm. It falls through to
`lowerExpr`, which refuses updates:
- postfix: `unsupported expression kind`, `5389`;
- prefix: `value-position prefix update`, `14203`.

The statement walkers call `lowerAdoptedMutatingStatement` first (`2467`, `12696`), so they are unaffected.

**Change.**

1. **`src/ir/identifier-write.ts`** (new). It is the write twin of `identifier-read.ts` and has the same shape.
   `classifyIdentifierWrite(id, writeValue, cx)` answers:
   - `{ kind: "scope", binding }`: `cx.scope` has `id`.
   - `{ kind: "module-binding", binding }`: `resolveModuleBinding(id, writeValue)` answers.
   - `{ kind: "readonly", binding }`: readable (`resolveModuleBinding(id)`) but not writable (`(id, writeValue)`
     undefined). This is the ordinary resolver's const or representation-mismatch answer.
   - `{ kind: "undeclared" }`: nothing resolves it.

   It emits no IR. It is not throw-free: the Prepared `resolveBinding` refuses a write to an immutable binding itself
   (`src/ir/program-source-units.ts:107`, `write to immutable module binding n`), and that refusal propagates
   unchanged. This is the same contract as `classifyIdentifierRead`, which also calls the resolver and may throw. It
   performs no owner check.
2. **`src/ir/from-ast.ts`.** The callers demote exactly as today, so neither message is lost:
   - `readonly` keeps `assignment to readonly or representation-incompatible module binding`, label
     `property-write-unsupported`, for `=`. For updates it takes the same text with the update's own prefix and its
     existing label `compound-assign-unsupported`.
   - `undeclared` keeps the three existing messages.
   - One local `refuseIdentifierWrite(answer, id, what, label, cx): never` replaces the five inline `demoteToLegacy`
     calls.
3. **One storage prologue, `identifierWriteStorage(id, writeValue, cx)`.** It returns `slot | moduleGlobal |
   captured cell` and records `resolved?: ModuleBindingGlobal` when the answer came from the resolver. All three
   writers use it:
   - the compound writer passes `id.parent`;
   - the update writer passes `id.parent`;
   - `=` passes `rhs`, as today.

   With it, `lowerIdentifierAssignment`'s two near-identical module arms (the resolver arm `13219-13240` and the scope
   `moduleGlobal` arm `13249-13261`) become one arm. That arm:
   - lowers the RHS;
   - applies `boxForDynamicModuleStorage`;
   - checks `moduleStorageCompatible`;
   - calls `lowerResolvedModuleBindingTdzCheck`, only when `resolved` is set;
   - emits `global.set`.

   No fourth copy of the store sequence. The owner check runs once, inside `lowerResolvedModuleBindingTdzCheck`
   (`4889-4890`). The two separate `requireMatchingModuleBindingOwner` calls (`13222`, `13230`) go. They are
   invariant throws, so moving them does not change the bytes of any compile that succeeds.
4. **TDZ order.** An update emits the TDZ check before it reads the old value (GetValue comes first). `=` keeps it
   after the RHS. A `var` has no TDZ global, so nothing is emitted for it.
5. **No scope leak.** The string `+=` arm's `store` (`13378-13386`) and the `=` arm write `cx.scope.set(id.text, …)`
   only when the storage came from the scope. Resolver-derived storage is never cached, so every later read still goes
   through the resolver, with its TDZ and owner checks.
6. **1b, in `lowerDiscardedExpression` (the discard authority).** Split the unary half of
   `lowerAdoptedMutatingStatement` (`10921-10939`) into `lowerDiscardedUpdate(expr, cx): boolean`.
   `lowerAdoptedMutatingStatement` calls it, and `lowerDiscardedExpression` calls it before its final
   `lowerExpr`. This is byte-safe: `lowerExpr` refuses every `++`/`--`, so no compiled unit today contains a
   discarded update at that point. It covers:
   - the void tail;
   - `(n++, x);`;
   - `c ? n++ : 0;`.

   There is no `lowerTail` patch.
7. **Leave it better.** `lowerForUpdateExpr`'s identifier `++`/`--` arm (`12238-12243`) is replaced by a call to
   `lowerDiscardedUpdate`. This is byte-safe: the selector admits only identifier operands there
   (`isPhase1ForUpdateExpr`), and those go to the same `lowerIncrementDecrement`. Its `=` and compound-identifier
   arms stay. `lowerAdoptedMutatingStatement`'s compound arm also takes member and element targets, which the
   for-update selector sends to `isPhase1Expr` → `lowerExpr`; folding them would move claimed bytes. The
   moduleGlobal / slot / cell read-write triplet (about 8 copies) is folded only if the byte gates below stay
   identical. Otherwise it is filed as its own issue and linked here.

### Gap 2 — `new X(…)` directly as a `+` operand

**Reproduction.** These programs refuse at compile:
- `"" + new TypeError("m")`;
- `new TypeError("m") + ""` (`unprovable/string`);
- `"" + new Error("m")`;
- `function C(){} "" + new C()`.

The message is `ir/from-ast: '+' operands not provably both-number or string-concatenable (string/unprovable) — the
unboxed numeric-add / string-concat fast path is unsound here; demote to the SAFE dynamic '+' (emitAnyAdd) in
<module-init>`. Through a variable, both pass: `var e = new TypeError("m")` and `var c = new C()`.

**Root cause.** The carrier is the boxed dynamic value of this lane. `yieldsCarrier`
(`src/ir/analysis/carrier-expression.ts:52-70`) has no leaf for `new`, so `addsAsCarrier` →
`expressionProducesDynamic` (`from-ast.ts:14862-14891`) answers false. The checker then says `unprovable`, and
`provenAdditiveOperands` throws (`14395-14409`). The lowering already produces the carrier. `lowerNewExpression`
(`8445-8450`) sends `TypeError` (`bindingHoldsDynamic` → `readsDynamicGlobal`,
`function-object-lowering.ts:363-368`) and a top-level function value (`C`) to `dyn.construct`. This is a different
cause from gap 1.

**Change.**

1. Lift `8447-8449` into one predicate, `constructsDynamic(expr, cx)`, in `from-ast.ts`. `lowerNewExpression` uses it
   at that arm, and `dynamicLeaves` answers a new leaf with it.
2. In `carrier-expression.ts`, add `construct?: (expression: ts.NewExpression) => boolean` to `CarrierLeaves`, next to
   `call`. `leaf()` answers `ts.isNewExpression(e) && leaves.construct?.(e) === true`. The selector's leaves leave it
   unset.
3. **The earlier arms never coincide with it.** The earlier arms of `lowerNewExpression` are Promise delay, open
   carrier, wrapper, `Map` and `RegExp`. Today a user-declared constructor with one of their names does not reach any
   arm. Each refuses at compile with `ir/from-ast: unknown class "<Name>" in <module-init>`, even through a variable
   (`function Map(){} var m = new Map(); "" + m`, and likewise `Promise`, `Number`, `RegExp`; measured).
   `constructsDynamic` is false for them. The test pins these four refusals by name inside `"" + new Name()`, so a
   later slice that admits one of them must decide where it goes. No mirror of the earlier arms is added to the
   predicate, since that would duplicate the dispatch.

### Tests — `tests/issue-7462-prepared-script-var-writes.test.ts`

Reuse `runPrepared`, `abortBodies` and `yieldToRpc` (`tests/helpers/prepared-node-agreement.ts`). Each program runs
with node's answer, which must return, and with a wrong one, which must throw. `new Function(right)()` must return.

- **1a, in a closure:**
  - `n++`, `n--`, `++n`, `n += 1`, `n -= 2`;
  - `n++` in a `for` loop (3);
  - `var n = "5"` then `n++` (6);
  - `var s = "a"` then `s += "b"`.
- **1a, in `g`:** `n++; return;` and `n += 1`.
- **1b:**
  - `function g(){ n++; }`;
  - `function g(){ n -= 1; }`;
  - `(n++, 0);`;
  - `true ? n++ : 0;`.
- **2:** each program with node's string and a wrong twin:
  - `"" + new TypeError("m")`;
  - `new TypeError("m") + ""`;
  - `"" + new Error("m")`;
  - `function C(){} "" + new C()`.
- **Pinned by name.** Each name is updated by the slice that admits it:

  | Program | Expected |
  |---|---|
  | `var f = function(){ var r = n++; return r; }` | abort `unsupported expression kind PostfixUnaryExpression` (an update used as a value) |
  | `var f = function(){ function h(){ n++; } h(); }` | abort `nested func must have a return type annotation` |
  | `let n = 0; var f = function(){ n++; }` | refuses `runtime callable __new_ReferenceError needs runtime function materialization` (the TDZ guard; `n = n + 1` refuses the same on main) |
  | `const n = 0; var f = function(){ n++; }` | abort `write to immutable module binding n`, beside the checker's `Cannot assign to 'n'`; proves the update passes a write value |
  | `function g(){ m++; } g();` (no `m` anywhere) | abort `increment/decrement of undeclared "m" in g` (on main: `unsupported expression kind PostfixUnaryExpression`); no global is created |
  | `var n = 1n; function g(){ n++; } g();` (node: `2n`) | refuses `ir/from-ast: unsupported expression kind BigIntLiteral in <module-init>`. No BigInt value exists on this lane, so the update arm's `emitDynToNumber` never sees one. A slice admitting BigInt literals must make this row ToNumeric or refuse it |
  | `function Map(){}` / `Promise` / `Number` / `RegExp` with `"" + new Name()` | refuses `unknown class "Name"` |

- **Mutated twins.** Each mutation below must fail at least one test. Record the result in the PR.
  - drop the `module-binding` answer in the update storage;
  - move the TDZ check after the read (the `let` pin);
  - cache resolver storage in scope;
  - pass no write value (the `const` pin);
  - drop `lowerDiscardedUpdate` from `lowerDiscardedExpression`;
  - drop the `construct` leaf;
  - make `constructsDynamic` return false.
- **Rerun:** `tests/issue-7354-*.test.ts`, `tests/test262-prepared-*.test.ts`, `tests/issue-7338*.test.ts`.

### Measurement gates (base `6694a8b8391`, head = the PR; yield stated even when 0)

1. **The 411-row Prepared sample.** Get it from branch `origin/claude/7354-o411-sample` `155b06691f`:
   `plan/samples/7354-o411.txt` and `plan/samples/7354-tally411.mjs`. Run it on base and on head:

   `TEST262_PATH_FILTER_FILE=<abs>/7354-o411.txt TEST262_COMPILER_PATH=ir TEST262_TARGET=standalone
   COMPILER_POOL_SIZE=3 TEST262_WORKERS=3 bash scripts/run-test262-vitest.sh`, then `node 7354-tally411.mjs <jsonl in
   benchmarks/results/>`.

   Report, base and head: the pass count, and the rows whose first gap is one of the refusals above. Also run the
   mutated twins through it.
   - **BASE, measured (6694a8b8391, 2026-11-26): pass = 83 / 411.** Rows whose first gap names one of these refusals: 5,
     and none of them is expected to pass on the head:
     - 2 `'+' operands not provably … (string/unprovable)` rows have `'…' + (new RegExp("a**"))`
       (`built-ins/RegExp/S15.10.1_A1_T1`, `_T7`). `new RegExp` takes the RegExp arm, not `dyn.construct`, so the
       `construct` leaf does not fire. The other 2 `'+'` rows are not `new` operands (`addition/S11.6.1_A2.4_T4`:
       `(y = 1) + y`; `do-while/S12.6.1_A4_T4`: a `&&` chain).
     - 2 `increment/decrement of undeclared "x"` rows (`postfix-increment/S11.3.1_A2.1_T2`,
       `prefix-decrement/S11.4.5_A2.1_T2`) expect a ReferenceError for an undeclared `x`. That stays a named refusal
       (point 7).
     - 1 `unsupported expression kind PostfixUnaryExpression` row (`postfix-decrement/S11.3.2_A2.2_T1`) has
       `var y = object--`, a postfix value, which is out of scope.
   - **Expected yield on this sample: 0 (estimate from the rows above, not measured).** The slice unblocks a pattern the
     prelude and later harness code need (a closure or function updating a script var; `new` as a `+` operand). The head
     run will say whether any row's first gap moves.
2. **`npm run check:prepared-bytes`.** This is `scripts/prepared-byte-identity.mts`, 804 rows, about 45 s. Base
   measured 2026-11-26 on `6694a8b8391`: 804 lines, 745 `bytes`, 58 `refused`, 1 `threw`; output sha256 `6c9504fe8787…`.
   Run it on head and `diff` the two outputs. A row may change only where it contains one of the gap shapes (a script
   var updated inside a function, a discarded update, or `new` as a `+` operand), and every changed row is explained in
   the PR.
3. **Prelude + `assert(true);`.** Compile the runner shim, `harness/assert.js` and `harness/sta.js`
   (`tests/issue-7354-u-prelude.test.ts`'s `prelude()`) plus `assert(true);\n` with the runner options
   (`runnerOptions()` in `tests/helpers/prepared-node-agreement.ts`), then take sha256 of `result.binary`
   (`.tmp/prelude-sha.mts`). Base 2026-11-26 on `6694a8b8391`: **81,397 B, sha256 `031c67f357f6…`**. The reviewer's
   `e23f5dca…` is #7354's older base of 77,429 B and is stale on this main. If head differs, explain it. The prelude
   has updates inside functions, so head may change; each changed function is named.
4. **Ordinary pipeline:** gc and standalone binaries sha256, base vs head. Corpus:
   - the equivalence corpus;
   - `website/playground/examples/`;
   - the gap programs. These have the same IR claims on main: `irCompiledFuncs` holds no `g`, no `h` and no module
     init. The `=` chain tail `a = b = 1` is claimed (`ir=["g"]`) and must stay identical.

   Every row must be identical.

### Risks

- The ordinary pipeline never reaches the new paths: the selector refuses `module-update` / `tail-module-compound`
  (`select.ts:4614`, `6598`), and `lowerExpr` refuses discarded updates. The `construct` leaf could change a claimed
  ordinary unit on a native-dynamic lane; gate 4 catches that.
- `src/ir/from-ast.ts` is at its LOC ceiling (17,340), so it must be net ≤ 0 lines; the folded prologues and arms pay
  for the change. `lowerTail` is not touched. No budget grants.

### The `readonly` kind: measured, then dropped (2026-11-26)

The lead's rule: an arm that no caller can reach must not exist. Which paths call `classifyIdentifierWrite`, measured
with a logging copy of the head (`.tmp/instr`, not committed) over the gate-4 corpus (3,816 inputs, gc + standalone,
7,632 compiles) and over probes:

- **Ordinary pipeline.** The classifier is reached, by `=` only: 144 non-scope answers, all `module-binding` (a
  function writing a module binding, e.g. `a = b = 1` in `g`). No `readonly`, no `undeclared`, and no call from the
  compound or update writer (the selector refuses `module-update` / `tail-module-compound` in a function; in
  module-init a compound target must be in scope).
- **Why `readonly` never arrives.** Every selector arm that claims a module-binding `=` asks the same resolver with
  the value first (`moduleBindingWrite`, `moduleBindingTakes`). Probes that would produce it (a `const` written in a
  function; `let x: number` written with a string) are not claimed: `g` is absent from `irCompiledFuncs`.
- **Prepared path.** `resolveBinding` ignores the value except to refuse an immutable binding itself, so it can never
  answer "readable but not writable".

So this is neither case the lead's note anticipated: the ordinary pipeline does call the classifier, but no caller
receives `readonly`. The kind is dropped: the classifier answers `scope`, `module-binding` or `undeclared`, and the
`=` writer's old `readonly or representation-incompatible` demote (main's resolver arm) goes with it. No Prepared test
expects it (PRV-7462 note b).

### Deviations from the plan, measured

- **Pins of `function Map(){}` / `Promise` / `Number` / `RegExp`.** Inside `"" + new Name()` the refusal is the `+`
  one (`'+' operands not provably … (string/unprovable)`), on main and on the head: `constructsDynamic` is false for
  them, so the `+` check refuses before `lowerNewExpression` runs. `unknown class "Name"` is the refusal through a
  variable (`var v = new Name(); "" + v`). The test pins both.
- **#7354 H2 rows.** `function f(){ return 1; } f++;` and `f += '';` refused at the write on main (`undeclared`), as
  module-init has no scope binding for a function declaration. The update and compound writers now ask the resolver,
  as `=` does: `f++` and `f -= 1` give node's `NaN`, and `f += ''` ends at the run-time abort where `f + ''` already
  does (a function's ToPrimitive). The H2 test states these three instead of the two refusals.
- **The `const` pin.** The checker's `Cannot assign to 'n' because it is a constant.` is an error diagnostic, so the
  row compiles with it and asserts both, not through `abortBodies` (which expects no diagnostics).

### Code-quality acceptance criterion

- One write classifier, `identifier-write.ts`, in `identifier-read.ts`'s shape. One storage prologue for all three
  writers. One module store arm in `=`. One owner check. No second copy of readable → writable → owner.
- One discarded-update helper, used by the statement walker, the discard authority and the for-update clause.
- One `constructsDynamic`, used by the lowering and the leaf. One `construct` leaf. No `+` special case.
- No new demote label and no defensive branch. `from-ast.ts` net ≤ 0 lines. A fresh-context adversarial review of the
  diff and this plan, with its verdict in the PR body.

### Adversarial review

A fresh-context reviewer (Claude Opus, `claude -p`, read-only tools) was given this plan as approved (`d2f2f45a7eb`),
`git diff d2f2f45a7eb..HEAD -- src tests` and the IR code-quality rule, and asked to prove the goal was not met.
Verdict: "quality goal NOT met", on findings 1 and 2. Each finding and its resolution:

1. **should-fix, fixed.** `constructsDynamic` and its doc were inserted between `lowerNewExpression`'s doc comment and
   the function, orphaning that comment. Moved above it.
2. **should-fix, recorded.** Two mutated twins survive: the TDZ guard after the read, and caching resolver storage in
   scope. Neither is observable on any lane today. The Prepared path refuses any TDZ guard (`__new_ReferenceError`
   has no runtime function there), and the ordinary selector never sends a compound or update to a module binding.
   A cached `var` read is the same `global.get`, and after a write that passed its TDZ guard, the guard on a later
   read is redundant. The ordering and the no-cache rule stay as the plan states them, for the lane that will
   materialize the guard. See `## Result`.
3. **should-fix, evidence added.** `lowerDiscardedUpdate` in the discard authority also routes member targets
   (`o.x++`, `a[i]--`), as the statement walker already did. A claimed ordinary unit that had demoted after claim
   could now change bytes. Measured: 17 probes, base vs head, gc and standalone, `.ts` and `.js` (68 compiles). They
   cover member and element updates as a void tail, in a comma, in a conditional arm and in a for-update clause, local
   and module-binding updates in those positions, and `new` as a `+` operand. All 68 match in status, sha256 and claim
   set. Gate 4 covers the rest. The member route is recorded among the deviations above
   (`issue-7354-m-refusals` G45).
4. **should-fix, rebutted.** The `readonly` kind is dropped. This was measured (see "The `readonly` kind" above),
   and the selector sites the reviewer cited read the resolver without a value only to detect a module binding:
   - a `=` is then gated by `moduleBindingWrite` / `moduleBindingTakes`, both of which ask the resolver with the value
     (`select.ts` `moduleBindingWrite`; the for-update `=` arm; the tail, body and non-tail `=` arms through
     `moduleBindingTakes` → `moduleBindingMatches`);
   - a compound or update in a function is refused (`module-update`, `tail-module-compound`, `*-module-compound`).

   The classifier's doc comment now names `moduleBindingWrite`.
5. **nit, kept as planned.** `id.parent as ts.Expression` is the plan's write value for the compound and update
   writers. Every caller passes `expr.left` or `expr.operand` that is itself an `Identifier` (a parenthesised operand
   never reaches them), so the parent is the assignment or update. The Prepared resolver reads only that a write value
   is present, and the ordinary pipeline never asks with it.
6. **nit, rebutted.** No triplet is left for a follow-up. The eight moduleGlobal / slot / cell read and write
   triplets were all in the compound and update writers, and fold into `readStorage` / `writeStorage`. The `=`
   writer's arms each store one kind after their own type check, so they are not copies of the triplet.
7. **nit, fixed.** The `construct` leaf's comment now says why it exists.
8. **nit, recorded.** The `Map` / `Promise` / `Number` / `RegExp` pins are listed among the deviations above.

## Result

Base `6694a8b8391`, head = this branch, measured 2026-11-26.

- **Both programs give node's answer**, each with a wrong twin that throws
  (`tests/issue-7462-prepared-script-var-writes.test.ts`, 29 tests): a closure or function updating a script `var`
  (`++`/`--` both forms, `+=`, `-=`, in a loop, of a string `var`), a discarded update (void tail, comma, conditional
  arm), and `new` as a `+` operand (`TypeError`, `Error`, a function `C`). The refusals left out are pinned by name.
- **Gate 1, 411-row Prepared sample:** pass 83 → 83 (+0). No row's first gap moved (per-row compare of status and first
  error). Yield 0, as estimated.
- **Gate 2, `check:prepared-bytes`:** 804 rows (745 `bytes`, 58 `refused`, 1 `threw`), output identical to base
  (sha256 `6c9504fe8787…` both).
- **Gate 3, prelude + `assert(true);`:** 81,397 B, sha256 `031c67f357f6…`, identical to base.
- **Gate 4, ordinary pipeline:** 3,816 inputs (the equivalence corpus's compile inputs captured from its own run, the
  13 playground examples, 21 gap programs as `.js` and `.ts`), each gc and standalone: 7,632 compiles, all identical
  in status, binary sha256 and claim set (`irCompiledFuncs`, 6,379 claimed functions over 3,677 compiles). No unit's
  claim set changed. The gap programs keep main's claims (`a = b = 1` → `["g"]`; `new C()` → `["C"]`). Rerun on
  the implementation commit after the `readonly` kind was dropped: 7,632 identical again. The 68 discarded-update
  probes of review finding 3 are identical as well.
- **Mutated twins** (each run against the new test file): dropping the module-binding answer (15 fail), passing no write
  value (the `const` pin fails), dropping `lowerDiscardedUpdate` from the discard authority (6 fail), dropping the
  `construct` leaf (4 fail), `constructsDynamic` false (4 fail). Two survive, both unobservable on every lane today:
  moving the TDZ guard after the read (the Prepared path refuses any TDZ guard, as `__new_ReferenceError` has no
  runtime function there; the ordinary selector never sends an update to a module binding), and caching resolver
  storage in scope (a `var` has no TDZ global, so a cached read is the same `global.get`).
- **Suites:** the 73 files of `tests/issue-7462-*`, `tests/issue-7354-*`, `tests/test262-prepared-*` and
  `tests/issue-7338*` (one vitest invocation each): 2,251 pass, 2 fail before the fix below. `issue-7354-m-refusals`
  G45 `v.a++` now refuses at the member compound write (`compound property write on dynamic not in IR scope (f)`, the
  refusal `v.a++; return;` already gives) instead of `unsupported expression kind PostfixUnaryExpression`; its pin is
  updated (43/43). `issue-7354-o-objects` fails the same test on base (pre-existing). Related ordinary suites
  (`issue-5163`, `issue-2856`, `issue-2089`, `es5-*compound*`, `compound-assignment-*`, `ir-const-update-refusal`,
  `issue-7143-legacy-reach`, `issue-2980`, `ir-frontend-widening`): failures in `issue-2089` (2), `issue-2856` (14) and
  `issue-5163` (2) are the same tests on base. Equivalence suite: 20 failures, all in `scripts/equivalence-baseline.json`.
  The new file passes under Node 24 with `--no-experimental-wasm-legacy-eh`.
- **Size:** `src/ir/from-ast.ts` 17,340 → 17,317 lines; no budget grant.

