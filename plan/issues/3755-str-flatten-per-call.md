---
id: 3755
title: "perf: `__str_flatten` runs per call on a receiver field that cannot change (#3753 S3)"
status: wont-fix
completed: 2026-07-28
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [3753, 3683, 682]
---

# #3755 — the per-call `__str_flatten`

Split out of #3753 as its S3.

After #3753 S1c removed the `ref.test` + `ref.cast` from a promoted string
field's read, one call remains in the tokenizer's hot body:

```
off: nextCode twin 76 lines | str_flatten=1 ref.test=1 ref.cast=1
on:  nextCode twin 62 lines | str_flatten=1 ref.test=0 ref.cast=0
```

`__str_flatten(this.input)` still runs on **every** `nextCode()` — once per
character of the scan — on a receiver field that does not change across the
loop.

## Why it is not free

The cons-cell memoization makes the repeat calls cheap (a load and a branch, not
a copy), which is why this is medium and not high priority. But it is still a
call plus a branch per character in the innermost loop of a parser, and the
value is loop-invariant by construction: the field is written once in the
constructor and #3753 proved it a string.

## Candidate approaches

1. **Flatten at the write.** Store the field already-flat, so reads never
   flatten. Cheapest at the read site; needs the write site to flatten and needs
   care for a field written more than once.
2. **Hoist per call.** Flatten once at twin entry into a local, reuse across the
   body. Bounded to one function, no representation change, but only removes the
   repeats WITHIN a call — `nextCode` is called per character, so this buys
   nothing for the tokenizer shape specifically.
3. **Hoist to the caller's loop** (true LICM across the devirtualized call).
   Biggest win, biggest complexity.

(1) is the most promising for the measured shape: a write-once string field is
exactly the case where flatten-at-write is provable.

## MEASURED: worth nothing — closing wont-fix (2026-07-28)

Priced before implementing, by the cheapest possible experiment: patch
`ensureNativeCharCodeAtHelper` to replace `call $__str_flatten` with a bare
`ref.cast $NativeString`. That is unsound in general but exactly valid for this
benchmark (whose subject string is already flat), and it removes the call
*entirely* rather than merely reducing it — so it measures the CEILING of every
approach listed above, including the "biggest win, biggest complexity" one.

Same container, interleaved, checksums matching throughout:

| arm                | string | tokenizer |
| ------------------ | -----: | --------: |
| flatten (today)    | 0.1458 |    0.7604 |
| **no flatten**     | 0.1576 |    0.7645 |
| flatten (today)    | 0.1517 |    0.7403 |
| **no flatten**     | 0.1882 |    0.7130 |

Nothing. The tokenizer arms interleave inside noise, and the `string` axis is
*slower* in the no-flatten arm in both rounds — which is the tell that the
whole spread is container noise, not signal.

The issue's own hypothesis was right: "the cons-cell memoization makes the
repeat calls cheap (a load and a branch, not a copy)". A load and a predictable
branch per character is, in fact, free here. The call being *visible* in the
WAT made it look like a cost; it is not one.

**Do not implement any of the three approaches.** Flatten-at-write (1) would
change a field's representation and add a write-side call for zero measured
gain; (3) would be a real LICM pass for the same zero.

### Where the tokenizer's remaining gap actually is

The same dump that motivated this issue shows four calls per character in the
`nextCode` twin. Three of them are the **local** `var c`, not the flatten — see
**#3765**, which prices that at #3753's own variant-B measurement (1.34x). That
is the tokenizer lever; this one was a decoy.

## Acceptance criteria

- [x] `__str_flatten` no longer appears in the tokenizer twin's hot body —
      **superseded**: measured to be worth 0, so removing it is not a goal.
- [x] Measured by same-container interleaved A/B behind a kill switch, checksums
      matching. Done, as the falsification above.
- [ ] A field written more than once, or written a non-flat rope, still behaves.
      Not applicable — nothing is being changed.
