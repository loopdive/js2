# Spike S15: can the Prepared path call the existing standalone runtime library?

Date: 2026-11-19. Base: main `89e47482`. Target: wasmgc standalone, strict
Prepared entry (`wholeProgram: { kind: "prepared-program-required" }`).
Scratch code (not for merge): branch `claude/spike-prepared-runtime-bridge`,
directory `spike/s15/`. Every probe below ran twice: as written, and with one
expected answer replaced by a wrong one. The wrong-answer twin threw in every
case reported as a pass, so no pass comes from a check that never ran.

## Answer

**Yes, with four fixes, all of which already exist as mechanisms on the
ordinary pipeline's package linker (#2527, #5226, #3451).** A Prepared module
and one ordinary-pipeline standalone library module exchange numbers, booleans,
strings, objects, function values and caught errors correctly once they share:
the canonical runtime type group (#2527, ABI v3), the `env.__exn` exception tag
(#5226), the `undefined` singleton, and one realm (the Prepared side mints no
objects of its own). Without these, three of the probes fail: an exception is
not caught, `undefined !== undefined`, and a long string traps with
`illegal cast`.

Recommended shape: **the Prepared program links the shared runtime library
(compiled once) at instantiation time, not per program.** Details and costs are
in the last two sections.

## Method

The spike branch did not exist on origin, so S15's shape A was rebuilt. The
compiler-side plumbing that S15 described (a from-ast call arm, a runtime
callable declaration, an import reserved in the physical plan, the
presentation gate) was **not rebuilt**. Instead:

1. A Prepared program declares a stub for each library function
   (`function lib_keys(a) { return __d; }`, so the signature is
   `externref → externref`), compiled through the strict entry.
2. The stub is replaced by `(import "legacy-lib" "lib_keys")` with the same
   type (Binaryen text round-trip). This is the module S15's physical-plan
   reservation produces; the call site is unchanged Prepared output.
3. The library is an ordinary-pipeline standalone module
   (`export function lib_keys(o: any): any { return Object.keys(o).length; }`).
4. Run two ways: two instances in one store, and one module fused by
   `wasm-merge` (0 imports).

Control: S15's own case, `parseInt("42")`, passes both ways, and its twin
(`!== 43`) throws.

## Results

### (a) Objects across the boundary

**Today: different types. Opaque passing works.**

- `$PropEntry` and `$PropMap` are the same type on both sides (shared
  declaration in `src/runtime/wasmgc/values/object-layouts.ts`).
- `$Object` is not the same type. The Prepared declaration
  (`createOpenObjectDeclaration`) has 6 fields and a non-null `props`. Legacy
  emits 7 fields (a trailing `protoLink anyref`) and a nullable `props`, on
  every program measured. A two-module Wasm check: an object with the legacy
  layout fails `ref.test` against the Prepared `$Object` (0) and passes against
  the legacy layout declared in another module (1).
- Probes a1 (`Object.keys(lib_obj()).length === 1` with the object passing
  through Prepared code) and a2 (object identity with `===` on both sides) pass,
  because Prepared code treats the object as an opaque `externref`.
- Prepared cannot yet read a member, write one or ask `typeof` of a library
  object. It refuses with `dyn.member_get has no Prepared intrinsic`,
  `property assignment on dynamic is not in slice 4`, and `dyn.typeof has no
  Prepared intrinsic`. Those operations are exactly what a library callable
  can provide.

Consequence: **only one module may mint objects.** If the Prepared side mints
objects natively, it must use the legacy layout. That has to be fixed as an ABI
constant (`protoLink` and the nullability included), not by matching each
program separately. The simpler rule is that object creation goes through the
library.

### (b) Strings across the boundary

**Yes for short strings. Long strings need the type-group fix.**

- Pass: legacy `toUpperCase` result compared on the Prepared side (b1), a
  Prepared literal compared in legacy (b2), legacy concatenation compared in
  Prepared (b4), a Prepared literal or key used as a property key in legacy get,
  set, `in` and `Object.keys` (b5–b7).
- **Fail:** a Prepared runtime concatenation of 64 characters or more (the
  length at which Prepared builds a rope node, `$ConsString`) passed to legacy
  `===`, `toUpperCase` or property get traps with `illegal cast` (b8, b10, b11).
  Only `.length` works (b9).
- Cause: legacy emits the leaf string types `$ConsString` and `$HashedString`
  as `sub final`, Prepared emits them as plain `sub`. These are different types
  under isorecursive canonicalization, so legacy's `ref.test` on its own rope
  type misses a Prepared rope and the fallback cast traps. `$AnyString` and
  `$NativeString` are the same on both sides, which is why S15's
  parseInt case and the short-string probes pass.
- Fix verified: marking the two Prepared types `final` makes b8–b11 pass, and
  their twins throw. The durable fix already exists: the frozen runtime type
  group `RUNTIME_RECGROUP_TYPE_NAMES` (`src/emit/canonical-recgroup.ts`, #2527,
  ABI v3). There the finality of each member is a constant of the ABI. Legacy
  emits it under `canonicalRuntimeTypes`. The Prepared path would have to emit
  the same 10-member group.

### (c) Exceptions across the boundary

**Two tags by default. One shared tag fixes it.**

- The fused module has two distinct `(tag (param externref))`. Prepared's
  `try_table` catches only its own, so a legacy `throw` escapes a Prepared
  `catch` (c1, c2 fail; the program throws even when it should return).
- With Prepared importing legacy's tag, c1 (a legacy `TypeError` caught in
  Prepared) and c2 (the caught value handed back, `e instanceof TypeError`)
  pass. c3 (a Prepared value thrown and caught inside legacy) passes either way.
