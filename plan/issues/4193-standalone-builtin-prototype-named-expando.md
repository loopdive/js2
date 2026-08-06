---
id: 4193
title: "Standalone: writing a NAMED property onto any builtin `.prototype` is a silent no-op — 112 ES5 files on one mechanism (#4160 generalised from integer keys to named keys)"
status: ready
created: 2026-08-06
updated: 2026-08-06
priority: high
task_type: bug
area: codegen
goal: es5
feasibility: hard
reasoning_effort: max
sprint: current
horizon: xl
related: [4160, 4159, 2875, 2860, 1906, 4163]
---

# #4193 — no own-property storage on a standalone builtin prototype

## Repro (`--target standalone`, all rows wrong)

```js
Number.prototype.foo = function () { return "FOO"; };
typeof Number.prototype.foo;   // "undefined"   (want "function")
(1).foo();                     // null          (want "FOO")
Number.prototype.bar = 7;
Number.prototype.bar;          // undefined     (want 7)
Number.prototype.hasOwnProperty("bar");  // false  (want true)

Boolean.prototype.baz = function () { return "BAZ"; };  true.baz();   // null
Object.prototype.qux = function () { return "QUX"; };   ({}).qux();   // null
Array.prototype.quux = function () { return "QUUX"; };  [].quux();    // null
String.prototype.zork = function () { return "ZORK"; }; "a".zork();   // undefined
```

An **own** property on an ordinary object works
(`var o = new Object(42); o.charAt = String.prototype.charAt; o.charAt(0) === "4"`).
The gap is specific to the builtin **prototype object**.

## Root cause

`<Builtin>.prototype` in standalone evaluates to the `$NativeProto` singleton
(`src/codegen/native-proto.ts`). That struct has six fields — `brand`,
`isClass`, `ctor`, `parent`, `memberCsv`, `name` — and **no own-property
store**. So the assignment has nowhere to land and the read has nothing to find.

This is exactly the gap #4160 identified and closed **for integer-index keys on
`Object.prototype` / `Array.prototype` only** (`src/codegen/proto-index-store.ts`:
lazily-minted `$Object` companions, write arms prepended to `__extern_set` /
`__defineProperty_*`, read fallbacks at the `__extern_get` / `__extern_has` /
`$__vec_base` / closed-struct miss points, all behind the `protoIndexDirty`
pre-scan gate). **#4193 is the same substrate generalised along two axes: named
(non-integer) keys, and every builtin brand.**

## Measured size — 112 ES5-label standalone failures

Method: list every ES5 test262 file whose body matches
`\b(Object|Function|Array|String|Number|Boolean|Date|RegExp|Error|…)\.prototype\.\w+\s*=`
(139 files), sweep them with `runTest262File(…, "standalone")` on 2026-08-06
main **with #4191's runner fix and `TEST262_FULL_RUNTIME_EVAL=1`**.

| directory | fail / total |
| --- | ---: |
| `built-ins/Object/defineProperty` (+ `defineProperties`) | 63 / 87 |
| `built-ins/String/prototype/split` | 13 / 13 |
| `built-ins/String/prototype/{toLowerCase,toUpperCase,toLocaleLowerCase,toLocaleUpperCase}` | 12 / 12 |
| `built-ins/RegExp/prototype/{exec,test}` | 6 / 6 |
| `built-ins/Function/prototype/bind` | 3 / 5 |
| `built-ins/String/prototype/{slice,substring,match,replace,concat,indexOf,lastIndexOf}` | 12 / 12 |
| `built-ins/Array/**`, `built-ins/Number/prototype`, misc | 3 / 4 |
| **total** | **112 / 139** |

Spot-verified causal, not incidental:

- `Object/defineProperty/15.2.3.6-3-34-1.js` — `Array.prototype.enumerable = true;`
  then an `[]` is used as the attributes bag and must inherit `enumerable`.
- `Object/defineProperty/15.2.3.6-3-248-1.js` — `Function.prototype.set = fn;`
  then a function object is the attributes bag and must inherit `set`.
- `String/prototype/split/call-split-1-0-instance-is-number.js` —
  `Number.prototype.split = String.prototype.split; new Number(…).split(1,0)`.

**This is the largest single mechanism found in the 2026-08-06 ES5 census**, and
it lands inside the campaign's #1 lever (`Object/defineProperty`, 857 reachable
failures per #4163) — 63 of those 857 are this, not the descriptor MOP.

## Design sketch

Generalise `proto-index-store.ts` rather than build a parallel store:

- **Companion per brand**, not per fixed pair — `__protoidx_companion(which,
  create)`'s `which` becomes the `$NativeProto.$brand` value; the globals become
  one lazily-grown table (or one companion global per participating brand,
  minted on first write).
- **Key admission** — `__protoidx_norm_key` currently *rejects* non-integer
  keys. Named keys must be admitted, but a named key must **never shadow a real
  builtin member**: the companion is consulted only after the brand's own member
  table misses, or the write must be refused for a name the brand already owns
  (`String.prototype.charAt = f` is a legal but far rarer shape — decide and
  record which).
- **Read consults** — same chokepoints as #4160, but the brand to consult comes
  from the receiver: a `$__vec_base` consults Array→Object, a boxed/primitive
  number consults Number→Object, a closure consults Function→Object, a
  `$NativeProto` consults itself. The brand→parent walk is already modelled by
  `$NativeProto.$parent`.
- **Gate** — a new pre-scan flag (`protoNamedDirty`) mirroring `protoIndexDirty`,
  so a module that never monkey-patches a builtin prototype is byte-identical.
  This is the whole no-regression argument; do not land without it.

## Hazards

- `proto-index-store.ts` had **unmerged PRs against it as of 2026-08-06** —
  check before starting, and expect to stack on whatever landed.
- Consulting a companion at `__extern_get`'s terminal miss changes the answer
  for *every* missing-property read in a flagged module. The
  own-before-inherited ordering and the "builtin member wins" rule are the two
  places a wrong answer becomes a silent conformance regression rather than a
  loud one.
- Reserve-then-fill funcIdx discipline (`reserveProtoIndexStore` /
  `fillProtoIndexStore`) is load-bearing; new helpers must follow it exactly.

## Sequencing note

Slice it by **read chokepoint**, not by brand: `$NativeProto`-receiver
read/write first (makes `Number.prototype.foo` round-trip, zero instance
lookups), then the ordinary-`$Object` inherited read (unlocks the
`Object/defineProperty` attributes-bag family, the biggest single bucket), then
the primitive/boxed receivers (the String-borrow family). Re-measure between
slices — the buckets are not independent.
