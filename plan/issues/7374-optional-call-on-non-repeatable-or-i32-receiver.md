---
id: 7374
title: "`g()?.toFixed()`, `c.a?.toFixed()` and `b?.toString()` on `boolean | undefined` return `undefined` for a defined receiver"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7370, 7360]
---

# #7374 — optional calls on receivers #7370 leaves out

## Problem

#7370 makes `x?.toFixed()` call the method on a defined primitive receiver when the receiver is an identifier or
`this`. Three shapes still return `undefined`, on main and with #7370, gc and standalone alike:

```ts
let n = 0;
function g(): number | undefined { n++; return 2; }
g()?.toFixed(0);                 // node "2" (and n === 1); we return undefined

class C { a: number | undefined = 4; }
new C().a?.toFixed(0);           // node "4"; we return undefined

function f(b: boolean | undefined) { return b?.toString(); }
f(true);                         // node "true"; we do not return "true"
```

## Cause

- **Non-repeatable receivers** (a call, a property chain): #7370 calls the method through the ordinary
  receiver-method ladder (`compileReceiverMethodCall`), which reads the receiver again. That is only safe for an
  identifier or `this`, so these shapes keep the old short-circuit. Fixing them needs the ladder to take the
  receiver value already tested and held in a temp, instead of re-reading it.
- **`boolean | undefined`**: the parameter lowers to a bare i32 that cannot hold `undefined`, so `f(true)` and
  `f(undefined)` cannot be told apart at the call. This is a representation gap in the boolean slot (compare the f64
  sentinel #7360 uses for `number | undefined`), not an optional-call defect.

## Acceptance criteria

- The three reproducers answer like node on gc and standalone; `g()` runs exactly once.
- Repeatable receivers (#7370) keep their bytes.

(Outcome: the first two reproducers are fixed; the boolean one cannot be, see Result. Repeatable receivers now read
the same held local as every other receiver, so their bytes change by one local; that is the cost of having one
path instead of two.)

## Implementation Plan

Legacy codegen only.

- **Mechanism (reused, not added).** `FunctionContext` already had a map from an AST node to a local that
  `compileExpressionInner` reads instead of evaluating the node: the native generator continuation spills (#680),
  which the Array-subclass receiver lowering (#2917) already borrowed. It is renamed for what it is,
  `nativeGeneratorExpressionValueLocals` → `preEvaluatedExpressionLocals`, and its scoped set/delete moves into
  one helper, `withPreEvaluatedExpression(fctx, expr, local, emit)` in `context/locals.ts`. #2917's inline copy of
  that set/try/finally/delete now calls the helper. The async twin (`asyncOperandValueLocals`) stays separate on
  purpose (its doc says why).
- **Optional calls** (`expressions/calls-optional.ts`). `compileHeldReceiverMethodCall` runs the receiver-method
  ladder inside `withPreEvaluatedExpression(propAccess.expression, <temp>)`. The externref arm passes the temp it
  already tests for nullishness; the value arm (`compileOptionalValueReceiverCall`) now `local.tee`s / `local.set`s
  the receiver into a temp instead of dropping it. The temp holds exactly the value and Wasm type that compiling the
  receiver yields, so the ladder sees the same type it would have produced itself, and any coercion it asks for still
  happens in `compileExpression`'s public layer. Dispatch still uses the non-nullish static type
  (`optionalChainReceiverType`), which is keyed on the AST node and unchanged.
- **Duplicate removed.** `isRepeatableOptionalReceiver` is gone: no receiver is re-read any more. The #4292
  `any`/`unknown` arm therefore also takes calls and property chains (`box.value?.at(-1)` with a getter reads once).
- **Quality criterion.** No third expression-substitution map; one scoped binder shared by the two users that bind a
  receiver; no per-shape repeatability predicate.

## Result (2026-11-19, on `claude/7374-optional-call-receiver-binding`, base c9983ac91b)

- `tests/issue-7374-optional-call-receiver-binding.test.ts`: 12 programs × gc/standalone, answers from node (call
  receiver defined/undefined with a call counter, `number | null` call receiver, argument side-effect order, class
  field defined/undefined, counting getter, `this.a?.toFixed()`, element receiver with a counting index, nested
  `a()?.b()?.toFixed()`, dynamic `any` getter, the #7370 identifier row). Before: 18 of 24 fail; after: 24/24.
- Neighbours (#7370, #1603, #2049, #2051 ×2, #4292, #4376, #5346, #6504): the same 8 tests fail on base and head
  (`issue-2051-optional-element-undefined` 1, `issue-6504-optional-chain-shortcircuit` 7: optional *element*
  access, not this path).
- Byte identity: 100 test262 files × gc/standalone, binaries identical (200/200).
- Gates: loc/func budget (also with `LOC_GATE_BASE=origin/main`), coercion sites, oracle ratchet, dead exports pass.
- Equivalence gate: exit 0, 4849 passing, 20 failing (all known), no new regressions; it reports two baseline
  failures now passing (`delete-sentinel`, `reflect-api` `Reflect.construct`), not attributed to this change.

### `boolean | undefined` — a representation gap, not fixed here

- **Representation.** `mapTsTypeToWasm` (`src/checker/type-mapper.ts`, the union arm) strips `null`/`undefined`
  from the union; `boolean` is the union `true | false`, both map to `{ kind: "i32", boolean: true }`, so
  `boolean | undefined` lowers to that bare branded i32. There is no undefined sentinel for it (unlike the f64
  `undefSentinel` of #7360).
- **Not distinguishable.** The call site passes `f(true)` as `i32.const 1` and `f(undefined)` as `i32.const 0`, the
  same bits as `f(false)`. No lowering of `b?.toString()` can answer both `f(false)` ("false") and `f(undefined)`
  (`undefined`), so no test is added for it.
- **What a fix needs.** A third value in the slot: either an i32 undefined sentinel for a nullable boolean (chosen in
  `mapTsTypeToWasm`, produced by the `undefined` → i32 coercion, and honoured by every boolean reader: ToBoolean
  conditions, boxing, `===`, `typeof`), or lowering `boolean | undefined` to externref. Either is a value
  representation change of its own.

### Left open (found while testing, not in this slice)

- `s?.toUpperCase()` with `s: string | undefined` returns `undefined` for a defined `s`, identifier or call
  receiver alike, on base and head (plain `s: string` is correct). Not diagnosed; a likely suspect is the string arm
  of `compileOptionalCallExpression`, which takes the native-string lowering only under `ctx.fast` and otherwise
  looks for a `string_*` import.
- `b?.toString()` with `b: bigint | undefined` throws on base and head.
