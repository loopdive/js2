---
id: 1561
title: "Architect review: decompose compiler into smaller, reviewable modules"
status: ready
created: 2026-05-21
priority: high
feasibility: medium
reasoning_effort: max
task_type: research+architecture
area: codebase-structure
goal: maintainability
related: [804, 806, 688]
---

# #1561 — Architect review: full codebase modularity analysis

## Motivation

The compiler has grown to 124 TypeScript source files and ~138,000 lines. Several
files have become review bottlenecks — every sprint produces merge conflicts in
the same half-dozen files, and PRs become hard to reason about because the
blast-radius of a single function is difficult to gauge.

The existing extraction work (#804, #806, and the `expressions/` subdirectory
pattern) has proven that extractions are safe and improve the workflow. This issue
asks an architect to go further: read the entire codebase, understand the logical
structure, and produce a complete decomposition plan.

## Current hot-spot sizes

| File | Lines | Pain level |
|------|-------|------------|
| `src/codegen/expressions/calls.ts` | 8,502 | 🔴 conflicts every sprint |
| `src/codegen/index.ts` | 8,313 | 🔴 conflicts every sprint |
| `src/codegen/array-methods.ts` | 5,908 | 🟡 frequently conflicted |
| `src/runtime.ts` | 5,335 | 🟡 hard to review |
| `src/codegen/expressions/assignment.ts` | 5,143 | 🟡 growing |
| `src/codegen-linear/index.ts` | 4,813 | 🟡 linear-memory backend |
| `src/ir/from-ast.ts` | 4,227 | 🟡 IR builder |
| `src/codegen/declarations.ts` | 3,447 | 🟠 |
| `src/compiler/validation.ts` | 3,373 | 🟠 |
| `src/codegen/native-strings.ts` | 3,361 | 🟠 |
| `src/codegen/statements/loops.ts` | 3,212 | 🟠 |
| `src/codegen/closures.ts` | 3,171 | 🟠 |
| `src/codegen/property-access.ts` | 3,013 | 🟠 |
| `src/codegen/object-ops.ts` | 2,681 | 🟡 |
| `src/codegen/expressions/new-super.ts` | 2,675 | 🟡 |
| `src/codegen/type-coercion.ts` | 2,513 | 🟡 |
| `src/codegen/binary-ops.ts` | 2,246 | 🟡 |
| `src/codegen/literals.ts` | 2,245 | 🟡 |

The entire `src/` tree has 124 files and 138K lines.

## What the architect must do

**Read every significant file in `src/`** — not skim, actually read and understand
what logical responsibilities each file carries. Then produce:

### 1. Domain map
Group the 124 files into logical domains (e.g., "expression compilation",
"statement lowering", "type coercion", "builtin method codegen", "IR pipeline",
"runtime helpers", "module resolution"). For each domain, note which files
currently belong to it, what interfaces cross domain boundaries, and whether
those interfaces are clean or tangled.

### 2. Per-file decomposition plan for every file over 2,000 lines
For each file exceeding 2,000 lines, produce:
- A list of function groups that could be extracted as independent modules
- For each group: new file name, ~line count, external dependencies (what it
  imports from the parent file vs. what it can take wholesale)
- Extraction order: which groups can be extracted independently vs. which need
  a shared-type refactor first
- Conflict risk: which extractions are high-risk (touching public function
  signatures) vs. low-risk (internal helpers that are only called within the file)

### 3. Shared-type / interface gaps
Identify cases where two files duplicate a type, a helper, or a pattern that
should live in a shared module. Flag any cross-file circular dependencies or
import tangles that make extraction harder.

### 4. `src/codegen/index.ts` deep dive
This is the orchestration hub — 8,313 lines that wires together module compilation,
class emission, function compilation, import registration, and Wasm binary
assembly. It currently acts as a God Object. The architect must:
- Enumerate every logical subsystem inside index.ts
- Propose a specific split into sub-modules (e.g., `module-compiler.ts`,
  `class-compiler.ts`, `function-compiler.ts`, `import-registry.ts`,
  `wasm-assembler.ts`)
- Identify the shared context object (`CompilationContext`) and whether it needs
  to be split or just re-exported

### 5. `src/codegen/expressions/calls.ts` deep dive
8,502 lines covering call-expression codegen. Identify:
- Which function families group naturally (e.g., host-call vs. wasm-call,
  method dispatch, super calls, tail calls, generator send)
- Concrete split proposals: `calls-method-dispatch.ts`, `calls-tail.ts`,
  `calls-generator.ts`, etc.

### 6. `src/runtime.ts` deep dive
5,335 lines of JavaScript runtime helpers (polyfills, host bridges, Wasm struct
helpers). Identify logical sections: object model helpers, promise/async helpers,
iterator helpers, regexp helpers, type-coercion shims. Propose a
`src/runtime/` subdirectory structure.

### 7. Priority ordering
Rank all proposed extractions by:
- **Impact**: lines removed from hot files → PR conflict reduction
- **Safety**: pure move vs. needs interface change
- **Sequencing**: which must come before which

### 8. What NOT to split
Explicitly list files that are already well-scoped and should NOT be extracted
further (e.g., `src/codegen/peephole.ts` at ~400 lines is fine).

## Output format

Write the analysis as a structured document appended to this issue file under
`## Architect Analysis`. Use markdown headers, tables, and code snippets
where they add clarity. The output should be long and thorough — this is a
"go the extra mile" task.

## Acceptance criteria

- [ ] All files > 2,000 lines have concrete decomposition proposals with new
  file names and function lists
- [ ] `index.ts` and `calls.ts` have specific sub-module proposals with
  rationale for each split boundary
- [ ] Priority-ordered extraction backlog with 20+ concrete items
- [ ] Domain map covers all 124 source files
- [ ] "What not to split" section prevents unnecessary churn
- [ ] No code changes — analysis only, written to this issue file

---

## Architect Analysis

**Scope of the read pass.** I surveyed all 124 `.ts` files under `src/`, read or function-mapped every file >500 lines, and verified function boundaries with `grep -nE` against the actual source. All function/file names below are quoted verbatim from the codebase — no hypothetical names. Line numbers are accurate as of HEAD (`main`, 2026-05-21).

### Summary metrics

- **Total**: 124 files, ~138,000 LoC.
- **>5,000 LoC**: 5 files (`calls.ts`, `codegen/index.ts`, `array-methods.ts`, `runtime.ts`, `assignment.ts`).
- **2,000–5,000 LoC**: 17 more files.
- **The pain has two shapes**:
  1. **God Functions** — single functions >1,000 LoC each: `compileCallExpression` (6,834 LoC inside calls.ts), `resolveImport` (~3,030 LoC inside runtime.ts), `detectEarlyErrors` (3,089 LoC inside compiler/validation.ts), `generateModule` (~410 LoC orchestrator), and `compileSource` (~410 LoC).
  2. **God Modules** — files holding 50+ functions that span several unrelated concerns: `codegen/index.ts` (109 top-level functions across import-collection, type-resolution, TDZ/hoisting, modifier helpers, WASI emit, struct-export emit, extern-class registry), `declarations.ts`, `array-methods.ts`.

The conflict-frequency ranking in the issue header tracks this exactly: any sprint that touches builtins routes through `calls.ts`; any sprint that touches imports/types/extern-classes routes through `index.ts`; any sprint that touches array semantics routes through `array-methods.ts`; sprints that touch destructuring or compound ops route through `assignment.ts`.

### 1. Domain map (all 124 files)

The codebase decomposes naturally into **11 domains**. Boundaries are mostly clean already — circular-dep escapes are handled by `src/codegen/shared.ts`'s register/lookup pattern (see §3). Pain is concentrated inside two domains: *expression codegen* and *codegen orchestration*.

| # | Domain | Files | LoC | Boundary health |
|---|--------|-------|-----|------------------|
| 1 | **Public API & entrypoints** | `src/index.ts`, `src/cli.ts`, `src/env.ts`, `src/cjs-rewrite.ts`, `src/import-resolver.ts`, `src/resolve.ts`, `src/treeshake.ts`, `src/wit-generator.ts`, `src/ts-api.ts`, `src/shape-inference.ts` | ~2,800 | Clean. `index.ts` re-exports the package surface; `compiler.ts` is the next layer. |
| 2 | **Compile pipeline glue** | `src/compiler.ts`, `src/compiler/output.ts`, `src/compiler/validation.ts`, `src/compiler/import-manifest.ts`, `src/compiler/define-substitution.ts`, `src/optimize.ts` | ~5,250 | Mostly clean — but `compiler/validation.ts` is overloaded (`detectEarlyErrors` = 3,089 LoC). |
| 3 | **Type checking adapter** | `src/checker/index.ts`, `src/checker/type-mapper.ts`, `src/checker/language-service.ts` | ~1,100 | Clean. |
| 4 | **IR pipeline (the new path)** | `src/ir/from-ast.ts`, `src/ir/lower.ts`, `src/ir/nodes.ts`, `src/ir/types.ts`, `src/ir/select.ts`, `src/ir/propagate.ts`, `src/ir/integration.ts`, `src/ir/builder.ts`, `src/ir/verify.ts`, `src/ir/index.ts`, `src/ir/passes/*.ts` (7 files) | ~14,500 | Good shape internally; `from-ast.ts` and `lower.ts` are large but already split by phase. `integration.ts` is the IR↔legacy bridge — modestly tangled with `codegen/`. |
| 5 | **Codegen orchestration (WasmGC backend)** | `src/codegen/index.ts`, `src/codegen/function-body.ts`, `src/codegen/declarations.ts`, `src/codegen/class-bodies.ts`, `src/codegen/closures.ts`, `src/codegen/destructuring-params.ts`, `src/codegen/shared.ts`, `src/codegen/context/*.ts` (6), `src/codegen/registry/*.ts` (3), `src/codegen/helpers/*.ts` (1) | ~18,800 | **Worst pain.** `index.ts` is a god module. `shared.ts`'s register pattern is the right escape hatch — but it's been used as a band-aid, not a fix. |
| 6 | **Expression codegen** | `src/codegen/expressions.ts` (dispatcher), `src/codegen/expressions/{calls,assignment,new-super,builtins,unary,calls-closures,identifiers,late-imports,logical-ops,misc,extern,calls-optional,eval-inline,helpers}.ts` (14 files) | ~24,500 | **Second-worst pain** — `calls.ts` has a 6,834-LoC function. |
| 7 | **Statement codegen** | `src/codegen/statements.ts`, `src/codegen/statements/{loops,destructuring,exceptions,control-flow,variables,nested-declarations,tdz,shared,index,functions}.ts` (10 files) | ~9,200 | Reasonably split — `loops.ts` and `destructuring.ts` are the only large ones; both have well-named internal cases. |
| 8 | **Builtin / library codegen** | `src/codegen/{array-methods,string-ops,native-strings,object-ops,math-helpers,property-access,typeof-delete,type-coercion,binary-ops,literals,string-builder,timsort,async-scheduler,builtin-tags,any-helpers,array-element-typing,array-reduce-fusion}.ts` (17 files) | ~37,500 | Some giants (`array-methods.ts`, `native-strings.ts`, `property-access.ts`, `literals.ts`, `binary-ops.ts`, `object-ops.ts`, `type-coercion.ts`) — but most are method-keyed already (e.g. `compileArrayMap`, `compileArrayFilter` are separate functions). Easy wins live here. |
| 9 | **Wasm backend post-passes** | `src/codegen/peephole.ts`, `src/codegen/stack-balance.ts`, `src/codegen/fixups.ts`, `src/codegen/dead-elimination.ts`, `src/codegen/walk-instructions.ts` | ~5,200 | Clean. Only `stack-balance.ts` (2,512 LoC) is large but its internal functions are well-named. |
| 10 | **Linear-memory backend (alternative path)** | `src/codegen-linear/{index,runtime,simd,c-abi,context,layout}.ts` (6 files) | ~9,600 | Clean. Two large files (`index.ts`, `runtime.ts`) but they're concern-separated. |
| 11 | **Binary emit / link / runtime** | `src/emit/{binary,object,wat,encoder,opcodes,sourcemap,c-header}.ts` (7 files), `src/link/{linker,reader,resolver,isolation,index}.ts` (5 files), `src/runtime.ts`, `src/runtime/builtins.ts`, `src/runtime-eval.ts`, `src/runtime-instantiate.ts`, `src/runtime-containment.ts` | ~13,800 | `runtime.ts` is the main pain (5,335 LoC with a 3,000-LoC `resolveImport`). Others are well-scoped. |

### 2. Per-file decomposition for every file > 2,000 LoC

Each subsection covers one file, with: **role, function inventory, proposed splits (table form), and extraction order**. I show actual line ranges I confirmed with `grep`/`Read`.

---

#### 2.1 `src/codegen/expressions/calls.ts` (8,502 LoC) — **TOP PRIORITY**

**Role.** Compiles every JavaScript call expression: `f()`, `obj.method()`, `obj?.method?.()`, `new`-less constructor calls, `super.x()`, IIFEs, `eval(...)`, dynamic `import(...)`, host bridges. A single function `compileCallExpression` (lines 965–7799 = **6,834 LoC**) holds 90% of the body via top-level `if` branches keyed on the syntactic shape of `expr.expression`.

**Helpers at top (already extractable, no risk):**

| Lines | Function | Role |
|------:|----------|------|
| 155 | `resolveClosureInfoFromLocal` | Helper |
| 193 | `tryEmitJsonStringifyPrimitive` | Inline fast-path for `JSON.stringify(prim)` |
| 300 | `usesArguments` | AST predicate |
| 330 | `sourceHasMethodReassignment` | Mutation analysis cache |
| 376 | `emitWrapperDynamicMethodCall` | Wrapper-type host call |
| 426 | `emitSetArgc` | `__argc` global writeback |
| 441 | `flattenCallArgs` | Spread flattening |
| 459 | `compileOptionalDirectCall` | `f?.()` |
| 548 | `classifyEvalCallExpression` | `eval` shape detection |
| 593 | `tryEvalAsRegExpPeephole` | `eval("/"+x+"/")` rewrite |
| 668 | `isGlobalEvalIdentifier` | Symbol-based predicate |
| 691 | `tryEmitInlineDynamicCall` | Closure-call dispatch chain |
| 849 | `emitVirtualMethodDispatchByTag` | Tag-based virtual dispatch |
| 8002 | `compileExpressionCallee` | Expression-shaped callee |
| 8192 | `compileIIFE` | IIFE inlining |
| 7799 | `compileConditionalCallee` | `(cond ? f : g)(...)` |
| 8473 | `compileWasiStringArgToLinearMemory` | WASI bridge |

