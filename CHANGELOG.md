# Changelog

## Unreleased

Nothing yet. Add a `## vX.Y.Z - YYYY-MM-DD` section for the next release **before** running
`node scripts/release.mjs X.Y.Z` — the script refuses to cut a version that has no entry here.

## Historical sprint tags

This file records the historical sprint boundary tags created from the sprint history in `plan/sprints/` and the Git history on `main`.

Tagging method:

- Use an explicit sprint-closing commit when one exists, for example `sprint-31 suspend`.
- Otherwise use the closest `main` snapshot that matches the documented sprint boundary and/or the archived `test262` run for that sprint.
- `sprint/32`, `sprint/34`, and `sprint/35` were not tagged because their sprint docs are still planning or incomplete.
- `sprint/33` does not exist in the current sprint history.

## Current test262 status

The current figures are generated into [STATUS.md](STATUS.md) by `scripts/sync-conformance-numbers.mjs`; they are not repeated here.

## Sprint history

## Sprint 0 - v0.0.0

- Tags: `sprint/0`, `v0.0.0`
- Date range: 2026-02-27 to 2026-03-10
- Goal: Build the compiler, runtime, playground, and first conformance baseline before structured sprint tracking began.
- Worked on: Turned the initial prototype into a real TypeScript-to-Wasm toolchain: core AOT compilation, CLI and playground, import resolution and stdlib growth, classes/closures/async-await/destructuring, relocatable object emission and multi-memory linking, linear-memory backend work, fast mode, native strings and arrays, gradual typing, npm/package resolution, SIMD and benchmark infrastructure, and the first serious test262 subset runs that reached the 550-pass baseline used by Sprint 1.
- Baseline: project bootstrap / no recorded sprint baseline
- Final result: pre-Sprint-1 baseline established at `550` test262 passes
- test262: `550` pass (100% of compilable tests at that point)

### Issues worked on

- #31 Default number type to i32, promote to f64 only when needed
- #33 Relocatable Wasm Object File (.o) Emission
- #34 Multi-Memory Module Linker with Isolation Validation
- #35 Class inheritance with extends and super
- #36 Static class members
- #37 Getter/Setter Properties on User-Defined Classes
- #38 Implement `instanceof` operator
- #39 Labeled Break and Continue
- #40 String Enums
- #41 typeof as Expression
- #42 Comma operator support
- #43 void Expression
- #44 Source Map Generation
- #45 Error reporting with source locations
- #46 Linear-memory compilation backend
- #47 importedStringConstants support
- #49 Default parameter values
- #50 Nullish and logical assignment operators
- #51 Functional array methods (filter, map, reduce, forEach, find)
- #52 String.split() method
- #53 Numeric separators
- #54 Map and Set collections
- #55 Function expressions
- #56 Tuples
- #57 Class expressions
- #58 Iterators and for...of with custom iterables
- #59 Abstract classes
- #60 RegExp via host imports
- #61 Object.keys / Object.values / Object.entries
- #62 JSON.parse / JSON.stringify via host
- #63 Promise.all / Promise.race
- #64 Generators and yield
- #65 Computed property names
- #67 Closed import objects — replace Proxy with compiler manifest
- #68 DOM containment — scope wasm module access to a subtree
- #69 Safe mode — restrict TypeScript to a secure subset
- #70 Fast mode — optimize for performance with restricted TypeScript
- #71 Fast mode — WasmGC-native strings
- #72 Fast mode — WasmGC-native arrays
- #73 Benchmark — JS vs host-call vs GC-native vs linear-memory performance
- #74 WASM SIMD support for string and array operations
- #75 Slice-based string views for substring/trim/slice
- #76 Rope/cons-string for O(1) concatenation
- #77 Object literals, spread, and structural typing
- #78 Standard library coverage — builtins and static methods
- #79 Gradual typing — boxed `any` with runtime dispatch
- #80 JS file compilation via `.d.ts` types and TS inference
- #81 npm package resolution and tree-shaking
- #83 Test262 conformance subset
- #85 Variadic `Math.min` / `Math.max`
- #87 Math.round negative zero preservation
- #88 Test262 coverage — language/expressions
- #89 Test262 coverage — language/statements
- #90 Test262 coverage — built-ins/Array
- #91 Test262 coverage — built-ins/Number
- #92 Test262 coverage — language/types (coercion)
- #93 Test262 coverage — built-ins/Object
- #94 Test262 coverage — language/function-code
- #95 Test262 coverage — built-ins/isNaN + isFinite
- #96 Test262 coverage — built-ins/JSON
- #97 NaN/undefined/null truthiness in boolean contexts
- #98 Proper ToInt32 modular arithmetic for bitwise operations
- #99 Externref arithmetic, comparison, and control flow
- #100 Mutable closure captures via ref cells
- #101 Test262 — language/statements remaining
- #102 Test262 — language/expressions remaining
- #103 Test262 — built-ins/String prototype methods
- #104 Test262 — language/ top-level categories
- #105 Test262 — built-ins/Map, built-ins/Set, built-ins/Promise
- #106 Test262 — built-ins/Object extended + built-ins/Array constructor
- #107 Fix codegen null-dereference crashes (90 occurrences)
- #109 Tagged template literals

## Sprint 1 - v0.1.0

- Tags: `sprint/1`, `v0.1.0`
- Date range: 2026-03-11 (morning) to 2026-03-11 (morning)
- Goal: First test262 conformance push — language feature coverage
- Worked on: Built the first serious test262 push: harness improvements, BigInt support, private class members, arguments/valueOf/toString behavior, object literal accessors, destructuring, IIFE support, and broad operator/coercion fixes.
- Baseline: 550 pass (100% of compilable tests at the time)
- Final result: 1,509 pass / ~23,000 total
- test262: `550 -> 1,509` pass
- Delta: +959 pass (+174% from 550)

### Issues worked on

- #116 Unskip implemented features in test262 runner
- #117 String comparison support in test262 harness
- #118 compareArray.js test262 harness include
- #119 assert.throws support in test262 harness
- #120 undefined/void 0 comparison support
- #121 Function.prototype.call/apply
- #122 arguments object
- #123 Wrapper object constructors: new Number/String/Boolean (648 tests)
- #124 delete operator via undefined sentinel (232 tests)
- #125 Object.defineProperty / property descriptors (106 tests)
- #126 valueOf/toString coercion
- #127 Private class members (#field, #method)
- #128 BigInt type
- #129 propertyHelper.js test262 harness (341 tests)
- #130 Usage-based shape inference + call/apply inlining
- #131 String concatenation with variables
- #132 Logical operators returning values (short-circuit)
- #133 typeof runtime comparison
- #134 Switch fallthrough
- #135 Ternary/conditional returning non-boolean values
- #136 Loose equality (== / !=)
- #137 Object literal getter/setter
- #138 valueOf/toString coercion on comparison operators
- #139 valueOf/toString coercion on arithmetic operators
- #140 Object computed property names not working at runtime
- #141 Tagged template literal runtime failures
- #142 Assignment destructuring failures
- #143 for-loop edge cases
- #144 new expression with class expressions
- #145 allowJs type flexibility — boolean/string/void as number
- #148 Element access (bracket notation) on struct types
- #150 ClassDeclaration in statement positions
- #151 `this` keyword in class methods for test262
- #152 Setter return value error in allowJs mode
- #154 while/do-while loop condition evaluation
- #155 Logical-and/logical-or short-circuit returns wrong value
- #156 Conditional (ternary) expression evaluation
- #157 void expression returns wrong value
- #158 String concatenation with non-string operands
- #159 Call expression edge cases
- #160 Math method edge cases
- #161 Compound assignment edge cases
- #162 switch statement matching
- #163 return statement edge cases
- #164 variable declaration edge cases
- #165 function statement hoisting and edge cases
- #166 `in` operator runtime failures
- #167 typeof edge cases
- #168 equality operators with null/undefined
- #169 Arrow function edge cases
- #170 Class expression/declaration edge cases
- #171 Boolean() edge cases
- #172 Array.isArray edge case

## Sprint 2 - v0.2.0

- Tags: `sprint/2`, `v0.2.0`
- Date range: 2026-03-11 (afternoon) to 2026-03-11 (afternoon)
- Goal: Runtime failure reduction — 167 failures and ~1,200 compile errors
- Worked on: Focused on runtime failure reduction: type coercion edge cases, built-in method compile errors, computed/class property names, `.call()` support, tagged template caching, for-of destructuring, and member increment/decrement.
- Baseline: 1,509 pass
- Final result: ~1,509+ pass (merged same day as Sprint 1)
- test262: incremental, no isolated archived run
- Delta: Primarily reduced runtime failures and compile errors

### Issues worked on

- #175 Bug: Negative zero not preserved in arithmetic operations
- #177 - Bug: Spread operator in new expressions
- #180 JS var re-declaration: "Subsequent variable declarations must have the same type"
- #181 Unsupported `new Object()` and `new Function()` constructor calls
- #183 Template literal type coercion wasm errors
- #184 - Function arity mismatch: "not enough arguments on the stack"
- #185 Unary plus on non-numeric types
- #186 `typeof null` returns wrong value
- #187 String prototype methods: heavy test skipping due to include filters
- #191 `assert` not found: tests using raw `assert()` calls
- #193 Coalesce operator wasm type mismatch
- #195 Prefix/postfix increment/decrement compile errors
- #196 Try/catch/finally: 66 compile errors
- #197 Statement-level `if` compile errors
- #200 JSON.parse/JSON.stringify: 24 compile errors
- #203 LEB128 encoding overflow for large type indices
- #205 String.prototype.indexOf type coercion errors
- #207 Class statement/expression runtime failures
- #208 Computed property names with complex expressions
- #209 While/do-while with string/object loop conditions and labeled block break
- #210 for-of destructuring runtime failures
- #211 Function.length and undefined comparison edge cases
- #212 Tagged template object caching
- #213 New expression spread arguments and module-level init collection
- #214 String relational ops and unary plus coercion
- #215 Modulus operator edge cases
- #216 More modulus and numeric coercion edge cases
- #217 While/do-while with string/object loop conditions and labeled block break
- #218 Remove Boolean() skip filter
- #219 Additional Boolean runtime fixes
- #220 ClassDeclaration in all statement positions
- #221 .call() and comma-operator indirect call patterns
- #222 Hoist var declarations from destructuring patterns
- #223 Computed property names in classes
- #224 Member increment/decrement on class properties

## Sprint 3 - v0.3.0

- Tags: `sprint/3`, `v0.3.0`
- Date range: 2026-03-11 (evening) to 2026-03-11 (evening)
- Goal: Zero runtime failures, ~1,500 CE reduction
- Worked on: Consolidated fixes around string comparison, object `valueOf` coercion, BigInt cross-type equality, nested hoisting, `in` operator runtime behavior, object destructuring, and private-field diagnostics.
- Baseline: ~1,509 pass
- Final result: merged same session, incremental improvements
- test262: incremental, merged same session
- Delta: 13 issues marked done

### Issues worked on

- #225 String comparison in equality ops
- #226 valueOf coercion on object literal comparisons
- #227 BigInt comparison/equality with Number and Infinity
- #228 BigInt equality with Number and Infinity
- #231 Remove overly broad typeof skip filter
- #233 Nested function hoisting in loops/switch
- #236 Super/derived-class diagnostic suppression
- #240 More super/derived-class diagnostic suppression
- #244 In operator runtime failures
- #245 String comparison in switch statements
- #246 Missing struct fields in for-of object destructuring
- #247 Null/undefined arithmetic correct results
- #248 Logical op tests around valueOf coercion
- #251 Equivalence test expansion
- #252 Additional equivalence tests
- #253 Remove overly broad loose inequality skip filter
- #254 Private class field assignment diagnostic suppression
- #255 More equivalence coverage
- #256 Unknown function: f -- locally declared functions not found

## Sprint 4 - v0.4.0

- Tags: `sprint/4`, `v0.4.0`
- Date range: 2026-03-11 to 2026-03-12
- Goal: Diagnostic suppression, bracket notation, destructuring, compound assignment
- Worked on: Reduced compile errors with batch diagnostic suppression while extending dynamic property fallback, bracket writes, destructuring scope handling, anonymous struct registration, arrow/default params, complex for-loop heads, and logical/compound assignment lowering.
- Baseline: ~1,509 pass
- Final result: incremental (same multi-day session)
- test262: incremental, multi-day session
- Delta: Major reduction in compile errors from diagnostic suppression

### Issues worked on

- #257 Unsupported call expression -- double/triple nested calls
- #258 Unsupported call expression -- double/triple nested calls
- #259 ClassDeclaration in block scope
- #261 New expression with inline/anonymous class expressions
- #262 Batch diagnostic suppression for Sprint 4
- #263 Dynamic property access fallback
- #264 Bracket notation write path for const keys
- #265 Additional diagnostic suppression
- #266 Scope resolution for multi-variable destructuring
- #267 Suppress yield-outside-generator diagnostics
- #268 Suppress TS2548 iterator protocol diagnostic
- #269 Strict-mode reserved word diagnostic suppression
- #270 Reserved word/strict-mode diagnostic suppression
- #272 Re-lookup funcIdx after arg compilation
- #273 Anonymous class expressions in new expressions
- #275 Comma operator unused diagnostic suppression
- #276 Additional assignability diagnostic suppression
- #277 Type coercion before local.set/local.tee
- #278 Auto-register anonymous struct types
- #279 Arrow function destructuring params and defaults
- #280 Function expression name binding and closure call
- #281 Object literal method names and spread ordering
- #282 Scan top-level statements for string literals
- #283 Compound assignment type coercion
- #284 Nested destructuring and rest elements in for-of
- #285 Complex for-loop initializers
- #286 Logical assignment compile errors -- nullish and short-circuit
- #316 Runtime failure -- array element access out of bounds

## Sprint 5 - v0.5.0

- Tags: `sprint/5`, `v0.5.0`
- Date range: 2026-03-12 to 2026-03-12
- Goal: Deep runtime fixes — coercion, equality, assignment, instanceof
- Worked on: Tightened runtime semantics: Wasm type-mismatch repair, nested class/function positioning, `instanceof`, default parameter initialization for methods/constructors, assignment result semantics, BigInt/string comparison, unary minus and `-0`, and Math intrinsics in pure Wasm.
- Baseline: building on Sprint 4
- Final result: incremental improvements in runtime correctness
- test262: incremental runtime gains
- Delta: 25+ issues resolved in one session

### Issues worked on

- #178 Resolve Wasm validation errors for type mismatches
- #234 ClassDeclaration in nested/expression positions
- #235 Function.name prefers own name over variable name for named expressions
- #238 Named class expressions in new expressions
- #239 Bracket notation field resolution for struct types
- #250 Function declarations inside for-loop bodies
- #260 Preserve non-null ref type in conditional expressions
- #274 Function .name property access
- #289 Bare identifier/assignment initializers in for-in
- #290 instanceof with class hierarchies and expression operands
- #292 number_toString import for any-typed string +=
- #293 Default parameter initialization for class constructors/methods
- #294 Assignment expressions return RHS value
- #295 BigInt vs String comparison
- #296 Strict equality cross-type comparison
- #297 Switch statement fall-through with default in non-last position
- #298 Nested function mutable captures and capture param padding
- #299 Loose equality null == undefined
- #301 Saturating float-to-int truncation
- #302 Math.min/max zero-argument edge cases
- #303 parseInt edge cases
- #304 Unary minus coercion and -0 preservation
- #306 Prefix/postfix inc/dec on member expressions
- #308 bigint-to-string coercion and ambiguous addition fallback
- #315 Re-read local type after func expr update
- #317 Issue 317
- #318 Issue 318
- #319 Issue 319
- #320 Issue 320
- #321 Issue 321
- #322 Issue 322
- #323 Native type annotations — type i32 = number

## Sprint 6 - v0.6.0

- Tags: `sprint/6`, `v0.6.0`
- Date range: 2026-03-13 to 2026-03-13
- Goal: Test262 expansion, generator fixes, test infrastructure, equivalence tests
- Worked on: Expanded the compiler and runner together: more test262 categories, negative-test support, generator and `new.target` fixes, Promise construction, object introspection, type inference from call sites, dead import elimination, and runner profiling.
- Baseline: building on Sprint 5
- Final result: significant test262 category expansion
- test262: `1,952` pass, `2,248` compilable
- Delta: 80+ issues resolved across Sprint 5-6 session

### Issues worked on

