---
name: reference_stale_bail_comment_and_its_test_defend_the_defect
description: "When lifting a deliberate bail/guard, its recorded justification AND its test are both suspect — the test asserts the bail, so it passes while the bail is wrong. Re-measure from a fresh matrix; never relax the predicate to whatever the old comment blamed."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-08-01T00:58:40.276Z
---

# A bail's COMMENT and its TEST both go stale — and the test defends the defect

**Twice in one session (2026-07-31/08-01):** an agent set out to lift a deliberate
codegen bail, and found that

1. the **comment** recorded a justification that **no longer reproduced**, and
2. a **test asserted the bail itself**, so it stayed green while the bail was wrong.

- **#2581** — wrong justification, and its test encoded it.
- **#3386** — the comment named the #3164 host-mix fixture
  `*method([gen = function*(){}] = [])` in the **class** lane as the breakage.
  **That shape now passes.** The unsafe set was real but **different**: generator
  fn-expr defaults and class-expression defaults, in different lanes.

> A test written to pin a bail is **evidence about the bail's existence, not about
> its necessity.** It cannot fail when the bail becomes unnecessary — that is the
> one outcome it is structurally unable to report.

Same shape as [[reference_silent_empty_is_indistinguishable_from_real]]: ask what
the artifact does when the thing it guards has been **fixed underneath it**. If the
answer is "stays green", it is not a detector.

## Rule

**Re-derive the unsafe set from a fresh matrix.** Do not relax the predicate to
whatever the old comment blamed — you will admit shapes that are still broken and
keep excluding shapes that are now fine, and the diff will look justified because
it matches the comment.

**Then re-measure the test too**, in the same change. Correct it in place with the
new evidence, and add a test pinning the surviving half — otherwise the next agent
inherits the same false record.

## Companion: what a widening must prove

Import-freedom is **not** the bar for lifting a spill/suspension bail. The value has
to survive the round trip and still **work**: spill, suspend, resume, **call it**,
assert the result. A module that stores a broken reference it never invokes passes
an import-freedom check and a value read.

Two discriminators that earned their keep on #3952:

- **Exclude on a CONTROL, not on caution.** The fn-expr-host arm was excluded
  because that lane already traps on an element default with a plain **numeric**
  value — no closure anywhere. Closure-independent and pre-existing, so admitting it
  would have swapped a loud leak for a runtime trap and proved nothing.
- **Never admit a shape on LANE IDENTITY alone.** One arm passed in the class lane
  and trapped in the objlit lane; 32 rows were deliberately left on the table rather
  than admitted on the passing lane's say-so. Admitting there is how a loud leak
  becomes a silent wrong value.

Related: [[feedback_measure_never_extrapolate]] ·
[[reference_valid_wasm_is_not_correct_verify_by_value.md]] ·
[[reference_broken_instrument_can_still_give_right_answer]]