- Both sides already support the shared tag: legacy's `sharedExceptionTag`
  (#5226, `env.__exn`) and the Prepared physical plan's
  `exceptionTag.shared` (`src/ir/program-physical-plan.ts:1487`,
  `native-object-realm.ts:109`).

### (d) Duplicated singletons

**`undefined` breaks Prepared `===`. Booleans and strings do not.**

- Each module has its own `$__undefined` (an `$AnyValue` struct, same type on
  both sides) and its own boxed `true`/`false`.
- Legacy tests `undefined` by the struct's tag field, so the duplicate is
  harmless to legacy (d2, d3, d6 pass).
- Prepared `__js_strict_eq` compares non-number, non-boolean, non-string values
  with `ref.eq`. A legacy `undefined` compared with a Prepared dynamic
  `undefined` is therefore unequal (d7 fails: `var v; lib_undef() !== v`).
  d1 passes only because comparing with the literal `undefined` takes a tag
  test, not `ref.eq`.
- Fix verified: Prepared imports the library's `$__undefined` global, and d7
  passes; its twin throws. (Alternative: compare by the tag.)
- Booleans compare by unboxed value (d4, d5, d8 pass). String constants compare
  by content (b-probes).
- Not exercised: mutable runtime state that legacy keeps in globals (the symbol
  intern table, `currentThis` for closure calls, the closure-property and
  prototype heads). Each must exist in one module only. That holds as long as
  Prepared does not reimplement those families.

### (e) Built-ins as values

**Yes, as opaque values. Calling them from the Prepared side is not built yet.**

- `var f = lib_getParseInt(); lib_call1(f, "7") === 7` passes (e1): the
  library's `parseInt` function value goes through Prepared code and back.
- `Object.getPrototypeOf(lib_obj()) === Object.prototype` passes (e2). There is
  one realm because only the library creates objects.
- Prepared code calling the value directly (`f("7")`) refuses: `direct call to
  "f" has no exact AST-site plan` (slice Fb).
- **Callback into a Prepared closure: fails today. Measured on S4's Fa branch**
  (`claude/7354-fa` @ `1474338c53`), with the shared tag:
  - `typeof inc === "function"` in the library passes (fa3).
  - `lib_call1(inc, 1)` (the library runs `f(a)`) and `[1, 2].map(inc)` in the
    library both fail (fa1, fa2). A classifying probe shows the library's call
    throws `TypeError`; it does not trap or return a wrong value.
  - Cause: the closure **header** is the same type on both sides
    (`(sub (struct funcref i32 (mut externref)))`), but the **entry signature**
    is not. Legacy's dynamic call `ref.test`s the closure's funcref against one
    uniform entry type, `(func (closure, externref, externref, externref) →
    externref)`, and throws `TypeError` when it misses. Fa's funcref has the
    callee's exact arity, `(func (closure, externref) → externref)`.
  - Fix (not tried): the Prepared closure either carries an entry with legacy's
    uniform signature (an adapter, or Fa's closure ABI adopting it), or the
    library's call dispatch learns Prepared's exact-arity entries. Either way
    the closure-call ABI becomes part of the versioned runtime ABI, next to
    rules 1–3 below. Whether the IR adopts legacy's closure ABI here is the
    lead's call: the 2026-11-15 rule says the IR need not mirror it.
  - Not exercised: the library's `currentThis` versus Prepared's when the
    callee reads `this` (slice C).

### (f) Size and compile time (prelude-shaped)

Same container, one process, warm median of 3 after one cold compile.

| what | bytes | compile |
| --- | ---: | ---: |
| M0 ordinary standalone: real prelude + `assert.sameValue(1, 1)` (today's per-test cost on the ordinary path) | 343,717 | 0.98 s (cold 2.2–2.5 s) |
| M1 per-program shim: 33 exports, the prelude's built-ins + dynamic ops (get/set, `+`, `<`, `==`, `typeof`, call, `new`, `instanceof`, `in`) | 439,885 | 0.74 s (cold 1.0 s) |
| M1 with `eval` added (pulls in the runtime-eval provider and its `js2wasm:runtime-eval` import) | 1,193,322 | 1.6 s |
| M2 shared library: 112 exports (M1 + 20 String, 20 Array, 15 Math, 15 Object methods, JSON.parse, RegExp, Date, Map, Set, Number) | 634,044 | 1.17 s (cold 1.5 s), **once** |
| Prepared module with the prelude's 33-import surface | 6,445 | (cold only, not comparable) |

Per-test link cost against each library:

| | shim (M1) | shared (M2) |
| --- | ---: | ---: |
| instantiate the library | 2 ms | 2 ms |
| instantiate Prepared against it (shared store) | < 1 ms | < 1 ms |
| `wasm-merge` into one module | 0.54 s → 386 kB | 0.69 s → 574 kB |
| + unused-element removal | 0.47 s → 235 kB | 0.65 s → 266 kB |
| + `-O2` instead | 2.5 s → 183 kB | 2.8 s → 211 kB |

Reading:

- **A per-program shim saves nothing.** It is another ordinary-pipeline compile
  per test (0.74 s), close to compiling the whole prelude on the ordinary
  pipeline (0.98 s).
- **The shared library is compiled once** and costs about 2 ms per test when
  linked in a shared store. Fusing per test costs 0.7–1.3 s and is only worth
  it for a single-file deliverable; after unused-element removal it is 266 kB,
  smaller than M0.
- Breadth is cheap. Going from 33 to 112 exports adds 194 kB unfused and 31 kB
  after removal, because most of the code is the shared runtime both need.

## Recommendation

**Adopt shape A as a link-time bridge onto the existing shared-runtime ABI
(#2514 / #2527), with one library module compiled once, linked in a shared
store, and fused with `wasm-merge` only for a single-file output.** Do not
introduce a new `legacy-lib` namespace. The pieces already exist:
`runtimeProvider`, `canonicalRuntimeTypes`, `sharedExceptionTag` and
`exportsConsumedByWasm` (`src/index.ts`), the package linker's
content-addressed provider cache, and `src/test262-harness-provider.ts` as the
compile-once model.

Rules that make it sound (each one closes a failure measured above):

1. The Prepared path emits the canonical runtime type group (ABI v3, pinned
   finality). This fixes b8–b11.
2. The Prepared path imports `env.__exn`. This fixes c1–c2.
3. The closure-call entry signature is fixed by the ABI (fa1/fa2 above).
4. The library exports the value singletons (`undefined`, the boolean boxes)
   and the Prepared path imports them, or Prepared `===` compares by tag. This
   fixes d7. Add them to the versioned ABI.
5. One minting module: objects, arrays, errors, closures-as-objects and the
   realm are created only by the library; Prepared holds them as `externref`.
   This avoids the `$Object` layout split (a) and the cross-module
   struct-decoder problem the linked harness had to solve (#5225), and gives
   one `Object.prototype` (e2).

### What it replaces in the #7354 slice ladder

| slice | today's plan | with the library |
| --- | --- | --- |
| H, T, X, Str | native, done or in flight | unchanged |
| Fa (function values) | native | unchanged, plus the shared closure-call entry signature (fa1/fa2 fail today) and the library's `currentThis` |
| O (objects as dynamic values) | native object literal, member get/set | library callables: create, get, set, `in`; Prepared lowers literals to create + set |
| Fb (dynamic call) | native IsCallable, apply vectors | library `call`/`apply` for any non-static callee; a direct typed call stays native |
| C (function objects: props, `new`, `instanceof`) | native | library callables over the closure value from Fa |
| B (built-in globals) | native, per family | library exports, one parameterised declaration family (e.g. `js.lib.<name>`), not one row per built-in |
| D2-style dynamic `+`, `<`, `==`, `typeof` | pure builders moved out of `dyn-ops.ts` | library callables now; the pure-builder move can follow per family later |
| M | — | runner links the library for `TEST262_COMPILER_PATH=ir` |

### Cost (estimates, not measured)

- Prepared emits the canonical type group: M (it already reserves the string
  family; the group adds the vec family, order and finality).
- Shared exception tag and singleton imports: S each (the tag mechanism exists
  on both sides).
- One generic library-callable declaration plus the from-ast arms for
  built-in reads and the dynamic operations, and admission of the runtime
  namespace in the presentation gate and in `finalizePipelineModule`'s
  retired-host-import check (#6979). S15 found each gate small: M in total.
- The library build: one source file under `src/runtime/`, built with
  `runtimeProvider` and cached by compiler ABI hash: M.
- Runner linking on the IR lane: S (mirrors the linked-harness instantiate).
- Closure-call entry signature shared with the library: S–M, part of Fa or a follow-up.

The remaining ladder becomes H/T/X/Str (done or in flight) → Fa → library
bridge → M, instead of seven native slices.

### Decisions for the lead

1. **Does a library compiled by the legacy front-end count toward "IR-only"?**
   The test file and prelude would be compiled by the IR, but built-in
   semantics would come from legacy-compiled code, so the legacy front-end
   cannot be retired while the library depends on it. A way out is to compile
   the library itself with the IR once the IR can, since it is ordinary
   TypeScript.
2. **Standalone delivery.** A shared-store link needs an instantiator that
   wires two modules, which is fine for the test262 runner. A single-file
   standalone artifact needs `wasm-merge` per program: 0.7 s plus 0.65 s for
   unused-element removal, measured above.
3. **Shape B, rejected unless the lead wants it:** compile the whole prelude
   once with the ordinary pipeline (the #3451 harness provider) and compile only
   the test body on the Prepared path. It would get to M fastest (#3451
   measured 30–96 ms per body), but then the prelude is not IR-compiled at all.

## Found on the way (to file)

- **Prepared crash:** a program with only declarations and `var x;` throws
  `PreparedIrProgramInvariantError: empty startup source … claims an
  executable body` from `assertPreparedIrProgram`, instead of a refusal.
  Repro: `var __d; function f(a) { return __d; } function g() { f(0); }`.
  Already fixed by PR #7319 (approved, per the lead).
- Binaryen 132 `wasm-merge -all` writes a module that V8 rejects
  (`stringview_wtf16`). Pass the explicit feature list instead.
- `eval` in a library pulls in the runtime-eval provider (+750 kB and an import
  from `js2wasm:runtime-eval`); keep it out of the base library.
