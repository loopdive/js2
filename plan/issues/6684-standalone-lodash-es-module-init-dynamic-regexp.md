---
id: 6684
title: "standalone: lodash-es module-init hits a runtime-built RegExp outside the dynamic grammar (`Unsupported dynamic regular expression pattern`)"
status: done
sprint: Backlog
created: 2026-09-26
updated: 2026-09-27
completed: 2026-09-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: RegExp
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6681, 4439, 6677, 6669, 2660, 6704, 6705]
loc-budget-allow:
  # 2026-09-26 (#6684): each file gains only the ONE-line hook into a new
  # classified module that holds the mechanism (foreign-module-global-shadow,
  # object-proto-has-own-property, object-create-value-body,
  # dispatch-extern-result-bridge) plus its import. builtin-value-read keeps
  # the `Object.create` switch case and body dispatch (+8) because the value
  # closure's ABI (param/return types) is declared in that switch.
  - src/codegen/builtin-value-read.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/identifiers.ts
  # 2026-09-27 (#6684 merge_group follow-up): calls.ts gains a one-line
  # decline (+ import) in the reflective `.call` interception so the DIRECT
  # `Object.prototype.hasOwnProperty.call(X, k)` keeps its fold; the predicate
  # lives in object-proto-has-own-property.ts.
  - src/codegen/expressions/calls.ts
func-budget-allow:
  # 2026-09-27 (#6684 merge_group follow-up): the same one-line decline.
  - src/codegen/expressions/calls.ts::tryEmitNativeProtoReflectiveCall
  # 2026-09-26 (#6684): the `Object.create` case + body arm in the builtin
  # value-closure switch, and the guarded-result fallback in the identifier
  # call dispatch ladder (both delegate to new modules).
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/expressions/call-identifier.ts::compileBoundIdentifierCall
---

# #6684 — standalone: lodash-es module-init throws on a runtime-built RegExp

## Problem

After #6681 (`Date.now` as a value), the lodash-es npm-compat
`standalone-dynamic` lane compiles with 0 imports and fails at module-init with
(verbatim):

```
TypeError: Unsupported dynamic regular expression pattern
```

That is the #4439 poisoned-`$NativeRegExp` refusal: `__regex_compile_dynamic_simple`
accepts only a narrow runtime grammar and a pattern outside it throws on first
use.

Likely site (unverified — confirm with a scoped probe before implementing):
`_baseIsNative.js` builds

```js
var reIsNative = RegExp('^' +
  funcToString.call(hasOwnProperty).replace(reRegExpChar, '\\$&')
  .replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$');
```

and module-init runs it through `getNative(Object, 'create')` →
`baseIsNative` → `reIsNative.test(...)`. The pattern carries lazy quantifiers
(`.*?`) and escaped metacharacters produced at run time. The other module-init
RegExp constructions (`_hasUnicode`, `_unicodeToArray`, `_unicodeWords`) build
large character-class patterns the same way and are the next candidates.

## Acceptance

- The lodash-es `standaloneDynamic` lane gets past module-init with 0 imports.
- Standalone `built-ins/RegExp` test262 rows do not regress.

## Re-measure after #6677 (2026-09-26)

PR #6151 (#6677, full-grammar runtime RegExp compiler) merged. On
`upstream/main` 36f92e8917 the lane no longer hits the RegExp refusal — the
`reIsNative` pattern from `_baseIsNative.js` compiles and matches (standalone
probe answers the same as Node). The lane instead stopped at a DIFFERENT
module-init throw (verbatim):

```
TypeError: Cannot access property on null or undefined at 88:12   (phase: module-init)
```

So the RegExp half of this issue is **already fixed** by #6677. This PR fixes
the chain of module-init blockers behind it.

## Implementation Plan (executed)

Each blocker was located from a `preserveDebugNames` O0 build (a temporary
`unreachable` in place of the throw gives a Wasm stack trace), then reduced to
a two-module repro.

