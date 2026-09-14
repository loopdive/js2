---
id: 6477
title: "Linked test262 harness: property-descriptor reads on consumer values differ from the honest lane"
status: ready
sprint: current
created: 2026-09-14
updated: 2026-09-14
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime
language_feature: property-descriptors
goal: test262-conformance
depends_on: [3451]
related: [3451, 5225, 6475]
# id reserved 2026-09-14 with pr_scan="degraded" (gh unreachable): verified
# against upstream main + the assignment ref, NOT against in-flight PRs.
---

# #6477 — descriptor VALUES read wrong across the linked-harness boundary

## Problem

~14 rows of the #3451 slice-3 sample (measured 2026-09-14, 404 rows) differ with
messages of the form

```
foo descriptor value should be foobar
property descriptor value should be
Expected obj[foo] to equal NaN, actually data
```

concentrated in `built-ins/Object/defineProperty`.

## Why it is NOT the known pre-existing gap

`Object.prototype.hasOwnProperty.call` / `in` / `Object.hasOwn` on a compiled
object already answer wrong in the HONEST single-module lane under `allowJs`
(measured during #3451 P2), and #3451's substrate tests assert only PARITY there
because both lanes fail alike.

**These rows are different: the honest lane PASSES them.** So a value that the
honest lane reads correctly through `Object.getOwnPropertyDescriptor` reads
wrong when the reader is the provider and the object is a consumer struct. The
#5225 cross-module decoder registry is the mechanism that is supposed to answer
here (`_decoderExportsFor`), so the first question is whether it is consulted on
the descriptor-VALUE path at all, or only on the presence path.

## Acceptance criteria

- [ ] A minimal body reproducing one of the three messages, with the runtime
      path named.
- [ ] It is established whether `_decoderExportsFor` is reached on the
      descriptor-value read, and the answer recorded here.
- [ ] The ~14 rows flip to agreement without changing the honest lane.
