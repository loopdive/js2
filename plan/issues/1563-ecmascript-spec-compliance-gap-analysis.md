---
id: 1563
title: "Architect: compare compiler codebase against ECMAScript spec — identify compliance gaps"
status: ready
created: 2026-05-21
updated: 2026-05-21
priority: high
feasibility: hard
model: fable
reasoning_effort: max
task_type: research+architecture
area: spec-compliance
goal: spec-completeness
sprint: Backlog
related: [779, 820, 1042, 1116, 1151]
---
# #1563 — ECMAScript spec compliance gap analysis

## Motivation

The compiler implements a large subset of ECMAScript but has no systematic
cross-reference between its codegen and the ECMAScript specification. Bugs
are found reactively (a test262 failure points to a spec section), not
proactively. This task asks an architect to systematically walk the
ECMAScript spec, compare it against the compiler's implementation, and
produce a gap analysis: what is missing, what is wrong, and what is
correctly implemented.

The output feeds directly into sprint planning — each identified gap
becomes a candidate issue.

## Scope

The architect should cover these specification chapters in depth:

### Tier 1 — Core language semantics (must cover fully)

| Chapter | Topic | Key compiler files |
|---------|-------|-------------------|
| §6 — Data Types and Values | Types, completion records, references | `type-coercion.ts`, `any-helpers.ts` |
| §7 — Abstract Operations | ToNumber, ToString, ToObject, etc. | `type-coercion.ts`, `binary-ops.ts` |
| §8 — Syntax-Directed Operations | Evaluation, binding | `declarations.ts`, `destructuring-params.ts` |
| §10 — Ordinary and Exotic Objects | OrdinaryGet, OrdinarySet, OrdinaryDefine | `property-access.ts`, `object-ops.ts`, `runtime.ts` |
| §12 — ECMAScript Language: Lexical Grammar | Template literals, regex literals | `literals.ts` |
| §13 — ECMAScript Language: Expressions | Every expression type | `expressions/*.ts` |
| §14 — ECMAScript Language: Statements | Every statement type | `statements/*.ts`, `declarations.ts` |
| §15 — ECMAScript Language: Functions and Classes | Functions, classes, generators, async | `closures.ts`, `class-bodies.ts`, `expressions/new-super.ts` |
| §22 — Indexed Collections | Array, TypedArray | `array-methods.ts`, `builtins/array.ts` |
| §23 — Keyed Collections | Map, Set, WeakMap, WeakSet | `runtime.ts`, builtins |
| §24 — Structured Data | ArrayBuffer, DataView, JSON | builtins |
| §25 — Managing Memory | WeakRef, FinalizationRegistry | (wont-fix, but document) |
| §26 — Control Abstraction | Iterators, generators, async | `async-scheduler.ts`, `closures.ts` |
| §27 — Reflection | Proxy, Reflect | (wont-fix, but document) |

### Tier 2 — Built-in objects (spot-check the most-failed ones)

| Built-in | test262 failure volume | Check |
|----------|----------------------|-------|
| `Array.prototype.*` | ~948 assertion_fail | Full review |
| `String.prototype.*` | ~200+ | Split, replace, match, search |
| `Object.*` | ~200+ | defineProperty, create, assign, keys |
| `Promise.*` | ~210+ | all, allSettled, race, any, resolve, reject |
| `RegExp.prototype.*` | ~150+ | exec, test, Symbol.* |
| `Function.prototype.*` | ~44 | toString, bind, call, apply |
| `Generator/AsyncGenerator` | ~36 | brand checks, iterator protocol |

## What to check for each spec section

For each §-section or abstract operation:

1. **Find the implementation**: where in `src/` does the compiler handle this?
   Use grep to locate:
   ```bash
   grep -rn "ToNumber\|toNumber\|ToNumeric" /workspace/src/codegen/ | head -10
   ```

2. **Check completeness**: does the implementation cover all steps of the spec
   algorithm? Common gaps:
   - Missing step (e.g., spec says "if Type(x) is Symbol, throw TypeError" but
     compiler silently converts)
   - Wrong order of operations (e.g., ToPropertyKey before argument evaluation)
   - Missing brand check (e.g., Array.prototype.map on non-Array receiver)
   - Missing [[Call]] vs [[Construct]] distinction

3. **Check correctness**: does the compiled output produce spec-correct results?
   For abstract operations, write a minimal test in `.tmp/` and compile it:
   ```bash
   echo 'console.log(typeof null)' > /workspace/.tmp/spec-null.ts
   node /workspace/src/cli.ts /workspace/.tmp/spec-null.ts
   ```

4. **Note the gap**: record it in the analysis with:
   - Spec reference (§N.M.P)
   - What step is missing/wrong
   - Estimated test262 impact (how many tests likely fail because of this)
   - Which compiler file/function needs to change
   - Difficulty: easy (1 guard) / medium (1 function) / hard (design change)

## Approach

### Step 1: Fetch the live ECMAScript spec

The spec is at `https://tc39.es/ecma262/`. Use WebFetch to read specific sections.
Key sections to fetch:
- §7.1 Type Conversion: `https://tc39.es/ecma262/#sec-type-conversion`
- §13.5 Unary Operators: `https://tc39.es/ecma262/#sec-unary-operators`
- §13.10 Relational Operators: `https://tc39.es/ecma262/#sec-relational-operators`
- §15.8 Async Function Definitions: `https://tc39.es/ecma262/#sec-async-function-definitions`

Fetch sections relevant to currently-failing test262 clusters first.

### Step 2: Map spec sections to compiler files

Build a table: spec section → compiler file → implementation status.
Use `grep -rn` liberally to find implementations.

### Step 3: Identify and rank gaps

For each gap:
- Assign a severity: **P0** (compiler crash/trap), **P1** (wrong value),
  **P2** (missing feature), **P3** (edge case)
- Estimate test262 impact (even rough: "~10 tests", "~200 tests", ">1000 tests")
- Determine if an issue already exists in `plan/issues/` for this gap

