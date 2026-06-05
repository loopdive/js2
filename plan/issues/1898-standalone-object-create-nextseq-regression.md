---
id: 1898
title: "standalone REGRESSION: __object_create struct.new omits nextSeq → invalid Wasm for all open-object programs"
status: done
created: 2026-06-05
completed: 2026-06-05
priority: critical
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen, runtime
language_feature: objects, standalone
goal: standalone-mode, host-independence
sprint: 59
related: [1472, 1196, 1837]
---
# #1898 — Standalone __object_create struct.new omits nextSeq (P0 regression)

## Symptom

Standalone test262 regressed hard immediately after #1196 (native
prototype-chain ops) merged: **28.94% → 24.76% (pass 12,481 → 10,676,
−1,805)**, with `compile_error` jumping **+5,582 (21,854 → 27,436)** and
`compile_timeout` only 10 — a real codegen break, not CI-load flake. The
default (gc) lane was unaffected. It slipped through because the standalone
lane is not a merge-gating check (`merge_group` runs only the default lane +
`quality`).

```
WebAssembly.compile(): Compiling function #N:"__object_create" failed:
  not enough arguments on the stack for struct.new (need 6, got 5)
```

## Root cause

`#1837` added a 6th field (`nextSeq`) to the `$Object` struct
(`{proto, props, count, tombstones, flags, nextSeq}`). `#1196` (commit
`c696b1ffc` "feat(#1472 Phase C): native prototype-chain ops") added the
native `__object_create` helper whose `struct.new $Object` pushed only **5**
operands (`proto, props, 0, 0, 0`) — missing the `nextSeq` push. The sibling
`__new_plain_object` already had the correct 6 operands.

Because `ensureObjectRuntime` emits **all** open-object runtime helpers
unconditionally (including `__object_create`), every standalone program that
touches the open-object runtime — even one that never calls `Object.create`,
e.g. `const o: any = {}; o["y"] = 2;` — got an invalid module. That broke the
whole standalone object-runtime surface.

Confirmed: only two `struct.new $Object` sites exist
(`src/codegen/object-runtime.ts`): `__new_plain_object` (line 332, correct)
and `__object_create` (line 1204, the broken one). #1211 (#1866 `__extern_get`
externref re-route, merged just before) touches no `struct.new $Object` — ruled
out.

## Fix

Add the missing `{ op: "i32.const", value: 0 }, // nextSeq` push to
`__object_create`'s `struct.new $Object` body so it supplies all 6 fields —
matching `__new_plain_object`. One-line fix-forward.

(PR #1195 — in/hasOwn, in CI — already carries this same fix bundled with its
feature; this is the minimal standalone-unblocking fix-forward so the −1,805
passes are restored immediately rather than waiting on #1195's larger payload.
The two are identical/idempotent and merge cleanly.)

## Test

`tests/issue-1898.test.ts` (new): a bare open-object standalone program +
`Object.create` both instantiate (empty imports) without a `struct.new` arity
error; default-gc path unaffected. A stale operand count fails at
`WebAssembly.compile`, so a green run guards every `struct.new $Object` site.

## Acceptance criteria

- [x] Bare open-object standalone program compiles to a valid module.
- [x] `Object.create(proto)` builds a valid 6-field `$Object` standalone.
- [x] Default (gc) lane unaffected.
- [x] tsc clean; new regression test green.
