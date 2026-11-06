---
id: 7095
title: "Regime gap: a user `declare function` import receives the raw native string carrier — `marshalPlatformArgs` only wraps `extern_class` imports"
status: done
created: 2026-10-19
updated: 2026-10-19
completed: 2026-10-19
assignee: ttraenkler/opus-7095-marshal
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: host-interop
goal: architecture
sprint: current
parent: 6708
related: [7091, 5385, 6979]
loc-budget-allow:
  # 2026-10-19 (#7095): the bridge-export trigger lives where user
  # `declare function` imports are registered (the #6708 DOM trigger's twin),
  # and ImportDescriptor gains the documented optional `refResult` field.
  - src/codegen/extern-declarations.ts
  - src/index.ts
---

# #7095 — platform-arg marshal for declared host functions

Found by #7091 (2026-10-19). Under the native regime in a JavaScript
environment, string arguments to a host extern cross the boundary as the
native i16-array carrier and `src/runtime/platform-arg-marshal.ts`
(`marshalPlatformArgs`, from #6708) converts them to JS strings before the
host function runs. That marshal is applied only to `extern_class` imports
(DOM capabilities such as `document.createElement`). A user-declared host
function

```ts
declare function log(s: string): void;
log("hi");   // host receives an opaque Wasm struct, not "hi"
```

receives the raw carrier on both the legacy and the IR path. #7091 made the
IR claim such calls (the `string` parameter crosses as externref, as legacy
does), so the defect is now reachable from both producers and is a runtime
gap, not a lowering one.

## Plan

1. Measure: a `.tmp` probe with `declare function` imports taking `string`,
   `string[]`, a closure and a plain object, under native-first (JS
   environment, `wrapCompiledExports`) against `host-assisted`; record which
   argument kinds arrive converted and which arrive as carriers. Count the
   `tests/issue-2856-*` / `issue-3214-*` rows that exercise declared
   functions and fail today on the default profile.
2. Implement in the runtime: the import wrapper applies `marshalPlatformArgs`
   to every host import classified `platform-capability`, keyed on the
   module's declared signature (the WIT/extern-declaration metadata already
   records parameter kinds), not on the `extern_class` registration alone.
   Results that are `string` come back through the value adapter the IR
   already uses for DOM reads. Keep `extern_class` behaviour byte-identical.
3. Tests: a focused test under native-first comparing the host's received
   values with Node; re-point the affected `issue-2856`/`issue-3214` rows to
   the default profile once green.
4. Acceptance: equivalence gate "No new equivalence regressions"; no new host
   import; `check:host-import-policy` unchanged.

## Measurements (2026-10-19, base `55198833f0`)

### Corrected premises

Three assumptions in the plan did not hold. Each was measured:

1. **Declared functions are not `platform-capability`.** A user
   `declare function f` gets intent `{ type: "builtin", name: "f" }`. The host
   import policy (`classifyBuiltin`) classifies it as **`unknown`** (owner
   #4401). Consequences:
   - an explicit `semanticProviders: "native-first"` compile refuses the
     module outright;
   - `buildCompiledImports` refuses to bind it, because the native-first
     adapter rejects `unknown` imports.

   The gap is therefore reachable on the **default** profile (`{}`, which
   resolves to native-first but is not an explicit opt-in) through
   `buildImports(result.imports, deps, stringPool)`. That is the documented
   embedder FFI (#3325) and the path the tests use. This change leaves the
   classification as is: reclassifying user functions is a policy decision,
   and `check:host-import-policy` stays unchanged.
2. **No parameter-kind metadata exists at runtime.** `ImportDescriptor`
   carries only `paramCount`, and WIT is generated only on request. So
   arguments are marshalled by value: a carrier the module's own
   discriminators recognise (`__str_is_native`, the boxed-primitive probes,
   `__is_closure`) is converted, and everything else passes through. This is
   exact without a signature. Results, however, need the import's Wasm
   result type: a carrier returned into an `f64`/`i32` result is a TypeError,
   and a `boolean` result is `i32`, so #3657's predicate would break. The
   manifest therefore gains an optional `refResult: true`. It is set only on
   `builtin` imports classified `unknown` whose single result is a reference.
3. **The runtime fix alone is not enough.** JavaScript cannot read a native
   string carrier unless the module exports `__str_is_native` /
   `__str_to_extern`. Codegen exported that bridge only when a user export
   had a string at its boundary (or, since #6708, when a DOM global was
   used). A small module such as #3325's (`declare function log(s: any)`
   plus a numeric export) had no bridge, so the host still got `{}`. The
   bridge is now also exported where a user `declare function` import is
   registered (`src/codegen/extern-declarations.ts`). This applies only when
   its signature takes or returns a reference, in a native-strings module
   with a JS value boundary. `ensureNativeStringBoundaryBridge` is reused as
   is: no new export names, and never on standalone/WASI.
   `__`-prefixed stubs are excluded, because they are injected runtime
   preludes (for example `__timer_set_timeout`).

### What the host receives / returns (`.tmp/probe-7095*.mts`)

Default profile, `buildImports`, `target: "gc"`:

| crossing | before | after | host-assisted |
| --- | --- | --- | --- |
| `string` arg | opaque struct | `"hi"` | `"hi"` |
| `string` arg, `any`-typed param, no string export (#3325) | opaque struct (no bridge exported) | `"hi"` | `"hi"` |
| closure arg | opaque struct | callable, `f(1) === 2` | opaque struct (unchanged) |
| `number` arg | `42` | `42` | `42` |
| `string[]` / object-literal arg | opaque struct | opaque struct (unchanged) | opaque struct |
| `string` result | trap: null deref | `"ret"`, `.length` 3 | `"ret"` |
| `any` / `unknown` result holding a string | `[object Object]` / `typeof` object | `"ret"` / `typeof` string | same |
| `string \| null` result `"abc"` / `null` | trap / `null` | `"abc"` / `null` | same |
| `number` result `7`, `void` | correct | correct | correct |
| `number` result given `"5"` (type lie) | `5` | `5` (numeric results untouched) | `5` |
| `any` result `true` | `[object Object]` | `[object Object]` (unchanged) | `true` |
| `string \| undefined` result `undefined` | trap | trap (unchanged) | `"undef"` |
| `string[]` / object result | wrong / trap | wrong / trap (unchanged) | correct |

### Byte identity (`.tmp/hash-corpus.mts`)

The corpus is 1,707 sources: the playground examples plus every
template-literal source in `tests/equivalence`. Each was compiled for gc,
standalone and wasi (5,121 binaries), and the hashes were compared against
base.

- **Runtime + manifest change alone:** all 5,121 binaries byte-identical.
- **With the bridge-export trigger:** standalone and wasi are byte-identical.
  On gc, 13 of 1,707 sources changed, and every one of them declares an
  ambient function:
  - 7 playground benchmark files (`benchmarks.ts`, `benchmarks/{array,dom,fib,loop,string,style}.ts`)
    import `addBenchCard, el` from `./helpers.ts`;
  - 6 `multi-file-compilation.test.ts` fragments (#1/3/5/6/8/10) import
    `add`/`scale`/`double`/`quadruple`/`secret`/`multiply`.

  Compiled single-file, those unresolved imports become `declare function`
  stubs. The only difference in each binary is the three bridge exports.

### Test rows

Same 27-file set run on base and after (dom-capability-adapter, 1004, 3325,
3518 host async, 3780, 4399, 4401, provider-manifest, 4396, 6686, 6706,
playground-example, all `issue-2856-*`, all `issue-3214-*`, 3657, and the new
7095 test): **82 failed on base, 78 after. No new failures; 4 rows flipped from
failing to passing:**

- `tests/issue-3325.test.ts` › "runs the supplied dep with a string arg"
- `tests/issue-7095-declared-function-marshal.test.ts`: 3 rows. The
  "host-assisted untouched" row and the module-shape row pass on both.

No `issue-2856-*` / `issue-3214-*` / `issue-3657` row flipped, and none
needed re-pointing. None of them pins `host-assisted`; they already run on
the default profile. All of their failing rows assert IR claims (for example
`expected ['check'] to include 'Gate_check'`). Those are IR-side and fail
identically on base, so this runtime change cannot reach them.

### Left out

- Struct/vec arguments and object/array results are not given host views
  (`_wrapForHost`). host-assisted passes structs opaque as well, and a view
  proxy would break identity when the host hands the value back.
- `undefined` returned into a `string | undefined` slot, and `boolean` into
  an `any` slot, still fail. The module exports no
  `__any_box_undefined`/`__box_boolean` for those slots. This is a
  codegen-side boundary question for the dynamic bridge.
- `buildCompiledImports` still refuses declared functions on the default
  profile, because they classify `unknown` (#4401). Classifying user
  `declare function`s as an explicit platform capability is a policy change
  that would alter `check:host-import-policy`. It needs its own issue.
