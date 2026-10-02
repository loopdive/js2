# Follow-up evidence — still held, not a landing candidate

This documentation-only checkpoint supplements the original recovery139fa.
It does not activate runtime changes. Preserve hold, all failures and the old
compiler. Current parent source is the original integration patch plus the
two-hunk Symbol calls.ts patch here; the two new test files are archived as
text and must be restored with their original .test.ts extensions to execute.

## Measured results

- Method/equality12: exact baseline608 and pre-Symbol integration both7/12,
  native12/12, zero imports, identical sources/hashes and per-row outcomes.
  Handles84876 and29789 terminal exit1. The paired receipt retains every row.
- After Symbol routing, handle64929 terminal exit1:39tests,28pass11fail.
  Breakdown: method/equality9/12; original ToObject14/20 (previous12/20);
  new Symbol safety5/7. All39 native results are1. No fixture was weakened.
- Safety baseline608 handle24376 terminal exit1:2/7 vs candidate5/7. The three
  gains reject plain-object, number and null receivers with TypeError. Both
  apply controls pass on both sides. Prototype replacement and namespace
  shadowing both fail-2 on both sides. They remain binding failures, not waivers.
- Class routing candidate is a separate lane, not integrated here: typecheck
  handle67935 exit0, focused handle16752 exit1,38/47 vs36/47. Gains are only
  static enumeration at O0/O2; all24 runtime source hashes match and no passing
  focused row regresses. Nine failures and original124/176 checks remain open.

The source review also found additional prototype lifecycle and host-boundary
obligations. Full plans/inventory are retained here. Object slot phase1 is
UNINTEGRATED and UNRUN: its patch is behavior-preserving encapsulation only,
not the required raw representation/semantic cutover. Its own handoff records
exact prerequisite file hashes and inverse textual comparison limitations.
Do not apply it as acceptance or overwrite another lane's Object runtime.

Next: fix override/shadowing and BigInt valueOf without narrowing wide values;
continue class/generator blockers, then complete lossless prototype authority
and exact activation. Compiler execution remains serialized. No retirement,
baseline rewrite, fixture omission or protected-queue bypass is authorized.
