---
name: reference_constant_folded_probe_tests_the_static_path
description: "A probe that builds a 'dynamic' value from constants (\"a\" + \".c\") gets CONSTANT-FOLDED and silently exercises the COMPILE-TIME path — so it reports green while the runtime path is untested. It invalidated a premise that a filed issue was resting on."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T07:26:54.171Z
---

Measured 2026-08-02 by the `L-regexp` lane, which caught it **in its own
instrument** before reporting.

## The trap

To test a *runtime-constructed* value you write the natural probe:

```js
new RegExp("a" + ".c")     // "dynamic", surely?
```

`staticConstStringValue` **constant-folds** it. The compiler takes the
**compile-time** path. The probe reports everything green — and the runtime path
it was written to exercise **was never run**.

## Why it is worse than a weak test

**A filed issue was resting on it.** #4042's premise — *"#4016 proved runtime
patterns work, so the refusal may no longer be load-bearing"* — came from exactly
this folded probe. The refusal was **real**; only its *grammar* was too narrow.
Had that premise gone unchallenged, a lane would have deleted a live refusal on
the strength of a test that never reached the code it claimed to cover.

This is the [[reference_silent_empty_is_indistinguishable_from_real]] shape in a
new place: green from an instrument that never executed the path.

## The rule

**When probing a dynamic/runtime path, defeat constant folding — and prove you
defeated it.**

- Source the value from something the compiler cannot fold: a function
  parameter, a global mutated at runtime, `argv`, a value read back from a
  structure.
- **Positive-control it**: confirm the probe actually reaches the dynamic path
  (the refusal fires, the dynamic emitter is entered, the import appears) rather
  than assuming the spelling was enough.
- Applies well beyond RegExp — any "is the runtime path handled?" question about
  strings, numbers, property keys or patterns.

## Companion finding from the same lane

The area was **already silently wrong on main**, independent of any change:

```
^(?:a.c|zz)$  ~ "abc"  -> NO MATCH   (Node: "abc")
a.c           ~ "abc"  -> "abc"      correct
```

Same construct, two answers, decided only by **anchoring** — because
`ensureDynamicStandaloneRegExpCompiler` walks the pattern **four times**, each
re-deriving character semantics, and only the emitter knew `.` is `ReOp.ANY`.
The invariant was not even a comment: it was **two independent derivations of
the same number** (`CHARS` counted vs `J - I` recomputed). Sixth instance of the
[[reference_bigger_number_bought_with_a_silent_wrong_answer_is_negative_value]]
family and of #4080's *"a correct treatment exists and one consumer never got
wired to it"*.

Related: [[feedback_measure_never_extrapolate]],
[[reference_broken_instrument_can_still_give_right_answer]],
[[reference_valid_wasm_is_not_correct_verify_by_value]].

## The sharpest form of the tell — all three failures were GREEN

Three instruments failed on one agent in one session (this constant-folded
probe; a watcher whose `grep -E "\t"` matched a literal `t` and so flagged a
**green** PR; a test whose nine cases all passed because
`instantiate(bin, {})` died at `Import #0` before running anything). It caught
all three before reporting a number, and its closing formulation is the one to
keep:

> **A broken instrument almost never announces itself as broken. It announces
> itself as good news that arrives slightly too easily.**

None of the three failed loudly. Two reported success and one reported a
*failure that did not exist* — but in every case the output was the answer the
agent wanted or expected, arriving with less friction than the question
deserved. Treat unearned agreement as the alarm.
