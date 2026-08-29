---
id: 5158
title: "ES2015 standalone: misc-statements conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
func-budget-allow:
  - src/codegen/destructuring-params.ts::destructureParamArray
  - src/codegen/binary-ops.ts::compileBinaryExpression
loc-budget-allow:
  - src/codegen/literals.ts
  - src/codegen/expressions/non-constructable.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/runtime.ts
  - src/codegen/statements/destructuring.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/binary-ops.ts
  - src/codegen/add-to-primitive.ts
  - src/codegen/object-runtime.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/statements/loops.ts
  - src/codegen/statements/exceptions.ts
  - src/codegen/arguments-object-mop.ts
---

## Problem

69 ES2015-bucket test262 tests in the "misc-statements" work package fail on the
standalone target (pure Wasm, zero host imports). Re-verified 2026-08-28 on head
(`86739f05`) with `npx tsx .tmp/run-standalone.mts --list
.tmp/es2015/wp-misc-statements-fails.txt`: 65 FAIL + 4 COMPILE_ERROR + 1 already
passing. The implementer's exact target list is
`.tmp/es2015/wp-misc-statements-current-fails.txt` (69 paths). Six clusters with
identified root causes cover 55/69 (80%); fixing them is a direct step toward the
100% ES2015 standalone goal.

Growth allowance (2026-08-28): the frontmatter `loc-budget-allow` grants LOC
growth to the files this plan changes — destructuring OOB-widening arms, the
binary-operand deferral, the in-module `@@toPrimitive` dispatch tail, tail-call
statement splitting, per-loop/catch lexical snapshots, and the arguments-object
`@@iterator` descriptor. All are standalone-mode conformance code with no
host-import additions.

## Current failure clusters

