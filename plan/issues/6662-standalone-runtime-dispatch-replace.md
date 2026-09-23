---
id: 6662
title: "standalone String.prototype.replace/replaceAll with runtime-only search or replacement values (hono, marked, moment, styled-components)"
status: done
sprint: current
created: 2026-09-23
completed: 2026-09-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: compiler
goal: standalone
related: [1474, 1539, 1913, 4016, 4224, 4620, 6651, 6665]
loc-budget-allow:
  # 2026-09-23 (#6662): the two dispatch sites live in these god-files and
  # nowhere else — the #1474 refusal in `compileNativeStringMethodCall` and the
  # `#1913 follow-up` refusal in `tryCompileStandaloneStringReplace`. Each gains
  # a 2-3 line call into the new satellite `string-replace-dynamic.ts` (which
  # holds the whole mechanism) plus one import line; regexp-standalone.ts also
  # turns three private helpers into exports (no line cost).
  - src/codegen/regexp-standalone.ts
  - src/codegen/string-ops.ts
func-budget-allow:
  # 2026-09-23 (#6662): +3 lines — the runtime-dispatch call must sit
  # immediately before the #1474 refusal it replaces, inside the dispatcher.
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
---

# #6662 — standalone replace/replaceAll with runtime-only operands

## Problem

In `--target standalone`, `String.prototype.replace` / `replaceAll` was lowered
only when the compiler could PROVE the operands' shape at compile time: a static
RegExp, a string or plain-`ToString` search value, a proven closure or a proven
non-callable replacement. Any operand the checker could not classify — every
`any` in an untyped `.js` npm package — hit a compile-time refusal:

- `Codegen error: String.prototype.replace(...) with a RegExp or symbol-protocol search value is not supported in --target standalone (#1474)`
- `Codegen error: standalone RegExp engine does not support replace with a function (or non-string) replacer (#1913 follow-up) (#1539 Phase 2a)`

One refusal fails the whole module, so this was the FIRST diagnostic of the
npm-compat **standalone-dynamic** lane for hono, marked, styled-components
(`#1474`) and moment (`#1913 follow-up`). The call sites (from the lane probe):

| package | site | shape |
| --- | --- | --- |
| hono | `utils/url.js:28`, `reg-exp-router/trie.js:27` | `paths[j].replace(mark, groups[i][1])` — both operands `any` |
| moment | `moment.js:628/633` | `output.replace(/%d/i, number)` — static RegExp, `any` replacement |
| styled-components | `esm.js` ×4 + stylis `A(e,r,a){return e.replace(r,a)}` | `new RegExp(tpl,"g")` + arrow replacer, `replaceAll(s, "")` with `s` any, fully dynamic |
| marked | `marked.esm.js` ×21 | rules-table RegExps (`other.x`, `edit(...).getRegex()`) typed `any`, dynamic flags + function replacers |

## Implementation Plan

What was executed (new satellite module `src/codegen/string-replace-dynamic.ts`):

1. **One runtime helper per module**, `__str_replace_dyn(subject, searchValue,
   replaceValue, isAll) → string`, minted on first use (stable handle, both
   arms built with `captureInto`, the first kept in `ctx.liveBodies` while the
   second is emitted so late-import shifts rewrite it).
2. **RegExp arm** — `ref.test $__StandaloneRegExp` on the search value. For
   `replaceAll`, §22.1.3.20 step 2.b first (`Get(flags)`, TypeError without
   `"g"`). Then the generic §22.2.6.11 `RegExp.prototype[@@replace]` body the
   reflective proto glue already uses (`emitRegExpSymbolReplaceBody`, with
   `emitRegExpBuiltinExecFromLocal` — now exported — as the builtin exec). This
   gives runtime `g`/`y`/`u` flags, `lastIndex` reset/advance, `$`-patterns and
   the functional replacer `(matched, ...captures, position, S)` via
   `__apply_closure`, with no new host import.
3. **Object arm** — §22.1.3.19 step 2 proper for a non-RegExp Object:
   `GetMethod(searchValue, @@replace)` via `__extern_get` + `__box_symbol(8)`;
   when present, `Call(method, searchValue, «string, replaceValue»)`, result
   `ToString`ed.
