# Host delegation completion repair — 2026-09-15

Status: specification only; not implementation or dispatch authorization.
Parent retains integration. No production writes, commits, pushes or test runs
were performed for this persistence task. The proposal below is preserved from
the preceding final response; the normative amendment afterward resolves its
expression-population ambiguity and adds current source observations.

## Preserved host completion proposal

The smallest shared-safe repair is the **host eager-delegation completion boundary**, not PR5753’s native state machine. Returning real `undefined` fixes the demonstrated array case, but the completion must remain a tagged JavaScript value through local storage and observation—not merely replace `0` with another sentinel.

No production writes or tests were performed.

## What current source establishes

At the last read, parent main was `c7f7252fe173749b3323543e21af707f5b095008`.

- [compileYieldExpression](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/codegen/expressions/misc.ts:263) calls void `__gen_yield_star`, then supplies `ref.null.extern`.
- [The runtime helper](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/runtime.ts:17033) drains with `for…of`, discarding the terminal iterator value.
- Declaration/hoisting inference can select numeric storage for the consumed value. Fixing the runtime alone therefore does not establish correct branding.
- PR5753’s composition still makes `bodyHasHostUnsupportedYieldShape` reject host native routing for every `yield*`. Its array-layout and abrupt-delegation changes do **not** repair this host path.
- `runtime.ts`, `expressions/misc.ts` and `registry/imports.ts` are byte-identical between inspected parent main and Volta’s composition. Local-allocation files differ and need parent reconciliation.

## Low worker contract

### 1. Add a return-valued host helper; preserve the existing void ABI

Proposed new import:

```ts
__gen_yield_star_result(
  buffer: externref,
  iterable: externref
): externref
```

Keep `__gen_yield_star(...): void` unchanged for existing IR statement delegation and async-buffer handling. Do not change its signature underneath sealed IR providers.

The new synchronous helper must:

- Append only nonterminal yielded values.
- Return the terminal iterator result’s actual `value`.
- Return JavaScript `undefined` for ordinary array exhaustion, including empty arrays.
- Preserve explicit terminal values: `0`, `-0`, `NaN`, strings, booleans, `null`, objects and `undefined`.
- Propagate exceptions without converting them to normal completion.
- Never append the terminal value or overwrite the outer generator’s return slot.

