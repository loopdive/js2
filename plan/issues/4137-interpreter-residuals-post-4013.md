---
id: 4137
title: "standalone interpreter residuals after #4013: `SyntaxError: NaN` (36), a null-deref in setEvalVariableEnvironmentBinding (16), Phase-1 emitter gaps (22)"
status: in-progress
assignee: ttraenkler/L3-annexb-hoisting
sprint: current
created: 2026-08-03
updated: 2026-08-08
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: eval
goal: standalone-mode
related: [1781, 2200, 2928, 2929, 4013, 4023, 4131, 4162]
origin: "2026-08-03 delta /harvest-errors, baselines 2090e7bfd342 (gitHash b65d2f5a, 13:19Z standalone); oracle v12/honest"
# (#4137 arm 2) The CatchParameter's Environment Record has to be pushed inside
# `emitTry`, which lives in the interpreter's single emitter god-file. There is
# no subsystem module to move a try-clause emission into without inventing one,
# and the scope markers it needs (`SIMPLE_CATCH_SCOPE_LABEL`, `scopeBindsName`)
# are read by five other emit sites in the same file. +60 LOC is the fix plus
# the B.3.5 exemption rationale, not barrel spill; `isActiveBlockLexical` /
# `cancelsAnnexBVarBinding` were folded into one scan to hold it down.
# (#4137 arm 1, Layer 2) +6 lines in operator-assignment.ts and every one of
# them is comment. The code change is a single gate condition; the comment is
# the load-bearing part, because the ORIGINAL comment on that gate asserted the
# opposite ("the AnyValue infrastructure already round-trips any += number") and
# that assertion is what kept the bug alive — true for numbers, false for
# runtime strings. Without a recorded reason the next reader re-narrows the gate
# to `anyValueTypeIdx < 0` and every compiled-acorn SyntaxError goes back to
# rendering as `NaN`. The file already has a documented history of subtle
# mode-coupling (#1999, #2058, #3039); no subsystem module exists to move one
# boolean into.
loc-budget-allow:
  - src/interp/emitter.ts
  - src/codegen/expressions/operator-assignment.ts
# func-budget: compileCompoundAssignment grew +6 (504 > 498) — the A2 gate
# widening plus its load-bearing rationale comment (the LOC allowance above
# already covers the identical change; the per-function ratchet fires on it
# too). Recorded here because this issue owns the edit: the gate is
# change-set-scoped against merge-base(origin), so the grant travels with the
# commit that grew the function, not with the change-sets that ship it.
func-budget-allow:
  - src/codegen/expressions/operator-assignment.ts::compileCompoundAssignment
---

# #4137 — the residual tail of the newly-linked standalone interpreter

## TL;DR

PR #4013 made CI's standalone shards link the **real** runtime-eval provider
(previously the refusal provider), which retired the entire
`dynamic code evaluation is not supported` / `dynamic eval is not supported in
standalone mode` refusal family — **559 records → 0** — and turned **343 of
those 559 into passes**. Of the 216 that still fail, three signatures are
**new**, produced by the interpreter itself rather than by the code under test.
They total **74 records** and did not exist at any earlier baseline.

| signature | records | category |
| --- | ---: | --- |
| `SyntaxError: NaN` | 36 (24 annexB, 12 standard) | `syntax_error` |
| `dereferencing a null pointer [in setEvalVariableEnvironmentBinding() ← callBuiltin ← run ← interpEnter]` | 16 | `null_deref` |
| `Error: interp/emitter: unsupported in Phase 1: …` | 22 | `other` |

**Prior art — read before starting.** Two of the three are already recorded
somewhere; this issue exists to give them a **published-baseline count** and an
owner, not to claim discovery:

- `SyntaxError: NaN` is recorded in **#2928** (line ~593) as an
  "error-message rendering defect in the thrown path", measured at **8** files in
  a local interpreter run. It is **36** in the published CI lane now that #4013
  links the real provider.
- The null-deref arm overlaps **#4131**'s recorded residual and **open PR #4077**
  (`codex/2929-annexb-init-update`, "five `existing-var-update` files became null
  dereferences"). **The frame differs**: #4131/#4077 cite
  `dereferencing a null pointer in __module_init()`, these 16 cite
  `setEvalVariableEnvironmentBinding() ← callBuiltin ← run ← interpEnter`.
  Confirm whether #4077 closes them before doing any work here.

## 1. `SyntaxError: NaN` — 36 records

The message is the *number* `NaN`, not a diagnostic. Whatever formats this error
is interpolating an unresolved position/offset instead of a message. Two things
are wrong and they are separable:

- **The text is unusable.** No test, triager or bucketing script can act on it,
  and it collapses 36 distinct causes into one opaque bucket.
- **It is thrown on `skip-early-err` tests**, i.e. tests whose whole point is
  that an early error must *not* be raised at that point. Samples:
  - `test/annexB/language/eval-code/indirect/global-if-decl-else-stmt-eval-global-skip-early-err-try.js`
  - `test/annexB/language/eval-code/direct/func-if-decl-else-decl-a-eval-func-skip-early-err-try.js`
  - `test/language/expressions/class/elements/arrow-body-derived-cls-direct-eval-contains-superproperty-1.js`

Fix the message first — the second half cannot be diagnosed while the diagnostic
is `NaN`.

## 2. Null-deref in `setEvalVariableEnvironmentBinding()` — 16 records

A hard crash inside the interpreter's var-environment binding path, all on
annexB eval-code:

- `test/annexB/language/eval-code/direct/global-if-decl-else-decl-b-eval-global-init.js`

This overlaps the residuals already recorded on **#4131** (annexB
existing-var-update). #4131 is merged; confirm whether this crash is one of its
two recorded residuals or a third, distinct one before starting.

