---
id: 3398
title: "standalone: tail-call ABI mismatch / block-result fallthru / call arity / ref.test-cast long tail — invalid Wasm (~13 tests)"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: medium
feasibility: medium
reasoning_effort: high
model: fable
task_type: bugfix
area: codegen, emit
language_feature: private-fields, arrays, tail-calls
goal: standalone-mode
umbrella: 2039
related: [2039]
test262_bucket: standalone-invalid-wasm
test262_count: 13
es_edition: multi
loc-budget-allow:
  # (#3398) The non-arrow `this`-shadow fix adds a ~15-line explanatory comment
  # to `arrowOwnLocals` in closures.ts (the correct home — it's the free-var
  # own-locals helper). +15 over the god-file ceiling is intended.
  - src/codegen/closures.ts
---

# #3398 — tail-call / block-result / arity / ref.test long tail (child of #2039)

## Bucket

- **Records:** 13 (the structurally-distinct long tail — smaller mechanisms,
  each 1–6 rows; grouped because none warrants its own umbrella child).
- **Validator signatures:**
  - `return_call: tail call type error` — 3 (all `expressions/in/private-field-presence-*`, in `Parent_new`)
  - `type error in fallthru[0] (expected (ref null A), got (ref B))` — 4 (Array join / toLocaleString)
  - `not enough arguments on the stack for struct.new (need N, got M)` — 2 (Array.from)
  - `not enough arguments on the stack for call` — 1
  - `Invalid types for ref.test: local.tee of type externref has to be in the same rec group` — 2 (expressions)
  - `Invalid types for ref.cast null: extern.convert_any of type externref …` — 1
- **Area distribution:** expressions:6, Array:6, statements:1.
- **3 sample tests:**
  - `test/language/expressions/in/private-field-presence-method-shadowed.js`
    (`return_call: tail call type error` in `Parent_new`)
  - `test/built-ins/Array/prototype/join/S15.4.4.5_A3.2_T2.js`
    (`type error in fallthru[0] (expected (ref null 6), got (ref 118))`)
  - `test/built-ins/Array/from/source-object-iterator-1.js`
    (`not enough arguments on the stack for struct.new (need 2, got 1)`)

## Reproduced on current main

```
INVALID [in/private-field-presence-method-shadowed.js]:
  Compiling function #48:"Parent_new" failed: return_call: tail call type error @+28702
INVALID [Array/prototype/join/S15.4.4.5_A3.2_T2.js]:
  Compiling function #56:"test" failed:
  type error in fallthru[0] (expected (ref null 6), got (ref 118)) @+30746
```

## Root cause (four sub-mechanisms)

1. **`return_call` tail-call type error (3, private-field-in `Parent_new`).**
   A class constructor `Parent_new` returns via `return_call`/`return_call_ref`
   (tail-call optimization, CLAUDE.md pattern) whose callee result type does not
   match `Parent_new`'s declared result. The WAT shows
   `struct.new 46 local.tee 0 return_call …` — the tail call's signature differs
   from the enclosing function's result. Root: tail-call emission does not
   verify caller/callee result-type identity in the constructor path with
   private-field presence checks (`#x in obj`).

2. **Block-result fallthru mismatch (4, Array join/toLocaleString).** A block's
   declared result type is `(ref null 6)` (generic object) but the fallthru
   value is a non-null `(ref 118)` (a concrete struct). The block-type
   annotation and the produced value disagree — the array-iteration block result
   ValType is too narrow/wide. Root: the join/toLocaleString element-accumulator
   block type is computed inconsistently with the element push.

3. **`struct.new` arity (2, Array.from).** The `Array.from` source-iterator
   lowering pushes only 1 of the 2 fields `struct.new` needs — a missing operand
   push in the array/iterator materialization.