1. **`lodash.default.js:88:12` — a function read resolved to ANOTHER module's
   same-named var.** `mixin.js` has `function mixin` + `export default mixin`;
   `lodash.default.js` has `var mixin = (function(func){…}(_mixin))`.
   `moduleGlobals` is name-keyed across the graph, so mixin.js's
   `export default mixin` read lodash.default.js's (still null) `__mod_mixin`
   cell. New `expressions/foreign-module-global-shadow.ts`: the identifier's
   module-global arm is skipped when the checker resolves the read to a
   top-level FunctionDeclaration with its own source-function handle, every
   declaration of the symbol is a FunctionDeclaration, and the name is not a
   #2931 reassigned-function live binding. Shared with JS-host (same wrong
   answer there). Mirror of #6669.
2. **`Object.prototype.hasOwnProperty is not yet implemented`.** lodash's
   `var hasOwnProperty = objectProto.hasOwnProperty; hasOwnProperty.call(o,k)`
   reached the reflective refusal closure. New
   `object-proto-has-own-property.ts`: `hasOwnProperty` /
   `propertyIsEnumerable` member bodies routing to the SAME
   `__hasOwnProperty` / `__propertyIsEnumerable` natives as the direct call,
   with the §20.1.3.2 step-2 nullish-`this` TypeError.