- #121 Function.prototype.call/apply
- #138 valueOf/toString coercion on comparison operators
- #139 valueOf/toString coercion on arithmetic operators
- #141 Tagged template literal runtime failures
- #142 Assignment destructuring failures
- #143 for-loop edge cases
- #146 Unknown identifier resolution from scope/hoisting issues
- #147 Function.name property
- #149 Additional call expression patterns
- #165 function statement hoisting and edge cases
- #176 Unicode escape sequences in property names
- #179 Generator yield in module mode
- #182 Arrow function closure type coercion errors
- #188 instanceof compile errors
- #189 new.target meta-property
- #190 Array destructuring assignment patterns
- #194 Logical assignment operators
- #198 Switch statement compile errors and type coercion
- #199 Labeled statement compile errors
- #201 Object.keys/values/entries
- #202 Var hoisting tests
- #227 BigInt comparison/equality with Number and Infinity
- #228 BigInt equality with Number and Infinity
- #229 Global index corruption when late string imports shift globals
- #230 Computed property names with let/var variable keys
- #232 Module-level object literal methods
- #237 i64 boxing/unboxing coercion paths for AnyValue
- #241 yield-as-identifier diagnostics
- #243 Array destructuring assignment and nested patterns
- #249 typeof Math constants and Math.round precision
- #261 New expression with inline/anonymous class expressions
- #267 Suppress yield-outside-generator diagnostics
- #279 Arrow function destructuring params and defaults
- #287 Spread stack corruption and callback destructuring
- #288 try/catch/finally runs finally on exception in catch body
- #291 in operator fallback with variable keys
- #300 Struct ref in template expressions toString coercion
- #305 ref/ref_null type mismatch resolution
- #307 Promise.resolve/reject/new
- #309 Test262 harness expansion
- #310 Remove 16 overly conservative test262 skip filters
- #311 String.prototype category expansion in test262 runner
- #312 Number prototype method categories in test262 runner
- #313 Add new test262 expression categories
- #314 Compile-time profiling in test262 runner
- #318 Issue 318
- #319 Issue 319
- #320 Issue 320

## Sprint 7 - v0.7.0

- Tags: `sprint/7`, `v0.7.0`
- Date range: 2026-03-13 (continued) to 2026-03-13 (continued)
- Goal: Runtime failure patterns — null guards, skip filter cleanup, gap coverage
- Worked on: Continued runtime cleanup with null guards, `_FIXTURE` filtering, property introspection, wrapper constructors, `delete`, `super` calls, global/globalThis handling, accessor edge cases, graceful extern fallbacks, and a large gap-analysis issue wave.
- Baseline: building on Sprint 6
- Final result: ~6,366 pass (first test262 run recorded at end of day)
- test262: later history records first end-of-day `~6,366` pass
- Delta: Major jump from skip filter cleanup and new test categories

### Issues worked on

- #324 Runtime test failures with wrong return values
- #325 Array rest destructuring null deref
- #326 Array destructuring bounds checking
- #327 Object-to-primitive coercion for increment/decrement
- #328 OmittedExpression for array holes/elision
- #330 ClassExpression in assignment positions
- #331 Strict mode eval/arguments diagnostic suppression
- #332 Skip _FIXTURE helper files in test262
- #334 Private class fields/methods and accessor compound assignment
- #335 Track bracket/brace depth in stripThirdArg/stripUndefinedAssert
- #336 for-of object destructuring on non-struct refs
- #337 Null guards to runtime property/element access
- #338 Negative test support in test262 runner
- #341 Property introspection (hasOwnProperty, propertyIsEnumerable)
- #342 Array.prototype.method.call/apply patterns
- #344 Wrapper constructors new Number/String/Boolean
- #347 Function/class .name property completion
- #348 Null/undefined arithmetic coercion
- #349 String() constructor as function
- #352 Delete operator expression
- #355 Object.keys with numeric-string keys
- #357 IIFE and call expression tagged templates
- #358 Issue 358
- #359 Gap coverage issue
- #361 Runtime `in` operator for array index bounds
- #362 Issue 362
- #367 Remove overly broad string concatenation skip filter
- #368 `this` in global scope
- #369 globalThis identifier
- #375 super.method() and super.prop in class methods
- #377 Getter/setter accessor edge cases
- #378 Graceful fallback for inc/dec on unresolvable access
- #379 Tuple/destructuring type errors
- #380 Unknown variable/function in test scope
- #381 Downgrade "never nullish" diagnostic
- #382 Spread argument in super/function calls
- #385 Array method optional args
- #386 Gap coverage issue

## Sprint 8 - v0.8.0

- Tags: `sprint/8`, `v0.8.0`
- Date range: 2026-03-16 to 2026-03-16
- Goal: Property access, element access, class inheritance, skip filter removal
- Worked on: Deepened property and element access support: externref/class/struct element reads and writes, tagged template identity, arrow-function `.call()` behavior, `import.meta`, narrower skip filters, fallback assignment targets, and class inheritance/property initialization fixes.
- Baseline: ~6,366 pass (from 2026-03-18 run, likely lower on 03-16)
- Final result: incremental (no test262 run recorded this day)
- test262: no dedicated full run archived
- Delta: 50+ issues resolved, major element/property access improvements

### Issues worked on

- #153 BigInt cross-type comparison tests
- #173 BigInt comparison support follow-up
- #174 BigInt comparison support follow-up
- #204 Miscellaneous runtime fixes
- #329 Runtime failure pattern
- #331 Strict mode eval/arguments diagnostic suppression
- #337 Null guards to runtime property/element access
- #339 Runtime failure pattern
- #340 Runtime failure pattern
- #343 Runtime failure pattern
- #344 Wrapper constructors new Number/String/Boolean
- #345 Runtime failure pattern
- #346 Issue 346
- #350 Test coverage improvements
- #351 Test coverage improvements
- #353 Test coverage improvements
- #354 Test coverage improvements
- #356 Remove overly broad skip filter
- #357 IIFE and call expression tagged templates
- #358 Issue 358
- #359 Gap coverage issue
- #360 Remove overly broad skip filters (closure-as-value, JSON.stringify)
- #362 Issue 362
- #363 Tagged template .raw property and identity
- #364 .call()/.apply() on arrow functions and module-level closures
- #365 Additional gap coverage
- #366 Additional gap coverage
- #370 Additional gap coverage
- #371 Compile import.meta expressions
- #372 Additional gap coverage
- #373 Remove outdated loop condition skip filters
- #374 Additional gap coverage
- #376 Additional gap coverage
- #383 Downgrade tolerated syntax diagnostics
- #384 ES2021+ string/array method type declarations
- #387 Graceful fallback for unsupported assignment targets
- #388 Element access on externref
- #389 Element access on class instances
- #390 Assignment to non-array types (70 CE)
- #391 Downgrade TS7053 index signature diagnostic
- #392 Graceful fallback for unknown field access on class structs
- #393 Compound assignment on externref element access
- #395 Function references callable via closure wrapping
- #396 Null guards for struct dereference traps
- #397 Additional fix
- #398 Inherit parent field initializers and accessors
- #399 Additional fix
- #400 Additional fix
- #401 Additional fix
- #402 Additional fix
- #403 Additional fix
- #404 Additional fix
- #405 Additional fix
- #406 Additional fix
- #407 Additional fix

## Sprint 9 - v0.9.0

- Tags: `sprint/9`, `v0.9.0`
- Date range: 2026-03-17 to 2026-03-17
- Goal: Async/await, for-in, try-catch, class features, prototype chain
- Worked on: Large compiler wave across async/await, for-in, try/catch/finally, class fields/methods, operator semantics, runtime error handling, and the start of React scheduler compilation work.
- Baseline: building on Sprint 8
- Final result: no test262 run recorded for this date
- test262: no dedicated full run archived
- Delta: 39 issues touched

### Issues worked on

- #408 Async/await compilation improvement
- #409 Async/await compilation improvement
- #410 Async/await compilation improvement
- #411 Async/await compilation improvement
- #412 Async/await compilation improvement
- #413 For-in loop enhancement
- #414 For-in loop enhancement
- #415 For-in loop enhancement
- #416 For-in loop enhancement
- #417 Try/catch/finally edge case
- #418 Try/catch/finally edge case
- #419 Try/catch/finally edge case
- #420 Try/catch/finally edge case
- #421 Class method/field fix
- #422 Class method/field fix
- #423 Class method/field fix
- #425 Various operator and expression fix
- #427 Various operator and expression fix
- #428 Various operator and expression fix
- #429 Various operator and expression fix
- #430 Various operator and expression fix
- #431 Various operator and expression fix
- #432 Various operator and expression fix
- #433 Various operator and expression fix
- #434 Various operator and expression fix
- #435 Various operator and expression fix
- #436 Various operator and expression fix
- #438 Additional fix
- #441 Additional fix
- #444 Additional runtime improvement
- #445 Additional runtime improvement
- #446 Additional runtime improvement
- #447 Additional runtime improvement
- #448 Additional runtime improvement
- #455 Compile React to Wasm
- #458 Additional issue
- #459 Additional issue
- #460 Additional issue
- #461 Additional issue

## Sprint 10 - v0.10.0

- Tags: `sprint/10`, `v0.10.0`
- Date range: 2026-03-18 (morning) to 2026-03-18 (morning)
- Goal: React compilation milestones, expression parser, playground improvements
- Worked on: Landed major real-world compilation milestones: React scheduler/fiber/hooks/custom renderer work, expression-parser demos, Symbol/WeakMap support, interactive conformance report work, and the first recorded large-scale test262 baseline.
- Baseline: ~6,366 pass (test262 run at 21:35 UTC)
- Final result: 6,366 pass / 23,021 total (first recorded run)
- test262: `6,366 / 23,021`
- Delta: baseline established

### Issues worked on

- #437 Continued fix from previous session
- #439 Generator .return()/.throw() methods and diagnostic downgrade
- #440 Handle dynamic import() expressions gracefully
- #449 Add ref.as_non_null before call_ref
- #450 Benchmark/maths milestone
- #451 Lodash utilities compile to Wasm
- #452 Expression parser / TypeScript compiler pattern tests
- #453 Three.js math and benchmark suite
- #454 pako zlib kernels compile to Wasm
- #455 Compile React to Wasm
- #456 Symbol.iterator/toPrimitive as compile-time constants
- #457 WeakMap/WeakSet support via extern class infrastructure
- #462 Null narrowing in if-statements
- #463 Self-referencing struct types for linked lists/fiber trees
- #464 Array bounds check elimination
- #465 Inline small functions at call sites
- #466 Local reuse via temp-local free list
- #467 Constant folding for binary expressions on numeric literals
- #468 Interactive conformance report with drill-down
- #469 React hooks state machine compiles to Wasm
- #470 f64/i32-to-externref coercion in expression statement context
- #471 Basic Symbol() support
- #472 Additional issue
- #473 Additional issue
- #474 Remove delete operator skip filter
- #475 Additional issue
- #476 Narrow hasOwnProperty.call skip filter
- #477 verifyEqualTo/verifyNotEqualTo propertyHelper stubs
- #478 assert_throws shim correctness
- #479 Additional issue
- #480 Additional issue
- #481 Resolve well-known symbols in element access
- #482 Dispatch [Symbol.toPrimitive] in type coercion
- #483 typeof Symbol() and narrower Symbol skip filter
- #484 Additional issue
- #485 Additional issue
- #486 Additional issue
- #487 Additional issue
- #488 propertyHelper transforms for hasOwnProperty/propertyIsEnumerable

## Sprint 11 - v0.11.0

- Tags: `sprint/11`, `v0.11.0`
- Date range: 2026-03-18 (afternoon/evening) to 2026-03-18 (afternoon/evening)
- Goal: Massive feature push — WASI, native strings, WIT, tail calls, SIMD, type annotations
- Worked on: Added major architecture/features rather than immediate conformance: WASI target support, native strings, WIT generation, tail-call optimization, peephole optimization, SIMD plumbing, native type annotations, TypedArray/ArrayBuffer work, and broader async/generator coverage.
- Baseline: 6,366 pass / 23,021 total
- Final result: 6,366 pass / 23,025 total (second run, minimal change)
- test262: `6,366 / 23,025`
- Delta: +0 pass (feature additions, not test262 focused)

### Issues worked on

- #493 Narrow prototype chain skip filter
- #494 Remove stale skip filters
- #495 Array-like objects with numeric keys
- #496 eval() and new Function() source transform for test262
- #497 Dynamic import() via host-side module loading
- #498 Proxy via type-aware compilation with trap inlining (70 tests)
- #499 with statement via static identifier dispatch
- #500 Remove cross-realm skip filter
- #501 Complete test262 baseline run and pin results
- #502 Quick wins: narrow stale skip filters
- #503 Runner safe-write: don't corrupt report on crash
- #504 Auto-generated README feature coverage + benchmark tables
- #505 Playground: integrate test262 results into test262 browser panel
- #506 Remove redundant conformance-report.html
- #507 Run benchmark suite and generate latest.json
- #508 ts2wasm-jwt: pure Wasm JWT decode + HS256 verify
- #509 Post-fix error analysis: create issues from fresh test262 run
- #510 TS parse errors from test wrapping
- #511 Wasm validation: call/call_ref type mismatch
- #512 RuntimeError: illegal cast
- #513 Fix any-typed equality: object/ref identity broken in __any_strict_eq and externref path
- #514 Generator/async-gen 'options is not defined'
- #515 Wasm validation: uninitialized non-defaultable local + struct.get/set type errors
- #516 struct.new argument count mismatch in class constructors
- #517 Unsupported call expression: class/generator/built-in method calls
- #518 Cannot destructure: not an array type
- #519 Internal error: targetLocal is not defined
- #520 Delete operator: operand must be optional
- #521 Yield keyword not recognized in nested contexts
- #522 Object.keys() requires struct type argument
- #523 Internal compiler errors: undefined property access
- #524 Type '{}' missing Function properties
- #525 RuntimeError: illegal cast
- #526 RuntimeError: dereferencing a null pointer
- #527 Fix test262 script: use tsx instead of node
- #528 Test262 runner -- show progress when starting each batch
- #529 Speed up test262 runner with parallel workers + compilation cache
- #530 Unsupported call expression — remaining CE bucket
- #531 Issue 531
- #532 Wasm validation: call type mismatch -- string addition folded to numeric
- #533 Wasm validation: struct.get on null ref type
- #534 Fix addUnionImports func index shift for parent function bodies
- #535 'delete' cannot be called on identifier in strict mode
- #536 Spread types may only be created from object types
- #537 TypeScript diagnostic suppressions for test262
- #538 PrivateIdentifier + new.target unsupported
- #539 Issue 539
- #540 Array out of bounds guards
- #541 Async flag skip filter blocks many tests
- #542 Negative test skip blocks many tests
- #543 propertyHelper.js + hasOwnProperty.call skip filters
- #544 Remove/narrow stale skip filters
- #545 Hang-risk skip filters
- #546 Remaining skip filters cleanup
- #547 Restore search/filter UI in report.html
- #548 Security: WAT string injection + memory bounds validation
- #549 Security: playground path traversal via symlinks
- #550 Security: XSS via error messages in report.html
- #551 Issue 551
- #552 Issue 552
- #553 Division by zero missing in constant folding
- #554 JSONL concurrent write corruption from parallel workers
- #555 Cache invalidation misses uncommitted source changes
- #556 Performance: O(n^2) struct deduplication in ensureStructForType

## Sprint 12 - v0.12.0

- Tags: `sprint/12`, `v0.12.0`
- Date range: 2026-03-19 (early) to 2026-03-19 (early)
- Goal: Test262 category expansion, continued feature work
- Worked on: Recovered from skip-filter regression by refining category coverage, removing stale skips, expanding test262 harness coverage, and fixing runtime/compiler failure patterns across the newly widened suite.
- Baseline: 5,753 pass / 22,974 total (regression from skip filter changes)
- Final result: 5,797 pass / 22,974 total → 7,139 pass / 22,974 total
- test262: `5,753 -> 7,139 / 22,974`
- Delta: +1,386 pass during the day

### Issues worked on

- #124 delete operator via undefined sentinel (232 tests)
- #125 Object.defineProperty / property descriptors (106 tests)
- #323 Native type annotations — type i32 = number
- #498 Proxy via type-aware compilation with trap inlining (70 tests)
- #557 Performance: repeated instruction tree traversal for index shifting
- #558 Performance: add hash-based function type deduplication
- #559 Addition/subtraction result not coerced to externref before call
- #560 BigInt + Number mixed arithmetic leaves stack dirty
- #561 Math.hypot closure captures ref instead of f64
- #562 Addition/subtraction valueOf coercion + Math special values
- #563 Unsupported call expression
- #564 Worker crashed -- tests lost to worker process crashes
- #565 Wrong return value bucket
- #566 Null pointer dereference (853 FAIL) - local index shift not recursive
- #567 Wasm validation: struct.get on null ref type
- #568 Wasm validation: local.set type mismatch
- #569 Issue 569
- #570 Issue 570
- #571 struct.new argument count mismatch
- #572 Internal compiler errors
- #573 struct.get on null ref in class tests
- #574 Worker crashed -- tests lost to worker process crashes
- #575 Class statement tests all return 0
- #576 TEST_CATEGORIES covers only a subset of previously-tested tests
- #577 Run test262 in a worktree to avoid mid-run code changes
- #578 WASI target: console.log -> fd_write, process.exit -> proc_exit
- #579 Issue 579
- #580 Issue 580
- #581 struct.get on ref.null in Wasm:test function
- #582 local.set type mismatch in class methods
- #583 Stack not empty at fallthrough in Wasm:test
- #584 Null pointer dereference in many tests
- #585 RuntimeError: illegal cast
- #586 Deduplicate array method callbacks
- #587 Deduplicate destructuring code
- #588 Finally block executes multiple times instead of once
- #589 ref.as_non_null on ref.null always traps
- #590 Generator for-of-string missing return depth update
- #591 Split expressions.ts into focused modules
- #592 Consolidate AST collection passes into single visitor
- #593 Minor security/correctness fixes across emit + runtime
- #594 Mark WasmGC struct types as final for V8 devirtualization
- #595 Integer loop inference: emit i32 loop counters
- #596 Eliminate unnecessary ref.cast when type is statically known
- #679 Dual string backend: js-host mode vs standalone mode

## Sprint 13 - v0.13.0

