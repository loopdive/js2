---
id: 7013
title: "dogfood: standalone lane for the npm upstream unit suites — `JS2WASM_UPSTREAM_TARGET=standalone` compiles every upstream suite's test modules with `--target standalone`, instantiates them with an EMPTY import object, runs the harness compiled in, and reports passed/total per suite beside (never over) the JS-host numbers"
status: done
sprint: current
created: 2026-10-16
updated: 2026-10-17
completed: 2026-10-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: infra
language_feature: dogfood, npm-compat
goal: standalone-gap
related: [7016, 7017, 7018, 7019, 7020, 7021, 7022, 7025, 6999]
---

# Standalone lane for the npm upstream unit suites

Every upstream suite (`tests/dogfood/<pkg>-upstream-suite.mjs`, through
`tests/dogfood/upstream-suite-runner.mjs` → `compileAndRunUpstreamModule` →
`upstream-suite-compile-worker.mjs`) compiled and ran on the JS-host lane only
(`target: "gc"`, a host import object, `wrapExports`), so `npm-compat.json`
`tests.passed/total` are JS-host numbers. Under the standalone-only policy
(2026-10-10) the same suites must be measurable with `--target standalone`.

## Implementation Plan

1. **Where the boundary goes (decided with evidence).** The assertion harness
   (`UPSTREAM_TEST_SHIM`: expect / vi / jest / QUnit / describe/it, plus each
   package's own shim — uvu `assert`, cookie snapshots, uuid's `assert`) is
   plain JavaScript that is ALREADY concatenated into each generated test
   module. Compiling it into the standalone binary therefore costs nothing and
   needs no host. Measured on clsx (`lite.js`, 5 tests): standalone binary with
   the harness compiled in, **0 imports**, 5/5. So: harness compiled in; the
   only host↔Wasm contact is a numeric, test-only export set.
2. **The numeric boundary** (`standaloneHarnessExports` in
   `tests/dogfood/upstream-standalone-lane.mjs`), appended to the generated
   module only in the standalone lane:
   `upstreamStandaloneCount()`, `upstreamStandaloneStart(i)` (→ 1 pass, 0 fail,
   2 pending), `upstreamStandaloneOutcome()`, and
   `upstreamStandaloneSelectText(kind, i)` + `upstreamStandaloneTextCharCode(at)`
   to read test names / failure messages one UTF-16 unit at a time (WasmGC
   strings, arrays and promises are opaque to the host). It wraps the shim's
   existing `runUpstreamTest(i)`, so sync and async tests run the same body.
3. **Async without a host loop.** A pending test is settled by calling the
   compiler-emitted `__drain_microtasks` export (the module's own native
   Promise job ring) until `__microtasks_pending()` is 0. A test still pending
   after that waits on host time/I/O and is reported as such.
4. **No host imports.** `instantiateStandaloneResult` refuses (never stubs) any
   import other than Wasm-to-Wasm package links (`js2wasm:npm:*` provider
   namespaces and the shared `env.__exn` tag of a linked project); a refusal is
   recorded as `compile.hostImports` + a `host-import:` runtime failure.
5. **Node `assert` is harness.** prettier/axios assert through `node:assert`;
   the standalone lane rewrites `assert` / `node:assert` / `node:assert/strict`
   specifiers in the generated TEST module (never package code) to the
   compiled-in `tests/dogfood/standalone-node-assert.js`.
