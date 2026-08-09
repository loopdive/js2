---
name: reference_valid_wasm_is_not_correct_verify_by_value
description: "Wasm validates" is NOT evidence a codegen fix works — verify by RETURN VALUE (and argument order). A pad that silences a validation error can install a guaranteed runtime trap or a silent wrong answer.
metadata:
  type: reference
---

**Never accept "the module now validates" as evidence a codegen fix is correct.** Proven
twice in one slice on 2026-07-24 (dev-rebase-3563, static-`super` arity, #3024 family).

**Failure mode 1 — valid Wasm that traps.** A pad added to the static-getter path removed
the `not enough arguments on the stack` validation error. It was nearly shipped on that
basis. Checking the *value* failed, and the WAT showed why:
```
(func $Base_get_x (param (ref null 1)) (result f64))  ; static getter compiled INSTANCE-shaped
(func $C_m   ref.null 1 / ref.as_non_null / call 2)   ; the pad
```
`ref.as_non_null` on a null ref **traps**. The "fix" would have traded a loud
compile-time invalid-Wasm error for a guaranteed runtime trap — strictly worse.

**Failure mode 2 — valid Wasm that silently lies.** `static super.<plain field>` was listed
as a *passing control* because it produced valid Wasm. It returns **0** instead of `13`
(emits `f64.const 0`) — pre-existing on stock main. So the control was measuring validity,
not correctness, and would have "passed" no matter what the fix did.

**How to verify instead:**
- Assert the **returned value**, not just that it compiled/validated.
- Choose values that pin **argument ORDER**, not merely count — e.g. `super.g(3,4)` must
  return `34`, which `g(4,3)` cannot fake. Counting args catches too little.
- **Run the same suite against stock `origin/main`** (temporarily restore the touched file)
  so the before/after is measured, not assumed: here **main 5 pass / 6 fail -> fix 11/0**.
- Lock known-broken cases in as explicit **KNOWN-OPEN assertions** (assert the *wrong*
  current value) so a later real fix flips them loudly instead of silently.

**Corollary for picking controls:** a "control that currently passes" must be verified to
pass *for the right reason* before you rely on it. Otherwise a too-broad fix sails through.

Related: [[feedback_measure_never_extrapolate]] ("compiles" != "passes"),
[[reference_standalone_floor_inflated_three_vacuity_mechanisms]] (the same
looks-fine-but-checks-nothing family, at the harness level).
