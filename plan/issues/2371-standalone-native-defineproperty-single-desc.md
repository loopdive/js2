---
id: 2371
title: "standalone-native single dynamic-descriptor Object.defineProperty (__obj_define_from_desc)"
status: done
assignee: ttraenkler/sendev-date
completed: 2026-06-19
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: object
goal: standalone-mode
parent: 1906
related: [1906, 1472, 1629a, 2372, 1355]
blocked_by: [2372]
---

# #2371 — standalone-native single dynamic-descriptor define (`__obj_define_from_desc`)

Sibling of #1906 (native plural `Object.defineProperties`). Adds the
**single-property** native applier for the dynamic (non-literal) descriptor
case `Object.defineProperty(o, k, descVar)` under `--target standalone`.

## What landed (this issue)

- `src/codegen/object-runtime.ts` — new native `__obj_define_from_desc(obj,
  key, desc) -> externref`. Self-contained ToPropertyDescriptor over a
  descriptor `$Object` (mirrors host `_toPropertyDescriptorValidate` +
  #1906's per-descriptor block, EXACT spec ordering): reads
  value/writable/enumerable/configurable/get/set via
  `__hasOwnProperty`+`__extern_get`; data+accessor conflict → TypeError
  (§6.2.5.6); non-object desc → TypeError (§10.1.6); non-callable get/set →
  TypeError; dispatches to native `__defineProperty_value` /
  `__defineProperty_accessor`. Zero new host imports; TypeError via the
  `__new_TypeError` ctor + exn tag.
- `src/codegen/object-ops.ts` — `emitDefinePropertyDescRuntime` forks under
  `ctx.standalone` to call `__obj_define_from_desc` instead of the refused
  `__defineProperty_desc` host import. Host mode + inline-literal path
  untouched.

## ⚠️ 0-flip until #2372 (receiver representation)

**This banks 0 test262 on its own** and is committed as infrastructure, NOT
merged for conformance. Verified: the native define is correct — on a
`$Object` receiver (`Object.create(null)`) BOTH a dynamic **data** descriptor
(`o.x === 7`) and a dynamic **accessor** descriptor (`o.x === 9`) read back
correctly. But every `built-ins/Object/defineProperty` test uses a
`var o = {}` receiver, which the compiler represents as a **typed WasmGC
struct**. The native define writes into a `$Object`; the test's read-back
(`o.foo` / `o.hasOwnProperty`) reads the *struct* — a different object — so
0/40 sampled tests flip. The whole ~235-test cluster is gated on **#2372**
forcing the receiver onto the `$Object` representation. Once #2372 lands, this
applier flips the data/accessor define cases for free (the read-back already
composes, proven by the create(null) spike).

## Acceptance (met for the define semantics)

1. `Object.create(null)` + dynamic data desc → `o.x` reads the value. ✓
2. `Object.create(null)` + dynamic accessor desc → getter invoked on read. ✓
3. get+value conflict → catchable TypeError. ✓
4. non-object desc → catchable TypeError. ✓
5. host mode + inline-literal path unchanged. ✓

## Next

Blocked on #2372. After #2372 lands, re-measure the 235-cluster flip and
extend to `Object.create(proto, props)` (PR-2, per-key drive of the same
helper).