- Tags: `sprint/13`, `v0.13.0`
- Date range: 2026-03-19 (afternoon/evening) to 2026-03-19 (afternoon/evening)
- Goal: Continued test262 improvement, 53 session issues finalized
- Worked on: Finalized the large issue wave from error analysis, documented runtime failure patterns, and expanded the exercised test262 surface from roughly 23k tests to nearly 48k.
- Baseline: 7,139 pass / 22,974 total
- Final result: 9,560 pass / 47,983 total (test set nearly doubled)
- test262: `9,560 / 47,983`
- Delta: +2,421 pass, test suite expanded from ~23K to ~48K tests

### Issues worked on

- #597 Type-specialized arithmetic skips AnyValue for non-addition ops
- #598 Regression tests for typed export signatures
- #599 Decouple native WasmGC strings from fast mode
- #600 Generate WIT interface files from TypeScript types
- #601 Binaryen wasm-opt post-processing pass
- #602 Emit return_call for tail-position calls
- #603 Remove stale skip filters blocking ~2,500 tests
- #604 add asyncHelpers.js shim
- #605 bypass shouldSkip for runtime negative tests
- #606 expand test262 harness with tcoHelper, deepEqual, throwsAsync
- #607 Issue 607
- #608 TypedArray constructor and element access support
- #609 cover all test262 directories in TEST_CATEGORIES
- #610 Issue 610
- #611 Null guards for undefined AST nodes + duplicate escapeWatString
- #612 suppress async iterator diagnostics for for-await-of
- #613 suppress TS2551 property-with-suggestion diagnostic
- #614 ArrayBuffer/DataView/TypedArray in compileNewExpression
- #615 Issue 615
- #616 suppress TS2689 for Iterator/Generator extends
- #617 prevent drop on empty stack for async void calls
- #618 triage umbrella
- #619 handle class element AST nodes in statement/expression compilers
- #620 Issue 620
- #621 graceful fallback for unsupported call expressions
- #622 null guard in destructureParamObject
- #623 increase worker timeout and per-test timeout
- #624 prevent dynamic field addition to class struct types
- #625 detect no-op coerceType to prevent local.set type mismatch
- #626 coerce call/call_ref arguments to match signatures
- #627 handle void RHS in logical operators
- #628 generator yield validation via fctx.isGenerator
- #629 tuple struct destructuring in function/method parameters
- #630 skip Temporal API tests
- #631 prototype chain patterns for class instances
- #632 emit empty string for RegExp flags
- #633 extend shape inference into try/catch/loop/switch blocks
- #634 promote captured locals to globals for object literal accessors
- #642 architecture/platform issue
- #643 atomic report writes for test262 runner
- #644 platform issue
- #645 additional issue
- #646 additional issue
- #647 additional issue
- #648 additional issue
- #649 additional fix
- #650 additional issue
- #651 additional issue

## Sprint 14 - v0.14.0

- Tags: `sprint/14`, `v0.14.0`
- Date range: 2026-03-20 (early) to 2026-03-20 (early)
- Goal: Dual-mode backends, compiler infrastructure
- Worked on: Established the dual-mode backend direction: dual string and RegExp backend work, broader compiler infrastructure changes, and architecture principles later documented for the project.
- Baseline: 9,560 pass / 47,983 total
- Final result: 10,444 pass / 47,773 total
- test262: `10,444 / 47,773`
- Delta: +884 pass

### Issues worked on

- #123 Wrapper object constructors: new Number/String/Boolean (648 tests)
- #333 Additional previously blocked issue
- #490 Additional fix
- #635 architecture/compiler issue
- #636 architecture/compiler issue
- #637 architecture/compiler issue
- #638 Reverse type map / platform issue
- #649 additional fix
- #652 Compile-time ARC
- #653 additional issue
- #654 additional issue
- #655 additional issue
- #656 additional issue
- #657 additional issue
- #658 additional issue
- #659 additional issue
- #660 additional issue
- #661 Temporal / coercion issue bucket
- #662 additional issue
- #663 additional issue
- #664 additional issue
- #665 additional issue
- #668 additional fix
- #669 additional fix
- #670 additional fix
- #679 Dual string backend: js-host mode vs standalone mode
- #682 Dual RegExp backend

## Sprint 15 - v0.15.0

- Tags: `sprint/15`, `v0.15.0`
- Date range: 2026-03-20 (continued) to 2026-03-20 (continued)
- Goal: Type tracking, backlog cleanup, MCP channel server
- Worked on: Pushed on type tracking and tooling: backlog cleanup, MCP channel server integration, more compiler fixes, and broad type-flow work that drove a large pass-count jump across partial/full runs.
- Baseline: 10,444 pass / 47,773 total
- Final result: 10,974 pass → 15,244 pass (by end of day runs)
- test262: `10,974 -> 15,244`
- Delta: +530 to +4,800 (variable due to partial runs)

### Issues worked on

- #672 Additional fix
- #673 Additional fix
- #676 Compiler improvement
- #677 Compiler improvement
- #678 Compiler improvement
- #683 Type tracking issue
- #686 Closure capture types
- #687 Live-streaming report / tooling
- #688 Extract property access / split index.ts umbrella
- #689 additional issue
- #690 additional issue
- #691 additional issue
- #692 additional issue
- #693 Issue 693
- #694 additional issue
- #695 Error classification improvement
- #696 Classify runtime errors
- #697 Ref/ref_null / error classification issue
- #698 property access fallback and setter dispatch coercion
- #699 Compiler pool
- #700 Reuse ts.CompilerHost across compilations (~25% speedup)

## Sprint 16 - v0.16.0

- Tags: `sprint/16`, `v0.16.0`
- Date range: 2026-03-21 to 2026-03-21
- Goal: Error classification, type coercion, equivalence tests
- Worked on: Focused on error classification, ref/ref_null coercion, property-access correctness, equivalence-test expansion, and compile-error reduction while stabilizing the enlarged 48k suite.
- Baseline: ~15,244 pass (from 03-20 evening run)
- Final result: 15,232 pass / 48,097 total
- test262: `15,232 / 48,097`
- Delta: roughly stable (±0 from baseline)

### Issues worked on

- #695 Error classification improvement
- #697 Ref/ref_null / error classification issue
- #702 issue
- #703 issue
- #704 issue
- #705 issue
- #706 issue
- #707 issue
- #708 issue
- #709 issue
- #710 issue
- #711 issue
- #712 issue
- #713 issue
- #714 conformance progress graph with historical trend tracking
- #715 issue
- #716 issue
- #717 issue
- #718 issue
- #719 issue
- #720 missing coercion paths to coercionInstrs
- #721 issue
- #722 issue
- #723 issue
- #724 TypeError for Object.defineProperty on non-configurable properties
- #725 fall back to __extern_get when ref.cast fails in property access

## Sprint 17 - v0.17.0

- Tags: `sprint/17`, `v0.17.0`
- Date range: 2026-03-22 (morning) to 2026-03-22 (morning)
- Goal: expressions.ts refactoring, goal system
- Worked on: Refactored the oversized `expressions.ts`, added goal-system groundwork, and changed pieces of property access, lib handling, and exception flow, but incurred a measurable regression during the refactor.
- Baseline: 15,232 pass / 48,097 total
- Final result: 14,757 pass / 48,097 total → 14,720 pass / 48,102 total
- test262: `15,232 -> 14,720 / 48,102`
- Delta: -512 pass (regression, likely from refactoring)

### Issues worked on

- #726 Multi-struct dispatch for property access on wrong-type GC objects
- #728 Null dereference should throw TypeError instead of trapping
- #739 assertion sub-classification follow-up
- #740 read lib.d.ts from typescript package at runtime
- #741 split index.ts / extract modules
- #742 Extract and refactor compileCallExpression
- #745 Promise/async handling / RegExp flags null behavior
- #746 Inline property tables / hash all codegen files
- #747 Escape analysis / Object.defineProperty host import + transforms
- #748 propertyHelper.js value checks in test262 preamble
- #750 extern.convert_any at call sites for ref→externref mismatch
- #751 monomorphization issue
- #754 issue already fixed by prior work

## Sprint 18 - v0.18.0

- Tags: `sprint/18`, `v0.18.0`
- Date range: 2026-03-22 (afternoon/evening) to 2026-03-22 (afternoon/evening)
- Goal: DAG-based goal system, milestone migration, issue renumbering
- Worked on: Shifted planning/infrastructure from milestones to a DAG-style goal system, renumbered and audited issue streams, and stabilized the branch after the prior refactor regression.
- Baseline: 14,720 pass / 48,102 total
- Final result: 14,720 pass / 48,102 total (stable)
- test262: `14,720 / 48,102`
- Delta: ~0 (infrastructure/planning focused)

### Issues worked on

- #761 Rest/spread destructuring
- #762 Generator .next(value) arguments are silently ignored
- #763 RegExp runtime methods
- #764 Immutable global / Temporal-related issue
- #765 issue
- #766 Symbol.iterator protocol
- #767 Equivalence test coverage
- #768 renumbered session issue
- #769 renumbered session issue
- #770 verifyProperty transform
- #771 externref-backed arguments object to preserve param types
- #772 renumbered session issue
- #773 Monomorphize functions
- #776 Yield in expression position leaves value on stack
- #777 fixupModuleGlobalIndices / immutable global CEs

## Sprint 19 - v0.19.0

- Tags: `sprint/19`, `v0.19.0`
- Date range: 2026-03-23 to 2026-03-23
- Goal: Equivalence tests, RegExp, skip filter work
- Worked on: Worked on equivalence coverage for RegExp/Promise/Proxy/WeakMap, skip-filter cleanup, struct/call coercion fixes, and failure-pattern analysis; the sprint dipped first and then recovered strongly.
- Baseline: 14,720 pass / 48,102 total
- Final result: 14,120 pass / 48,102 total → 15,997 pass / 49,642 total
- test262: `14,120 -> 15,997 / 49,642`
- Delta: Variable — initial regression then recovery to +1,277

### Issues worked on

- #767 Equivalence test coverage
- #774 Additional fix / already-fixed cleanup

## Sprint 20 - v0.20.0

- Tags: `sprint/20`, `v0.20.0`
- Date range: 2026-03-24 to 2026-03-24
- Goal: Light maintenance day
- Worked on: Mostly maintenance and targeted repair work between larger sessions, with very low commit volume and no archived full-suite run.
- Baseline: 15,997 pass / 49,642 total
- Final result: no test262 run recorded
- test262: no archived full run

### Issues worked on

- No specific issues were recorded for this sprint.

## Sprint 21 - v0.21.0

- Tags: `sprint/21`, `v0.21.0`
- Date range: 2026-03-25 to 2026-03-25
- Goal: Mutable closure captures, assertion failures, type errors
- Worked on: Addressed mutable closure captures, assertion-failure patterns, TypeError/null-trap behavior, early error detection, regex-based assert routing, and several compiler error-model fixes.
- Baseline: ~15,997 pass / 49,642 total
- Final result: 15,410 pass / 49,663 total
- test262: `15,410 / 49,663`
- Delta: -587 from peak (expanded test coverage exposing new failures)

### Issues worked on

- #729 generator return values dropped
- #730 TypeError for destructuring null/undefined and new on arrows
- #731 function/class .name property infrastructure
- #732 hasOwnProperty/propertyIsEnumerable correctness
- #734 Array method correctness edge cases
- #738 instanceof to host for unresolvable constructors
- #771 externref-backed arguments object to preserve param types
- #775 null dereferences throw catchable TypeError instead of trapping
- #779 Wrong values / boxed captures written in outer scope
- #780 null guards to throw TypeError instead of trapping
- #781 __async_iterator for for-await-of
- #782 detect JS undefined in destructuring defaults
- #783 throw TypeError when destructuring null/undefined
- #784 early error checks for rest elements, await/yield identifiers, strict reserved words
- #785 null guards for for-of array/string struct.get
- #786 Multi-assertion failures / boxed capture propagation / wrong AnyValue→f64 unboxing
- #787 NaN sentinel for f64 default parameter checks
- #788 modularize src/ into focused subfolder structure

## Sprint 22 - v0.22.0

- Tags: `sprint/22`, `v0.22.0`
- Date range: 2026-03-26 (morning) to 2026-03-26 (morning)
- Goal: Compile-away principle, new issues, memory files
- Worked on: Established the “compile away, don’t emulate” principle while landing null-guard fixes, TDZ checks, `verifyProperty` handling, ref.cast safety, iterator protocol work, memory/process notes, and a new batch of issue triage.
- Baseline: 15,410 pass / 49,663 total
- Final result: 15,579 pass / 49,833 total
- test262: `15,579 / 49,833`
- Delta: +169 pass

### Issues worked on

- #494 Remove stale skip filters
- #766 Symbol.iterator protocol
- #770 verifyProperty transform
- #778 Illegal cast failures
- #789 Null guard only throws TypeError for genuinely null refs
- #790 TDZ checks in closures and for-loop let/const
- #791 Detect SyntaxErrors that ES spec requires but TS parser accepts
- #792 Export exception tag and multi-struct dispatch for emitGuardedRefCast
- #793 class/elements compilation hang investigation
- #794 nested binding patterns with defaults in destructuring
- #795 externref unbox/string-concat coercion for boxed captures
- #796 destructuring default value checks in param destructuring
- #797 Property descriptor work
- #798 foreign JS exceptions / rethrow instruction
- #799 prototype chain walk for property access
- #800 compile-away typeof / null guards / TDZ analysis
- #801 tuple literals in destructuring defaults
- #811 issue
- #812 Test262Error extern class
- #813 private member name collision
- #815 Regression from patch-rescue commits

## Sprint 23 - v0.23.0

- Tags: `sprint/23`, `v0.23.0`
- Date range: 2026-03-26 (afternoon/evening) to 2026-03-26 (afternoon/evening)
- Goal: Push toward 20K pass, team protocol improvements
- Worked on: Continued the same fix wave with more honest measurement discipline: cache-clearing, repeated full-suite verification, and team/protocol updates that corrected previously inflated counts.
- Baseline: 15,579 pass / 49,833 total
- Final result: 15,362 pass / 49,834 total (full run)
- test262: `15,362 / 49,834`
- Delta: -217 pass (honest measurement after cache clear)

### Issues worked on

- #789 Null guard only throws TypeError for genuinely null refs
- #790 TDZ checks in closures and for-loop let/const
- #791 Detect SyntaxErrors that ES spec requires but TS parser accepts
- #792 Export exception tag and multi-struct dispatch for emitGuardedRefCast
- #793 class/elements compilation hang investigation
- #794 nested binding patterns with defaults in destructuring
- #795 externref unbox/string-concat coercion for boxed captures
- #796 destructuring default value checks in param destructuring
- #797 Property descriptor work
- #798 foreign JS exceptions / rethrow instruction
- #799 prototype chain walk for property access
- #800 compile-away typeof / null guards / TDZ analysis
- #801 tuple literals in destructuring defaults
- #802 issue
- #803 issue
- #804 issue
- #805 issue
- #806 issue
- #807 issue
- #808 issue
- #809 issue
- #810 issue
- #811 issue
- #812 Test262Error extern class
- #813 private member name collision
- #815 Regression from patch-rescue commits

## Sprint 24 - v0.24.0

- Tags: `sprint/24`, `v0.24.0`
- Date range: 2026-03-27 (early morning) to 2026-03-27 (early morning)
- Goal: valueOf recursion fixes, depth limiter, String/prototype unblocking
- Worked on: Unblocked `String.prototype` and valueOf-heavy tests with recursion depth limiting, SyntaxError early-error checks, RangeError validation, JS-`undefined` emission fixes, and better runtime error classification.
- Baseline: ~15,182 pass / 49,840 total
- Final result: 14,169 pass → 14,616 pass / 49,880 total
- test262: `14,616 / 49,880`
- Delta: +447 pass (from session start of 14,169)

### Issues worked on

- #675 Dynamic import
- #696 Classify runtime errors
- #701 resolveWasmType recursion depth guard
- #733 RangeError validation
- #736 SyntaxError gaps / early error checks
- #737 Emit JS undefined instead of null for missing args/uninit vars
- #816 String/prototype compilation hang investigation

## Sprint 25 - v0.25.0

- Tags: `sprint/25`, `v0.25.0`
- Date range: 2026-03-27 (afternoon) to 2026-03-27 (afternoon)
- Goal: Wave 4 merge, class/elements unblocking, worker thread execution
- Worked on: Merged the wave-4 fixes: broader destructuring coverage, RegExp host-import methods, ref.cast guarding, removal of class/elements hang workarounds, and replacement of direct execution with a worker-thread Wasm pool.
- Baseline: 14,616 pass / 49,880 total
- Final result: 15,197 pass / 49,881 total (+1,028 session gain)
- test262: `15,197 / 49,881`
- Delta: +581 from sprint start, +1,028 from session start (14,169)

### Issues worked on

- #761 Rest/spread destructuring
- #763 RegExp runtime methods
- #766 Symbol.iterator protocol
- #778 Illegal cast failures
- #789 Null guard only throws TypeError for genuinely null refs
- #793 class/elements compilation hang investigation
- #815 Regression from patch-rescue commits
- #817 let/const in loop and try/catch bodies
- #818 additional issue
- #819 Multi-file compilation for _FIXTURE tests via compileMulti
- #820 TypeError / null dereference failures
- #821 additional issue
- #822 Wasm type mismatch compile errors (907 CE)
- #823 additional issue

