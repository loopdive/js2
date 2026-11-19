# Is the target right? Cost of each IR route on the same ES5 files

Evidence gathered 2026-11-19. Read-only on the repository.

- **Tree measured by me:** `origin/main` `89e47482` (2026-11-19), test262 pin `b363f29d`.
- **Census quoted:** branch `origin/claude/es5-census-1119` @ `e142bda6` (PR #7308), measured there on main `ee3fcdd610`
  (`plan/log/es5-ir-only-census-2026-11-19.md` and the 38 first-gap lists beside it).
- **My scripts and raw rows:** `/home/user/js2/.tmp/altcost/` (gitignored). Named per section below.
- Every number is tagged **[measured]** (I ran it), **[quoted]** (from a file, named) or **[estimate]**.

Routes: **P** = Prepared whole-program path (no legacy fallback). **O** = ordinary pipeline (selector claims a unit, legacy
compiles the rest). **F** = IR-owned files (#7348). **H** = hybrid.

## 0. The five findings that decide the question

1. **The two paths share the IR front and middle, not the runtime.** O's IR code calls 215 symbols of legacy codegen
   (about 55 `ensure*` runtime-helper emitters); P calls 20, of which 2 are functions. P has its own native realm, and that
   realm's catalog has 42 of 45 intrinsics marked `unavailable`. [measured]
2. **A "zero-legacy" file on O is not legacy-free.** In 8 of 8 such files I probed, legacy also compiled 8 of the 9 units
   (the IR body is patched over it), and about 720 of the 768 Wasm functions in the binary are legacy-emitted runtime
   helpers. [measured]
3. **Legacy's runtime cannot be separated from legacy's AST compilers today.** Every runtime emitter I tested
   (`object-runtime.ts`, `any-helpers.ts`, `dyn-read.ts`, `json-codec-native.ts`, `native-regex.ts`, …) transitively
   imports all 1,189 files of `src/codegen`. So "legacy deletable" needs the runtime extracted on every route. Only P
   forces that work and only P's metric shows it. [measured]
4. **The first-gap histogram overstates each slice about fivefold.** By the syntax of each test, only 18 % of files
   (1,491 of 8,254) are freed by solving their own first-gap family. Function values and literals together (O+Fa+Fb+C)
   free 9.0 % of the corpus; 77.6 % of files use a built-in global or prototype method. [measured, syntactic estimate]
5. **The prelude is a self-made wall in part.** 87.8 % of files need only `assert.js` + `sta.js`, but every file also
   compiles the project's own 111-line shim, which reads 28 globals (`Proxy`, `Map`, `WeakMap`, `Promise`, `Symbol`,
   `eval`, …) to build `$262`. Only 21 of 8,717 positive ES5 files name `$262`; none calls `print`. [measured]

## 1. What the two pipelines share (from code)

### Call chains

| step | ordinary pipeline (O) | Prepared path (P) |
|---|---|---|
| entry | `compile()` in `src/index.ts` → `runPipeline` (`src/compiler.ts:1016`) | `src/test262/test262-prepared-entry.ts` `compile()`; checks `wholeProgram`, else delegates to legacy; → `runPreparedIrPipelinePresentation` (`src/compiler.ts:1121`) |
| driver | `generateModule` (`src/codegen/index.ts`, 14,483 lines). Legacy owns the module, the type registry, the function index space, imports | `prepareIrProgramPresentation` → `runIrProgramDriver` (`src/compiler/ir-program-driver.ts`, 35 lines): `prepareWholeIrProgram` → `acceptPreparedIrProgram` → `emitAcceptedIrProgram` |
| who decides what the IR takes | selector `src/ir/select.ts` (14,746 lines) + `select-*.ts`; a refused unit goes to legacy | no selector; the first thing the path cannot lower fails the whole compile |
| AST → IR | `lowerFunctionAstToIr` (`src/ir/from-ast.ts`, 17,427 lines) | the same function, called from `src/ir/program-source.ts:1752` |
| resolver for from-ast | `src/ir/integration.ts` (10,939 lines), backed by `CodegenContext` | `src/ir/program-source.ts` (1,846 lines) |
| IR passes | constant-fold, GVN, DCE, simplify-CFG, inline, monomorphize | the same passes (`src/ir/program-middleend.ts`) |
| IR → Wasm | `lowerIrFunctionBody` (`src/ir/lower.ts`, `lower-generic.ts` 4,569 lines) with a codegen-backed `IrLowerResolver` | the same function, with a resolver over reserved native resources (`src/ir/program-consumer.ts`) |
| runtime helpers | emitted on demand by legacy `ensure*` functions in `src/codegen` | "native resources" in `src/backend/wasmgc/resources` (15,163 lines) built from pure builders in `src/runtime/wasmgc/values` |
| module assembly | legacy `ctx.mod` | physical plan + reservations (`src/ir/program-physical-plan.ts`, `src/wasm/physical/`) and a presentation census |
| binary, WAT, d.ts | `finalizePipelineModule` | the same `finalizePipelineModule` |
| harness | prelude prepended; its units go through the selector like any other | prelude prepended; must compile whole |

### Resolver hooks supplied [measured, name match in the listed files; `.tmp/altcost/impl.mjs`]

| interface | members | named on P | named in O's `integration.ts` |
|---|---:|---:|---:|
| `IrFromAstResolver` (`from-ast.ts:566`) | 66 | 7 | 59 |
| `IrLowerResolver` (`backend/lower-contracts.ts:44`) | 36 | 11 | 32 |

P's seven: `sourceClosureInvocation`, `sourceClosureCallableParameter`, `resolveString`, `resolveDynamic`, `resolveVec`,
`resolveVecForElement`, `resolveModuleBinding`. The #7354 branches add a few (`isAmbientStringBinding` on `claude/7354-o`).

### Dependence on legacy codegen [measured; `.tmp/altcost/edges.mjs`, value imports only, not following into `src/codegen`]

| | files outside `src/codegen` | value-import edges into `src/codegen` | symbols |
|---|---:|---:|---:|
| P (roots: `ir-program-presentation.ts`, `ir-program-driver.ts`) | 525 | 7 | 20 |
| O's IR side (root: `src/ir/integration.ts`) | 346 | 83 | 215 (162 in `integration.ts`) |

- P's 20: 16 name constants (`IR_DYN_ADD_FN`, …), `evaluateConstantCondition`, `collectI32CoercedLocals`,
  `generateModule` and `isFatalCodegenDiagnostic` (the last two via `compiler/output.ts`, not used on this path).
- O's 215 include `ensureObjectRuntime`, `ensureAnyHelpers`, `ensureDynMemberGet/Set`, `ensureIrDynamicRuntime`,
  `ensureMapHelpers`, `emitJsonParseText`, `ensureNativeStringHelpers`, `ensureIrRegExpLiteralHelper`,
  `ensureIrDynamicConstructHelper`, `ensureVecElemSet`, `scriptVarHome`, `addUnionImports`, `boxToAny`.

### Lines of code [measured; closures from the same script]

| part | lines |
|---|---:|
| shared by both IR paths (from-ast, lowering, passes, analysis, IR core, manifest) | 116,173 (includes `select.ts`, imported by P for helpers but not run as a selector) |
| P only (`backend/wasmgc` 14,194; `runtime/wasmgc` 14,796; `ir/program*` and other `ir` 17,230; `compiler` 3,794; `wasm/physical` 2,241; rest shared with legacy's finalizer) | 66,633 |
| O's IR side only (`integration.ts` 10,939 and its `prepared-*` support files) | 21,944 |
| legacy `src/codegen` | 648,118 in 1,199 files |
| … of which AST-walking compilers [estimate: ≥ 3 uses of `ts.is…`/`ts.SyntaxKind`] | 401,463 in 557 files |
| … of which runtime emitters with no AST use [estimate: ≥ 5 instruction literals] | 203,440 in 411 files; 341 exported `ensure*` functions |

### The crux: same runtime, or a second one?

- **Value representation: the same by design.** A dynamic value on P is an `externref` over a GC reference, as on
  standalone legacy (#7354 plan, "One dynamic value, the existing one"). The object layout
  (`src/runtime/wasmgc/values/object-layouts.ts`: `$Object`, `$PropEntry`, `$PropMap`) is declared "in the legacy
  storage order", but only the Prepared backend imports that file; legacy declares its own copy in
  `src/codegen/object-runtime.ts`.
- **Implementation: mostly not shared.** `src/runtime/wasmgc/values` holds 93 pure-builder files, 19,188 lines. Imported
  directly by both legacy and the Prepared backend: 30 files, 6,094 lines. Legacy only: 25 files, 6,104 lines. Backend
  only: 24 files, 4,021 lines. [measured; `.tmp/altcost/values-share.txt`]
- **P's native realm exists but is nearly empty of library.** `src/runtime/contracts/native-realm-catalog.ts`
  (`ecma262-2026:Object+Function:v1`): 45 intrinsics; available are `%Function.prototype%` and `%ThrowTypeError%`;
  42 are `unavailable` (every `Object.*` static, every `Object.prototype` method, `call`/`apply`/`bind`). Its
  `remaining` list ends with "other ECMAScript intrinsic families". There is no String, Array, Number, Boolean, Math,
  JSON, RegExp, Date or Error family. [measured; `.tmp/altcost/catalog.mts`]
- **Legacy has all of it.** ES5 is a completed edition on standalone legacy (CLAUDE.md, edition ratchet). That library
  lives in the 203 k lines of ctx-bound emitters.

So P does need its own realm, and O borrows legacy's. The #7354 rule ("a body is moved and shared, not duplicated")
makes the cost a move, not a rewrite, but each move must keep legacy output byte-identical.

### Probes through both front doors [measured; `.tmp/altcost/probe-prepared.mts`, `progs.json`]

37 one-line ES5 programs through the strict Prepared entry, standalone:

- **6 compile and run:** script `var` arithmetic, string `===`, `try`/`catch` with a number, a top-level `for` loop,
  `x !== undefined`.
- **29 are refused, 2 crash the compiler.** Examples:
  - `function f(a){return a+1}` → `__ir_dyn_add has no Prepared intrinsic`;
  - `Math.abs(-1)` → "host provider or async demand is outside this numeric presentation contract";
  - `isNaN`, `parseInt`, `String(1)`, `eval` → "no exact AST-site plan";
  - `var o = {a:1}` → "no supported carrier"; an object literal inside a function → emission crash;
  - `[1,2,3]`, `a.push`, a function expression, a callback, `new P()`, `this`, `instanceof`, `new Error`,
    `Object.keys`, for-in, `switch` on a dynamic value, a closure, `arguments`, `s.charAt`, `n.toString(16)`,
    `JSON.stringify(1)`, `delete`, a getter → each refused by name; a RegExp literal → crash.
- The same 37 on O: all compile and run (legacy fallback). None is IR-only, because my probes use `throw 1`, which O's
  module-init lowering refuses ("throw val not in slice 9") and P accepts. The two paths have diverged in both
  directions.

Ten real tests through the Prepared entry [measured; `few-real.jsonl`, `few-standin.jsonl`]: real prelude 0 of 10
(9 stop at `dyn.typeof` in `assert.js`); stand-in 4 of 10 pass. Refusals take 2–12 ms; a compile that reaches emission
takes 0.3–0.7 s. `claude/7354-o` records about 18 s per compile once the realm is reserved (a quadratic reservation
audit; plan section "Realm join") [quoted].

## 2. Prepared path: the set-cover picture

**The census records only the first failure per file.** Its README says so: "The Prepared path stops at its first gap,
so a file is in exactly one list." There is no sole-blocker or files-carrying count on this path.

To see behind the first gap I parsed every positive ES5 file with the TypeScript parser (body plus its includes other
than `assert.js`/`sta.js`) and recorded which mechanisms its syntax needs (`.tmp/altcost/features.mjs`, `cover.mjs`,
`hidden.mjs`). Limits: it is syntax only, so it undercounts (a file that parses as needing only `String` may still need
a method the realm lacks); harness calls (`assert.*`, `new Test262Error`), `typeof`, `throw`/`try` and control flow are
assumed solved. Check: of the 514 files with an empty need-set, 141 are among the 148 that pass today; 7 passing files
have a non-empty set.

### Files carrying each mechanism [measured, syntactic], of 8,717 positive files

| mechanism | whole program | needed by the test body itself |
|---|---:|---:|
| object / array literals (O) | 3,957 (45.4 %) | 2,967 |
| built-in `Object` (statics, descriptors) | 3,443 (39.5 %) | 2,455 |
| function expressions, declarations as values, nested functions (Fa) | 3,397 (39.0 %) | 2,619 |
| `new F()`, `this`, `prototype`, `instanceof` (C) | 3,303 (37.9 %) | 2,393 |
| Error constructors | 2,269 (26.0 %) | 1,302 |
| calls through a value, method calls on user objects, IIFEs (Fb) | 2,266 (26.0 %) | 1,381 |
| built-in `String` | 1,817 (20.8 %) | 851 |
| accessors (literal `get`/`set`, descriptor `get`/`set`) | 1,669 (19.1 %) | 708 |
| `Function.prototype.call/apply/bind` | 1,372 (15.7 %) | |
| built-in `Array` | 1,362 (15.6 %) | 395 |
| for-in | 1,301 (14.9 %) | 390 |
| `delete` | 1,231 (14.1 %) | 326 |
| `arguments` | 1,201 (13.8 %) | 297 |
| **`eval` or `Function(...)`** | **1,050 (12.0 %)** | **1,024** (`eval` 822, `Function()` 202) |
| RegExp | 747 (8.6 %) | 682 |
| `Number` 638 · `Boolean` 393 · `Math` 1,093 (187 in bodies) · `JSON` 170 · `Date` 163 | | |
| `with` | 192 (2.2 %) | 192 |
| any built-in global or prototype method | 6,761 (77.6 %) | |

Need-set size: 0 groups 514 files · 1: 1,222 · 2: 1,479 · 3: 1,643 · 4: 1,153 · 5: 951 · 6: 471 · 7: 126 · 8 or more:
1,158. Median 3. Includes: 905 files pull `propertyHelper.js` (510 lines: for-in, `arguments`, descriptors, `Function`,
`String()` 19×), 89 `fnGlobalObject.js`, 58 `testIntl.js`, 30 `compareArray.js`.

### Cumulative cover in the plan's order [measured, syntactic upper bound on files that could compile]

| after | files | share | step |
|---|---:|---:|---:|
| nothing beyond the prelude's own mechanisms | 514 | 5.9 % | (148 pass today behind the stand-in) |
| + O literals | 580 | 6.7 % | +66 |
| + Fa | 631 | 7.2 % | +51 |
| + Fb | 697 | 8.0 % | +66 |
| + C | 787 | 9.0 % | +90 |
| + `Object` statics and `Object.prototype` methods | 1,313 | 15.1 % | +526 |
| + Error family | 1,661 | 19.1 % | +348 |
| + `String` and its methods, `toString`/`valueOf` | 2,261 | 25.9 % | +600 |
| + `Number`, `Boolean`, `Math`, `isNaN`/`parseInt`/… | 3,126 | 35.9 % | +865 |
| + `Array` and its methods | 3,376 | 38.7 % | +250 |
| + `call`/`apply`/`bind`, `Function` as a value | 3,681 | 42.2 % | +305 |
| + script-scope shapes (repeated `var`, block functions, global `this`, undeclared writes) | 4,452 | 51.1 % | +771 |
| + `delete`, for-in, `arguments` | 5,061 | 58.1 % | +609 |
| + accessors | 6,506 | 74.6 % | +1,445 |
| + RegExp | 7,182 | 82.4 % | +676 |
| + JSON, URI functions, `Date` | 7,531 | 86.4 % | +349 |
| + `with` | 7,667 | 88.0 % | +136 |
| + `eval` / `Function()` | 8,713 | 100 % | +1,046 |

A greedy order (`cover.mjs`) is as flat: no step frees more than 454 files, 30 steps reach 79 %. That is the same shape
the ordinary census found on 2026-11-14 ("No single lever dominates").

### What the first-gap lists hide [measured, syntactic; `hidden.mjs`]

| first-gap family (lists) | first-gap files | freed by that family alone | other mechanism groups needed per file |
|---|---:|---:|---:|
| O · #7352 | 1,862 | 39 (2 %) | 6.5 |
| Fa · #7349 | 614 | 25 (4 %) | 2.9 |
| Fb · #7349 (with Fa) | 1,285 | 20 (2 %) | 3.0 |
| C · #7349 | 982 | 285 (29 %) | 2.1 |
| B · #7350, #7369, RegExp and Object-static crashes | 2,560 | 854 (33 %) | 1.9 |
| script scope (S10) | 659 | 106 (16 %) | 2.2 |
| eval · #7363 | 292 | 162 (55 %) | 0.5 |
| sum | 8,254 | 1,491 (18 %) | |

The ordinary census agrees on depth: its 6,824 blocked files carry one reason 1,838 · two 2,167 · three 1,194 · four 588
· five or more 1,037 [quoted, 11-19], and that count is itself one refusal per statement.

**Long tail on P:** `eval`/`Function()` 1,050 files (12.0 %), `with` 192, accessors 1,669, RegExp 747, `Date` 163.
No IR-only path passes 88 % of ES5 without an answer for `eval`.

## 3. Ordinary pipeline

### Set cover [quoted from `es5-ir-only-census-2026-11-19.md` §2.3, main `ee3fcdd610`; 8,591 compiled files]

| stacked levers | zero-legacy files | share |
|---|---:|---:|
| today | 1,767 | 20.6 % |
| + function values (#7349) | 2,250 | 26.2 % |
| + built-in globals (#7350) | 2,573 | 29.9 % |
| + object / array literals (#7352) | 2,785 | 32.4 % |
| + eval and `with` | 2,981 | 34.7 % |
| + storage agreement (#7348) | 3,232 | 37.6 % |
| + Object statics (#7338) | 3,981 | 46.3 % |
| + primitive wrappers (#7340) | **4,376** | **50.9 %** |
| + RegExp, `assert.js`/`sta.js` units, `delete`, post-claim errors, parameter carriers, own-property methods | 5,261 | 61.2 % |
| + `propertyHelper.js`, call-graph bridge, other harness files, `new Object()` (all 17 levers) | 6,065 | 70.6 % |

- **50 %** needs seven levers. **90 % (7,732 files) is not reached by any named lever set:** 2,526 blocked files carry a
  reason no lever covers. On 2026-11-14 that tail was 393 distinct reasons.
- These are upper bounds. `ir-behind-the-selector-2026-11-13.md`: with the selector forced open on 600 blocked files,
  8 % of legacy units built, 44 % failed after the claim, 8 % crashed; 15 of 600 files became IR-only.
- Trend [quoted]: 1,088 (11-06) → 1,601 (11-14) → 1,767 (11-19), about 52 files a day.

### Which files are the 1,767? [measured; 900-file uniform sample, `ordinary-sample.jsonl`]

- Sample: 847 compiled, 174 zero-legacy (20.5 %; the census says 20.6 %).
- **Zero-legacy files are tests whose body is one top-level block.** Over all 977 compiled rows (the sample plus the
  148 Prepared-pass files): 290 of 300 zero-legacy rows have exactly 9 units, the 8 prelude functions plus
  `<module-init>`. In 676 of 677 blocked rows the test's `<module-init>` is a legacy unit. So on this corpus the
  selector's per-function grain does little: the body is one unit, taken or not.
- **On O the IR already compiles the real prelude** (`assert.js`, `sta.js`, the shim) in those files, and 1,759 of the
  1,767 pass [quoted]. P compiles it in none.

### Zero-legacy files on the Prepared path [measured]

- All 148 Prepared-pass files (stand-in) run through O: 143 are zero-legacy, 5 are blocked.
- So of the 1,767 zero-legacy files **about 143 (8 %) pass on P behind the stand-in, and 0 with the real prelude.** The
  uniform sample gives the same picture (17 of 174, 9.8 %).
- Where the other 157 sampled zero-legacy files stop on P: `new Test262Error` / `new` / `this` 42 · built-in global as
  a value 28 · RegExp crash 21 · object-literal script var 15 · built-in call 14 · repeated `var` 9 · call through a
  value 8 · native provider missing 8 · async 5 · other 7.

### What O gets from legacy that P lacks

1. **The runtime library.** One trivial zero-legacy test (`language/future-reserved-words/final.js`) compiles to
   349,861 bytes and 768 functions: 8 unit bodies, about 36 closures, about 720 legacy-emitted helpers
   (`__builtin_*` 116, `__proxy_*` 54, `__str_*` 43, `__vec_*` 30, `__any_*` 30, `__object_*` 26, …). The same test on
   P behind the stand-in is about 6 KB and 8–13 functions.
2. **The resolver.** 59 of 66 from-ast hooks and 32 of 36 lowering hooks, answered from `CodegenContext`.
3. **Module assembly:** type registry, function index space, late imports, string constants, exception tag,
   script-var homes (`scriptVarHome` is imported from `src/codegen/index.ts`).
4. **A compiled body for every unit.** In 8 of 8 zero-legacy files, 8 of 9 units report `legacyBodyEmitted: true`;
   the IR body replaces it at stage `patch`.
5. **A fallback.** A refusal costs one unit, not the file.

### Why "O at 100 % zero-legacy" cannot simply be the goal

- It does not end with legacy deletable (points 1–4). The metric stays green while legacy still compiles and ships
  most of the module.
- The runtime is not separable from the AST compilers (finding 3), so deleting "the hacks" under O still needs the
  extraction P is doing.
- The selector admits a unit only if it agrees with legacy's storage and calling convention
  (`param-dynamic-carrier-diverges-from-legacy`, "typeIdx parity mismatch — keeping legacy body"). That preserves the
  representations the 2026-11-15 decision says not to mirror.
- Its named levers stop at 70.6 %.

## 4. Is the harness prelude the right first obstacle?

- **Size:** shim `scripts/test262-fyi-runtime.js` 111 lines + `assert.js` 184 + `sta.js` 28 = 323 lines.
  `propertyHelper.js` is 510 more for 905 files.
- **Who needs what:** 7,654 of 8,717 positive files (87.8 %) have no include beyond `assert.js` + `sta.js`. 7,733 use
  only `assert`, `assert.sameValue`, `assert.notSameValue`, `assert.throws`, `new Test262Error`, `$DONE`. 490 call no
  harness function at all.
- **Constructs** [measured; `prelude.mjs`]:
  - `assert.js`: 6 function declarations, 6 function expressions, 30 calls (13 through a member), 37 member accesses,
    7 `typeof`, 8 `new`, 9 `throw`, 3 `try`, 1 `switch`; globals `String` ×7, `JSON` ×2, `Object`, `Array`.
  - `sta.js`: 2 declarations, 2 function expressions, `this` ×3, `new` ×2, `instanceof`.
  - shim: `globalThis` ×22 and one read each of `Array`, `Boolean`, `Date`, `Function`, `Map`, `Math`, `Number`,
    `Object`, `Promise`, `Proxy`, `RegExp`, `Set`, `String`, `Symbol`, `WeakMap`, `parseInt`, seven Error
    constructors, `eval` ×2, `console`.
- **Verdict.** The prelude forces function values, function objects, `new`/`this`, dynamic member access and a few
  built-ins. Those are needed by a third or more of the bodies, so the work is not wasted. But it is a poor first
  *measure*:
  - it reads 0 until every slice lands, then steps;
  - behind it only 148 files (1.7 %) pass, and only 514 (5.9 %) can by syntax, so the bodies are the wall (#7354 says
    the same: "the test bodies are the larger wall");
  - the shim makes ES2015+ globals a precondition for ES5 test number one, for 21 files' sake.
- **Linked harness.** The repository has it: `src/test262-harness-provider.ts` (528 lines) compiles a prefix once and
  links bodies through getter imports "over the frozen cross-module type group"; there are 64 distinct prefixes. It is
  built on the ordinary pipeline (`compileMulti`) and is authoritative for the JS-host lane only. For P it would need:
  1. an import arm in the Prepared presentation (today a host or provider demand is refused: "outside this numeric
     presentation contract");
  2. a member read and a call on a foreign function object (`assert.sameValue`), which are the missing O and Fb slices;
  3. type identity between P's reserved `$Object` group and the provider's. The layouts are mirrored by convention;
     I did not verify they canonicalise to the same type.
  So it is not available within days. **What it would measure today:** at most the stand-in figure, 148 of 8,717
  (1.7 %), because the stand-in is the friendlier case (direct calls to plain functions). I did not build it.
- **Cheaper fixes to the measure:** emit the shim's `$262` only for files that name it (the stand-in already does this
  for its own functions), and publish the stand-in count per merge beside the real one.

## 5. Cost table

| | P: Prepared path | O: ordinary pipeline | F: IR-owned files (#7348) | H: Prepared driver, legacy runtime borrowed |
|---|---|---|---|---|
| status today | 0 of 8,717 real; 148 stand-in [quoted]; 6 of 37 probes [measured] | 1,767 of 8,591 zero-legacy, 1,759 pass [quoted] | parked: 41 of 1,438 blocked files claim every unit, ≈ 200 projected [quoted] | not built |
| new code still to write [estimate] | 59 from-ast and 25 lowering hooks; move 50–80 k lines of ES5-relevant legacy runtime into pure builders with manifests (6 k shared today); `eval` for 1,024 files; script-scope shapes; compile-time fix (18 s with the realm) | lowering + selector + resolver for 17 levers and a ≈ 400-reason tail: 20–40 k lines; then the driver flip and runtime extraction, which is P's work again | O's work plus one storage authority | P's front-end work (hooks, scope shapes, `eval`) plus one adapter that lets Prepared code call ctx-emitted helpers; runtime moves leave the critical path |
| reuse of legacy runtime | 6,094 lines shared; the rest must move | all of it (215 symbols) | all of it | all of it at first |
| risk of dead end | no dead end, but the library is the long pole and each move is gated by legacy byte identity | stalls near 70 % on named levers; metric cannot show legacy leaving | measured small | adapter may not compose with the reservation ledger (unverified); the two type spaces must merge |
| ends with legacy deletable | yes: AST compilers when coverage is complete, runtime as it moves. Today P needs 2 functions from `src/codegen` | no | no | AST compilers yes; runtime emitters only after later moves, and they import the AST compilers today |
| earliest real-harness positive pass [estimate] | 1–3 weeks from 11-19 (slices Fa, O2–O4, Fb, C, B and the shim's globals; ≈ 5,000 `src` lines landed in the 4 days since 11-15); days sooner if `$262` is not emitted for files that do not name it | already: 1,759 | already | after the adapter, about when P's Fa/Fb/C land |
| what CI can track | real-prelude pass (exists since #7262), stand-in pass, first-gap tally | zero-legacy files and their pass count; should add "units where legacy emitted no body" | same as O | P's metrics, plus a count of helpers still served by ctx |

Basis of the estimates: runtime sizes from `wc -l` on `object-runtime*.ts` (≈ 20 k), `native-regex.ts` + `regex/` +
`regex-runtime/` (≈ 11 k), `json-codec-native.ts` (4.6 k), `array-object-proto.ts` (4.5 k), `type-coercion.ts` (5.1 k),
strings (≈ 8 k), `any-helpers.ts` + `dyn-read.ts` (3.7 k), then rounded up for descriptors, wrappers, errors and number
formatting. The 20–40 k for O is the size of what exists (`select.ts` + `integration.ts` + `from-ast.ts` ≈ 43 k for
20.6 %) discounted for shared code. Neither is a measurement.

## 6. Which route, and what would change my mind

**P is the right end state and the only honest metric. O's count is not a measure of legacy leaving.** I would keep P as
the measured goal and change how it is run:

1. **Stop treating the prelude as the gate.** Emit `$262` only where named; put the stand-in pass count and my
   need-set cover in CI; order work by the cover table, not the first-gap table.
2. **Plan the library as the main body of work.** Function values and literals are 9 % of the corpus by need; built-ins
   are needed by 78 %. The native realm has 3 of 45 intrinsics available and no family beyond Object and Function.
3. **Spike H for a week before committing to pure moves:** make one Prepared program call one ctx-emitted helper
   (`Object.keys({a:1}).length`). If it composes, P gets the ES5 library at once and the moves can follow by family.
4. **Decide `eval` now.** 1,024 files (11.7 %) depend on it on every route.
5. **Keep O only as a regression guard.** Its last five days bought 166 files, all single-block bodies.

What would change my mind:

- **Towards pure P (no borrowing):** the H spike fails on type or index merging, or after the prelude milestone the
  stand-in count grows by more than about 300 files a week.
- **Towards O:** someone shows the runtime emitters can be cut loose from the AST compilers cheaply (today every one
  imports all of `src/codegen`), and IR-first can skip every legacy body in a zero-legacy file. Then "O plus a driver
  flip" ends with the AST compilers deletable at lower cost.
- **Against all of them:** a measured cost per moved runtime family (lines, days, byte-identity failures) that puts
  the ES5 library beyond a quarter.

## 7. Not verified

- The syntactic cover is an upper bound on what compiles and says nothing about what passes.
- Legacy/runtime line splits are heuristics over `src/codegen`.
- The hook counts are name matches in the listed files, not a type-level check.
- Dual legacy emission was probed on 8 zero-legacy files, not all 1,767.
- I did not run a full census; the 143-file intersection uses the committed lists (main `ee3fcdd610`) against my
  ordinary run (main `89e47482`).
- Linked-harness and H feasibility were read from code, not built.
- The repository clone is shallow (history from 2026-10-25), so dates of older Prepared work come from plan logs.