## 3. `interp/emitter: unsupported in Phase 1` — 22 records

Honest refusals, listed for the Phase-2 scope of #2928:

| unsupported construct | records |
| --- | ---: |
| regex literal | 13 |
| class method key `PrivateIdentifier` | 4 |
| class element `PropertyDefinition` | 3 |
| expression `TaggedTemplateExpression` | 1 |
| binary operator `\|` | 1 |

`binary operator '|'` is the odd one out — a single missing bitwise op in an
otherwise-complete expression emitter is a one-line gap, not a phase boundary.

## Context: what the interpreter bought

Disposition of the 559 previously-refused records at the new baseline:

| | records |
| --- | ---: |
| now `pass` | 343 (61.4 %) |
| still failing | 216 (38.6 %) |

Restricted to the **ES5+untagged goal scope** (8,648 files, `scope_official` ∧
(`es5id` ∨ no edition id), intersected across both lanes): the dynamic-code
exclusion set was **147** files, of which **74 now pass and 73 still fail**.

---

## Work log — 2026-08-06, L3 (annexB B.3.3 lever)

Two of the three arms are fixed and measured. The third (`SyntaxError: NaN`) is
diagnosed to a reproducible pair of probe files but deliberately **not** fixed
here; see below for why and for the handoff.

### Instrument (read this before trusting or reproducing any number)

`tests/test262-runner.ts`'s in-process `runTest262File` **does not attach the
`js2wasm:runtime-eval` provider namespace**, so on the standalone lane every
eval-mentioning module fails to instantiate with
`Import "js2wasm:runtime-eval": module is not an object or function`. On this
185-file lever that was 81 files of pure instrument artifact. The authoritative
oracle is `scripts/test262-worker.mjs` (what `tests/test262-shared.ts` drives and
what produces the baselines). Filed separately as **#4162**; three agents hit it
independently the same day.

The harness used for every number below mirrors test262-shared's normal path:
`CompilerPool(n, "unified")` + `assembleOriginalHarness` + strict rerun. Build
order matters and is not optional:

1. `esbuild src/index.ts → scripts/compiler-bundle.mjs` **and**
   `esbuild src/runtime.ts → scripts/runtime-bundle.mjs`
   (`scripts/run-test262-vitest.sh:173-176` — *not* `compiler-bundle-entry.ts`).
2. `node scripts/build-runtime-eval-provider.mjs` — **after** step 1, because the
   provider cache key folds in the compiler-bundle hash. ~2 min, and it must be
   redone after every source change being A/B'd.
3. Run with `TEST262_FULL_RUNTIME_EVAL=1`. Without it you silently get the
   REFUSAL tier and every eval test reports
   `TypeError: dynamic code evaluation is not supported` — a different, equally
   fake signature.

Instrument responsiveness was confirmed, not assumed: the baseline run's error
histogram reproduces the published one term for term (27/24/24/16/15/13…), and
the score moved 0 → 16 → 40 in step with the two source changes, with the
flipped files matching the predicted buckets exactly.

### Measured

Population: the 185 standalone ES5-label failures under
`annexB/language/{global-code,function-code,eval-code}` (2026-08-06 baseline).

| build | pass / 185 | delta | regressions |
| --- | ---: | ---: | ---: |
| `origin/main` (176e4408f) | 0 | — | — |
| + WeakMap-miss fix | 16 | **+16** | 0 |
| + catch-parameter Environment Record | 40 | **+24** | 0 |

### 1. Null-deref in `setEvalVariableEnvironmentBinding` — FIXED (+16)

Not a #4131 residual and not an Annex B semantics gap. It is a **standalone ABI
mismatch**: a `Map`/`WeakMap` miss whose value type is a **class** reads back as
`null`, not `undefined`, because the nullable class reference has no distinct
`undefined` representation. Measured directly (`.tmp/probe/wm.ts`,
`.tmp/probe/wm2.ts`):

| expression | standalone result |
| --- | --- |
| `WeakMap.get(missing) === null` evaluated **inline** | `false` |
| `const v = WeakMap.get(missing); v === null` | **`true`** |
| `typeof WeakMap.get(missing) === "undefined"` inline | `true` |

So the coercion happens **at the local store** — precisely where an absence test
reads it. `setEvalVariableEnvironmentBinding` tested `existing !== undefined`
only; the miss passed the guard and `setOwnEnvironmentBinding` dereferenced it.

`variableEnvironmentFor` had the same shape with a *different* consequence — it
returned the miss rather than continuing the parent walk, truncating the chain at
the first unregistered record. Fixed alongside. **It is not what moved the
number**: the 24 `binding value is updated following evaluation` failures I
expected it to fix stayed at 24 until the catch fix landed. Stated because a
plausible-but-wrong attribution is worth recording.