## Sprint 26 - v0.26.0

- Tags: `sprint/26`, `v0.26.0`
- Date range: 2026-03-27 (evening) to 2026-03-28 (early)
- Goal: Exception tag fix, honest baseline, multi-file compilation
- Worked on: Exposed stale-cache inflation, fixed exception-tag and multi-file compilation issues, revisited arguments/default/null-deref behavior, and reset the project onto an honest worker-thread baseline.
- Baseline: 15,197 pass / 49,881 total (stale cache)
- Final result: 13,289 pass / 36,828 total (fresh run with worker threads)
- test262: sprint document records `13,289 / 36,828`; tag uses the nearest preserved boundary snapshot
- Delta: Honest baseline established — previous 15,197 was stale cache

### Issues worked on

- #779 Wrong values / NaN sentinel defaults / closure semantics
- #819 Multi-file compilation for _FIXTURE tests via compileMulti
- #820 TypeError / null dereference failures
- #822 Wasm type mismatch compile errors (907 CE)

## Sprint 27 - v0.27.0

- Tags: `sprint/27`, `v0.27.0`
- Date range: 2026-03-28 (morning/afternoon) to 2026-03-28 (morning/afternoon)
- Goal: Test262 infrastructure overhaul — precompiler, caching, vitest runner
- Worked on: Overhauled test262 infrastructure: standalone precompiler, two-phase compile/run flow, compiler pools sized to cores, batch JSONL writes, split compile/run logs, disk cache, Vitest integration, and targeted skip policy cleanup.
- Baseline: 13,289 pass (honest baseline)
- Final result: 17,612 pass / 48,086 total → 18,546 pass / 48,086 total
- test262: `17,612 -> 18,546 / 48,086`
- Delta: +4,323 to +5,257 from honest baseline

### Issues worked on

- #674 SharedArrayBuffer and Atomics
- #832 Upgrade to TypeScript 6.x to support Unicode 16.0.0 identifiers
- #833 Consider sloppy mode support for legacy octal escapes and non-strict code
- #834 ES2025 Set methods
- #835 Unknown extern class: Error types
- #836 Tagged templates with non-PropertyAccess tag expressions
- #837 Stage 3: Map/WeakMap upsert
- #838 BigInt64Array / BigUint64Array typed arrays

## Sprint 28 - v0.28.0

- Tags: `sprint/28`, `v0.28.0`
- Date range: 2026-03-28 (evening) to 2026-03-29 (early)
- Goal: PO analysis, runtime fix wave, closure semantics
- Worked on: Combined PO-guided analysis with runtime/compiler fixes for computed properties, accessor correctness, iterator close protocol, safe externref destructuring, closure capture semantics, callback detection, and runtime trap diagnostics.
- Baseline: 18,546 pass / 48,086 total
- Final result: 18,117 pass / 47,835 total → 18,186 pass / 47,782 total
- test262: `18,117 -> 18,186 / 47,782`
- Delta: -360 to -429 from peak (but more honest/complete runs)

### Issues worked on

- #848 Class computed property and accessor correctness
- #850 Object-to-primitive conversion missing: valueOf/toString not called
- #851 Iterator close protocol not implemented
- #852 Destructuring parameters cause null_deref and illegal_cast
- #857 wasm_compile: 'fn is not a function' in Array callback methods
- #859 Map.forEach callback captures are immutable snapshots
- #860 Promise executor and property-assigned functions not compiled as host callbacks
- #861 Playground: fs module externalized error in browser
- #862 Empty error message failures: iterator/destructuring step-err tests
- #863 decodeURI/encodeURI failures
- #864 WeakMap/WeakSet invalid key errors

## Sprint 29 - v0.29.0

- Tags: `sprint/29`, `v0.29.0`
- Date range: 2026-03-29 to 2026-03-29
- Goal: Team infrastructure, agent roles, checklists, runtime fixes
- Worked on: Mixed compiler fixes with team/process infrastructure: array callback semantics, for-of defaults, math methods, AggregateError, URI imports, WeakMap boxing, caller-side default-param refactor, ff-only merge rules, agent roles, and checklist-driven workflow.
- Baseline: 18,167 pass / 47,797 total
- Final result: 18,284 pass / 48,088 total
- test262: `18,284 / 48,088`
- Delta: +117 pass from baseline

### Issues worked on

- #825 Null dereference failures
- #827 Array callback methods: 'fn is not a function' Wasm compile error
- #836 Tagged templates with non-PropertyAccess tag expressions
- #839 return_call stack args and type mismatch in class constructors
- #840 Array.prototype.concat/push/splice require 0-arg support
- #841 Unsupported Math methods: sumPrecise, cosh, sinh, tanh, f16round
- #843 super keyword in object literals and edge cases
- #844 Unsupported new expression for built-in classes
- #846 assert.throws not thrown: built-in methods accept invalid arguments silently
- #847 for-await-of / for-of destructuring produces wrong values
- #849 Mapped arguments object does not sync with named parameters
- #854 Iterator protocol: null next/return/throw methods
- #856 Expected TypeError but got wrong error type
- #863 decodeURI/encodeURI failures
- #864 WeakMap/WeakSet invalid key errors
- #865 Console wrapper for fd_write in JavaScript environments
- #866 Regression: NaN sentinel interferes with toString/valueOf and explicit NaN arguments
- #867 Playground: interactive test262 conformance explorer with inline errors
- #868 Playground: lazy-load test262 tree and file contents on demand
- #869 Refactor default params: caller-side insertion instead of sNaN sentinel
- #870 Playground: Monaco web workers fail to load, UI freezes
- #871 Playground: default example throws WebAssembly.Exception at runtime
- #872 Test262 report data should only update on complete runs
- #873 Design dev branch protocol for agent merge workflow

## Sprint 30 - v0.30.0

- Tags: `sprint/30`, `v0.30.0`
- Date range: 2026-03-29 to 2026-03-29
- Goal: High-impact test262 fixes targeting 40%+ pass rate
- Worked on: Targeted the biggest remaining test262 wins: computed class properties/accessors, for-of destructuring, `assert.throws` validation, array callback methods, destructuring null-deref repair, plus verifyProperty diagnosis and stronger merge/test discipline.
- Baseline: 18,284 pass / 48,088 total (38.0%)
- Final result: 18,599 pass / 48,088 total (38.7%)
- test262: `18,599 / 48,088`
- Delta: +315 pass, -64 CE

### Issues worked on

- #822 Wasm type mismatch compile errors (907 CE)
- #824 Compilation timeouts: tests exceed compile limit
- #825 Null dereference failures
- #827 Array callback methods: 'fn is not a function' Wasm compile error
- #846 assert.throws not thrown: built-in methods accept invalid arguments silently
- #847 for-await-of / for-of destructuring produces wrong values
- #848 Class computed property and accessor correctness
- #850 Object-to-primitive conversion missing: valueOf/toString not called
- #852 Destructuring parameters cause null_deref and illegal_cast
- #857 wasm_compile: 'fn is not a function' in Array callback methods
- #866 Regression: NaN sentinel interferes with toString/valueOf and explicit NaN arguments

## Sprint 31 - v0.31.0

- Tags: `sprint/31`, `v0.31.0`
- Date range: 2026-03-30 to 2026-03-30
- Goal: Re-apply sprint-31 fixes without regressions. Test262 between EVERY merge.
- Worked on: Re-ran the previous sprint under a stricter safe-first protocol, focusing on tail-call guards, sNaN/ToPrimitive fixes, WasmGC iterable support, equivalence-test infrastructure, and “test262 after every merge” process enforcement before the sprint was suspended.
- Baseline: 15,246 pass / 48,174 total (31.7%) — honest baseline, no cache, negative test bug fixed
- Final result: baseline `15,246 / 48,174`; latest archived full run `15,155 / 48,174`
- test262: baseline `15,246 / 48,174`; latest archived full run `15,155 / 48,174`

### Issues worked on

- #822 Wasm type mismatch compile errors (907 CE)
- #826 Illegal cast failures
- #828 Unexpected undefined AST node in compileExpression
- #839 return_call stack args and type mismatch in class constructors
- #851 Iterator close protocol not implemented
- #854 Iterator protocol: null next/return/throw methods
- #862 Empty error message failures: iterator/destructuring step-err tests
- #866 Regression: NaN sentinel interferes with toString/valueOf and explicit NaN arguments
- #868 Playground: lazy-load test262 tree and file contents on demand
- #876 Sprint dashboard — kanban board, burndown, agent status, metrics
- #877 Agile criteria — Definition of Ready, Definition of Done, velocity tracking
- #891 Apply test262 infrastructure learnings to equivalence tests

## Sprint 52 - v0.52.0

- Tags: `sprint/52`, `v0.52.0`
- Date range: 2026-05-20
- Goal: Spec-completeness continuation + host platform imports — spec gap fixes, WASI extensions, Node.js/browser host imports, method closure caching, builtin subclassing
- Baseline: 22,412 pass / 43,160 total (51.9%) at v0.41.0
- Final result: 28,171 pass / 43,160 total (65.3%)
- test262: `28,171 / 43,160`
- Delta: +5,759 pass from v0.41.0 baseline (+25.7 pp)

### Highlights

- **Node.js host imports**: `fs.readFileSync`/`writeFileSync`/`existsSync` (gated behind `--allow-fs`), `crypto.randomBytes`/`randomUUID`, `console.error`/`warn` stderr routing, `process.argv`/`env`/`cwd`/`exit`, `__dirname`/`__filename`/`import.meta.url`
- **Browser host imports**: `fetch`, `setTimeout`/`setInterval`/`clearTimeout`, `localStorage`/`sessionStorage`, `crypto.getRandomValues`, export return-type interop
- **WASI extensions**: stdin via `fd_read`, console stderr via `fd_write`, `environ_get`/`environ_sizes_get`, `clock_time_get`, async stubs
- **Builtin subclassing**: `instanceof Sub` and `instanceof Parent` both true for `class Sub extends Map/Float32Array/WeakRef/Set` (tag-chain runtime approach)
- **Method closure caching**: fixes repeated `obj.method` creating new function objects each time
- **Spec gap fixes**: assignment-operator destructuring completion, rest-parameter destructuring, `ToNumber`/`ToNumeric` coercion, named-evaluation destructuring defaults, for-loop per-iteration let binding, iterator protocol destructuring close, private reference readonly TypeError, `Object.defineProperty` descriptor fidelity, `Array.prototype` generic arraylike, `Promise` combinators, generator prototype, `Array.fromAsync`, and 30+ more
- **Test262 CI**: 3× speedup via cross-PR baseline cache and per-scope test filter; sharded run time ~8 min
- **ESLint valid-wasm plugin**: `@loopdive/eslint-plugin-js2` package entries fixed

### Issues worked on (done)

- #1392 Refresh benchmarks — browser runtime hang
- #1394 Method closure caching
- #1396 for-of destructuring externref array defaults
- #1397 Static dispatch on method reassignment
- #1398 Report edition filter and category table
- #1400 ESLint package entry valid-wasm
- #1431 Assignment-operator destructuring completion
- #1432 Parameter list rest destructuring
- #1434 ToNumber/ToNumeric unary coercion
- #1437 Math numeric edge cases
- #1455 Subclassing builtins — instanceof and prototype chain
- #1481 WASI stdin fd_read
- #1491 Node.js fs host imports (non-WASI)
- #1493 Node.js console.error/warn stderr routing
- #1521 Test262 CI speedup — cross-PR cache and scope filter

## Releases since v0.52.0