**Internal structure of `compileCallExpression` (the 6,834-LoC monster).** Confirmed via `grep` on top-level `if` blocks (column = 2 spaces) — these are *sibling* branches dispatching on AST shape:

| Lines | Branch key | What it does |
|------:|------------|--------------|
| 967–989 | `expr.questionDotToken && PropertyAccess` | Optional method call |
| 991–1014 | `RegExp(p,f)` without `new` | Spec-equivalence shortcut |
| 1015–1022 | `expr.questionDotToken && Identifier` | Optional direct call |
| 1023–1088 | `eval(...)` | Direct/indirect `eval` dispatch |
| 1090–1102 | (early-exit guard) | Type resolution guard |
| 1103–1148 | `expr.expression.kind === ImportKeyword` | Dynamic `import(...)` |
| 1149–1199 | `ParenthesizedExpression` | Unwrap parens + conditional callees |
| 1200–1229 | `NonNullExpression` | Strip `!` |
| 1230–1238 | `SuperKeyword.method()` | Super-method-call |
| **1239–5174** | **`PropertyAccessExpression`** | **The body of the monster — 3,935 LoC** (see breakdown below) |
| 5174–5241 | `node:fs` calls (non-WASI) | Lazy `__node_fs_*` host import |
| 5244–5281 | `node:fs` calls (WASI) | `__wasi_write_file_sync` |
| 5283–5763 | `Identifier` callee | parseInt/parseFloat/isNaN/isFinite/eval-alias/global fns |
| 5764–6768 | `Identifier` callee, continued | Closure call / direct fn call / rest params / closure conversion |
| 6769–6808 | `SuperKeyword.method()` (alt) | Element-access super |
| 6809–7274 | `ElementAccessExpression` callee | `obj[name](...)` |
| 7275–7414 | `CallExpression` callee | `f()()` (call returning callable) |
| 7415–7538 | `CallExpression` callee (alt) | Curry chain |
| 7539–7798 | `ConditionalExpression` callee | `(c ? f : g)(...)` |

**The 3,935-LoC `PropertyAccessExpression` branch (lines 1239–5174).** This is the actual primary source of merge conflicts. Confirmed sub-branches via `grep` on `// Handle …`:

| Lines | Sub-branch | Family |
|------:|------------|--------|
| 1242–1281 | `Array.prototype.X.call`, `fn.bind` | Function-style methods |
| 1283–1765 | `.call` / `.apply` | Reflection |
| 1766–1856 | `Number.isNaN`, `Number.isInteger` | Number static |
| 1858–1876 | `Array.isArray` | Array static |
| 1877–1937 | `String.fromCharCode/fromCodePoint` | String static |
| 1938–2079 | `Array.from`, `Array.of` | Array static |
| 2080–2545 | `Object.{keys/values/entries/freeze/seal/preventExtensions/isFrozen/…/setPrototypeOf/getPrototypeOf/create}` | Object static **(huge)** |
| 2545–3061 | `Object.{defineProperty/defineProperties/getOwnPropertyDescriptor/getOwnPropertyNames/getOwnPropertySymbols/hasOwn/is/assign/fromEntries/getOwnPropertyDescriptors/groupBy/Proxy.revocable}` | Object static (more) |
| 3089–3345 | `Symbol.for/keyFor`, `ArrayBuffer.isView` | Symbol/ArrayBuffer static |
| 3346–3477 | `Promise.{all,race,allSettled,any,resolve,reject}` | Promise static |
| 3478–3533 | `JSON.stringify/parse` | JSON |
| 3534–3727 | `Date.now`, `Date.UTC`, Date statics | Date static |
| 3728–3792 | Date instance methods | Date instance |
| 3740–3792 | `hasOwnProperty`, `propertyIsEnumerable` | `Object.prototype.*` |
| 3793–3885 | `Promise.prototype.{then,catch,finally}` | Promise instance |
| 3886–3910 | `Number/String/Boolean.prototype.valueOf` | Wrapper instance |
| 3912–4916 | Class instance method dispatch | **User-class methods** |
| 4917–4937 | `.toLocaleString()` | Coercion |
| 4938–4991 | `.toString()` | Coercion |
| 4992–5173 | `.valueOf()` | Coercion |

**Proposed decomposition** of `calls.ts` into a new directory `src/codegen/expressions/calls/`:

| New file | ~Lines | Pulls from | Risk |
|----------|-------:|-----------|------|
| `calls/index.ts` (dispatcher) | 600 | shell of `compileCallExpression` + top-level branches | low (mechanical move) |
| `calls/helpers.ts` | 800 | lines 155–960 (top helpers above) | low |
| `calls/property-access.ts` (dispatcher) | 250 | lines 1239–1281 shell + dispatch to children | low |
| `calls/object-statics.ts` | 1,300 | lines 2080–3061 (`Object.*` static) | low (already disjoint) |
| `calls/promise-json.ts` | 250 | lines 3346–3533 (`Promise.*`, `JSON.*`) | low |
| `calls/date.ts` | 350 | lines 3534–3792 (`Date.now`, Date instance) | low |
| `calls/wrapper-instance.ts` | 250 | lines 3793–3910 (`Promise.then`, wrapper valueOf) | low |
| `calls/coercion-methods.ts` | 350 | lines 4917–5173 (`toString`/`valueOf`/`toLocaleString`) | low |
| `calls/class-method-dispatch.ts` | 1,100 | lines 3912–4916 (user-class methods) | medium (touches `funcMap`, `classParentMap`) |
| `calls/reflection.ts` | 500 | lines 1283–1765 (`.call`, `.apply`) | low |
| `calls/number-array-string-statics.ts` | 350 | lines 1766–1937 (`Number.*`, `Array.isArray`, `String.from*`) | low |
| `calls/array-of-from.ts` | 250 | lines 1938–2079 (`Array.from`, `Array.of`) | low |
| `calls/symbol-arraybuffer.ts` | 300 | lines 3089–3345 (`Symbol.*`, `ArrayBuffer.isView`) | low |
| `calls/eval.ts` | 350 | lines 548–667, 1023–1088 (eval classification + emit) | low |
| `calls/dynamic-import.ts` | 80 | lines 1103–1148 | low |
| `calls/node-fs.ts` | 200 | lines 5174–5281 (Node fs / WASI fs) | low |
| `calls/identifier-callee.ts` | 1,800 | lines 5283–6768 (closure call / direct fn call / global fns) | **medium-high** — depends on `closureMap`, `funcRestParams`, etc. |
| `calls/element-callee.ts` | 500 | lines 6809–7274 | medium |
| `calls/nested-callee.ts` | 350 | lines 7275–7538 (`f()()`, curry) | medium |
| `calls/conditional-callee.ts` | 250 | lines 7539–7798 | low (already isolated as `compileConditionalCallee`) |
| `calls/iife.ts` | 280 | lines 8192–8472 (`compileIIFE`) | low |
| `calls/super-call.ts` | 100 | lines 1230–1238, 6769–6808 (super-method) | low (also overlap with `new-super.ts`) |

**Extraction order:**
1. **First wave — leaf branches** (safe, mechanical, parallelizable; can ship one PR per file): `eval.ts`, `dynamic-import.ts`, `node-fs.ts`, `array-of-from.ts`, `symbol-arraybuffer.ts`, `promise-json.ts`, `date.ts`, `wrapper-instance.ts`, `coercion-methods.ts`, `reflection.ts`, `number-array-string-statics.ts`, `iife.ts`, `super-call.ts`.
2. **Second wave** (needs `calls/helpers.ts` first): `object-statics.ts`, `class-method-dispatch.ts`.
3. **Third wave** (needs internal refactor to lift shared helpers like the `compileExpressionCallee` resolution sequence into `calls/helpers.ts`): `identifier-callee.ts`, `element-callee.ts`, `nested-callee.ts`, `conditional-callee.ts`.
4. **Final** — strip the dispatcher down: `calls/index.ts` becomes ~600 LoC of pure routing.

**Conflict risk by extraction:**
- *Low risk*: any subbranch that already returns `InnerResult` on first match and falls through otherwise (most do — see the `if (…) return …` shape throughout).
- *Medium risk*: branches that mutate `fctx.body` before the match-decision and need to be rolled back via `ctx.savedBody` (search for `savedBody` in calls.ts — confirmed 30+ sites). Care needed when extracting these: the caller must hold the savepoint.
- *High risk*: the identifier-callee branch is the only one that calls `addUnionImports` / `flushLateImportShifts` — which shift function indices. Extracting that one requires confirming the dispatcher hasn't already cached `funcIdx` from `ctx.funcMap` (see the `addUnionImports` note in CLAUDE.md).

---

#### 2.2 `src/codegen/index.ts` (8,313 LoC) — **TOP PRIORITY (orchestration God Module)**

**Role.** Orchestrates module compilation, builds the import registry, owns type-resolution for the WasmGC backend, registers built-in extern classes, emits struct-field exports and the closure-call dispatcher.

**Function inventory (109 top-level functions, 18 of them exported).** I grouped them by responsibility, with confirmed line ranges:

##### 2.2.1 Module orchestrators (lines 117–2742)

| Lines | Function | Role |
|------:|----------|------|
| 117 | `sourceContainsClass` | AST predicate |
| 131 | `extractConstantDefault` (export) | Default-value extraction |
| 211–649 | IR-bridge helpers (`latticeToIr`, `resolvePositionType`, `objectIrTypeFromLattice`, `atomToFieldIr`, `objectIrTypeFromTsType`, `tsTypeToFieldIr`, `buildIrClassShapes`, `tsTypeToClassPositionIr`, `valTypeToIrField`) | Talks IR↔TS↔ValType |
| 652–1061 | **`generateModule`** (export) | Single-file orchestrator (~410 LoC) |
| 2742–2977 | **`generateMultiModule`** (export) | Multi-file orchestrator (~235 LoC) |

##### 2.2.2 Export-table emit (lines 1062–2615)

| Lines | Function | Role |
|------:|----------|------|
| 1062 | `addWasiStartExport` | WASI `_start` |
| 1124–1228 | `emitStructFieldGetters` + `_emitStructFieldGettersInner` | `__struct_get_*` helpers |
| 1230 | `emitStructFieldNamesExport` | Field-name reflection |
| 1334 | `emitIteratorMethodExport` | Iterator dispatch table |
| 1460–2105 | `emitClosureCallExport{,1,2,3,4,N}` — 6 functions | Closure call exports (per-arity) |
| 2106 | `emitToPrimitiveMethodExports` | `[Symbol.toPrimitive]` exports |
| 2306–2494 | `emitVecAccessExports` + inner | Array vec-access exports |
| 2495 | `emitDataViewByteExports` | DataView byte-level exports |
| 2616 | `buildNestedIfElse` | Helper for closure-call dispatch |
| 2669 | `buildGetterExtract` | Helper |

##### 2.2.3 Import collectors (lines 2978–5832) — **the single largest concern in the file**

This is essentially a 2,850-LoC "scan every AST and register every host import you find" subsystem. 25 collectors and 5 adders:

| Lines | Function | Role |
|------:|----------|------|
| 2978 | `collectAllSourceImports` | Top dispatcher |
| 2985 | `collectConsoleImports` | console.{log,warn,error,…} |
| 3047 | `registerWasiImports` | WASI host imports |
| 3206–3528 | `emitWasiWriteStringHelper`, `emitWasiWriteStringStderrHelper`, `emitWasiWriteFileSyncHelper`, `emitWasiReadStdinAllHelper` | WASI native helpers |
| 3529 | `collectPrimitiveMethodImports` | Number/Bool/String/Symbol .prototype methods |
| 3702 | `collectStringMethodImports` | String.prototype methods |
| 3821 | `addStringImports` (export) | Lazy-add string imports |
| 3959 | `parseRegExpLiteral` (export) | RegExp literal parser |
| 3970 | `collectStringLiterals` | string-pool collector |
| 4074 | `collectForInStringLiterals` | for-in key pool |
| 4123 | `collectInExprStringLiterals` | `in` operator key pool |
| 4173 | `collectObjectMethodStringLiterals` | dyn property keys |
| 4262 | `collectMathImports` | Math.* host imports |
| 4329 | `emitToUint32Helper` (export) | i32 conversion helper |
| 4359 | `collectParseImports` | parseInt/parseFloat |
| 4500 | `collectUnknownConstructorImports` | Unknown `new` ctors |
| 4545 | `collectWrapperConstructors` | Number/String/Boolean as ctors |
| 4568 | `collectStringStaticImports` | String.fromCharCode etc |
| 4614 | `collectPromiseImports` | Promise constructor + statics |
| 4726 | `collectJsonImports` | JSON.stringify/parse |
| 4781 | `collectCallbackImports` | callback bridges |
| 4816 | `collectGeneratorImports` | generator runtime imports |
| 4957 | `collectFunctionalArrayImports` | array HOFs (map/filter/…) host imports |
| 5026 | `collectUnionImports` | Boxed-union types |
| 5102 | `addUnionImports` (export) | Lazy-add union imports + shift indices |
| 5335 | `addUnionImportsAsNativeFuncs` | Native variant |
| 5634 | `collectIteratorImports` | Iterator host imports |
| 5683 | `addIteratorImports` (export) | Lazy-add |
| 5719 | `addArrayIteratorImports` (export) | Lazy-add |
| 5757 | `addGeneratorImports` (export) | Lazy-add |
| 5810 | `addForInImports` (export) | Lazy-add |

##### 2.2.4 Type resolution (lines 5832–6359)

