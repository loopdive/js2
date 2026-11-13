---
id: 7092
title: "Regime gap: `(new Promise(executor)).constructor` reads `undefined` — the `$Promise` arm of `__extern_get` only answers then/catch/finally"
status: done
completed: 2026-10-19
assignee: ttraenkler/opus-7092-ctor-read
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: Promise
goal: architecture
sprint: current
parent: 5385
related: [7089, 7090, 6979]
---

# #7092 — `Promise.prototype.constructor` on a native promise receiver

Found while implementing #7090 (2026-10-19, native-first default in a
JavaScript environment and on standalone): a dynamic member read on a native
promise receiver — `p.constructor`, where `p = new Promise(executor)` or the
`promise` field of `Promise.withResolvers()` — evaluates to `undefined`.
The `$Promise` arm of `__extern_get` in
`src/codegen/promise-dynamic-member-read.ts` only answers `then`, `catch` and
`finally`; every other name falls through to the "no such member" result.
Under the retired `host-assisted` profile the host object answered the read.

Observable consequence: test262 rows that assert
`Object.getPrototypeOf(p).constructor === Promise` or call
`p.constructor.resolve(...)` (the species path of `Promise.prototype.then`,
`finally`) fail on every WasmGC lane; the subclass cases are #7089's scope.

## Plan

1. Measure: a `.tmp` probe compiled with `semanticProviders: "native-first"`
   (JS environment, through `wrapCompiledExports`) and with
   `target: "standalone"` reading `p.constructor`, `p.constructor === Promise`,
   `"constructor" in p`, `Object.keys(p)`; the test262 rows under
   `built-ins/Promise/prototype/` that mention `constructor` before the fix
   (standalone lane, `TEST262_PATH_FILTER`).
2. Implement in the promise provider's dynamic read: the `$Promise` arm of
   `__extern_get` answers `constructor` with the intrinsic `%Promise%` value
   (the same reference `Promise` resolves to as a first-class value), and
   `Symbol.toStringTag` with `"Promise"`; unknown names keep falling through
   to the prototype-chain walk the provider already uses for user-touched
   `Promise.prototype` members, so a user `Promise.prototype.foo = …` is still
   found.
3. Tests: a focused test under native-first and standalone comparing with
   Node; the test262 subset count before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; direct-AST freeze respected (provider/runtime code only).

## Measurements (2026-10-19)

Probe `.tmp/probe7092.mts`: `export function main(): number { <decl>; return <read>; }`,
`skipSemanticDiagnostics`, run through `buildCompiledImports` +
`wrapCompiledExports`. `<decl>` is `const p = new Promise<number>((r) => r(1))`
or `const p = Promise.withResolvers<number>().promise`; both declarations and
both lanes (`semanticProviders: "native-first"` in the JS environment, and
`target: "standalone"`) gave identical rows.

| Read | Before | After | Node |
| --- | --- | --- | --- |
| `p.constructor === Promise` | 0 | 1 | 1 |
| `typeof p.constructor === "function"` | 0 | 1 | 1 |
| `id(p).constructor === Promise` (untyped receiver) | 0 | 1 | 1 |
| `p["constructor"] === Promise` | 0 | 1 | 1 |
| `typeof p.constructor.resolve === "function"` | throws (native-first: "Cannot access property on null or undefined"; standalone: host "Cannot convert object to primitive value") | 1 | 1 |
| `p[Symbol.toStringTag] === "Promise"` | 0 | 1 | 1 |
| `Object.prototype.toString.call(p) === "[object Promise]"` | 0 (`[object Object]`) | 1 | 1 |
| `"constructor" in p` | 1 | 1 | 1 |
| `Object.getPrototypeOf(p).constructor === Promise` | 1 (static fold) | 1 | 1 |
| `Object.keys(p).length` | 0 | 0 | 0 |
| `Object.prototype.hasOwnProperty.call(p, "constructor")` | 0 | 0 | 0 |
| `p.constructor === undefined` | 1 | 1 | 0 |

The last row is a separate, pre-existing defect: the `x.m === undefined`
lowering answers 1 for any member of a native promise on base too
(`p.then === undefined` is 1 on base while `typeof p.then` is `"function"`).
It is not this arm (the value itself is now correct), so it is left out.

Prototype-modification cases (`.tmp/probe4.mts`, Node oracle in a fresh `vm`
realm), both lanes:

| Case | Before | After | Node |
| --- | --- | --- | --- |
| `Promise.resolve(3).constructor === Promise` | 0 | 1 | 1 |
| `promise.then(f).constructor === Promise` | 0 | 1 | 1 |
| `p.constructor.resolve(4) instanceof Promise` | throws | 1 | 1 |
| `(Promise.prototype).constructor = 5; p.constructor === 5` | 1 | 1 | 1 |
| own `p.constructor = 7` shadows | 1 | 1 | 1 |
| `class C extends Promise` instance `.constructor === C` | 1 | 1 | 1 |
| `defineProperty(Promise.prototype, @@toStringTag, {value: "Xy"})` then `p[@@toStringTag]` | "Xy" | "Xy" | "Xy" |
| `delete Promise.prototype[@@toStringTag]` then `toString.call(p)` | `[object Object]` | `[object Object]` | `[object Object]` |
| `p.foo`, `p[Symbol.iterator]` | undefined | undefined | undefined |
| `delete Promise.prototype.constructor` then `p.constructor === Object` | 0 | 0 | 1 |
| `p[@@toStringTag] = "Own"` then `toString.call(p)` | `[object Own]` | `[object Own]` | `[object Promise]` |