6. **Opt-in, JS-host untouched.** `JS2WASM_UPSTREAM_TARGET=standalone`
   (`gc`/unset = today's lane). With it unset the generated module bytes, the
   compile options, the report shape and the report path are exactly as
   before; the standalone report is written beside it as
   `report/<pkg>-upstream-suite.standalone.json`. uuid and react have their own
   compile paths and got the same boundary (uuid: the `node:test` `t.mock`
   context is compiled in; react: lifted test functions dispatched by index).
7. **Reporting.** Not wired into `npm-compat.json` here — see Resolution.

## Resolution

Implemented as planned.

- `tests/dogfood/upstream-standalone-lane.mjs` — lane selection, compile
  overrides (`target: "standalone"`, `runtimeEvalProvider: false`), the
  numeric boundary, zero-import instantiation (linked projects included), the
  microtask drain, trap rendering (`renderHarnessThrownText` + innermost Wasm
  frame names), and the test-module rewrite.
- `tests/dogfood/standalone-node-assert.js` — compiled-in `node:assert`.
- `upstream-suite-runner.mjs` / `upstream-suite-compile-worker.mjs` — the
  shared lane; `uuid-upstream-suite.mjs`, `react-upstream-suite.mjs` — their
  own paths.
- Regression test `tests/dogfood/upstream-standalone-lane.test.ts` (fails on
  the parent: the module does not exist). Anti-vacuity: the suite contains
  failing tests (a sync `toEqual`, an async rejection, a `node:assert`
  failure) that must fail in standalone Wasm with their own messages, and the
  JS-host lane's generated module must be byte-identical to the input.

JS-host lane unchanged (`JS2WASM_UPSTREAM_TARGET` unset, before = upstream/main
`ee58c1aa26`, after = this branch):

| suite | before | after |
| --- | --- | --- |
| uuid | 75/75 | 75/75 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| redux | 76/82 | 76/82 |

### Standalone measurements (2026-10-16, one suite at a time)

Command per suite: `JS2WASM_UPSTREAM_TARGET=standalone node --import tsx
tests/dogfood/<pkg>-upstream-suite.mjs`, one suite at a time on a shared box
(load 40–150). Reports: `tests/dogfood/report/<pkg>-upstream-suite.standalone.json`
(not committed). react and uuid re-measured 2026-10-17 after their last lane
edit; the rest 2026-10-16. JS-host column = `npm-compat.json` `tests`
(generatedAt 2026-10-15T19:43Z).

| suite | standalone | JS host | dominant standalone failure cluster |
| --- | --- | --- | --- |
| uuid | 41/75 | 75/75 | no entropy source (`crypto is not defined`, 15) → [#7016](./7016-standalone-upstream-host-import-leak.md); TypedArray construction saturates + `Uint8Array.of(...u8)` invalid Wasm (sha1/v5, v1) → [#7018](./7018-standalone-typed-array-construction-touint8.md) |
| clsx | 32/32 | 32/32 | — |
| cookie | 114/63740 | 63740/63740 | the 63,528-test stringify file times out: expando writes on closed literals land in the quadratic `$ClosurePropEntry` registry; tuple rows read through `any` fail `Array.isArray` → [#7020](./7020-standalone-literal-expando-bag-quadratic-tuple-isarray.md) |
| moment | 9/10 | 10/10 | `Date.UTC is not yet implemented in --target standalone` (1) |
| redux | 58/82 | 76/82 | deep-equality false negatives (`toEqual` mismatch, `any.length` on closed structs reads 0) → [#7017](./7017-standalone-any-length-closed-struct-number.md); 1 file refused for `env.__node_vm` → #7016 |
| lodash | 55/62 | 60/62 | `strictEqual`/`deepEqual` mismatches (7) |
| marked | 0/30 | 30/30 | `illegal cast` in `__call_m_use_1` (every Hooks test) → [#7021](./7021-standalone-call-m-dispatch-illegal-cast-marked.md) |
| axios | 44/231 | 219/231 | host imports (`__node_util/types`, `hasSymbolShams`, …) refuse 10 files → #7016; module init derefs null (`utils.toObjectSet`) → [#7019](./7019-standalone-module-init-traps-cjs-graphs.md) |
| hono | 32/324 | 294/324 | Web platform host imports (atob/btoa, Blob/FormData/File, fetch, crypto.subtle) refuse 9 files; `Request is not defined` (54) → #7016 |
| jest | 185/356 | 344/356 | Node builtins (`__node_os`, `__node_util/types`, `__node_path`) refuse 7 files → #7016; `Cannot destructure null` (18) |
| prettier | 51/151 | 111/151 | package code imports `node:assert` / `node:url` → host import, 8 files refused → #7016 |
| react | 0/180 | 150/180 | every batch refused: the compiled-in React shim reaches jsdom (`env.DOMImplementation_createHTMLDocument`) and host-installed React infrastructure → [#7025](./7025-standalone-react-upstream-harness-host-infra.md) |
| tailwindcss | 13/13 | 13/13 | — |
| jsdom | 1/6 | 6/6 | `called value is not a function` (5) |
| styled-components | 6/9 | 9/9 | `toEqual` mismatch (3) → #7017 |
| stylelint | 85/108 | 108/108 | `illegal cast` in `__module_init` (3 files) → #7019; assertion mismatches |
| webpack | 14/16 | 16/16 | `toStrictEqual` mismatch (2) |
| three | 0/18 | 17/18 | the math unit pulls WebGL renderer constants → host imports → #7016 |
| typescript | 6/14 | 11/14 | module init `ReferenceError: Buffer is not defined` (5); null property access (3) |

Total: 746/65,457 scored standalone (clsx and tailwindcss pass fully; cookie's
63,740 dominate the denominator — 632/1,717 without cookie).

Reporting into `npm-compat.json` is left to
[#7022](./7022-npm-compat-report-standalone-unit-lane.md): running every suite
a second time inside `npm-compat-refresh.yml` roughly doubles a job that is
already longer than the merge interval (#3988), and the dashboard needs a new
field — not a small, safe change.