4. **String arm** — `ToString(searchValue)`; a callable replacer
   (`__is_callable`) runs a per-occurrence
   `Call(replaceValue, undefined, «searchString, position, string»)` loop
   (replaceAll advances by `max(1, len)`, empty-search terminates at
   `from > len`); otherwise `ToString(replaceValue)` into the existing native
   `__str_replace` / `__str_replaceAll` GetSubstitution helpers (#1822).
5. **Two call sites**, each taken only where the old lowering REFUSED (so every
   call that compiled before is byte-identical):
   - `string-ops.ts` `compileNativeStringMethodCall`, immediately before the
     #1474 refusal (`symbolProtocolArgForm` for replace/replaceAll);
   - `regexp-standalone.ts` `tryCompileStandaloneStringReplace`, immediately
     before `tryRefuseHostFreeRegExpReplacer`, via `tryCompileRuntimeReplacer`
     (replacement neither `isStringLikeArg` nor `isPlainToStringReplacement`).
     A STATIC pattern with named groups keeps the refusal: the runtime exec
     result carries no `groups` object yet.
6. Standalone only (`ctx.standalone && usesNativeRegExpProvider &&
   hasStandaloneRegExpEngine`); WASI and every JS-host lane are untouched.

## Resolution

Measured on this branch vs its parent `upstream/main` 9b1ba0d19f.

**Regression test** `tests/issue-6662-standalone-dynamic-replace.test.ts`:
parent 2 passed / 24 failed of 26 (the 2 passing are the controls: a typed
string replace mints no helper, and a static named-group pattern keeps its
refusal); fix 26 / 26. `tests/es5-standalone-replace-fn.test.ts` flips its
"object search value still refuses" case to assert the correct `@@replace`
dispatch.

**npm-compat standalone-dynamic lane** (`generate-npm-compat-report.mjs --only
<pkg> --perf-only --lane standalone-dynamic`), before → after:

| package | before | after |
| --- | --- | --- |
| hono | compile-error `replace … #1474` | compile-error `String.prototype.match(...) … #1474` (+ `Array.prototype.flat` #2717) |
| marked | compile-error `replace … #1474` | compile-error `String.prototype.search(...) … #1474` (+ match/split dynamic RegExp) |
| moment | compile-error `replace … #1913 follow-up` | compile-error `String.prototype.match(...) … #1474` |
| styled-components | compile-error `replace … #1474` | **compiles**; optimization-error: wasm-opt validation failure in `re` (hoist-statics helper, `call $oe` param mismatch) |

Every replace/replaceAll diagnostic is gone from all four packages (probe: marked
56 → 13 errors, hono 19 → 15, moment 6 → 4, styled-components 23 → 15, all 15 of them
host-import-leak warnings, no errors).

**Scoped standalone test262** (local vitest shards, `TEST262_TARGET=standalone`,
parent vs fix, identical set of 218 unique files): every `built-ins/String/prototype/replace/`,
`replaceAll/` and `RegExp/prototype/Symbol.replace/` file (172) plus the 12
baseline `compile_error` rows whose source uses `replace`/`Symbol.replace` and a
seeded sample of 40 `compile_error` rows whose harness (`temporalHelpers.js` /
`testIntl.js`) uses `replace`:

| | pass | fail | compile_error |
| --- | --- | --- | --- |
| parent | 144 | 22 | 52 |
| fix | 144 | 27 | 47 |

No pass→non-pass flips. The five `compile_error → fail` rows are exactly the
residuals below (3 `replaceAll/searchValue-*` overridden-`@@replace` rows, 2
`named-groups/groups-object-subclass*`). The 39 harness-sample rows stay
`compile_error` for unrelated reasons (a first loaded run showed them as
`compile_timeout` at load average ~40; re-run in isolation: 39/39
`compile_error`, as on the parent).

## Residuals

- A RegExp INSTANCE whose own `@@replace` is overridden (`defineProperty(re,
  Symbol.replace, …)`, a RegExp subclass method) still runs the builtin body:
  the symbol read on a `$__StandaloneRegExp` carrier is not wired
  (`replaceAll/searchValue-replacer-call`, `-RegExp-call-fn`,
  `-tostring-regexp`: compile_error → fail).
- A RegExp built at runtime hands `$<name>` / a replacer no `groups` object
  (`named-groups/functional-replace-*`, `groups-object-subclass*`:
  compile_error → fail when reached through a runtime-only search value).
- [#6665](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6665-standalone-string-methods-dynamic-regexp-value)
  (filed in parallel for lodash/lodash-es/prettier) covers the same refusal for
  `replace`/`split`/`match`/`search`; this issue lands its `replace`/`replaceAll`
  slice, the other three methods remain there.
- The remaining lane blockers are other clusters: dynamic `match`/`search`/
  `split` search values (#1474 siblings), `Array.prototype.flat` (#2717), and
  the styled-components `re` validation failure.