`src/interp` has ~30 further `x !== undefined` / `x === undefined` absence tests;
the ones whose value type is a class (several `INTERP_BINDINGS.get(...)` reads in
`loop.ts`) carry the same latent hazard. Not swept here — each needs its own
reachability argument, and this issue's arm is closed.

### 2. `binding value is updated following evaluation` (24) — FIXED

Root cause is in the interpreter's **emitter**, not in Annex B. `emitTry` bound
the CatchParameter with `bind()`, which writes into `names` — a flat,
function-wide name→register map **with no pop**. §14.15.3 gives the parameter its
own declarative Environment Record, so `catch (f)` shadowed `f` for the entire
rest of the body: every name resolution emitted *after* the clause read the catch
register. That is why the family's `before` assertion passed (emitted before the
clause, resolves to the eval var cell) while `after` read the caught value:

```js
// annexB/language/eval-code/**/*-no-skip-try — 24 files, one shape
var before = typeof f;                                   // "undefined"  ok
try { throw null; } catch (f) { { function f(){ return 123; } } }
var after  = typeof f;                                   // want "function", got "object"
                                                         //   ^ the caught `null`
```

Fix: route the parameter through the lexical-scope machinery blocks already use
(`BUILTIN_PUSH_LEXICAL_ENV` + control-stack marker + `RESTORE_ENV`), so
`emitLoadName` / `storeName` / `initializeName` and the `typeof` fast path all see
it via `isActiveBlockLexical` and stop seeing it when the clause ends.

**The wrinkle, and the reason for a second scope label.** Making the parameter an
ordinary block lexical *cancels* Annex B — and measurably did: the intermediate
build scored `run = 1` on the repro (null leak gone, function never assigned).
B.3.5 **exempts a simple `CatchParameter: BindingIdentifier`**; only a
destructuring parameter cancels, and `emitTry` rejects those earlier.
`SIMPLE_CATCH_SCOPE_LABEL` marks the scope so `isActiveBlockLexical` (name
resolution) counts it while `cancelsAnnexBVarBinding` (the two Annex B sites, in
`emitBlock` and the switch emitter) does not.

Side effects, all in the correct direction: `boundNames` no longer gains a
permanent entry for the parameter (which is what kept `typeof f` on the stale
register), and a closure declared inside a catch block can now see the parameter
at all — previously it could not, since registers are frame slots invisible to a
nested `FunctionEmitter`.

### 3. `SyntaxError: NaN` (24 here / 36 published) — DIAGNOSED, NOT FIXED

**It is Acorn's `pp.raise` message, and the "NaN" is a `number`.** Proof, in
three independent steps:

1. `acorn.mjs:3756` is `message += " (" + loc.line + ":" + loc.column + ")"`.
2. Take a program where **node-acorn genuinely raises**:
   `eval("try { throw {}; } catch (f) { function f() {} }")`. Node reports
   `Identifier 'f' has already been declared (1:39)`. The standalone interpreter
   reports message `"NaN"` exactly (`.tmp/probe/acornraise.ts`).
3. The shape reproduces standalone with no eval at all: `.tmp/probe/pa10.ts`
   returns `viaLength = 3` (`"NaN".length`) and `viaTypeof = 2` (number).

**Why it is not fixed here, stated plainly:**

- It is a **codegen** bug (`any`-typed compound `+`), not an interpreter bug, so
  it does not belong in this issue's `src/interp` change and lands in
  `src/codegen/expressions/operator-assignment.ts` — concurrently owned by
  another lane today.
- It is **context-sensitive, not a flat rule**, and anyone who assumes otherwise
  will conclude the bug does not exist. The near-identical `.tmp/probe/pa9.ts`
  compiles **correctly** while `.tmp/probe/pa10.ts` does not; the only difference
  is surrounding call sites. Whole-program parameter inference is deciding a
  numeric lowering for `message`. **That probe pair is the diagnostic** — start
  from it.
- **Fixing the message will not, on its own, flip these 24 tests.** They are the
  `skip-early-err` family, whose point is that an early error must *not* be
  raised. node-acorn does **not** raise on their actual shape
  (`catch ({ f }) { if (true) function f(){} }` parses fine), yet compiled-acorn
  does. So there is a **second, separate** defect in compiled-acorn's scope
  tracking underneath the unreadable message. #4137 already says "fix the message
  first — the second half cannot be diagnosed while the diagnostic is `NaN`";
  that ordering is confirmed, and the second half is real.

### Also refuted / worth knowing

- **`typeof` and `===` against a string literal are unreliable when applied to an
  `any` holding a freshly-built native string.** An earlier probe of mine
  (`.tmp/probe/plusassign2.ts`) "showed" that `any += stringLiteral` works and
  `any += <concat>` does not; re-measured through `String(...)` the distinction
  partly dissolved. Do not size the `+=` bug from `typeof`-based probes.
