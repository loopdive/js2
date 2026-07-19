---
id: 3401
title: "standalone: URI carrier routing gap — #2500 native decode/encodeURI* landed but 48 conformance tests still leak env::decodeURI"
status: done
assignee: ttraenkler/fable-dev-4
completed: 2026-07-18
created: 2026-07-18
updated: 2026-07-18
priority: high
horizon: m
feasibility: medium
model: opus
reasoning_effort: high
task_type: fix
area: codegen, standalone
language_feature: uri-functions
goal: standalone-mode
umbrella: 2860
related: [2500, 863, 2961]
loc-budget-allow:
  # (#3401) +27 LOC in extern-declarations.ts: the standalone/wasi native-skip
  # is extended from parseInt/parseFloat to the URI family + escape/unescape
  # (which have standalone natives since #2500/#3063/#3064), plus a load-bearing
  # explanatory comment on WHY the leak was context-dependent (libReferencedNames).
  # The added logic belongs on this collector arm (it IS the extern-declaration
  # skip list); there is no separate subsystem module for it.
  - src/codegen/extern-declarations.ts
origin: "2026-07-18 fable-dev-4 #2860 re-measurement — #2500 (native URI carrier) is done, yet 48 official built-ins/{decode,encode}URI* tests still emit env::decodeURI/... host imports (host_import_leak). The carrier exists but is not dispatched for these call shapes."
---

# #3401 — standalone URI carrier routing gap

## Problem

#2500 shipped Wasm-native `decodeURI` / `encodeURI` / `decodeURIComponent` /
`encodeURIComponent` (status `done`), and #863 closed the earlier decode/encode
failures. Yet the fresh 2026-07-18 standalone lane baseline shows **48 official
`built-ins/{decodeURI,decodeURIComponent,encodeURI,encodeURIComponent}/*`
conformance tests still fail with `error_category: host_import_leak`**, leaking
exactly one of:

```
env::decodeURI  env::decodeURIComponent  env::encodeURI  env::encodeURIComponent
```

Since #2961, any standalone binary emitting an `env::*` host import is a hard
`compile_error` — so these are host-pass but standalone-CE. The native carrier
EXISTS (#2500); the compiler is simply **not routing these call sites to it**
under `--target standalone`. This is a dispatch/gate regression or an
incomplete-coverage gap, not a missing-carrier problem.

## Measured cohort (2026-07-18, official scope, host pass ∧ standalone leak)

| dir | rows (approx) | leaked import |
| --- | ---: | --- |
| `built-ins/decodeURI/*` | ~14 | `env::decodeURI` |
| `built-ins/decodeURIComponent/*` | ~13 | `env::decodeURIComponent` |
| `built-ins/encodeURI/*` | ~11 | `env::encodeURI` |
| `built-ins/encodeURIComponent/*` | ~10 | `env::encodeURIComponent` |

Sample files: `built-ins/decodeURI/S15.1.3.1_A2.4_T1.js`,
`built-ins/decodeURIComponent/S15.1.3.2_A2.5_T1.js`,
`built-ins/encodeURI/S15.1.3.3_A1.2_T1.js`,
`built-ins/encodeURIComponent/S15.1.3.4_A1.2_T1.js`. These are the `S15.1.3.*`
spec-conformance families (`A1` malformed-URI throws, `A2` reserved-char
round-trips, `A3` unescaped-set boundaries) — i.e. they exercise the URI
functions across many argument shapes, so the un-routed shape is likely a
GENERAL call form the conformance harness uses, not one exotic edge.

## Investigation entry points (Opus dev: START here — measure before coding)

1. **Reproduce.** Compile a minimal `export function test(){ return
   decodeURI("%41") === "A" ? 1 : 0; }` with `--target standalone` and inspect
   `WebAssembly.Module.imports`. Then try the shapes the conformance tests use:
   - `decodeURI` called with a computed / non-literal arg,
   - `decodeURI` referenced as a VALUE (`var f = decodeURI; f(x)`),
   - the test262 harness wrapper (`export function test(){…}`) — the #3178/#3386
     lesson: the wrapper flips routing (module-scope vs nested). **Bisect which
     shape leaks** exactly as #3386 did (module-scope HOST-FREE vs wrapped LEAK).
2. **Find the routing site.** Grep the URI builtin dispatch:
   `grep -rn "decodeURI\|encodeURI\|__uri\|percent" src/codegen/ src/runtime.ts`.
   #2500 registered the natives (likely in `object-runtime.ts` /
   `registry/imports.ts` and a call-expression fast-path in
   `expressions/` builtin-call dispatch). Identify the gate that decides
   native-vs-host: it is almost certainly an `ensureLateImport(ctx,
   "decodeURI", …)` path that resolves to the `env::` import instead of the
   registered native `funcMap` entry when the call arrives via the generic
   global-call fallback rather than the recognised builtin fast-path.
3. **Confirm the class.** The 4 names share one dispatch; a single missed
   fast-path arm (e.g. the value-reference form, or the
   `__get_builtin("decodeURI")` dynamic-read path) plausibly explains all 48.
   Verify by re-measuring per-name after the fix.

## Implementation plan