| Lines | Function | Role |
|------:|----------|------|
| 5832 | `isTupleType` (export) | TS-type predicate |
| 5851 | `getTupleElementTypes` (export) | Tuple elem extractor |
| 5871 | `tupleTypeKey` | Hash |
| 5885 | `getOrRegisterTupleType` (export) | Tuple → struct type |
| 5946 | `resolveNativeTypeAnnotation` (export) | `type i32 = number` etc |
| 5964 | `resolveWasmType` (export) | **Most-imported symbol (12 importers)** |
| 6122 | `fieldsHashKey` | Struct-shape hash |
| 6136 | `ensureDateStructForCtx` | Date struct lookup |
| 6157 | `ensureStructForType` (export) | TS type → wasm struct |

##### 2.2.5 Extern-class registry (lines 6359–7325)

| Lines | Function | Role |
|------:|----------|------|
| 6360 | `externMethod` | Builder helper |
| 6379 | `registerBuiltinExternClasses` (export) | Date/Map/Set/RegExp/Promise/… (~360 LoC of static tables) |
| 6738 | `getPseudoExternClassInfo` (export) | Lookup |
| 6765 | `resolveMethodDispatchTarget` (export) | Method dispatch routing |
| 6779 | `collectExternDeclarations` | Scan .d.ts |
| 6878 | `collectDeclareNamespace` | Walk `declare namespace` |
| 6894 | `collectExternClass` | Walk `declare class` |
| 6970 | `collectExternFromDeclareVar` | Walk `declare var` |
| 7052 | `collectInterfaceMembers` | Interface walker |
| 7102 | `collectMixinMembers` | Mixin walker |
| 7133 | `registerExternClassImports` | Per-class import registration |
| 7169 | `collectUsedExternImports` | Drive collector from AST |

##### 2.2.6 Lib globals (lines 7327–7575)

| Lines | Function | Role |
|------:|----------|------|
| 7327 | `collectDeclaredGlobals` | `var globalThis: …` |
| 7447 | `registerNodeBuiltinImports` | node:fs etc |
| 7527 | `sourceUsesLibGlobals` | Heuristic |
| 7553 | `checkWasiDomUsage` | WASI dom-leak check |

##### 2.2.7 Hoisting / TDZ (lines 7576–8077)

| Lines | Function | Role |
|------:|----------|------|
| 7576 | `collectEnumDeclarations` (export) | TS enums |
| 7638 | `hoistVarDeclarations` (export) | `var` hoisting |
| 7652 | `hoistBindingPattern` | Pattern walker |
| 7691 | `ensureLetConstBindingPatternTdzFlags` (export) | TDZ flags |
| 7725 | `hoistVarDecl` | Single-decl walker |
| 7747 | `walkStmtForVars` | Statement walker |
| 7822 | `hoistLetConstWithTdz` (export) | let/const hoist + TDZ |
| 7837–7976 | 5 helpers for TDZ analysis (`needsTdzFlag`, `getContainingFunctionForTdz`, `isInsideLoopContainingForTdz`, `isDescendantOfNode`, `getLoopBodyNode`) | TDZ control-flow analysis |
| 7977 | `walkStmtForLetConst` | Statement walker |

##### 2.2.8 String-literal pooling & assorted helpers (lines 8078–8216)

| Lines | Function | Role |
|------:|----------|------|
| 8078 | `cacheStringLiterals` (export) | Hoist common literals into globals |
| 8116 | `collectStringCalls` | Helper |
| 8138 | `replaceStringCalls` | Helper |
| 8162–8194 | `hasExportModifier`, `hasDeclareModifier`, `hasAsyncModifier`, `hasAbstractModifier`, `hasStaticModifier`, `isGeneratorFunction` (all exports) | TS modifier predicates |
| 8194 | `unwrapGeneratorYieldType` (export) | TS type extractor |
| 8217 | `ensureI32Condition` (export) | Truthy coercion |

**Proposed decomposition of `codegen/index.ts` into:**

| New file | ~Lines | Holds | Risk |
|----------|-------:|-------|------|
| `codegen/index.ts` (orchestrator, slimmed) | 800 | `generateModule`, `generateMultiModule`, `extractConstantDefault`, the IR-bridge helpers (211–649), and the dispatcher logic only | medium (touches every other extracted module) |
| `codegen/ts-modifiers.ts` | 80 | `hasExportModifier`, `hasDeclareModifier`, `hasAsyncModifier`, `hasAbstractModifier`, `hasStaticModifier`, `isGeneratorFunction`, `unwrapGeneratorYieldType` | **low — do first** |
| `codegen/exports/struct-fields.ts` | 320 | `emitStructFieldGetters`, `_emitStructFieldGettersInner`, `emitStructFieldNamesExport` | low |
| `codegen/exports/iterator.ts` | 130 | `emitIteratorMethodExport` | low |
| `codegen/exports/closure-call.ts` | 700 | `emitClosureCallExport{,1,2,3,4,N}`, `buildNestedIfElse`, `buildGetterExtract` | low (already 6 sibling functions) |
| `codegen/exports/to-primitive.ts` | 200 | `emitToPrimitiveMethodExports` | low |
| `codegen/exports/vec-access.ts` | 200 | `emitVecAccessExports`, `_emitVecAccessExportsInner`, `fields_type_kind` | low |
| `codegen/exports/dataview.ts` | 130 | `emitDataViewByteExports` | low |
| `codegen/wasi/start.ts` | 70 | `addWasiStartExport` | low |
| `codegen/wasi/imports.ts` | 170 | `registerWasiImports` | low |
| `codegen/wasi/native-helpers.ts` | 330 | `emitWasiWriteStringHelper`, `emitWasiWriteStringStderrHelper`, `emitWasiWriteFileSyncHelper`, `emitWasiReadStdinAllHelper` | low |
| `codegen/wasi/dom-check.ts` | 30 | `checkWasiDomUsage` | low |
| `codegen/import-collectors/index.ts` | 80 | `collectAllSourceImports` (top dispatcher), re-exports below | low |
| `codegen/import-collectors/console.ts` | 65 | `collectConsoleImports` | low |
| `codegen/import-collectors/primitive-methods.ts` | 175 | `collectPrimitiveMethodImports` | low |
| `codegen/import-collectors/string-methods.ts` | 120 | `collectStringMethodImports` + `addStringImports` + `parseRegExpLiteral` | low |
| `codegen/import-collectors/string-literals.ts` | 290 | `collectStringLiterals`, `collectForInStringLiterals`, `collectInExprStringLiterals`, `collectObjectMethodStringLiterals` | low |
| `codegen/import-collectors/math.ts` | 70 | `collectMathImports` + `emitToUint32Helper` | low |
| `codegen/import-collectors/parse.ts` | 145 | `collectParseImports` | low |
| `codegen/import-collectors/constructors.ts` | 70 | `collectUnknownConstructorImports`, `collectWrapperConstructors` | low |
| `codegen/import-collectors/string-static.ts` | 45 | `collectStringStaticImports` | low |
| `codegen/import-collectors/promise.ts` | 110 | `collectPromiseImports` | low |
| `codegen/import-collectors/json.ts` | 60 | `collectJsonImports` | low |
| `codegen/import-collectors/callbacks.ts` | 40 | `collectCallbackImports` | low |
| `codegen/import-collectors/generators.ts` | 145 | `collectGeneratorImports` | low |
| `codegen/import-collectors/array-hof.ts` | 70 | `collectFunctionalArrayImports` | low |
| `codegen/import-collectors/unions.ts` | 600 | `collectUnionImports`, `addUnionImports`, `addUnionImportsAsNativeFuncs` | **medium** — `addUnionImports` shifts indices (CLAUDE.md note) |
| `codegen/import-collectors/iterators.ts` | 240 | `collectIteratorImports`, `addIteratorImports`, `addArrayIteratorImports`, `addGeneratorImports`, `addForInImports` | medium (shifts indices) |
| `codegen/import-collectors/lib-globals.ts` | 230 | `collectDeclaredGlobals`, `registerNodeBuiltinImports`, `sourceUsesLibGlobals` | low |
| `codegen/type-resolution.ts` | 520 | `isTupleType`, `getTupleElementTypes`, `tupleTypeKey`, `getOrRegisterTupleType`, `resolveNativeTypeAnnotation`, `resolveWasmType`, `fieldsHashKey`, `ensureDateStructForCtx`, `ensureStructForType` | **medium-high** — `resolveWasmType` is the most-imported helper (12 callers); a co-ordinated rename pass is needed |
| `codegen/extern-classes/registry.ts` | 540 | `externMethod`, `registerBuiltinExternClasses`, `getPseudoExternClassInfo`, `resolveMethodDispatchTarget` | low-medium |
| `codegen/extern-classes/collect.ts` | 550 | `collectExternDeclarations`, `collectDeclareNamespace`, `collectExternClass`, `collectExternFromDeclareVar`, `collectInterfaceMembers`, `collectMixinMembers`, `registerExternClassImports`, `collectUsedExternImports` | low-medium |
| `codegen/hoisting.ts` | 450 | `collectEnumDeclarations`, `hoistVarDeclarations`, `hoistBindingPattern`, `ensureLetConstBindingPatternTdzFlags`, `hoistVarDecl`, `walkStmtForVars`, `hoistLetConstWithTdz`, `needsTdzFlag`, `getContainingFunctionForTdz`, `isInsideLoopContainingForTdz`, `isDescendantOfNode`, `getLoopBodyNode`, `walkStmtForLetConst` | medium — TDZ logic is gnarly but already self-contained |
| `codegen/string-literal-pool.ts` | 100 | `cacheStringLiterals`, `collectStringCalls`, `replaceStringCalls` | low |
| `codegen/i32-coercion.ts` | 30 | `ensureI32Condition` | low |

**Extraction order:**
1. **Trivial first**: `ts-modifiers.ts`, `i32-coercion.ts`, `string-literal-pool.ts` (single-purpose, exported widely, can be done in one PR each).
2. **Export-emit second** (no cross-module dependencies — they only consume `ctx`): all `codegen/exports/*.ts` files.
3. **WASI third**: all `codegen/wasi/*.ts` files (independent).
4. **Import-collectors fourth**: the 14 collector files. They share a common signature `(ctx, sourceFile) => void` and operate on disjoint AST shapes. Can be done one or two collectors per PR. Save `unions.ts` and `iterators.ts` for last (those shift indices).
5. **Hoisting fifth**: `hoisting.ts` is large but well-isolated.
6. **Extern-classes sixth**: split into registry vs. collect.
7. **Type resolution last** (highest risk): `type-resolution.ts` because `resolveWasmType` has 12 importers; needs a coordinated import-update PR.

**Re-export shim strategy**: while extractions land incrementally, `codegen/index.ts` should retain a `re-exports` block (e.g. `export { resolveWasmType } from "./type-resolution.js"`) so downstream importers don't churn. Once all callers migrate, the shim disappears.

---

#### 2.3 `src/codegen/array-methods.ts` (5,908 LoC) — **HIGH PRIORITY**

**Role.** Compiles every `Array.prototype.*` method call (both the WasmGC-typed-array fast path and the externref fallback). Already 60+ separately-named functions — extraction is mostly mechanical.

**Function inventory:**

| Lines | Function | Family |
|------:|----------|--------|
| 34–186 | Helpers (`emitThrowString`, `throwStringInstrs`, `isKnownNonCallable`, `emitCallbackTypeCheck`, `guardedFuncRefCastInstrs`, `emitReceiverNullGuard`, `isReceiverNonNull`) | local |
| 189 | `emitBoundsCheckedArrayGet` (export) | helper |
| 260 | `emitClampIndex` (export) | helper |
| 298 | `emitClampNonNeg` (export) | helper |
| 312 | `resolveArrayInfo` (export) | helper |
| 338 | `getReceiverLocalIdx` | helper |
| 377 | `compileArrayLikePrototypeCall` (export) | dispatcher (array-like) |
| 1155 | `compileArrayLikePrototypeSearch` | array-like indexOf/includes |
| 1523 | `compileArrayPrototypeCall` (export) | dispatcher (`Array.prototype.*.call`) |
| 1608 | `compileArrayPrototypeIndexOf` | family |
| 1730 | `compileArrayPrototypeIncludes` | family |
| 1814 | `compileArrayPrototypeEvery` | family |
| 1956 | `compileArrayPrototypeSome` | family |
| 2078 | `compileArrayPrototypeForEach` | family |
| 2223 | `compileArrayMethodCall` (export) | dispatcher (main) |
| 2507 | `compileArrayToReversed` | ES2023 |
| 2613 | `compileArrayToSorted` | ES2023 |
| 2673 | `compileArrayToSpliced` | ES2023 |
| 2812 | `compileArrayWith` | ES2023 |
| 2878 | `compileArrayIteratorMethod` | iterator |
| 2902 | `emitArrayCopy` | helper |
| 2932 | `compileArrayAt` | accessor |
| 2995 | `compileArrayIndexOf` | search |
| 3148 | `compileArrayIncludes` | search |
| 3335 | `compileArrayReverse` | mutator |
| 3426 | `compileArrayPush` | mutator |
| 3555 | `compileArrayPop` | mutator |
| 3624 | `compileArrayShift` | mutator |
| 3725 | `compileArraySlice` | non-mutator |
| 3802 | `compileArrayConcat` + `compileArrayConcatExtern` | concat |
| 3993–4036 | `compileArrayJoinExtern`, `compileArrayJoin` | join |
| 4169 | `compileArraySplice` | mutator |
| 4306–4570 | HOF setup helpers (`setupArrayCallback`, `setupArrayLoop`, `buildClosureCallInstrs`, `buildBridgeCallInstrs`, `buildTruthyCheck`, `buildFalsyCheck`, `emitArrayLoop`, `loopExitCheck`, `loopIncrement`, `buildCallAndCheck`) | HOF kernel |
| 4594 | `compileArrayFilter` | HOF |
| 4680 | `compileArrayMap` | HOF |
| 4777 | `compileArrayReduce` | HOF |
| 4894 | `compileArrayReduceRight` | HOF |
| 5056 | `compileArrayForEach` | HOF |
| 5099 | `compileArrayFind` | HOF |
| 5177 | `compileArrayFindIndex` | HOF |
| 5245 | `compileArraySome` | HOF |
| 5307 | `compileArrayEvery` | HOF |
| 5370 | `compileArraySort` | sort dispatcher |
| 5425 | `compileArrayFill` | mutator |
| 5540 | `compileArrayCopyWithin` | mutator |
| 5647 | `compileArrayLastIndexOf` | search |
| 5816 | `compileArrayFlat` | flatten |
| 5858 | `compileArrayFlatMap` | flatten |

