---
title: "npm-package compat testing — 2026-05-20"
date: 2026-05-20
author: product-owner
type: report
---

# Compat testing report — 2026-05-20

Goal: stress-test the js2wasm `compile()` entry against representative
patterns drawn from popular npm packages and harvest issues from any
compilation gaps. Methodology: write 5-20 minimal TS snippets per
package covering its dominant style, compile each, classify failures
by root cause, file one issue per cluster.

Baseline: `main` @ v0.52.0 (commit a3341c78c), 28,171/43,160 test262
passes (65.3 %). All snippets and the batch driver are checked in
under `.tmp/compat-2026-05-20/` (gitignored). Per `CLAUDE.md` no
source files were touched.

## Headline

The compiler is in excellent shape on real-world TypeScript. Across
**67 snippets in five packages and three thematic batches**, the only
material failure cluster is **JSX parsing**. Filed:

| # | Title | Severity |
|---|---|---|
| **#1522** | JSX syntax is not parsed when compiling `.tsx`/`.jsx` input | medium |

## Results by package

### lodash — 12/12 pass
`map`, `filter`, `reduce` (both method-form and from-scratch impls),
`groupBy`, `debounce` (closure with `setTimeout`/`clearTimeout`),
method chaining, `pick`, `uniq` (via `Set`), `cloneDeep` (via
`JSON.parse/stringify`). The functional-iteration vocabulary that
defines lodash is fully supported.

### typescript (syntax) — 15/15 pass
Enums (numeric + string), namespaces, interfaces, generic classes,
discriminated unions, `keyof typeof`, `as const`, mapped types,
conditional types, type guards, function overloads, decorators
(`@logged`), tuple types, abstract classes. All compile.

### react — 0/12 pass — **all blocked on JSX parser**
`<div/>`, attributes, expression children, fragments
(`<>…</>`), components, spread attrs, JSX-in-`map`, JSX with hooks,
conditional JSX, event handlers, prop typing, children. Every snippet
fails at parse time with the same class of errors:

```
'>' expected.
Unterminated regular expression literal.
Cannot find name 'div'.
```

Root cause (confirmed by reading `src/checker/index.ts:275-291`):
- `analyzeSource` forces `ScriptKind.TS` regardless of `.tsx`
- `compilerOptions.jsx` is never set

Filed as **#1522**. Companion issue #1033 ("Compile React to Wasm")
assumed JSX would arrive pre-transpiled — but for raw `.tsx` input
(the natural source for React/Preact/SolidJS users) the parser must
be told to accept JSX.

### hono — 7/7 pass
Basic `Hono` app shape (Map-backed router), context interface, async
middleware with `await next()`, path-param parsing with `split`,
`HResponse.json` static factory, method chaining (`.get().post()`),
async handler with `Promise.resolve`. The full HTTP-handler vocabulary
compiles.

### eslint — 8/8 pass
Visitor pattern (`{NodeType: handler}` dispatch), full ESLint Rule
object shape (`meta`/`create`), Linter class with rule registration,
scope analysis with parent chain, generator-based tokenizer (with
`Generator<T>`, `Array.from`), `String.replace` with named-capture
regex, `SourceCode` line-splitting, multi-severity reporter. The
AST-walker/visitor vocabulary works in full.

## Additional thematic batches

To probe for hidden gaps beyond the requested five packages, I ran
two further batches drawn from common library-source idioms:

### Edge cases — 20/20 pass
Spread in call (`add(...args)`), rest+spread arrays, object spread,
tagged templates, destructure with defaults, async generators with
`for await`, private class fields (`#n`), getter/setter, custom
`[Symbol.iterator]`, Promise chains, BigInt (`100n + 200n`), regex
named groups, `??`, `?.`, class static initializer blocks
(`static { … }`), Error subclassing, `instanceof`, `Array.from(gen())`,
`Map` `for…of` destructuring, string iteration.

### Library-source idioms — 20/20 pass
IIFE module, module-pattern singletons, `Symbol.for('react.element')`,
`Object.create(proto)`, `Object.defineProperty`, `Object.keys` loop,
`Array.of`, `Array.prototype.slice.call`, `Function.prototype.bind`,
`WeakMap` cache, thenable shape unwrapping, dedent tag, range
generator spread, `Promise.all`, `Promise.race`, `Array.sort(cmp)`,
`Object.assign`, `Array.reduceRight`, custom `toString` in template
literal, mixed Set/Map iterable spread.

## Failure-cluster classification

| Cluster | Severity | Examples | Issue |
|---|---|---|---|
| JSX parser gap (TSX/JSX ScriptKind + `compilerOptions.jsx`) | medium | all 12 react snippets | **#1522** |

No other cluster. Across 67 snippets exercising lodash/TypeScript/Hono/
ESLint/edge/library-source vocabularies there is exactly one root
cause to file.

## Notes for next sprint

1. **#1522 (JSX parsing)** is small and well-scoped. Splitting it
   into "accept JSX syntax" (parser fix) and "compile JSX runtime
   calls" (codegen / host-import) gives a 1-issue / 2-PR shape that
   maps cleanly onto a sprint slot. Step 1 is feasibility=easy.
2. **#1033 (Compile React to Wasm)** should cross-reference #1522 as
   a prerequisite for "feed raw `.tsx` to `compile()`" but is not
   blocked if React is pre-transpiled by `tsc`/`esbuild`.
3. **No other compat issues uncovered** — the compiler handles a
   strikingly broad slice of modern TS. Future compat sweeps should
   move beyond compile-only and exercise *runtime* behaviour
   (correctness against V8) on these same snippets, where surprises
   are more likely.

## Artifacts

- Snippet JSON files: `.tmp/compat-2026-05-20/{lodash,typescript,react,hono,eslint,edge,nasty,libsrc}.json`
- Batch driver: `.tmp/compat-2026-05-20/batch.mjs`
- All gitignored per `CLAUDE.md` `.tmp/` convention.