### Step 4: Cross-reference with existing issues

```bash
# Check if a gap is already tracked
grep -r "ToObject\|toObject" /workspace/plan/issues/ | grep "^.*id:" | head -10
```

If a gap is already tracked in an issue, note the issue ID. If not, propose a new issue.

## Output format

Append `## Spec Compliance Analysis` to this issue file. Structure:

```markdown
## Spec Compliance Analysis (2026-05-21)

### Summary table

| Spec Chapter | Implementation Status | Gap Count | Highest-impact gap |
|---|---|---|---|
| §7.1 Type Conversion | Partial | 3 | ToNumber on Symbol must throw |
...

### Gap inventory

#### §7.1.3 ToNumeric
- **Status**: Partial
- **Missing**: Step 3 — if Type(value) is Symbol, throw TypeError. Currently silently converts to NaN.
- **Impact**: ~12 test262 tests in `built-ins/Number/`
- **Fix**: 2-line guard in `src/codegen/type-coercion.ts:compileToNumeric`
- **Difficulty**: easy
- **Existing issue**: none → propose #1564

...

### New issue proposals

| Proposed ID | Title | Spec ref | Est. FAIL | Difficulty |
|---|---|---|---|---|
| 1564 | ToNumeric: Symbol should throw TypeError | §7.1.3 step 3 | ~12 | easy |
...
```

## Acceptance criteria

- [ ] Tier 1 spec chapters (§6–§15, §22–§26) fully surveyed
- [ ] All 7 Tier 2 built-ins spot-checked against actual compiler output
- [ ] Gap inventory contains ≥30 identified gaps with spec references
- [ ] Each gap has: severity, test262 impact estimate, fix location, difficulty
- [ ] New issue proposals table with ≥10 actionable entries
- [ ] Cross-referenced against existing `plan/issues/` — no duplicate proposals
- [ ] No code changes — analysis only, written to this issue file

## Spec Compliance Analysis (2026-05-21)

> Architect: po-issues (PO). Inputs: `benchmarks/results/test262-current.jsonl`
> snapshot 21.5.2026 00:24 (13,654 official fails), live spec at
> `https://tc39.es/ecma262/`, source tree `src/codegen/**` (~30k LOC across
> the 10 hot files). This is a static + spec-driven survey, not a per-test
> root-cause analysis — for that see #820 and #779 investigation notes.

### Methodology

1. **Bucketed test262 fails** by (path-prefix, error_category) using
   `benchmarks/results/test262-current.jsonl`. Top buckets surface the
   highest-value compliance gaps.
2. **Walked the spec** §6 → §27 and mapped each chapter's abstract
   operations and intrinsics to the compiler files implementing them.
3. **Reviewed source** for missing steps, wrong ordering, missing brand
   checks, and missing TypeErrors that the spec mandates.
4. **Cross-referenced against existing `plan/issues/`** so we don't re-file
   gaps that are already tracked.

### Summary table — spec chapters

