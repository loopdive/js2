---
id: 6665
title: "standalone: String.prototype.replace/split/match/search refuse a RegExp that arrives as a VALUE (parameter, Map entry) — first blocker for lodash, lodash-es and prettier in the npm-compat standalone lane"
status: done
sprint: current
created: 2026-09-23
updated: 2026-09-24
completed: 2026-09-24
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler
goal: standalone
related: [1474, 1539, 1913, 4016, 6661, 6662, 6672, 6673]
loc-budget-allow:
  # 2026-09-24 (#6665): the whole mechanism lives in the new satellite
  # `string-regexp-dynamic.ts`. string-ops.ts: the #6662 call before the #1474
  # refusal now also serves match/search/split (+2, prettier wraps the line).
  # regexp-standalone.ts: `tryCompileStandaloneStringMatch` / `...Split` decline
  # a RegExp-typed value whose flags/pattern are runtime-only to that dispatcher
  # instead of refusing (+5 incl. comments/wrapping).
  - src/codegen/string-ops.ts
  - src/codegen/regexp-standalone.ts
func-budget-allow:
  # 2026-09-24 (#6665): +2 lines — the dispatcher call must sit immediately
  # before the #1474 refusal it replaces, inside the dispatcher.
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
---

# #6665 — standalone string methods refuse a RegExp passed as a value

## Problem

