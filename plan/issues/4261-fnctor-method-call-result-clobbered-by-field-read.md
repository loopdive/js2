---
id: 4261
title: "standalone: a fnctor prototype-method call returns 0 when the SAME function also reads a declared field of that receiver — each half is correct alone"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
assignee: ttraenkler/fable-4261-method-result
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: core-semantics
related: [3683, 3927, 4194, 4241]
# +19 lines, all documentation: the clause-B mechanism comment in the
# classification step. The fix itself is one condition; the comment is what
# stops the NEXT absolute-clause regression from being re-introduced blind.
loc-budget-allow:
  - src/codegen/fnctor-escape-gate.ts
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

## Resolution (2026-08-09, ttraenkler/fable-4261-method-result)

**Root cause: neither dispatch nor local allocation — CLASSIFICATION.** The
#2660 S1 escape gate's clause B was absolute: any typed own-field consumer
(`p.pos`, read OR write) classified the `new P()` site `keep-typed`, even when
the site ALSO had a dynamic use (`p.step()` — a non-own-field access). A
keep-typed fnctor never enters `approvedNames`, and EVERYTHING that makes a
prototype method callable is approval-gated: the #2660 S2 prototype
materialization, the #3683 direct-call twins, the `__fnctor_proto_start`
registry. So in the two-line repro the module contained NO compiled `step`
function at all (WAT diff: 267 vs 281 funcs; the "smaller" module was the
broken one). The call fell to the generic `__call_m_step_0` →
`__extern_method_call`, found nothing, returned **null**, and
`__unbox_number(ToPrimitive(null))` reads null as **0** — the plausible wrong
answer. `q` stayed correct because the A3 read dispatch (`ref.test` +
`struct.get`) works without approval. This is the same mechanism class the
#4123 note recorded for the inline-argument asymmetry.

**Fix** (`src/codegen/fnctor-escape-gate.ts`, classification step 3): a site
with BOTH a typed own-field consumer AND a dynamic use classifies
`reconstruct`, **standalone lane only**. Rationale mirrors the existing
`new this()` exception verbatim: A1 (#4155 typed instances) + A3 (struct read
dispatch) keep an approved site's field reads on `struct.get`, so approving
does not resurrect the #1888 `__extern_get` hot-path concern — post-fix WAT
confirms `p` is the struct-typed local, the call is the direct twin
`__dc_P_step_0_g`, and the field read is `struct.get 17 0`. Typed-only sites
still classify keep-typed; host/wasi verified **byte-identical** pre/post.

**Blast radius measured** (main @ dda0d1dc7, standalone): 11 of 13 probe
shapes were wrong pre-fix, all silent — method result into if-conditions
(took the wrong branch), into call arguments (null), chained methods (null),
two instances, string fields, separate-if spellings, and notably a typed
field **WRITE** (`p.pos = 7; p.step()` → null), which the issue's read-only
framing under-stated. All 13 pass post-fix.

**Pins**: `tests/es5-standalone-fnctor-method-plus-field.test.ts` — 14 content
assertions (native answers, composite `s + q*100` distinguishes which value
corrupts), including both single-statement controls green both ways.

**Not my collateral, verified by A/B on baseline**: the 4 red tests in
`issue-2608-new-this-fnctor-static.test.ts`, the flipped `it.fails` pin in
`issue-4155-fnctor-shape-regression.test.ts` ("field added by a method" now
passes — a latent #4253-class flip from this week's landed work), and the
`issue-3610` reflective-`.call` failure — all identical on baseline.