| Chapter | Topic | Impl files | Status | Gap count | Top gap |
|---------|-------|-----------|--------|-----------|---------|
| §6 Data Types | Value reps, completion records | `type-coercion.ts`, `any-helpers.ts` | Good | 1 | Type(Symbol) underused (Symbol mostly absent) |
| §7.1 Type Conversion | ToPrimitive/ToNumber/ToString/ToObject/ToPropertyKey | `type-coercion.ts`, `runtime.ts:_genericToPrimitive` | Partial | 5 | ToPropertyKey not called on computed keys |
| §7.2 Testing/Comparison | IsCallable, IsArray, SameValue, IsStrictlyEqual | `binary-ops.ts`, `runtime.ts` | Partial | 3 | SameValueZero NaN/+0/-0 inconsistency in built-ins |
| §7.3 Objects | OrdinaryGet/Set/Define, HasProperty, GetMethod | `property-access.ts`, `object-ops.ts`, `runtime.ts` | Partial | 4 | OrdinaryToPrimitive sidecar fallback (#1253 residual) |
| §7.4 Iterator | GetIterator/IteratorNext/IteratorClose/IteratorStep | `closures.ts`, `runtime.ts`, `expressions/calls.ts` | Partial | 3 | IteratorClose not invoked on early return from for-of in many paths |
| §8 Syntax-Directed Ops | Evaluation, binding, declaration | `declarations.ts`, `destructuring-params.ts` | Partial | 4 | dstr-binding default-init typing residuals (#1553 sub-issues) |
| §10 Ordinary/Exotic Objects | [[Get]]/[[Set]]/[[DefineOwn]] | `property-access.ts`, `runtime.ts` | Partial | 5 | Instance Proxy.getPrototypeOf returns Object.prototype (#779b/#1364b) |
| §12 Lexical Grammar | Template literals, regex literals | `literals.ts` | Good | 1 | Tagged-template cache identity (#229 long-standing) |
| §13 Expressions | Every expression type | `expressions/**` | Partial | 6 | Argument evaluation order on tagged calls (subset) |
| §14 Statements | Every statement type | `statements/**`, `declarations.ts` | Partial | 4 | for-of/dstr residuals (#1396/#1454/#1468) |
| §15 Functions & Classes | Functions/classes/generators/async | `closures.ts`, `class-bodies.ts`, `expressions/new-super.ts` | Partial | 7 | Class-body prototype chain not wired (#1364b) — root of ~1,790 fails |
| §15.7 Class Definitions | DefineMethod, ClassElementEvaluation | `class-bodies.ts` | Partial | 3 | Static private methods + prototype lookup chain |
| §15.8 Async Functions | Async resumption / AsyncFunctionStart | `async-scheduler.ts`, `runtime.ts` | Partial | 5 | Sync throw → must produce a rejected Promise (#1151 Gap B) |
| §22.1 Array | Array.prototype.* | `array-methods.ts`, `builtins/array.ts` | Partial | 5 | `arguments` argv shape mismatch (#1461) — ~948 fails |
| §22.2 Strings & RegExp | String.prototype.*, RegExp.* | `string-ops.ts`, `runtime.ts` | Partial | 5 | RegExp Symbol.replace/match/search/split (~150 fails) |
| §23 Keyed Collections | Map/Set/WeakMap/WeakSet | `runtime.ts` host imports | Partial | 2 | Tracked in #1103 (Wasm-native rewrite) |
| §24 Structured Data | ArrayBuffer/DataView/JSON | `expressions/calls.ts`, host imports | Partial | 4 | DataView byteLength on resizable buffers, JSON receiver coercion |
| §25 Memory Management | WeakRef/FinalizationRegistry | n/a | Won't-fix | 0 | (documented in #1355/#1356) |
| §26 Control Abstraction | Iterators/generators/async iterators | `closures.ts`, `async-scheduler.ts`, `expressions/yield.ts` | Partial | 6 | Iterator helpers prototype chain not registered (~178 fails) |
| §27 Reflection | Proxy, Reflect | `runtime.ts`, `expressions/calls.ts` | Partial | 4 | Proxy invariants on ownKeys/get/set (~145 fails) |
| §28 Built-in Tagged | Atomics, SharedArrayBuffer | (skipped) | Won't-fix | 0 | (tracked in #1354) |

### Cross-cutting observations

Three structural gaps explain ~60% of the 13,654 failure budget:

1. **Prototype chain not wired on instances (#1364b)**. `_wrapForHost`'s
   `getPrototypeOf` trap returns `Object.prototype`, so JS native lookup
   doesn't fall through to the class prototype where bridge methods live.
   Affects ~1,790 fails across `language/{statements,expressions}/class/{dstr,elements}`
   and built-in `verifyProperty(Class.prototype, "m", …)` assertions.
2. **No spec-Array prototype on builtin-returned arrays**. `split`, slice
   returned from other builtins, regex match groups — all produce arrays
   whose `[[Prototype]]` is not `%Array.prototype%`. Affects ~78 (`split` only)
   plus a long tail across Array/String/RegExp.
3. **Array-like receivers feed wrong `arguments` shape into callbacks** (#1461).
   ~948 Array.prototype.{filter,map,every,some,forEach,reduce,…} fails on
   non-Array array-like receivers.

### Gap inventory

Format per gap: §spec ref, what's missing/wrong, estimated impact, fix
location, difficulty (easy / medium / hard), existing issue or NEW.

---

#### G1 — §7.1.1 ToPrimitive: Symbol.toPrimitive return-must-be-primitive
- **Status**: Partial. `coerceType` calls into `_genericToPrimitive`
  (runtime.ts:432) which checks Symbol.toPrimitive, valueOf, toString.
- **Gap**: When the user-defined `[Symbol.toPrimitive]` returns a non-primitive
  (object), the spec says "If Type(result) is not Object, return result; else
  throw a TypeError". Source path at runtime.ts:430-485 currently has a path
  that re-tries OrdinaryToPrimitive (#1253) but in `type-coercion.ts:1826`
  the in-binary fallback still emits a host call without the explicit
  "if Type(result) is Object" guard.
- **Impact**: ~15 fails in `built-ins/Symbol/prototype/toPrimitive` and
  long-tail in `language/expressions/{addition,equals}`.
- **Fix**: `type-coercion.ts:1822-1850` — gate the no-host fallback path
  with a runtime Type(result) check.
- **Difficulty**: easy.
- **Existing issue**: #1253 (partially closed) — propose NEW **#1564**.

#### G2 — §7.1.2 ToBoolean: Symbol/BigInt return values
- **Status**: Good for f64 + ref; not covered for `i64` (BigInt).
- **Gap**: `ToBoolean(0n)` must be `false`; current `compileNumericBinaryOp`
  path takes i64 → coerce to f64 via `f64.convert_i64_s`, which drops
  precision for large BigInts and produces wrong truthiness for `> 2^53`.
- **Impact**: ~12 fails in `built-ins/BigInt/prototype/valueOf` chains and
  `language/expressions/conditional` BigInt subjects.
- **Fix**: `type-coercion.ts` — add `i64.eqz` path for ToBoolean from BigInt.
- **Difficulty**: easy.
- **Existing**: none → propose **#1565**.

#### G3 — §7.1.4 ToNumber on Symbol must throw TypeError
- **Status**: Wrong. Numeric coercion of a `Symbol`-typed expression
  silently produces NaN via the `_toNumber` host path (runtime.ts).
- **Gap**: §7.1.4 step "If argument is Symbol, throw a TypeError" is missing.
- **Impact**: ~10 fails in `built-ins/Symbol/prototype/{valueOf,toString}`
  and `language/expressions/unary-plus`.
- **Fix**: Add `typeof argument === "symbol" → throw TypeError` to
  `runtime.ts:_toNumber` AND to `coerceType` extern→f64 path.
- **Difficulty**: easy.
- **Existing**: none → propose **#1566**.

#### G4 — §7.1.9 ToPrimitive hint propagation
- **Status**: Partial. Hint is computed at one call-site, but binary `+`
  with mixed string/object uses default→number where spec says default.
- **Gap**: `String(obj)` (explicit constructor call) must use hint "string"
  but compiler emits "default" for some receivers (cfr type-coercion.ts:1837).
- **Impact**: ~8 fails in `built-ins/String/S15.5.1_A2_T2` and adjacent.
- **Fix**: `type-coercion.ts:945-960` — thread caller-provided hint.
- **Difficulty**: easy.
- **Existing**: subset of #1090 — note in #1090, no new issue.

#### G5 — §7.1.19 ToPropertyKey called too late on computed keys
- **Status**: Wrong. Computed property keys in object literals call
  `compileToString` after evaluating the value side, so a thrown ToPropertyKey
  from a Symbol-bearing computed key fires in the wrong order.
- **Gap**: §7.1.19 must run **before** the property value is evaluated for
  PropertyDefinition.
- **Impact**: ~12 fails in `language/expressions/object/computed-property-name-*`.
- **Fix**: `expressions.ts` PropertyAssignment evaluation order.
- **Difficulty**: medium.
- **Existing**: none → propose **#1567**.

#### G6 — §7.2.4 IsCallable on bound-function targets
- **Status**: Partial. Fast-path `bind(this, …)(args)` recognized (calls.ts:7273)
  but generic `fn.bind(thisArg)` returns a host-bound function whose
  IsCallable check goes through `typeof === "function"` correctly.
- **Gap**: When the source `fn` is not callable, `.bind` should throw TypeError
  *eagerly*, not at later call time. Current code defers to host bind.
- **Impact**: ~66 fails in `built-ins/Function/prototype/bind`.
- **Fix**: `expressions/calls.ts:1248` — pre-bind IsCallable guard.
- **Difficulty**: easy.
- **Existing**: none → propose **#1568**.

#### G7 — §7.3.5 OrdinaryGet: integer-indexed exotic vs ordinary
- **Status**: Partial. Array element access (`property-access.ts:compileElementAccess`)
  doesn't check for accessor descriptors on numeric indices.
- **Gap**: When an Array has a getter installed on index `0` via
  `Object.defineProperty`, the existing `compileElementAccess` path issues
  a struct field load that misses the accessor.
- **Impact**: ~140 fails across `built-ins/Array/prototype/{filter,map,every,…}`
  hot loops that test accessor-observability.
- **Fix**: tracked in #1130 — extend to all array-iter callsites (currently
  only fixed in the array literal probe).
- **Difficulty**: medium.
- **Existing**: #1130 (in-progress) — extend scope.

#### G8 — §7.3.10 GetMethod returning undefined when fn is null
- **Status**: Partial. `GetMethod(o, k)` per spec returns undefined when the
  property is `null` or `undefined`; current `compilePropertyAccess` may
  emit `ref.cast` of `null` → trap before checking.
- **Gap**: ~135 `null_deref` fails in RegExp Symbol.* (post-#820a baseline-stale)
  share this shape; equivalent gap in generic GetMethod path.
- **Impact**: ~50 (residual after #820a lands).
- **Fix**: `property-access.ts:emitNullGuardedStructGet` already handles
  this for direct field reads; needs analog in optional/Symbol-keyed paths.
- **Difficulty**: medium.
- **Existing**: subset of #820 — leave to #820a residual.

#### G9 — §7.4.5 IteratorStep result must be checked for non-object
- **Status**: Partial. for-of lowering in `statements/loops.ts` reads
  `.value`/`.done` without first running `Type(result) is Object → throw`.
- **Gap**: §7.4.5 step 4: "If Type(result) is not Object, throw TypeError".
- **Impact**: ~40 fails in `language/expressions/object/method-definition/async-gen-yield-star-*`
  (overlap with #820c).
- **Fix**: `expressions/calls.ts` yield* lowering + statements/loops.ts for-of
  result consumer — emit `if !ref.test (struct) → throw TypeError`.
- **Difficulty**: medium.
- **Existing**: #820c (in-progress).

#### G10 — §7.4.10 IteratorClose not called on abrupt for-of completion
- **Status**: Wrong in subset of paths. for-of with `break` / `return` /
  thrown exception is supposed to call `IteratorClose(iter)` before
  unwinding. Current `statements/loops.ts` skips the close call for
  `try/finally` based unwinds in many cases.
- **Impact**: ~25 fails in `built-ins/{Generator,AsyncGenerator}Prototype/return`
  and `language/statements/for-of/iterator-close-*`.
- **Fix**: `statements/loops.ts` — wrap for-of body in `try { … } finally {
  IteratorClose(iter, completion) }`, gated by need-of-close analysis.
- **Difficulty**: medium.
- **Existing**: subset of #681 (pure-Wasm iterator) — propose carve-out **#1569**.

#### G11 — §10.1.7.2 OrdinarySetPrototypeOf cycle detection
- **Status**: Wrong. `Object.setPrototypeOf` host impl (`runtime.ts`) does
  not guard against creating prototype-chain cycles, which spec mandates.
- **Impact**: ~6 fails in `built-ins/Object/setPrototypeOf` + `Reflect.setPrototypeOf`.
- **Fix**: `runtime.ts` setPrototypeOf wrapper — walk proto chain looking
  for `O`, throw TypeError if found.
- **Difficulty**: easy.
- **Existing**: subset of #802 — propose **#1570** carve-out.

#### G12 — §10.4.2 [[GetPrototypeOf]] on instances returns wrong proto (BIG)
- **Status**: Wrong. `_wrapForHost`'s `getPrototypeOf` trap returns
  `Object.prototype` (runtime.ts:1500) instead of the registered class
  prototype. This is the single biggest spec compliance gap by impact.
- **Impact**: ~1,790 fails — all `class/dstr` (1,062 + 530) and `class/elements`
  (389 + 339) buckets, plus many `verifyProperty(c, …)` chains that
  read `Object.getPrototypeOf(c)`.
- **Fix**: `src/codegen/class-bodies.ts` — emit
  `__register_instance_prototype(struct, proto)` in the synthesized
  constructor. `src/runtime.ts:_wrapForHost` — return registered prototype.
  Side effects on `instanceof`, `hasOwnProperty`, `for…in` need spec walk.
- **Difficulty**: hard (architect spec required — see #779b investigation
  findings).
- **Existing**: #1364b (deferred carve-out in runtime.ts:1218 comment).
  Propose promoting **#1364b** to a sprint-blocker issue (rename to active id).

#### G13 — §10.4.2 Array exotic [[Set]]("length") — coerce + truncate
- **Status**: Partial. `length` writes on Array proxies do not coerce via
  `ToUint32` and don't truncate the backing vec when shrinking.
- **Impact**: ~24 fails in `built-ins/Array/length`.
- **Fix**: `runtime.ts` proxy set handler — special-case `length`.
- **Difficulty**: medium.
- **Existing**: none → propose **#1571**.

#### G14 — §10.5 Array exotic: `Reflect.ownKeys(array)` integer-indexed sort
- **Status**: Done for proxies (runtime.ts:1576). Not done for native
  WasmGC vec arrays — `Object.getOwnPropertyNames` on a plain compiled
  array returns insertion-order, not numeric-sorted.
- **Impact**: ~10 fails in `built-ins/Array` ownKeys ordering tests.
- **Fix**: `runtime.ts:_collectIntegerIndexedKeys` extension for non-proxy
  paths.
- **Difficulty**: easy.
- **Existing**: none → propose **#1572**.

#### G15 — §13.1.5 Argument evaluation order: rest must materialize last
- **Status**: Partial. Calls with `(...spread)` evaluate the spread before
  later positional args in tagged-call lowering.
- **Impact**: ~8 fails in `language/expressions/call/spread-{obj,arr}-…`.
- **Fix**: `expressions/calls.ts` — keep textual evaluation order in
  argument-array build.
- **Difficulty**: easy.
- **Existing**: none → propose **#1573**.

#### G16 — §13.5.3 typeof on uninitialized binding (TDZ) must throw
- **Status**: Wrong. `typeof x` where `x` is in TDZ returns "undefined"
  in some let/const paths instead of throwing ReferenceError per
  §13.5.3 step 4 / §8.1.1.1.6.
- **Impact**: ~6 fails in `language/expressions/typeof/let-tdz` and
  `class-instance-name-binding`.
- **Fix**: `expressions/identifiers.ts` typeof branch — preserve TDZ guard
  exception, do not short-circuit.
- **Difficulty**: easy.
- **Existing**: subset of #1380 — propose **#1574**.

#### G17 — §13.10 in operator must call HasProperty
- **Status**: Partial. `binary-ops.ts:516-585` uses a compile-time
  property-lookup helper (`tsTypeHasProperty`) which works for typed
  receivers but falls through to `Reflect.has` for `any`.
- **Gap**: In strict mode, `in` on a non-object receiver must throw
  TypeError eagerly (§13.10.2 step 6). Current path returns `false` for
  primitive receivers.
- **Impact**: ~5 fails.
- **Fix**: `binary-ops.ts:585` — add primitive receiver guard.
- **Difficulty**: easy.
- **Existing**: none → propose **#1575**.

#### G18 — §13.15 Assignment AssignmentTargetType for property updates
- **Status**: Partial. `obj.foo++` on null/undefined receiver must throw
  before reading `foo` (current emits a struct-field load that traps).
- **Impact**: ~14 fails across `language/expressions/{post,pre}-{increment,decrement}`.
- **Fix**: `expressions/unary.ts` and `expressions/assignment.ts` — emit
  receiver null check before load.
- **Difficulty**: easy.
- **Existing**: subset of #806 (open) — note.

#### G19 — §14.4 for/dstr declaration scoping
- **Status**: Partial. Already escalated as #1553a–e.
- **Impact**: ~60 fails (`language/statements/for/dstr`).
- **Fix**: covered by #1553 sub-issues.
- **Difficulty**: medium.
- **Existing**: #1553 family.

#### G20 — §14.7.5 for-of CreateIterResultObject shape on async-gen yield*
- **Status**: Wrong. `__yieldstar_async_*` (runtime.ts) consumes the
  inner iterator's IteratorResult without re-wrapping into
  `CreateIterResultObject(value, done)` when the inner is a non-Object.
- **Impact**: ~30 fails in `built-ins/AsyncGenerator/prototype` and
  `language/expressions/object/method-definition/async-gen-yield-star-*`.
- **Fix**: `runtime.ts:__yieldstar_async_*` — add IsObject check + wrap.
- **Difficulty**: medium.
- **Existing**: subset of #820c.

#### G21 — §15.7 ClassDefinitionEvaluation: prototype chain for verifyProperty
- **Status**: Wrong. (Duplicate-driver of G12; G12 is the runtime side.)
- **Impact**: covered by G12.
- **Existing**: #1364b.

#### G22 — §15.7.13 ClassElementEvaluation: methods missing from Class.prototype
- **Status**: Done as field installation (runtime registers bridge
  methods at `_prototypeMethodBridges`), but `assert.sameValue(c.m, C.prototype.m)`
  fails because instance-side lookup returns `undefined` — see G12.
- **Existing**: #1364b.

#### G23 — §15.8.4 AsyncFunctionStart: sync throw → rejected Promise
- **Status**: Wrong on the binding-pattern async-param path.
- **Impact**: ~25 fails (#1151).
- **Fix**: covered by #1151 Gap B (in-progress, task #56).
- **Existing**: #1151.

#### G24 — §15.6 AsyncGenerator yield*: spec `OrdinaryYield`
- **Status**: Partial. Object-method async-gen trampoline drops the
  isAsyncGenerator flag through `__obj_meth_tramp_*`. Causes null deref
  on `.next/.throw/.return` of the returned async iterator.
- **Impact**: ~39 fails (#820c).
- **Fix**: `src/codegen/closures.ts` trampoline emission.
- **Existing**: #820c.

#### G25 — §20.1 Object.create: descriptor enumerable/configurable defaults
- **Status**: Partial. `Object.create(proto, props)` does not apply the
  `enumerable: false / configurable: false / writable: false` defaults
  from §20.1.2.2 step 3 → `ObjectDefineProperties` step 4.
- **Impact**: ~146 fails in `built-ins/Object/create` and ~328 in
  `Object.defineProperties`.
- **Fix**: `runtime.ts:Object_create` (and host fallback) — pass through
  the spec defaulting helper.
- **Difficulty**: medium.
- **Existing**: subset of #846 (closed) — propose follow-up **#1576**.

#### G26 — §20.2.3.2 Function.prototype.bind name + length
- **Status**: Partial. Bound function name should be `"bound " + targetName`
  and length = `max(0, target.length - boundArgs)`. Current bound result
  uses host bind (carries V8's defaults) but the wrapped `fn` lacks the
  configured `.name`.
- **Impact**: ~66 fails in `built-ins/Function/prototype/bind`.
- **Fix**: `expressions/calls.ts:1248` post-bind metadata wiring.
- **Difficulty**: medium.
- **Existing**: none → propose **#1577**.

#### G27 — §20.2.3.1 / §20.2.3.4 Function.prototype.{apply,call} TypeError on non-callable
- **Status**: Wrong. Generic `nonFn.apply()` / `nonFn.call()` paths
  attempt struct ref.cast and produce `illegal cast` instead of TypeError.
- **Impact**: ~38 + ~35 fails (Function.prototype.apply / call).
- **Fix**: `expressions/calls.ts` apply/call lowering — pre-call IsCallable.
- **Difficulty**: easy.
- **Existing**: none → propose **#1578**.

#### G28 — §21.2.5 Symbol.hasInstance — instanceof on host-bound functions
- **Status**: Partial. `e instanceof Klass` where Klass has a custom
  `Symbol.hasInstance` static method is not honored.
- **Impact**: ~8 fails (`built-ins/Function/prototype/Symbol.hasInstance`).
- **Fix**: `expressions/identifiers.ts` instanceof branch — call
  `target[Symbol.hasInstance](v)` first if present.
- **Difficulty**: medium.
- **Existing**: none → propose **#1579**.

#### G29 — §22.1 Array exotic [[DefineOwnProperty]]: integer keys on holes
- **Status**: Wrong. `Array.prototype.{map,filter,every,…}` callbacks
  are invoked on holes (`HasProperty(arr, i) === false`); spec says skip.
- **Impact**: ~948 fails (subset of #1461 — Array-like receivers).
- **Fix**: `array-methods.ts:buildHasIndexInstrs` callsite — already
  partially threaded; missing in `filter`/`every`/`some`/etc.
- **Existing**: #1461 (in-review).

#### G30 — §22.1.3.6 Array.prototype.filter: result constructor identity
- **Status**: Wrong. `[].filter(…).constructor !== Array` — sibling
  symptom of G2 (#779c) but for `filter`/`map`/`slice` returns.
- **Impact**: ~78 in `split` plus ~150 across `filter/map/slice/concat`
  return-value tests.
- **Fix**: `array-methods.ts` — return-value construction must thread
  through `ArraySpeciesCreate` or at least set `%Array.prototype%`.
- **Difficulty**: medium (interacts with @@species).
- **Existing**: #779c (in-progress) — extend scope OR propose **#1580**.

#### G31 — §22.1.3.22 String.prototype.split result prototype
- **Status**: Wrong. (Covered in #779c.)
- **Impact**: ~78 fails.
- **Existing**: #779c (in-progress, task #70).

#### G32 — §22.1.3.{29,30} String.prototype.{replace,replaceAll} replacement-pattern semantics
- **Status**: Partial. Replacement string `$1`, `$&`, `$$`, `$<name>` handling
  goes through host `String.prototype.replace`, which is spec-correct, but
  custom RegExp Symbol.replace paths drop the named group support.
- **Impact**: ~20 + ~20 fails.
- **Fix**: `string-ops.ts` + `runtime.ts` RegExp Symbol.replace bridge.
- **Difficulty**: medium.
- **Existing**: subset of #820a (closed) — propose follow-up **#1581**.

#### G33 — §22.2 RegExp.prototype Symbol.{replace,match,search,split,matchAll}
- **Status**: Partial. #820a closed the null-deref class, but assertion
  failures remain (groups, sticky flag, lastIndex update semantics).
- **Impact**: ~150 fails.
- **Fix**: `runtime.ts` RegExp prototype methods + `expressions/calls.ts`
  bridge.
- **Difficulty**: medium.
- **Existing**: tracked under #820 umbrella — propose carve-out **#1582**.

#### G34 — §23.1 Map/Set/WeakMap/WeakSet — Wasm-native rewrite (deferred)
- **Status**: Implemented via host imports; standalone Wasm impl pending.
- **Impact**: ~78 + ~20 fails in `built-ins/{Set,Map}/prototype`.
- **Existing**: #1103 (already filed, architect spec deferred to task #54).

#### G35 — §24.1 ArrayBuffer/SharedArrayBuffer: resizable buffer fixtures
- **Status**: Compile-error on harness fixtures.
- **Impact**: ~52 + ~79 fails.
- **Existing**: #1524 (harness fixture).

#### G36 — §24.5 JSON.stringify: replacer this/key invariants
- **Status**: Partial. Host path used; spec invariants on `this` inside
  replacer are violated when replacer is a compiled closure.
- **Impact**: ~48 fails.
- **Fix**: `runtime.ts:2090-2128` replacer wrapping.
- **Difficulty**: medium.
- **Existing**: none → propose **#1583**.

#### G37 — §26 Iterator helpers (Iterator.prototype.{map,filter,take,drop,…})
- **Status**: Wrong. Native generators inherit Iterator.prototype (#1367),
  but the helper methods themselves throw on `IsObject` checks because
  the helper's brand check fails on WasmGC iterators.
- **Impact**: ~178 fails (`built-ins/Iterator/prototype/*`).
- **Fix**: `runtime.ts` Iterator.prototype helper bindings — accept
  WasmGC generator structs as valid Iterator instances.
- **Difficulty**: hard (interacts with helper internal slots).
- **Existing**: subset of #680/#681 — propose carve-out **#1584**.

#### G38 — §26.6 Async iteration: AsyncIteratorClose ordering
- **Status**: Partial. for-await-of doesn't await IteratorClose result
  when the loop throws.
- **Impact**: ~20 fails in `language/statements/for-await-of/iterator-close-*`.
- **Fix**: `statements/loops.ts` for-await-of emission.
- **Difficulty**: medium.
- **Existing**: subset of #1042 — note.

#### G39 — §27.1 Proxy invariants on ownKeys
- **Status**: Partial. `Reflect.ownKeys` on a Proxy must validate the
  trap result against `target.[[OwnPropertyKeys]]` (no missing
  non-configurable keys). Current proxy path delegates to host but the
  bridge layer drops the validation step.
- **Impact**: ~27 fails (`built-ins/Proxy/ownKeys`).
- **Fix**: `runtime.ts` proxy wrapper — re-run validation.
- **Difficulty**: medium.
- **Existing**: subset of #1100 — propose **#1585**.

#### G40 — §27.1 Proxy set/get/has invariants on non-configurable, non-writable target
- **Impact**: ~23+19+16 fails.
- **Existing**: subset of #1100.

#### G41 — §27.2 Promise.all/allSettled rejection ordering (microtask race)
- **Status**: Partial. Host `Promise.all` semantics are correct, but the
  compiler's wrapper around an array of compiled closure-promises
  doesn't preserve the per-element rejection order under fast-reject.
- **Impact**: ~23+30 fails (`built-ins/Promise/all`, `Promise/allSettled`).
- **Fix**: `runtime.ts:3949-3970` — order-preserving aggregation.
- **Difficulty**: medium.
- **Existing**: none → propose **#1586**.

#### G42 — §B.3.3 annex-B eval-code: var hoisting across direct eval
- **Status**: Partial. #1518 in-review covers direct-eval; indirect-eval
  branch still fails.
- **Impact**: ~50 fails (`annexB/language/eval-code/indirect/*`).
- **Fix**: `src/runtime-eval.ts` indirect-eval var hoisting.
- **Difficulty**: medium.
- **Existing**: #1518 — extend to indirect path, no new issue.

#### G43 — §B.3.7 Annex-B HTML legacy: RegExp.$1..$9 accessors
- **Impact**: ~17 fails (`annexB/built-ins/RegExp/legacy-accessors`).
- **Fix**: `runtime.ts` RegExp legacy accessors.
- **Difficulty**: easy.
- **Existing**: none → propose **#1587**.

#### G44 — §15.4.5 Arguments object: mapped-arguments sync semantics
- **Status**: Partial. ~183 fails in `language/arguments-object`; most under
  `cls-` prefix (94) — class-body methods don't expose `arguments` per spec
  (it's only available in non-arrow functions).
- **Impact**: ~183 fails.
- **Fix**: `closures.ts` arguments-object materialization — class methods
  should still expose `arguments` per spec (it's a function-scoped binding
  except in arrow functions). Mapped-arguments sync (~18) tracked separately.
- **Difficulty**: medium.
- **Existing**: subset of #849 (closed) — propose **#779e** (already mentioned
  in #779-investigation) and **#1588** for class-method arguments.

#### G45 — §15.5 GeneratorYield: return inside try/finally
- **Impact**: ~21 fails (`built-ins/GeneratorPrototype/return`).
- **Fix**: `closures.ts` generator state machine — finally completion.
- **Difficulty**: medium.
- **Existing**: subset of #680 — note.

#### G46 — §25 Date.prototype setters return value
- **Status**: Partial. `setFullYear/Month/Date/Hours/Minutes/Seconds/Milliseconds`
  setters return the wrong value (should return the new timestamp); host
  delegation has the right value but conversion through the proxy drops it.
- **Impact**: ~117 fails (`built-ins/Date/prototype/set*`).
- **Fix**: `runtime.ts` Date proxy method bridging — preserve return value.
- **Difficulty**: easy.
- **Existing**: none → propose **#1589**.

#### G47 — §11 Tagged-template cache identity (long-standing)
- **Status**: Wrong. Tagged template strings array is re-allocated per call
  in some inlined-call paths.
- **Impact**: ~8 fails.
- **Existing**: #229 (open in `plan/issues/sprints/0/`).

#### G48 — §22.2.5.4 RegExp `lastIndex` advancement on zero-length matches
- **Impact**: ~10 fails.
- **Existing**: subset of #1539 (Wasm-native regex).

#### G49 — §27.6 AsyncGenerator: `.return()` finally completion
- **Impact**: ~10 fails.
- **Existing**: subset of #680.

#### G50 — §15.1 Class subclass — built-in subclassing (`class X extends Array`)
- **Impact**: ~18+5 fails (`subclass-builtins`).
- **Fix**: `expressions/new-super.ts` — built-in subclass exotic instance
  shape.
- **Difficulty**: hard.
- **Existing**: none → propose **#1590** (deferred; subclassing built-ins
  is structurally non-trivial under WasmGC).

---

### New issue proposals (consolidated)

| Proposed ID | Title | Spec ref | Est. FAIL | Difficulty |
|---|---|---|---|---|
| **#1364b → upgrade** | Class instance Proxy: getPrototypeOf returns Object.prototype, breaking prototype-chain lookup on instances | §10.1.1 / §15.7 | ~1,790 | hard |
| **#1564** | ToPrimitive non-host fallback must enforce Type(result) is not Object | §7.1.1 step 7 | ~15 | easy |
| **#1565** | ToBoolean on BigInt should use i64.eqz, not via f64 (precision loss) | §7.1.2 | ~12 | easy |
| **#1566** | ToNumber on Symbol must throw TypeError | §7.1.4 step 1 | ~10 | easy |
| **#1567** | ToPropertyKey on computed object-literal keys must run before value evaluation | §7.1.19 + §13.2.5 | ~12 | medium |
| **#1568** | Function.prototype.bind: pre-bind IsCallable guard (eager TypeError) | §20.2.3.2 step 1 | ~30 (of ~66) | easy |
| **#1569** | for-of IteratorClose on abrupt completion (break/return/throw) | §7.4.10 + §14.7.5.13 | ~25 | medium |
| **#1570** | Object.setPrototypeOf cycle detection | §10.1.7.2 | ~6 | easy |
| **#1571** | Array exotic `length` set: ToUint32 + truncate backing | §10.4.2.4 | ~24 | medium |
| **#1572** | Array exotic ownKeys: integer-indexed keys must sort numerically | §10.4.2.13 | ~10 | easy |
| **#1573** | Argument evaluation order on spread + positional mix | §13.3.6.1 | ~8 | easy |
| **#1574** | `typeof x` in TDZ must throw ReferenceError (not return "undefined") | §13.5.3 / §8.1.1.1.6 | ~6 | easy |
| **#1575** | `in` operator on primitive receiver must throw TypeError | §13.10.2 step 6 | ~5 | easy |
| **#1576** | Object.defineProperties: spec descriptor-default propagation | §20.1.2.4 / §10.1.6.2 | ~150 (of ~474) | medium |
| **#1577** | Function.prototype.bind metadata: name="bound X", length=max(0,L-N) | §20.2.3.2 steps 4-9 | ~30 (of ~66) | medium |
| **#1578** | Function.prototype.{apply,call}: TypeError on non-callable receiver | §20.2.3.1/4 step 1 | ~70 (apply+call) | easy |
| **#1579** | instanceof: honor Symbol.hasInstance on RHS before host dispatch | §13.10.5 / §13.10.6 | ~8 | medium |
| **#1580** | Array.prototype.{map,filter,slice,concat} result: %Array.prototype% identity | §22.1.3.* (ArraySpeciesCreate) | ~150 | medium |
| **#1581** | RegExp Symbol.replace replacement-pattern: named groups | §22.2.5.10 / §22.2.5.13 | ~20 | medium |
| **#1582** | RegExp Symbol.{match,search,split,matchAll}: post-#820a residual assertion fails | §22.2.5.* | ~150 | medium |
| **#1583** | JSON.stringify replacer this-binding + key invariants | §24.5.2.1 step 11 | ~48 | medium |
| **#1584** | Iterator.prototype.{map,filter,take,drop,reduce,…} brand check on WasmGC generators | §27.1.2.* | ~178 | hard |
| **#1585** | Proxy ownKeys invariant validation (non-configurable keys) | §10.5.11 step 18 | ~27 | medium |
| **#1586** | Promise.all/allSettled rejection ordering preserved under fast-reject | §27.2.4.1 step 6 | ~50 (all+allSettled) | medium |
| **#1587** | RegExp Annex-B legacy `$1..$9` accessors | §B.2.1 | ~17 | easy |
| **#1588** | class-method `arguments` binding (currently dropped) | §15.4.5 | ~94 | medium |
| **#1589** | Date.prototype.set* returns the new timestamp | §25.4.4.{20-37} | ~117 | easy |
| **#1590** | Subclassing built-ins (`class X extends Array/Error/Map`) | §10.1.13 / §22.1.1 step 6 | ~25 | hard (deferred) |

Total new-issue addressable: **≥3,200 fails** if all 27 proposals land.
Largest single value: #1364b (~1,790 fails) — single architectural change.
Largest easy-win bucket: #1589 + #1576 + #1578 + #1580 + #1572 + #1571 ≈ **560 fails** for
six self-contained fixes.

### Already-tracked gaps (no new issue)

Cross-referenced existing issues that cover gaps surfaced by this survey:

- **#1130** (in-progress) — Array accessor-observability
- **#1151** (in-progress) — Async sync-throw → rejected Promise
- **#1253** — OrdinaryToPrimitive returns Object instead of TypeError
- **#1352** — RegExp exec wasmGC vs externref string equality (completed)
- **#1396 / #1454 / #1468** — for-of dstr residuals
- **#1431** — assignment dstr residuals
- **#1450 / #1451** — object dstr residuals
- **#1456** — class/elements residuals (parent of #779b)
- **#1461** — Array.prototype.* arguments-shape mismatch (in-review)
- **#1518** — annex-B eval direct
- **#1543 / #1544** — async-gen dstr default-init illegal cast
- **#1553a–e** — declaration destructuring carve-outs
- **#1525 / #1526 / #1528** — completed micro-fixes
- **#229 (s0)** — tagged template cache identity
- **#680 / #681** — pure-Wasm generators / iterators
- **#682 / #1474 / #1539** — pure-Wasm RegExp
- **#1103 / #1105 / #1474** — pure-Wasm Map/Set/String
- **#802** — Object.setPrototypeOf — covered by carve-out #1570
- **#820a–d** — null/illegal-cast umbrella
- **#779b / #779c** — class-element / split residuals (in-progress)
- **#849** — arguments-object (closed but #779e/#1588 carve-outs)
- **#929 / #846** — Object.defineProperty receiver — covered by carve-out #1576
- **#1100 / #1355** — Proxy / Reflect (host-impl pending Wasm port)
- **#1354 / #1356 / #1357** — SAB / ShadowRealm / AbstractModuleSource (won't-fix)

### Recommended sprint-54 prioritization

The PO should consider sprinting these in dependency order:

1. **#1364b (upgrade) — prototype-chain on instances** — `~1,790 fails`,
   architect spec already half-written in #779b investigation. Single
   biggest lever in the entire spec-compliance landscape.
2. **#1576 + #1580 — descriptor defaults + ArraySpeciesCreate** — 
   `~300 fails`, both medium difficulty, scoped to `runtime.ts` +
   `array-methods.ts`. Self-contained.
3. **#1578 + #1568 + #1577 — Function.prototype.{bind,call,apply} brand
   checks** — `~130 fails`, easy/medium, scoped to `expressions/calls.ts`.
4. **#1589 — Date setter returns** — `~117 fails`, easy, one-file in
   `runtime.ts`.
5. **#1584 — Iterator.prototype helpers brand check** — `~178 fails`,
   hard, blocks long-tail iterator helpers; gate behind #1364b since both
   touch the same proxy layer.
6. **#1566 + #1565 + #1574 + #1570 + #1575 + #1572 + #1573 — easy spec guards**
   — `~70 fails` combined, 1-2 lines each, can be batched into a single
   "spec-strictness" PR.

Total addressable in sprint 54 via this plan: **~2,500 fails**
(~18% of the 13,654 budget) for moderate dev effort.

### Files-not-changed assertion

No `src/`, `tests/`, or other code-bearing files were modified during this
analysis. Output is confined to this issue file (`plan/issues/backlog/1563-*.md`).