3. **`Object.prototype.hasOwnProperty called on null or undefined` —
   `lodash.prototype` read dynamically answered `undefined`.** Under a
   runtime-eval consumer (`_root.js`'s `Function('return this')()`) every
   top-level function is a #2931 live binding, and the #2660 M3
   function-value → prototype edge rejected every live binding.
   `closure-prototype-edge.ts`: for a function DECLARATION's cached value
   singleton, find its declaration and apply the same source-assignment scan
   instead of the blanket rejection (the singleton is the function's own
   identity; replacing the binding cannot make it name another function).
4. **`_baseCreate.js:21:14` — `Object.create` as a value.** It was the generic
   two-slot refusal closure; the one-argument call site's closure cast failed.
   New `object-create-value-body.ts` + a one-slot `Object.create` case in
   `builtin-value-read.ts`, calling `__object_create`; loud TypeError for any
   proto the native does not model exactly (primitive, `undefined`, closed
   struct literal) instead of a silent null `[[Prototype]]`.
5. **Checksum: `toString(x)` read back as `undefined`.** A JSDoc
   `@returns {string}` makes the importer expect a native string; the callee's
   runtime funcref (through the runtime-eval carrier) returns externref, and
   the dispatch ladder's dead-arm placeholder dropped the LIVE result. New
   `expressions/dispatch-extern-result-bridge.ts`: a guarded (non-trapping)
   downcast used by both ladders (`call-identifier.ts`, `calls-closures.ts`)
   on the no-host lanes — a real `T` survives, anything else still answers
   `null` as before.

## Resolution

Lane (`generate-npm-compat-report.mjs --only lodash-es --no-write --perf-only
--lane standalone-dynamic`), 0 imports throughout:

| step | lane result (verbatim) |
| --- | --- |
| main 36f92e8917 | `runtime-error` `TypeError: Cannot access property on null or undefined at 88:12` (module-init) |
| + fix 1 | `TypeError: Object.prototype.hasOwnProperty is not yet implemented in --target standalone` (module-init) |
| + fix 2 | `TypeError: TypeError: Object.prototype.hasOwnProperty called on null or undefined` (module-init) |
| + fix 3 | `TypeError: Cannot access property on null or undefined at 21:14` (module-init) |
| + fix 4, 5 | `RuntimeError: dereferencing a null pointer` (**checksum** — module init now completes) |

Next blocker filed as [#6704](6704-standalone-callable-property-optional-param-abi.md):
the harness's `__pkgNs.words(input)` property call has no dispatch arm for the
callee's real `(externref, externref, externref)` funcref (the JSDoc
`[string='']` param lowers to externref), so it ends in a null.
Found on the way and filed as [#6705](6705-cross-module-same-named-var-shares-one-cell.md):
two modules' `var x` share one module global (`35` in Node, `55` compiled).

Tests (each fails on the parent, passes with the fix — 9/9 red on the parent):
`tests/issue-6684-foreign-var-shadows-function-read.test.ts` (standalone +
gc), `tests/issue-6684-object-proto-own-predicate-value.test.ts`,
`tests/issue-6684-runtime-eval-prototype-edge.test.ts`,
`tests/issue-6684-object-create-value.test.ts`,
`tests/issue-6684-dispatch-extern-result.test.ts`.

Scoped standalone test262 (`scripts/run-test262-paths.mts --standalone`, 1,284
rows: `built-ins/Object/prototype/{hasOwnProperty,propertyIsEnumerable}`,
`built-ins/Object/create`, `language/module-code`, `language/eval-code/direct`):
parent `{ pass: 999, fail: 221, skip: 4, compile_error: 60 }`, fix identical —
the non-pass sets are equal row for row (0 losses, 0 gains).

JS-host control (`identifiers.ts` is the one shared change):
`tests/dogfood/lodash-upstream-suite.mjs` 59/62 before and after.

### merge_group follow-up (2026-09-27)

merge_group run 36285181870 parked the PR: `merge shard reports` failed the
#1897 standalone regression guard (net −122: 3 improvements, 125 wasm-change
regressions; 124 in `language/{statements,expressions}/class/elements`) and the
#2097 high-water floor (41009 < 41132 − 50). All 126 pass→other rows still
pass on main's newest standalone baseline, so this was the PR, not drift.

6. **Mechanism.** Wiring a body for `hasOwnProperty` / `propertyIsEnumerable`
   (step 2) also switched on the reflective `.call` interception in
   `calls.ts::tryEmitNativeProtoReflectiveCall` for the DIRECT spelling
   `Object.prototype.hasOwnProperty.call(X, k)`. That used to decline (the
   refusal made `ensureStandaloneNativeMethodClosure` yield nothing), leaving
   it to the #3021 introspection fold. The fold answers a class CONSTRUCTOR
   from its static surface; the runtime `__hasOwnProperty` has no
   class-object arm (#5195 R2-2), so
   `Object.prototype.hasOwnProperty.call(C, "foo")` for an instance field
   answered `true`. Fix: `objectOwnPredicateCallKeepsFold`
   (object-proto-has-own-property.ts) declines the direct form, exactly like
   the #4119 `Object.prototype.toString.call` decline. Value-erased spellings
   (`var hop = objectProto.hasOwnProperty; hop.call(o, k)`, lodash-es) still
   take the closure.

- Test: `tests/issue-6684-object-proto-own-predicate-value.test.ts` new case
  fails on the parent (`100111`), passes with the fix (`10110`, Node's answer).
- The 126 regressed rows, `--standalone`: parent 126 fail; fix 125 pass, 1 fail
  (`Temporal/PlainDateTime/prototype/since/roundingincrement-cleanly-divides.js`,
  `Temporal` undefined locally; a CI `compile_timeout` in the park run).
- Scoped standalone (264 rows: the 126 + `Object/prototype/{hasOwnProperty,
  propertyIsEnumerable}` + a 1-in-20 sample of class/elements files using the
  borrowed predicate + the park run's 3 improvements): parent
  `{ pass: 109, fail: 144, compile_error: 11 }` → fix
  `{ pass: 232, fail: 21, compile_error: 11 }`, 125 gains. Two rows go back to
  fail: `language/expressions/super/prop-{dot,expr}-obj-ref-non-strict.js`.
  They fail on main too; the parent passed them only through this same
  unintended routing (the fold misses a `super.x =` expando). No loss against
  main.
- lodash-es `standalone-dynamic` lane unchanged: `runtime-error`
  `RuntimeError: dereferencing a null pointer`, phase `checksum`, 0 imports
  (next blocker #6704). The reflective route is `ctx.standalone`-only, so
  JS-host is byte-identical.