All counts re-measured 2026-08-28 via the probe (`npx tsx .tmp/run-standalone.mts <path>`
or `.tmp/probe-one.mts` for minimal repros; repro files in `.tmp/es2015/probes5158/`).

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| B | Array-destructuring iterator fidelity | 19 | `src/codegen/destructuring-params.ts:340 emitBoundsCheckedArrayGetUndef` numeric early-out → OOB reads yield 0 not undefined; `src/codegen/statements/destructuring.ts:105 tryEmitArrayProtoIteratorReadDrive` — standalone drive of a native-generator `Array.prototype[Symbol.iterator]` override resolves null → all bindings null; no TypeError on deleted/non-callable @@iterator; rest-after-elision builds a non-Array; elision-only pattern on a generator traps `__gen_resume` | `language/statements/for/dstr/const-ary-ptrn-elem-id-iter-complete.js`, `language/statements/for/dstr/let-ary-ptrn-elem-id-iter-val-array-prototype.js`, `language/statements/for/dstr/var-ary-ptrn-rest-id-exhausted.js` |
| A | Binary-operator coercion order + @@toPrimitive | 14 | `src/codegen/binary-ops.ts:283 tryFlattenBinaryChain` passes the f64 `numericHint` into `compileExpression(operands[0])`, so ToNumeric(lhs) (valueOf) runs before rhs is evaluated (§13.15.2 wants evaluate-lhs, evaluate-rhs, then coerce); `+`-specific: `__to_primitive` $Object tail (`src/codegen/object-runtime.ts`, consumed by `src/codegen/add-to-primitive.ts`) never consults a dynamically-assigned `[Symbol.toPrimitive]` and does not throw TypeError on a Symbol-returning valueOf | `language/expressions/subtraction/order-of-evaluation.js`, `language/expressions/addition/order-of-evaluation.js`, `language/expressions/addition/coerce-symbol-to-prim-invocation.js` |
| E | Lexical-scope closure capture (for-head / catch) | 7 | `src/codegen/statements/loops.ts:322 compileForStatement` — the for-head `let x` shares storage with an outer shadowed `x`, so a closure created before the loop reads the head binding ('inside' where 'outside' expected); same defect in the catch lane (`src/codegen/statements/exceptions.ts:344 compileTryStatement`, catch-param env vs catch-block `let` env). The for-IN twin was fixed by #2705 Slice B (outer-binding snapshot, loops.ts:3732) | `language/statements/for/scope-head-lex-open.js`, `language/statements/try/scope-catch-block-lex-open.js`, `language/block-scope/leave/outermost-binding-updated-in-catch-block-nested-block-let-declaration-unseen-outside-of-block.js` |
| D | annexB escape/unescape observability | 6 | ToString(arg) in the escape/unescape lowering skips `GetMethod(input, @@toPrimitive)` (same `__to_primitive` tail gap as cluster A) — `toString()` is invoked where `[Symbol.toPrimitive]` must be; and both functions are constructable (`new escape()` does not throw; `Reflect.construct`-based `isConstructor` true) | `annexB/built-ins/escape/to-primitive-observe.js`, `annexB/built-ins/unescape/to-primitive-err.js`, `annexB/built-ins/escape/not-a-constructor.js` |
| C | TCO through branching expressions | 5 | `src/codegen/statements/control-flow.ts:596-622` — `return cond ? f(n-1) : 0` and `return x && f(n-1)`: the arm rewrite (`rewriteArmTailCalls`) cannot promote the closure-call shape (call_ref + post-call coercion/materialization inside the if-arm), so the call stays non-tail → stack overflow at 100k depth. Plain `return f(n-1)` on the same closure IS promoted (verified: probe p11 passes, p10 fails) | `language/expressions/conditional/tco-cond.js`, `language/expressions/logical-and/tco-right.js`, `language/expressions/comma/tco-final.js` |
| F | arguments object / rest parameters | 4 | arguments exotic object lacks the own `Symbol.iterator` property (`value: [][Symbol.iterator]`, writable+configurable, non-enumerable) — `src/codegen/arguments-object-mop.ts`; arrow-function rest param with zero extra args materializes `null` instead of `[]`; rest param + `new.target` breaks `arguments.length` | `language/arguments-object/mapped/Symbol.iterator.js`, `language/rest-parameters/arrow-function.js`, `language/rest-parameters/with-new-target.js` |
| G | AsyncFunction intrinsics | 3 | `Object.getPrototypeOf(async function(){}).constructor` surface: `AsyncFunction`/`AsyncGeneratorFunction` intrinsics not constructable via Reflect.construct probe, and `AsyncFunction.prototype[Symbol.toStringTag]` missing | `built-ins/AsyncFunction/is-a-constructor.js`, `built-ins/AsyncFunction/AsyncFunctionPrototype-to-string.js` |
| — | Misc singles (11) | 11 | See "Misc residue" step below; includes 3 annexB COMPILE_ERRORs (#2200/#1539 territory), 2 cross-realm tests, a Wasm-validation CompileError in template-literal evaluation-order, `typeof Object(Symbol())`, `substr` this-coercion order, harness/testTypedArray, keyed-destructuring evaluation order, `for (let in {})` parse | `language/expressions/template-literal/evaluation-order.js`, `language/expressions/typeof/symbol.js` |

## Implementation Plan

Ordered by cluster count descending — partial completion maximizes yield. Every
fix must be Wasm-native (no new host imports; a host import is acceptable only as
a js-host-mode fast path with a standalone fallback). New codegen that needs type
info goes through `ctx.oracle` (`src/checker/oracle.ts`), never the raw TS
checker (oracle-ratchet gate).

### Step 1 — Cluster B: array-destructuring iterator fidelity (19 tests)

Four independent sub-fixes, all in the decl-destructure lane
(`compileArrayDestructuring`, `src/codegen/statements/destructuring.ts:1051` →
`destructureParamArray`, `src/codegen/destructuring-params.ts:1526`):

1. **OOB element → `undefined`, not 0** (covers the 6 `*-iter-complete` /
   `*-iter-done` tests plus assertions inside others). Minimal repro:
   `const [a] = []` binds `a === 0` (probe p2/p3). Root: the early-out at
   `destructuring-params.ts:346-348` sends non-externref element types to
   `emitBoundsCheckedArrayGet`, whose OOB arm produces the numeric zero.
   Fix in decl mode, identifier binding, no initializer: when the element read
   can be OOB, widen the binding local to externref (precedent: the #1553d
   re-typing block at `destructuring-params.ts:2512-2524`) and emit the OOB arm
   with `undefinedExternInstrs(ctx)` (the #2106 singleton — same file, line
   ~367), boxing the in-bounds f64 via the existing coercion. Register the name
   in `fctx.undefWidenedLocals` so downstream reads map correctly. Do NOT touch
   the param-mode path (fixed signature types) or bindings WITH initializers
   (defaults already fire via the externref arm).
2. **`Array.prototype[Symbol.iterator]` override honored in standalone**
   (covers the 4 `*-elem-id-iter-val-array-prototype` + 4
   `*-init-iter-get-err-array-prototype` tests). Probe p5: after assigning a
   generator to `Array.prototype[Symbol.iterator]`, `const [x,y,z]=[1,2,3]`
   binds all-null — the #1719 CPR read-drive
   (`tryEmitArrayProtoIteratorReadDrive`, `destructuring.ts:105`) drives the
   override via `__iterator_next`, and in standalone its closure dispatch
   cannot resolve a *native generator* override, so the null-iterator guard
   (destructuring.ts:162-168) silently degrades. Fix: when the captured
   override resolves to a native generator function, drain it through the
   native resume protocol instead — mimic the #2169 pattern already in
   `compileArrayDestructuring` (`emitNativeGeneratorToVec`,
   `destructuring.ts:1121-1170`) and the Wasm-native iterator helpers in
   `src/codegen/iterator-native.ts`. Additionally, per §7.4.2 GetIterator: when
   the brand says the override may be set but it resolves to undefined/deleted
   or non-callable (`delete Array.prototype[Symbol.iterator]` — the
   `init-iter-get-err` tests), throw TypeError instead of falling through to
   the backing-store fast path (follow the throw pattern of
   `buildDestructureNullThrow`, `destructuring-params.ts`).
3. **Rest element after elision must bind a real empty Array** (3
   `*-rest-id-exhausted` tests). Probe p7: `var [, , ...x] = [1, 2]` →
   `Array.isArray(x)` false. The rest branch is
   `destructuring-params.ts:2406-2504`; when `restLen` clamps to 0 the produced
   vec fails the `Array.isArray` brand check. Diagnose whether the local is
   re-typed (line 2469-2479) into a shape `Array.isArray`'s dispatch does not
   recognize, and align the empty-rest product with the non-empty one (the
   passing `[...x] = [1,2]` shape).
4. **Elision-only pattern over a generator traps** (3 `*-ary-ptrn-elision`
   tests). Probe p8: `let [,] = g()` → `RuntimeError: unreachable in
   __gen_resume_g`. Per §13.3.3.6 an elision performs one IteratorStep; the
   native-generator drain path (`destructuring.ts:1133-1170` /
   `patternIteratorStepCount`, `destructuring-params.ts:1632`) mishandles a
   pattern with only elisions. Trace which of the two lanes the shape takes and
   make the bounded drain execute exactly one resume, asserting `first===1 &&
   second===0` semantics (body runs to the first yield only).

Also in this cluster's scope: `language/statements/try/dstr/ary-init-iter-get-err-array-prototype.js`
(same fix 2, catch-param lane — the passing sibling
`ary-ptrn-elem-id-iter-val-array-prototype.js` proves the catch lane already
routes through the drive).

### Step 2 — Cluster A: binary-operator evaluation order + @@toPrimitive (14 tests)

1. **Two-phase operand evaluation** (11 `order-of-evaluation` tests, minus the
   addition-specific parts). Root: `tryFlattenBinaryChain`
   (`src/codegen/binary-ops.ts:283`) compiles `operands[0]` with the f64
   `numericHint` (line 348), so the hint-driven coercion inside
   `compileExpression` runs ToNumeric(lhs) — observable valueOf — before
   `operands[i]` is even compiled (probe p9: trace "13", spec wants "12").
   The deferral machinery already exists right below (lines 356-378: stash rhs,
   coerce lhs, coerce rhs) and there is a worked precedent for `**`
   (`isDeferredExponentiationObject`, line 178). Fix: when an operand's static
   type is not provably primitive (object-like / any — use the oracle, and keep
   the existing `isDeferredExponentiationObject` anonymous-object test as the
   template), compile it WITHOUT the numeric hint so the raw ref reaches the
   existing defer-and-coerce block. Keep provably-numeric operands on the
   hinted fast path — this gate is what protects the ratchet/perf baselines.
2. **`+` @@toPrimitive protocol** (3 `addition/*symbol-to-prim*` tests +
   `addition/order-of-evaluation`). The in-module default-hint dispatch
   (`src/codegen/add-to-primitive.ts`, `__to_primitive` tail in
   `src/codegen/object-runtime.ts`) must, for `$Object` inputs: (a) run
   `GetMethod(input, @@toPrimitive)` first — including a symbol-keyed property
   assigned dynamically (`left[Symbol.toPrimitive] = function(){}`), calling it
   with the `"default"` hint string and `this = input`; (b) throw TypeError
   when the @@toPrimitive result — or an OrdinaryToPrimitive valueOf result —
   is a Symbol or a non-primitive. The #4491 T4 residue notes in
   `add-to-primitive.ts:234-260` document exactly why the tail must not widen
   ToNumber — follow the same layering: extend the ADD-site dispatch, not the
   shared `__to_primitive` used by ToNumber.

### Step 3 — Cluster E: lexical-scope closure capture (7 tests)

`for (let x = 'inside'; …)` under an outer `let x = 'outside'`: a closure made
before the loop returns 'inside' — head binding and outer binding share one
storage cell. Fix in `compileForStatement` (`src/codegen/statements/loops.ts:322`)
by mirroring the #2705 Slice B pattern used for for-in heads (outer-binding
snapshot before installing head bindings, loops.ts:3647/3732; per-iteration cell
machinery from #1453 is already present at loops.ts:512/834): the head `let/const`
must allocate a FRESH box/cell distinct from any same-named outer binding, and
closures created in head decl/test/incr/body positions capture the loop cell
while closures created before/after the loop keep the outer cell. Apply the same
separation to the catch lane (`compileTryStatement`,
`src/codegen/statements/exceptions.ts:344`, localMap save/restore around line
505): catch-param default closures see the OUTER env; a `let x` inside the catch
block shadows for block closures (`scope-catch-block-lex-open/close`). The two
`block-scope/*` tests in this cluster (`outermost-binding-updated-in-catch-…`,
`for-in/mixed-values-in-iteration`) are the same capture-identity defect observed
through catch/for-in bodies — re-run them after the two lane fixes before any
extra work.

### Step 4 — Cluster D: escape/unescape observability (6 tests)

Depends on Step 2's @@toPrimitive plumbing. The escape/unescape lowering (see
`src/runtime.ts` / the annexB lowering added by #5123 — grep `escape` there)
must route its ToString(argument) through the string-hint ToPrimitive that
consults `@@toPrimitive` before `toString`/`valueOf` and throws TypeError on a
non-primitive result (`to-primitive-observe`/`to-primitive-err`, 4 tests). For
`not-a-constructor` (2 tests): `new escape(…)` and
`Reflect.construct(escape, [])` must throw TypeError — mark these builtins
non-constructable in the same way other non-ctor builtins are handled (grep for
how an existing non-constructor builtin, e.g. `parseInt`/`isNaN`, is rejected in
`src/codegen/expressions/new-builtin-globals.ts`; the shared IsConstructor gate
is the pattern to reuse — note `language/expressions/new/non-ctor-err-realm.js`
in the misc residue needs the same gate).

### Step 5 — Cluster C: TCO through branching expressions (5 tests)

Verified split: `return f(n-1)` on a closure IS tail-called (probe p11 passes);
`return true ? f(n-1) : 0` is not (p10 overflows). Rather than teaching
`rewriteArmTailCalls` (`src/codegen/statements/control-flow.ts:614-620`) to peel
coercions it cannot legally move, lower the return-of-branching-expression as
control flow in `compileReturnStatement` (`control-flow.ts:192`): `return c ? a
: b` → `if (c) return a; else return b;`; `return a && b` / `return a || b` →
evaluate `a`, branch, `return b` in the taken arm; `return (a, b)` → evaluate
`a`, drop, `return b`. Each synthesized return then flows through the existing
tail-merge (`peelToTailCallIdx` + `canTailCall`/`canTailCallRef`,
control-flow.ts:596-613) with matching types, and all existing guards (#822/#839
signature match, #1972 never-inside-try-with-handler) apply unchanged. Restrict
the split to arms whose compiled types agree with the function's return type to
avoid disturbing the value-producing `if` shape other passes expect.

### Step 6 — Cluster F: arguments/rest (4 tests)

- `arguments-object/{mapped,unmapped}/Symbol.iterator` (2): give the arguments
  exotic object an own `Symbol.iterator` data property equal to
  `%Array.prototype.values%` (writable: true, enumerable: false, configurable:
  true) in `src/codegen/arguments-object-mop.ts`, following how existing own
  properties (`length`, `callee`) are installed there; the test verifies via
  propertyHelper, so the descriptor must be right, not just the value.
- `rest-parameters/arrow-function` (1): arrow rest with zero surplus args must
  bind `[]`, not null — the rest materialization from `__argc`/extras for the
  arrow/closure ABI (grep `__extras_argv` in `src/codegen/closures.ts` /
  `destructuring-params.ts`) returns a null vec when count is 0; produce an
  empty vec instead (same empty-vec product as Step 1.3).
- `rest-parameters/with-new-target` (1): `function(a, b, ...c)` called with
  `new` must still populate `arguments` (length 3 for 3 args). Diagnose via the
  probe; likely the new-path prologue (`src/codegen/expressions/new-super.ts`)
  skips the arguments-object setup the plain-call path performs.

### Step 7 — Cluster G: AsyncFunction intrinsics (3 tests)

`AsyncFunctionPrototype-to-string` only needs
`AsyncFunction.prototype[Symbol.toStringTag] === "AsyncFunction"` on the
intrinsic reached via `Object.getPrototypeOf(async function(){})` — follow the
toStringTag installs from #5116/#5129 (Map/Set/buffer prototypes; grep
`toStringTag` in `src/runtime.ts`). The two `is-a-constructor` tests require the
intrinsic to BE constructable (isConstructor true) — constructing compiles
source text, i.e. runtime-eval territory; implement the constructable-brand +
TypeError-free Reflect.construct probe only if it does not drag in eval — else
mark those 2 explicitly deferred in the wrap-up note.

### Step 8 — Misc residue (11 tests) — fix only the cheap ones, document the rest

Cheap (attempt): `annexB/built-ins/String/prototype/substr/this-to-str-err.js`
(CheckObjectCoercible/ToString order on `this` in the substr lowering — throw
the receiver's Test262Error, not TypeError; grep `substr` in
`src/codegen/native-strings*.ts`); `language/expressions/typeof/symbol.js`
(`typeof Object(Symbol())` must be "object" — the Object() symbol-boxing path
keeps the symbol brand);
`language/destructuring/binding/keyed-destructuring-…-evaluation-order-with-bindings.js`
(object-destructuring step order — same observation discipline as Step 2);
`language/expressions/template-literal/evaluation-order.js` (genuine Wasm
validation bug: `call_ref[0] expected (ref null 82), found externref` in
`__module_init` — bisect the template-literal lowering's callee type).

Defer with a one-line note in the issue on completion (do NOT sink time):
`built-ins/ThrowTypeError/distinct-cross-realm.js` and
`language/expressions/new/non-ctor-err-realm.js` (need `$262.createRealm`);
`language/statements/for/head-lhs-let.js` (TS parser rejects `for (let in {})`);
`annexB/language/statements/labeled/function-declaration.js` and
`annexB/language/function-code/function-redeclaration-switch.js` (annexB
function-declaration semantics — #2200's territory, in-progress);
`annexB/language/literals/regexp/identity-escape.js` (standalone RegExp engine
gap, #1539 Phase 2); `harness/testTypedArray.js` (TypedArray-constructor
call-count harness self-test — overlaps #5138's constructor work).

### What NOT to do

- No new host imports without a standalone fallback (the runner fails any test
  whose module emits host imports — `standaloneHostImportError`).
- Never edit `tests/test262-runner.ts`, skip lists, or `scripts/*baseline*.json`.
- Do not use raw `ctx.checker.getTypeAtLocation` in new codegen — `ctx.oracle`
  only (oracle-ratchet gate).
- Do not widen the shared `__to_primitive` ToNumber tail (see #4491 T4 note) —
  extend at the ADD/ToString dispatch layer.
- Do not "fix" cluster A by always deferring — keep the numeric-hint fast path
  for provably-primitive operands, or perf baselines and the coercion-sites
  gate will move.
- Run all ratchet gates before committing (`check-loc-budget`,
  `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`,
  `check:dead-exports`), bare, never piped.

## Acceptance criteria

- All 69 tests in `.tmp/es2015/wp-misc-statements-current-fails.txt` pass via
  `npx tsx .tmp/run-standalone.mts --list …` — except any explicitly listed in
  the Step 8 deferred note (each with a one-line reason in this file).
- Every test in `.tmp/es2015/wp-misc-statements-passing-spotcheck.txt` (40
  paths) still passes via the same probe.
- Source-ratchet gates pass (LOC/func budgets against this issue's
  `loc-budget-allow`, coercion sites, oracle ratchet, dead exports).
- Equivalence tests pass (`npm test -- tests/equivalence.test.ts`).

## References

- #1052 / #1719 — Array.prototype[@@iterator] override machinery (CPR
  read-drive) that Step 1.2 extends for standalone native-generator overrides.
- #2169, #2033, #2106, #1553d, #1016 — prior destructuring lanes Step 1 builds
  on (native-generator drain, custom-iterable drain, OOB undefined singleton).
- #2705 (done) — for-IN head lexical scope: the Slice B outer-binding-snapshot
  pattern Step 3 mirrors for plain `for(;;)`. #1453 — per-iteration cells.
  #4672, #5109 (done) — adjacent let/TDZ and for-in capture fixes.
- #4491 — add-site OrdinaryToPrimitive residue; layering constraint for Step 2.
- #5123 (done) — escape/unescape ToString entry point Step 4 extends.
- #2200 (in-progress) — annexB function-declaration semantics (2 deferred
  COMPILE_ERRORs belong there). #1539 — standalone RegExp identity-escape.
- #5138 — TypedArray wave (harness/testTypedArray overlap). #5116/#5129 —
  toStringTag install pattern for Step 7.

## Results (implementation pass 1, 2026-08-28)

Measured with `npx tsx .tmp/run-standalone.mts --list
.tmp/es2015/wp-misc-statements-current-fails.txt` on this branch.

| | before | after |
|---|---|---|
| pass | 0 | 18 |
| fail | 65 | 47 |
| compile_error | 4 | 4 |

Guard list (`wp-misc-statements-passing-spotcheck.txt`): **26 pass / 14 fail
before AND after** — no regression. **The list is not all-green at HEAD**: 14 of
its 40 entries already failed on this branch *and* at the plan's measured base
`86739f05`, all with `RuntimeError: unreachable in __gen_resume_*`. See
"Standalone generator trap" below.

### Fixed

- **Cluster A, two-phase operand evaluation (10 tests).** `DEFERRED_TONUMERIC_OPS`
  in `src/codegen/binary-ops.ts` generalises the `**`-only deferral to every
  ToNumeric binary operator, so `obj - f()` evaluates both operands before
  running `obj.valueOf()` (§13.15.2). Covers `order-of-evaluation` for
  `subtraction · multiplication · division · modulus · bitwise-{and,or,xor} ·
  {left,right,unsigned-right}-shift`.
- **Cluster B.1, OOB element binds `undefined` (6 tests).** Two lanes in
  `src/codegen/destructuring-params.ts`: the vec lane gets
  `emitBoundsCheckedArrayGetUndefWidened` (in-bounds boxes to externref, OOB
  yields the canonical `undefined`), and the TUPLE lane — which is the one the
  `[]`-initialised patterns actually take — keeps a no-default decl binding at
  externref instead of unboxing an absent slot to `0`. `src/codegen/literals.ts`
  now pads missing tuple slots with `canonicalUndefinedExternInstrs` rather than
  the flag-gated `emitUndefined`, which fell back to `ref.null.extern` (read
  back as JS **null**). Covers the `*-elem-id-iter-{complete,done}` family.
- **Cluster D, `escape`/`unescape` are not constructors (2 tests).** The
  non-constructor global-function set moved to
  `src/codegen/expressions/non-constructable.ts` (gaining `escape`/`unescape`)
  and is now also consulted by `isStaticallyConstructible` in
  `call-namespace-static.ts`, so `Reflect.construct(fn, [], escape)` throws —
  which is what test262's `isConstructor` helper probes.

### Not fixed — with the reason measured

- **Cluster C, TCO through branching expressions (5 tests) — BLOCKED, not a
  rewriter gap.** The plan's premise (that `rewriteArmTailCalls` cannot promote
  the arm) is not the binding constraint. A control-flow split of
  `return c ? a : b` into two returns was implemented and verified to reach the
  tail-merge; the calls still are not promoted because `canTailCallRef`
  (`src/codegen/statements/control-flow.ts:135`) **refuses every externref
  return in standalone/WASI** — a deliberate Wasmtime `return_call` workaround
  (commit `0d916af3`). Any fix here is a decision about that workaround, so the
  split was reverted rather than landed as dead complexity.
- **Standalone generator trap — pre-existing, blocks ~11 of cluster B.** In this
  environment `function* g(){ yield 11 } g().next()` traps with
  `RuntimeError: unreachable in __gen_resume_g`, at this branch **and** at
  `86739f05`. Both the WAT printer and a `wasm-dis` decode of the emitted binary
  show **no `unreachable` opcode anywhere in that function**, so the fault is not
  where the frame name points. This gates every `*-iter-val-array-prototype` /
  `*-ary-ptrn-elision` test (they install or drain a generator) and the 14
  spotcheck failures. Needs its own issue.
- **Clusters A.2 / D.to-primitive (7 tests) — one shared root.** `String(obj)`
  ignores a `[Symbol.toPrimitive]` method on an object LITERAL in standalone
  (measured directly, not only through `escape`): the literal lowers to a closed
  struct, and `__class_to_primitive` only has per-struct `__call_valueOf` /
  `__call_toString` dispatchers. Fixing it needs a third `@@toPrimitive`
  dispatcher that also passes the hint argument — a real slice, not a patch.
  Routing `escape`'s ToString through `__extern_toString` was tried and reverted:
  correct layering, zero effect until that dispatcher exists.
- **Cluster E (7), cluster F (4), cluster G (3), misc residue** — not attempted
  in this pass. One measurement worth keeping for F:
  `language/rest-parameters/arrow-function.js` fails only when a SECOND rest
  arrow (`((...args) => args)()`) is present in the same module; with it removed
  the identical `fn()` assertions all pass, so the defect is cross-arrow
  interference (shared `__extras_argv`/closure-type state), not the zero-extras
  materialization the plan predicted.
- **Environment-blocked (4):** `built-ins/{AsyncFunction,AsyncGeneratorFunction}/is-a-constructor`,
  `built-ins/ThrowTypeError/distinct-cross-realm`, `language/expressions/new/non-ctor-err-realm`
  all fail with "quickjs provider is not built", not on semantics.
- **Deferred per the plan (5 of the 4 CEs + 1):** `for/head-lhs-let`,
  `annexB/.../labeled/function-declaration`, `annexB/.../function-redeclaration-switch`,
  `annexB/.../regexp/identity-escape`, `harness/testTypedArray`.
