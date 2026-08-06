---
id: 3926
title: "perf: `__extern_get` generic property lookup is the largest non-parser function in the standalone parse and is unowned"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen, runtime
language_feature: objects
goal: performance
related: [4157, 3673, 3669, 3671, 3685, 3686, 3780, 3921]
origin: "#3780 round 4 — re-ranking the standalone acorn profile found __extern_get unowned: #3673 (which carried it as a slice) is done, and #3669/#3671 are about slot MONOMORPHISM, not lookup cost"
---

# #3926 — `__extern_get` generic property lookup cost has no live owner

## Why this issue exists

Across four independent profiles of the standalone acorn self-parse,
`__extern_get` is consistently **the largest single non-parser function**:

| profile | `__extern_get` self time | whose |
| --- | ---: | --- |
| `dev-acorn-throughput`, 30 parses of 226 KB | 8.03% (bucket 10.10%) | theirs |
| #3686's, 20,000 parses of 1.5 KB | 9.69% (bucket 12.6%) | theirs |
| #3780 round 4, 30 parses, this box | 4.46% (bucket 5.15%) | mine |

The spread across boxes is real and unexplained (see the caveat in #3921), but
no profile puts it below 4%, and two put it near 10%.

**It is nevertheless unowned.** The issue that carried it as a slice, #3673, is
`status: done`. #3669 is also `done`; #3671 is `ready` but scoped to *slot
monomorphism* — whether a slot seeded with a number/boolean corrupts on a later
write — which is a **correctness/representation** question, not the cost of the
lookup itself. Nothing currently tracks "the generic property read is
expensive".

## What is already known

- The helper is emitted, not imported, in standalone — this is **internal**
  cost, not bridge tax. (Do not conflate with #3780's JS-host lane, where
  `__extern_get` is one of 17.67 M host crossings per parse.)
- Its structure is a front-guard cascade → per-key prototype-lookup cache
  (#3673 round 9b) → closed-struct field ladder → `__obj_find` own-property
  walk → prototype-chain walk → accessor branch. The ladder is what the cache
  exists to skip.
- **#3780 round 4 already removed one cost from inside it**: the boolean arms
  of the closed-struct ladder allocated a fresh 16-byte carrier per read
  (742 static `struct.new` sites → 2 after interning). That was allocation, not
  lookup, and the lookup work is untouched.
- #3780 round 3 routed acorn's `this.options.<x>` reads *directly* to
  `__extern_get`, deliberately skipping a useless closed-struct candidate
  ladder at the call site (`JS2WASM_TYPED_OPEN_CARRIER_READS`, 4.59% faster).
  So some call sites now reach this helper **sooner** by design — which raises,
  not lowers, the value of making the helper itself cheap.

## Scope

- [ ] Profile *inside* `__extern_get` — which arm actually retires the time on
      the acorn parse: front guards, cache probe, ladder, `__obj_find`, or the
      proto walk. The whole-function 4–10% figure does not say.
- [ ] Establish the hit rate of the #3673 round-9b per-key prototype cache on
      this workload. A cache that mostly misses is pure added latency.
- [ ] Only then choose a lowering. Do NOT start from the assumption that the
      ladder is the problem — that is what the cache was already built to fix.

## Non-goals

- Slot monomorphism (#3671) — different question, different failure mode.
- The JS-host lane's import count (#3673's old framing) — that lane's cost is
  the crossing, not this helper's body.

## Acceptance criteria

- [ ] An intra-function attribution for `__extern_get` on the standalone acorn
      parse, naming which arm costs what.
- [ ] Cache hit rate reported for the same workload.
- [ ] Any lowering that lands is measured with a paired control on the
      standalone acorn parse, and reports binary-size cost alongside the win.
- [ ] No standalone test262 regression.