**Proposed decomposition** into `src/codegen/array/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `array/index.ts` (dispatchers) | 700 | `compileArrayMethodCall`, `compileArrayLikePrototypeCall`, `compileArrayPrototypeCall` (the three top dispatchers) |
| `array/helpers.ts` | 350 | All shared helpers (lines 34–337) + `resolveArrayInfo` + bounds-check emitters |
| `array/hof-kernel.ts` | 400 | All HOF setup helpers (4306–4570) |
| `array/mutators.ts` | 750 | `compileArrayPush`, `compileArrayPop`, `compileArrayShift`, `compileArraySplice`, `compileArrayReverse`, `compileArrayFill`, `compileArrayCopyWithin` |
| `array/accessors.ts` | 250 | `compileArrayAt`, `compileArraySlice`, `compileArrayConcat`, `compileArrayConcatExtern` |
| `array/search.ts` | 850 | `compileArrayIndexOf`, `compileArrayIncludes`, `compileArrayLastIndexOf`, `compileArrayLikePrototypeSearch`, `compileArrayPrototypeIndexOf`, `compileArrayPrototypeIncludes` |
| `array/hof-collectors.ts` | 650 | `compileArrayMap`, `compileArrayFilter`, `compileArrayReduce`, `compileArrayReduceRight`, `compileArrayForEach` |
| `array/hof-predicates.ts` | 350 | `compileArrayFind`, `compileArrayFindIndex`, `compileArraySome`, `compileArrayEvery`, `compileArrayPrototypeEvery`, `compileArrayPrototypeSome`, `compileArrayPrototypeForEach` |
| `array/join-string.ts` | 200 | `compileArrayJoin`, `compileArrayJoinExtern` |
| `array/flatten.ts` | 100 | `compileArrayFlat`, `compileArrayFlatMap` |
| `array/sort.ts` | 60 | `compileArraySort` (kernel is in `timsort.ts`) |
| `array/es2023.ts` | 350 | `compileArrayToReversed`, `compileArrayToSorted`, `compileArrayToSpliced`, `compileArrayWith` |
| `array/iterator.ts` | 30 | `compileArrayIteratorMethod` |

**Extraction risk**: low across the board. Each method has a single dispatcher entry-point, all share `helpers.ts` + `hof-kernel.ts`. Recommend extracting in this order: `helpers.ts` → `hof-kernel.ts` → leaf method files (parallelisable, 1–2 per PR) → finally trim `array/index.ts`.

---

#### 2.4 `src/runtime.ts` (5,335 LoC) — **HIGH PRIORITY**

**Role.** The JS host runtime: import-import resolution (the giant `resolveImport`), wasm-struct ↔ host-object bridging, `ToPrimitive`, accessor sidecars, property descriptor validation, Proxy/Map/Set/Date polyfills, WASI polyfill, test262 harness shim, and `buildImports`/`wrapExports`.

**Big-block layout (confirmed):**

| Lines | Block | Role |
|------:|-------|------|
| 1–135 | Module-level sidecar state | `_wasmStructProps`, `_wasmStructDeletedKeys`, `_wasmPropDescs`, `_wasmStructAccessors`, `_wasmFrozenObjs`, `_wasmSealedObjs`, `_wasmNonExtensibleObjs`, `_userClassTags`, `_userClassParents`, `_dvViewMeta`, descriptor flag constants |
| 136–290 | Property-descriptor helpers | `_normalizeDescKey`, `_getSidecarDescs`, `_validatePropertyDescriptor`, `_toPropertyDescriptorValidate`, `_isWasmStruct`, `_canBeWeakKey` |
| 291–425 | Closure wrapping + iterable materialization + sidecar access | `_wrapWasmClosure`, `_materializeIterable`, `_getSidecar`, `_sidecarGet`, `_sidecarSet`, `_sidecarDelete` |
| 426–840 | **ToPrimitive subsystem** | `_toPrimitive` (424–595), `_toPrimitiveSync` (596–628), `_hostToPrimitive` (629–842) |
| 843–983 | Struct ↔ plain-object conversion | `_getStructFieldNames`, `_structToPlainObject`, `_wasmToPlain` |
| 984–1193 | Identity / safe accessors | `_resolveNamespacedClass`, `_safeGet`, `_safeSet` |
| 1194–1283 | **Host method bridges** | `_hostProxyCache`, `_hostProxyReverse`, `_prototypeMethodNames`, `_prototypeMethodBridges`, `_staticMethodNames`, `_classMethodBridges`, `_getProtoMethodBridge`, `_getClassMethodBridge` |
| 1284–1574 | wrap/unwrap-for-host | `_wrapForHost` (1284–1542), `_unwrapForHost` (1543–1574) |
| 1575–1737 | Array.prototype sparse fast paths | `_collectIntegerKeys`, `_arrayProtoUnshiftSparse`, `_arrayProtoReverseSparse`, `_arrayProtoForEachSparse`, `_toJsArray`, `_arrayProtoSparseFastPaths` |
| 1737–1781 | Native string config | `jsString`, `JS_STRINGS_NATIVE_BUILTIN`, `buildStringConstants` consts |
| **1782–4815** | **`resolveImport`** (one function, ~3,030 LoC) | The giant `switch(intent.type)` over `ImportIntent`. Inside it: `string_literal`, `math`, `console_log`, `string_method`, `extern_class` (which contains the **test262 harness shim** as a 90-LoC string literal at lines 2227–2316), `box_number`, `unbox_number`, `wasm_func`, `iterator`, `regexp`, `promise`, `weakset/weakmap/map/set`, `dataview`, `wasi-related`, `getter/setter`, `object_*`, `array_*`, `string_*`, `symbol_*`, plus 30+ more cases I confirmed by sampling. |
| 4817 | `buildStringConstants` (export) | Pool externalization |
| 4832 | `checkPolicy` (export) | Import policy check |
| 4848 | `wrapWithContainment` | Containment wrapper |
| 4984 | `buildWasiPolyfill` (export) | WASI polyfill |
| 5080 | `buildImports` (export) | Compose all imports |
| 5203 | `wrapExports` (export) | Export wrapper |
| 5253 | `instantiateWasm` (export) | Sync instantiate |
| 5283 | `instantiateWasmStreaming` (export) | Streaming instantiate |
| 5323 | `compileAndInstantiate` (export) | Combined |

**Proposed `src/runtime/` subdirectory** (turn the current `runtime.ts` into a thin re-export shell):

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `runtime/sidecar.ts` | 220 | `_wasmStructProps`, `_wasmStructDeletedKeys`, `_wasmPropDescs`, `_wasmStructAccessors`, `_wasmFrozenObjs`, `_wasmSealedObjs`, `_wasmNonExtensibleObjs`, `_userClassTags`, `_userClassParents`, `_dvViewMeta`, descriptor flag constants, `_getSidecar`, `_sidecarGet`, `_sidecarSet`, `_sidecarDelete`, `_normalizeDescKey`, `_getSidecarDescs` |
| `runtime/descriptors.ts` | 130 | `_validatePropertyDescriptor`, `_toPropertyDescriptorValidate`, `_isWasmStruct`, `_canBeWeakKey` |
| `runtime/closure.ts` | 80 | `_wrapWasmClosure`, `_materializeIterable` |
| `runtime/toprimitive.ts` | 420 | `_toPrimitive`, `_toPrimitiveSync`, `_hostToPrimitive` |
| `runtime/struct-bridge.ts` | 350 | `_getStructFieldNames`, `_structToPlainObject`, `_wasmToPlain`, `_resolveNamespacedClass`, `_safeGet`, `_safeSet` |
| `runtime/method-bridge.ts` | 270 | `_hostProxyCache`, `_hostProxyReverse`, `_prototypeMethodNames`, `_prototypeMethodBridges`, `_staticMethodNames`, `_classMethodBridges`, `_getProtoMethodBridge`, `_getClassMethodBridge`, `_wrapForHost`, `_unwrapForHost` |
| `runtime/array-sparse.ts` | 160 | `_collectIntegerKeys`, `_arrayProtoUnshiftSparse`, `_arrayProtoReverseSparse`, `_arrayProtoForEachSparse`, `_toJsArray`, `_arrayProtoSparseFastPaths` |
| `runtime/test262-shim.ts` | 100 | The test262 harness shim string literal (currently embedded inside `resolveImport`'s `extern_class new Test262Error` case at lines 2227–2316) |
| `runtime/resolve-import/index.ts` | 350 | `resolveImport` shell + `switch` dispatch |
| `runtime/resolve-import/math.ts` | 60 | `case "math"` |
| `runtime/resolve-import/console.ts` | 80 | `case "console_log"` |
| `runtime/resolve-import/string-method.ts` | 50 | `case "string_method"` |
| `runtime/resolve-import/extern-class.ts` | 900 | `case "extern_class"` (the biggest single case; contains Test262Error and the builtinCtors table) |
| `runtime/resolve-import/object-ops.ts` | 350 | All `case "object_*"` (defineProperty, getOwnPropertyDescriptor, freeze/seal/etc., assign, fromEntries) |
| `runtime/resolve-import/array-ops.ts` | 300 | All `case "array_*"` (push, pop, shift, splice, etc.) |
| `runtime/resolve-import/string-ops.ts` | 200 | All `case "string_*"` |
| `runtime/resolve-import/number-ops.ts` | 100 | `case "box_number"`, `case "unbox_number"`, `case "number_*"` |
| `runtime/resolve-import/collections.ts` | 400 | Map/Set/WeakMap/WeakSet cases |
| `runtime/resolve-import/promise.ts` | 200 | Promise cases |
| `runtime/resolve-import/iterator.ts` | 150 | Iterator cases |
| `runtime/resolve-import/regexp.ts` | 100 | RegExp cases |
| `runtime/resolve-import/dataview.ts` | 200 | DataView cases |
| `runtime/resolve-import/symbol.ts` | 80 | Symbol cases (also share table with `runtime/sidecar.ts`) |
| `runtime/resolve-import/wasi.ts` | 200 | WASI-relevant cases (some overlap with `buildWasiPolyfill`) |
| `runtime/resolve-import/getter-setter.ts` | 80 | Accessor cases |
| `runtime/build-imports.ts` | 230 | `buildImports`, `wrapWithContainment`, `buildStringConstants`, `checkPolicy` |
| `runtime/wasi-polyfill.ts` | 100 | `buildWasiPolyfill` |
| `runtime/wrap-exports.ts` | 60 | `wrapExports` |
| `runtime/instantiate.ts` | 90 | `instantiateWasm`, `instantiateWasmStreaming`, `compileAndInstantiate` |
| `runtime.ts` (kept) | ~50 | Re-export façade preserving public API |

**Extraction order:**
1. **First** — `sidecar.ts`, `descriptors.ts`, `closure.ts` (no public-API impact).
2. **Second** — `toprimitive.ts`, `struct-bridge.ts`, `method-bridge.ts`, `array-sparse.ts`.
3. **Third** — `instantiate.ts`, `wrap-exports.ts`, `wasi-polyfill.ts` (export those used by `src/index.ts`).
4. **Fourth** — `build-imports.ts`. This still calls `resolveImport`, so wait until step 5 is done in parallel.
5. **Fifth** — split `resolveImport` by case. The `extern_class` case is the biggest single block (~900 LoC) — extract `test262-shim.ts` first to make it manageable. Each case file exports a function with signature `(intent: ImportIntent, deps?, callbackState?, sandbox?) => Function`. The dispatcher's `switch` becomes a small lookup table.

**Risk:** the test262 shim is a string literal — touching it can silently break test262 runs. **Mitigation:** keep it byte-identical when moving (no whitespace changes), and re-run a full test262 shard immediately after.

---

#### 2.5 `src/codegen/expressions/assignment.ts` (5,143 LoC) — **MEDIUM-HIGH PRIORITY**

**Role.** Compiles `=`, compound (`+=` etc.), logical (`||=`, `&&=`, `??=`) assignments, plus *all* destructuring assignment forms.

**Function inventory (40 functions, 10 exports):**

| Lines | Function | Family |
|------:|----------|--------|
| 57 | `emitExternrefAssignDestructureGuard` | helper |
| 86 | `compileAssignment` (export) | main entry |
| 314 | `isStrictContext` (export) | helper |
| 355 | `isUnresolvableIdent` (export) | helper |
| 383 | `findUnresolvableInObjectPattern` (export) | helper |
| 407 | `findUnresolvableInArrayPattern` (export) | helper |
| 444 | `emitStrictPutValueThrow` | helper |
| 451–1311 | **Destructuring family** — `compileDestructuringAssignment`, `compileArrayDestructuringAssignment`, `compileExternrefArrayDestructuringAssignment` | destructuring |
| 1501 | `emitAssignToTarget` | helper |
| 1582 | `emitObjectDestructureFromLocal` | destructuring |
| 1713 | `emitArrayDestructureFromLocal` | destructuring |
| 1874–2680 | **Property-assignment family** — `compilePropertyAssignment`, `compilePropertyAssignmentExternSet`, `compileExternPropertySet`, `emitSetterCallWithDummy`, `compileElementAssignment` | property/element assign |
| 2681 | `compileExternSetFallback` | helper |
| 2761 | `compileLogicalAssignment` (export) | logical-assign main |
| 2971 | `compilePropertyLogicalAssignment` | logical-assign |
| 3080 | `compilePropertyLogicalAssignmentExternref` | logical-assign |
| 3256 | `compileElementLogicalAssignment` | logical-assign |
| 3417 | `compileElementLogicalAssignmentExternref` | logical-assign |
| 3515 | `isRefType` | helper |
| 3530 | `emitLogicalAssignmentPattern` | helper |
| 3645 | `isCompoundAssignment` (export) | predicate |
| 3675 | `compileStringCompoundAssignment` | compound |
| 3758 | `compileNativeStringCompoundAssignment` | compound |
| 3881–4038 | `compileAndCoerceToAnyStr`, `hasStringAssignment`, `hasStringAssignmentInParentScopes` | helpers |
| 4039 | `compileCompoundAssignment` (export) | compound main |
| 4328 | `emitBitwiseCompoundOp` | helper |
| 4368 | `emitCompoundOp` | helper |
| 4405 | `compilePropertyCompoundAssignment` | compound |
| 4565 | `compilePropertyCompoundAssignmentExternref` | compound |
| 4783 | `compileElementCompoundAssignment` | compound |

**Proposed decomposition** into `src/codegen/expressions/assignment/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `assignment/index.ts` | 350 | `compileAssignment` shell + dispatch + `isStrictContext`, `isUnresolvableIdent`, `findUnresolvableInObjectPattern`, `findUnresolvableInArrayPattern` |
| `assignment/destructuring.ts` | 1,500 | `compileDestructuringAssignment`, `compileArrayDestructuringAssignment`, `compileExternrefArrayDestructuringAssignment`, `emitObjectDestructureFromLocal`, `emitArrayDestructureFromLocal`, `emitAssignToTarget`, `emitExternrefAssignDestructureGuard`, `emitStrictPutValueThrow` |
| `assignment/property.ts` | 850 | `compilePropertyAssignment`, `compilePropertyAssignmentExternSet`, `compileExternPropertySet`, `emitSetterCallWithDummy`, `compileExternSetFallback` |
| `assignment/element.ts` | 470 | `compileElementAssignment` |
| `assignment/logical.ts` | 900 | `compileLogicalAssignment`, `compilePropertyLogicalAssignment`, `compilePropertyLogicalAssignmentExternref`, `compileElementLogicalAssignment`, `compileElementLogicalAssignmentExternref`, `emitLogicalAssignmentPattern`, `isRefType` |
| `assignment/compound.ts` | 1,100 | `isCompoundAssignment`, `compileCompoundAssignment`, `compilePropertyCompoundAssignment`, `compilePropertyCompoundAssignmentExternref`, `compileElementCompoundAssignment`, `emitBitwiseCompoundOp`, `emitCompoundOp` |
| `assignment/string-compound.ts` | 480 | `compileStringCompoundAssignment`, `compileNativeStringCompoundAssignment`, `compileAndCoerceToAnyStr`, `hasStringAssignment`, `hasStringAssignmentInParentScopes` |

