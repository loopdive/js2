---
id: 2072
title: "standalone: String(any-boxed primitive) returns '[object Object]' — $__any_to_string doesn't recognize the boxed shape from String()/pop/catch paths"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: host-independence
related: [1836, 1470]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2072 — anyref unboxing missing in standalone String()

## Problem

```ts
const v: any = 42;  String(v)   // standalone: "[object Object]"   node: "42"
const u: any = undefined; String(u)  // "[object Object]" vs "undefined"
String(a.pop())                      // "[object Object]" vs "3"
```

Also `e.name` after catch and `String()` of property-read results. Direct
concat `"n:" + v` works — only the String()/read-result paths fail.

## Root cause

`src/codegen/native-strings.ts:5417-5582` — `$__any_to_string`
tag-dispatches on `$AnyValue`, but the boxed shape produced for
String(anyref) / pop-return / catch-binding values isn't recognized and
falls to the "[object Object]" else-arm (:5470/:5582).

## Fix direction

Normalize all any-producing paths to the `$AnyValue` shape
`$__any_to_string` expects, or teach it the second shape (ref.test chain).

## Acceptance criteria

- All repros match Node in standalone mode; host mode unchanged
- Concat paths unaffected

## Dupe check

#1759 (done, WASI bridge), #1836 (number↔string formatting only), #1470 —
none cover anyref unboxing in String(). New.

## Investigation (2026-06-11, dev-spec-b2) — deeper root cause than originally scoped

The `$__any_to_string` dispatcher is NOT the bug — the **boxing tags are
wrong**. `coerceType(from → AnyValue)` (`src/codegen/type-coercion.ts:1178+`)
picks the box helper by **Wasm ValType kind, not the JS type**:

| `const v: any = …` | lowers to | boxed via | tag | wrong? |
|---|---|---|---|---|
| `42` | f64/i32 | `__any_box_f64`/`i32` | 2/3 number | ok |
| `true` | i32 | `__any_box_i32` | 2 (number!) | yes → "1", typeof traps |
| `undefined` | externref | `__any_box_string` | 5 (string!) | yes → "[object Object]" |
| `null` | externref | `__any_box_string` | 5 (string!) | yes |
| native string (standalone) | `ref $AnyString` (eqref) | `__any_box_ref` | 6 (object!) | yes (see #2080) |

So `$__any_to_string` (and `__any_unbox_bool`, `__any_typeof`, `__any_*_eq`)
all receive the WRONG tag and dispatch incorrectly. Confirmed: the **concat**
path (`compileNativeConcatOperand` → `$__any_to_string`) ALSO returns
`"[object Object]"` for `undefined`/`null` any and `"1"` for `true` any — the
"concat works" claim only held for the number case. `typeof (true as any)`
**traps** in standalone.

Fix requires **type-aware boxing**: the `coerceType(→AnyValue)` site must
consult the source expression's static TS type to pick `__any_box_bool`
(tag 4) for booleans and emit tag-0/tag-1 boxes for null/undefined, instead of
boxing by Wasm kind. `coerceType` is called from many sites without the TS
type, so this means threading a TS-type hint through the boxing path — a
cross-cutting change to the coercion API. **Recommend senior-dev/architect**:
this is the standalone-AnyValue-representation core, same family as the
#2009/#1989 struct-shape work, not a localized two-helper fix.
