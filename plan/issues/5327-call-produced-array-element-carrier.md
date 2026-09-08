---
id: 5327
title: "An array literal whose element zero is a CALL keys the whole vec to that call's closed struct, trapping at module init (prettier doc-builders 0/46)"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

# An array literal whose element zero is a CALL keys the whole vec to that call's closed struct

## Symptom

`prettier@3.8.1` `tests/unit/doc-builders.js` scored **0/46** in the Wasm lane.
Compilation and validation both succeeded; the module died the moment it was
initialised:

```
module init: RuntimeError: dereferencing a null pointer
    at __closure_374 (wasm-function[881])
    at describe    (wasm-function[265])
    at __module_init_chunk_7
```

Two neighbours share the file's shape and were on the same ticket:
`print-doc-to-string.js` 0/3 and `doc-printer.js` 0/1. **Neither is this bug** —
see "Leads that were wrong" below.

## Root cause

`compileArrayLiteral` (`src/codegen/literals.ts`) picks the vec's element
carrier from **element zero** and then guard-casts every later element into it.
#4289 added the proof that this is unsound for heterogeneous objects — but its
predicate opened with

```ts
const firstObject = unwrapObjectLiteralElement(first);
if (!firstObject) return false;          // <- bails out here
```

so it only ever ran when element zero was **written as an object literal**. The
spelling real code uses is a call:

```js
const valid = [
  group(validDoc),                       // {type, contents}
  ifBreak(validDoc),                     // {type, breakContents, flatContents}
  align("any string", validDoc),
  trim,
];
```

Element zero resolves to `$__anon_0 (struct externref externref)`, the vec
becomes `(array (mut (ref null $__anon_0)))`, and element one — a genuinely
valid `$__anon_1` with three fields — is coerced with:

```wat
struct.new $__anon_1
local.tee  $tmp
ref.test   (ref $__anon_0)
(if (result (ref null $__anon_0))
  (then local.get $tmp  ref.cast null (ref null $__anon_0))
  (else ref.null $__anon_0))          ;; <- always this arm
ref.as_non_null                        ;; <- TRAPS
array.new_fixed …
```

The `ref.test` cannot succeed, so the coercion yields null and
`ref.as_non_null` traps while the module-init chunk is still running. Every
test in the file dies with it.

Note that WasmGC struct identity is **structural**: two anonymous structs with
the same field *count* canonicalise to the same type regardless of field names.
That is why `[group(d), ifBreakTwoField(d)]` was fine and
`[group(d), ifBreakThreeField(d)]` was not — the bug is invisible until the
arities differ, which is what made it survive so long.

## Fix

`hasIncompatibleObjectLiteralCarrier` is generalised to
`hasIncompatibleElementCarrier` and moved out of the `literals.ts` god file into
a subsystem module, `src/codegen/struct-carrier-inhabits.ts`. The object-literal
arm is byte-for-byte the #4289 proof. The new arm runs when element zero is
anything else and resolves to a **closed data struct**: each later element that
also resolves to one must INHABIT element zero's carrier, walking the declared
`superTypeIdx` chain. If any does not, the vec takes the universal externref
carrier — exactly #4289's remedy.

It stays deliberately narrow:

- elements that do not resolve to a closed data struct are skipped (string,
  number and nested-vec carriers each have their own widening decision);
- string carriers (`anyStrTypeIdx` / `nativeStrTypeIdx`) and vec carriers are
  excluded from "closed data struct";
- a declared subtype passes, so `[new Shape(), new Circle()]` keeps the closed
  `$Shape` vec that #2021's subclass-ordering fix depends on;
- the existing `hasSpread` / `hasContextualRefCarrier` guards are untouched, so
  an annotated `Doc[]` literal keeps its closed representation.

The move makes the change-set a **net reduction** on every ratchet
(`loc-budget` net −45 vs `upstream/main`, `oracle-ratchet` getTypeAtLocation −1
/ ctx.checker −1 — the three duplicated
`resolveWasmType(ctx, ctx.checker.getTypeAtLocation(…))` sites collapse into one
local `carrierOf`). No budget allowance is needed.

## Known limitation, deliberately not fixed here

When the later element's field NAMES are a **superset** of element zero's
(`{type, contents}` then `{type, n, contents}`) nothing traps: the coercion
re-projects the shared fields and silently drops `n` — data loss with no
diagnostic. Widening the literal stops that at CONSTRUCTION, but it is **still
observable after this fix**, because the *binding's* slot type is independently
keyed to TypeScript's best-common-supertype inference (`{type, contents}[]`) and
the store into the module global re-narrows every element the same lossy way:

```wat
;; module-global store, unchanged by this fix
ref.test (ref $__anon_0)
(if (then ref.cast …)
    (else …rebuild from __extern_get(type), __extern_get(contents)…))  ;; `n` gone
```

Measured after the fix, two-file untyped-`.js` project:
`Object.keys(docs[1]).length` → 2 (should be 3), `doc["n"]` → undefined.

That is a **binding-slot** defect, not a literal one, and fixing it means
widening the declared vec carrier for every module global / local that holds an
array literal — a materially larger blast radius than this trap fix. The last
case in `tests/issue-5327-call-produced-array-element-carrier.test.ts` pins the
current behaviour so a future fix has a failing anchor instead of a silent
change. Prettier does not lose a test to it (`doc-builders`' `valid` array is
only asserted with `toBeDefined()`).

## Leads that were wrong

Recorded because they were handed over as likely diagnoses and each is
falsifiable from the report:

- **"`doc-builders` fails inside the test file's own `describe` callback"** —
  true of the stack frame, but the `describe` nesting is irrelevant. Bisection
  reduced the repro to two top-level statements with no `describe` at all
  (`__module_init_chunk_2` traps identically).
- **"a surviving sibling of the #5323 / #5320 closure-capture family"** — no.
  Nothing in the reduced repro captures anything; it is array-literal element
  typing. The shared string "dereferencing a null pointer" is the whole
  resemblance.
- **"`print-doc-to-string` fails at `illegal cast` in `printDocToString`"** —
  the location is right and it is a different defect (`ref.cast`, not
  `ref.test` → null), untouched by this fix and still 0/3.
- **"the four all-zero compile failures hit the deliberate #3587 async-in-`try`
  refusal"** — CONFIRMED. `get-parser-plugin-by-parser-name` (11),
  `get-printer-plugin-by-ast-format` (11), `massage-ast` (1) and
  `resolve-parser` (1) each report the `--allow-fs` refusal for
  `readFileSync` **and** "async shape not supported: this suspension point
  (await / for-await) sits inside a `try` …" from
  `src/config/prettier-config/loaders.js`. Both refusals are intentional; not
  forced.

## Result

prettier@3.8.1 admitted upstream suite:

| | base | fix |
|---|---|---|
| `tests/unit/doc-builders.js` | 0/46 | **40/46** |
| whole suite | **61/151** | **101/151** |

The 6 residual `doc-builders` failures are two unrelated families: three
`expected matching throw` (a `TypeError` the arity/`Array.isArray` guards do not
raise) and two `indentIfBreak` null-pointer traps (a member read on an
`undefined` argument traps instead of throwing a `TypeError`). Neither is array
element typing.

## A/B, one HEAD (`b08dd4589c` + this change), both arms run serially

Base arm = `HEAD:src/codegen/literals.ts`, fix arm = working copy; every suite
run bare, exit 0, `admitted` headline present. Compared per test file, not just
by headline — the per-file diff is EMPTY for all sixteen unchanged packages.

| package | base | fix |
|---|---|---|
| **prettier** | **61/151** | **101/151** |
| axios | 200/231 | 200/231 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| hono | 244/324 | 244/324 |
| jest | 299/356 | 299/356 |
| jsdom | 6/6 | 6/6 |
| lodash | 53/62 | 53/62 |
| marked | 9/30 | 9/30 |
| moment | 10/10 | 10/10 |
| redux | 64/82 | 64/82 |
| styled-components | 9/9 | 9/9 |
| stylelint | 108/108 | 108/108 |
| tailwindcss | 13/13 | 13/13 |
| three | 17/18 | 17/18 |
| uuid | 75/75 | 75/75 |
| webpack | 16/16 | 16/16 |

Targeted `tests/equivalence/` subset (18 struct/array-carrier files, 107 tests):
identical on both arms — one pre-existing `array-inline-return` compile failure,
everything else green.

## Regression test

`tests/issue-5327-call-produced-array-element-carrier.test.ts` — untyped `.js`
module behind a two-file project (`mod.js` + `entry.ts`), because annotating the
values `: any` routes the literal through a different arm and the test then
passes identically on both arms.

- parent: **2 failed / 3 passed**
- fix: **5 passed**

The three that pass on both are the guards (shared fields of a wider element,
the known limitation above, and the homogeneous + subclass carriers).
