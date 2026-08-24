---
id: 4531
title: "prettier: AstPath.getValue traps 'illegal cast' on the heterogeneous stack array — 4 of 7 upstream failures"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays, classes
goal: npm-library-support
related: [3995, 4289, 3979]
# +37 lines in the vec host-bridge emitter: the struct-ref push/pop arms live
# inside the same per-vec-type cascade builder as every other element kind.
# literals.ts carries the escape-widening predicate + shared decision helper;
# variables.ts and vec-define-writeback.ts each take the matching ~12-line arm.
func-budget-allow:
  - src/codegen/vec-access-exports.ts::_emitVecAccessExportsInner
  - src/codegen/vec-define-writeback.ts::emitVecDefineWritebackExports
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/statements/variables.ts::compileVariableStatement
loc-budget-allow:
  - src/codegen/vec-access-exports.ts
  - src/codegen/vec-define-writeback.ts
  - src/codegen/literals.ts
  - src/codegen/statements/variables.ts
files:
  - tests/dogfood/prettier-upstream-suite.mjs
---

# prettier: mixed string/number/object `stack` array element reads trap

## Problem

Prettier's pinned upstream slice: **1/8 Wasm** (8/8 Node), 2026-08-16 on
`a9b20d4c`, matching the npm-compat card. Four failures are one trap:

```text
RuntimeError: illegal cast
    at AstPath_getValue (wasm-function[68])
```

