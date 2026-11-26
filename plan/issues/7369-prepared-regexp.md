---
id: 7369
title: "Prepared IR path: a native RegExp provider (pure VM bodies, then create / test / exec)"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-26
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: []
related: [7354, 682, 1539, 7364]
---

# #7369 — Prepared IR path: a native RegExp provider

## Problem

A RegExp on the Prepared whole-program path (the IR-only path the site
measures, #7354) needs a native provider: there is no JS host to construct one,
and nothing on that path can call the in-module engine.

The engine exists (#682, #1539): a pattern compiler in TypeScript and a
backtracking VM written as Wasm. The compiler half is pure. The runtime half
was not: the VM `__regex_run`, its class matcher, the search loop
`__regex_search` and the `$NativeRegExp` struct were all emitted by functions
that take a `CodegenContext` (the legacy compiler's module state). The Prepared
path has no `CodegenContext`, so it could not register any of them.

Measured on main `ee3fcdd610` with the S9 stand-in census (2026-11-19): **259
ES5 test262 files crashed on a RegExp** on the Prepared path: 220 on `.exec`,
32 on `.test`, 6 on `.source`, 1 on both `.exec` and `.test`. #7364 turns those
crashes into named refusals; this issue makes them compile.

## Implementation Plan

Three steps. Each lists where the code lives, what it reuses, the duplicate it
removes, and the code-quality criterion a reviewer checks next to correctness.

### R0 — extract the runtime emitters into pure body builders (this PR)

No behaviour change: the compiled output is byte-identical.

- **Target modules** (`native-runtime` and `runtime-contracts` layers of
  `scripts/compiler-boundaries.json`):
  - `src/runtime/wasmgc/values/regexp-vm-bodies.ts`:
    `buildRegExpClassMatchBody`, `buildRegExpRunBody` (entry, main loop,
    dispatch chain).
  - `src/runtime/wasmgc/values/regexp-vm-arms.ts`: the opcode arms of
    `__regex_run`, its local indices and its operands type.
  - `src/runtime/wasmgc/values/regexp-search-body.ts`: `buildRegExpSearchBody`.
  - `src/runtime/wasmgc/values/regexp-carrier-layouts.ts`: the `$NativeRegExp`
    struct, its field indices, and the backtrack frame struct and array.
  - `src/runtime/contracts/regexp-bytecode.ts`: the opcode enum, the
    instruction width, the literal-alternation marker and the step-budget
    numbers.
- **Shape.** `build<Thing>Body(operands: Readonly<<Thing>Operands>)` returns
  `{ locals, body }`. Operands are type, function and global indices, plus one
  flag and the caller-owned instruction sequences listed below. No
  `CodegenContext`, no checker, no import from `src/codegen`.
- **Reuses.** `registerStructType` (`src/codegen/registry/types.ts`) for both
  struct registrations, in place of two hand-written copies of it. The
  `regex/{parse,compile,unicode,casefold}.ts` compiler half is untouched.
- **Adapters.** `ensureRegexRun`, `emitClassMatch`, `ensureRegexSearch` and
  `ensureFrameTypes` stay in `src/codegen/native-regex.ts`, and
  `ensureStandaloneRegExpStruct` in `src/codegen/regexp-standalone.ts`. Each
  resolves indices from `ctx`, calls the builder and registers exactly as
  before: same names, same order of type, global and function registration,
  same locals.
- **Duplicates removed.**
  - The VM, class-matcher and search bodies are moved, not copied.
  - `STANDALONE_REGEXP_STRUCT_NAME` was declared twice
    (`regexp-standalone.ts`, `string-isregexp-guard.ts`); both now import
    `NATIVE_REGEXP_STRUCT_NAME`.
  - `host-regexp-search.ts` repeated three `RE_FIELD_*` indices "so this helper
    does not import the RegExp god-file"; it now imports them from the layout.
  - The `-1` "budget exhausted" result was produced in `linear-search.ts` and
    consumed through two instruction-returning helpers; it is now one constant,
    `REGEXP_RUN_BUDGET_EXHAUSTED`, written by the VM body and read by the search
    body.
- **Three things the brief did not foresee**, decided here:
  1. *The opcode numbering had to move.* The VM body dispatches on `ReOp`, which
     lived in `src/codegen/regex/bytecode.ts`; the `native-runtime` layer may
     not import `src/codegen`. The numbering is a contract between the compiler
     and the VM, so it now lives in `src/runtime/contracts/regexp-bytecode.ts`.
     Every importer of `ReOp`, `INSTR_WIDTH` and the step-budget numbers
     imports them from there; `bytecode.ts` and `vm.ts` keep no re-export
     (review RV7337). The alternative, passing the opcode table in as an
     operand, would leave R1's binder unable to reach it for the same layering
     reason. Likewise the `RE_FIELD_*` indices are imported from
     `regexp-carrier-layouts.ts`, not re-exported by `regexp-standalone.ts`.
  2. *Three body files instead of one.* The function budget is 300 lines and
     the file budget 1,500. `__regex_run` alone is about 1,300 lines, so its
     arms are module-level functions in their own file, and the search loop has
     its own file because its local indices (`CAPS = 8`, `PC = 10`) collide
     with the VM's (`CAPS = 7`, `PC = 10`) at module scope.
  3. *Two operands are instruction sequences, not indices.* `stepCapThrow` and
     `poisonThrow` build a JS error through the caller's error constructor and
     exception tag. `indexedLiteralAlt` is the matcher for a program
     representation only the legacy runtime pattern compiler produces
     (`regex-anchored-alt-index.ts`); the search body splices it in and gives
     it the locals after its own.
- **Code-quality criterion.** No function over 300 lines and no file over
  1,500 in the new modules; `native-regex.ts` and `regexp-standalone.ts`
  shrink; no instruction literal exists in two places; the boundaries check
  accepts the new modules as `clean`; no budget grant.
- **Correctness criterion.** `scripts/byte-diff-corpus.mts --corpus regexp`,
  run on `origin/main` and on the branch and then `--compare`d, reports 0
  differing rows over every test262 file that mentions a RegExp, for the
  default, `standalone` and `wasi` targets. (`linear` never emits the WasmGC
  engine, so it proves nothing here; review RV7337.)

### R1 and R2 (superseded)

The original R1 (`create` / `test`) and R2 (`exec`) outline is replaced by
"Implementation Plan (R1+, Prepared provider)" below, written after R0 merged
(PR #7337). Its open point, where the pattern compiler lives, is answered there.

## Result (R0)

Measured 2026-11-26 on branch `s12-7369-r0-finish` (the rework of
`claude/7369-regexp-vm-bodies`, with `origin/main` `313281866f` merged in),
against a tree of `origin/main` `313281866f`.

**Byte identity.** `scripts/byte-diff-corpus.mts --corpus regexp --jobs 1` once
per tree, then `--compare` (review RV7337 folded the regexp corpus into this
tool and retired the separate `check-regexp-byte-identity.mjs`): 2,691 files ×
3 targets = 8,073 comparisons, **0 differences**, 0 crash rows, 0
order-dependent rows.

| Target       | Compiled on base | Failed on base | Failed on both | Differ on head |
| ------------ | ---------------: | -------------: | -------------: | -------------: |
| default      |            2,159 |            532 |            532 |              0 |
| `standalone` |            2,160 |            531 |            531 |              0 |
| `wasi`       |            2,159 |            532 |            532 |              0 |

The 6,478 compiled rows emit identical binaries. A row that fails on both trees
proves nothing about bytes, so it is counted apart and never as identical; all
1,595 failed with the same message on both trees. `wasi` replaces the earlier
`linear` column, because the linear backend never emits the WasmGC RegExp
engine.

`staging/sm/RegExp/regress-yarr-regexp.js` (`x{2147483648,}`) used to exhaust a
3 GB compiler heap on both trees, which made the first run `INCONCLUSIVE`.
#7409 has since fixed that on main: the file is now a compile error on both
trees ("exceeds expansion cap"), in the "failed on both" column.

**Compile order (#7410).** Compiled bytes can depend on what the same process
compiled before, because TypeScript's symbol ids are process-global and reach
emitted names such as `__@replace@22`. The tool does both things: the two trees
compile the same sorted corpus in the same 300-compile chunks, **and**
`--compare` recompiles every differing row alone, in a fresh process per tree,
counting it as a difference only if it still differs alone (one that agrees is
listed as order-dependent). The recheck is what makes the verdict
order-independent: a change that alters one file's compile also shifts that
state for the files after it in its chunk, which equal ordering alone does not
rule out. This run had no differing row to recheck.

**Tests.** The 66 `tests/*regex*` / `*regexp*` files, `npx vitest run
--maxWorkers=1`, on the branch and on the base tree: 1,143 tests, 1,094 pass,
37 skipped and the same 12 fail on both sides. The failure-set diff is empty.

**Size.** The new modules hold 2,433 lines; `src/` grows by a net 273.

| File                                                | Before | After |
| --------------------------------------------------- | -----: | ----: |
| `src/codegen/native-regex.ts`                       |  4,396 | 2,489 |
| `src/codegen/regexp-standalone.ts`                  |  6,659 | 6,600 |
| `src/codegen/regex/bytecode.ts`                     |    172 |   110 |
| `src/codegen/regex/vm.ts`                           |    313 |   304 |
| `src/codegen/regex-runtime/linear-search.ts`        |    539 |   500 |
| `src/codegen/regex-scratch-pool.ts`                 |    226 |   153 |
| `src/codegen/helpers/host-regexp-search.ts`         |    246 |   241 |
| `src/codegen/string-isregexp-guard.ts`              |    179 |   177 |
| `src/runtime/wasmgc/values/regexp-vm-arms.ts`       |      — | 1,041 |
| `src/runtime/wasmgc/values/regexp-vm-bodies.ts`     |      — |   647 |
| `src/runtime/wasmgc/values/regexp-search-body.ts`   |      — |   527 |
| `src/runtime/wasmgc/values/regexp-carrier-layouts.ts` |    — |   107 |
| `src/runtime/contracts/regexp-bytecode.ts`          |      — |   111 |

The largest new function is `rawLiteralAltSearch` at 172 lines, and no new file
exceeds 1,500 lines. The LOC and function budgets pass with no grant, against
both the merge base and `LOC_GATE_BASE=origin/main`.

## Implementation Plan (R1+, Prepared provider)

Written 2026-11-26 against `origin/main` `41f0654e8c`, and revised the same day after plan review PRV-7369. Every
number below was measured on that head unless it is labelled **estimate**.

### Decisions

| Question | Answer |
| --- | --- |
| One engine? | Yes. The Prepared realm calls R0's `buildRegExpRunBody`, `buildRegExpClassMatchBody` and `buildRegExpSearchBody` over bytecode from the one `compilePattern`. There is no second VM and no second compiler. |
| Where does the pattern compiler live? (Q2) | In a new boundaries layer `regexp-compiler` at `src/regexp-compiler/` (details under R1a). |
| What is a RegExp value on this path? | An ordinary realm object with one internal slot. It is a final subtype `$RegExpObject` of the realm `$Object`, with the field `[[RegExpMatcher]]: ref $__StandaloneRegExp` (R0's carrier). The shape precedent is `createPrimitiveWrapperDeclaration`: a subtype that adds a ref field. `lastIndex` is an own data property (writable, not enumerable, not configurable). `js.object.is-regexp` is `ref.test $RegExpObject`. |
| A new `CarrierKind`? | **No.** A RegExp is the `object` kind (the complement). Every row of `dynamic-value-kinds.ts` is already right for it: `typeof` "object", member get and set through the realm, ToPrimitive through its prototype. `carrierKindOf` learns one rule: a `js.object.create-regexp` call produces `object`. |
| How is a construction created? (Q1) | The Prepared legalization rewrites `extern.regex {pattern, flags}` into `i32.const k; call js.object.create-regexp`, as G1 writes `js.object.intrinsic(selector)`. Here `k` is the pair's index in the program's literal table (see "Literal table" under R1). The `extern.regex` arm of `lower-generic.ts` gains no lane test, and no per-pair functions are created. |
| Contract naming | The `js.object.*` family, served by `ROWS` in `native-source-objects.ts`, as `create-error` / `is-error` are: `js.object.create-regexp`, `js.object.is-regexp`, `js.object.regexp-exec-index`; later `js.object.regexp-exec` (R2) and the accessor bodies (R1b). |

### Steps (one PR each)

| Step | Content | Gate |
| --- | --- | --- |
| R1a | **Move + merge**: the compiler into `regexp-compiler`; one static-pair predicate; one i32-array builder; the Prepared mode of `byte-diff-corpus` | — |
| R1 | Realm RegExp object, creation, `RegExp.prototype.test`, `lastIndex`; the refusal disappears | R1a |
| R1b | `%RegExp.prototype%` accessors (`source`, `flags`, `global`, `ignoreCase`, `multiline`) and `toString`, which covers ToPrimitive and `+` (the old "R3") | R1 |
| R2 | `RegExp.prototype.exec` | **Parked** until Prepared arrays reach `main`. It is not stacked on S13's suspended branch. |

R1a, R1 and R1b are judged on the wider ES5 measure (below). The order is R1 → R1b → R2 (Q6).

#### R1a — move + merge (no behaviour change)

- **Layer `regexp-compiler`** (root `src/regexp-compiler/`), added to `scripts/compiler-boundaries.json`.
  - Its edges: `regexp-compiler → [regexp-compiler, foundation, runtime-contracts]`. It reaches `runtime-contracts` only for the opcode numbering in `regexp-bytecode.ts`.
  - `frontend-ts`, `backend-wasmgc`, `compiler` and the `legacy-*` layers gain an edge to it.
  - Why a new top-level root:
    - It runs at compile time, so it does not belong under the runtime roots (`src/runtime/**`).
    - `src/shared/contracts` (foundation) may not import `runtime-contracts`.
    - The backend may import neither `src/frontend` nor `src/compiler`.
- **Moved files**:
  - `parse`, `compile`, `bytecode`, `casefold`, `unicode`, `unicode-string-properties`, `unicode-string-data.generated`.
  - The reference VM (`vm`, `linear`, `match-units`) goes to `src/regexp-compiler/reference/`. It is the executable specification of the same bytecode, so it stays with the compiler that owns that bytecode. Only tests import it.
  - Each path is recorded in `moves` and marked `clean`.
  - `regex-runtime/unicode.ts` and about 10 `tests/*regex*` imports are repointed, with no re-export shim (RV7337).
- **Merge 1: one static-pair predicate.**
  - `src/regexp-compiler/static-pair.ts` exports `staticRegExpPairCompiles` and `staticRegExpPairSyntaxError`.
  - It replaces `standaloneStaticRegExpCompiles`, `isSupportedStaticRegExpCandidate`, `hostRegExpSyntaxErrorMessage` and `SUPPORTED_STANDALONE_FLAGS` in `regexp-standalone.ts`, and the host-`new RegExp` check in the early-error rule `src/compiler/early-errors/node-checks.ts:1310`.
  - The syntax verdict comes from the in-module parser. Today the parser throws one class, `RegexUnsupportedError`, for both "invalid" and "unsupported", so R1a splits it:
    - `RegexSyntaxError` for "nothing to repeat", an unterminated group, a duplicate flag, …;
    - `RegexUnsupportedError` stays for valid patterns the engine lacks.
  - The host engine is only the fallback for `u` / `v` patterns the parser does not cover (Q4).
  - TypeScript's own regex diagnostics (1499–1535) are not reachable here:
    - Measured with TS 5.9.3: `/a**/` gives 1507 in a `.ts` file but **nothing in a `.js` file** without `checkJs`.
    - They come only through semantic diagnostics, which the test262 Prepared options skip.
- **Merge 2: one i32-array builder.** `regExpI32ArrayInstrs(i32ArrayTypeIdx, values, scratchLocal)` goes in `regexp-carrier-layouts.ts`. `pushRegexI32Array` and `i32ArrayLiteralInstrs` become thin over it.
- **Prepared byte identity.** `scripts/byte-diff-corpus.mts` gains `--corpus prepared`:
  - It compiles through `src/test262/test262-prepared-entry.ts` with the real harness assembly and the CI worker's options.
  - Its inputs are `plan/samples/7354-o411.txt` plus `plan/samples/7369-es5-regexp-606.txt`.
  - The census's `loadToolchain`, `realAssembly` and `options` move into one exported module, `scripts/ir-census/prepared-toolchain.mts`, which both scripts import. There is no copy.
- **Pins.**
  - The early-error verdict:
    - The 132 negative `language/literals/regexp` tests stay at 131 pass. That is the 2026-11-26 measurement on the Prepared lane; the one failure, `S7.8.5_A2.2_T2`, is a TypeScript "Expression expected." parse error, not a RegExp one.
    - A unit table (`tests/issue-7369-static-pair-verdict.test.ts`) checks, for every RegExp literal in `byte-diff-corpus`'s regexp corpus, that the parser verdict equals node's. Any difference must be listed.
  - Bytes:
    - `byte-diff-corpus --corpus regexp` (default, `standalone`, `wasi`): 0 differences.
    - `--corpus prepared`: 0 differences.
  - Gates: `check:ir-layering` and `check:compiler-boundaries` green; the 66 `tests/*regex*` files show the same failure set as on main.

#### R1 — the provider (create, `test`, `lastIndex`)

- **How each construction source comes out (finding 1).** Literals and string pairs follow different rules:

  | Source | Invalid pair | Valid pair the engine cannot compile |
  | --- | --- | --- |
  | `/p/f` literal | An **early error at build time** (the R1a rule): no script code runs, no creation arm exists. A negative test (`negative: {phase: parse, type: SyntaxError}`, `$DONOTEVALUATE()` first) is a Prepared front-end failure in phase `early`. The worker counts it `pass`, as for the 131 today. | Named build refusal `regexp-constructor-unsupported` ("RegExp literal has no provider") |
  | `new RegExp("p", "f")`, both string literals | The **run-time SyntaxError** of its `create-regexp` arm (the realm's `create-error`, SyntaxError selector, message from `staticRegExpPairSyntaxError`), thrown when the expression is evaluated | The same named build refusal |
  | `new RegExp(x)` with a non-literal argument, `RegExp(…)`, `RegExp` as a value | — | Stay refused at build: `unknown class "RegExp"`, `"RegExp" is not in scope`. They need the runtime pattern compiler (`src/codegen/regex-runtime/`); follow-up issue. |

- **Where each part lives.** Each row names its module and the existing sibling it follows:

  | Concern | Module (sibling) | Change |
  | --- | --- | --- |
  | Capability | `src/ir/backend/legality.ts`, `src/ir/regexp-literal-admission.ts` | New capability `native-regexp-object` in `IrBackendTargetCapability` and `RegExpBuildCapability`. `supportsIrBackendTargetCapability` answers `false` for it, so the selector and the gc lane never see it, by construction. `nativeStaticRegExpBuilt` = pair ∧ `native-regexp` ∧ `nativeRegExpCompiles` ∧ (`native-regexp-object` ∨ today's consumer set). There is no new lane method. |
  | Lane answers | `src/ir/source-dynamic-contracts.ts`, `resolver` block | On the native lane with i16 native string storage: `supportsBackendCapability` (`native-regexp`, `native-regexp-object`), `nativeRegExpCompiles: staticRegExpPairCompiles`, `isLibOnlyBinding: isPristineBuiltinGlobal`. `from-ast.ts` is unchanged: `regExpLiteralBuilt` stays its only gate. |
  | Program fact | `src/ir/source-plain-objects.ts` | A static construction is an object producer (`objects.present`). The same walk yields the literal table: distinct pairs in source order. |
  | Literal table | `src/ir/program/runtime-support.ts` | A batch `regexp-literals` beside the number-format radix batches: the pairs, and every `create-regexp` occurrence with its `k`. It is re-derived and checked by the existing canonical walk. The realm reads the pairs from it; a program without a RegExp has no batch. |
  | Legalization | `src/ir/program/dynamic-regexp-methods.ts` (new; shaped like `dynamic-prototype-methods.ts`) | (a) Rewrites `extern.regex` into `create-regexp(k)`. (b) Writes `test` in spec order (below). (c) Turns a method call whose callee is the [[Get]] of `exec`, in a program that holds RegExps, into a **build-time** named refusal `RegExp.prototype.exec has no Prepared provider (#7369 R2)`, so the 269 `.exec` files stay census signal instead of run-time aborts (an own `exec` on a user object is refused too, on purpose). One dispatch arm in `dynamic-value-legalization.ts`. |
  | Realm family | `src/runtime/contracts/native-realm-catalog.ts` | Rows `%RegExp%` (constructor `unavailable`) and `%RegExp.prototype%` with `exec`, `test` and `toString`. `NATIVE_MEMBERS["RegExp.prototype"] = ["test"]`. `exec` and `toString` are present as `unavailable` rows, so a lookup never falls through to `Object.prototype.toString`. The family is held when the table is non-empty, as `heldErrorConstructors` decides for the Error family. |
  | Layout | `src/runtime/wasmgc/values/regexp-carrier-layouts.ts` | `declareNativeRegExpType` and the frame types (ledger keys, as in `bigint-carrier-layouts.ts`), plus `createRegExpObjectDeclaration(keys)`, written after `createPrimitiveWrapperDeclaration`. |
  | Bodies | `src/runtime/wasmgc/values/regexp-object-bodies.ts` (new) | `buildRegExpCreateDefinition`: a chain over `k`, as `buildSourceObjectIntrinsicDefinition` does. Each arm builds the matcher and the object, then defines `lastIndex` = +0. `buildIsRegExpDefinition`: `ref.test`. `buildRegExpExecIndexDefinition`: steps 3–11 below. No body runs user code. |
  | Rows and contracts | `native-source-objects.ts` `ROWS`; `ordinary-object-callables.ts` `DECLARATIONS` and `ORDINARY_OBJECT_RUNTIME_FEATURES` | Three `{ signature, body }` rows. R0's run, class and search functions are reserved once per realm (helpers, as with `RecordHelpers`). `stepCapThrow` is the realm RangeError and `poisonThrow` the TypeError. `indexedLiteralAlt` is empty. |
  | Program arrays (Q5) | the create body | Each pair's program and class-table arrays are immutable globals built once per pair (with `regExpI32ArrayInstrs`). Each creation allocates only the two structs. Each `exec-index` call allocates its capture array, which R1 accepts; pooling comes after a measurement. |

- **`re.test(S)` in spec order (§22.2.6.16, RegExpExec §22.2.7.1).** The method-call shape is `o.test(s)`, where the callee is the [[Get]] of `test` on `o`. When that callee is the realm built-in:
  1. `R = o`. If R is not an Object, throw a TypeError. This is the kind chain; a primitive or `null` cannot reach this point, but the chain stays total.
  2. `string = ToString(S)`, through the program's `stringOf`, so its side effects happen.
  3. `exec = Get(R, "exec")`, through `js.object.get`.
  4. If `exec` is the realm's `%RegExp.prototype.exec%` (identity against `js.object.intrinsic`):
     - the built-in exec's own steps: RequireInternalSlot (`js.object.is-regexp`, a TypeError if absent);
     - `n = ToNumber(Get(R, "lastIndex"))`, through the program's chain, so `valueOf` runs once;
     - `js.object.regexp-exec-index(R, string, n)`; the test result is `≠ −1`.
  5. Else, if `exec` is callable: the dispatcher calls it with receiver `R` and argument `string`.
     - A result that is neither an Object nor `null` is a TypeError (the kind chain over the result).
     - The test result is `result ≠ null`.
     - This arm needs a program with function values; without one it is the existing dispatcher gap.
  6. Else: RequireInternalSlot (`is-regexp`, TypeError), then step 4's lastIndex and `exec-index` path.

  Any other callee of `o.test(s)` goes to the dispatcher. RegExp-ness is checked at step 4 or 6, never before `exec` has been read.
- **The body of `js.object.regexp-exec-index(R, S, n) -> f64` (RegExpBuiltinExec §22.2.7.2).**
  - Step 2's Get and ToNumber are the caller's (above). They are **always** performed, even without `g` or `y`.
  - ToLength(n): NaN, −0 and negatives give 0; +∞ and anything ≥ 2^53 give 2^53 − 1. The comparison stays in f64, before any `i32` conversion.
  - Neither `g` nor `y`: lastIndex = 0, and the body **never** writes `lastIndex`. A non-writable `lastIndex` therefore never throws.
  - lastIndex > length: if g ∨ y, Set(R, "lastIndex", 0, true); return −1.
  - Sticky failure (one anchored attempt): Set 0; return −1.
  - Global failure (R0's search scans every start up to length): Set 0; return −1.
  - Success at end e: if g ∨ y, Set(R, "lastIndex", e, true); return e.
  - Every Set goes through the kernel's `set` with Throw = true: `false` (non-writable) becomes the realm TypeError. A Set never runs user code, because `lastIndex` is a non-configurable data property.

  | Case | Pin |
  | --- | --- |
  | Get + ToLength with neither g nor y; `valueOf` runs once | `test262 …/exec/failure-lastindex-access.js`, `success-lastindex-access.js` (run by R2); unit `tests/issue-7369-test-lastindex.test.ts` ("no g/y: valueOf once, no write") |
  | Neither g nor y: no Set, non-writable does not throw | unit (same file, "non-writable, no g/y") |
  | lastIndex > length with g/y → Set 0 | `…/test/S15.10.6.3_A1_T22.js` (ToLength is the start); unit "beyond length" |
  | sticky failure → Set 0; non-writable → TypeError | `…/test/y-fail-lastindex.js`, `…/test/y-fail-lastindex-no-write.js` |
  | global failure → Set 0 | `…/exec/failure-g-lastindex-reset.js` (R2); unit "g failure resets" |
  | success → Set e only with g/y | `…/test/y-set-lastindex.js`, `…/test/y-init-lastindex.js`; unit "g success sets e" |
  | ToLength of NaN, −0, −1, +∞, 2^53 | unit, one case each; `…/exec/S15.10.6.2_A4_T*` (`lastIndex` = `"12"`, `NaN`, `null`, `undefined`, `false`, `"eleven"`; R2) |

- **Out of scope in R1.** Each item stays a named build-time refusal:
  - `.exec` (finding 6, above);
  - the dynamic constructor (the table above);
  - `String.prototype.match`, `replace`, `search` and `split`: there is no String.prototype on this path yet, and they need the `@@match` / `@@replace` protocol;
  - pairs the engine cannot compile;
  - `--utf8-storage`: the VM reads i16 code units, so `native-regexp` is not answered there.

  A refusal is never a claim and then a withdrawal.

#### R1b — reflection accessors and `toString`

- **Catalog.** `%RegExp.prototype%` gets accessor rows (getter only, configurable): `source`, `flags`, `global`, `ignoreCase`, `multiline`. `toString` becomes native. The bodies go in `regexp-object-bodies.ts` and read `RE_FIELD_SOURCE` / `RE_FIELD_FLAGS`.
- **Receiver rules (§22.2.6).** On `%RegExp.prototype%` itself, a flag getter returns `undefined` and `source` returns `"(?:)"`. On any other non-RegExp receiver, they throw a TypeError.
- **ToPrimitive.** `'' + re` and `String(re)` produce `/source/flags` through OrdinaryToPrimitive. `ADD_ROLE` is unchanged.

#### R2 — `exec` (parked)

- **Gate.** It starts once Prepared arrays are on `main`. `claude/7354-arrays` (`9d3a111d11`, suspended 2026-11-20) is not an ancestor of `origin/main`.
- **Contract and realm.** `js.object.regexp-exec(R, S, n) -> externref` returns the match array (`index`, `input`, `undefined` for an unmatched capture) or `null`.
- **Unparking.** `NATIVE_MEMBERS` adds `exec`, and the build-time `.exec` refusal goes.
- **Shared code.** The capture-array body is extracted the R0 way from `ensureRegexCaptureArray` / `emitRegExpBuiltinExecFromLocal`. The matcher-to-search instruction sequence (`regExpSearchCallInstrs`) is shared with legacy's `emitRegExpTestFromLocals` and `emitRegexSearchCall`, parameterised by local indices so the output stays byte-identical.

### Measured yield (2026-11-26, `origin/main` `41f0654e8c`, standalone, `TEST262_COMPILER_PATH=ir`)

**The 411 sample** (`plan/samples/7354-o411.txt`, branch `claude/7354-o411-sample` `155b06691f`; `scripts/run-test262-vitest.sh`, 2 workers):

- 83 pass / 411.
- 13 rows stop at "RegExp literal has no provider", 5 at `unknown class "RegExp"`.
- What comes next for those 18 rows (**estimates**):
  - R1: +0. One row reaches `Function.prototype.bind`; three are `String.prototype` rows; four use a dynamic `new RegExp`.
  - R1b: +1 (`S7.8.5_A3.1_T4`).
  - R2: up to +11, of which 10 also need array literals with expando `index` / `input`.

**The wider ES5 measure (decides R1a / R1 / R1b).**

- **List.** `plan/samples/7369-es5-regexp-606.txt`, committed with this plan. It was produced as follows:
  - start from `npx tsx scripts/ir-census/es5-files.mts` (9,174 ES5 files, seeded order);
  - keep each file whose front matter has no `negative:` and whose TypeScript AST (`ScriptKind.JS`) contains a `RegularExpressionLiteral`, or a `new`/call expression whose callee is the identifier `RegExp`;
  - that leaves 606 files, kept in `es5-files.mts` order, with paths relative to `test262/test/` (the format `es5-files.mts` writes and the census reads).
- **Census.** S9's census (`npx tsx scripts/ir-census/prepared-census.mts --files plan/samples/7369-es5-regexp-606.txt --harness real --jobs 1`, 1 min 44 s):
  - 0 pass;
  - **431 stop first at a RegExp**: 346 "RegExp literal has no provider", 74 `unknown class "RegExp"`, 5 direct `RegExp(…)` calls, 5 `"RegExp" is not in scope`, 1 `instanceof RegExp`;
  - 175 stop earlier, the largest group at `'+' operands not provably …` (81).

  | Bucket of the 431 (static scan of each test's uses) | Files | Step | Passes after (**estimate**) |
  | --- | ---: | --- | --- |
  | `.test` / `lastIndex` only, literal or static `new RegExp` | 71 | R1 | 50–65 (35 `.test` files; 25 `Object/*` files using `new RegExp()` as a plain object) |
  | reflection (`source`, `global`, …, `toString`) | 15 | R1b | 10–15 |
  | `.exec` | 269 | R2, parked | 0 until R2. Of these, 21 compare only with `null` and 228 compare against an `__expected` array literal. |
  | dynamic constructor or `RegExp` as a value | 49 | refused | 0 |
  | `String.prototype` match / replace / search / split | 27 | refused | 0 |

- **Acceptance for R1.** The criterion is the census re-run on the committed list in the PR, with its date and head, against the 0 measured here. The estimate above is not the criterion.

### Code-quality acceptance (next to correctness)

- **One engine.** R0's three builders and one `compilePattern`. A grep for `ReOp.` dispatch outside `regexp-vm-arms.ts` and `src/regexp-compiler/reference/` finds nothing new.
- **One admission rule.** `regexp-literal-admission.ts` serves the selector, from-ast and Prepared through one capability. `from-ast.ts` and `lower-generic.ts` gain no branch.
- **Siblings in the same shape.** The contracts sit in `DECLARATIONS` / `ROWS`; the family in the catalog beside Error's; the layout after `createPrimitiveWrapperDeclaration`; the table as a `runtime-support.ts` batch; the legalization next to `dynamic-prototype-methods.ts`.
- **Duplicates removed.**
  - The static-pair predicate, shared by legacy, the selector, Prepared and the early-error rule.
  - The i32-array builder.
  - The Prepared toolchain of the census and `byte-diff-corpus`.
  - The search-call sequence (R2).
- **Budgets.** No `loc-budget-allow` or `func-budget-allow` grant is expected. Each new file stays under 400 lines; `native-source-objects.ts` grows by about 60 (**estimate**).

### Byte identity

- **Ordinary pipeline.** Every step runs `byte-diff-corpus --corpus regexp` (default, `standalone`, `wasi`) with 0 differences, plus the equivalence gate.
- **JS environment and the gc lane.** They cannot change: `native-regexp-object` is `false` in `supportsIrBackendTargetCapability`, and `lower-generic.ts` is untouched.
- **Prepared programs without a RegExp.** `byte-diff-corpus --corpus prepared` (R1a) shows every such row byte-identical, and the 83 sample passes stay passing.

### Settled questions and follow-ups

| # | Settled |
| --- | --- |
| Q1 | The legalization rewrite to `i32.const k; call create-regexp`; the table is a `runtime-support.ts` batch. |
| Q2 | Layer `regexp-compiler`, `src/regexp-compiler/`; the reference VM in `reference/`. |
| Q3 | R0's `$__StandaloneRegExp` fields 6–9 (`lastIndex` state) are unused on the Prepared path, and that is accepted. **Follow-up:** split the struct into a matcher and a legacy shell, which changes legacy bytes and so is its own change. |
| Q4 | In-module parser verdict, host engine only for `u`/`v`, pinned by the verdict table and the 132 negative tests. TypeScript's regex diagnostics are unavailable for `.js` (measured, TS 5.9.3). |
| Q5 | Allocation per call is fine for R1; program and class-table arrays are globals built once per pair; capture-array pooling after a measurement. |
| Q6 | R1 → R1b → R2; R2 is gated on arrays on `main`. |

- **Risk — the `'+'` stop.** 81 of the 606 stop at `'+' operands not provably …` before any RegExp. R1 does not change that count; it belongs to #7354's dynamic `+` work.
- **Risk — the early-error rule.** Moving `node-checks.ts`'s rule to the parser verdict changes build verdicts wherever the parser and the host disagree. The verdict table must list every such difference before R1a merges.