4. **`ref.test`/`ref.cast` rec-group violation (3, expressions).** An externref
   operand is fed to `ref.test`/`ref.cast $T` where `$T` is a GC type in a
   different rec group — externref is never castable to a GC struct directly;
   must `any.convert_extern` first. Root: a `ref.test`/`ref.cast` is emitted on
   a still-externref value without the `any.convert_extern` bridge (mirror of
   #3395 shape 3 but on the test/cast side).

## Implementation Plan

### Investigation anchors

- **Tail call (1):** grep `return_call` / `return_call_ref` emission in
  `src/codegen/statements.ts` / `src/codegen/index.ts` (return-position TCO).
  Add a result-type identity check: only emit `return_call` when callee result
  ValType === enclosing function result ValType; otherwise fall back to
  `call` + `return`. Focus on the constructor (`*_new`) path with `#x in obj`.
- **Block fallthru (2):** grep the Array `join` / `toLocaleString` lowering
  (`src/codegen/array-methods.ts`) for the accumulator block type. Align the
  block result type with the pushed element ValType (widen the block type to
  `(ref null 6)` on both sides, or cast the pushed value).
- **struct.new arity (3):** grep `Array.from` / iterator materialization
  (`array-methods.ts` / `expressions.ts`); find the `struct.new` with a dropped
  operand and push the missing field.
- **ref.test/cast rec-group (4):** grep the offending `ref.test`/`ref.cast`
  sites; insert `any.convert_extern` before testing/casting an externref to a
  GC type (use the `ref.test`-before-`ref.cast` guard from CLAUDE.md).

### Wasm IR patterns (targets)

```wasm
;; 1: only tail-call when result types match
call $callee                 ;; if result type != caller's, use call+return
return
;; 4: bridge externref before ref.test
local.get $x                 ;; externref
any.convert_extern           ;; -> anyref
ref.test $T                  ;; now legal
```

### Edge cases

- Tail-call fallback must preserve TCO where types DO match (don't disable it
  wholesale — it's load-bearing for deep recursion).
- `Array.from` with a custom `@@iterator` returning fewer values must still
  materialize a well-formed element struct.
- `ref.test` on a null externref → returns 0 (not a trap).

### Test files to verify

- `test/language/expressions/in/private-field-presence-method-shadowed.js`
- `test/built-ins/Array/prototype/join/S15.4.4.5_A3.2_T2.js`
- `test/built-ins/Array/from/source-object-iterator-1.js`
- Regression test `tests/issue-3398-tailcall-longtail.test.ts` (standalone +
  wasi + host-guard), one case per sub-mechanism.

## Acceptance criteria

- All 13 rows compile to valid Wasm (or refuse loudly).
- TCO preserved where result types match; no deep-recursion regression.
- No host-mode regression; equivalence tests green.

---

## Investigation (fable-dev-1, 2026-07-18) — sub-mechanism 3 (struct.new arity) MINIMALLY REPRODUCED

Branch `issue-3398-getter-structnew` (pushed). Focused on the **`struct.new`
arity** sub-mechanism (2 rows, Array.from) — the only one with a clean minimal
repro. The other three (return_call TCO, block fallthru, ref.test rec-group)
were not minimized (harness-dependent, like #3397).

### Minimal repro (standalone) — CLEAN, no harness needed

```ts
export function test(): any {
  var obj = {
    make() {
      return {
        index: 0,
        get val() {
          return this.index;
        },
      };
    },
  };
  return obj.make();
}
// → INVALID: "not enough arguments on the stack for struct.new (need 2, got 1)"
```

Trigger matrix (all `--target standalone`):

- object-literal METHOD (`make(){…}` OR `[Symbol.iterator](){…}`) returning an
  object literal with a DATA prop + a GETTER (`{ index:0, get val(){} }`) →
  **INVALID**. This is the real `Array.from(obj)` shape
  (`source-object-iterator-1.js`): `obj[Symbol.iterator]()` returns
  `{ index, next(), get val() }`.
- Same inner object returned from an ARROW / FUNCTION-DECL / directly from
  `test()` → **VALID** (routes correctly).
- Inner object with method+getter but NO data prop → **VALID**.
- So the trigger is specifically: **object-literal-method return-value + inner
  object literal with (data prop + getter)**.

### Root direction

The getter host-path gate (`literals.ts:1285`,
`expr.properties.some(isGetAccessorDeclaration) → compileObjectLiteralWithAccessors`)
is NOT firing for the inner object in the method-return context. The emitted
struct type is contaminated: for the repro the WAT shows
`(type $__anon_0 (struct (field $make (mut externref)) (field $index (mut f64))))`
— it MERGED the outer object's `make` with the inner object's `index` and
DROPPED the getter `val`, then `struct.new` wants 2 fields but only 1 operand is
pushed. So a struct-shape resolution / registration path for nested anonymous
object types (in the object-literal-method return position) bypasses the
getter gate and builds a wrong-arity struct. Fix anchor: find the entry point
that compiles the method-return object literal WITHOUT routing through
`compileObjectLiteral`'s getter gate (likely a contextual-struct-new path keyed
on the method's inferred return type), and either (a) route it through the gate,
or (b) make the struct-shape builder exclude/handle accessor members + push the
matching operands.

### Status

Sub-mechanism 3 (struct.new arity): minimal repro banked, root direction
identified; **fix DEFERRED** (anonymous-struct-shape contamination is deeper
than a one-liner). Sub-mechanisms 1/2/4: harness-dependent, not minimized.
Build DEFERRED — hand off with this repro.

---

## Slice plan (fable-dev-5, 2026-07-18, branch `issue-3398-getter-structnew-fix`, continuation of dev-1's banked repro)

Scope: sub-mechanism 3 ONLY (the banked minimal repro). Plan:

1. Reproduce on this base; dump the anon-struct registration trace for the
   repro (who builds `$__anon_0` merging outer `make` + inner `index` and
   dropping the getter `val`).
2. Locate the method-return object-literal compile entry that bypasses
   `compileObjectLiteral`'s getter gate (literals.ts:1285 —
   `compileObjectLiteralWithAccessors`); per dev-1 likely a contextual
   struct-new path keyed on the method's inferred return type.
3. Fix by ROUTING (option a: make the bypass path consult the getter gate) —
   preferred over teaching the shape-builder accessor handling (option b),
   which duplicates the gate's logic.
4. Validate: repro → valid + correct runtime (getter reads `this.index`);
   `Array/from/source-object-iterator-1.js` + `-2` standalone; anon-struct
   regression sweep (object-literal suites + emit-identity); no host change.

Checklist:

- [x] Repro confirmed on base
- [x] Root located (NOT the getter-gate bypass dev-1 hypothesized — see below)
- [x] Fix + committed suite (5 cases)
- [x] Array.from samples measured base vs branch
- [x] Anon-struct/object-literal sweep + prove-emit-identity
- [x] PR open

### Actual root cause (fable-dev-5) — non-arrow `this`-capture, NOT a getter-gate bypass

dev-1's hypothesis (the getter host-path gate at literals.ts:1285 not firing)
was a symptom, not the cause. Instrumenting the anon-struct registration
(`ensureStructForType`) + the dynamic field auto-add
(`property-access-dispatch.ts`) showed the sequence:

1. `ensureStructForType` correctly builds `__anon_0` for the OUTER object
   `{ make(): {…} }` with ONE field `make:externref` (the getter gate DID fire
   for the inner object — it never became a struct).
2. The inner getter `get val() { return this.index; }` is lifted as a closure.
   The free-variable scan (`collectReferencedIdentifiers`) collects `this` as a
   capturable name for EVERY function-like, and `arrowOwnLocals` did not shadow
   it — so the getter captured the ENCLOSING `make` method's `this`, a
   `(ref $__anon_0)`.
3. Inside the getter, `this.index` therefore statically resolved against the
   OUTER `__anon_0` struct (via `resolveThisStructName`). `index` wasn't a field
   of it, so the dynamic-property auto-add path APPENDED `index` to the
   already-emitted `__anon_0` — but the `struct.new` for `make`'s return was
   already emitted with the 1-field arity → "not enough arguments on the stack
   for struct.new (need 2, got 1)". Invalid Wasm in BOTH lanes.

**Fix:** `arrowOwnLocals` (closures.ts) shadows `this` for NON-arrows. Only
arrows inherit the lexical `this` (§8.1.1.3); a function expression /
object-literal method / accessor binds its own dynamic `this` at call time
(the closure-call path installs the receiver via `__current_this`). Callers
force-cast accessor/method decls to `FunctionExpression`, so `isArrowFunction`
is the reliable discriminator.

**Validated:** committed suite 5/5 (repro valid+correct both lanes; iterator
method-mutates/getter-observes; arrow-inherits-this guard; outer-struct-intact
guard). `Array/from/source-object-iterator-{1,2}` standalone CE→pass (the 2
cited rows). Array/from full dir (47 files): ONLY those 2 flip, 0 regressions.
Full `tests/equivalence/` + accessor/objlit-method suites: failure set
identical base↔branch (the 14 failing files all PASS in isolation — known
in-process test262-runner realm pollution). `prove-emit-identity` IDENTICAL
56/56 (host lane unaffected on the corpus).

**Remaining #3398 sub-mechanisms (NOT this PR):** return_call TCO (3),
block-result fallthru (4), ref.test/cast rec-group (3) — all harness-dependent,
not minimized.