in `AstPath#call() / #callParent() / #each() / #map()`. Upstream `AstPath`
keeps `this.stack = [node, key1, child1, key2, child2, …]` — an array
interleaving **objects, strings, and numbers** — and `getValue()` reads
`this.stack[this.stack.length - 1]`. The compiled element read casts to one
element shape and traps on the mixed carrier. This is the class-field
variant of the mixed-array-literal family (#3979 mixed array literal calls,
#4289 heterogeneous object-array carrier): here the array is a **class
field** mutated by `push`/`splice` across element types.

The other three failures are Error-subclass `.name` (#4532).

## Reproduction

```bash
node --import tsx tests/dogfood/prettier-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Reduce**: class with `stack: any[]` field seeded `[obj]`, methods that
   `push(str, num, obj)` and read `this.stack[i]` returning it through the
   host bridge. Expect the illegal cast at the read. `.tmp/`, then
   `tests/issue-4531.test.ts`.
2. **Root cause**: the field's array carrier was specialized (probably to the
   seed element's struct type) while writes admit any element. Either the
   declaration-site inference must widen a class-field array that receives
   heterogeneous `push` args (preferred — matches how #4289 handled the
   literal case; check `src/codegen/declarations/object-shape-widening.ts`
   and the array-element-typing pass `src/codegen/array-element-typing.ts`),
   or the element read must cast through the generic any-carrier when the
   element type is not provable.
3. **Check overlap before implementing**: #4289 / #4290 landed carriers for
   heterogeneous arrays in object/class contexts — read their tests first;
   this may be a small extension of an existing pass, not a new one.
4. **Validation gates**: reduction test; prettier harness 1 → ≥5 (the 4
   AstPath tests; record exact); equivalence + #4289/#3979 tests green.

## Acceptance criteria

- [ ] `AstPath` reduction passes: mixed push + indexed read round-trips all
      three element kinds.
- [ ] Prettier upstream ≥ 5/8 (remaining 3 tracked by #4532).

## 2026-08-21 mechanism note (curated-npm-tests lane)

The diff-sequences jest cluster (32 tests) reduces to this issue's family with
a precise mechanism, measured via host-boundary traffic spies:

1. `const callbacks = [{ foundSubsequence, isCommon }]` builds a TYPED vec of
   one closed object struct.
2. The vec crosses an `any`-typed parameter; the callee's
   `callbacks.push({ …wrapper arrows… })` compiles its object-literal argument
   as an OPEN host `$Object` (the externref-context literal routing), which can
   never ref.test as the vec's closed element struct.
3. The host push previously reported the whole vec UNSUPPORTED
   (`__vec_mut_supported` = 0 for struct-ref elements) and silently mutated
   only the materialized mirror; `callbacks[transposed ? 1 : 0]` then read
   null and destructuring threw.

Landed now: `__vec_push`/`__vec_pop` support struct-ref-element vecs with a
guarded element ref.test (mismatch → the -1 unsupported sentinel, keeping the
legacy fallback). This fixes homogeneous typed pushes through opaque
boundaries but NOT the mixed-representation push above — the real fix is
construction-time carrier widening: an array literal of closed-struct elements
whose value ESCAPES into an `any`-typed call argument must select the
universal externref element carrier (the #3244 widening extended from
contextual-`any` literals to escaping literals). That is this issue's
implementation step 2, now with a concrete reduction:

```js
// cb.mjs
const inner = (flip, callbacks) => {
  if (flip && callbacks.length === 1) {
    const { f, g } = callbacks[0];
    callbacks.push({ f: (x, y) => f(y, x), g: (x, y) => g(y, x) });
  }
  const { f, g } = callbacks[flip ? 1 : 0];   // callbacks[1] → null today
  return '' + f(1, 2) + g(3, 4);
};
export function run(f, g, flip) { return inner(flip, [{ f, g }]); }
```

## 2026-08-21 checkpoint — escape-widening slice LANDED (curated-npm-tests lane)

The construction-time carrier widening above is implemented and green on the
reduction (`tests/issue-4531-escape-widened-array-carrier.test.ts`):

- `arrayLiteralEscapeWidensToExternref` (`src/codegen/literals.ts`): shared
  decision — non-empty, spread/hole-free, all elements object/function-tagged,
  and the value escapes into an implicit-any / any / unknown call argument
  (directly or through a const/let binding scanned over the enclosing
  function scope; fail-closed on every unprovable shape).
- `compileArrayLiteral` widens the ELEMENT carrier to externref when that
  predicate holds and the element lane was a closed struct ref.
- **The binding's SLOT must widen too** (`statements/variables.ts` declaration
  cascade, before `taViewType`): first cut widened only the literal, and the
  checker-derived closed-struct vec slot forced a vec→vec converting copy
  whose per-element `ref.test` NULLED every open-representation element —
  measured: `callbacks[0] === null` even caller-side. Slot + literal now
  consult the same predicate, so no converting copy exists on this path.
- `vec-define-writeback.ts` `__vec_set_elem` gained the struct-ref arm
  (guarded `ref.test` → -1 sentinel, mirroring `__vec_push`); without it any
  module with a struct-elem vec in `mutEntries` failed BINARY EMIT
  (`ref.cast typeIdx: -1`).

Validation: reduction passes both lanes (`f12g34|f21g43`); #3979 test 1
(`[1, () => 7]` mixed literal call) flipped from `it.fails` to passing;
#3244/#4204/#4289/#4428 guards green; clsx holds 31/32; jest holds 113/232 —
the diff-sequences 32-test cluster did NOT move: the real jest trap is a
DIFFERENT mechanism (guarded casts inside the module-const-arrow
`diffSequence` closure, type-57 cascade), still open here. Prettier AstPath
(the issue headline, class-FIELD variant) also still open — the widening
covers literals, not class-field arrays mutated across types.

## 2026-08-23 checkpoint — AstPath class-FIELD headline FIXED (prettier 48 → 49/151; call() green, traps cleared)

Three coordinated fixes close the class-field variant (the issue headline):

1. **Raw vec box on externref FIELD stores** — `compileCoercionRhs`
   (char-at-transfer.ts), the ctor-store twin of the #4611 member-set arm: an
   array-literal RHS assigned to an externref struct field compiles UNHINTED
   and boxes with a bare `extern.convert_any`. Before, the externref hint
   routed the vec through the generic coercion, which appends
   `__make_iterable`; the field then held the JS MIRROR while every native
   lane `ref.cast`ed to the vec — the `illegal cast` under all four AstPath
   methods.
2. **Guarded dual-lane push/pop for externref receivers** —
   `compileExternReceiverPushPop` (array-methods.ts), mirroring the #2784 S3
   arm: `ref.test` the registered vec carriers → native
   `__vec_push`/`__vec_pop`, else the host `__extern_method_call` bridge.
   `case "push"/"pop"` route there when `receiverIsExternref` (host/gc lane
   only). The old native inline push cast the receiver unguarded.
3. **Mirror→vec mutation routing** — `_tryWasmVecMutation` (runtime.ts)
   resolves a registered mirror via `vecForMirror` and mutates BOTH the vec
   (authoritative) and the mirror (immediate host-side visibility). A host
   push on a mirror was a silent no-op wiped by the next crossing's refresh.

Regression test: `tests/issue-4531-class-field-array-native-identity.test.ts`
(2 tests incl. the verbatim AstPath call/getValue shape, `true|1`). Full
pinned-source probe (`.tmp/probe-astpath.mts`, real ast-path.js): call,
nested call, callParent basics all correct.

**Measured**: prettier 48 → 49/151; AstPath#call PASSES; callParent/each/map
converted from `illegal cast` traps to assertion-level residuals
(`callParent` assert 3 `1 != 5` — `stack.splice(stackIndex + 1)` +
`stack.push(...parentValues)` spread-push on the field are the next lanes;
each/map toEqual mismatches). Guards: acorn 3518/3518, jest 328/358,
react 109 pass zero-flips (fail 35→37 is the main-merge denominator change:
the 2 former `skipped` now count as fail), cookie 63740, clsx 32/32,
issue-3244/4204/4289/4428/4531/4611 unit guards 46/46, equivalence
push-pop/prototype-methods/optimize-differential 29/29, func/LOC/oracle
gates OK.

**Still open here**: the ~95 prettier no-error-text failures (doc-utils
validation / isEmptyDoc / parser-selection families — likely one shared root,
un-diagnosed) and the AstPath splice/spread-push lanes above.
