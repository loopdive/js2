---
id: 5305
title: "standalone: a class's static/instance method is callable but is NOT an own property of the class object — verifyProperty fails on 218 class-elements tests"
status: ready
sprint: current
created: 2026-09-03
priority: high
feasibility: medium
reasoning_effort: medium
horizon: m
task_type: bugfix
area: codegen, runtime
language_feature: class-elements, property-descriptors
goal: standalone-mode
test262_bucket: standalone-class-elements-own-property
test262_count: 218
related: [1781, 1888, 2963, 2860]
origin: "2026-09-03 harvest of baselines-repo test262-standalone-current.jsonl (sha 998a110a): 218 official-scope standalone rows, 0 in the default lane."
---

# #5305 — standalone class methods are callable but not own properties

## Problem (measured 2026-09-03)

218 official-scope rows in the **standalone lane** fail with exactly:

```
Test262Error: m should be an own property
```

The default (JS-host) lane passes all of them — this is a pure
standalone-only gap.

| Count | Directory |
| ---: | --- |
| 108 | `language/expressions/class/elements/**` |
| 108 | `language/statements/class/elements/**` |
| 1 | `built-ins/Iterator/from` |
| 1 | `built-ins/ShadowRealm/descriptor.js` |

Samples:

- `test/language/statements/class/elements/after-same-line-static-method-static-private-fields.js`
- `test/language/expressions/class/elements/after-same-line-static-gen-grammar-privatename-identifier-semantics-stringvalue.js`
- `test/language/statements/class/elements/after-same-line-static-async-method-rs-private-setter-alt.js`

## Root cause (exact)

The message text comes from `verifyProperty` in the test262
`propertyHelper.js` harness, which fails its very first check when
`Object.prototype.hasOwnProperty.call(obj, name)` is false.

In the representative test the assertions run in this order:

```js
assert.sameValue(C.m(), 42);                                    // line 41 — PASSES
assert(!Object.prototype.hasOwnProperty.call(c, "m"), ...);     // line 42 — PASSES
assert(!Object.prototype.hasOwnProperty.call(C.prototype,"m")); // line 46 — PASSES
verifyProperty(C, "m", {                                        // line 51 — FAILS
  enumerable: false, writable: true, configurable: true
});
```

So the static method **is reachable and returns the right value**
(`C.m() === 42`), but the class constructor object does not report `m` as an
own property. In standalone lowering the method is dispatched through the
static/vtable path rather than being installed as a real own property with a
descriptor on the class object. The host lane installs it, which is why the
gap is standalone-only.

This is the class-object face of the same reification gap tracked by #1888
(open-any method dispatch + built-ins-as-static-globals) and #2963 (reify
builtins as first-class values), but it is distinguishable by signature and
by the fact that dispatch already works — only descriptor materialisation is
missing.

## Acceptance criteria

1. For a class `C` with a static method `m`, `Object.getOwnPropertyDescriptor(C, "m")`
   in standalone returns `{ value: <fn>, writable: true, enumerable: false, configurable: true }`.
2. The same holds for prototype methods on `C.prototype`, and private elements
   (`#x`) remain *absent* from `hasOwnProperty` on `C`, `C.prototype` and instances.
3. The 218 rows above flip to `pass` in the standalone lane, with no default-lane
   regression.