- Route ALL four URI call forms to the #2500 native funcMap entries under
  `ctx.standalone || ctx.wasi`, mirroring how the recognised fast-path already
  does it. The likely fix is the same shape as the #2963 `__get_builtin`
  reification / the #1907 "builtin-as-value" refusal: ensure the global-call
  fallback AND the value-reference read resolve `decodeURI` etc. to the native
  defined func rather than `ensureLateImport(..., "env::decodeURI")`.
- If the leak is `ensureLateImport` registering the host import in standalone
  (the #2029/#2961 anti-pattern), gate it: in `ctx.standalone`, resolve to the
  native `funcMap.get("decodeURI")` (register via the #2500 path if absent) and
  NEVER add the `env::` import — identical to how `__extern_get`/`__box_number`
  route native in standalone.
- Keep the host (gc) lane byte-identical (the `env::` import is the correct
  fast path there) — gate every change on `ctx.standalone || ctx.wasi`.

## Test plan

- `tests/issue-3401.test.ts`: for each of the 4 functions, compile under
  `--target standalone`, assert `WebAssembly.Module.imports` contains no
  `env::*URI*`, instantiate with `{}`, and assert the decoded/encoded value +
  the malformed-URI `URIError` throw (the `A1` family). Use BOTH the
  module-scope and the `export function test(){…}` wrapper shapes (the routing
  seam).
- Re-measure the standalone JSONL cohort: the ~48 `built-ins/*URI*` rows flip
  from `host_import_leak` CE to pass; zero host-mode regression; standalone
  high-water floor (`check-standalone-highwater.mjs`) rises.

## Regression risks

- The value-reference form (`var f = decodeURI`) may share a dispatch with the
  #2963 builtin-reification lane — coordinate so the fix doesn't double-register
  the native func (funcMap idempotency).
- `URIError` construction in standalone must use the in-module error
  constructor (`emitWasiErrorConstructor`, as `buildDestructureNullThrow` does),
  not a host `__throw_*` import, or the malformed-URI `A1` tests will re-leak.

## Root cause (CONFIRMED) + fix (fable-dev-4, 2026-07-18)

The investigation-first plan above hypothesised a value-reference / call-shape
dispatch gap. The ACTUAL root cause is narrower and upstream of the call site:

**`collectExternDeclarations` (`src/codegen/extern-declarations.ts:~686`)** walks
every ambient `declare function` the user references and registers it as an
`env.*` host import. It had a standalone/wasi skip for `parseInt`/`parseFloat`
(which have WasmGC natives) but **no equivalent skip for the URI family**
(`decodeURI`/`decodeURIComponent`/`encodeURI`/`encodeURIComponent`, native since
#2500) nor `escape`/`unescape` (native since #3063/#3064). So in standalone this
pass registered `env::decodeURI` FIRST; the URI finalize in
`import-collector.ts` (`collectURIImports finalize`) then hit its
`if (ctx.funcMap.has(name)) continue;` guard and **skipped `emitNativeUriDecode`**
— the call site fell through to the leaked `env::decodeURI` import (a
`host_import_leak` CE under #2961).

**Why it was context-dependent** (and why #2500 shipped green): the registration
is gated on `libReferencedNames.has(name)` (extern-declarations.ts:656). A bare
`decodeURI("%41")` on its own does NOT put `decodeURI` in that lib-referenced
set, so the leak did not reproduce in isolation. But an unrelated builtin in the
same module — `String.fromCharCode`, `new Error`, … (which the S15.1.3.* URI
conformance tests all use) — drags `decodeURI` into `libReferencedNames`,
triggering the early `env::decodeURI` registration. Bisected live: `return
decodeURI("%41")` is host-free, but `decodeURI("%41") === String.fromCharCode(65)`
leaks. Confirmed the exact branch with a `funcMap.has("decodeURI")` probe in the
URI finalize (`true` in the leak case, `false` in the clean case) and an
`addImport` stack trace pointing at `collectExternDeclarations`.

**Fix** (one-liner, mirrors the parseInt/parseFloat precedent): extend the
standalone/wasi native-skip in `collectExternDeclarations` to
`decodeURI`/`decodeURIComponent`/`encodeURI`/`encodeURIComponent`/`escape`/
`unescape`, so the finalize owns their native emit. Gated on
`ctx.wasi || ctx.standalone` → host (gc) lane byte-identical (still uses the
`env.*` import). `escape`/`unescape` were carrying the identical latent leak and
are fixed in the same change.

### Files
- `src/codegen/extern-declarations.ts` — extend the native-skip name set.
- `tests/issue-3401.test.ts` — 7 cases, each co-locating a sibling builtin
  (String.fromCharCode / new Error) with the URI/escape call: host-free import
  set + correct decoded/encoded value + native `URIError` on malformed input.

### Validation
- `tests/issue-3401.test.ts` — 7/7 green (all 4 URI fns + escape + malformed-URI
  URIError + the loop/helper module shape).
- No regressions: issue-2500-uri-encoding, issue-3063-escape-unescape-host,
  parseint-edge, issue-2160-number-parse (28 tests). `tsc --noEmit` clean.
- Expected flip: the ~48/52 official `built-ins/{decode,encode}URI*`
  host_import_leak rows → pass (plus any escape/unescape siblings), zero
  host-mode change.