- The 15 `Initialized binding created prior to evaluation` failures are the
  **AOT** twins of arm 2 (`function-code/*-no-skip-try`), not interpreter
  failures. They need #2200 Phase 2 (`annexBOuterBindings`) plus B.3.5, whose last
  attempt (#1769) cost −1180 net. Explicitly out of scope here.

## Acceptance criteria (updated)

- [x] `SyntaxError: NaN` never reaches a test result — **fixed 2026-08-08**
      (Layer 2, `operator-assignment.ts` gate). The bucket goes 24 → 0 on the
      scoped standalone lane and renders `SyntaxError: Binding rvalue (1:266/288)`.
      The remaining verdict-flipping half is #4194 (Layer 1), by design.
- [x] The `setEvalVariableEnvironmentBinding` null-deref is fixed — and it is
      **not** a #4131 residual; it is a standalone null-vs-undefined ABI bug.
- [x] Each `interp/emitter` Phase-1 gap is either implemented or listed in
      #2928's Phase-2 scope with a count — bitwise (`\|`/`&`/`^`/`>>>`) and regex
      literals implemented; PrivateIdentifier (4) / PropertyDefinition (3) /
      TaggedTemplateExpression (1) listed in #2928 with counts.
- [x] Re-measured, with counts: 0 → 40 of 185, 0 regressions (table above);
      and 442/469 → 442/469 with 0 fail→pass / 0 pass→fail for this session
      (2026-08-08 work log).

---

## Implementation Plan (arch, 2026-08-08)

### (a) Arm-by-arm status — verified against `origin/main` (e738507f era)

| arm | status | evidence |
| --- | --- | --- |
| 2. `setEvalVariableEnvironmentBinding` null-deref (16) | **LANDED** | PR #4139 merged `c5e7d6a3`; commit `95d2b82a`. Fix present on main: `src/interp/eval-environment.ts:391-396` (`existing !== null` guard) and the `variableEnvironmentFor` parent-walk continuation at `:75`. |
| 2b. Catch-parameter Environment Record (24) | **LANDED** | Same PR, commit `a751e10b` (`SIMPLE_CATCH_SCOPE_LABEL`, B.3.5 exemption). `tests/issue-4137-interp-catch-scope.test.ts` on main. |
| 1. `SyntaxError: NaN` (36) | **OPEN** — and re-diagnosed by #4194 | The verdict-flipping half is NOT this issue's; see below. The rendering half is a real, unowned codegen defect specced here. |
| 3. Phase-1 emitter gaps (22) | **OPEN** | All five refusal buckets unchanged in `src/interp/emitter.ts`; no commits touched the file since PR #4139. |

### (b) Arm 1 — `SyntaxError: NaN` (36 records): split into three layers, only ONE is this issue's

**Read `plan/issues/4194-standalone-instance-expando-substrate-breaks-compiled-acorn.md` first.** It corrects this issue's earlier diagnosis:

- **Layer 1 (verdict-flipping, NOT here):** the raise itself is *spurious* — acorn's `copyNode` for-in enumerates zero keys on a standalone class instance, so `checkLValPattern` sees a blank node and raises on every object-destructuring shorthand (`catch ({ f })`, `var { a } = {}`). That is #4194 (status: ready, priority: high, feasibility: hard). **Do not duplicate it here.** All 24 annexB `skip-early-err` records and (probably) the 12 class-family records flip only via #4194's stack.
- **Layer 2 (this issue): the message renders as the number `NaN`.**

  **Root cause (verified in source):** `compileCompoundAssignment` in `src/codegen/expressions/operator-assignment.ts` gates the #2058 runtime-string `any +=` recovery on **`ctx.anyValueTypeIdx < 0`** (line **1722**: `if (op === PlusEqualsToken && !fctx.boxedCaptures?.has(name) && ctx.anyValueTypeIdx < 0)`). The runtime-eval provider is a huge `any`-typed program, so `ensureAnyValueType` (`src/codegen/any-helpers.ts:27-29`) has registered `$AnyValue` long before acorn's `pp.raise` compiles → the gate fails → `message += " (" + …` falls through to the numeric compound path (line ~1898 onward), which ToNumber-coerces both sides → `f64` NaN. The gate's own comment claims "the AnyValue infrastructure already round-trips `any += number` through the existing numeric path" — true for numbers, **false for runtime strings**.

  The exclusion exists because `__host_add` is not part of the fast-mode ABI — but the **standalone** lane doesn't use `__host_add` at all: `emitAnyAddFromExternTemps` (`src/codegen/binary-ops.ts:2354`, standalone branch at `:2360`+) already has the host-free tag-dispatch concat/add.

  **Fix design:** widen the gate to `(ctx.anyValueTypeIdx < 0 || ctx.standalone === true)` (WASI too if `emitAnyAdd`'s `noJsHost` covers it — it tests `ctx.standalone === true || ctx.wasi === true`, so match that). Then verify `compileAnyCompoundAdd` (line **1040**) writes back correctly when the binding's storage type is `ref_null $AnyValue` rather than `externref`: its store path calls `coerceType(ctx, fctx, {externref}, localType)` (lines 1064-1083) — confirm `type-coercion.ts`'s externref→AnyValue arm (~line 2355) handles this; if not, add that coercion leg, not a new path.

- **The probe pair IS the acceptance test — run BOTH.** `.tmp/probe/pa9.ts` / `pa10.ts` (reproduced verbatim in `plan/agent-context/L3-annexb-hoisting.md`). The bug is context-sensitive: whole-program parameter inference makes the single-call-site probe (`pa9`) compile correctly while the four-call-site twin (`pa10`) mis-lowers. A fix validated on only one of them proves nothing. Compile with `target: "standalone", skipSemanticDiagnostics: true, inferModuleStrictArguments: false`. Success = `pa10.viaLength() === 10` and `pa9` still correct.

- **Layer 3 (`err.pos === NaN`) — hypothesis, needs one discriminating probe.** #4194 observed `err.pos = NaN` and inferred "something numerifies both operands". Leading hypothesis from #4194's own data: acorn's `err.pos = pos` is a **dynamic expando write on a SyntaxError instance**, which standalone currently **drops** (#4194's `readsBack = 101` row); the read-back is `undefined`, and the *harness/consumer* numerifies `undefined → NaN` at the read. Probe: in the provider lane, catch a genuine syntax error and report `typeof err.pos` — `"undefined"` confirms this is #4194's write half (no third defect; nothing more to do here), `"number"` means a real second numerification path exists and needs its own diagnosis. Record the outcome in this file either way.

**Expected flips from Layer 2 alone: ZERO.** This is a diagnostic-quality fix (unblocks all future compiled-acorn triage), already stated twice in this file. Do not sell it as a conformance delta.

**Ownership caution:** `operator-assignment.ts` was concurrently owned by another lane on 2026-08-06. Before dispatch, check `origin/issue-assignments` and open PRs touching this file; the prescribed diff is one gate condition + at most one coercion leg — keep it that small.

### (b) Arm 3 — Phase-1 emitter gaps (22 records)

Published buckets: regex literal **13** · class method key `PrivateIdentifier` **4** · class element `PropertyDefinition` **3** · `TaggedTemplateExpression` **1** · binary `|` **1**.

#### C1 — bitwise binary operators (implement; covers the `|` record + the compound forms for free)

- **Root cause:** `binaryOpcode` (`src/interp/emitter.ts:1713-1744`) returns −1 for `|`/`&`/`^`/`>>>` (`default` comment at line 1742 names them as Phase-1 out of scope). The same table drives compound assignment (`emitAssign`, line 1571-1573), so `|=`/`&=`/`^=`/`>>>=` currently refuse too.
- **Fix — follow the #4013 Shl/Shr precedent exactly (all four files, append-only):**
  1. `src/interp/opcodes.ts`: append `BitOr: 45, BitAnd: 46, BitXor: 47, ShrU: 48` after `Shr: 44` (line 102); bump `OP_COUNT` 45 → **49** (line 106); append four `{ name, form: OperandForm.RegA }` rows to `OP_INFO` after index 44 (line 240). **Never renumber** (file header, lines 29-30).
  2. `src/interp/runtime-ops.ts`: add `anyBitOr/anyBitAnd/anyBitXor/anyShrU` next to `anyShl`/`anyShr` (lines 46-51) — bodies are the plain native ops (`a | b`, `a & b`, `a ^ b`, `a >>> b`), which is what makes the value bridge free in both lanes (file header contract).
  3. `src/interp/loop.ts`: four `case Op.BitOr: acc = anyBitOr(regs[a], acc); break;` arms next to `Op.Shl`/`Op.Shr` (lines 970-975); extend the import list (lines 74-75).
  4. `src/interp/emitter.ts`: four `case` lines in `binaryOpcode`; update the line-1742 comment (leaves `**`, `in`, `instanceof` as the remaining out-of-scope set).
- **Semantics come free:** ToInt32/ToUint32 and operand order (`acc = op(regs[r], acc)`, syntactic left in the register) are identical to the landed Shl/Shr; `>>>` correctly yields unsigned via native `>>>`.
- **Expected flips:** the 1 published `binary operator '|'` record, plus any records currently refusing at `compound assignment |=` etc. (not separately counted in the published 22 — they'd have surfaced under the same-file refusal). Verify in Node first via `tests/interp/differential.test.ts` additions (no Wasm build needed).

#### C2 — regex literal (implement as an interpreter-intrinsic builtin; measure honestly)

- **Site:** `src/interp/emitter.ts:1249` — `if (node.regex) throw new UnsupportedNodeError("regex literal", "Literal")`.
- **Fix design — builtin, NOT a new opcode** (the established "fewer ops, same cost class" rule the object/array-literal builtins follow):
  1. `src/interp/opcodes.ts`: `export const BUILTIN_REGEXP_CREATE = 28;` appended after `BUILTIN_PUSH_OBJECT_ENV = 27` (line 133) — **scalar export, not a field on the frozen `Builtin` object** (the file's own note, lines 108-110: separately compiled callable rec-groups keep their shape). Append `"RegExpCreate"` to `BUILTIN_NAMES` (line 300).
  2. `src/interp/runtime-ops.ts`: `export function buildRegExpLiteral(pattern: JSValue, flags: JSValue): JSValue { return new RegExp(pattern, flags); }` — in Node (E1) this is the real intrinsic; self-compiled it lowers to the AOT standalone RegExp constructor.
  3. `src/interp/loop.ts` `callBuiltin` (line 1285): `case BUILTIN_REGEXP_CREATE: return buildRegExpLiteral(regs[base], regs[base + 1]);`
  4. `src/interp/emitter.ts` `emitLiteral` (line 1249): replace the throw with: mark; `LdaConst internConst(node.regex.pattern)` → `Star rBase`; `LdaConst internConst(node.regex.flags)` → `Star rBase+1`; `CallBuiltin BUILTIN_REGEXP_CREATE, rBase, 2`; release. **Use `node.regex.pattern`/`node.regex.flags`, never `node.value`** (acorn's own `value` construction can be null/absent in the compiled lane).
- **Semantics:** a fresh RegExp object per literal evaluation is correct ES2015+ (§13.2.7.3); `lastIndex` state per evaluation follows. Immune to a user-shadowed `RegExp` binding (intrinsic construction, not name resolution) — which is also why the `LdName "RegExp"` + `Construct` desugar was rejected.
- **Dependency / honest expectations:** self-compiled, `new RegExp(<runtime string>)` goes through the standalone **dynamic-pattern** path — #4042 (status: ready, assignee L-regexp) records that patterns outside the post-#4065 grammar refuse with `Unsupported dynamic regular expression pattern`. So expect **≤ 13** flips: patterns inside the grammar flip; the rest degrade from a blanket Phase-1 refusal to a per-pattern runtime error (an attribution improvement, not a regression — verify 0 pass→fail). Measure the split and record it.
- **Provider canary:** the provider build canary-verifies before caching (`scripts/build-runtime-eval-provider.mjs`) — a `new RegExp` that fails to self-compile fails the build loudly, not silently.

#### C3 — defer to #2928 Phase 2 with counts (do NOT implement here)

`PrivateIdentifier` method keys (**4**), `PropertyDefinition` class fields (**3**), `TaggedTemplateExpression` (**1**) each need a runtime protocol (private state slots; field-initializer evaluation in constructor context; the tagged-template call convention with `raw`), none of which fits an M-horizon residual issue. **Action:** append these three, with the counts above, to #2928's Phase-2 scope list, citing this section. That closes this issue's acceptance box ("implemented **or** listed in #2928's Phase-2 scope with a count").

**Also record for Phase 2 (not in the published 22):** catch destructuring `ObjectPattern` (`emitter.ts:1054`) is invisible today only because #4194's parse-level raise masks it; it is #4194's declared "layer 2" and becomes the next blocker the day #4194 lands. Its implementer must also wire the B.3.3 **cancellation** half (a destructuring CatchParameter cancels the Annex B synthetic var — the `cancelsAnnexBVarBinding` counterpart to the landed `SIMPLE_CATCH_SCOPE_LABEL` exemption), which is currently unreached and untested.

### (c) New opcodes / builtin ids — encoding positions (append-only)

| id | name | form | notes |
| ---: | --- | --- | --- |
| 45 | `BitOr` | RegA | `acc = regs[r] \| acc` |
| 46 | `BitAnd` | RegA | `acc = regs[r] & acc` |
| 47 | `BitXor` | RegA | `acc = regs[r] ^ acc` |
| 48 | `ShrU` | RegA | `acc = regs[r] >>> acc` |
| builtin 28 | `BUILTIN_REGEXP_CREATE` | Builtin (a=id, b=rBase, +argc word) | scalar export |

`OP_COUNT` → 49. All ids < 64, so the WIDE-flag encoding invariant (bit 7 free) holds untouched. No changes to `OperandForm`, the encoder, or the disassembler beyond the indexed-table rows.

### (d) Edge cases

- **C1:** `null`/`undefined`/string operands — ToInt32 handles them natively (e.g. `"3" | 0 === 3`, `undefined | 0 === 0`); covered for free by the native-op authoring rule, but add differential cases anyway. Operand order matters for `>>>` (left in register).
- **C2:** empty flags (`/x/` → `flags === ""`); pattern containing chars that needed escaping in the literal (`node.regex.pattern` is already the source-exact pattern text); a regex literal in expression-statement head position never reaches the emitter as such (parser disambiguates — not our problem).
- **A2 (Layer 2):** must not disturb host fast mode — the widened gate admits only `standalone`/`wasi`, where `emitAnyAddFromExternTemps` never emits `__host_add`. Boxed captures stay excluded (`!fctx.boxedCaptures?.has(name)` — the #1999 hazard). BigInt stays excluded (existing check, line 1727-1728).
- **General:** none of these changes touch the provider seam — result envelope, callable rec-group ABI, and the ordered-initializer contract (#2928 "public linked runtime" findings) are unchanged. The provider disk cache key folds the compiler-bundle hash, so any A2 (codegen) change forces a ~2 min provider rebuild before measuring — that is correct behavior, not staleness.

### (e) Verification

Cheap first (no Wasm): add C1/C2 cases to `tests/interp/differential.test.ts` (runs the emitter+loop in Node against the host's `eval`), e.g. `a | b` on numbers/strings/undefined, `x |= 3`, `/a+b/.test("aab")`, `/x/g.flags`, two evaluations of one literal are distinct objects.

Then the provider lane (build order is mandatory — `scripts/run-test262-vitest.sh:173-176` then the provider):

```sh
# 1. rebuild both esbuild bundles, 2. node scripts/build-runtime-eval-provider.mjs, then:
TEST262_PATH_FILTER='annexB/language/eval-code/' TEST262_TARGET=standalone \
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1 \
pnpm run test:262 -- --official-scope-only
```

To enumerate the exact current record sets: `node scripts/fetch-baseline-jsonl.mjs --print-path`, then filter the standalone entries on error strings `"unsupported in Phase 1"` and `"SyntaxError: NaN"`.

Expected outcomes per arm: **A2** — 0 verdict flips; success = `pa9`+`pa10` both correct, and a genuine-syntax-error control (`eval("var 1 = 2;")` through the provider) renders `Unexpected token (1:4)`-shaped text instead of `NaN`. **C1** — the 1 `binary operator '|'` record flips (plus any compound-bitwise refusals); 0 regressions. **C2** — ≤13 flips, 0 pass→fail; record the in-grammar/out-of-grammar split. **C3** — 0 flips; #2928 Phase-2 list updated.

### (f) Risks / collisions

- **`src/interp/emitter.ts` + `src/interp/eval-environment.ts` are contested files.** #4171 (ready, sprint current) will touch eval-environment; any in-flight B.3.3/annexB-semantics spec touches emitTry and the scope machinery. This spec's emitter diffs deliberately avoid both: C1 touches only `binaryOpcode` (lines 1713-1744), C2 only the `emitLiteral` regex branch (line 1249) — **no changes to `emitTry`, `SIMPLE_CATCH_SCOPE_LABEL`, `isActiveBlockLexical`, `cancelsAnnexBVarBinding`, or any env-record path.** If a merge conflict appears in those regions anyway, it is someone else's change — do not resolve inline (per the `[CONFLICT]` protocol).
- **`operator-assignment.ts` (A2)** — concurrent-lane ownership as of 2026-08-06; re-check claims/open PRs at dispatch. The file also has a history of subtle mode-coupling (#1999, #2058, #3039) — keep the diff to the gate + coercion leg, nothing structural.
- **A2 blast radius:** widening the #2058 gate changes lowering for *every* standalone `any +=` site, not just acorn — the equivalence gate and the standalone floor/net guards in `merge_group` are the real check; a local scoped run cannot clear this. Expect the possibility of a park; that is the gate working.
- **Do not conflate arms in one PR.** A2 is codegen; C1/C2 are interpreter. Separate PRs so a park on the risky A2 change does not strand the mechanical C1/C2 wins.
- **Frontmatter `loc-budget-allow` for emitter.ts already exists** (granted for the landed catch fix); C1+C2 add ~20 LOC — re-run `check:loc-budget` and extend the rationale only if it trips.
- **#4194 sequencing:** nothing here depends on #4194 landing, and nothing here blocks it. But re-measure the `SyntaxError: NaN` bucket after #4194 lands — the 36 should collapse via its layer 1, and whatever remains is Layer-2/3 residue attributable with the now-readable diagnostics.

---

## Work log — 2026-08-08 (spec execution: C1, C2, A2 Layer 2, C3)

All four spec items implemented as four separate commits. Arm statuses below.

### Arm status after this session

| arm | status |
| --- | --- |
| 2 / 2b — null-deref + catch Environment Record | **LANDED** (PR #4139, unchanged here) |
| 1 — `SyntaxError: NaN`, **Layer 2** (rendering) | **FIXED** — the bucket now renders real acorn text with position |
| 1 — Layer 1 (the spurious raise, verdict-flipping) | **NOT HERE** — #4194, and this session's readable diagnostic now *names* it (below) |
| 1 — Layer 3 (`err.pos === NaN`) | **RESOLVED as a hypothesis** — it is #4194's dropped-expando write; no third defect |
| 3 — Phase-1 emitter gaps: bitwise `\|`/`&`/`^`/`>>>` | **IMPLEMENTED** (C1, opcodes 45-48) |
| 3 — Phase-1 emitter gaps: regex literal | **IMPLEMENTED** (C2, `BUILTIN_REGEXP_CREATE = 28`) |
| 3 — PrivateIdentifier / PropertyDefinition / TaggedTemplate | **DEFERRED with counts** to #2928 Phase 2 (C3) |

### Scoped test262 — local A/B, same machine, same corpus

`TEST262_PATH_FILTER='annexB/language/eval-code/' TEST262_TARGET=standalone
TEST262_FULL_RUNTIME_EVAL=1 COMPILER_POOL_SIZE=1 TEST262_WORKERS=1
pnpm run test:262 -- --official-scope-only`, 469 official-scope files, full
interpreter provider rebuilt for each arm (cache keys `8d62618f76cb96b7` before /
`e858993d4151b13f` after — the ~3 min rebuild is the cache key folding the
compiler-bundle hash, i.e. correct, not staleness).

| build | pass / 469 | fail→pass | pass→fail |
| --- | ---: | ---: | ---: |
| `HEAD~3` (pre-C1/C2/A2) | 442 (94.2 %) | — | — |
| this branch | 442 (94.2 %) | **0** | **0** |

**0 verdict flips, exactly as the spec predicted for A2.** What changed is the
entire failure bucket's *text*:

| bucket | before | after |
| --- | ---: | ---: |
| `SyntaxError: NaN` | **24** | **0** |
| `SyntaxError: Binding rvalue (1:266)` | 0 | 16 |
| `SyntaxError: Binding rvalue (1:288)` | 0 | 8 |
| `Test262Error: …"first declaration"/"second declaration"…` | 2 | 2 |
| `Test262Error: …«function () { [native code] }», «1»…` | 1 | 1 |

24 records changed error text with an unchanged verdict; nothing else moved.

**New, actionable finding — the now-readable message names #4194's raise.**
Compiled-acorn's spurious early error is `Binding rvalue`, i.e. `checkLValSimple`
rejecting the destructuring shorthand's `AssignmentPattern`/binding target. That
is the concrete diagnostic #4194 has been working without, and it is the
observable payoff of this arm: the message is now a lead, not an opaque `NaN`.

### A2 — the mandatory probe pair (`.tmp/probe/pa9.ts` + `.tmp/probe/pa10.ts`)

Compiled `target: "standalone", skipSemanticDiagnostics: true,
inferModuleStrictArguments: false`. Both were run; the pair disagrees by design.

| build | pa9 | pa10 |
| --- | --- | --- |
| baseline | `run=1 control=1` (correct) | `viaString=0 viaDirectEq=0 viaTypeof=2 viaLength=3` — **wrong** (`"NaN".length`, `typeof` number) |
| this branch | `run=1 control=1` | `viaString=1 viaDirectEq=1 viaTypeof=1 viaLength=10` — **correct** |

**Genuine-syntax-error control, through the real provider** (`.tmp/probe/layer3.mjs`,
`js2wasm:runtime-eval` linked, verified with `WebAssembly.Module.imports`):

```
err.name        = "SyntaxError"
err.message     = "Unexpected token (1:4)"      ← position TEXT, not NaN
```

A constant-string `eval("var 1 = 2;")` does **not** reach the provider (the
Tier-0 inline path answers `Invalid eval source`); the control must read `eval`
as a first-class value and pass a source string built at runtime, or it verifies
nothing.

### Layer 3 — the discriminating probe, and its verdict

Same probe, same caught provider syntax error:

```
typeof err.pos  = "undefined"
String(err.pos) = "undefined"
```

**`"undefined"` ⇒ this is #4194's dropped-expando-write half.** There is no
second numerification path and nothing further is owed by #4137: acorn's
`err.pos = pos` write on the SyntaxError instance is dropped in standalone, the
read-back is `undefined`, and whatever numerifies it to `NaN` does so at the
consumer. Closed as a hypothesis.

### A2 — the write-back coercion leg

No new coercion leg was needed. `compileAnyCompoundAdd`'s store path calls
`coerceType(ctx, fctx, {externref}, localType)`, and `type-coercion.ts` already
has the externref → `$AnyValue` arm (`isAnyValue(to)` → `addUnionImports` +
`boxToAny`, whose `from.kind === "externref"` branch is complete). Verified in
source; the diff is one gate condition, as specced.

### C1 — bitwise operators

Node differential (`tests/interp/differential.test.ts`, 15 new bodies covering
`|`/`&`/`^`/`>>>`, ToInt32 on string/`undefined`/`null`/fractional operands,
`>>>` operand order, and the compound forms incl. a member target): **all pass**,
curated corpus `supported=94 unsupported=1` (the one is `**`, still out of
scope). The 1 published `binary operator '|'` record is outside the
annexB/eval-code filter, so this A/B does not price it; the differential is the
direct evidence that the opcode path is correct.

### C2 — regex literals: the honest grammar split

Node (E1) differential: **9 new regex bodies, all pass** — `.test`, `.exec`,
`.replace`, `.source`, `.flags`, `lastIndex` state, and fresh-object-per-
evaluation identity. The emitter no longer refuses.

Self-compiled (the lane the 13 published records live in), measured through the
real provider (`.tmp/probe/c2-split.mjs`, 20 representative bodies):

| outcome | count | meaning |
| --- | ---: | --- |
| evaluates correctly | 1 | `/x/.source` |
| wrong value | 1 | `/x/g.flags` → `1` |
| `Unsupported dynamic regular expression pattern` (#4042) | 10 | the expected out-of-grammar degradation |
| `undefined is not a function` | 5 | **a second, distinct gap** — `RegExp.prototype.test`/`.exec` are not reachable on the constructed object in standalone |
| other (`String is not defined`, invalid `\p{L}`) | 3 | unrelated Phase-1/host-surface gaps |

**So the realistic standalone flip yield from C2 is near zero, not ≈13.** The
spec's "≤13, patterns inside the grammar flip" is an upper bound that assumed
#4042's grammar was the only obstacle; it is not — method reachability on the
constructed RegExp is a second one. The change is still correct and worth
landing: the refusal moves from a blanket `unsupported in Phase 1: regex literal`
(which hides everything behind it) to per-pattern, per-method runtime errors that
name their own cause, and it is verdict-neutral (a refusal and a runtime error
are both `fail`). Whoever picks up #4042 should also chase the
`undefined is not a function` half.
