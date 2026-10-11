---
id: 6879
title: "S3-h part C: acorn and prettier on the native regime — a `for…in` key read that dereferences null, and a closure that fails Wasm validation"
status: in-progress
assignee: ttraenkler/opus-6879
created: 2026-10-06
updated: 2026-10-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: npm-compat
goal: architecture
sprint: current
parent: 6749
related: [5385, 6749, 6875, 6876]
loc-budget-allow:
  # 2026-10-07 (#6879): each fix lands next to the helper it repairs —
  # object-runtime.ts (boundary own-presence arm for __hasOwnProperty /
  # __object_hasOwn), native-strings.ts (string-bridge memory growth),
  # declarations.ts (`export { f }` boundary signature), runtime.ts (regime
  # carrier-bag reads/keys in the JS view). Mostly doc comments; no new
  # module was warranted.
  - src/codegen/object-runtime.ts
  - src/codegen/native-strings.ts
  - src/codegen/declarations.ts
  - src/runtime.ts
func-budget-allow:
  # 2026-10-07 (#6879): +2, the two `recordExportListSignature` call lines.
  - src/codegen/declarations.ts::collectDeclarations
---

# #6879 — the last two npm-compat regime rows that are not react

Re-measured 2026-10-06 evening on main (after #6875, #6876, #6748):
**marked and lit now measure** on the regime lane. Two rows remain
(`--only <pkg> --perf-only --lane js-host-native`):

| package | regime diagnostic |
| --- | --- |
| acorn | `TypeError: Cannot access property on null or undefined at 438:67` — `tests/dogfood/.acorn/package/dist/acorn.js:438`: `for (var opt in defaultOptions) { options[opt] = opts && hasOwn(opts, opt) ? opts[opt] : defaultOptions[opt]; }` (`getOptions`): a `for…in` over a module-scope object literal, then computed reads with the loop key |
| prettier | `emitted WebAssembly failed validation — Compiling function #2012:"__closure_538" failed: type error in fallthru[0] (expected (ref null 38), got (ref 2))` |

Both compile and run on the host lane; prettier compiles on standalone (the
regime's extra boundary wiring is the difference), acorn is the same code
standalone runs in the dogfood harness.

## Plan

**acorn.** Reduce to `const defaults = { a: 1, b: 2 }; export function get(opts) { const o = {}; for (const k in defaults) o[k] = opts && hasOwn(opts, k) ? opts[k] : defaults[k]; return o.b; }` called from JS with `{ a: 5 }` and with `undefined`, under `semanticProviders: "native-first"`, `platform: "node"`. Candidate causes, in order of likelihood: (1) the `for…in` key arrives as a host string externref and the computed read `defaults[k]` on the regime does not treat it as a key (the receiver arm of #6875 covers strings as RECEIVER; the key side goes through `__str_equals` / `__str_to_number` and a boundary-string key may miss), (2) `hasOwn(opts, k)` on an admitted boundary object with a native-string key, (3) `opts && …` short-circuit typing. Fix at the emitter, focused test, byte identity for default gc / standalone / wasi.

**prettier.** `__closure_538` fails validation only on the regime: a closure body whose fallthrough value is a non-null `(ref 2)` where the signature wants `(ref null 38)` — a dispatcher/callee type mismatch of the #6710 family (`closureDispatchParamType`, `widenNonDefaultableTypes`), now on the RESULT side. Compile prettier's entry alone with `emitWat: true, emitWatOnlyFunctions: ["__closure_538"]` (the generator's `--inspect-wat` plumbing exists for cookie; reuse it), identify the source closure, reduce, and fix the result widening (the closure's declared result type after widening vs the value the body produces). Byte identity for default gc / standalone / wasi.

## Acceptance

- [ ] acorn and prettier `measured` on `jsHostNative` with the host lane's checksum.
- [ ] Focused tests for both reductions on the regime; the standalone result unchanged.
- [ ] `check:host-import-policy` 0 legacy / 0 unknown.

## Progress — acorn (2026-10-07, opus-6879)

**acorn measures on `jsHostNative`: checksum 422 = 422** (ratio 0.086,
`--only acorn --perf-only --lane js-host-native`, interpreter eval engine).
Before: `optimization-error` locally under load, `runtime-error` at 438:67 on
the issue's measurement. Four independent regime gaps, each reduced and
covered by `tests/issue-6879-regime-acorn.test.ts` (3 of 4 cases fail on base; the standalone control passes on both):

1. **`hasOwn` on an admitted JS object answered 0.** `__hasOwnProperty` /
   `__object_hasOwn` sent every non-`$Object` receiver to the carrier-bag
   consult, which never sees a JS object. New non-`$Object` arm
   (`boundaryOwnPresenceArm`, object-runtime.ts): a receiver that is not a
   Wasm value (`ref.test eq` fails) asks the boundary gOPD and answers 1 iff the
   returned descriptor is admitted (null = not mine, the undefined box = absent).
   No new import. Why gOPD and not `__boundary_object_has`: `has` is
   `Reflect.has` (prototype-inclusive); own-presence must not see
   `Object.prototype.toString`.
2. **`export { parse }` had no boundary signature.** Only `export function`
   reached `recordExportSignature`; the export-list and `export default <id>`
   paths pushed the Wasm export without one, so the regime adapter passed the
   options object raw (never admitted → every read missed) and the input string
   un-marshalled. `recordExportListSignature` (declarations.ts) records it,
   gated on `native-first` + `jsValueBoundary` so the host lane keeps its raw
   pass-through and bytes.
3. **Strings over 32,767 code units trapped in the string bridge.** The bridge
   memory is one page; `__str_to_mem` refused the oversize write silently and
   the Wasm copy loop then read out of bounds (acorn parses its own 226 KB
   bundle). `growStrMemFor` (native-strings.ts) grows the memory before each
   copy in `__str_from_extern` / `__str_to_extern`; gated on
   `hostStringBridgeUsable` (host-free lanes never emit the bridge's host side).
4. **A returned fnctor instance's expandos were invisible from JS.** On the
   regime, `node.body = []` lands in the native carrier bag; the JS view
   (`_resolveHostField` / key enumeration in runtime.ts) only consulted
   `__sget_<field>` and the host sidecar, so `program.body` read undefined.
   A native-regime module exports `__extern_get` / `__object_keys` (the host
   lane imports them), so the view now falls back to them for closed structs
   (`src/runtime/native-regime-view.ts`; runtime.ts keeps only the call sites,
   +3 lines). Host lane untouched.

`plan/audit/host-import-policy-baseline.json`: `maximumImports` 426 → 446 and
`maximumRuntimeTsLines` 20220 → 20221. The +20 is one `boundary-object`
value-adapter import (`__boundary_object_is_admitted`, now referenced by the
hasOwn arm) in each of the 20 probes that link the object runtime; legacy 0 /
unknown 0 unchanged. The gOPD-only alternative (test the descriptor for "not a
Wasm value") is not sound: when a module has no dynamic export signature the
host's absent-key answer is a raw JS `undefined`, which is also "not a Wasm
value".

Byte identity (sha256 on `.tmp/sha-probe.mts`: hasOwn loop, export list,
closures, class, JSON/Object.keys): default gc `329b4f43…`, standalone
`14567243…`, wasi `5cad58c1…` identical base vs change; regime changes by
design.

Found on the way, NOT fixed here (follow-ups):
- `new F(...).m()` (method call directly on a `new` expression) and
  `new this(...).m()` in a static method drop the receiver on standalone and
  the regime — `this.x` reads undefined inside `m`. Cause:
  `resolveReceiverStruct` (fnctor-escape-gate.ts) maps only identifier uses and
  property accesses, never a `NewExpression` receiver, so the call falls to the
  tail closure dispatch (no `this`). acorn itself is unaffected (its path goes
  through the approved-fnctor dynamic dispatch).
- A concise arrow `e => Object.keys(e)` returning into a typed `string[]`
  return null-derefs on standalone (externref → vec guarded cast, no
  conversion); block-body `return` is fine.
- `typeof console === "object" && console.warn` on the regime: `console` as a
  value is unbound ("console is not defined" / null). acorn only reaches it
  without `ecmaVersion`. Part of the host-global re-key slice.
- compileProject + `platform: "node"` on the getOptions/Parser reduction:
  `dynamic array length fill requires a pre-reserved Hole global`
  (vec-length-hole-fill.ts) — a codegen error on a small fnctor program.
