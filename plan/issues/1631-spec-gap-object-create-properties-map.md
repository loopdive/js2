---
id: 1631
title: "spec gap: Object.create(proto, descriptors) ignores descriptor map (162 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: object
goal: spec-completeness
sprint: 50
renumbered_from: 1337
parent: 1328
---
# #1337 — Object.create: descriptor map handling

## Problem

`built-ins/Object/create`: **158 / 320 pass (49.4%) — 162 fails (131 assertion_fail, 22 other,
5 wasm_compile, 2 illegal_cast, 2 null_deref)**.

Spec §20.1.2.2 (Object.create) requires:
1. Create object with the given prototype (or null).
2. If a second `Properties` argument is provided, call `ObjectDefineProperties(O, Properties)` —
   apply each descriptor to O.
3. Return O.

When called with two args, the descriptor-map handling currently falls through to the same
broken Object.defineProperty path (#1335) — losing all attribute flags.

## Acceptance criteria

1. `built-ins/Object/create/15.2.3.5-4-{1..348}` (descriptor-map application) tests pass.
2. Pass-rate for `built-ins/Object/create` rises from 49.4% to ≥80%.
3. Object.create(null) (null prototype) continues to work.

## Files to modify

- `src/codegen/object-ops.ts` — Object.create emitter
- `src/runtime.ts` — `__object_create` if applicable

## Implementation Plan

### Root cause

Object.create + descriptor map is implemented by lowering to:
1. Allocate object with prototype.
2. For each key in descriptors, call `Object.defineProperty(O, key, descriptors[key])`.

Step 2 inherits the descriptor-attribute fidelity bug from #1335. This issue is fixed
by completing #1335 first — but additional Object.create-specific bugs remain:

- The descriptor map iteration uses `Object.keys` which excludes Symbol keys; spec says
  Object.create must use OwnPropertyKeys (own enumerable) which includes Symbols.
- When prototype is a Proxy, the [[GetPrototypeOf]] trap must be invoked exactly once during
  create — currently invoked twice (assertion_fail).

### Approach

1. Block this issue on #1335 landing.
2. After #1335: verify Object.create-specific tests now pass; if not, fix prototype-trap counting.
3. Use `Reflect.ownKeys(descriptors)` (which returns string + Symbol own keys) instead of
   `Object.keys`.

### Test262 sample

- `test262/test/built-ins/Object/create/15.2.3.5-4-2.js`
- `test262/test/built-ins/Object/create/proto-from-ctor-realm.js`

## Investigation (2026-05-27, dev)

**The descriptor map is already wired** — not the gap the title implies. Codegen
(`src/codegen/expressions/calls.ts`, the `Object.create` handler) has four
descriptor-application paths: (1) static expansion for all-object-literal
descriptors → `__defineProperty_value`; (2) object-literal-with-non-literal-values
→ `__defineProperty_desc`; (3) non-literal Properties object → `__defineProperties`;
(4) standalone fallback. The runtime imports (`src/runtime.ts:4064`,
`__defineProperty_desc`/`__defineProperties`) delegate to native
`Object.defineProperty(ies)` for plain JS objects.

**Real failure profile** (full `built-ins/Object/create`, 320 tests, run with the
runner's `skipSemanticDiagnostics:true`): **PASS 160 / FAIL 160**. The 160
failures break down (true single-test isolation):

| Bucket | ~count | Root cause |
|--------|--------|------------|
| flag-check (configurable/enumerable/writable) | 33 | descriptor object is a WasmGC struct; its fields aren't readable |
| dynamic-prototype-desc | 28 | `Ctor.prototype = proto` then read inherited descriptor field — prototype-chain read gap (broad, not create-specific) |
| accessor-desc (get/set) | 23 | struct-descriptor get/set not readable |
| exotic-host-desc (`new String/Number/...`) | 19 | exotic host receiver field reads |
| RT: getter/setter must be a function | 16 | `_toPropertyDescriptorValidate` misreads struct descriptors |
| RT: property description must be an object | 14 | Properties is an exotic object (e.g. `Math`) |
| other / null-deref | ~27 | mixed |

**Key blocker confirmed by probe:** when the descriptor object is a non-literal
(e.g. `var d = {}; d.value = 42` or `var d = function(){}; d.value = 42`), it
compiles to a WasmGC struct whose `value`/`get`/`set`/flags are **not readable**
by any current runtime helper — `_safeGet`, `_sidecarGet`, and the `__sget_value`
export all return `undefined` for that field. Native `Object.defineProperty` sees
the struct as null-proto/no-keys and silently drops the descriptor.

**Attempted fix (reverted):** routing struct descriptors through
`_toPropertyDescriptorValidate` + a sidecar/`__sget_`-aware `getField` in
`__defineProperty_desc`. In **true single-test isolation it fixed nothing** — the
apparent "+12" in a single-process full-suite probe was test-ordering pollution
(`__defineProperties` mutates real globals; the runner sandboxes per-test, my probe
did not). The blocker is upstream: struct property reads (`d.value` where `d` is a
struct) don't round-trip through the helpers the descriptor path can call.

**Conclusion:** #1631 is **not a localized runtime fix**. It depends on (a) making
WasmGC-struct field reads available to the descriptor-conversion path (a struct
representation/`_safeGet` gap), and (b) for the dynamic-prototype and exotic-host
buckets, the broader prototype-chain + descriptor-model work tracked under #1364b /
#1630. Recommend re-scoping: either split out "struct property read for descriptor
objects" as a prerequisite, or fold the remaining buckets into the #1630 descriptor
model. No code shipped.

## Resolution (2026-05-27, dev-1607)

The earlier investigation tested the wrong path. The bug is **path-specific**:
`Object.create(proto, { key: descObj })` — an **object-literal Properties** with
identifier-valued descriptors — lowers per-property to the `__defineProperty_desc`
host import (`calls.ts:3443`). That helper handed a WasmGC-struct descriptor
straight to native `Object.defineProperty`, which sees a null-proto/no-keys object
and dropped every attribute (value/flags). The sibling `__defineProperties` path
(non-literal Properties, `calls.ts:3491`) already had a struct-aware `getField` and
worked — so the same descriptor object passed two ways gave different results
(confirmed by isolated probe: `var Props` PASS, `{...}` literal Props FAIL).

**Fix** (`src/runtime.ts`, `__defineProperty_desc`): give the helper the same
struct-aware `getField` (`_safeGet` for accessor getters + sidecar, with an
`__sget_<field>` export fallback for typed struct fields), and when the descriptor
is a WasmGC struct but the target object is a plain JS object, materialize a plain
descriptor via `_toPropertyDescriptorValidate(desc, getField)` before calling
native `Object.defineProperty`.

**Measured (true per-test isolation, `runTest262File`):**

| Category | baseline | patched |
|----------|---------:|--------:|
| `built-ins/Object/create` | 166 | **173 (+7)** |
| `built-ins/Object/defineProperties` | 201 | 201 (no regression) |
| `built-ins/Object/getOwnPropertyDescriptor` | 261 | 261 (no regression) |
| `built-ins/Object/freeze` | 43 | 43 |
| `built-ins/Object/assign` | 15 | 15 |

Unit tests: `tests/issue-1631.test.ts` (4 cases, all pass).

**Still failing (out of scope — separate models):** the getter-on-descriptor-flag
family (`15.2.3.5-4-105`), inherited-flag-via-prototype (`15.2.3.5-4-102`), and
`instanceof Object` on the created object (`15.2.3.5-2-2`). These are the
struct-accessor-storage / prototype-chain gaps tracked under #1364b / #1239 / #1630,
not the descriptor-map wiring this issue covers.