Generated from `git tag` and the merged-PR titles of each tag range (#6795); the sprint sections above are the older, hand-written history. Each entry lists the newest feature and fix PRs and counts the rest. The test262 figures are read from the artifact committed at each tag; the harness and the scored scope changed over this period (for example the oracle v8 reset in v0.61.0), so they are not comparable across releases.

## v0.56.0 - 2026-05-29

- Tag `v0.56.0` · range `v0.52.0..v0.56.0` · [compare](https://github.com/loopdive/js2/compare/v0.52.0...v0.56.0) · also tagged `sprint/56`
- `package.json` still read `0.52.0` at this tag, so it is a sprint-boundary tag with no matching package version.
- 294 merged PRs: 20 features, 151 fixes, 123 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 30,214 / 43,135 (70.0 %).
- No `v0.53.0`, `v0.54.0` or `v0.55.0` tag was ever cut and `package.json` stayed at `0.52.0` throughout, so there is no such release; this entry covers everything since `v0.52.0` (sprints 53–56).

### Features

- feat(#1636-S1): add __call_fn_method_N dispatcher for this-val threading (Slice 1 of 3) ([PR 873](https://github.com/loopdive/js2/pull/873))
- feat(#1660): CLA gate — PR template checkbox ([PR 852](https://github.com/loopdive/js2/pull/852))
- feat(#1588) PR-C: standalone __str_to_utf8 transcoder + benchmark + ADR ([PR 571](https://github.com/loopdive/js2/pull/571))
- feat(#1588) Phase 2 PR-B part 2: activate i8 string storage end-to-end ([PR 567](https://github.com/loopdive/js2/pull/567))
- feat(#1588) Phase 2 PR-B part 1: dual i8/i16 string-storage scaffolding (gated, inert) ([PR 548](https://github.com/loopdive/js2/pull/548))
- feat: enforce dual-mode architecture with --no-host-imports flag + CI gate (#1524) ([PR 432](https://github.com/loopdive/js2/pull/432))
- feat(#1042): async CPS lowering module skeleton (gated off) ([PR 544](https://github.com/loopdive/js2/pull/544))
- feat(#1588) Phase 2 PR-A: call-result string-encoding origins + method propagation ([PR 546](https://github.com/loopdive/js2/pull/546))
- feat(#747): IR escape analysis on #1587 ownership (Phase 1) ([PR 545](https://github.com/loopdive/js2/pull/545))
- feat(#1588): string encoding analysis (UTF-8/WTF-16 lattice) on IR alloc sites ([PR 538](https://github.com/loopdive/js2/pull/538))
- feat(#1587): ownership + access-semantics analysis on IR values (Phase 1) ([PR 539](https://github.com/loopdive/js2/pull/539))
- feat(#1586): explicit IR allocation sites with stable identity + metadata hooks ([PR 536](https://github.com/loopdive/js2/pull/536))
- feat(scripts): auto-update conformance numbers after each test262 run (#1522) ([PR 425](https://github.com/loopdive/js2/pull/425))
- feat(standalone): eliminate JS host string ops ([PR 408](https://github.com/loopdive/js2/pull/408))
- feat(#1198): pre-size dense arrays at const a = [] allocation site ([PR 350](https://github.com/loopdive/js2/pull/350))
- feat(ir): ratchet IR-fallback budget + per-kind demote-to-warning scoping (#1530) ([PR 430](https://github.com/loopdive/js2/pull/430))
- feat(#1326c): Phase 1C-A — microtask queue + drain export (WASI standalone) ([PR 405](https://github.com/loopdive/js2/pull/405))
- feat(#1540): JSX runtime host binding — _jsx/_jsxs/_Fragment ([PR 429](https://github.com/loopdive/js2/pull/429))
- feat: default pass-rate to ECMAScript standard, opt-in proposals via landing-page slider ([PR 474](https://github.com/loopdive/js2/pull/474))
- feat(#1373b Slice 1): IR async Phase C scaffolding — gate + FULFILLED/REJECTED fast paths ([PR 441](https://github.com/loopdive/js2/pull/441))

### Fixes

- fix(#1337): bound-function variable storage + invocation (Layer-2) ([PR 883](https://github.com/loopdive/js2/pull/883))
- fix(ci): promote-baseline atomically syncs conformance docs (#1522) ([PR 898](https://github.com/loopdive/js2/pull/898))
- fix(#1636-S1): gate __current_this fallback to host-dispatchable closures only ([PR 895](https://github.com/loopdive/js2/pull/895))
- fix(ci): pre-push conformance sync + baseline direct-push to main ([PR 896](https://github.com/loopdive/js2/pull/896))
- fix(#1690b): inner function var shadows module global instead of aliasing it ([PR 882](https://github.com/loopdive/js2/pull/882))
- fix(ci): baseline PRs use --admin --merge instead of --auto ([PR 893](https://github.com/loopdive/js2/pull/893))
- fix(#1530): nm_js2wasm.sh — specific Wasm proposals instead of all-proposals ([PR 886](https://github.com/loopdive/js2/pull/886))
- fix(#1333): Annex B legacy RegExp accessors override V8 native ([PR 877](https://github.com/loopdive/js2/pull/877))
- fix(#1695): persistent writeback for DisposableStack stored callbacks ([PR 875](https://github.com/loopdive/js2/pull/875))
- fix(#1554): reject --standalone + --allow-fs at parse time ([PR 872](https://github.com/loopdive/js2/pull/872))
- …and 141 more fix PRs (newest 10 shown; see the compare link).

## v0.57.0 - 2026-06-27

- Tag `v0.57.0` · range `v0.56.0..v0.57.0` · [compare](https://github.com/loopdive/js2/compare/v0.56.0...v0.57.0)
- 1049 merged PRs: 158 features, 516 fixes, 375 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,319 / 43,135 (74.9 %).

### Features

- perf(#2682): string read-loop fast path — hoist charCodeAt flatten/descriptor + proof-gated i32 leaf ([PR 2122](https://github.com/loopdive/js2/pull/2122))
- feat(#2701): node:fs/promises destructured-import host-glue (slash sanitisation) ([PR 2121](https://github.com/loopdive/js2/pull/2121))
- feat(#2699): host-glue node:url/module/os destructured function imports ([PR 2118](https://github.com/loopdive/js2/pull/2118))
- feat(#2660): PART-1 inert receiver-struct analysis + resolveReceiverStruct ([PR 2112](https://github.com/loopdive/js2/pull/2112))
- feat(#2693): MILESTONE — ESLint-style Linter.verify runs as Wasm in Node (host-delegated parse) ([PR 2107](https://github.com/loopdive/js2/pull/2107))
- feat(#2660 S3a): reconstruct approved empty-body new F() as $Object (standalone canary) ([PR 2104](https://github.com/loopdive/js2/pull/2104))
- feat(#1791): node:path posix shim (pure TS, host + standalone) ([PR 2105](https://github.com/loopdive/js2/pull/2105))
- feat(examples): native-messaging node:process variant + 5-way comparison harness ([PR 2089](https://github.com/loopdive/js2/pull/2089))
- feat(host-interop): #2682 Deno stdio surface (Deno.stdin/stdout.*Sync → WASI fd) + nm_deno.ts ([PR 2094](https://github.com/loopdive/js2/pull/2094))
- feat(#2660 S2): per-fnctor prototype $Object (standalone) ([PR 2087](https://github.com/loopdive/js2/pull/2087))
- feat(wasi): #2658 B0 spike — P3 async stream<u8> echo runs under wasmtime 44 + nm_wasi_p3 comparison instance ([PR 2092](https://github.com/loopdive/js2/pull/2092))
- feat(#2663): with Tier-2 @@unscopables HasBinding (Slice 4, host-mode) ([PR 2082](https://github.com/loopdive/js2/pull/2082))
- feat(#2663): with Tier-2 dynamic delete + var/object precedence — Slice 3 (ref #1472) ([PR 2065](https://github.com/loopdive/js2/pull/2065))
- feat(#2663): with Tier-2 dynamic-scope WRITE — Slice 2 (ref #1472) ([PR 2061](https://github.com/loopdive/js2/pull/2061))
- feat(#2663): with Tier-2 dynamic-scope READ — Slice 1 (ref #1472) ([PR 2059](https://github.com/loopdive/js2/pull/2059))
- feat(#2660 S1): inert whole-program escape/dynamic-use gate for new F() instances ([PR 2056](https://github.com/loopdive/js2/pull/2056))
- feat(wasi): #2657 raw wasi_snapshot_preview1 fd_read/fd_write import + nm_wasi.ts variant ([PR 2044](https://github.com/loopdive/js2/pull/2044))
- feat(#1355): standalone Proxy ownKeys trap (Slice E, §10.5.11) ([PR 2042](https://github.com/loopdive/js2/pull/2042))
- feat: #2528/#2645 --platform node|web + compose with node capability gate ([PR 2034](https://github.com/loopdive/js2/pull/2034))
- feat(wasi): #2655 direct WASI P1 fd_read/fd_write for node:fs readSync/writeSync (no shim) ([PR 2037](https://github.com/loopdive/js2/pull/2037))
- …and 138 more feature PRs (newest 20 shown; see the compare link).

### Fixes

- fix(#2726): hasOwnProperty-after-delete + non-configurable accessor delete (groups c/d) ([PR 2177](https://github.com/loopdive/js2/pull/2177))
- fix(#2741): `in` operator — primitive-RHS TypeError + LHS-before-RHS eval order ([PR 2181](https://github.com/loopdive/js2/pull/2181))
- fix(#2739): for-in walks a setPrototypeOf prototype chain (part a) ([PR 2180](https://github.com/loopdive/js2/pull/2180))
- fix(#2687): emit __call_fn_method_N up to max closure arity (acorn parseSubscript dispatch) ([PR 2175](https://github.com/loopdive/js2/pull/2175))
- fix(#2628): method call on a __construct_closure-built instance (new this().m()) ([PR 2172](https://github.com/loopdive/js2/pull/2172))
- fix(#2731): symmetric delete-aware property write routing (delete+re-add re-appears in for-in) ([PR 2170](https://github.com/loopdive/js2/pull/2170))
- fix(#2680): ToPropertyDescriptor reads proto-inherited descriptor attributes ([PR 2168](https://github.com/loopdive/js2/pull/2168))
- fix(#2707c): TCO through ?:/&&/||/comma + recursive named-fn-expr IIFE ([PR 2159](https://github.com/loopdive/js2/pull/2159))
- fix(#2720): full non-Unicode /i case folding in standalone regex ([PR 2166](https://github.com/loopdive/js2/pull/2166))
- fix(wasi): #2735 stdin reactor non-EOF termination (process.exit/.destroy/in-band shutdown) ([PR 2165](https://github.com/loopdive/js2/pull/2165))
- …and 506 more fix PRs (newest 10 shown; see the compare link).

### Carried over from the former Unreleased section: Breaking: `compile()` API is now async (#1757)

- The public compiler entry points — `compile`, `compileMulti`, `compileFiles`,
  `compileToWat`, `compileProject`, and `createIncrementalCompiler().compile`
  (plus the lower-level `compileSource` / `compileMultiSource` /
  `compileFilesSource`) — now return a `Promise`. **Every caller must `await`
  them.** A synchronous `compileSourceSync` (no Binaryen optimization) is
  retained for the few contexts that cannot await (the `eval` host shim).
- **Why:** the optional Binaryen optimizer now loads via
  `await import("binaryen")` instead of a synchronous `require`. Binaryen ships
  a top-level `await` that a sync `require` cannot load, which is what blocked
  embedding it in a `bun build --compile` / `deno compile` standalone binary
  (GH #986). With the async path the optimizer is bundled and the single-file
  binary runs `--optimize` with Binaryen embedded — no `wasm-opt` on `PATH`
  required. Follow-up to the #1756 `createRequire` stopgap.

  Migration: `const r = compile(src)` → `const r = await compile(src)`.

### Carried over from the former Unreleased section: Added: relocatable standalone CLI bundle (#1775, GH #986 follow-up)

- Added `pnpm run build:standalone-cli`, which writes
  `dist/js2wasm-standalone.mjs` for `deno compile` / `bun build --compile`
  workflows. This build bundles the core compiler dependencies and injects
  TypeScript's `lib.*.d.ts` files into the existing bundled-lib hook, so the
  generated file does not need to stay next to `node_modules/typescript/lib`.
- Standalone bundles now get the package version injected at build time, so
  `--version` does not rely on `../package.json` after the file is moved.
- Binaryen is now an optional peer/dev dependency and is no longer bundled into
  the standalone CLI artifact; `-O` can use an installed `binaryen` package or a
  `wasm-opt` binary on PATH, and the emitted `.wasm` can be optimized afterward.
- The standalone docs now recommend `--minify`, which brings the no-Binaryen
  bundle down to roughly 8.5 MB before native runtime embedding.

## v0.58.0 - 2026-06-28

- Tag `v0.58.0` · range `v0.57.0..v0.58.0` · [compare](https://github.com/loopdive/js2/compare/v0.57.0...v0.58.0)
- 64 merged PRs: 8 features, 24 fixes, 32 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,667 / 43,135 (75.7 %).

### Features

- feat(#2785): type-aware box primitive — box keyed on the TS type, not the Wasm kind ([PR 2248](https://github.com/loopdive/js2/pull/2248))
- feat(#2782): hybrid IR Row-5 — no-box NUMBER-local proof gate ([PR 2245](https://github.com/loopdive/js2/pull/2245))
- feat(#2781): hybrid IR Row-7 — Binary `+` string-or-number proof-gate ([PR 2244](https://github.com/loopdive/js2/pull/2244))
- feat(#2780): hybrid IR ArrayLiteral widening-escape gate ([PR 2243](https://github.com/loopdive/js2/pull/2243))
- feat(compiler): #2771 bundle relative imports for standalone WASI compilation ([PR 2237](https://github.com/loopdive/js2/pull/2237))
- feat(codegen): #2773 S1 keystone — reserve fnctor struct types up-front (pass-invariant typeIdx) ([PR 2234](https://github.com/loopdive/js2/pull/2234))
- feat(process): wire weekly budget source from statusline; close #2751 ([PR 2199](https://github.com/loopdive/js2/pull/2199))
- feat(process): rolling sprint model + budget-aware pull scheduling (#2751) ([PR 2194](https://github.com/loopdive/js2/pull/2194))

### Fixes

- fix(#2766): IR ElementAccess prove-then-specialize (folds #2760) ([PR 2233](https://github.com/loopdive/js2/pull/2233))
- fix(codegen): #2714 object-spread keys enumerable in non-specific contexts ([PR 2215](https://github.com/loopdive/js2/pull/2215))
- fix(#2757): bind object/array/member rest targets in array assignment-destructuring ([PR 2224](https://github.com/loopdive/js2/pull/2224))
- fix(website): mobile-friendly feature test report layout ([PR 2236](https://github.com/loopdive/js2/pull/2236))
- fix(#2774): relabel edition card summary % as edition-wide on landing page ([PR 2235](https://github.com/loopdive/js2/pull/2235))
- fix(#2767): recover nominal type for bare-var method receiver dispatch ([PR 2228](https://github.com/loopdive/js2/pull/2228))
- fix(#2671): recognize Promise.resolve/reject capability-ctor sites (+6 test262) ([PR 2225](https://github.com/loopdive/js2/pull/2225))
- fix(#2729): apply ToUint8 on WasmGC Uint8Array element store ([PR 2223](https://github.com/loopdive/js2/pull/2223))
- fix(#2764): invoke @@hasInstance handler at spec arity 1 ([PR 2221](https://github.com/loopdive/js2/pull/2221))
- fix(#2756): array-pattern object/class default null-deref + fn-name-class NamedEvaluation ([PR 2216](https://github.com/loopdive/js2/pull/2216))
- …and 14 more fix PRs (newest 10 shown; see the compare link).

## v0.59.0 - 2026-06-28

- Tag `v0.59.0` · range `v0.58.0..v0.59.0` · [compare](https://github.com/loopdive/js2/compare/v0.58.0...v0.59.0)
- 30 merged PRs: 5 features, 14 fixes, 11 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,704 / 43,135 (75.8 %).
- Release notes: [docs/releases/0.59.0.md](docs/releases/0.59.0.md)

### Features

- feat(#2792): symbol[] OOB→undefined + native standalone __box_symbol ([PR 2261](https://github.com/loopdive/js2/pull/2261))
- feat(#2784): S3 native-vec-aware method + element dispatch — acorn parses identifiers/calls ([PR 2260](https://github.com/loopdive/js2/pull/2260))
- feat(cli): #2783 remove --link-node-shims alias entirely (--link node:fs only) ([PR 2258](https://github.com/loopdive/js2/pull/2258))
- feat(cli): #2783 S1-S3 general --link <namespace> dynamic-linking flag (generalize --link-node-shims) ([PR 2256](https://github.com/loopdive/js2/pull/2256))
- feat(#2788): hybrid IR no-box NUMBER-local gate — i32 arm (#2782 fast-follow) ([PR 2255](https://github.com/loopdive/js2/pull/2255))

### Fixes

- fix: present WasmGC vec fields to host as real JS arrays (#2801 layer-1) ([PR 2275](https://github.com/loopdive/js2/pull/2275))
- fix(#2804): object spread & Object.assign copy keys + values (rep mismatch) ([PR 2274](https://github.com/loopdive/js2/pull/2274))
- fix(#2800): read init-time any-receiver fields host-free during module-init ([PR 2272](https://github.com/loopdive/js2/pull/2272))
- fix(#2796): diff-test host lane runs top-level after setExports (deferTopLevelInit) ([PR 2270](https://github.com/loopdive/js2/pull/2270))
- fix(checker/codegen): #2754 transpiled-.js sync NM hosts round-trip (zero-output) + CI coverage ([PR 2268](https://github.com/loopdive/js2/pull/2268))
- fix(host): #2795 console.log applies ToString/ToPrimitive + renders booleans as true/false ([PR 2267](https://github.com/loopdive/js2/pull/2267))
- fix(#2794): compiled-acorn parses var-declarations (host-proxy data-struct + vec reads) ([PR 2264](https://github.com/loopdive/js2/pull/2264))
- fix(#2795): typed-array element OOB read → JS undefined (hybrid audit Row 9) ([PR 2263](https://github.com/loopdive/js2/pull/2263))
- fix(codegen): #2788 coerce module-init call args — array/01-basic + closures/10-mutual emit valid wasm ([PR 2259](https://github.com/loopdive/js2/pull/2259))
- fix(#2773): S2/S2b substrate + dispatcher funcIdx over-shift fix (new this() reconstruct, dispatch symmetry, #2687 literal gap) ([PR 2247](https://github.com/loopdive/js2/pull/2247))
- …and 4 more fix PRs (newest 10 shown; see the compare link).

## v0.59.1 - 2026-06-29

- Tag `v0.59.1` · range `v0.59.0..v0.59.1` · [compare](https://github.com/loopdive/js2/compare/v0.59.0...v0.59.1)
- 9 merged PRs: 0 features, 5 fixes, 4 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,817 / 43,135 (76.1 %).
- Release notes: [docs/releases/0.59.1.md](docs/releases/0.59.1.md)

### Fixes

- fix: adopt nm_js2wasm_* rename in #2807's new test + scale files (broken main) ([PR 2285](https://github.com/loopdive/js2/pull/2285))
- fix(#2808): for-of object-binding head recurses into nested sub-patterns ([PR 2286](https://github.com/loopdive/js2/pull/2286))
- fix(#2807): chunk WASI fd_write below wasmtime's ~128 MiB single-write cap ([PR 2283](https://github.com/loopdive/js2/pull/2283))
- fix(#2769): for-of typed in-bounds undefined/hole default-init ([PR 2281](https://github.com/loopdive/js2/pull/2281))
- fix(#2758): eager-box caller-scope captures mutated by a called sibling (dstr init-skipped) ([PR 2279](https://github.com/loopdive/js2/pull/2279))

## v0.59.2 - 2026-06-29

- Tag `v0.59.2` · range `v0.59.1..v0.59.2` · [compare](https://github.com/loopdive/js2/compare/v0.59.1...v0.59.2)
- 6 merged PRs: 0 features, 3 fixes, 3 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,841 / 43,135 (76.1 %).
- Release notes: [docs/releases/0.59.2.md](docs/releases/0.59.2.md)

### Fixes

- fix(#2814): re-chunk ALL Native-Messaging hosts to <=1 MiB JSON frames ([PR 2294](https://github.com/loopdive/js2/pull/2294))
- fix(#2815): suppress spurious 'Cannot find name Deno' on recognized stdio surface ([PR 2292](https://github.com/loopdive/js2/pull/2292))
- fix(#2811): capture/globalize builtin-named vars + dstr-param closure TDZ-flag offset ([PR 2289](https://github.com/loopdive/js2/pull/2289))

## v0.59.3 - 2026-06-29

- Tag `v0.59.3` · range `v0.59.2..v0.59.3` · [compare](https://github.com/loopdive/js2/compare/v0.59.2...v0.59.3)
- 9 merged PRs: 0 features, 6 fixes, 3 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,847 / 43,135 (76.1 %).
- Release notes: [docs/releases/0.59.3.md](docs/releases/0.59.3.md)

### Fixes

- fix(#2817): skip dead env.__wasiStdinStop host import under --target wasi ([PR 2302](https://github.com/loopdive/js2/pull/2302))
- fix(#2816): NM smoke scale-test expects stripped CLI output name ([PR 2304](https://github.com/loopdive/js2/pull/2304))
- fix(#2821): harden deno-stdio test EPIPE flake via stdin file fd ([PR 2298](https://github.com/loopdive/js2/pull/2298))
- fix(#2816): default CLI output dir to cwd, strip source extension ([PR 2297](https://github.com/loopdive/js2/pull/2297))
- fix(#2820): reuse block-let pre-hoisted slot for non-CPS hoisted-fn captures (Bug C) ([PR 2293](https://github.com/loopdive/js2/pull/2293))
- fix(#2726): sloppy delete of unresolvable identifier returns true (group a) ([PR 2296](https://github.com/loopdive/js2/pull/2296))

## v0.59.4 - 2026-06-29

- Tag `v0.59.4` · range `v0.59.3..v0.59.4` · [compare](https://github.com/loopdive/js2/compare/v0.59.3...v0.59.4)
- 6 merged PRs: 1 feature, 3 fixes, 2 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,873 / 43,135 (76.2 %).
- Release notes: [docs/releases/0.59.4.md](docs/releases/0.59.4.md)

### Features

- feat(#2827): statusline + dashboard render sprint:current window (finish #2751) ([PR 2305](https://github.com/loopdive/js2/pull/2305))

### Fixes

- fix(#2832): bound nm_js2wasm_node_process read-side memory (streaming re-chunk) ([PR 2309](https://github.com/loopdive/js2/pull/2309))
- fix(#2828): ship examples/ in the npm tarball ([PR 2308](https://github.com/loopdive/js2/pull/2308))
- fix(#2809): undefined[] externref representation — finish Sites C+D (acorn arguments milestone) ([PR 2301](https://github.com/loopdive/js2/pull/2301))

## v0.59.5 - 2026-06-29

- Tag `v0.59.5` · range `v0.59.4..v0.59.5` · [compare](https://github.com/loopdive/js2/compare/v0.59.4...v0.59.5)
- 14 merged PRs: 1 feature, 8 fixes, 5 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 33,017 / 43,135 (76.5 %).
- Release notes: [docs/releases/0.59.5.md](docs/releases/0.59.5.md)

### Features

- perf(#2835): pack ArrayBuffer/DataView byte buffer as array(mut i8) — 4× smaller GC footprint ([PR 2324](https://github.com/loopdive/js2/pull/2324))

### Fixes

- fix(#2840): exclude module-scope Uint8Array from #1886 linear analysis (.ts-direct nm_node_process) ([PR 2323](https://github.com/loopdive/js2/pull/2323))
- fix(#2839): externref→vec materializer i8/i16 coerce + WASI native reader (#2311 regression) ([PR 2321](https://github.com/loopdive/js2/pull/2321))
- fix(#2838): L3 — wasmClosureBridge method-this arity fallback ([PR 2319](https://github.com/loopdive/js2/pull/2319))
- fix(#2837): route growable object literals to externref $Object (no more dropped out-of-shape writes) ([PR 2318](https://github.com/loopdive/js2/pull/2318))
- fix(#2836): gate host-shim vec conversion on __is_vec — arrow params on compiled acorn ([PR 2317](https://github.com/loopdive/js2/pull/2317))
- fix(#2834): make nm_js2wasm_node_process node-runnable via stdin setEncoding ([PR 2315](https://github.com/loopdive/js2/pull/2315))
- fix(#2833): add .ts extension to native-messaging relative imports ([PR 2312](https://github.com/loopdive/js2/pull/2312))
- fix(#2831): host-externref→wasm-vec materializer for dynamic vec-field writes ([PR 2311](https://github.com/loopdive/js2/pull/2311))

## v0.60.0 - 2026-07-05

- Tag `v0.60.0` · range `v0.59.5..v0.60.0` · [compare](https://github.com/loopdive/js2/compare/v0.59.5...v0.60.0)
- 403 merged PRs: 92 features, 159 fixes, 152 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,472 / 43,106 (75.3 %).

### Features

- feat(#3057): runtime-kind byte codec for dynamic $__ta_dyn_view element get/set ([PR 2741](https://github.com/loopdive/js2/pull/2741))
- feat(#3054 D+E): dynamic new <ctorVar>(rab) + resizable-ctors harness shim ([PR 2740](https://github.com/loopdive/js2/pull/2740))
- feat(#3054 C): resizable ArrayBuffer via $__resizable_ab WasmGC subtype ([PR 2739](https://github.com/loopdive/js2/pull/2739))
- feat(#3054 B3): proto-method write-through on TypedArray view receivers ([PR 2738](https://github.com/loopdive/js2/pull/2738))
- feat(#3054 B2): TypedArray view accessor props + windowing constructor ([PR 2737](https://github.com/loopdive/js2/pull/2737))
- feat(#3054 B1): shared-backing TypedArray/DataView views over ArrayBuffer ([PR 2736](https://github.com/loopdive/js2/pull/2736))
- feat(#3053): U2 — open the IR scan for dynamic member/element reads (the claim-flip) ([PR 2730](https://github.com/loopdive/js2/pull/2730))
- feat(#3053): U1 — wire __dyn_member_get into the IR member-read path (byte-inert-off-path) ([PR 2729](https://github.com/loopdive/js2/pull/2729))
- feat(#3053): U0 — byte-inert __dyn_member_get carrier substrate helper ([PR 2728](https://github.com/loopdive/js2/pull/2728))
- feat(#3051): IR class.call — void instance method in statement position ([PR 2721](https://github.com/loopdive/js2/pull/2721))
- feat(#2949 S5.3): dynamic numeric-abstract relational lowering (byte-inert) ([PR 2702](https://github.com/loopdive/js2/pull/2702))
- feat(website): move benchmarks to a dedicated performance page ([PR 2699](https://github.com/loopdive/js2/pull/2699))
- feat(#2949 S5.2): dynamic strict/loose equality lowering (byte-inert) ([PR 2694](https://github.com/loopdive/js2/pull/2694))
- feat(#2949 S5.1): dynamic-value truthiness lowering (byte-inert mechanism slice) ([PR 2690](https://github.com/loopdive/js2/pull/2690))
- feat(#2906): async-generator for-await CONSUMER — host-free 3d-ii drive ([PR 2678](https://github.com/loopdive/js2/pull/2678))
- feat(#2949 S5.0): builder emit plumbing for dynamic box/unbox/tag.test ([PR 2682](https://github.com/loopdive/js2/pull/2682))
- feat(#3000-E): IR inheritance/super emission — classes.ts fully IR ([PR 2675](https://github.com/loopdive/js2/pull/2675))
- feat(#2906): async-generator producer core — host-free settleYield drive (slice 3d-i) ([PR 2669](https://github.com/loopdive/js2/pull/2669))
- feat(#2933): standalone fixed-arity Reflect.* static-method value reads ([PR 2668](https://github.com/loopdive/js2/pull/2668))
- feat(#3000-C): IR constructor emission for flat classes ([PR 2662](https://github.com/loopdive/js2/pull/2662))
- …and 72 more feature PRs (newest 20 shown; see the compare link).

### Fixes

- fix(#1524): test262 byteConversionValues + TA constructor-list harness globals ([PR 2732](https://github.com/loopdive/js2/pull/2732))
- fix(#3045): materialize class-expression constructor value into its binding ([PR 2719](https://github.com/loopdive/js2/pull/2719))
- fix(#3051): RegExp @@replace/@@split arg + flag coercion (Slice 2) ([PR 2727](https://github.com/loopdive/js2/pull/2727))
- fix(#3051): host-wrap RegExp exec-override result for @@replace/@@split coercion ([PR 2723](https://github.com/loopdive/js2/pull/2723))
- fix(#3037): CS1b(ii) element-access object-identity carrier (standalone) ([PR 2713](https://github.com/loopdive/js2/pull/2713))
- fix(#3048): register __make_getter_callback for object-literal accessor/method shapes ([PR 2716](https://github.com/loopdive/js2/pull/2716))
- fix(#3046): bind JSON.parse reviver this to the holder ([PR 2715](https://github.com/loopdive/js2/pull/2715))
- fix(#3047): var/function same-name coexistence at var-scope top level ([PR 2714](https://github.com/loopdive/js2/pull/2714))
- fix(#3042): value-less defineProperty defaults widened field to undefined ([PR 2711](https://github.com/loopdive/js2/pull/2711))
- fix(#3044): stop Math.<inherited-method>() crashing codegen (op.endsWith) ([PR 2710](https://github.com/loopdive/js2/pull/2710))
- …and 149 more fix PRs (newest 10 shown; see the compare link).

## v0.60.1 - 2026-07-06

- Tag `v0.60.1` · range `v0.60.0..v0.60.1` · [compare](https://github.com/loopdive/js2/compare/v0.60.0...v0.60.1)
- 16 merged PRs: 3 features, 5 fixes, 8 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,513 / 43,106 (75.4 %).

### Features

- feat(#3058): resizable-TA read proto-methods over dynamic $__ta_dyn_view (Bucket A first slice) ([PR 2759](https://github.com/loopdive/js2/pull/2759))
- feat(#3065): IR claim non-terminating if-guard at non-void body position ([PR 2758](https://github.com/loopdive/js2/pull/2758))
- feat(#2858): IR call-graph-closure bucket → 0 (host-mode caller-arm relaxation) ([PR 2752](https://github.com/loopdive/js2/pull/2752))

### Fixes

- fix(#3064): pure-Wasm escape() / unescape() for standalone/WASI ([PR 2756](https://github.com/loopdive/js2/pull/2756))
- fix(#3062): compute DataView.byteLength/byteOffset natively in JS-host mode ([PR 2754](https://github.com/loopdive/js2/pull/2754))
- fix(#3063): implement legacy global escape() / unescape() in JS-host mode ([PR 2755](https://github.com/loopdive/js2/pull/2755))
- fix(#3061): compute ArrayBuffer.byteLength/byteOffset natively in JS-host mode ([PR 2753](https://github.com/loopdive/js2/pull/2753))
- fix(#2726): clear mapped-arguments slot on delete arguments[i] (group e) ([PR 2748](https://github.com/loopdive/js2/pull/2748))

## v0.61.0 - 2026-07-18

- Tag `v0.61.0` · range `v0.60.1..v0.61.0` · [compare](https://github.com/loopdive/js2/compare/v0.60.1...v0.61.0)
- 550 merged PRs: 81 features, 243 fixes, 226 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 25,003 / 43,106 (58.0 %).
- Release notes: [docs/releases/0.61.0.md](docs/releases/0.61.0.md)

### Features

- feat(test262): make original harness authoritative ([PR 3267](https://github.com/loopdive/js2/pull/3267))
- feat(#3390): drive non-constructor Promise-combinator .call receivers to native TypeError (standalone) ([PR 3329](https://github.com/loopdive/js2/pull/3329))
- feat(#3388): async-gen yield* runtime delegation (nested/method producers, standalone) ([PR 3332](https://github.com/loopdive/js2/pull/3332))
- feat(#802): dynamic prototype for class instances (Slices B+C, standalone) ([PR 3321](https://github.com/loopdive/js2/pull/3321))
- feat(#2570): lazy yield* delegation on the driven async-generator machine ([PR 3312](https://github.com/loopdive/js2/pull/3312))
- feat(porffor): prove shared heap layouts (#3299) ([PR 3263](https://github.com/loopdive/js2/pull/3263))
- feat(ir): extract target-neutral linear memory plan ([PR 3245](https://github.com/loopdive/js2/pull/3245))
- feat(#1044): ambient global Buffer typing under --emulate node ([PR 3233](https://github.com/loopdive/js2/pull/3233))
- feat(#1792): node:url URL / URLSearchParams as host constructors ([PR 3217](https://github.com/loopdive/js2/pull/3217))
- feat(linear-ir): enable selector overlay by default (#2956) ([PR 3232](https://github.com/loopdive/js2/pull/3232))
- feat(#3101): E1 standalone bytecode interpreter library + ADR-0019 ([PR 3218](https://github.com/loopdive/js2/pull/3218))
- feat(linear-ir): lower selector-claimed strings ([PR 3203](https://github.com/loopdive/js2/pull/3203))
- feat(linear-ir): lower aggregate and ref-cell layouts ([PR 3200](https://github.com/loopdive/js2/pull/3200))
- feat(porffor): prove scalar control flow through Porffor C ([PR 3198](https://github.com/loopdive/js2/pull/3198))
- feat(#1795): node:http/https GET round-trip (axios unblocker) + fix(#3329) shared-capture cell unification ([PR 3193](https://github.com/loopdive/js2/pull/3193))
- feat(ir): #3142 slice 2 — module-init lowering + __module_init slot patch (gate G3) ([PR 3168](https://github.com/loopdive/js2/pull/3168))
- feat(#2956 L2): vec mutation (element store + push) through the linear-IR overlay ([PR 3179](https://github.com/loopdive/js2/pull/3179))
- feat(#1794): node:events EventEmitter — host class + closure-callback contract (Tier 0) ([PR 3175](https://github.com/loopdive/js2/pull/3175))
- feat(#745): S4 — union params/returns + any-boundary on the $AnyValue carrier ([PR 3171](https://github.com/loopdive/js2/pull/3171))
- feat(#745): S3 — carrier-agnostic strict-eq / truthiness / concat for $AnyValue union locals ([PR 3169](https://github.com/loopdive/js2/pull/3169))
- …and 61 more feature PRs (newest 20 shown; see the compare link).

### Fixes

- fix(ci): align Test262 pool with published baseline ([PR 3363](https://github.com/loopdive/js2/pull/3363))
- fix(#3395 shape 2): Weak-collection typed-null → valid Wasm (child of #2039) ([PR 3343](https://github.com/loopdive/js2/pull/3343))
- fix(#2872): slice 5 — standalone findLast/findLastIndex host-free (dyn-view two-arm + scalar-HOF any-receiver decline + __hof_* S1 undefined singleton) ([PR 3342](https://github.com/loopdive/js2/pull/3342))
- fix(#3394): box i64/bigint at externref boundaries — invalid Wasm (child of #2039) ([PR 3341](https://github.com/loopdive/js2/pull/3341))
- fix(#2875): reflective String proto non-string ToString — box-struct ordering + trim flatten (standalone) ([PR 3339](https://github.com/loopdive/js2/pull/3339))
- fix(#739): host-lane representation pinning for runtime-store defines (S1) ([PR 3317](https://github.com/loopdive/js2/pull/3317))
- fix(#3379): baseline-sync staleness guard must measure public/, not the in-repo copy (follow-up to #3375) ([PR 3298](https://github.com/loopdive/js2/pull/3298))
- fix(#3384): unwrap wrapped JSON.parse call before reading .arguments (standalone/wasi crash) ([PR 3295](https://github.com/loopdive/js2/pull/3295))
- fix(#2961): warning-first standalone host-import leak scan (phase 1) ([PR 3288](https://github.com/loopdive/js2/pull/3288))
- fix(#2728): Object(Symbol()) boxes to a Symbol-wrapper object ([PR 3275](https://github.com/loopdive/js2/pull/3275))
- …and 233 more fix PRs (newest 10 shown; see the compare link).

## v0.62.0 - 2026-07-19

- Tag `v0.62.0` · range `v0.61.0..v0.62.0` · [compare](https://github.com/loopdive/js2/compare/v0.61.0...v0.62.0)
- 28 merged PRs: 5 features, 8 fixes, 15 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 27,827 / 43,106 (64.6 %).

### Features

- perf(test262): rebalance shard weight maps from post-#3374 timings (#3438) ([PR 3377](https://github.com/loopdive/js2/pull/3377))
- feat(#3251): S1 array-descriptor overlay substrate — companion $Object per vec receiver (standalone) ([PR 3327](https://github.com/loopdive/js2/pull/3327))
- feat(hooks): pre-push LOC-regrowth ratchet check — catch #3102/#3131 locally before CI ([PR 3355](https://github.com/loopdive/js2/pull/3355))
- perf(#3433): memoize per-call full-file assignment scans — 2.6-3.8x faster test262 v8 harness compiles ([PR 3374](https://github.com/loopdive/js2/pull/3374))
- feat(ir): prove shared allocation-policy leverage (#3300) ([PR 3287](https://github.com/loopdive/js2/pull/3287))

### Fixes

- fix(release): bump jsr.json in lockstep (JSR was silently frozen at 0.60.1) ([PR 3384](https://github.com/loopdive/js2/pull/3384))
- fix(#3387): drive nested async-gen for-await destructuring heads host-free (standalone) ([PR 3322](https://github.com/loopdive/js2/pull/3322))
- fix(#3436): eliminate standalone harness-prelude import leak ([PR 3369](https://github.com/loopdive/js2/pull/3369))
- fix(#3395 shape 3): mixed == string-ToNumber redundant extern.convert_any (child of #2039) ([PR 3345](https://github.com/loopdive/js2/pull/3345))
- fix(#3428): observe test262 async completion marker in the host lane ([PR 3372](https://github.com/loopdive/js2/pull/3372))
- fix(#3419): duplicate function declarations — spec-correct early errors + last-wins codegen + var-counter i32 gate ([PR 3368](https://github.com/loopdive/js2/pull/3368))
- fix(#3427): dedupe duplicate top-level harness function declarations (isPrimitive) ([PR 3366](https://github.com/loopdive/js2/pull/3366))
- fix(test262): quarantine proven same-SHA host noise ([PR 3367](https://github.com/loopdive/js2/pull/3367))

## v0.63.0 - 2026-07-19

- Tag `v0.63.0` · range `v0.62.0..v0.63.0` · [compare](https://github.com/loopdive/js2/compare/v0.62.0...v0.63.0)
- 39 merged PRs: 6 features, 19 fixes, 14 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 27,834 / 43,106 (64.6 %).

### Features

- feat(#745 S4.5): flip unionAnyRep lane-default ON for native-string lanes ([PR 3409](https://github.com/loopdive/js2/pull/3409))
- feat(#3461): productionize native-harness FAST oracle (host lane) ([PR 3399](https://github.com/loopdive/js2/pull/3399))
- feat(#1373b C-1): IR async Phase C — claim the sync-pass-through population on the one-engine consistency gate ([PR 3350](https://github.com/loopdive/js2/pull/3350))
- feat(#2662): lazy capturing-nested generators on the gc/host lane ([PR 3335](https://github.com/loopdive/js2/pull/3335))
- feat(#2963 Tier 2a): wire Number.is* first-class values (standalone) ([PR 3359](https://github.com/loopdive/js2/pull/3359))
- feat(#2917): standalone native 'class Sub extends Array' + extends-Object own-field fix (slice 1) ([PR 3324](https://github.com/loopdive/js2/pull/3324))

### Fixes

- fix(#3471): gate body-usage param inference on zero call sites (unsound f64 narrowing broke isSameValue → ~433 name/length tests) ([PR 3419](https://github.com/loopdive/js2/pull/3419))
- fix(#3469): standalone host-free console/print output sink + async drain gate ([PR 3416](https://github.com/loopdive/js2/pull/3416))
- fix(#3470): restore host-builtin method .name/.length sub-properties between test262 runs ([PR 3417](https://github.com/loopdive/js2/pull/3417))
- fix(#3435): Function-typed dynamic ctor params route through __construct_closure (stacked on #3370) ([PR 3375](https://github.com/loopdive/js2/pull/3375))
- fix(#3389 slice 2): async-gen .return()/.throw() consumer methods [DRAFT — held pending #3344] ([PR 3390](https://github.com/loopdive/js2/pull/3390))
- fix(#3408): retire non-atomic issue-ID entrypoints in favor of the atomic allocator ([PR 3406](https://github.com/loopdive/js2/pull/3406))
- fix(#3407): guard test262 fixture runner inner catch against duplicate/contradictory verdict rows ([PR 3405](https://github.com/loopdive/js2/pull/3405))
- fix(#2787): capture async console.log in diff-test harness (corpus 96→99 match) ([PR 3402](https://github.com/loopdive/js2/pull/3402))
- fix(#802): promote object-literal proto receivers to $Object (slice A) ([PR 3318](https://github.com/loopdive/js2/pull/3318))
- fix(#3410): close legacy-origin bypass in the private-labs pre-push guard ([PR 3401](https://github.com/loopdive/js2/pull/3401))
- …and 9 more fix PRs (newest 10 shown; see the compare link).

## v0.64.0 - 2026-07-21

- Tag `v0.64.0` · range `v0.63.0..v0.64.0` · [compare](https://github.com/loopdive/js2/compare/v0.63.0...v0.64.0) · also tagged `sprint-74/begin`, `sprint/73`
- 45 merged PRs: 6 features, 20 fixes, 19 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 29,482 / 43,106 (68.4 %).

### Features

- feat(ir): add a bounded multi-module overlay ([PR 3464](https://github.com/loopdive/js2/pull/3464))
- feat(ir): compile the builtins example through IR ([PR 3463](https://github.com/loopdive/js2/pull/3463))
- feat(#3481): host BigInt binop delegation for wrapper coercion (prereq for #3328 flip) ([PR 3458](https://github.com/loopdive/js2/pull/3458))
- feat(ir): share module bindings across front-ends ([PR 3457](https://github.com/loopdive/js2/pull/3457))
- feat(ir): lower shared string build and methods (#3502) ([PR 3453](https://github.com/loopdive/js2/pull/3453))
- feat(benchmarks): add landing four-lane backend evidence (#3498) ([PR 3452](https://github.com/loopdive/js2/pull/3452))

### Fixes

- fix(test262): close FYI parity follow-up gaps ([PR 3456](https://github.com/loopdive/js2/pull/3456))
- fix(#3512): stop instance fields leaking as own props of the class constructor (#3479 Slice C) ([PR 3462](https://github.com/loopdive/js2/pull/3462))
- fix(#3511): symbol-safe array-index probe for dynamic-any element access (~40 host flips) ([PR 3461](https://github.com/loopdive/js2/pull/3461))
- fix(#3488): route reflective gOPD().get callees through the host-callable arm ([PR 3460](https://github.com/loopdive/js2/pull/3460))
- fix(ci): remove redundant landing benchmark separators ([PR 3454](https://github.com/loopdive/js2/pull/3454))
- fix(test262): align FYI and project harness verdicts ([PR 3420](https://github.com/loopdive/js2/pull/3420))
- fix(#3468): add capturing-closure own-property side table ([PR 3418](https://github.com/loopdive/js2/pull/3418))
- fix(ir): infer typed vectors for empty arrays (#3501) ([PR 3451](https://github.com/loopdive/js2/pull/3451))
- fix(ir): certify recursive linear call-graph types ([PR 3448](https://github.com/loopdive/js2/pull/3448))
- fix(ir): lower typed bitwise composites to Porffor (#3499) ([PR 3447](https://github.com/loopdive/js2/pull/3447))
- …and 10 more fix PRs (newest 10 shown; see the compare link).

## v0.64.1 - 2026-07-21

- Tag `v0.64.1` · range `v0.64.0..v0.64.1` · [compare](https://github.com/loopdive/js2/compare/v0.64.0...v0.64.1)
- 3 merged PRs: 0 features, 1 fix, 2 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 29,482 / 43,106 (68.4 %).

### Fixes

- fix(test262): handle absent trap baselines as unknown ([PR 3468](https://github.com/loopdive/js2/pull/3468))

## v0.65.0 - 2026-07-21

- Tag `v0.65.0` · range `v0.64.1..v0.65.0` · [compare](https://github.com/loopdive/js2/compare/v0.64.1...v0.65.0)
- 20 merged PRs: 7 features, 7 fixes, 6 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 30,272 / 43,096 (70.2 %).

### Features

- feat(ir): complete the typed R0 migration boundary ([PR 3483](https://github.com/loopdive/js2/pull/3483))
- feat(ir): claim exact generic Map module init ([PR 3479](https://github.com/loopdive/js2/pull/3479))
- feat(ir): lower ambient void event callbacks ([PR 3475](https://github.com/loopdive/js2/pull/3475))
- feat(ir): lower imported higher-order calls ([PR 3473](https://github.com/loopdive/js2/pull/3473))
- perf(ci): saturate the serial merge queue ([PR 3472](https://github.com/loopdive/js2/pull/3472))
- perf(ci): rebalance Test262 and reduce pipeline overhead ([PR 3470](https://github.com/loopdive/js2/pull/3470))
- feat(ir): canonicalize callable boundary ABI ([PR 3466](https://github.com/loopdive/js2/pull/3466))

### Fixes

- fix(ir): preserve boolean identity at extern boundaries ([PR 3486](https://github.com/loopdive/js2/pull/3486))
- fix(#1907): standalone BigInt64Array/BigUint64Array .prototype value read host-free ([PR 3485](https://github.com/loopdive/js2/pull/3485))
- fix(#3409): portable pre-push format-gate watchdog (no GNU timeout dep) ([PR 3482](https://github.com/loopdive/js2/pull/3482))
- fix(ir): finish function body-shape migration to zero ([PR 3477](https://github.com/loopdive/js2/pull/3477))
- fix(ci): cancel Test262 when merge-group quality fails ([PR 3478](https://github.com/loopdive/js2/pull/3478))
- fix(ci): stop polling for missing Test262 baselines ([PR 3476](https://github.com/loopdive/js2/pull/3476))
- fix(release): keep js2wasm dependency in lockstep ([PR 3469](https://github.com/loopdive/js2/pull/3469))

## v0.66.0 - 2026-07-24

- Tag `v0.66.0` · range `v0.65.0..v0.66.0` · [compare](https://github.com/loopdive/js2/compare/v0.65.0...v0.66.0)
- 76 merged PRs: 9 features, 41 fixes, 26 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 30,364 / 43,102 (70.4 %).

### Features

- feat(#3177): standalone %TypedArray%.of / .from statics (slice 5) ([PR 3546](https://github.com/loopdive/js2/pull/3546))
- feat(#3400): R-FUNC per-function LOC-ceiling ratchet (check:func-budget) ([PR 3540](https://github.com/loopdive/js2/pull/3540))
- feat(#3474): done-status integrity gate + audit (Part B) ([PR 3541](https://github.com/loopdive/js2/pull/3541))
- feat(#3437): deterministic pre-merge test262 harness compile-time budget gate ([PR 3536](https://github.com/loopdive/js2/pull/3536))
- feat(#2906 3c-iii): nested try/catch regions — recursive region-body producer, static handler tagging ([PR 3527](https://github.com/loopdive/js2/pull/3527))
- feat(#2906 3c-ii-b): combined try/catch/finally regions — two-region model, producer-only ([PR 3526](https://github.com/loopdive/js2/pull/3526))
- feat(#2906 3c-ii-a): return-through-finally + sibling try/catch regions ([PR 3524](https://github.com/loopdive/js2/pull/3524))
- feat(#2906 3c-i): try/catch-around-await drives — catch regions as states + routed dispatcher ([PR 3522](https://github.com/loopdive/js2/pull/3522))
- feat(#2864 D2): yield* delegation abrupt forwarding + dedicated self-suspend states ([PR 3519](https://github.com/loopdive/js2/pull/3519))

### Fixes

- fix(#3340): keep inverted expected-failure sentinels out of the root baseline ([PR 3569](https://github.com/loopdive/js2/pull/3569))
- fix(#3460): unmatched typed-callable host-read direct-call → catchable TypeError, not null-deref trap ([PR 3564](https://github.com/loopdive/js2/pull/3564))
- fix(#3024): coerce module-global writes to slot type — object-literal runtime-computed-key + for-of array-rest desync ([PR 3558](https://github.com/loopdive/js2/pull/3558))
- fix(#3200): flatMap non-callable mapper → TypeError (§23.1.3.11 step 3) ([PR 3560](https://github.com/loopdive/js2/pull/3560))
- fix(#3378): don't capture member/property names as free variables (deepEqual.js stale-local crash) ([PR 3559](https://github.com/loopdive/js2/pull/3559))
- fix(#3201): slice explicit-undefined end coerces to len; re-scope Array residue ([PR 3561](https://github.com/loopdive/js2/pull/3561))
- fix(#1325): host-free instanceof Promise in standalone (distinct $Promise struct) ([PR 3556](https://github.com/loopdive/js2/pull/3556))
- fix(#3573): Set/Map.forEach non-callable guard + Symbol.matchAll drift (standalone) ([PR 3555](https://github.com/loopdive/js2/pull/3555))
- fix(#3572): native WeakMap/WeakSet iterable constructor (standalone) ([PR 3554](https://github.com/loopdive/js2/pull/3554))
- fix(#3569): well-formed surrogate escaping in standalone JSON.stringify ([PR 3553](https://github.com/loopdive/js2/pull/3553))
- …and 31 more fix PRs (newest 10 shown; see the compare link).

## v0.67.0 - 2026-07-31

- Tag `v0.67.0` · range `v0.66.0..v0.67.0` · [compare](https://github.com/loopdive/js2/compare/v0.66.0...v0.67.0)
- 269 merged PRs: 72 features, 104 fixes, 93 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 29,856 / 43,099 (69.3 %).

### Features

- feat(npm-compat): add sixteen package harnesses ([PR 3847](https://github.com/loopdive/js2/pull/3847))
- perf: restore WASI warm array and string fast paths ([PR 3844](https://github.com/loopdive/js2/pull/3844))
- feat(ir): prepare bounded free functions before direct bodies ([PR 3841](https://github.com/loopdive/js2/pull/3841))
- feat(ir): prove prepared component binding ownership ([PR 3845](https://github.com/loopdive/js2/pull/3845))
- feat(runtime): bind host data bridges to genuine instances ([PR 3840](https://github.com/loopdive/js2/pull/3840))
- feat(ir): derive prepared component dependencies ([PR 3842](https://github.com/loopdive/js2/pull/3842))
- feat(ir): preclaim stable this-bound function calls ([PR 3839](https://github.com/loopdive/js2/pull/3839))
- feat(ir): add strict dynamic member stores ([PR 3832](https://github.com/loopdive/js2/pull/3832))
- feat(dogfood): add React upstream API vectors ([PR 3835](https://github.com/loopdive/js2/pull/3835))
- perf(ir): keep Fibonacci state in native i32 ([PR 3819](https://github.com/loopdive/js2/pull/3819))
- feat(ir): dispatch dynamic RegExp string replacement ([PR 3830](https://github.com/loopdive/js2/pull/3830))
- feat(ir): add sealed prepared-program core ([PR 3828](https://github.com/loopdive/js2/pull/3828))
- feat(ir): emit retained Acorn parser wrappers ([PR 3826](https://github.com/loopdive/js2/pull/3826))
- feat(ir): bridge standalone native RegExp tests (#3791) ([PR 3823](https://github.com/loopdive/js2/pull/3823))
- feat(ir): lower dynamic parser loops through IR ([PR 3820](https://github.com/loopdive/js2/pull/3820))
- feat(npm-compat): add standalone lanes and package dashboard ([PR 3821](https://github.com/loopdive/js2/pull/3821))
- perf(benchmarks): move auxiliary refreshes post-merge ([PR 3818](https://github.com/loopdive/js2/pull/3818))
- feat(ir): support mutable dynamic parameter slots ([PR 3816](https://github.com/loopdive/js2/pull/3816))
- feat(benchmarks): refresh complete performance baselines ([PR 3812](https://github.com/loopdive/js2/pull/3812))
- feat(npm-compat): add ESLint and relative speed history ([PR 3813](https://github.com/loopdive/js2/pull/3813))
- …and 52 more feature PRs (newest 20 shown; see the compare link).

### Fixes

- fix(runtime): compile React element APIs correctly ([PR 3843](https://github.com/loopdive/js2/pull/3843))
- fix(codegen): preserve this for stable named .call targets ([PR 3838](https://github.com/loopdive/js2/pull/3838))
- fix(ir): preserve counted string aggregation ([PR 3837](https://github.com/loopdive/js2/pull/3837))
- fix(pages): resolve benchmark timing source ([PR 3834](https://github.com/loopdive/js2/pull/3834))
- fix(benchmarks): stabilize CI timing and promotion ([PR 3833](https://github.com/loopdive/js2/pull/3833))
- fix(npm-compat): keep package cards visible ([PR 3817](https://github.com/loopdive/js2/pull/3817))
- fix(ci #3788): deploy Pages after Refresh Benchmarks, not just on push ([PR 3815](https://github.com/loopdive/js2/pull/3815))
- fix(bench #3785): keep the timing wrapper out of the benchmark it times ([PR 3806](https://github.com/loopdive/js2/pull/3806))
- fix(ir #3784): type the no-box number-local gate so it demotes instead of hard-failing ([PR 3805](https://github.com/loopdive/js2/pull/3805))
- fix(#3663): preserve inherited descriptor flags ([PR 3749](https://github.com/loopdive/js2/pull/3749))
- …and 94 more fix PRs (newest 10 shown; see the compare link).

### Carried over from the former Unreleased section: Added: reusable `FyiSourceExecutor` for external test262 integrations (#3599)

- `FyiSourceExecutor` and `runTest` are now exported from the new
  `@loopdive/js2/test262-fyi` subpath (added to `package.json`'s `exports`
  map — this subpath was previously unreachable via `import`, even though
  `js2-test262` shipped as a bin). `executeTestFile({ ..., executor })` now
  accepts an optional pre-existing executor: an external caller that runs
  many test files in one long-lived process (e.g. a persistent server) can
  reuse a single warm executor across many calls instead of paying a fresh
  Node start + full compiler-module load per call. Omitting `executor`
  preserves the exact prior one-shot behavior.
- Fixed a real bug this surfaced: `FyiSourceExecutor`'s default `workerPath`
  resolved to a `scripts/` path that only exists in the monorepo checkout,
  not in the published package — `new FyiSourceExecutor()` with no explicit
  `workerPath` threw `Cannot find module '.../scripts/test262-worker.mjs'`
  when called from outside this repo. It now resolves lazily next to its own
  module location, matching the (already-correct) logic `js2-test262`'s CLI
  entry point used internally.

## v0.68.0 - 2026-08-04

- Tag `v0.68.0` · range `v0.67.0..v0.68.0` · [compare](https://github.com/loopdive/js2/compare/v0.67.0...v0.68.0)
- 239 merged PRs: 34 features, 98 fixes, 107 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 30,982 / 43,505 (71.2 %).
- Release notes: [docs/release-notes/v0.68.0.md](docs/release-notes/v0.68.0.md)

### Features

- feat(website): scope-reactive trend graphs + report-page edition sparklines ([PR 4104](https://github.com/loopdive/js2/pull/4104))
- perf(arrays): keep affine indices in i32 ([PR 4069](https://github.com/loopdive/js2/pull/4069))
- feat(eval): route standalone eval and Function through bytecode interpreter ([PR 4013](https://github.com/loopdive/js2/pull/4013))
- feat(ir): retire prepared class methods and accessors ([PR 4081](https://github.com/loopdive/js2/pull/4081))
- feat(#4127): give npm-compat a named correctness axis — cookie is divergent, not compatible ([PR 4080](https://github.com/loopdive/js2/pull/4080))
- perf(strings): scalarize nested static splits ([PR 4067](https://github.com/loopdive/js2/pull/4067))
- perf(strings): scalarize derived host results ([PR 4066](https://github.com/loopdive/js2/pull/4066))
- feat(ir): migrate final async terminal owners ([PR 4065](https://github.com/loopdive/js2/pull/4065))
- perf(#4122): an unresolvable assignment is not a cross-domain one — method axis 3.6x, plus #4121/#4123 ([PR 4064](https://github.com/loopdive/js2/pull/4064))
- perf(compiler): close benchmark parity gaps ([PR 4062](https://github.com/loopdive/js2/pull/4062))
- feat(ir): compile Promise.all continuations through IR ([PR 4059](https://github.com/loopdive/js2/pull/4059))
- feat(ir): emit single-await async functions from prepared plans ([PR 4050](https://github.com/loopdive/js2/pull/4050))
- feat(ir): consume async runtime plans before ABI sealing ([PR 4049](https://github.com/loopdive/js2/pull/4049))
- feat(ir): plan module initialization before body emission ([PR 4036](https://github.com/loopdive/js2/pull/4036))
- feat(ir): route certified Math calls through semantic intrinsics ([PR 4041](https://github.com/loopdive/js2/pull/4041))
- feat(ir): compile flat scalar instance methods once ([PR 4040](https://github.com/loopdive/js2/pull/4040))
- feat(#4094): derive enqueue eligibility from real signals, not the stale mergeStateStatus ([PR 4038](https://github.com/loopdive/js2/pull/4038))
- feat(ir): define fail-closed async suspension plan ([PR 4039](https://github.com/loopdive/js2/pull/4039))
- feat(ir): add frozen pure-math runtime manifest ([PR 4037](https://github.com/loopdive/js2/pull/4037))
- feat(#4035): gate the host-bridge export suite behind a hostBridge policy ([PR 4002](https://github.com/loopdive/js2/pull/4002))
- …and 14 more feature PRs (newest 20 shown; see the compare link).

### Fixes

- fix(#4098): per-instance own-property deletability — `delete o[k]` is real on a class instance (G1 stage 1) ([PR 4100](https://github.com/loopdive/js2/pull/4100))
- fix(hooks): pre-commit fast lane — prettier/biome unconditional, slow checks skippable ([PR 4102](https://github.com/loopdive/js2/pull/4102))
- fix(codegen): 12 compiler defects found compiling ESLint; 2 emit blockers remain (#4001, #4133, #4134 + 9 more) ([PR 4074](https://github.com/loopdive/js2/pull/4074))
- fix(editions): index every test262 file, closing the standalone count gap ([PR 4093](https://github.com/loopdive/js2/pull/4093))
- fix(#4010): S3 — own-property visibility over the carrier bags; the -684 isolated ([PR 4091](https://github.com/loopdive/js2/pull/4091))
- fix(#4061): Object.create descriptor-argument validation (§8.10.5) — 16/17, 0 regressions ([PR 4096](https://github.com/loopdive/js2/pull/4096))
- fix(codegen/ir): three defects blocking acorn on --target standalone ([PR 4088](https://github.com/loopdive/js2/pull/4088))
- fix(#4140): the npm-compat promote PUSH runs husky too — and the retry loop lied about why ([PR 4094](https://github.com/loopdive/js2/pull/4094))
- fix(#4141): heal poison rows under the shards' proposal scope; treat baseline `skip` as can't-testify ([PR 4095](https://github.com/loopdive/js2/pull/4095))
- fix(#4120): typeof of a reified builtin constructor answers "function" ([PR 4090](https://github.com/loopdive/js2/pull/4090))
- …and 88 more fix PRs (newest 10 shown; see the compare link).

## v0.69.0 - 2026-08-09

- Tag `v0.69.0` · range `v0.68.0..v0.69.0` · [compare](https://github.com/loopdive/js2/compare/v0.68.0...v0.69.0)
- 191 merged PRs: 62 features, 60 fixes, 69 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 31,651 / 43,505 (72.8 %).
- Release notes: [docs/release-notes/v0.69.0.md](docs/release-notes/v0.69.0.md)

### Features

- perf(array): batch numeric indexOf misses ([PR 4307](https://github.com/loopdive/js2/pull/4307))
- feat(ir): retire Builtins legacy bodies ([PR 4305](https://github.com/loopdive/js2/pull/4305))
- feat: ES5 standalone conformance — wave 5 (#4262 error substrate, #4264 `with` value carriers +30, #4265 callable ToString) ([PR 4302](https://github.com/loopdive/js2/pull/4302))
- feat: ES5 standalone — wave 5 follow-up (#4266 vec own-key enumeration +7, #4269 object-literal method receiver) ([PR 4299](https://github.com/loopdive/js2/pull/4299))
- perf(strings): elide empty concat allocations ([PR 4300](https://github.com/loopdive/js2/pull/4300))
- perf(runtime): collapse fixed host method call crossings ([PR 4293](https://github.com/loopdive/js2/pull/4293))
- perf(strings): inline constant-needle indexOf scans ([PR 4291](https://github.com/loopdive/js2/pull/4291))
- perf(strings): scalarize proven ASCII case conversions ([PR 4292](https://github.com/loopdive/js2/pull/4292))
- perf(runtime): streamline non-throwing leaf imports ([PR 4289](https://github.com/loopdive/js2/pull/4289))
- perf(strings): specialize proven rope concatenation ([PR 4287](https://github.com/loopdive/js2/pull/4287))
- feat(linear): add native String.repeat support ([PR 4286](https://github.com/loopdive/js2/pull/4286))
- perf(array): accelerate hot indexOf scans ([PR 4279](https://github.com/loopdive/js2/pull/4279))
- perf(strings): avoid integer format scratch allocation ([PR 4278](https://github.com/loopdive/js2/pull/4278))
- perf(strings): fuse native trim length scan ([PR 4277](https://github.com/loopdive/js2/pull/4277))
- perf(codegen): cache ambient host globals per instance ([PR 4275](https://github.com/loopdive/js2/pull/4275))
- feat(linear): cache literals and lower string searches ([PR 4274](https://github.com/loopdive/js2/pull/4274))
- feat: ES5 standalone conformance — wave 4 (#4246 this/new, #4247 array keys, #4248 wrapper protos, #4251 harness canary, #4252 computed-key calls) ([PR 4258](https://github.com/loopdive/js2/pull/4258))
- perf: speed up cookie host bridge and clsx arguments ([PR 4272](https://github.com/loopdive/js2/pull/4272))
- feat(website): npm-compat measured-at shows time, not only date ([PR 4266](https://github.com/loopdive/js2/pull/4266))
- feat(#4250): whole-program per-field write-kind verdict — fixes the literal-slot miscompile, flips JS2WASM_FNCTOR_CTOR_PARAM_SLOTS to unset⇒ON ([PR 4265](https://github.com/loopdive/js2/pull/4265))
- …and 42 more feature PRs (newest 20 shown; see the compare link).

### Fixes

- fix(#4276): host-free `instanceof Object` / `instanceof Function` in standalone (+6, −0) ([PR 4311](https://github.com/loopdive/js2/pull/4311))
- fix(benchmarks): verify array callback checksums ([PR 4298](https://github.com/loopdive/js2/pull/4298))
- fix(async): preserve Promise rejection payload identity ([PR 4297](https://github.com/loopdive/js2/pull/4297))
- fix(linear): reclaim safe arenas between exported calls ([PR 4288](https://github.com/loopdive/js2/pull/4288))
- fix(dogfood): contain late jsdom host errors ([PR 4285](https://github.com/loopdive/js2/pull/4285))
- fix(#4261): typed field access no longer erases a fnctor's prototype methods — escape-gate clause B yields to a dynamic use (standalone) ([PR 4276](https://github.com/loopdive/js2/pull/4276))
- fix(#4241): carrier-intrinsic $bag on un-split fnctors — acorn's registry leak goes 1 entry/parse to 0 ([PR 4273](https://github.com/loopdive/js2/pull/4273))
- fix(#4235): run the fnctor pipeline on the multi-file compile path ([PR 4269](https://github.com/loopdive/js2/pull/4269))
- fix(#2107): stop the union-undefined erasure being silent; file #4258 ([PR 4267](https://github.com/loopdive/js2/pull/4267))
- fix(website): standalone edition filter + issue links that pointed at unrelated PRs ([PR 4264](https://github.com/loopdive/js2/pull/4264))
- …and 50 more fix PRs (newest 10 shown; see the compare link).

## v0.70.0 - 2026-08-19

- Tag `v0.70.0` · range `v0.69.0..v0.70.0` · [compare](https://github.com/loopdive/js2/compare/v0.69.0...v0.70.0)
- 313 merged PRs: 96 features, 116 fixes, 101 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 32,615 / 43,621 (74.8 %).
- Release notes: [docs/release-notes/v0.70.0.md](docs/release-notes/v0.70.0.md)

### Features

- feat(codegen-linear): #4539 link topology + calls through to C, and #4554 tier-1 address domain ([PR 4643](https://github.com/loopdive/js2/pull/4643))
- feat(hooks): add PreToolUse guard against Claude-authored commits ([PR 4638](https://github.com/loopdive/js2/pull/4638))
- feat(npm-compat): benchmark curated packages and run upstream suites ([PR 4619](https://github.com/loopdive/js2/pull/4619))
- feat(#4513): IR-adopt statically-foldable computed object keys ([PR 4617](https://github.com/loopdive/js2/pull/4617))
- feat(#4512): ref-typed ToBoolean in condition/ternary/! position — 4 residual shapes claim, invariants become clean rejects ([PR 4614](https://github.com/loopdive/js2/pull/4614))
- feat(#4511): session-start usage-limit monitor — 5h-window cache, suspend sentinel, agent-spawn deny hook ([PR 4612](https://github.com/loopdive/js2/pull/4612))
- feat(#4503): IR boolean brand — boolean template substitutions claim in all three lanes ([PR 4610](https://github.com/loopdive/js2/pull/4610))
- feat(#4508): module-binding storage edges in the prepared-owner fixpoint — fibMemo and main claim standalone ([PR 4611](https://github.com/loopdive/js2/pull/4611))
- feat(codegen): fn.prototype auto-object S1+S2 (#4480) + plain-object descriptor slice (#4479) ([PR 4609](https://github.com/loopdive/js2/pull/4609))
- feat(npm-compat): benchmark every curated package ([PR 4608](https://github.com/loopdive/js2/pull/4608))
- feat(#4487): array-literal spread claims over same-typed vec sources ([PR 4601](https://github.com/loopdive/js2/pull/4601))
- feat(#3522): nested class accessors prepare compile-once (family-2 slice) ([PR 4597](https://github.com/loopdive/js2/pull/4597))
- feat(#4471): empty object literal claims — narrowly, with the polymorphic-representation boundary measured ([PR 4593](https://github.com/loopdive/js2/pull/4593))
- feat(#4459): value-discarding expression statements claim — the gate was selector-only ([PR 4589](https://github.com/loopdive/js2/pull/4589))
- feat(#4461): native $Map storage in the IR — standalone Map functions claim ([PR 4583](https://github.com/loopdive/js2/pull/4583))
- feat(#4467): numeric template-literal substitutions claim in all three lanes ([PR 4584](https://github.com/loopdive/js2/pull/4584))
- feat(#3522): nested implicit-constructor classes prepare compile-once ([PR 4576](https://github.com/loopdive/js2/pull/4576))
- feat(codegen): single-emitter %Function% carrier + host-free .constructor arm (#4442) ([PR 4566](https://github.com/loopdive/js2/pull/4566))
- feat(#4424): structure-tree GVN, flag-gated OFF (upstream re-host of #4524) ([PR 4564](https://github.com/loopdive/js2/pull/4564))
- feat(#4418): shared cached dominance analysis (upstream re-host of #4520 + spec-coverage citation) ([PR 4558](https://github.com/loopdive/js2/pull/4558))
- …and 76 more feature PRs (newest 20 shown; see the compare link).

### Fixes

- fix: follow the loopdive/js2wasm → loopdive/js2 rename (npm publish + Pages deploy) ([PR 4652](https://github.com/loopdive/js2/pull/4652))
- fix(ci): retry transient API failures in cla-check; docs: #4540 two-memory alternative ([PR 4645](https://github.com/loopdive/js2/pull/4645))
- fix(ci): import missing setupMarked in npm-compat report generator ([PR 4637](https://github.com/loopdive/js2/pull/4637))
- fix(#4524): out-of-shape data define was dropped, and a borrowed-method read un-poisoned the escape ([PR 4635](https://github.com/loopdive/js2/pull/4635))
- fix(#2668): standalone ordinary indexed set must create an all-true data property ([PR 4631](https://github.com/loopdive/js2/pull/4631))
- fix(codegen): Function residuals (#4483) + operator smalls (#4484) + builtin-surface smalls (#4485) + module-global undefined seed (#4489) ([PR 4624](https://github.com/loopdive/js2/pull/4624))
- fix(#4517): lower the recognised char-read loop's condition in i32 ([PR 4632](https://github.com/loopdive/js2/pull/4632))
- fix(#1888): Array.isArray static fast path claimed every ref is an array ([PR 4629](https://github.com/loopdive/js2/pull/4629))
- fix(website): refine compatibility report links ([PR 4628](https://github.com/loopdive/js2/pull/4628))
- fix(website): collapse JS host source cards ([PR 4626](https://github.com/loopdive/js2/pull/4626))
- …and 106 more fix PRs (newest 10 shown; see the compare link).

### Carried over from the former Unreleased section: Repository rename

- The repo has been renamed `loopdive/js2wasm` → `loopdive/js2`.
  GitHub provides a permanent redirect for the old URL, so existing
  clones and PR links continue to work. New clones and CI should use
  the new name. The `loopdive/js2wasm-baselines` baselines repo is
  tracked separately and will be renamed in a follow-up.

## v0.71.0 - 2026-09-01

- Tag `v0.71.0` · range `v0.70.0..v0.71.0` · [compare](https://github.com/loopdive/js2/compare/v0.70.0...v0.71.0)
- 628 merged PRs: 83 features, 267 fixes, 278 other (infrastructure, docs, tests, planning).
- test262 at the tag (`benchmarks/results/test262-current.json` summary): 35,392 / 48,232 (73.4 %).
- Release notes: [docs/release-notes/v0.71.0.md](docs/release-notes/v0.71.0.md)

### Features

- feat(ir): prepare fast host string signatures ([PR 5379](https://github.com/loopdive/js2/pull/5379))
- feat(3523): record a truthful non-executable module-init outcome row (R4 gap 4) ([PR 5367](https://github.com/loopdive/js2/pull/5367))
- feat(ir): number-boundary intrinsics behind the frozen runtime manifest (#3526 F1-S1) ([PR 5364](https://github.com/loopdive/js2/pull/5364))
- feat(deno): complete linked runtime bootstrap ([PR 5336](https://github.com/loopdive/js2/pull/5336))
- perf(codegen): single direct compile for call-free module inits (#3523 R4 gap-1a) ✓ ([PR 5238](https://github.com/loopdive/js2/pull/5238))
- feat(ir): nested-vec element carrier + destructuring for-of heads (#5166, #4470) ([PR 5218](https://github.com/loopdive/js2/pull/5218))
- feat(ir): prepare fast scalar functions before direct emission ([PR 5308](https://github.com/loopdive/js2/pull/5308))
- feat(ir): reconcile callable alias components graph-first ([PR 5297](https://github.com/loopdive/js2/pull/5297))
- feat(ir): publish multi-source callable components atomically ([PR 5275](https://github.com/loopdive/js2/pull/5275))
- feat(#3520): establish structural Program ABI ownership ([PR 5210](https://github.com/loopdive/js2/pull/5210))
- feat(ir): claim counted-loop-proven string index reads via charAt (#5167) ✓ ([PR 5217](https://github.com/loopdive/js2/pull/5217))
- feat(ir): adopt tail-position loops and finally-less try returns (#5165) ✓ ([PR 5219](https://github.com/loopdive/js2/pull/5219))
- feat(standalone): Deno runtime integration — PR #5148 checkpoint continued ([PR 5202](https://github.com/loopdive/js2/pull/5202))
- feat(ir): adopt mutating expression statements with property/element LHS (#5163) ([PR 5214](https://github.com/loopdive/js2/pull/5214))
- feat(ir): adopt the comma operator and bounded dynamic-lane `in` (#5164) ([PR 5211](https://github.com/loopdive/js2/pull/5211))
- feat(ir): activate the exact prepared field-call family (#3522 F4) ([PR 5199](https://github.com/loopdive/js2/pull/5199))
- feat(selfhost): compile TypeScript 5 parser graph to Wasm (merge-conflict fix for #5183) ([PR 5204](https://github.com/loopdive/js2/pull/5204))
- feat(ir): replay semantic declarations through prepared owners ([PR 5196](https://github.com/loopdive/js2/pull/5196))
- feat(ir): own mixed primitive conditional joins ([PR 5102](https://github.com/loopdive/js2/pull/5102))
- perf(codegen): #4406 Phase 4 — default-ON boolean ABI + numericFunctions admission filter ✓ ([PR 5171](https://github.com/loopdive/js2/pull/5171))
- …and 63 more feature PRs (newest 20 shown; see the compare link).

### Fixes

- fix(es5): recover standalone Test262 regressions ([PR 5374](https://github.com/loopdive/js2/pull/5374))
- fix(runtime): resolve struct decoders from the minting module, not the running module (#5225) ([PR 5365](https://github.com/loopdive/js2/pull/5365))
- fix(codegen): stop extern-class name hijack on cross-module any-receivers; box boolean bridge results (#5241) ([PR 5350](https://github.com/loopdive/js2/pull/5350))
- fix(codegen): Object.create with a dynamic class prototype mints a real instance (#5239) ([PR 5347](https://github.com/loopdive/js2/pull/5347))
- fix(runtime): preserve provider mirrors at method-call exits; method bridges honour `this` (#5237) ([PR 5343](https://github.com/loopdive/js2/pull/5343))
- fix(codegen): register dynamic accessor reads for the host getter bridge (#5223) ([PR 5339](https://github.com/loopdive/js2/pull/5339))
- fix(codegen): enforce Date bridge export provenance (#3520 C39) ([PR 5345](https://github.com/loopdive/js2/pull/5345))
- fix(#5221): `Temporal.PlainDate.from(…)` — six lowering defects behind one null deref ([PR 5334](https://github.com/loopdive/js2/pull/5334))
- fix(ir): account exact R2 body emissions ([PR 5313](https://github.com/loopdive/js2/pull/5313))
- fix(codegen): enforce constructor-closure export provenance ([PR 5342](https://github.com/loopdive/js2/pull/5342))
- …and 257 more fix PRs (newest 10 shown; see the compare link).
