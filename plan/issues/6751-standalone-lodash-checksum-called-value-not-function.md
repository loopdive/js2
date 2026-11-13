---
id: 6751
title: "standalone lodash: after module init, the perf checksum (`words(text).length + kebabCase(text).length`) throws `called value is not a function`"
status: done
completed: 2026-10-16
sprint: current
created: 2026-09-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6736, 6713, 6732, 4586]
---

# #6751: lodash standalone-dynamic fails in the checksum phase

## Problem

After [#6736](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6736-standalone-fnctor-prototype-length-reads-number),
lodash 4.18.1's `runInContext` module init completes in `--target standalone`
with 0 imports. The first call to the perf export then throws:

```
checksum THROW: TypeError: called value is not a function
```

Measured 2026-09-29 on `0aeb5733bb` + #6736. The steps:

1. Build the unoptimized binary:
   `npx tsx scripts/generate-npm-compat-report.mjs --only lodash --no-write --perf-only --lane standalone-dynamic --inspect-binary .tmp/lodash.wasm`
2. Instantiate it with `{}`.
3. Call `__module_init()`, which returns normally.
4. Call `__npmCompatStandaloneDynamic(1, 4381)`, which throws the error above.

The sample op is `words(text).length + kebabCase(text).length`.

The lane itself still reports `optimization-error`. That is the O4
`Flatten.cpp:231` abort, followed by the `--skip-pass=flatten` retry, and it is
tracked separately in
[#6732](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6732-standalone-axios-o4-no-flatten-retry-exceeds-timeout).
This issue covers only the runtime link, which the unoptimized binary
exposes.

## Direction

`words` → `asciiWords` / `unicodeWords` use `string.match(reAsciiWord)`, and
`kebabCase` → `createCompounder` → `arrayReduce(words(deburr(string).replace(reApos, '')), callback, '')`.
Either the match of a realm-aliased `RegExp` (#6713 carriers) or a callback
reached through `arrayReduce` is the likely non-callable. Bisect with
`globalThis.__probeStep` markers inside the two entry points, then reduce.

## Root cause located — 2026-10-05

Measured on `b6324ee6d1` + the #6736 re-land + #6861. Module init now
completes, and the checksum throws from `__call_m_words_1` →
`__extern_method_call` on the receiver `__pkg`. `__pkg` itself is wrong, not
`words`.

A probe driver over the same lodash file answers:

- `typeof __pkg` is `"object"`, not `"function"`;
- `__pkg.words`, `__pkg.kebabCase` and `__pkg.map` are not functions;
- `__pkg._ !== __pkg`;
- `Object.keys(__pkg).length` is not above 100.

So the default import is an empty `exports` object. lodash's export never
reached it.

Reduction: a CJS file imported by default from an ES driver, standalone,
0 imports.

```js
;(function() {
  var freeExports = typeof exports == 'object' && exports && !exports.nodeType && exports;
  var freeModule = freeExports && typeof module == 'object' && module && !module.nodeType && module;
  function lodash(v) { return v; }
  lodash.words = function (s) { return s.split(' '); };
  var _ = lodash;
  if (freeModule) { (freeModule.exports = _)._ = _; freeExports._ = _; }   // lodash.js:17251
}.call(this));
```

| Export statement | `pkg.words` callable |
|---|---|
| `module.exports = _;` | yes |
| `(freeModule.exports = _)._ = _;` (the alias `freeModule === module`) | **no**: the import sees the empty `exports` |

`freeExports` and `freeModule` are both truthy in both runs. The write goes
through an alias of `module`, and the CJS interop does not see it, apparently
because it only recognises the literal `module.exports` spelling. Even with
`module.exports = _`, `typeof pkg` reads `"object"` instead of `"function"`,
which is a smaller second defect.

Next step: make the default import read the real `module.exports` slot after
the CJS body runs, so that any write path, aliased or not, is observed.

## Implementation Plan

Measured 2026-10-16 on `ee58c1aa26`: lane still `runtime-error`, phase
`checksum`, `TypeError: called value is not a function`. The reduction above
reproduces with 0 imports.

Mechanism: `src/cjs-rewrite.ts` wraps a CJS file in a prelude
(`let __cjs_default_export = {}; const exports = __cjs_default_export;
const module = {};`) and rewrites only the literal `module.exports` spelling
to `__cjs_default_export`. lodash writes `freeModule.exports = _`, where
`freeModule` aliases `module`, so the write lands on the throwaway `module`
object and the default export stays the empty `exports` object.

Fix (host-free targets only, so the JS-host binary stays byte-identical):

1. `CjsRewriteOptions.aliasedModuleExports`. When it is set and `module` is
   read as a value anywhere other than `module.exports` (`moduleIsAliased`),
   seed `const module = { exports: __cjs_default_export }` and append
   `if (module.exports !== exports) __cjs_default_export = module.exports;`
   before the existing `export { __cjs_default_export as default }`.
   A direct `module.exports = X` is still rewritten to the cell, so it leaves
   `module.exports === exports` and the footer does nothing.
2. `ModuleResolver` (`src/resolve.ts`) owns the rewrite that `compileProject`
   feeds into `compileMultiSource`. It sets the option for every target except
   `gc`. The later rewrite in `compileMultiSource` is a no-op on an already
   rewritten source, so `src/compiler.ts` is left unchanged.

Acceptance: the reduction returns `words = 3`, `typeof pkg === "function"`
and `pkg._ === pkg` in standalone mode. The lodash standalone-dynamic lane
measures with a matching checksum. The gc binary of the reduction is
byte-identical.

## Resolution

Implemented as planned (`src/cjs-rewrite.ts`, `src/resolve.ts`). Regression
test: `tests/issue-6751-cjs-aliased-module-exports.test.ts`. The aliased case
and the rewrite unit check fail on the parent. The literal
`module.exports = _` control passes on both.

| Lane (standalone-dynamic) | before | after |
|---|---|---|
| lodash | `runtime-error` (checksum, `called value is not a function`) | `measured`, checksum 54 = 54, ratio 0.034, 2,814,757 B |
| lodash-es | `measured`, checksum 54, 5,300,194 B | `measured`, checksum 54, 5,300,194 B (ESM, not affected) |

The gc binary of the reduction has the same SHA-1 before and after
(`c5a85411…`).

Scoped standalone test262 ran on base and on the fix: `language/module-code`
(all rows) plus the two `dynamic-import/namespace/*own-property-keys-sort.js`
rows, 601 rows in total. These are the only test262 files that contain a CJS
surface token, and only inside comments. Both runs gave 368 pass, 188 fail,
41 compile_error and 4 skip, with the same non-pass set row for row.