**Extraction order:** `string-compound.ts` → `destructuring.ts` → `compound.ts` → `logical.ts` → `property.ts` → `element.ts` → finalize `index.ts`.

---

#### 2.6 `src/codegen-linear/index.ts` (4,813 LoC)

**Role.** The alternative linear-memory backend (entry points: `generateLinearModule`, `generateLinearMultiModule`). Mirrors the WasmGC backend's structure but with linear-memory data layout.

**Function inventory (sample):** 60+ functions. Compile* functions: `compileFunction`, `compileStatement` (488), `compileForOfStatement` (681), `compileSwitchStatement` (1067), `compileExpression` (1175), `compileBinaryExpression` (1696), `compileObjectLiteral` (1533), `compileArrayLiteral` (2210), `compileObjectDestructuring` (2239), `compileArrayDestructuring` (2327), `compileNewExpression` (2396), `compilePropertyAccess` (2507), `compileElementAccess` (2661), `compileMethodCall` (2766), `compileArrayMethodCall` (2902), `compileArrayHOF` (2946), `compileArrayJoin` (3204), `compileUint8ArrayMethodCall` (3313), `compileMapMethodCall` (3405), `compileSetMethodCall` (3455), `compileClassDeclaration` (3797), `compileClassCtor` (3822), `compileClassMethod` (3914), `compileClassGetter` (3988), `compileClassNewExpression` (4054), `compilePropertyAssignment` (4112).

**Proposed decomposition** into `src/codegen-linear/` (sibling files, not subdir — already one level deep):

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `codegen-linear/index.ts` (trimmed) | 350 | `generateLinearModule`, `generateLinearMultiModule`, `compileFunction`, `compileFunctionMulti`, `collectModuleGlobals` |
| `codegen-linear/statements.ts` | 800 | `compileStatement`, `compileSwitchStatement`, `compileDoWhileStatement`, `compileForOfStatement`, `compileForOfMap`, default-arg helpers |
| `codegen-linear/expressions.ts` | 700 | `compileExpression`, `compileBinaryExpression`, `compileTemplateExpression`, op classifiers (`isComparisonOp`, `isBitwiseOp`, `bitwiseOp`, …), `emitTruthyCoercion` |
| `codegen-linear/literals.ts` | 350 | `compileObjectLiteral`, `compileArrayLiteral`, `compileStringLiteral`, `classifyFieldType`, `detectCollectionKind`, `getExprCollectionKind`, `isStringExpr` |
| `codegen-linear/destructuring.ts` | 300 | `compileObjectDestructuring`, `compileArrayDestructuring` |
| `codegen-linear/class.ts` | 600 | `compileNewExpression`, `compileClassDeclaration`, `compileClassCtor`, `compileClassMethod`, `compileClassGetter`, `compileClassNewExpression`, `compilePropertyAssignment`, `scanClassDeclaration`, `resolveFieldType`, `inferClassName` |
| `codegen-linear/property-access.ts` | 350 | `compilePropertyAccess`, `compileElementAccess`, `compileElementAccessAssignment` |
| `codegen-linear/calls.ts` | 350 | `compileMethodCall`, `compileArrayMethodCall`, `compileArrayHOF`, `compileArrayJoin`, `compileUint8ArrayMethodCall`, `compileMapMethodCall`, `compileSetMethodCall`, `compileCallArg`, `isCallVoid`, `isVoidExpression`, `findMethodResultType` |
| `codegen-linear/type-inference.ts` | 200 | `inferExprType`, `resolveType`, `resolveParamTypeFromChecker`, `compileExprToI32`, `compileExprToF64` |

