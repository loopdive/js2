---
id: 4261
title: "standalone: a fnctor prototype-method call returns 0 when the SAME function also reads a declared field of that receiver — each half is correct alone"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: core-semantics
related: [3683, 3927, 4194, 4241]
origin: "found 2026-08-09 while writing the #4241 step-1b hazard pins. The pin was a composite (prototype call + declared read + expando read) that answered 0 while each half answered correctly; narrowing removed the expando entirely and left a two-line repro. A/B'd identical on upstream/main at 4e90526dd, so it predates #4241 step 1b and is unrelated to the carrier-bag work that surfaced it."
---

# #4261 — a fnctor method call's RESULT is clobbered to 0 by a declared-field read in the same function

## Problem

Under `--target standalone`, a constructor-function ("fnctor") prototype method
returns the WRONG VALUE — `0` instead of its real result — whenever the calling
function ALSO reads a declared field of the same receiver. Either operation
alone is correct. Nothing is thrown, nothing fails to compile, and the module
validates: it is a silent wrong answer.

```js
function P(n) { this.pos = n; this.type = "x"; }
P.prototype.step = function () { return this.pos + 1; };

// CORRECT (2):
export function test() { var p = new P(1); var s = p.step(); return s; }

// WRONG (0) — the ONLY change is an additional read of p.pos:
export function test() { var p = new P(1); var s = p.step(); var q = p.pos; return s; }
```

## Measured

Standalone lane, upstream/main @ `4e90526dd` (and identically on the #4241
step-1b branch, so this is not that change):

| program | expected | measured |
| --- | ---: | ---: |
| `var s = p.step(); return s;` | 2 | **2** |
| `var s = p.step(); var q = p.pos; return s;` | 2 | **0** |
| `var s = p.step(); var q = p.pos; return q;` | 1 | 1 |
| `var s = p.step(); var q = p.pos; return s + q * 100;` | 102 | **100** |
| `p.step(); var q = p.pos; return q;` (result discarded) | 1 | 1 |

`s + q * 100 = 100` pins it precisely: `q` is correct (1) and `s` is `0`, not a
comparison artefact. **The method's RETURN VALUE is what gets corrupted**, and
only when a declared-field read of the same receiver is present in the function.

## What it is NOT

Ruled out by measurement, so the next person does not re-derive them:

- **Not `&&` / short-circuit.** Splitting into separate statements, separate
  `if`s, or hoisting the call into a local all still answer 0.
- **Not evaluation order.** Reading `pos` before the call fails the same way.
- **Not the expando/carrier-bag substrate.** The original repro included an
  expando write; removing it entirely still fails. This is declared fields only.
- **Not field-specific.** `p.type` (a string field) triggers it as well as
  `p.pos`.
- **Not the receiver's construction.** A fnctor with NO prototype method reads
  its declared fields correctly.

## Why it matters

This is the failure class that hides longest: the parts pass, the composition
does not, so unit-shaped tests miss it and only a program that does both in one
function is wrong — silently, with a plausible-looking `0`. `this.pos + 1`
returning 0 in a parser-shaped object is exactly the kind of value that
propagates far from its cause.

## Suspected territory (not yet confirmed)

The typed-`this` / receiver-monomorphization dispatch for fnctor prototype
methods (#3683 is the perf work over that same path) and/or a local-slot or
representation collision between the method-call result and the field-read
temporary — `s` becoming `0` rather than garbage suggests a slot defaulting or
an f64/i32 representation mix-up rather than memory corruption.

## Acceptance criteria

- [ ] The two-line repro above answers 2, and `s + q * 100` answers 102.
- [ ] A test pins call-then-read, read-then-call, hoisted, and separate-`if`
      spellings — the composition, not just the parts, since every part already
      passes today.
- [ ] Root cause named (dispatch path vs local allocation) rather than papered
      over by forcing a spill.
- [ ] No standalone conformance regression.
