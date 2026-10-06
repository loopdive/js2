---
id: 6875
title: "`__extern_get` has no native-string receiver arm: `.length` on a dynamically typed string reads undefined on standalone and on the native regime (hono `input.length`)"
status: ready
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

- [ ] The reduced `probe()` is 1 on standalone; `len("/users/1")` is 8 on the regime.
- [ ] hono measures on `jsHostNative` with the host lane's checksum
      (`--only hono --perf-only --lane js-host-native`).
- [ ] Focused test covering `length`, index, and a `String.prototype` method
      through an untyped parameter.