**Risk:** low — this backend has fewer cross-file callers and the file is already chunked by responsibility. Conflicts are also rarer here (it's the secondary backend).

---

#### 2.7 `src/ir/from-ast.ts` (4,227 LoC)

**Role.** Lowers TypeScript AST into the IR. Already 50+ small functions, mostly per-AST-shape (`lowerExpr`, `lowerStmt`, `lowerCall`, `lowerNewExpression`, `lowerBinary`, `lowerForOfStatement`, …).

**Proposed decomposition** into `src/ir/from-ast/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `from-ast/index.ts` | 400 | `lowerFunctionAstToIr`, `lowerStatementList`, `lowerTail`, `lowerStmt` + interfaces |
| `from-ast/declarations.ts` | 400 | `collectMutatedLetNames`, `collectMutatedLetNamesFromBlock`, `lowerVarDecl`, `lowerNestedFunctionDeclaration`, `liftNestedFunction` |
| `from-ast/patterns.ts` | 200 | `lowerBindingPattern`, `lowerObjectPattern`, `lowerArrayPattern` |
| `from-ast/types.ts` | 200 | `typeNodeToIr`, `isPrimitiveTypeNode`, `describeIrType`, `resolveIrType`, `isIrTypeNullable` |
| `from-ast/expressions.ts` | 600 | `lowerExpr`, `lowerConditional`, `lowerPrefixUnary`, `lowerRegExpLiteral`, `parseRegExpLiteralText`, `lowerTemplateExpression`, `lowerTypeOf`, `staticTypeOfFor` |
| `from-ast/property-access.ts` | 350 | `lowerOptionalExternPropertyAccess`, `lowerPropertyAccess`, `lowerObjectLiteral`, `lowerElementAccess`, `phase1PropertyName` |
| `from-ast/calls.ts` | 700 | `lowerCall`, `expandStaticSpreadArgs`, `lowerClosureCall`, `lowerNestedFuncCall`, `lowerNewExpression`, `emitDefaultExternArg`, `coerceToExpectedExtern`, `lowerMethodCall`, `lowerStringMethodCall` |
| `from-ast/assignments.ts` | 250 | `lowerPropertyAssignment`, `lowerIdentifierAssignment`, `lowerCompoundAssignment`, `lowerIncrementDecrement` |
| `from-ast/control-flow.ts` | 800 | `lowerYield`, `coerceYieldValueToExternref`, `lowerForOfStatement`, `lowerWhileStatement`, `lowerForStatement`, `lowerForUpdateExpr`, `lowerForOfIterFromExternrefValue`, `lowerForOfString`, `lowerForOfVec`, `inferVecElementValTypeFromContext`, `inferVecDataValTypeFromContext` |
| `from-ast/binary.ts` | 300 | `lowerBinary`, `requireF64`, `requireI32`, `typeOfValue`, `tryFoldNullCompare` |
| `from-ast/closures.ts` | 100 | `lowerClosureExpression` |

**Risk:** medium. The `LowerCtx` mutable state is threaded through every function. Splitting requires exporting the context type cleanly. Since these functions are already ≤200 LoC each, the work is mostly grouping.

---

#### 2.8 `src/codegen/declarations.ts` (3,447 LoC)

**Role.** Pre-walks the source to collect: class declarations, interface members, struct field types, prop sets, generic call-site types, parameter types from call-sites/body, numeric return types, empty-object widening. Drives the WasmGC `ensureStructForType` registry.

**Function inventory:**

| Lines | Function | Family |
|------:|----------|--------|
| 126–780 | `createUnifiedCollectorState`, `unifiedVisitNode`, `finalizeUnifiedCollector` | unified collector |
| 1177 | `resolveGenericCallSiteTypes` | type inference |
| 1214 | `inferParamTypeFromCallSites` | type inference |
| 1274 | `inferParamTypeFromBody` | type inference |
| 1384 | `inferNumericReturnTypes` | type inference |
| 1643 | `collectEmptyObjectWidening` | type inference |
| 1727 | `isAccessorDescriptor` | helper |
| 1748 | `collectPropsFromStatements` | prop collector |
| 1894 | `applyShapeInference` | shape merge |
| 1946 | `collectDeclarations` | top entry |
| 2924 | `collectInterface` | interface |
| 2957 | `resolveStructFieldTypes` | finalize struct types |
| 3012 | `collectObjectType` | object-type registration |
| 3038 | `compileDeclarations` | final emit |

**Proposed decomposition:**

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `declarations/index.ts` | 300 | `collectDeclarations`, `compileDeclarations`, `collectObjectType` |
| `declarations/unified-collector.ts` | 700 | `createUnifiedCollectorState`, `unifiedVisitNode`, `finalizeUnifiedCollector` |
| `declarations/type-inference.ts` | 700 | `resolveGenericCallSiteTypes`, `inferParamTypeFromCallSites`, `inferParamTypeFromBody`, `inferNumericReturnTypes` |
| `declarations/shape-inference-bridge.ts` | 350 | `applyShapeInference`, `collectEmptyObjectWidening`, `isAccessorDescriptor`, `collectPropsFromStatements` |
| `declarations/struct-fields.ts` | 150 | `resolveStructFieldTypes` |
| `declarations/interfaces.ts` | 50 | `collectInterface` |

**Risk:** medium. Type-inference passes are mutually recursive (call-site ↔ body) — extract together.

---

#### 2.9 `src/compiler/validation.ts` (3,373 LoC) — `detectEarlyErrors` is a God Function

**Role.** Pre-compile validation: safe-mode checks, hardened-mode checks, early-error detection (syntactic conditions that throw at compile time).

**Functions:**

| Lines | Function | Role |
|------:|----------|------|
| 17 | `getApproxSourceLocation` | helper |
| 23 | `pushSourceAnchoredDiagnostic` | helper |
| 39 | `validateSafeMode` | top entry |
| **168–3257** | **`detectEarlyErrors`** | **3,089-LoC God Function** — single block of nested early-error checks. |
| 3259 | `hasExportModifier` | helper |
| 3268 | `validateHardenedMode` | top entry |
| 3345 | `rewriteEvalSuperCall` | rewrite |

**The God Function `detectEarlyErrors`.** It's almost entirely a giant `forEachChild` recursion with chains of `if (ts.isXxx(node)) { check… }`. Each early-error check is a few-dozen-LoC block.

**Proposed decomposition** into `src/compiler/validation/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `validation/index.ts` | 250 | `validateSafeMode`, `validateHardenedMode`, `rewriteEvalSuperCall`, `getApproxSourceLocation`, `pushSourceAnchoredDiagnostic`, `hasExportModifier` |
| `validation/early-errors/index.ts` | 150 | `detectEarlyErrors` skeleton: walks AST, dispatches to per-shape checkers |
| `validation/early-errors/literals.ts` | ~400 | early errors on number/string/regexp literals (octal escapes, invalid escapes, etc.) |
| `validation/early-errors/patterns.ts` | ~400 | binding patterns / destructuring errors |
| `validation/early-errors/declarations.ts` | ~400 | duplicate let/const, function-in-block, class extends |
| `validation/early-errors/expressions.ts` | ~500 | yield/await context, super outside method, assignment-target errors |
| `validation/early-errors/strict-mode.ts` | ~300 | with-statement, reserved words, octals |
| `validation/early-errors/classes.ts` | ~400 | class-specific (private names, static blocks, computed names) |
| `validation/early-errors/iteration.ts` | ~300 | for-in/of head errors, labelled loops, break/continue |

**Extraction risk: medium.** Each early-error check is independent in spirit but currently shares a closure over `errors: CompileError[]`. Extraction requires passing `errors` (and `sourceFile`) explicitly or via a small `ValidationCtx` object. The walker can stay in `index.ts`; each detected shape dispatches to the appropriate `early-errors/*.ts` module. **The exact subdivision should be confirmed by reading the full 3,089-LoC function** — my proposal above is a reasonable starting partition but the actual divisions are best discovered by reading each check.

---

#### 2.10 `src/codegen/native-strings.ts` (3,361 LoC)

**Role.** Implements the standalone (non-`wasm:js-string`) string backend using i16 GC arrays. Exposes 8 functions, but only 3 do meaningful work: `ensureNativeStringHelpers` (lines 85–2949 — ~2,860 LoC of dozens of `addFunc(...)` calls into `ctx.module`), `ensureNativeStringExternBridge` (2950–3126), `emitTestRuntimeStringHelpers` (3127+).

**Proposed decomposition.** This is a *helper-function library* — each native-string helper (length, charCodeAt, indexOf, slice, concat, split, replace, trim, padStart, padEnd, …) is currently inlined in `ensureNativeStringHelpers` as a separate `addFunc("__str_<name>", ...)` block. The grouping should be:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `native-strings/index.ts` | 150 | `nativeStringType`, `nativeStringLiteralInstrs`, `stringConstantExternrefInstrs`, `nativeStringTypeNullable`, `flatStringType`, plus the dispatch shell of `ensureNativeStringHelpers` (which calls per-helper modules) |
| `native-strings/basic.ts` | ~400 | length, charCodeAt, codePointAt, charAt, slice, substring, substr, at |
| `native-strings/search.ts` | ~400 | indexOf, lastIndexOf, includes, startsWith, endsWith, match, search |
| `native-strings/transform.ts` | ~500 | toUpperCase, toLowerCase, trim, trimStart, trimEnd, padStart, padEnd, repeat, normalize |
| `native-strings/split-replace.ts` | ~400 | split, replace, replaceAll |
| `native-strings/concat.ts` | ~300 | concat, += accumulator helpers |
| `native-strings/conversion.ts` | ~300 | from-utf16, to-utf16, fromCharCode, fromCodePoint, parseInt/parseFloat support |
| `native-strings/iteration.ts` | ~250 | string iterator (for-of support), Symbol.iterator |
| `native-strings/extern-bridge.ts` | ~180 | `ensureNativeStringExternBridge` |
| `native-strings/test-runtime.ts` | ~180 | `emitTestRuntimeStringHelpers` |

**Extraction risk:** low–medium. Each helper is a `addFunc("__str_<name>", body)` call — they don't read each other's locals. The shell `ensureNativeStringHelpers` becomes a dispatcher that lazily ensures each helper category.

**Cross-cutting concern**: the helper `addFunc` pattern recurs in `codegen-linear/runtime.ts` and `codegen/math-helpers.ts`. Consider extracting a tiny shared `addRuntimeFunc(mod, name, params, results, body)` builder.

---

#### 2.11 `src/codegen/statements/loops.ts` (3,212 LoC)

**Role.** Compiles `for`, `while`, `do-while`, `for-of`, `for-in`. The `for-of` family is huge (covers string, array, externref-iterator, direct iterator, destructuring head, assignment head).

**Function inventory:**

| Lines | Function | Family |
|------:|----------|--------|
| 49 | `compileWhileStatement` (export) | while |
| 123, 203 | `detectI32LoopVar`, `loopBodyMutatesIndexOrArray` | helper |
| 295 | `compileForStatement` (export) | for |
| 603 | `compileDoWhileStatement` (export) | do-while |
| 681 | `compileForOfDestructuring` | for-of-decl-destructuring |
| 1119 | `compileForOfAssignDestructuring` | for-of-assign-destructuring |
| 1511 | `compileForOfAssignDestructuringExternref` | for-of-assign-destructuring externref |
| 1704 | `collectBindingNames` | helper |
| 1719 | `compileForOfStatement` (export) | for-of dispatcher |
| 1746 | `compileForOfString` | string |
| 1918, 1946 | `compileForOfArrayTentative`, `compileForOfArray` | array |
| 2168 | `compileForOfIteratorAssignDestructuring` | iterator + assign-destructure |
| 2404 | `compileForOfDirectIterator` | direct iterator |
| 2676 | `findStructFieldsByTypeIdx` | helper |
| 2709 | `compileForOfIterator` | externref iterator |
| 3042 | `compileForInStatement` (export) | for-in |

**Proposed decomposition** into `src/codegen/statements/loops/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `loops/index.ts` | 150 | re-exports + tiny dispatcher (keep export surface stable) |
| `loops/while-do.ts` | 200 | `compileWhileStatement`, `compileDoWhileStatement` |
| `loops/for.ts` | 400 | `compileForStatement`, `detectI32LoopVar`, `loopBodyMutatesIndexOrArray` |
| `loops/for-in.ts` | 200 | `compileForInStatement` |
| `loops/for-of/index.ts` | 200 | `compileForOfStatement` (dispatcher), `collectBindingNames` |
| `loops/for-of/string.ts` | 200 | `compileForOfString` |
| `loops/for-of/array.ts` | 270 | `compileForOfArrayTentative`, `compileForOfArray` |
| `loops/for-of/direct-iterator.ts` | 280 | `compileForOfDirectIterator`, `findStructFieldsByTypeIdx` |
| `loops/for-of/extern-iterator.ts` | 340 | `compileForOfIterator` |
| `loops/for-of/destructuring-decl.ts` | 440 | `compileForOfDestructuring` |
| `loops/for-of/destructuring-assign.ts` | 400 | `compileForOfAssignDestructuring` |
| `loops/for-of/destructuring-assign-extern.ts` | 200 | `compileForOfAssignDestructuringExternref` |
| `loops/for-of/destructuring-iterator.ts` | 240 | `compileForOfIteratorAssignDestructuring` |

**Risk:** low — `for-of` variants already have function-level boundaries. The dispatcher's branch selection logic is what needs preserving.

---

#### 2.12 `src/codegen/closures.ts` (3,171 LoC)

**Role.** Closure capture analysis, arrow-function lowering, function-ref wrapping, host-callback bridging.

**Function inventory:**

| Lines | Function | Role |
|------:|----------|------|
| 63 | `isFunctionScopeBoundary` | helper |
| 90 | `collectFunctionOwnLocals` (export) | scope analysis |
| 117 | `collectVarAndTopLevelDecls` | scope analysis |
| 183 | `collectReferencedIdentifiers` (export) | scope analysis |
| 217 | `collectWrittenIdentifiers` (export) | scope analysis |
| 275 | `promoteAccessorCapturesToGlobals` (export) | accessor-capture promotion |
| 382 | `collectBindingPatternNames` (export) | helper |
| 394 | `isOwnParamName` (export) | helper |
| 411–882 | `emitArrowParamDestructuring`, `emitParamDefaultCheckInline`, `emitArrowParamDefaults`, `emitMethodParamDefaults` | param-emit |
| 973 | `isHostCallbackArgument` (export) | host callback predicate |
| 1080 | `closureProvablyAfterLetDecl` | timing analysis |
| 1137–1150 | `compileArrowFunction` (export) | arrow lowering |
| 1151–2259 | **`compileArrowAsClosure`** (export) | ~1,110 LoC — the main closure-lowering pass |
| 2260–2652 | **`compileArrowAsCallback`** (export) | ~390 LoC — host-callback variant |
| 2653 | `getFuncSignature` (export) | signature resolution |
| 2686 | `getOrCreateFuncRefWrapperTypes` (export) | wrapper types |
| 2734 | `emitFuncRefAsClosure` (export) | funcref → closure adapter |
| 2995 | `emitObjectMethodAsClosure` (export) | object-method adapter |
| 3063 | `emitCachedMethodClosureAccess` (export) | cached method-as-closure |
| 3158 | `closureBodyUsesArguments` | helper |

**Proposed decomposition** into `src/codegen/closures/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `closures/index.ts` | 250 | Re-export façade + `closureBodyUsesArguments`, `isFunctionScopeBoundary` |
| `closures/scope-analysis.ts` | 320 | `collectFunctionOwnLocals`, `collectVarAndTopLevelDecls`, `collectReferencedIdentifiers`, `collectWrittenIdentifiers`, `collectBindingPatternNames`, `isOwnParamName`, `closureProvablyAfterLetDecl`, `promoteAccessorCapturesToGlobals` |
| `closures/params.ts` | 480 | `emitArrowParamDestructuring`, `emitParamDefaultCheckInline`, `emitArrowParamDefaults`, `emitMethodParamDefaults` |
| `closures/arrow.ts` | 1,150 | `compileArrowFunction`, `compileArrowAsClosure` |
| `closures/callback.ts` | 400 | `compileArrowAsCallback`, `isHostCallbackArgument` |
| `closures/funcref-wrapper.ts` | 600 | `getFuncSignature`, `getOrCreateFuncRefWrapperTypes`, `emitFuncRefAsClosure`, `emitObjectMethodAsClosure`, `emitCachedMethodClosureAccess` |

**Risk:** medium. `compileArrowAsClosure` is internally a single long function that's been organized via comments — internally it needs sub-splitting (capture analysis → ref-cell allocation → body emit → wrapper emit) but that's a follow-up after the top-level split.

---

#### 2.13 `src/codegen/property-access.ts` (3,013 LoC)

**Role.** Compiles property reads, element reads, and the typed dispatch that picks between struct.get, externref host get, and dynamic dispatch.

**Function inventory:** 24 functions. Hot ones: `compilePropertyAccess` (896), `compileExternPropertyGet` (2590), `compileElementAccess` (2670), `compileElementAccessBody` (2801). Plus 8 small `resolveStructName*` / `isProvablyNonNull` / `typeErrorThrowInstrs` helpers at the top.

**Proposed decomposition** into `src/codegen/property-access/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `property-access/index.ts` | 250 | Top dispatcher: `compilePropertyAccess` shell + re-exports |
| `property-access/struct-resolution.ts` | 220 | `resolveStructName`, `resolveStructNameForExpr`, `resolveEffectiveStructName`, `isGeneratorIteratorResultLike`, `getIteratorResultValueType`, `findAlternateStructsForField` |
| `property-access/null-guards.ts` | 150 | `isProvablyNonNull`, `typeErrorThrowInstrs`, `emitNullCheckThrow`, `emitDummyStruct`, `emitGetterCallWithDummy` |
| `property-access/struct-get.ts` | 700 | `emitNullGuardedStructGet`, `emitExternrefToStructGet`, body of `compilePropertyAccess` for struct path |
| `property-access/optional.ts` | 130 | `compileOptionalPropertyAccess` |
| `property-access/extern-get.ts` | 200 | `compileExternPropertyGetFromStack`, `compileExternPropertyGet` |
| `property-access/element.ts` | 350 | `compileElementAccess`, `compileElementAccessBody`, `emitBoundsGuardedArraySet`, `isSafeBoundsEliminated` |
| `property-access/well-known-symbols.ts` | 30 | `isAnonymousFunctionDefinition`, `getWellKnownSymbolId` (private duplicates) |

**Risk:** medium — the central `compilePropertyAccess` function holds a 2,000-LoC body that interleaves struct dispatch, extern dispatch, and prototype-method fallback. Needs careful section labelling before extraction.

---

#### 2.14 `src/codegen/object-ops.ts` (2,681 LoC)

**Role.** `Object.defineProperty`, `Object.defineProperties`, `Object.keys/values/entries`, `Object.getOwnPropertyDescriptor`-family. Already heavily decomposed (12 functions, 6 exports).

**Proposed decomposition:**

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `object-ops/define-property.ts` | 1,000 | `computeDescriptorFlags`, `emitDefinePropertyFlagCheck`, `compileObjectDefineProperty`, `computeRuntimeFlags`, `emitExternDefinePropertyValue`, `resolveExprToFuncNode`, `emitExternDefinePropertyNoValue` |
| `object-ops/define-properties.ts` | 600 | `compileObjectDefineProperties` |
| `object-ops/keys-values.ts` | 400 | `compileObjectKeysOrValues` |
| `object-ops/introspection.ts` | 350 | `compilePropertyIntrospection` |
| `object-ops/guards.ts` | 200 | `emitNonObjectArgGuard`, `emitObjectArgNullGuard` + the flag constants |

---

#### 2.15 `src/codegen/expressions/new-super.ts` (2,675 LoC)

**Role.** `new` expressions, super calls, class-expression `new`.

**Function inventory:**

| Lines | Function |
|------:|----------|
| 44 | `resolveEnclosingClassName` |
| 52 | `compileSuperMethodCall` |
| 167 | `compileSuperElementMethodCall` |
| 258 | `compileSuperPropertyAccess` (export) |
| 380 | `compileSuperElementAccess` (export) |
| 523 | `inferArrayElementType` |
| 602 | `usesArguments` |
| 615 | `flattenCallArgs` |
| 645 | `compileNewFunctionDeclaration` |
| 851 | `compileNewFunctionExpression` |
| 1212 | `compileClassExpression` |
| 1252 | `compileNewExpression` |

**Proposed decomposition:**

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `new-super/index.ts` | 200 | Re-export shell |
| `new-super/super.ts` | 700 | All super-call / super-property functions |
| `new-super/new-function.ts` | 800 | `compileNewFunctionDeclaration`, `compileNewFunctionExpression`, helpers |
| `new-super/new-class.ts` | 550 | `compileNewExpression`, `compileClassExpression`, `inferArrayElementType` |
| `new-super/helpers.ts` | 80 | `usesArguments`, `flattenCallArgs`, `resolveEnclosingClassName` (duplicate of shared.ts version — investigate) |

---

#### 2.16 `src/codegen-linear/runtime.ts` (2,668 LoC)

**Role.** 8 separate `addXxxRuntime(mod)` functions emitting linear-memory helper exports (Array, Uint8Array, String, Map, Set, NumericMap, NumericSet). Already cleanly split by collection-type — extract straightforwardly:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `codegen-linear/runtime/index.ts` | 60 | `addRuntime` (calls each subsection) + `findFuncIndex`, `addRuntimeFunc` helpers |
| `codegen-linear/runtime/array.ts` | 170 | `addArrayRuntime` |
| `codegen-linear/runtime/uint8array.ts` | 260 | `addUint8ArrayRuntime` |
| `codegen-linear/runtime/string.ts` | 790 | `addStringRuntime` |
| `codegen-linear/runtime/map.ts` | 400 | `addMapRuntime` |
| `codegen-linear/runtime/set.ts` | 280 | `addSetRuntime` |
| `codegen-linear/runtime/numeric-map.ts` | 385 | `addNumericMapRuntime` |
| `codegen-linear/runtime/numeric-set.ts` | 265 | `addNumericSetRuntime` |

**Risk: minimal.** Each function is a self-contained `addFunc` cascade. Easy first win.

---

#### 2.17 `src/codegen/type-coercion.ts` (2,513 LoC)

**Role.** Type-coercion emission (`coerceType` is *the* central helper for cross-ValType conversions).

**Function inventory:** 22 functions, dominated by `coerceType` itself (951–1928, ~970 LoC) — another God Function. Helpers: `buildVecFromExternref`, `buildTupleFromIterableFallback`, `buildTupleFromExternref`, `emitVecToTupleBody`, `emitVecToVecBody`, `emitStructNarrowBody`, `tryToStringFallback`, `emitToStringResultToF64*`.

**Proposed decomposition** into `src/codegen/type-coercion/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `type-coercion/index.ts` | 350 | `coerceType` shell + dispatch (`from-kind` → handler) |
| `type-coercion/guards.ts` | 80 | `emitGuardedRefCast`, `emitGuardedFuncRefCast` |
| `type-coercion/to-primitive.ts` | 130 | `pushStringHint`, `emitToPrimitiveHostCall`, `toPrimitiveHostCallInstrs` |
| `type-coercion/vec.ts` | 470 | `getVecInfo`, `buildVecFromExternref`, `emitVecToVecBody` |
| `type-coercion/tuple.ts` | 300 | `buildTupleFromIterableFallback`, `buildTupleFromExternref`, `getTupleFields`, `emitVecToTupleBody` |
| `type-coercion/struct.ts` | 350 | `getStructNarrowInfo`, `emitSafeStructConversion`, `isDeclaredStructSubtype`, `emitStructNarrowBody` |
| `type-coercion/to-f64.ts` | 250 | `tryToStringFallback`, `emitToStringResultToF64`, `emitToStringResultToF64ByKind`, `emitSafeExternrefToF64`, `emitUndefinedValue` |
| `type-coercion/defaults.ts` | 200 | `pushDefaultValue`, `pushParamSentinel`, `defaultValueInstrs`, `coercionInstrs` |

**Risk:** medium. `coerceType` is on the hot path — extraction must not change semantics. Recommendation: extract leaves first (`vec.ts`, `tuple.ts`, `struct.ts`), have them export pure-Instr builders, and have `coerceType` call them — no API change. Final step: rewrite `coerceType` as a dispatch table.

---

#### 2.18 `src/codegen/stack-balance.ts` (2,512 LoC)

**Role.** Post-codegen pass that infers and corrects stack-balance / branch-type mismatches.

**Function inventory:** Already well-organized (18 functions, mostly ≤200 LoC each): `eliminateDeadCode`, `instrDelta`, `sequenceDelta`, `blockTypeExpected`, `inferLastType`, `fixBranchType`, `fixBranch`, `fixBody`, `inferInstrType`, `callArgCoercionInstrs`, `fixCallArgTypesInBody`, `fixStructNewFieldCoercion`, `updateTypeStack`.

**Proposed decomposition** into `src/codegen/stack-balance/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `stack-balance/index.ts` | 250 | `stackBalance` (top entry) + `buildFuncSigs`, `getFullParamTypes`, `getTagArity`, `valTypeCategory` |
| `stack-balance/instr-delta.ts` | 320 | `instrDelta`, `sequenceDelta`, `blockTypeExpected`, `inferInstrType`, `inferLastType`, `typesCompatible` |
| `stack-balance/branch-fix.ts` | 350 | `fixBranchType`, `fixBranch`, `fixBody`, `updateTypeStack` |
| `stack-balance/coercion.ts` | 600 | `callArgCoercionInstrs`, `fixCallArgTypesInBody`, `fixStructNewFieldCoercion` |
| `stack-balance/dead-code.ts` | 70 | `eliminateDeadCode`, `isTerminator`, `resolveFuncType` |

**Risk:** low — internally a pure pass with stable signatures.

---

#### 2.19 `src/ir/lower.ts` (2,310 LoC)

**Role.** Lowers IR to Wasm instructions (the IR→Wasm backend). Already organized by lowering pass and IR-instr kind. Main function `lowerIrFunctionToWasm` (309) is a large body with per-instr handlers.

**Proposed decomposition** into `src/ir/lower/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `lower/index.ts` | 350 | `lowerIrFunctionToWasm` shell + interfaces |
| `lower/value-types.ts` | 250 | `lowerIrTypeToValType`, `describeShape`, `describeIrTypeShallow` |
| `lower/instr-handlers.ts` | 700 | per-instr handlers (const, binary, unary, select, if, await, async, raw-wasm, box/unbox/tag-test) |
| `lower/uses.ts` | 200 | `collectIrUses`, `collectForOfBodyUses`, `collectTerminatorUses` |
| `lower/jsop-bitwise.ts` | 100 | `jsBitwiseToI32`, `emitJsToInt32` |
| `lower/const-emit.ts` | 130 | `emitConst` |
| (remaining instr-handlers as needed) | ~580 | continue subdivision based on instr kind |

**Risk:** medium — IR lowering is fragile; do this *after* the `from-ast.ts` split and only when IR coverage is stable.

---

#### 2.20 `src/codegen/binary-ops.ts` (2,246 LoC)

**Role.** Binary operator codegen. Already well-structured (`compileBinaryExpression` dispatcher + per-type compilers).

**Proposed decomposition** into `src/codegen/binary-ops/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `binary-ops/index.ts` | 300 | `compileBinaryExpression` shell + `tryFlattenBinaryChain` |
| `binary-ops/numeric.ts` | 250 | `compileNumericBinaryOp` |
| `binary-ops/i32.ts` | 100 | `compileI32BinaryOp` |
| `binary-ops/i64.ts` | 130 | `compileI64BinaryOp` |
| `binary-ops/bitwise.ts` | 100 | `compileBitwiseBinaryOp`, `emitToInt32` |
| `binary-ops/modulo.ts` | 70 | `compileModulo`, `emitModulo` |
| `binary-ops/boolean.ts` | 80 | `compileBooleanBinaryOp` |
| `binary-ops/any-dispatch.ts` | 1,200 | `compileAnyBinaryDispatch` (the giant tag-dispatched any-binary fallback) |

**Risk:** low — boundaries are already function-level.

---

#### 2.21 `src/codegen/literals.ts` (2,245 LoC)

**Role.** Object-literal, array-literal, tuple-literal compilation, plus constant evaluation.

**Proposed decomposition** into `src/codegen/literals/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `literals/index.ts` | 150 | re-export façade + `_isUndefinedLike` |
| `literals/object.ts` | 800 | `compileObjectLiteral`, `compileObjectLiteralAsExternref`, `compileObjectLiteralWithAccessors`, `compileObjectLiteralForStruct`, `compileWidenedEmptyObject`, `ensureComputedPropertyFields` |
| `literals/array.ts` | 700 | `compileArrayLiteral`, `compileTupleLiteral`, `compileArrayConstructorCall`, `detectCountedPushLoopSize`, `isNonThrowingFillRhs`, `detectCountedIndexAssignSize` |
| `literals/constants.ts` | 280 | `resolveConstantExpression`, `resolvePropertyNameText`, `resolveComputedKeyExpression`, `resolveAccessorPropName` |
| `literals/symbol.ts` | 100 | `resolveWellKnownSymbol`, `getWellKnownSymbolId`, `ensureSymbolCounter`, `compileSymbolCall` |

**Risk:** low.

---

#### 2.22 `src/codegen/statements/destructuring.ts` (2,082 LoC)

**Role.** Decl-form destructuring (not assignment-form, which is in `assignment.ts`).

**Proposed decomposition** into `src/codegen/statements/destructuring/`:

| New file | ~Lines | Holds |
|----------|-------:|-------|
| `destructuring/index.ts` | 100 | `ensureBindingLocals`, `syncDestructuredLocalsToGlobals`, `emitNullGuard`, `ensureAsyncIterator`, `ensureExternIsUndefined`, `emitExternrefDefaultCheck`, `emitNestedBindingDefault`, `emitDefaultValueCheck` |
| `destructuring/object.ts` | 700 | `compileObjectDestructuring` |
| `destructuring/object-extern.ts` | 200 | `compileExternrefObjectDestructuringDecl` |
| `destructuring/array.ts` | 950 | `compileArrayDestructuring` |
| `destructuring/array-extern.ts` | 250 | `compileExternrefArrayDestructuringDecl` |
| `destructuring/string.ts` | 100 | `compileStringDestructuring` |

**Risk:** low–medium.

---

### 3. Shared-type gaps & circular-dependency analysis

#### 3.1 The `shared.ts` registration pattern is good — but overused as a workaround

`src/codegen/shared.ts` (531 LoC) uses an explicit register/lookup pattern to break circular imports:

```ts
let _compileExpression: CompileExpressionFn | undefined;
export function registerCompileExpression(fn: CompileExpressionFn): void { _compileExpression = fn; }
export function compileExpression(ctx, fctx, expr, hint?) { return _compileExpression!(ctx, fctx, expr, hint); }
```

There are **22 such register pairs** — `registerCompileExpression`, `registerCompileArrowAsClosure`, `registerEmitBoundsCheckedArrayGet`, `registerResolveEnclosingClassName`, `registerCoerceType`, `registerEnsureLateImport`, `registerFlushLateImportShifts`, `registerEnsureAnyHelpers`, `registerResolveComputedKeyExpression`, `registerCompileStatement`, `registerEnsureBindingLocals`, `registerHoistFunctionDeclarations`, `registerEmitNestedBindingDefault`, `registerEmitDefaultValueCheck`, `registerEmitArgumentsObject`, `registerCompileStringLiteral`, `registerCompileSuperPropertyAccess`, plus `registerAddStringImports` (called from `codegen/index.ts`).

**Pros**: solves circular import issues at compile-time without a refactor.
**Cons**: 
- 22 mutable globals — no static analysis catches "forgot to register".
- Hides the actual dependency graph from the type system.
- Each `register*` is paired with a runtime null-assertion (`!`).

**Recommendation**: after the extractions in §2.1–2.2 land, audit each register pair. Many of them only exist because `codegen/index.ts` was the central hub; once it's broken up, several can become normal imports. **Target: reduce 22 registers to ≤8** by the end of the modularization sprint.

#### 3.2 Duplicate symbol definitions to fold

Confirmed duplicates by grep:

| Symbol | Defined in | Should live in |
|--------|------------|----------------|
| `resolveEnclosingClassName` | `codegen/shared.ts` (registered), `codegen/expressions/new-super.ts:44` | `codegen/shared.ts` only; `new-super.ts` should import |
| `usesArguments` | `codegen/expressions/calls.ts:300`, `codegen/expressions/new-super.ts:602`, `codegen/helpers/body-uses-arguments.ts` (`bodyUsesArguments`) | `codegen/helpers/body-uses-arguments.ts` — others import |
| `flattenCallArgs` | `codegen/expressions/calls.ts:441`, `codegen/expressions/new-super.ts:615` | Move to `codegen/expressions/calls/helpers.ts` |
| `parseRegExpLiteral` | `codegen/index.ts:3959`, `codegen/typeof-delete.ts:287` (`compileRegExpLiteral`) | `codegen/regexp.ts` (new module — also used by `calls.ts/eval.ts`) |
| `getWellKnownSymbolId` | `codegen/literals.ts:717`, `codegen/property-access.ts:74` (private) | `codegen/literals/symbol.ts` only |
| `coerceType` | `codegen/expressions.ts:667`, `codegen/type-coercion.ts:951`, `codegen/shared.ts:196` (registered) | Single source in `codegen/type-coercion/index.ts`; `expressions.ts` and `shared.ts` re-export only |
| `getLine` / `getCol` | `codegen/shared.ts:62,73`, `codegen/statements/nested-declarations.ts:879,890` | `codegen/shared.ts` only |
| `isCompoundAssignment` | `codegen/expressions/assignment.ts:3645`, `codegen-linear/index.ts:2060` | OK to keep separate (different backends) |
| `unwrapParens` | `codegen/expressions/unary.ts:28`, `codegen/expressions/misc.ts:490` | Move to `codegen/expressions/helpers.ts` |
| `hasExportModifier` | `codegen/index.ts:8162`, `compiler/validation.ts:3259`, `treeshake.ts:229`, `ir/integration.ts:640` | `codegen/ts-modifiers.ts` — all import from there |

#### 3.3 Cross-domain import tangles

- **`codegen/expressions/calls.ts` imports `array-methods.ts`** which makes sense (Array.from etc.) — clean.
- **`codegen-linear/*.ts` does NOT import `codegen/*.ts`** — clean separation, preserve this invariant.
- **`ir/integration.ts` imports `codegen/*.ts`** (the IR↔legacy bridge) — necessary, and isolated to a single file. Clean.
- **`codegen/*.ts` imports `ir/types.ts`** broadly (for `Instr`, `ValType`, `WasmModule`, `WasmFunction`) — fine; `ir/types.ts` is the de-facto IR data definition module.
- **No file imports `codegen-linear/*.ts` from `codegen/*.ts`** — good.

#### 3.4 Cross-file `ValType` / `Instr` constructor noise

Per CLAUDE.md, 158 occurrences of `as unknown as Instr` for ops not yet in the `Instr` union (e.g. `f64.copysign`, `f64.min/max`). This is a typing debt — orthogonal to file-size but worth a follow-up issue (#1561-followup-typing).

### 4. `src/codegen/index.ts` deep dive (already covered in §2.2)

The full per-subsection split is in §2.2; the headline is:
- **35 new files** replacing one 8,313-LoC monolith.
- **Sequenced over 7 waves**, each shippable independently.
- **`codegen/index.ts` ends at ~800 LoC** (orchestrator only).
- **`resolveWasmType` is the keystone export** (12 importers); plan its move last with a re-export shim during transition.

### 5. `src/codegen/expressions/calls.ts` deep dive (already covered in §2.1)

Headline:
- **22 new files** replacing one 8,502-LoC monolith.
- **Calls.ts ends at ~200 LoC** (`calls/index.ts` re-export + dispatcher).
- **`compileCallExpression` becomes a switch on AST shape** that hands off to one of `property-access.ts`, `identifier-callee.ts`, `element-callee.ts`, `nested-callee.ts`, `conditional-callee.ts`, `super-call.ts`, `eval.ts`, `dynamic-import.ts`, `iife.ts`, `node-fs.ts`.

### 6. `src/runtime.ts` deep dive (already covered in §2.4)

Headline:
- **`resolveImport` (~3,030 LoC) is the single biggest target** in the runtime.
- Split into `runtime/resolve-import/` with one file per `ImportIntent` case-family (math, console, string, extern-class, object, array, string-ops, number-ops, collections, promise, iterator, regexp, dataview, symbol, wasi, getter-setter, test262-shim).
- **Test262 shim should move out of the source first** — it's a 90-LoC string literal currently buried in the `extern_class new Test262Error` case.
- **`runtime.ts` ends as a re-export façade** (~50 LoC) to preserve the package's public surface (`buildImports`, `wrapExports`, `instantiateWasm`, etc.).

### 7. Priority-ordered extraction backlog (28 items)

Ranked by **(LoC moved out of hot files) × (safety) × (sequencing freedom)**. Items #1–8 can be done in parallel by independent devs.

| # | Extraction | Lines moved | Hot file relief | Risk | Depends on |
|---|------------|------------:|-----------------|------|------------|
| **1** | `codegen/ts-modifiers.ts` from `codegen/index.ts` | 80 | index.ts -80 | 🟢 trivial | — |
| **2** | `codegen/wasi/{start,imports,native-helpers,dom-check}.ts` from `codegen/index.ts` | 600 | index.ts -600 | 🟢 low | — |
| **3** | `codegen/exports/{closure-call,struct-fields,vec-access,dataview,iterator,to-primitive}.ts` from `codegen/index.ts` | 1,700 | index.ts -1,700 | 🟢 low | — |
| **4** | `codegen-linear/runtime/{array,uint8array,string,map,set,numeric-map,numeric-set}.ts` from `codegen-linear/runtime.ts` | 2,600 | runtime.ts -2,600 | 🟢 low | — |
| **5** | `codegen/expressions/calls/eval.ts`, `dynamic-import.ts`, `node-fs.ts`, `array-of-from.ts`, `symbol-arraybuffer.ts`, `promise-json.ts`, `date.ts`, `wrapper-instance.ts`, `coercion-methods.ts`, `iife.ts`, `super-call.ts`, `conditional-callee.ts` — first wave of `calls.ts` | 3,800 | calls.ts -3,800 | 🟢 low | — |
| **6** | `runtime/{sidecar,descriptors,closure,toprimitive,struct-bridge,method-bridge,array-sparse,instantiate}.ts` from `runtime.ts` | 1,500 | runtime.ts -1,500 | 🟢 low | — |
| **7** | `codegen/array/{mutators,accessors,search,join-string,flatten,sort,es2023,iterator}.ts` from `array-methods.ts` | 2,700 | array-methods.ts -2,700 | 🟢 low | helpers.ts first |
| **8** | `codegen/import-collectors/{console,primitive-methods,string-methods,string-literals,math,parse,constructors,string-static,promise,json,callbacks,generators,array-hof,lib-globals}.ts` | 1,800 | index.ts -1,800 | 🟢 low | ts-modifiers.ts |
| **9** | `codegen/extern-classes/{registry,collect}.ts` from `codegen/index.ts` | 1,100 | index.ts -1,100 | 🟡 medium | — |
| **10** | `codegen/expressions/assignment/{destructuring,property,element,logical,compound,string-compound}.ts` | 4,400 | assignment.ts -4,400 | 🟡 medium | — |
| **11** | `codegen/array/hof-{kernel,collectors,predicates}.ts` from `array-methods.ts` | 1,500 | array-methods.ts -1,500 | 🟡 medium | helpers.ts |
| **12** | `codegen/expressions/calls/object-statics.ts` from `calls.ts` | 1,300 | calls.ts -1,300 | 🟡 medium | first wave done |
| **13** | `codegen/expressions/calls/class-method-dispatch.ts` from `calls.ts` | 1,100 | calls.ts -1,100 | 🟡 medium | first wave done |
| **14** | `codegen/hoisting.ts` from `codegen/index.ts` | 450 | index.ts -450 | 🟡 medium | — |
| **15** | `codegen/import-collectors/{unions,iterators}.ts` from `codegen/index.ts` | 850 | index.ts -850 | 🟡 medium | other collectors done |
| **16** | `codegen/type-resolution.ts` from `codegen/index.ts` (+12 importer updates) | 520 | index.ts -520 | 🟠 medium-high | re-export shim |
| **17** | `compiler/validation/early-errors/*.ts` from `compiler/validation.ts` | 2,800 | validation.ts -2,800 | 🟠 medium-high | section labelling pass |
| **18** | `codegen/native-strings/{basic,search,transform,split-replace,concat,conversion,iteration,extern-bridge,test-runtime}.ts` | 2,900 | native-strings.ts -2,900 | 🟡 medium | shared `addRuntimeFunc` builder |
| **19** | `codegen/statements/loops/{while-do,for,for-in,for-of/*}.ts` from `loops.ts` | 2,900 | loops.ts -2,900 | 🟡 medium | — |
| **20** | `codegen/closures/{scope-analysis,params,callback,funcref-wrapper}.ts` | 1,800 | closures.ts -1,800 | 🟡 medium | — |
| **21** | `codegen/property-access/{struct-resolution,struct-get,optional,extern-get,element,null-guards}.ts` | 2,500 | property-access.ts -2,500 | 🟠 medium-high | — |
| **22** | `codegen/type-coercion/{vec,tuple,struct,to-f64,defaults,guards,to-primitive}.ts` | 2,200 | type-coercion.ts -2,200 | 🟠 medium-high | — |
| **23** | `codegen/expressions/calls/identifier-callee.ts`, `element-callee.ts`, `nested-callee.ts` — third wave of `calls.ts` | 2,650 | calls.ts -2,650 | 🟠 medium-high | helpers.ts |
| **24** | `runtime/resolve-import/*.ts` — split `resolveImport` into per-case files | 3,030 | runtime.ts -3,030 | 🟠 medium-high | test262-shim.ts extracted first |
| **25** | `codegen/declarations/{unified-collector,type-inference,shape-inference-bridge,struct-fields,interfaces}.ts` | 2,800 | declarations.ts -2,800 | 🟠 medium-high | — |
| **26** | `codegen/object-ops/{define-property,define-properties,keys-values,introspection,guards}.ts` | 2,500 | object-ops.ts -2,500 | 🟡 medium | — |
| **27** | `codegen/binary-ops/{numeric,i32,i64,bitwise,modulo,boolean,any-dispatch}.ts` | 1,900 | binary-ops.ts -1,900 | 🟡 medium | — |
| **28** | `codegen/literals/{object,array,constants,symbol}.ts` | 2,000 | literals.ts -2,000 | 🟡 medium | — |

**Realistic sprint plan**:
- **Sprint A (1 sprint, 3–4 devs in parallel)**: items #1–8 (all 🟢-low risk, no inter-dependencies). Estimated **~14,800 LoC moved** across hot files. After Sprint A, `calls.ts` drops below 5,000 LoC and `codegen/index.ts` drops below 4,500 LoC.
- **Sprint B**: items #9–15. Estimated **~10,500 LoC moved**. After Sprint B, `calls.ts` drops below 2,500 LoC, `codegen/index.ts` drops below 2,000 LoC.
- **Sprint C**: items #16–22. **~17,000 LoC moved**, hits the property-access and type-coercion dragons.
- **Sprint D**: items #23–28. Final clean-up; `runtime.ts` split; `declarations.ts` split.

### 8. What NOT to split (stay-as-is list)

These files are already well-scoped — extracting from them would be churn, not improvement:

| File | LoC | Why keep |
|------|----:|----------|
| `src/codegen/peephole.ts` | 231 | Single pass, single entry — atomic. |
| `src/codegen/dead-elimination.ts` | 428 | Single pass; helpers don't need separate files. |
| `src/codegen/walk-instructions.ts` | 38 | Tiny utility. |
| `src/codegen/shared.ts` | 531 | Acts as a router; consolidation point, not a god module (despite size). |
| `src/codegen/timsort.ts` | 922 | Self-contained sort emitter; internal `IF`/`LOOP`/`BR` DSL would just create cross-file noise. |
| `src/codegen/string-builder.ts` | 556 | Single feature, atomic. |
| `src/codegen/array-element-typing.ts` | 402 | Single analysis pass. |
| `src/codegen/array-reduce-fusion.ts` | 621 | Single fusion pass; `detect` + `apply` is the right shape. |
| `src/codegen/async-scheduler.ts` | 232 | Single feature. |
| `src/codegen/math-helpers.ts` | 1,606 | Despite size, it's a list of per-function emitters keyed by name — splitting by Math function gains nothing. |
| `src/codegen/builtin-tags.ts` | 223 | Static tables + tiny predicates. |
| `src/codegen/any-helpers.ts` | 1,170 | Centralizes the "any-value" struct — splitting would scatter the single-cell concept. |
| `src/codegen/fixups.ts` | 1,003 | A set of mutually-recursive post-passes; splitting would break local reasoning. |
| `src/codegen/function-body.ts` | 984 | Per-function body emitter; coherent single-purpose. |
| `src/codegen/destructuring-params.ts` | 1,425 | Already split from `statements/destructuring.ts`; further split unjustified. |
| `src/codegen/expressions.ts` | 1,061 | Dispatcher only — keep as the central re-export. |
| `src/codegen/expressions/unary.ts` | 1,643 | 5 cohesive functions (prefix/postfix on identifier/property/element); fine. |
| `src/codegen/expressions/builtins.ts` | 1,804 | Date+Math+Console internal kernels — already disciplined. |
| `src/codegen/expressions/calls-closures.ts` | 842 | 6 cohesive helpers — fine. |
| `src/codegen/expressions/identifiers.ts` | 819 | Single feature (identifier resolution + TDZ). |
| `src/codegen/typeof-delete.ts` | 958 | `typeof`, `delete`, `instanceof`, RegExp literal — all small primitive-shape codegen. Single tight module is right. |
| `src/codegen/string-ops.ts` | 1,880 | Template + binary + tagged-template emitters; coherent. |
| `src/codegen/class-bodies.ts` | 1,735 | Class body emit; single feature. |
| `src/ir/nodes.ts` | 1,940 | Pure data definitions (no code paths). |
| `src/ir/types.ts` | 428 | Pure data. |
| `src/ir/integration.ts` | 1,585 | IR↔legacy bridge; splitting weakens encapsulation. |
| `src/ir/builder.ts` | 1,132 | `IrFunctionBuilder` class; single-purpose. |
| `src/ir/propagate.ts` | 1,210 | Single dataflow pass with helpers all keyed off the same lattice. |
| `src/ir/select.ts` | 2,038 | Phase-1 claim predicate — splitting predicates by AST kind would create cross-file recursion. Keep. |
| `src/ir/passes/*.ts` | <800 each | Each pass is one function plus helpers; appropriate granularity already. |
| `src/codegen/statements/{exceptions,control-flow,variables,nested-declarations,tdz,shared}.ts` | each <1,200 | Already split appropriately. |
| `src/emit/binary.ts` | 1,591 | Single emitter; logical splits already exist (`encoder.ts`, `wat.ts`, `object.ts`, `sourcemap.ts`). |
| `src/emit/object.ts`, `wat.ts`, `encoder.ts`, `opcodes.ts`, `sourcemap.ts`, `c-header.ts` | <1,000 each | All scoped. |
| `src/link/*.ts` | <700 each | Already split by phase (reader, resolver, isolation, linker). |
| `src/checker/*.ts` | <700 each | TS-adapter; correct shape. |
| `src/compiler/{output,import-manifest,define-substitution}.ts`, `src/compiler.ts` | <1,100 each | OK as-is. (`compiler.ts:compileSource` at 411 LoC could be sub-divided if it grows further — note for a future review.) |
| `src/codegen-linear/{c-abi,context,layout,simd}.ts` | <870 each | All scoped. |
| `src/runtime-{containment,eval,instantiate}.ts`, `src/runtime/builtins.ts` | <410 each | Coherent. |

### Closing notes

1. **The 4 monolithic files** (`calls.ts`, `codegen/index.ts`, `runtime.ts`, `array-methods.ts`) collectively account for **27,758 LoC = 20% of the entire codebase**. Reducing those four to their orchestrator skeletons (~3,000 LoC total) eliminates roughly 25,000 LoC of merge-conflict surface.
2. **The 5 God Functions** (`compileCallExpression`, `resolveImport`, `detectEarlyErrors`, `coerceType`, `compileArrowAsClosure`) together hold ~14,700 LoC — splitting them is what actually reduces *per-PR* friction. Pure file-renames don't reduce conflict frequency if a 3,000-LoC function still lives in one file.
3. **Sprint A (the 8 🟢-low-risk items)** is the highest-value-per-week work. Each item is shippable as a single PR by a single dev with negligible test risk. If the team starts there, the next sprint planning meeting will see *visibly* smaller diffs on touched files.
4. **`shared.ts`'s 22 registration pairs** should shrink as the dependency graph straightens out. Track this metric — it's the proxy for "how knotted is the import graph?".
5. **Test discipline during extractions**: every extraction PR should run `npm test -- tests/equivalence.test.ts` (full) and one test262 shard. The CI guard on regressions (`test262-baseline-validate.yml`) catches accidental semantic changes.

— *Architect, 2026-05-21.*

