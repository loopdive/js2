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

Written 2026-11-26 against `origin/main` `41f0654e8c`. Every number below is
measured on that head unless it is labelled **estimate**.

### Decisions

| Question | Answer |
| --- | --- |
| One engine? | Yes. The Prepared realm calls R0's `buildRegExpRunBody`, `buildRegExpClassMatchBody` and `buildRegExpSearchBody`. Bytecode comes from the one pattern compiler (`compilePattern`). No second VM, no second compiler. |
| Where does the pattern compiler live? | It moves out of `src/codegen/regex/`, into `src/runtime/contracts/regexp/` (the `runtime-contracts` layer). Both the Prepared front end (admission) and `backend-wasmgc` (the bytecode) must call it. That layer is the only one that both may import, and it already owns the opcode numbering (`regexp-bytecode.ts`). |
| What is a RegExp value on this path? | An **ordinary realm object with an internal slot**, as an Error is. It is a final subtype `$RegExpObject` of the realm `$Object` with one extra field, `[[RegExpMatcher]]: ref $__StandaloneRegExp` (R0's carrier). Its `lastIndex` is an own data property (writable, not enumerable, not configurable). The shape follows `createPrimitiveWrapperDeclaration`. |
| New `CarrierKind`? | **No.** A RegExp is the `object` kind (the complement), so every row of `dynamic-value-kinds.ts` is already right for it: `typeof` "object", member get and set through the realm, ToPrimitive through its prototype. `carrierKindOf` learns one rule: an `extern.regex` produces `object`. |
| How is a literal created? | `extern.regex {pattern, flags}` survives legalization unchanged; its operands are immediates, as `string.const` carries its text. The realm description lists the program's pairs, deduplicated in canonical order. The lowering calls `js.object.create-regexp(selector)`, where `selector` is the pair's index in that list. This is the `create-error(selector)` / `intrinsic(selector)` pattern. |
| Contract naming | The Error precedent: `js.object.create-error`, `is-error`, `error-to-string`, all served by `ROWS` in `native-source-objects.ts`. So: `js.object.create-regexp`, `js.object.is-regexp`, `js.object.regexp-exec-index` and `js.object.regexp-exec` (R2), and the accessor bodies (R1b). No separate `js.regexp.*` family. |

### Steps (one PR each)

| Step | Content | Depends on |
| --- | --- | --- |
| R1a | Move the pattern compiler below the backend (pure move) | — |
| R1 | Realm RegExp object, creation, `RegExp.prototype.test`, `lastIndex`; the refusal disappears | R1a |
| R1b | `%RegExp.prototype%` accessors (`source`, `flags`, `global`, `ignoreCase`, `multiline`) and `toString`. This covers the old "R3 `+`": ToPrimitive of a RegExp | R1 |
| R2 | `RegExp.prototype.exec`: result array, `index`, `input` | R1, lane S13's arrays on main |

#### R1a — the compiler moves (no behaviour change)

- **Move as a unit** to `src/runtime/contracts/regexp/`: `parse`, `compile`, `bytecode`, `casefold`, `unicode`,
  `unicode-string-properties`, `unicode-string-data.generated`, and the reference VM (`vm`, `linear`, `match-units`).
  The VM is the executable specification of R0's arms and is imported only by tests.
  - Record each path in `compiler-boundaries.json` `moves` and mark the files `clean` / `runtime-contracts`.
  - Repoint `regex-runtime/unicode.ts` and about 10 `tests/*regex*` imports. No re-export shim (RV7337).
- **Shared static-pair predicate.** `standaloneStaticRegExpCompiles`, `isSupportedStaticRegExpCandidate`,
  `hostRegExpSyntaxErrorMessage` and `SUPPORTED_STANDALONE_FLAGS` leave `regexp-standalone.ts`. They become
  `staticRegExpPairCompiles` and `staticRegExpPairSyntaxError` in `src/runtime/contracts/regexp/static-pair.ts`.
  Legacy, the selector (`codegen/index.ts`) and the Prepared lane all import that one function.
- **Pure half of `wasm-array-literal.ts`.** The chunked `array.new_fixed` / `array.copy` builder becomes
  `regExpI32ArrayInstrs(i32ArrayTypeIdx, values, scratchLocal)` in `regexp-carrier-layouts.ts`. Both
  `pushRegexI32Array` and `i32ArrayLiteralInstrs` become thin over it.
- **Acceptance.**
  - `scripts/byte-diff-corpus.mts --corpus regexp`, `--compare` against `origin/main`: 0 differences for default,
    `standalone` and `wasi`.
  - `check:ir-layering` and `check:compiler-boundaries` green, with no new edges.
  - The 66 `tests/*regex*` files: the same failure set as on main.

#### R1 — the provider (create, `test`, `lastIndex`)

| Concern | Module (sibling it follows) | Change |
| --- | --- | --- |
| Admission | `src/ir/regexp-literal-admission.ts` | `RegExpBuildAnswers` gains `regExpObjects?(): boolean`: "this lane's RegExp is an ordinary realm object, so every consumer takes it". `nativeStaticRegExpBuilt` = pair ∧ `native-regexp` ∧ `nativeRegExpCompiles` ∧ (`regExpObjects` ∨ today's consumer set). The selector does not answer it, so its answers are unchanged. |
| Lane answers | `src/ir/source-dynamic-contracts.ts`, `resolver` block, beside `createsFunctionObjects` | On the native lane with native string storage: `supportsBackendCapability("native-regexp")`, `nativeRegExpCompiles: staticRegExpPairCompiles`, `isLibOnlyBinding: isPristineBuiltinGlobal`, `regExpObjects: () => true`. `from-ast.ts` stays as it is: `regExpLiteralBuilt` is already its only gate. |
| Program fact | `src/ir/source-plain-objects.ts` | A static RegExp construction is an object producer, so `objects.present` holds and the object kind is admitted. |
| Kind | `src/ir/program/dynamic-value-kinds.ts` `carrierKindOf` | `definition.kind === "extern.regex"` → `"object"`. |
| `re.test(s)` | `src/ir/program/dynamic-regexp-methods.ts` (new; the shape of `dynamic-prototype-methods.ts`) | Callee = [[Get]] `test` on the receiver. If that is the realm built-in, the module writes the spec steps that can run user code: the brand test (`js.object.is-regexp`, TypeError on a miss), ToString(S) (the program's `stringOf`), RegExpExec's Get `exec` (not the built-in → the dispatcher), Get `lastIndex`, then ToNumber (the program's chain, which can call `valueOf`). Then `js.object.regexp-exec-index(R, S, n) -> f64` (end index or −1). Any other callee → the dispatcher. One dispatch arm in `dynamic-value-legalization.ts`. |
| Realm family | `src/runtime/contracts/native-realm-catalog.ts` | Rows `%RegExp%` (constructor `unavailable`) and `%RegExp.prototype%`; `NATIVE_MEMBERS["RegExp.prototype"] = ["test"]`. `exec` and `toString` stay **`unavailable` rows, but present**. Otherwise ToPrimitive would silently fall back to `Object.prototype.toString`. Held when `description.regExpLiterals` is non-empty, as `heldErrorConstructors` decides for the Error family. |
| Literal table | `src/ir/program/native-realm-requirements.ts` | `NativeRealmDescription.regExpLiterals: {pattern, flags}[]`, filled by scanning `extern.regex` (the scan `native-string-value-demands.ts` already does). It is empty for a program without one, so the bytes of every such program do not change. |
| Layout | `src/runtime/wasmgc/values/regexp-carrier-layouts.ts` | `declareNativeRegExpType` / frame types (ledger keys, as in `bigint-carrier-layouts.ts`), and `createRegExpObjectDeclaration(keys)`. |
| Bodies | `src/runtime/wasmgc/values/regexp-object-bodies.ts` (new) | Two builders. `buildRegExpCreateDefinition`: a chain over the selector, as `buildSourceObjectIntrinsicDefinition` does. Each arm builds the matcher (via `regExpI32ArrayInstrs`) and the object, then defines `lastIndex` = +0. An invalid pair's arm throws the realm SyntaxError (`create-error`) with `staticRegExpPairSyntaxError`'s message. `buildRegExpExecIndexDefinition`: ToLength's clamp; ¬g ∧ ¬y → 0; the bounds check; then R0's `__regex_search`; then Set `lastIndex` through the kernel's `set` (a TypeError when it is not writable). It runs no user code. |
| Rows | `src/backend/wasmgc/resources/native-source-objects.ts` `ROWS` | `create-regexp`, `is-regexp`, `regexp-exec-index`, each `{ signature, body }`. Their operands resolve R0's run / class / search functions from one reservation of the three builders per realm (`regexp-vm` helpers, reserved once, like `RecordHelpers`). `stepCapThrow` / `poisonThrow` become the realm RangeError and TypeError. `indexedLiteralAlt` is empty here: only the runtime compiler produces that form. |
| Contracts | `src/ir/runtime/ordinary-object-callables.ts` `DECLARATIONS`, `ORDINARY_OBJECT_RUNTIME_FEATURES` | Three declarations. |
| Lowering | `src/ir/lower-generic.ts`, `extern.regex` arm | On the Prepared lane the provider is `js.object.create-regexp` and the resolver supplies `i32.const selector` before the call. The ordinary lane's per-pair helper path is untouched (open question Q1). |

```wasm
;; re.test(s), after the legalization's observable steps
local.get $R  local.get $S  local.get $n     ;; n = ToNumber(Get(R, "lastIndex"))
call $js.object.regexp-exec-index            ;; ToLength, g/y rule, __regex_search, Set lastIndex
f64.const -1  f64.ne                         ;; test's Boolean
```

- **Out of scope in R1, each stays a named refusal at build time:**

  | Refusal | Reason it stays |
  | --- | --- |
  | `new RegExp(x)` with a non-literal argument, and `RegExp` as a value or in call form (`unknown class "RegExp"`, `"RegExp" is not in scope`) | These need the runtime pattern compiler, `src/codegen/regex-runtime/`, a Wasm-emitted second compiler. Follow-up issue. |
  | `String.prototype.match` / `replace` / `search` / `split` (`method call .replace on string not in slice 4`) | The Prepared path has no String.prototype methods yet, and these also need the `@@match`/`@@replace` protocol. |
  | Pairs the engine cannot compile (`nativeRegExpCompiles` false) | The existing `regexp-constructor-unsupported` "RegExp literal has no provider" stays exactly for these. |
  | `--utf8-storage` | The VM reads i16 code units, so the lane answers `native-regexp` only with i16 native storage. |

  A refusal is never a claim followed by a withdrawal: from-ast's `refuseUnselected` remains the only gate.

#### R1b — reflection accessors and `toString`

- **Catalog.** `%RegExp.prototype%` gets accessor rows `source`, `flags`, `global`, `ignoreCase`, `multiline`
  (get only, configurable) and `toString`. Their bodies go in `regexp-object-bodies.ts` and read
  `RE_FIELD_SOURCE` / `RE_FIELD_FLAGS`.
- **Receiver rules (§22.2.6).** `%RegExp.prototype%` itself → `undefined` for a flag getter and `"(?:)"` for
  `source`. A non-RegExp receiver → TypeError.
- **ToPrimitive.** Once `toString` is native, `'' + re` and `String(re)` render `/source/flags` through
  OrdinaryToPrimitive. Nothing is added to `ADD_ROLE`.

#### R2 — `exec` (after lane S13's arrays merge)

- **Gate.** Lane S13's arrays are **not on main**: `claude/7354-arrays` (`9d3a111d11`, suspended 2026-11-20) is
  not an ancestor of `origin/main`.
- **Contract and realm.** `js.object.regexp-exec(R, S, n) -> externref` returns the match array or `null`, built
  with S13's `create-array` and `index` / `input` defined as data properties. An unmatched capture is `undefined`.
  `NATIVE_MEMBERS` adds `exec`.
- **R1's `test` arm.** It now calls the built-in exec's index form directly when `exec` is the built-in.
- **The match array.** The capture-array body is extracted the R0 way from `ensureRegexCaptureArray` and
  `emitRegExpBuiltinExecFromLocal`; legacy keeps its match-vec carrier.
- **Duplicate removed.** One instruction sequence: the matcher fields go into `__regex_search`'s operands
  (`regExpSearchCallInstrs`, in `regexp-carrier-layouts.ts`). Legacy's `emitRegExpTestFromLocals`,
  `emitRegexSearchCall` and the two realm bodies all use it. It stays byte-identical, because the helper is
  parameterised by local indices.

### Measured yield (2026-11-26, `origin/main` `41f0654e8c`, `--target standalone`, `TEST262_COMPILER_PATH=ir`)

**The 411-file sample** (`plan/samples/7354-o411.txt`, branch `claude/7354-o411-sample` `155b06691f`;
`scripts/run-test262-vitest.sh`, 2 workers):

- 83 pass / 411.
- 13 rows stop at "RegExp literal has no provider", and 5 at `unknown class "RegExp"`.

| Row(s) | What the test needs beyond the literal | Next stop | Passes after (estimate) |
| --- | --- | --- | --- |
| 8 × `S15.10.2.{6,7,8}_*` | `.exec`, then `__expected = ["…"]` with `.index` / `.input` written onto an array | exec, then S13 arrays | R2 |
| `S15.10.2.11_A1_T9`, `S15.10.2.12_A4_T5` | `.exec` result read by index, or compared to `null` | exec | R2 |
| `S7.8.5_A3.1_T4` | `.global` / `.ignoreCase` / `.multiline` reads | accessors | R1b |
| `S15.3.4.4_A16` | `Function.prototype.bind.call(re, …)` | Function.prototype read (not RegExp) | — |
| `S15.5.4.11_A3_T3` | `String.prototype.replace` | stays refused | — |
| `15.10.6.2-9-e-1` | `new RegExp("World")`, `.exec`, then the array's `toString` | S13 array ToPrimitive | R2 + S13 |
| `S15.5.4.18_A1_T14` | `String.prototype.toUpperCase` read | not RegExp | — |
| 3 × `S15.10.4.1_*`, `15.10.4.1-1` | `new RegExp(regexp, …)`, `new RegExp(null, void 0)` | stays refused (dynamic) | — |

- **Sample estimate.** R1 +0, R1b +1, R2 up to +11. All but one of these 11 need S13's array literals too.

**The wider ES5 measure.**

- **File set.** `es5-files.mts` lists 9,174 ES5 files. A static TypeScript AST scan of those
  (`.tmp/classify.mjs`, uncommitted) finds the 606 positive files that construct a RegExp.
- **Census.** S9's Prepared census, `--harness real --jobs 1` (1 min 44 s), on those 606:
  - 0 pass;
  - **431 stop first at a RegExp** (346 "RegExp literal has no provider", 74 `unknown class "RegExp"`, 5 direct
    `RegExp(…)` calls, 5 `"RegExp" is not in scope`, 1 `instanceof RegExp`);
  - 175 stop earlier; the largest group is `'+' operands not provably …` (81, string concatenation in assert messages).

| Bucket of the 431 (static scan of what each test uses) | Files | Step | Passes after (estimate) |
| --- | ---: | --- | --- |
| literal or static `new RegExp` with `.test` / `lastIndex` only | 71 | R1 | 50–65: 35 `.test` files, 25 `Object/*` files that use `new RegExp()` as a plain object; not `S15.10.4.1_A6_T1`, which needs `Object.prototype.toString` |
| reflection (`source` / `global` / …, `toString`) | 15 | R1b | 10–15 |
| `.exec` | 269 | R2 | 21 compare only with `null`; 20 read elements; 228 compare with an `__expected` array literal carrying `.index` / `.input` (S13's A2 work) |
| dynamic constructor / `RegExp` as a value | 49 | refused | 0 |
| `String.prototype.match/replace/search/split` | 27 | refused | 0 |

### Code-quality acceptance (next to correctness)

- **One engine.** R0's three VM builders and one `compilePattern`. No VM or compiler code exists twice: grep for
  `ReOp.` dispatch outside `regexp-vm-arms.ts` and `src/runtime/contracts/regexp/vm.ts` finds nothing new.
- **One admission rule.** `regexp-literal-admission.ts` serves the selector, from-ast and Prepared;
  `from-ast.ts` gains no branch.
- **Siblings in the same shape.** The contracts sit in `DECLARATIONS` and `ROWS`, the RegExp family in the
  catalog beside Error's, and the legalization module next to `dynamic-prototype-methods.ts`.
- **Duplicates removed.** `standaloneStaticRegExpCompiles` and its two helpers (moved, shared). The i32
  array-literal builder (pure, shared). The search-call sequence (R2). `regexp-standalone.ts` and
  `wasm-array-literal.ts` shrink.
- **Budgets.** No `loc-budget-allow` or `func-budget-allow` expected. Each new file stays under 400 lines;
  `native-source-objects.ts` grows by about 60 (**estimate**); `dynamic-value-legalization.ts` gains one arm.

### Correctness and byte identity

- **Byte identity.** R1a, R1 and R2 each run `byte-diff-corpus --corpus regexp` (default, `standalone`, `wasi`)
  against their base, with 0 differences, and the equivalence gate. JS-environment output and the gc lane stay
  byte-identical: the selector's answers do not change, because it never answers `regExpObjects`.
- **Prepared programs without a RegExp.** Their `regExpLiterals` list is empty, so no family is held and their
  bytes do not change. The 83 passing sample rows must stay passing.

### Risks and open questions for the reviewer

- **Q1 — the `extern.regex` lowering seam.** Either the Prepared resolver supplies the selector immediate in
  lower-generic's arm (proposed), or the realm reserves one function per pair (no immediate, but N reservations
  and per-pair ABI symbols). Which shape does the frozen-body consumer prefer?
- **Q2 — the layer.** Is `runtime-contracts` acceptable for a compiler of about 3,000 lines, or should the
  boundaries schema get a dedicated `regexp-compiler` layer, which both `frontend-ts` and `backend-wasmgc` may
  import?
- **Q3 — the matcher carrier.** On the Prepared path R0's struct carries `lastIndex` fields 6–9 unused.
  Splitting it into matcher and legacy shell would touch legacy bytes, so it is deferred.
- **Q4 — compile-time SyntaxError check.** `staticRegExpPairSyntaxError` runs the compiler host's `new RegExp`
  at compile time. That is a compile-time check, not a runtime host import, but it makes the result depend on
  the host engine's version.
- **Risk — allocation per call.** Each creation re-materialises the program arrays (legacy parity) and each
  `exec-index` allocates a caps array; legacy has a scratch pool. Caching in globals is a measured follow-up,
  not part of R1.
- **Risk — S13 ordering.** R2's yield (up to 269 files, **estimate**) needs S13's arrays plus their A2 expando
  writes. If S13 stays suspended, only the 21 null-only `.exec` files are reachable.
- **Risk — the `'+'` stop.** 81 of the 606 stop at `'+' operands not provably …` before any RegExp. R1 does not
  change that count; it belongs to #7354's dynamic `+` work.