The protocol reads `done` before retrieving the terminal `value`; thrown accessors remain throws. The terminal value—not the operand’s static array type—determines completion. [ECMAScript yield-star evaluation](https://tc39.es/ecma262/multipage/ecmascript-language-functions-and-classes.html#sec-generator-function-definitions-runtime-semantics-evaluation).

**Do not implement “drain, then return undefined.”** Arrays can have overridden iteration methods with non-undefined terminal values.

**Do not reuse `_materializeIterable` indiscriminately.** Its closure-backed branch pre-drains to an array and loses completion. Reuse only positively identified vector-to-array adaptation; genuine host arrays/iterators must retain their protocol. Unsupported opaque carriers must fail explicitly, not become an empty iterable.

### 2. Consume the returned carrier

In `compileYieldExpression`, select the new helper for the bounded synchronous host completion path and return `{ kind: "externref" }` directly. Remove the synthetic null only on that path.

Requirements:

- Evaluate the operand once.
- Register/resolve the helper through the existing late-import machinery.
- Missing dependencies are compile errors, not omitted calls.
- Do not change ordinary `yield`, async delegation or standalone routing.
- Determine synchronous-generator ownership from the enclosing function declaration, stopping at the nearest function boundary; `fctx.isGenerator` alone does not distinguish async generators.

A genuine host `undefined` can inhabit externref; the existing `createHostUndefinedImport()` already uses that representation.

### 3. Keep completion bindings boxed consistently

A directly initialized consumed-delegation binding must use the same externref carrier in:

- `var` hoisting;
- `let`/`const` pre-hoisting;
- declaration emission;
- subsequent identifier reads.

Use one narrowly scoped predicate for a parenthesized/direct `yield*` initializer belonging to the repaired synchronous host path. It must outrank usage-driven numeric specialization.

Do not globally alter `resolveWasmType(undefined)`, number inference or coercion. An explicit operation such as `Number(completion)` may convert undefined to NaN; storing or observing the completion may not.

Assignment into an already numeric binding, captured bindings and destructuring are **not implicitly covered** by this initializer rule. They need explicit tests and their actual allocation owners before admission.

## Exact write scope

Low worker:

- [src/runtime.ts](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/runtime.ts): new synchronous return-valued import implementation.
- [src/codegen/registry/imports.ts](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/codegen/registry/imports.ts): exact new ABI, preferably registered only when used.
- [src/codegen/expressions/misc.ts](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/codegen/expressions/misc.ts): completion-result consumption.
- [src/codegen/index.ts](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/codegen/index.ts): authoritative hoisted-slot carrier selection.
- [src/codegen/statements/variables.ts](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/codegen/statements/variables.ts): matching declaration selection.
- New `tests/issue-5398-host-delegation-completion.test.ts`.

Parent:

- Reconcile the two allocation files with Volta’s composition.
- Narrow [generator-semantic-safety.ts](/private/tmp/js2-ir-takeover-20260914.uLEULx/pr5748/src/compiler/generator-semantic-safety.ts) only for the **implemented carrier/consumer population**, after executable tests pass.
- Restore the sixth original fixture in [issue-5393-guard-regressions.test.ts](/private/tmp/js2-ir-takeover-20260914.uLEULx/pr5748/tests/issue-5393-guard-regressions.test.ts).

Do not edit PR5753’s `generators-native.ts`, `generator-vec-abrupt.ts`, native protocol helpers, factory/prototype handling or closure capture machinery. No IR dialect expansion is required: current `gen.yieldStar` is statement-only and retains its void provider. Verify consumed expressions still follow the existing fallback rather than silently acquiring a second lowering.

## Required tests

Run at host optimization levels 0 and 2, with production imports/export wiring and Node comparison.

1. **Exact executed counterexample:** `var x = yield* [1,2]; yield x;` produces values `1`, `2`, `undefined`, then terminal `undefined`. Assert `done` separately.
2. Repeat with `[]`, string arrays and mixed numeric/string arrays; use `var`, `let`, `const` and parenthesized initializers.
3. Observe completion using strict equality, `typeof`, `Object.is`, `String` and null comparison. JSON alone cannot distinguish the relevant values.
4. `return yield* array` versus `yield* array; return 7` and `return "done"`: terminal values appear once and never enter spread/for-of output.
5. Runtime-helper tests with explicit terminal payloads listed above, including object identity.
6. Throwing iterator acquisition, `next`, `done` getter and terminal `value` getter: preserve payload and ordering; no successful completion afterward.
7. Original dynamic-import fixture, unchanged, with original harness and strict rerun.
8. Existing ignored-delegation/return controls: `issue-1017-yield-star`, `issue-2035`; async controls `issue-3227-s3` and relevant `issue-3075` cases.
9. Parent composition controls: `issue-5753-composed-delegation` and `issue-5753-composed-core`; retain standalone import-free assertions.

Keep the non-array numeric-generator completion refusal and unrelated generator diagnostics until their actual paths are repaired. Do not update them merely because the new helper can return a number.

## Concrete limit on the requested guarantee

The normal-completion repair is bounded. **An unconditional guarantee for arbitrary thrown completions and mid-delegation resumption is not.**

Two existing mechanisms prevent that claim:

- [Eager generator state](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/runtime/iterator-polyfills.ts:288) uses `null`/`undefined` as “no pending throw.” Uncaught `throw null` and `throw undefined` cannot be represented faithfully by that convention.
- Eager buffering finishes delegation before later `.next(value)`, `.return(value)` or `.throw(value)` calls. A return-valued drain cannot restore those suspension semantics.

Include these as negative/limitation controls, not passing claims. If unblocking requires changing pending-exception representation or forwarding abrupt resumption, stop this Low slice and report the exact failing test; that crosses into additional generator-state ownership.

Thus: dispatch the completion helper plus carrier fix, with parent-owned admission. It directly targets the measured `0` defect and original fixture, without claiming that array syntax makes every delegation behavior safe.

## Normative amendment: the original expression population is mandatory

This amendment supersedes any reading of the preserved proposal that limits
helper selection or diagnostic admission to variable initializers. The
initializer rule is a **storage rule**, not the complete admission rule.

### Exact fixture and provenance

During this persistence task, the corpus file was not present under the parent
main worktree. It was re-read, without modification, at:

`/Users/thomas/Code/js2/.codex-worktrees/5748-guard-repair-20260914/test262/test/language/expressions/dynamic-import/assignment-expression/yield-star.js`

SHA-256:
`4ceab6c267bea8f1adc3dd076eafe2a59628ce2ae667971dc5e43650c04407bb`.

Its executable source is:

```js
// Asserts valid syntax, return is not asserted for the undefined value of yield *
function *g() {
    import(yield * ['Roberta Flack', 'Donny Hathaway', 'Frank Sinatra']);
}
```

There is no `x = ...` assignment and no variable initializer. The directory's
`assignment-expression` names the ECMAScript grammar production accepted by
`import(...)`; `yield*` itself is an AssignmentExpression here. Its immediate
consumer is argument zero of an ImportKeyword CallExpression. The declaration
is uncalled in this fixture, but that is neither a safety proof nor the proposed
reason to relax the diagnostic.

### Required producer-to-consumer connection

The mandatory path is:

1. `compileYieldExpression` evaluates the array operand once, invokes the new
   result-returning helper and leaves its actual completion as externref.
2. `compileCallExpression`'s ImportKeyword arm in
   `src/codegen/expressions/calls.ts` consumes that same externref as argument
   zero of `__dynamic_import(externref) -> externref`.
3. There is no intervening binding, numeric slot or mandatory string conversion
   in this codegen arm. Normal array exhaustion must reach the import boundary
   as real JavaScript `undefined`, not `null`, `0`, `NaN`, an empty string or the
   literal string `"undefined"`. Runtime import conversion remains owned by the
   existing import implementation.
4. If operand evaluation or completion retrieval throws, the import call must
   not occur. This does not erase the separate eager pending-throw limitation.

The inspected arm at `calls.ts:7707` already calls
`compileExpression(ctx, fctx, specArg)` and leaves an externref result unchanged.
Consequently, helper selection in `misc.ts` must recognize consumed synchronous
host delegation independently of whether its parent is a VariableDeclaration.
The parent diagnostic admission must include this exact direct import-argument
consumer, with transparent parentheses accounted for, once its backend path is
verified. An initializer-only exception leaves the original regression blocked.

### Additional consumer owner: dynamic import and late indices

Add `src/codegen/expressions/calls.ts` to the **bounded consumer review/write
scope**, not to a generic call-dispatch refactor. It currently looks up `dynIdx`
before compiling the specifier and extra arguments and emits that saved numeric
index afterward. A new completion-helper import registered during argument
compilation can participate in late-index shifts.

Required invariant: the final `__dynamic_import` call uses the current index
after all argument compilation/coercion/import registration. Re-resolve the
symbol immediately before the call, or prove the existing registration ordering
prevents a shift on every admitted path. A test must exercise the late-helper
registration path; ordinary validation with all imports pre-registered is not
that evidence. Do not retain a missing/stale dependency as a silent omitted call.

The exact consumer's externref transport requires verification, not an invented
new branding API. Do not modify global coercion or dynamic-import semantics to
compensate for an incorrect producer. The import manifest owner is
`src/compiler/import-manifest.ts` and the dynamic-import capability branch is
`src/runtime/platform-capability-adapter.ts`; neither is automatically added to
the write set by this proposal.

### Distinct completion consumers; no blanket admission

- **Mandatory original:** `import(yield* array)` and transparent parentheses.
  Required owners are the result producer in `misc.ts` and the existing import
  argument arm in `calls.ts`. No initializer allocation change can substitute.
- **Mandatory executed counterexample:** `var/let/const x = yield* array` followed
  by observations of `x`. Required owners are `index.ts` hoisting and
  `statements/variables.ts` declaration allocation, in addition to the producer.
- **Return consumer:** `return yield* array` must pass the actual carrier through
  `statements/control-flow.ts`'s existing generator `__gen_set_return` path.
  Read/test this owner; add a narrow edit only if it fails the required carrier
  or current-index invariant. Never put the terminal result into the yield buffer.
- **Actual assignment variant:** `import(x = yield* array)` is NOT the upstream
  fixture and is not implicitly admitted. It additionally crosses identifier
  assignment/storage in `expressions/assignment.ts` and
  `expressions/identifier-assignment.ts`. Both the stored value and the assignment
  expression result must preserve the RHS carrier, along with existing const/TDZ
  behavior. Existing numeric storage must not be reinterpreted or widened after
  dependent code has already been emitted. Keep this population refused unless
  its binding-plan and assignment consumers are explicitly implemented/tested.
- Captures, property stores, destructuring, arbitrary call arguments and other
  expression contexts do not become certified by the import consumer's success.

Guard edits remain parent-owned in the PR5748 integration tree. Parent main at
the inspected SHA does not yet contain `src/compiler/generator-semantic-safety.ts`;
the existing integration-path links above deliberately identify its actual owner.
No reachability fact, dormant-body bypass, harness-name exception or file-path
allowlist is part of this contract.

### Additional acceptance evidence before claiming the original is unblocked

Add these tests to the proposed focused host-completion test file and the parent
regression suite, at host optimization levels 0 and 2:

1. Compile and execute the exact hashed upstream file with its original assembly,
   including the strict rerun, after normal parent guard integration. Keep its
   contents and harness unchanged. Successful syntax-only execution proves only
   the original regression is restored, not the runtime completion behavior.
2. Add a separate executed source retaining the exact `import(yield* array)` AST
   shape. Observe the **actual emitted import boundary** in a focused diagnostic
   test: its argument is `undefined`, `typeof` is `"undefined"`, and it differs
   from `null`, `0` and `NaN`. A recording wrapper must forward to the production
   dynamic-import implementation; it may not replace the loader with a fake
   successful import or serve as the original-harness pass evidence. Await/handle
   the real import result/rejection so it cannot become an unhandled rejection.
3. Pair that boundary test with an ordinary dynamic-import positive control and
   assert the helper and dynamic-import import signatures and valid emitted Wasm.
   Exercise first-use helper registration while compiling the specifier.
4. Pair the direct-consumer tests with the executed numeric/string/mixed array
   initializer tests in the preserved proposal. Check values and `done` separately;
   correct import-argument transport does not prove correct local allocation.
5. Test throwing completion retrieval: no import-boundary call follows the throw.
   Preserve the distinction between helper-level throw propagation and end-to-end
   arbitrary pending-throw support, which remains pending as described above.
6. Keep actual assignment-into-numeric-storage as a refusal/control until its
   separate storage contract is implemented. Do not rename it as the original
   fixture or count a rewritten initializer test as an original-source pass.

Executed import instrumentation must report when the import occurred; this
proposal does not claim repaired suspension timing. The known eager-buffer
limitations, array iterator overrides and opaque-carrier adaptation obligations
remain acceptance constraints. If a required case exposes those limitations,
report the concrete blocker; do not admit it because the upstream test is dormant.

### Evidence status

The exact fixture and current import consumer were read during this task; the
file hash and parent SHA above are observations. Helper implementation,
consumer/slot correctness, late-index safety, executed import behavior, original
harness passes and composed-head regression results are all **pending**. This
document records a proposed connected repair, not a new implementation or result.

## Follow-up verification: discarded statement value is not skipped evaluation

Parent specifically asked whether the import path ignores the specifier. The
following is a **source trace**, not a measured claim of helper execution:

- `src/codegen/statements.ts:229`, `compileExpressionStatement`, calls
  `compileExpression` on the import expression before passing its result to
  `sinkExpressionStatementValue`.
- `src/codegen/expressions.ts` dispatches the CallExpression to
  `compileCallExpression`. The host ImportKeyword arm in
  `src/codegen/expressions/calls.ts:7707` calls `compileExpression` on argument
  zero, retaining an externref result as the import's operand.
- `src/codegen/expressions.ts:1557` dispatches a YieldExpression to
  `compileYieldExpression`, unless an existing native-generator yield-value local
  explicitly owns that node. The inspected host native candidate gate excludes
  `yield*`; a future routing change must be checked again rather than assumed.
- `src/codegen/expressions/calls.ts:7733` emits the dynamic-import call after
  compiling its arguments. `src/codegen/statements/eval-completion-value.ts:71`
  ordinarily drops the **already-produced import result**. This drop does not
  delete the specifier evaluation or the emitted helper call on this legacy path.
- `src/runtime/platform-capability-adapter.ts:150` implements the dynamic-import
  capability as `(specifier: unknown) => import(specifier as string)`. The `as
  string` is a TypeScript assertion, not a runtime coercion or substituted value.

No alternate IR/optimizer route is certified by this trace. Current statement
`gen.yieldStar` remains void, and the actual executed consumed-import route must
be established on the integrated candidate. A surviving import declaration, an
unused helper import, valid Wasm, or a passing uncalled fixture is insufficient.

### Bounded admission gate for the direct-expression consumer

Parent may admit the synchronous host `import(yield* <supported array operand>)`
consumer, including transparent parentheses, **only after** all of these hold:

1. The actual integrated emitted body contains the result-valued helper call
   feeding the dynamic-import argument; final call indices and signatures are
   correct. Identify the function/body and actual route, not just import names.
2. An executed diagnostic variant proves the helper was invoked once for this
   site, its completion was obtained, and the import boundary was invoked once
   with that same completion. A test-local counting wrapper around the genuine
   helper must call through; a separate wrapper around the genuine import must
   call through. Neither wrapper is a production bypass or a substitute loader.
3. A load-bearing negative control wraps the same helper with a unique thrown
   sentinel: helper-call count is positive, import-call count is zero, and the
   sentinel is observed through the test's explicit exception path. If the body
   is dropped or the helper never called, the test must fail, not pass on absence
   of an import. Use a non-null object sentinel here so this control does not
   silently rely on the known nullish pending-throw defect.
4. Separate uninstrumented production-runtime execution and the exact original
   primary/strict fixture runs pass. The counting/control wrappers establish
   connection, not conformance or improved suspension timing.
5. The normal-completion and carrier tests above pass for the admitted operand
   population. Existing refusal remains for unsupported consumer/storage paths;
   there is no blanket array or ImportKeyword exception.

All five items remain pending. The earlier statement that the repair targets the
original fixture is an implementation objective, not an observation that the
current dormant fixture executes the helper or that a candidate has unblocked it.