The last two rows are pre-existing and unchanged. The first needs the deleted
key to fall through to `Object.prototype`; the second is a SET-path issue
(`Promise.prototype[@@toStringTag]` is non-writable, so the sloppy assignment
must be ignored).

test262: `built-ins/Promise/prototype/**` (124 rows) plus
`built-ins/Promise/{try,withResolvers}/promise.js`, 126 rows, via
`scripts/run-test262-paths.mts`, `JS2WASM_EVAL_ENGINE=interpreter`. Default
(gc, native-first) lane run with `--isolate` (one process per row); standalone
lane in-process.

| Lane | Before | After | Flips |
| --- | --- | --- | --- |
| default gc (native-first) | 45 pass, 80 fail, 1 CE | 46 pass, 79 fail, 1 CE | +`withResolvers/promise.js` |
| standalone | 112 pass, 13 fail, 1 CE | 113 pass, 12 fail, 1 CE | +`withResolvers/promise.js` |

No row went the other way. On the gc lane 73 of the failures are
"async completion marker not observed" in both runs (this local runner's gc
async lane), and 5 rows on each lane fail on the missing local runtime-eval
provider; neither changes with this patch. `Promise/try/promise.js` stays a
compile error: the native regime has no `Promise.try` yet (`__get_builtin`
refusal), which is not this read.

Byte identity (`.tmp/hash-equiv.mts`): I took the 1,910 program literals embedded in `tests/equivalence/*.test.ts`, compiled each on gc, standalone and WASI before and after, and compared SHA-256 hashes. 0 of 5,730 binaries differ. The compile errors (151 gc, 151 standalone, 172 WASI, mostly source fragments) are the same set before and after.

Equivalence gate (`scripts/equivalence-gate.mjs`, run locally with `--configLoader runner`): 20 failing, 2,020 passing, 22 known failures in the baseline, "✓ No new equivalence regressions." Two baseline failures (`delete-sentinel`, `reflect-api` `Reflect.construct`) now pass. Every equivalence binary is byte-identical, so that is not this change; the baseline is left to main.

## Implementation notes

- **Owner.** `%Promise.prototype%`'s own surface is the promise provider's:
  the change is confined to the `$Promise` arm of `__extern_get` and its demand
  hook in `src/codegen/promise-dynamic-member-read.ts`. No direct-AST emitter
  changed (plan/method/ir-only-development-freeze.md).
- **Why the measured `Get` on `Promise.prototype` did not work as the answer.**
  The first cut answered step 3 with `__extern_get(<Promise.prototype singleton>, key)`.
  That only works when the module seeded the prototype's companion table,
  which happens only for modules that reflect on prototype members
  (`protoMemberDirty`). In a plain module the singleton has no `constructor`
  entry and the read stayed `undefined`. The final answer has two sources:
  - the live companion (`__protoidx_get_r`) when the key is seeded, or when
    the program WROTE the key onto the prototype (the existing
    `writtenMemberArm` check unseeded `then` already uses). So an overwrite or
    redefinition stays observable.
  - otherwise the intrinsic value, which nothing can have changed:
    `constructor` is the `__builtin_ctor_Promise` identity singleton (the same
    reference the bare `Promise` value read yields, #3006), and
    `@@toStringTag` is the string `"Promise"`.
- **The `%Promise%` accessor is minted at demand time, never at finalize.**
  `__promise_proto_ctor() -> externref` wraps `emitBuiltinConstructorIdentity`
  with the singleton's guarded lazy init, the same contract as
  `ensureWrapperConstructorCarriers` (#4223). The `.constructor` read may be the
  module's first use of the carrier, as in `p.constructor.resolve(…)`.
- **Key filter.** `constructor` joins the string-key ladder. `@@toStringTag`
  is recognised by the `$Symbol` carrier's id (4, the well-known id). A null
  flattened key then identifies it, so it is answered before the string ladder,
  which assumes a non-null key. With no tag arm the filter emits the
  pre-#7092 instruction sequence exactly.
- **Demand and byte identity.** `constructor` is demanded by a value read of
  `.constructor` / `["constructor"]` in a file that names `Promise`;
  `@@toStringTag` by a `[Symbol.toStringTag]` read, or by the presence of
  `__opts_symbol_tag`, which is `Object.prototype.toString`'s step-14
  `Get(O, @@toStringTag)`. The tag arm also needs the `$Symbol` carrier;
  without it no symbol key can arrive. A module with none of these emits
  exactly what it emitted before.
- **WASI** stays excluded, like the existing then/catch/finally arm, which
  gates on `!ctx.wasi`.

## Test

`tests/issue-7092-promise-constructor-member-read.test.ts` has 15 cases on
native-first (JS environment) and on standalone (zero imports asserted), each
compared with Node in a fresh `vm` realm. The cases are: constructor identity
(typed, untyped, literal key, `withResolvers`, `Promise.resolve`, a `then`
result), `constructor.resolve`, own shadowing, overwritten prototype
constructor, subclass, `[Symbol.toStringTag]`, `Object.prototype.toString`,
redefined and deleted `@@toStringTag`, and other names staying absent.
