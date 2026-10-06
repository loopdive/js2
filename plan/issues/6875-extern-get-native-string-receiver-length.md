---
id: 6875
title: "`__extern_get` has no native-string receiver arm: `.length` on a dynamically typed string reads undefined on standalone and on the native regime (hono `input.length`)"
status: done
completed: 2026-10-06
assignee: ttraenkler/fable
created: 2026-10-06
updated: 2026-10-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: strings, dynamic-ops
goal: architecture
parent: 6749
related: [5385, 6749, 6868, 6686]
loc-budget-allow:
  # 2026-10-06 (#6875): +3 lines in index.ts — the import and the two
  # finalize calls of the new string-receiver arm (arm lives in its own file).
  - src/codegen/index.ts
coercion-sites-allow:
  # 2026-10-06 (#6875): the arm classifies the KEY with the same three helpers
  # the string-exotic wrapper arm and the vec numeric-key arm already use
  # (canonical-numeric-string test, boxed-number unbox); no new ToNumber matrix.
  - src/codegen/extern-get-string-receiver.ts
func-budget-allow:
  # 2026-10-06 (#6875): +1 line each, the finalize call in both module builders.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #6875 — dynamic `.length` on a native string via `__extern_get`

## Problem

hono's npm-compat driver (`app.routes.length + input.length`, `input`
untyped) reads `Wasm 1, Node 9` on the regime lane: `input.length` is
`undefined`. Reduced (2026-10-06):

```js
// untyped .mjs, compileProject; any lane that carries native strings
export function len(input) { return input.length; }
export function probe() { return len(JSON.parse('"abcd"')) == 4 ? 1 : 0; }
```

| lane | `probe()` / `len("/users/1")` |
| --- | --- |
| `--target standalone` | `probe()` → **0** |
| native regime, JS env (`wrapCompiledExports`, arg marshalled by `__str_from_extern`) | `len` → **undefined** |
| default gc (host `__extern_get`) | 8 |

The same source with an internal literal call site (`len("abc")`) is fine:
call-site inference specialises the parameter to `(ref $AnyString)` and emits
`struct.get`. A TS `(input: unknown)` with `(input as any).length` is also
fine: that site emits an inline `ref.test (ref $AnyString)` + `__extern_length`
arm. The failing shape is an `externref` parameter (untyped JS, `any`) whose
member read goes `__carrier_recv_to_extern` → `__extern_get(recv, "length")`.

Traced on the regime: `__extern_get` tests the receiver for the `$Object`
struct, misses, calls `__boundary_object_get` (returns null — correctly not
admitted), then walks instance / vec / closure / proto arms and answers the
undefined miss. **No arm tests the receiver for `$AnyString`.** The
`ref.test (ref $AnyString)` at the top of the helper is on the KEY (`local 1`),
not the receiver. Standalone and regime build the identical helper
(`object-runtime.ts` `buildObjectGetBody`, patched by the `unshiftExternGet*`
arms), so this is a pre-existing standalone gap the regime merely exposes
through real packages.

Also seen: a TS function `function lenAny(input: any) { return input.length }`
compiles to a bare `unreachable` body under standalone (`.tmp/any.wat`,
2026-10-06) — a silent demote worth its own look while here.

## Fix

Add a native-string RECEIVER arm to `__extern_get` (first thing after the
`$Object` test misses, before the boundary/instance arms), mirroring what the
inline site does: `any.convert_extern(recv)` `ref.test $AnyString` → key
`"length"` → `__box_number(f64(__str_len))`; canonical numeric key → the code
unit (the string-exotic arm already does this for WRAPPER objects — reuse its
index parse); otherwise fall to the `String.prototype` member lookup the
native proto machinery exposes (`__str_proto_get` or whatever the `unknown`
site uses). Keep `__extern_has` / `__extern_set` consistent (has: `"length"`
and in-range index → 1; set: refuse, strings are not extensible). Byte identity
for default gc is automatic (host helper). Standalone output changes
deliberately: equivalence gate + a focused test.

## Acceptance

- [x] The reduced `probe()` is 1 on standalone; `len("/users/1")` is 8 on the regime.
- [x] hono measures on `jsHostNative` with the host lane's checksum
      (`--only hono --perf-only --lane js-host-native`).
- [x] Focused test covering `length` and index through an untyped parameter
      (`String.prototype` members through a dynamic receiver stay on their
      existing path — follow-up).

## Progress (2026-10-06)

`src/codegen/extern-get-string-receiver.ts` `unshiftExternGetNativeStringReceiverArm`
(called from both finalize paths in `index.ts`, next to the string-exotic
wrapper arm): receiver `ref.test $AnyString` → `length` (shared
`stringWrapperLengthArm`), canonical numeric-string key, and boxed-Number key
(the vec arm's integral/non-negative classifier) → code unit; other keys fall
through. `tests/issue-6875-extern-get-native-string-receiver.test.ts` green
(standalone `probe()` 1; regime `len` 8, `at` "u", `routes` 9). Default gc and
wasi byte-identical (sha `a0b48272…` / `b8758b0b…` base = after); standalone
changes by design (`ef908e07…` → `403fea55…`).

**hono still reads `Wasm 1, Node 9` on the lane.** Every replica of the
driver compiled in the same project computes 9 — `both`, `bothNum`,
two-level (`mid → both`), three-level with non-exported callees
(`three → mid2 → innerOp`), `__`-prefixed names — but the literal
`__npmCompatPerf → __npmCompatApply → Number(__npmCompatPackageOperation(input))`
chain in the same file returns 1, i.e. `Number("1")` of `1 + ""`: in that
chain `input.length` evaluates to the empty string, not undefined and not 8.
Next: dump the WAT (`optimize: false`, `wasm-opt -all --print`) of
`__npmCompatApply` and `mid2` side by side; the difference is in how that one
chain lowers the parameter (specialisation from a single dynamic call site vs
the externref path this arm fixes).

### Resolution of the hono residual (2026-10-06, later)

The literal chain differed from every replica by one thing: the export's
NAME. `wrapExports` (`src/runtime.ts`) passed any `__`-prefixed export through
raw ("unmarked internal helper") unless it had a Boolean boundary — and the
npm-compat drivers export `__npmCompatPerf(input)`. On the regime the string
therefore arrived un-marshalled, `input.length` read `""`, and
`Number(1 + "")` is 1; redux's `Number(input)` on the raw string was the
`NaN`. The rule is now "unmarked = carries no signature": a user export keeps
its adapter whatever its name (host-lane semantics unchanged; such exports
gain the wrapper's call overhead there). Re-measured on the regime lane:
**hono measured** (ratio 0.178), **redux measured** (ratio 0.054). Focused
test extended with a `__perf(input)` export. Pre-existing reds on base,
unrelated: `issue-3426` ×2, `issue-4397` object-rest.
