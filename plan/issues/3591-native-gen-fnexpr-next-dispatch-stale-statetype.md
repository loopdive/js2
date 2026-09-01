---
id: 3591
title: "Native generator fn-expr: .next() dispatch tests a stale pass-1 state-struct type (4 silent regressions from #3032 W6)"
status: done
completed: 2026-09-01
sprint: current
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
created: 2026-07-24
updated: 2026-09-01
assignee: ttraenkler/codex-3591-terra-20260901
reasoning_effort: max
task_type: conformance
area: codegen, generators
es_edition: ES2015
loc-budget-allow:
  - src/codegen/generators-native-consumer.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/index.ts
  - tests/issue-3164.test.ts
  - tests/issue-3386.test.ts
  - tests/issue-3591.test.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #3591 — `.next()` on a variable-bound generator function expression throws TypeError (standalone)

## Summary

In the **standalone** lane, a generator **function expression** bound to a
module-scope variable compiles host-free and then **throws a `TypeError` at
runtime** when consumed via `.next()`:

```ts
var g = function* gen() {
  yield 3;
};
export function test(): number {
  const it: any = g();
  return it.next().value; // → TypeError: Generator.prototype.next requires that 'this' be a Generator
}
```

The module reports `success: true` with **zero `env` imports**, then traps out of
`test()` with an uncaught Wasm exception. `for-of` over the _same_ generator
works — only the `.next()/.return()/.throw()` member-call path is broken.

This is a **real product regression**, not a stale test (see Attribution).

## Completion — 2026-09-01

#3591 is complete. The original module-init-pass-2 opaque resume-dispatch
defect is fixed by the reserve-then-fill native-generator dispatcher, with the
standalone/WASI result-carrier and iterator-helper paths narrowed to their
proper lanes. The original four `#3591` skipped cases in
`tests/issue-3164.test.ts` and `tests/issue-3386.test.ts` are re-enabled, and
all original acceptance criteria below are satisfied without adding `env`
imports to the standalone generator shapes.

