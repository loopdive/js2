---
id: 4060
title: "`'use strict'` directive prologue inside a function body does not take effect in standalone — undeclared assignment silently creates a global"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: n/a
goal: standalone-mode
---
# `'use strict'` directive prologue inside a function body does not take effect in standalone — undeclared assignment silently creates a global

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Found by `g-function` 2026-08-01 while triaging sibling signatures of the expected-throw census. **Unowned, coherent, and nobody has looked at it.**

**Population:** the `ReferenceError` sibling signature is **15 files** in the goal scope (es5id-tagged or untagged, standalone). **11 of them are `language/directive-prologue/*-runtime.js`** — one mechanism.

**Mechanism:** a `'use strict'` directive prologue **inside a function body** does not take effect. Consequence: an undeclared assignment inside that function **silently creates a global** instead of throwing `ReferenceError`. That is a silent-wrong-answer failure mode, not a refusal — nothing downstream can detect it.

**Explicitly NOT any of the current owners:**
- not descriptors (`g-descriptors` owns the RangeError 16 and the enforcement family)
- not the `with` cluster (that is the SyntaxError 2)
- not value-reification (that is the separate family below)

**Sizing caution:** 11 is the population **gated** in the goal scope. The mechanism is strict-mode scoping, which is *pervasive* — a fix may reach well beyond `language/directive-prologue/`, or may be narrowly about prologue detection in a nested function body. **Enumerate the trigger shape across the corpus before sizing**, positive-controlling the enumerator against the 11 where ground truth exists. Files without the shape compile byte-identically, so that converts an extrapolation into a population.

**Method** (proven repeatedly this session): paired per-file A/B inside one process via a collection-time kill switch; a final arm with the scaffold **deleted** to prove the shipped code produces the result; rows floored in both arms; an in-sweep control that must NOT move; and **interrogate any zero** — five instrument artifacts were caught today, each by reading the failure *signature* rather than the pass count.

---

## Related strategic note — a value-reification cluster is converging from three directions

Three independent investigations today landed on the same underlying shape, and none of them is individually large enough to fund:

1. **#3571 refuted** — 32/40 files had `obj` **already nullish** before the suspected code ran. A **missing value** (builtins not reified), not a receiver drop.
2. **`instanceof` bound (#3962)** — 26 of 36 leaks closed, but the remainder need builtins reified as values.
3. **`g-function` family 3 (34 files)** — builtin prototype methods are **not first-class receiver-taking function values**. Three observation shapes, including **16 via method transfer by assignment** (`s1.toString = Boolean.prototype.toString; s1.toString()`) that contain no `.call` at all and which a `.call`-pattern census misses entirely.

**Its denominator matters and prevents overstatement: 106 of the 176 goal-scope files using `<Builtin>.prototype.<m>.call/apply(` already PASS.** So this is gap-filling in a mostly-working special-case table (`tryEmitNativeProtoReflectiveCall`), not a blanket defect. The architectural statement is at `src/codegen/expressions/calls.ts:6378` — *"For standalone functions (no `this`), drop thisArg and call directly."*

**Recommendation carried forward from `g-function`: do not fund the 34-file fix as a conformance lever.** If it is worth doing, fund it as **value-reification** work judged on the combined three-way evidence, not on 34 files.