Found by [#6661](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6661-npm-compat-opaque-lane-diagnostic),
which made the npm-compat standalone-dynamic lane report its real error. For
three packages the first error is a compile-time refusal in
`src/codegen/string-ops.ts` (the `symbolProtocolArgForm` / `alwaysRegExp`
branch):

```
Codegen error: String.prototype.replace(...) with a RegExp or symbol-protocol search value is not supported in --target standalone (#1474).
```

The standalone engine only handles a **backend-created static RegExp literal**
at the call site. Library code almost never has that shape — the pattern is a
parameter or a table entry:

| package | site (standalone-dynamic lane, 2026-09-23) | shape |
| --- | --- | --- |
| lodash-es 4.18.1 | `replace.js:26` `string.replace(args[1], args[2])` | RegExp parameter |
| lodash-es | `words.js:32` `string.match(pattern)`; `split.js:49`; `truncate.js:89` (`search`) | RegExp parameter |
| lodash-es | `template.js:207` | function replacer (`#1913 follow-up`) |
| lodash 4.18.1 | same functions inside `lodash.js` (replace, split, search, match) | RegExp parameter |
| prettier 3 `standalone.mjs` | `replaceAll` polyfill `e.global?this.replace(e,t):this.split(e).join(t)`; `e.match(po.get(t))` (RegExp from a `Map`) | RegExp parameter / Map value |

Measured with `npx tsx scripts/generate-npm-compat-report.mjs --only <pkg> --no-write --perf-only --lane standalone-dynamic`
(lodash 100 s, lodash-es 304 s, prettier 18 s to the refusal).

## What a fix needs

A runtime dispatch on the search value, in Wasm: if it is a native RegExp
object, run the pure-WasmGC matcher (#1539) with its runtime `source`/`flags`;
otherwise ToString it (the #4016 plain-string path). The refusal becomes the
fallback only for a genuine Symbol.replace/Symbol.split protocol object.

## Acceptance criteria

- A two-file untyped `.js` fixture whose exported function forwards a RegExp
  parameter to `replace`, `split`, `match` and `search` compiles and runs
  under `--target standalone` with results equal to Node.
- The lodash, lodash-es and prettier standalone-dynamic lanes move past this
  refusal (their next error, if any, is recorded here).

## Implementation Plan

What was executed (built on #6662's `string-replace-dynamic.ts`, merged as PR
#6054). New satellite module `src/codegen/string-regexp-dynamic.ts`:

1. **One runtime helper per method, minted on first use** (stable handle, every
   late native registered and flushed before an index is captured):
   `__str_match_dyn(subject, value) → externref`,
   `__str_search_dyn(subject, value) → f64`,
   `__str_split_dyn(subject, separator, limit) → externref`.
2. **RegExp arm** — `ref.test $__StandaloneRegExp` on the value, then the
   generic `RegExp.prototype[@@match/@@search/@@split]` body the reflective
   proto glue already uses (`emitRegExpSymbol{Match,Search,Split}Body` over
   `emitRegExpBuiltinExecFromLocal`). Runtime `g`/`y`/`u` flags, `lastIndex`
   reset/restore, captures, `@@split`'s SpeciesConstructor — no second
   implementation.
3. **Object arm** — §22.1.3.x step 2: `GetMethod(value, @@X)` via
   `__extern_get` + `__box_symbol`; when present, `Call(method, value, «O[, limit]»)`.
4. **Otherwise** — match/search: `RegExpCreate(value, undefined)` through the
   runtime pattern compiler `__regex_compile_dynamic_simple` (`undefined` → the
   empty pattern, else `ToString`), then the same `@@X` body over the fresh
   RegExp; split: §22.1.3.23 steps 3-14 natively (ToUint32 limit, `ToString`
   separator, `lim = 0`, `undefined` separator, empty separator code-unit split,
   empty subject, the `StringIndexOf` walk), producing the same `$ObjVec` the
   `@@split` body returns.
5. **Call sites**, each taken only where the old lowering REFUSED:
   - `string-ops.ts` `compileNativeStringMethodCall`: the #6662 call before the
     #1474 refusal becomes `tryCompileStandaloneDynamicStringRegExpCall`, which
     keeps routing replace/replaceAll to #6662 and adds match/search/split. Any
     arity: a missing parameter is `undefined`, surplus arguments are evaluated
     and dropped (hono's `this.router.match(method, path)` reaches the string
     arm of the #2576 guarded dispatch with two arguments).
   - `regexp-standalone.ts`: `tryCompileStandaloneStringMatch` (dynamic flags)
     and `tryCompileStandaloneStringSplit` (non-static pattern) decline to the
     dispatcher instead of refusing with `#1539 Phase 2a` (marked's rules-table
     RegExps are typed `RegExp` but built at runtime).
6. Standalone only (`ctx.standalone && usesNativeRegExpProvider &&
   hasStandaloneRegExpEngine`); WASI and every JS-host lane are untouched.
   `regexp-split-protocol.ts` exports three existing helpers (no code change).

## Resolution

Measured on this branch vs its parent `upstream/main` d772cc772d (A/B by
swapping `string-ops.ts` / `regexp-standalone.ts`).

**Regression test** `tests/issue-6665-standalone-dynamic-match-search-split.test.ts`
(38 cases returning 1 exactly when the result equals Node's, plus a matchAll
control): parent 1 passed / 38 failed (the control), fix 39 / 39.
`tests/issue-682.test.ts`'s "string-pattern search refuses" case now asserts
the correct answer (`"banana".search("a") === 1`, no host import).

**Scoped standalone test262** (`scripts/run-test262-paths.mts --standalone`):
all 359 files of `built-ins/String/prototype/{match,matchAll,search,split}` and
`built-ins/RegExp/prototype/Symbol.{match,search,split}`, plus the 5 standalone
baseline rows whose error cites #1474 outside that set:

| | pass | fail | compile_error |
| --- | --- | --- | --- |
| parent | 325 | 22 | 17 |
| fix | 326 | 22 | 16 |

The 359-file slice has an identical non-pass set on both sides (these files
call the methods on typed operands the static arms already serve).
`built-ins/JSON/stringify/value-string-escape-ascii.js` goes compile_error →
pass. No pass → non-pass flips.

**npm-compat standalone-dynamic lane** (`generate-npm-compat-report.mjs --only
<pkg> --no-write --perf-only --lane standalone-dynamic`), before (parent
d772cc772d) → after (this branch, re-measured after merging upstream/main
7d94ea72bf — same blockers as before the merge):

| package | before (parent) | after (this branch) |
| --- | --- | --- |
| hono | compile-error `String.prototype.match(...) … (#1474)` | compile-error `Array.prototype.flat() is not yet supported in --target standalone/wasi (#2717)` |
| marked | compile-error `String.prototype.search(...) … (#1474)` | **compiles**; runtime-error (checksum) `Error: Infinite loop on byte: 35` ([#6672](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6672-standalone-exec-untyped-property-chain-null)) |
| moment | compile-error `String.prototype.match(...) … (#1474)` | **compiles**; runtime-error (module-init) `TypeError: Object.prototype.toString is not yet implemented in --target standalone` |
| lodash | compile-error `String.prototype.split(...) … (#1474)` | compile-error `stack-balance invariant (entry): '__closure_72' references local 327, but only 3 params + 59 locals are declared …` (pre-existing; named `'__cb_7'` before the upstream merge, also in the parent's error list — [#6673](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6673-standalone-lodash-closure-capture-stack-balance)) |
| lodash-es | compile-error `String.prototype.match(...) … (#1474)` | **compiles**; host-import-error `standalone binary retained 4 host import(s)` (`env.setTimeout`, `env.clearTimeout`, `js2wasm:runtime-eval.__runtime_new_function`, `__runtime_apply_interpreted`) |
| prettier | compile-error `String.prototype.split(...) … (#1474)` | compile-error `native generator lowering currently supports only sequential numeric yields in standalone/WASI targets (#680)` |

marked's lane prints `[object WebAssembly.Exception]`; the text above is the
payload rendered with the instance (the checksum branch passes the exports to
the renderer — recorded in #6672).

## Residuals

- `matchAll` with a runtime-only value keeps its #1474 refusal: §22.2.6.9 is a
  lazy RegExpStringIterator with no standalone carrier (the static arm's eager
  vec is not a spec iterator). None of the six packages needs it.
- A RegExp INSTANCE whose own `@@match`/`@@search`/`@@split` is overridden still
  runs the builtin body (same residual as #6662).
- A string pattern outside the runtime compiler's subset (e.g. `\d`, lookbehind)
  raises that compiler's catchable TypeError on first use
  (`match/cstm-matcher-is-null`, `search/cstm-search-is-null` stay `fail`).
- `tests/issue-1474-standalone-regex-refuse.test.ts` "throws catchable errors
  for invalid and unsupported dynamic patterns" fails identically on the parent
  (`new RegExp("a+")` no longer throws since #4439) — not touched here.