The seven-row Test262 list was a diagnostic expansion, not the original
acceptance scope. Its two `chunks`/`windows` exhaustion rows are handed to
[#5254](5254-es2015-inherited-iterator-helper-getter-dispatch.md), whose
assembled-WAT trace corrected the initial closure-carrier hypothesis to the
outer inherited-helper admission path. Its
`GeneratorPrototype/next/context-method-invocation` dynamic-`this` row is
handed to [#5255](5255-es2015-generator-method-this-transport.md). Those
independent residuals do not reopen #3591's stale-dispatch fix.

Final validation after synchronizing `upstream/main` at
`2d246ec12278721bfe5bee16dec321e03199e485`:

- `tests/issue-3591.test.ts`, `tests/issue-3164.test.ts`,
  `tests/issue-3386.test.ts`, and
  `tests/issue-2864-standalone-generator-carrier.test.ts`: **68/68 pass** in
  one single-worker lane.
- The retained official controls keep their authoritative baseline statuses:
  `language/statements/generators/no-yield.js` is the known `NaN` versus
  `undefined` assertion failure, and
  `language/statements/generators/yield-star-before-newline.js` is the known
  `__gen_resume_g` `local.tee` Wasm compile error. Neither is caused by the
  #3591 dispatch repair.

## 2026-09-01 current-main re-grounding and implementation plan

The old four skipped root-test cases no longer prove the defect by themselves.
Commit `49e67ee60a` added the call-free module-init fast path, so those fixtures
normally stop after pass 1. They remain useful controls, but the implementation
must be justified by a fixture that forces pass 2.

The defect is still live on `upstream/main` at
`83b173d8ded5d10ea7d9986f62290334982fdee9`. The authoritative isolated
standalone runner measured **0 pass / 7 fail** for this exact ES2015 cohort;
every row throws `TypeError: Generator.prototype.next requires that 'this' be
a Generator`:

- `built-ins/Iterator/prototype/chunks/underlying-iterator-advanced-in-parallel.js`
- `built-ins/Iterator/prototype/chunks/underlying-iterator-closed-in-parallel.js`
- `built-ins/Iterator/prototype/chunks/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/windows/underlying-iterator-advanced-in-parallel.js`
- `built-ins/Iterator/prototype/windows/underlying-iterator-closed-in-parallel.js`
- `built-ins/Iterator/prototype/windows/exhaustion-does-not-call-return.js`
- `built-ins/GeneratorPrototype/next/context-method-invocation.js`

The evidence command was
`node --import tsx scripts/run-test262-paths.mts <seven-path-list> --isolate
--standalone`. No compiler/test process was active before the lane. The locked
f841 census and the current-main rerun agree on all seven outcomes.

### Bounded implementation plan

1. Add a host-free red unit fixture that forces module-init pass 2 with an
   unrelated top-level call and then consumes a module-scope generator function
   expression through an opaque receiver. Pin `.next`, `.return`, and `.throw`
   shapes plus zero `env` imports. Do not change production code unless this
   fixture reproduces the stale brand.
2. Keep the direct, statically typed generator fast path unchanged. Replace
   only the opaque `anyref`/`externref` resume-method ladder that snapshots
   `ctx.nativeGenerators` during body compilation with reserve-then-fill
   dispatch helpers. Fill their bodies after all producer registrations, next
   to `fillNativeIteratorLateArms`, using the final state/result types.
3. Preserve the current argument-evaluate-once, host-generator-mix, abrupt
   completion, result-carrier, and TypeError miss semantics for each of
   `next`/`return`/`throw`. Do not memoize capturing generator closures by AST
   node; current main admits captures and their `__self` state is pass-local.
4. Re-enable the four `#3591` skips as call-free controls. Run the complete
   `tests/issue-3164.test.ts` and `tests/issue-3386.test.ts`, the new forced-pass
   test, and the heterogeneous/abrupt carrier controls in
   `tests/issue-2864-standalone-generator-carrier.test.ts`.
5. Rerun the exact seven-row isolated standalone cohort before/after and record
   zero-loss evidence. Also retain `language/statements/generators/no-yield.js`
   and `yield-star-before-newline.js` as official controls.

Draft PR #5063 changes a separate result-reader hunk in
`generators-native-consumer.ts` and does not own the stale dispatch builder.
This branch must stay independent from #5063 and preserve that PR's sentinel
reader change when it is eventually rebased.

## 2026-09-01 implementation checkpoint — incomplete

The required forced-pass-2 standalone fixture was red before production changes:
an opaque module-scope generator function expression failed `.next()`, `.return()`,
and `.throw()` with the native GeneratorValidate `TypeError` despite zero `env`
imports. The reserve-then-fill prototype makes that fixture green and has these
focused results:

- `tests/issue-3591.test.ts`: **1/1 pass**
- `tests/issue-3164.test.ts`: **13/13 pass** (the three #3591 controls re-enabled)
- `tests/issue-3386.test.ts`: **18/18 pass** (the one #3591 control re-enabled;
  the current suite contains 18 assertions, not the historical 17)
- `tests/issue-2864-standalone-generator-carrier.test.ts`: **34/34 pass**

The authoritative isolated standalone command is still a blocker and the draft
must remain unmergeable:

```text
node --import tsx scripts/run-test262-paths.mts .tmp/issue-3591-test262-seven.txt --isolate --standalone
```

It measured **0 pass / 7 non-pass** after the first reserve/fill prototype:

- `chunks` / `windows` `underlying-iterator-advanced-in-parallel` and
  `underlying-iterator-closed-in-parallel`: **4 compile errors** —
  `Cannot destructure: unknown type`.
- `chunks` / `windows` `exhaustion-does-not-call-return` and
  `GeneratorPrototype/next/context-method-invocation`: **3 runtime failures** —
  `Generator.prototype.next requires that 'this' be a Generator`.

Current diagnosis: returning the helper's fixed ABI as `eqref` erases the
call-site's statically known IteratorResult shape, explaining the four
destructuring compile errors. The remaining three stale-brand routes are still
being isolated; do not claim completion or modify the #5063 result reader from
this checkpoint.

## 2026-09-01 draft checkpoint — partial repair and precise handoff

The opaque resume dispatcher is now reserve-then-fill, using the final native
generator state set after module-init pass 2. Its fixed ABI returns `externref`
so an opaque result can still be destructured as an IteratorResult. For opaque
`.next()` only, the finalized no-generator-match arm recognizes native
`__IterRec` / `$LazyIterHelper` carriers and delegates through the existing
`__any_iter_next` adapter. The statically typed native-generator path is
unchanged; `.return()` / `.throw()` keep their existing abrupt and
evaluate-once behavior.

`tests/issue-3591.test.ts` now has two host-free focused regressions: the
forced real module-init-pass-2 `.next()` / `.return()` / `.throw()` case, and
opaque `chunks()` / `windows()` `.next()` dispatch. Both assert zero `env`
imports. The final focused lane on the synchronized tree was **67/67 pass**:

- `tests/issue-3591.test.ts`: **2/2**
- `tests/issue-3164.test.ts`: **13/13**
- `tests/issue-3386.test.ts`: **18/18**
- `tests/issue-2864-standalone-generator-carrier.test.ts`: **34/34**

The authoritative isolated standalone cohort improved from **0/7** to
**4/7 pass**:

```text
node --import tsx scripts/run-test262-paths.mts .tmp/issue-3591-test262-seven.txt --isolate --standalone
{ pass: 4, fail: 3 }
```

The remaining exact rows are deliberately left as a draft handoff, not folded
into this bounded stale-dispatch repair:

1. `chunks` / `windows` `exhaustion-does-not-call-return`: the throw is in the
   getter-returned closure's inner captured `n.next()`, not the outer lazy
   helper. Generated WAT has the final `$GenState_g` arm, but the captured
   native state crossing its `externref` closure field still reaches the brand
   miss. This needs a dedicated closure-carrier trace before changing another
   boundary.
2. `GeneratorPrototype/next/context-method-invocation`: `obj.g()` drops a
   known native state `ref` through the standalone callable-property result
   bridge, whose declared `Generator` result is `externref`. A narrow native
   state transport bridge would repair that brand miss, but the row also needs
   deferred dynamic-`this` stored in and rehydrated from the native state;
   object-literal receiver recognition currently excludes this generator
   declaration. That semantic feature is outside #3591's late-dispatch scope.

The two requested official controls were measured and match the authoritative
cached standalone baseline rows in workspace
`.test262-cache/test262-standalone-current.jsonl`:

- `language/statements/generators/no-yield.js`: fail — `NaN` versus
  `undefined` assertion.
- `language/statements/generators/yield-star-before-newline.js`: compile error
  in `__gen_resume_g` (`local.tee` ref type mismatch).

They are baseline residuals, not this checkpoint's regressions. Typecheck,
focused Biome lint, and Prettier passed; LOC/function and oracle ratchets
passed. `scripts/diff-test-gate.ts` could not evaluate because the provisioned
worktree lacks ignored `benchmarks/results/diff-test.json` (the script reports
that missing artifact).

Validation ran after synchronizing upstream/main `77303d58018bcf6d675dbfd2382063033e5714a9`.
The exact source/test checkpoint is
`135ecee93e9fa1f0578cbfa9cd4602e34f890410`; commands executed against its
identical precommit worktree state over sync HEAD
`2c6b737aacbe3259534aaab45e68886a5cf3896a`. Both commits have the required
Thomas and Codex/Terra trailers. Git signing is unavailable in this environment:
there is no configured signing format/key/program and no `gpg` executable;
`git log --show-signature` therefore reports no signature block.

## 2026-09-01 CI regression containment checkpoint

Draft PR #5402 CI run `33478111830` surfaced six genuine **host-lane**
regressions: the four `generator-return-method` cases, #1205's nested
TDZ-capturing generator case, and #1388's detached static async-generator
method case. The exact failed jobs were equivalence shards `99761721969` and
`99761721882`.

The cause was #3591 removing the original
`ctx.nativeGenerators.size === 0` admission guard. In a module with no
pass-1 synchronous native producer, that let the new opaque dispatcher claim
legacy sync and async-generator protocol calls with an empty state ladder.
The former reaches the GeneratorValidate TypeError; the latter is not a
synchronous IteratorResult at all. The forced-pass-2 #3591 fixtures retain a
pass-1 native function-expression registration, so restoring the guard does
not remove their late-filled final-state dispatch.

The repair restores that guard and keeps the new opaque `externref` result ABI,
`extern.convert_any`, and `__any_iter_next` reserve only for standalone/WASI.
The JS-host native declaration path retains its historical `eqref` result ABI.
`tests/issue-3591.test.ts` now also covers a nested host legacy generator
through `(it as any).return(...)` followed by `.next()`; it protects the exact
over-admission shape without changing nested-legacy bookkeeping.

Post-CI validation on the worktree over
`49db135cc230ed8f905d4f1d6fc96eed0167e8b7`:

- Exact CI regressions: **6/6 pass**. The focused four-file run had **16 pass,
  1 existing todo** (`generator-return-method`, #1205, #1388, and #3591).
- Existing standalone controls remain **67/67 pass**; including the new host
  control, the four #3591 control files total **68/68 pass** (3 + 13 + 18 +
  34).
- The authoritative isolated standalone cohort remains **4/7 pass, 3 fail**:
  `chunks/exhaustion-does-not-call-return`,
  `windows/exhaustion-does-not-call-return`, and
  `GeneratorPrototype/next/context-method-invocation`. Their exact TypeError
  failures are the pre-existing closure-carrier/property-call residuals above,
  not a regression from this containment repair.
- Typecheck, focused Biome lint, oracle ratchet, and LOC/function budget gates
  pass.

After the one upstream synchronization to
`d36e706738546c6c89ddb3d73a420e5e2c931651`, the combined focused lane
remained **81 active pass, 1 existing todo**, and the isolated seven-path
standalone cohort remained **4/7 pass, 3 fail** with the same three residuals.

This remains a draft/in-progress handoff. A mixed module containing both a
native synchronous producer and a typed async-generator receiver may still
need a caller-side async exclusion; an `any`-typed heterogeneous sync/async
receiver needs a dedicated runtime discriminator. Neither belongs in this
late-fill repair, and `call-receiver-method.ts` is deliberately unchanged.

## Reproduction / affected shapes

Measured on `origin/main` @ `7652f033774194`, `target: "standalone"`:

| #   | shape                                            | result       |
| --- | ------------------------------------------------ | ------------ |
| A   | `function* gen(){}` decl → binding `.next()`     | **3** ✓      |
| B   | `var g = function* gen(){}` → binding `.next()`  | **THROWS** ✗ |
| C   | `var g = function*(){}` → direct `g().next()`    | **THROWS** ✗ |
| D   | `function* gen(){}` decl → direct `gen().next()` | **3** ✓      |
| E   | `var g = function*(){}` → `for (v of g())`       | **3** ✓      |
| F   | `var g = function*(){}` → `for (v of it)`        | **3** ✓      |
| G   | `const g = function*(){}` → direct `g().next()`  | **THROWS** ✗ |
| H   | fn-expr IIFE _inside_ a function → `.next()`     | **3** ✓      |

So the break is exactly: **generator function expression lifted at MODULE
scope, consumed through the `.next()` open dispatch.** Declarations are fine
(registered once, by name). IIFEs inside a function body are fine (lifted once).

The thrown value is a `WebAssembly.Exception` carrying a real `TypeError` whose
message is exactly 60 chars — `Generator.prototype.next requires that 'this' be
a Generator` — i.e. the #1344 `emitBrandCheckTypeError` arm in
`src/codegen/generators-native-consumer.ts` (`buildNativeGeneratorDispatch`).

## Root cause (diagnosed, not guessed)

`compileDeclarations` compiles the **module-init body twice**:

- pass 1 — `src/codegen/declarations.ts:2312` ("early closure/setup discovery")
- pass 2 — `src/codegen/declarations.ts:2438` ("Recompile module init after
  top-level functions are compiled so call sites inside module-level code can
  see the final inlinable-function registry")

Top-level **function bodies are compiled between the two passes**. For a
module-scope generator function expression, `compileArrowAsClosure`
(`src/codegen/closures.ts:1894`) allocates a **fresh** `__closure_<n>` id and a
**fresh** state-struct type on _each_ pass. Instrumented compile of shape B:

```
[DBG] closure gen-expr closureName=__closure_0 selfTypeIdx=57  nodePos=7
[DBG] register nativeGenerator name=__closure_0 stateTypeIdx=61
[DBG] methodCall .next() receiverType={"kind":"externref"} registered=[["__closure_0",61]]
[DBG] closure gen-expr closureName=__closure_1 selfTypeIdx=108 nodePos=7
[DBG] register nativeGenerator name=__closure_1 stateTypeIdx=111
```

Same AST node (`nodePos=7`) → **two registrations, two state-struct types**.

`buildNativeGeneratorDispatch` emits an **inline `ref.test` chain** over
`ctx.nativeGenerators` _at the point the consuming function body is compiled_ —
i.e. between the passes, when only `__closure_0`/`61` exists. Pass 2's module
init is the one that survives, so at runtime `g` holds the `__closure_1` closure
whose factory does `struct.new 111`. `ref.test 61` fails, the chain falls
through to the `typeErrArm`, and the #1344 TypeError is thrown.

### Why `for-of` survives and `.next()` does not

`for-of` goes through the `__iterator` runtime's **GENSTATE arm**
(`src/codegen/iterator-native.ts`), which is **filled at finalize** by
`fillNativeIteratorLateArms` — by then _all_ registrations (including
`__closure_1`/`111`) are visible. The `.next()` dispatch is **inline and frozen
mid-compile**. That asymmetry is the whole bug.

### Why a naive fix does not work

Reusing pass 1's `NativeGeneratorInfo` on pass 2 is **not** sound as-is: the
lifted closure's `self` struct type also differs per pass (`57` vs `108` above),
and the state struct's `__self` field is typed `ref_null <selfTypeIdx>`. Pass 2
would store a type-108 self into a field typed `ref_null 57` → invalid Wasm.

## Suggested fix (two candidates)

1. **Late-fill the resume-method dispatch** (architecturally consistent —
   mirrors what already works for `for-of`): have
   `tryCompileNativeGeneratorMethodCall` emit a **call to a generated
   `__gen_dispatch_{next,return,throw}` helper** whose body is filled at
   finalize from the complete `ctx.nativeGenerators`, instead of an inline
   `ref.test` ladder frozen mid-compile. Needs care with the dispatch block's
   `resultType` (today it is computed from the generators known so far).
2. **Memoize the lifted closure per AST node for generator fn-exprs.** The
   #3164 admission gate already requires **no outer capture**, so such a closure
   is capture-free and _is_ safely shareable across both module-init passes —
   reuse the same `__closure_<n>`, `selfTypeIdx` and `stateTypeIdx` on pass 2.
   Smaller in principle, but touches closure lifting/DCE registries.

Candidate 1 is the more general fix: it also covers any future late
registration, not just the two-pass module-init case.

## Attribution — bisected, first-bad commit

- **last good**: `8bc6e1c3ccea74` (`feat(#3462)`) — `tests/issue-3164.test.ts` +
  `tests/issue-3386.test.ts` = **30/30 pass**
- **first bad**: `1fbb1810bd071361aea025a7a3878e95bb338c43` —
  `feat(#3032): W6 — host-lane generator declarations route native (lazy §27.5 +
next(v) two-way); GenState brands; sentinel-undefined reads (#3356)`,
  merged **2026-07-19** — the _same two files_ = **26/30, 4 failed**
- The four failures at the culprit are byte-identical to the four still failing
  on `main` @ `7652f033774194` today.

`git bisect` over the 2,937-commit range `a5220f56..7652f033` (12 steps,
automated probe on shape B) converged on that single commit. Both suites
predate it (`tests/issue-3164.test.ts` @ `a5220f56`, 2026-07-12;
`tests/issue-3386.test.ts` @ `3fa9b754`, 2026-07-18), and both were green at its
parent.

Most likely mechanism of exposure: W6's **"GenState brands"** made the two
passes' state structs no longer structurally identical, so they stopped
collapsing to a single deduped type index — turning a previously-harmless
double registration into a live type mismatch.

## Why this went unnoticed for 5 days

Neither suite was in the **required-checks** set:

- the #3008 per-PR gate only runs `tests/*.test.ts` files a PR **touches**, and
  #3356 touched neither;
- the heavy test262 shard matrix is `merge_group`-only and does not run root
  test files at all.

So #3356 could land fully green while breaking four assertions. Mitigated in
this issue's PR by folding both suites into the required guard suite
(`tests/guard-suite.json`, #3552) — the same class of fix as #3561/#3562/#3565.

## Acceptance criteria — complete

- [x] Shapes B, C, G above return their expected values host-free (zero `env`
      imports) in the standalone lane.
- [x] The four `it.skip`ped cases are re-enabled (search `#3591` in
      `tests/issue-3164.test.ts` and `tests/issue-3386.test.ts`) and pass.
- [x] `tests/issue-3164.test.ts` (13) and `tests/issue-3386.test.ts` (18) are
      fully green and remain in `tests/guard-suite.json`.
- [x] No new `env` imports in the standalone lane for any generator shape.

## Related

- **#3586** (`s += yield` compound-assign not claimed by the native generator —
  eager-buffer fallback), filed by the substrate + async review in PR #3578. Same
  native-generator territory as this issue's shape-gate work; worth reading
  together, since both concern which generator shapes the native path actually
  claims.

## Note — renumbered from #3584

This issue was originally filed as **#3584**, which collided with
`plan/issues/3584-auto-enqueue-blind-to-workflow-touching-prs.md` (PR #3577,
merged first — id reserved on `origin/issue-assignments` at 2026-07-24T22:05:41Z,
~29 min before this branch's PR was opened). The `check:issue-ids:against-main`
gate (#2531) caught it at PR level once #3577 landed on `main`.

Renumbered to **#3591** (fresh id via `claim-issue.mjs --allocate`) by the
PR-queue shepherd, since the authoring session was unreachable. The change is
purely mechanical — file rename plus id/reference rewrites in
`tests/issue-3164.test.ts`, `tests/issue-3386.test.ts` and
`tests/guard-suite.json`. **No test expectation, assertion or source behaviour
was touched.**
