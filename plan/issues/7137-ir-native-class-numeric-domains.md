---
id: 7137
title: "IR: preserve native i32/u32 class field domains"
status: in-progress
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: ir
goal: ir-full-coverage
parent: 3518
depends_on: [7136]
assignee: "ttraenkler/codex-session-b"
loc-budget-allow:
  # 2026-10-22: +1 import binds the extracted source-qualified field projection.
  - src/codegen/index.ts
---

## Problem and authoritative base

Base: upstream `709f0f550dd1b34cfad98adb44351f3bdc1ac9ea`.
Full open-PR collision scan and issue allocation succeeded; the branch claim
`codex/7137-ir-native-class-numeric-domains-20261022` is server-verified.

The console qualification in **IR: native dynamic console arguments and output
providers** (#7136, PR #6872) found a prior class-initializer defect:
`type u32 = number; class C { value: u32 = 4294967295; }` stores 2147483647.
A separate `return (new C()).value` export also reaches the existing post-claim
i32/f64 return mismatch. Exact-base and candidate probes recorded the clamped
literal in `C_init`; the console witnesses are explicitly known-open.

The class projection recovers a checker number as f64, rejects it against the
physical i32 slot and falls back to the lossy ValType. The IR field store then
uses signed saturating f64-to-i32 conversion. A native annotation's source
domain must survive the physical layout without changing that layout.

## Implementation plan

- Reproduce native signed/unsigned initializers, explicit constructor stores,
  field returns and updates on standalone/WASI. Assert values and genuine IR
  constructor/consumer bodies; refuse to count legacy fallback as ownership.
- Reuse the shared syntactic native-annotation proof. Preserve i32's explicit
  ToInt32 brand and u32's unsigned domain in the class field projection. Keep
  physical layout parity and exact source/alias binding checks.
- Extract numeric IR coercion from from-ast into one producer helper. Reuse the
  existing canonical JS bitwise IR operations for ToInt32/ToUint32 and unsigned
  widening; do not invent a second numeric conversion engine or add a backend
  escape instruction.
- Audit all class-field read/write and return consumers before making signedness
  load-bearing. Unsigned field values must enter source arithmetic/comparisons
  as the correct nonnegative number. Cover destructuring, assignment results,
  inherited fields and observable initializer effects where admitted.
- Keep boolean/symbol brands and unrelated slot conversions separate. Keep
  direct-AST body emitters frozen and old comparison results intact. Native
  narrow-width/f32 gaps are not silently declared solved by this 32-bit work.
- Record exact-base failures, relevant regression tests, current-main gates and
  a fresh-context review request in a ready PR. No existing head/HOLD/queue
  modifications; constructor-stack source ownership remains respected.

## Acceptance

- [x] Domain projection is source-qualified and physically ABI-compatible.
- [x] i32 stores wrap via ToInt32; u32 stores/readback preserve the uint32 domain.
- [x] Supported constructors, reads, updates and return boundaries execute in IR
      with correct values and no post-claim errors on both native targets.
- [x] Brands, alias rejection, source evaluation order and inherited fields have
      meaningful controls; remaining unsupported forms stay explicit.
- [ ] Exact-base comparison and normal quality checks are recorded; ready PR is
      published with fresh-context review status and remaining migration gaps.


## Initial evidence, 2026-10-22

The original exact-base matrix on `709f0f550d` has **38 failures and six
passing controls out of 44**. It checks actual values and source-owner rows,
not merely compilation. The first candidate passes 40/44; the four remaining
rows expose separate ownership boundaries: implicit inheritance has an
unplanned derived-constructor/class-layout ABI dependency; a global-counter
initializer is withdrawn for `storage-terminal-unprepared`.

The source-local effect fixture now uses a previously initialized instance
counter and an IR-emitted `this.take()` method. Explicit parent/derived
constructors also exercise inherited field domains with complete constructor
ownership. These are positive controls; the original implicit-inheritance
refusal was retained as a known-open witness at that stage. The dependency
correction below replaces it with a positive ownership control. Original
failure logs are preserved.

The three class-field read sites are audited: ordinary reads and destructuring
widen uint32 values into source Number space; compound updates read the field
before evaluating the RHS, compute there and convert once back into storage.
Both tail and early returns share the extracted numeric boundary. Boolean and
Symbol handles are explicitly excluded from numeric slot conversion.


The expanded exact-base runtime matrix has **52 failures and eight passes out
of 60 registrations**; the two candidate-only brand-helper controls are omitted
from that base run because their helper does not exist there. Two of those 52
failures are ownership-diagnostic witnesses, not numeric semantic gains: on base
Parent_new is prepared and run falls back at its return boundary; admitting run
exposes an unplanned implicit-derived dependency and withdraws Parent_new.

That withdrawal is not accepted as a finished fix. The implicit-support planner
must distinguish exact terminal parents from non-terminal forwarding helpers.
An implicit parent with initialized fields is a source terminal, just like an
explicit constructor; its unit must belong to the same preparation transaction.
Only non-terminal implicit parents require membership in the staged support
set. The existing exact allocator, parent-handle and transaction checks stay
in force. The formerly known-open inheritance fixture is now a positive
constructor/consumer ownership test. This small preparation correction is
necessary to retain the constructor ownership that existed before run's new
numeric return was admitted.

The full exact-base comparison is **61 failures / 94 passes over 155 runtime
registrations**: the new runtime matrix contributes 58 failures / 10 passes;
the four older suites contribute three failures / 84 passes. The two new
brand-helper unit controls are absent from this base-only runtime instrument.
The three older failures are the native-i32 parameter `>>>` result in #1817 and
two #5163 string-chain legacy readback expectations. The same three rows fail
on the candidate and are not reported green.

The inherited-constructor correction passes all 70 new registrations and all
19 existing implicit-derived constructor controls. A grandparent support chain,
a derived own field initializer, implicit argument forwarding and a source-local
initializer effect now have actual IR source owners and correct native values.
A separate global-storage parent control preserves a correct runtime result and
retained fallback; it does not certify that unrelated global storage is prepared.

The oracle ratchet initially caught a new checker reference. The shared native
annotation proof now accepts the existing oracle's exact, unaliased declaration
query as well as its existing checker callers; no second proof or alias policy
is introduced. The projection has no runtime import of IR factories. Oracle,
cycle and directory gates therefore need no new allowance.


Final numeric-change qualification before predecessor integration: **129/129
registrations in five focused files**, including all 70 new controls and all 19
implicit-derived constructor controls. No new test remains a known-wrong-value
or accepted loss-of-ownership witness. The standard byte-identity tool reports
**all 60 records IDENTICAL to exact base 709f0f550d**: 36 successful binaries
(15 gc, 15 standalone, five WASI, one Linear) and 24 retained compile-error
records. This is bounded corpus evidence, not full IR retirement certification.

Integration must also update the two previously known-open console witnesses
from PR #6872 to the corrected value. The own numeric branch will incorporate
that durable predecessor head, leaving the Console PR head untouched, and will
require #6872 to land before release. The numeric commit remains independently
reviewable from base 709f0f550d; the combined branch is requalified afterward.


Predecessor integration uses exact PR #6872 head
`775b4c95a22344b26c42cc377295fab51647bf62`; its head is unchanged. The independent
numeric fix is commit `d5f37a1c99de5578f7aa299fcf278ad7ca66e2f9` from base 709f0f550d.
The merge resolves only adjacent imports and preserves both implementations.
The two console known-open witnesses now assert 4294967295 and a genuine IR
constructor. Combined qualification passes **213/213 registrations in seven
files**. This branch depends on #7136 and must not be released before PR #6872.
Fresh-context adversarial review is still required before release.


Combined validation also passes **140/140 registrations with i32 inference**.
The final combined byte corpus has precisely the Console predecessor's two
already-qualified WASI changes (classes/algorithms); all other 58 records match
base. No additional numeric-fix drift appears. Typecheck, lint and normal source
ratchets pass. Inventory and preservation contracts remain bounded; strict
closure and full IR retirement are not certified.

A separate mixed-boundary probe remains open: `read(v: any): number { return
v.value; }` called with `new C()` where `C.value: u32 = 4294967295` returns
2147483647 through the legacy constructor and -1 after the IR constructor fix.
The candidate read is refused for `param-type-not-resolvable`; its caller is
refused for `return-type-not-resolvable`, with no post-claim errors. The old
physical dynamic-member read does not preserve the unsigned field domain.
This is not a supported IR-owned consumer or a completed native semantic
boundary. It requires the remaining dynamic ABI/shared member-read migration;
it is not silently counted among the qualified field operations or a Test262
gain. Direct-AST body emitters remain frozen. Full goal completion stays open.


Latest-main integration: upstream `699a2e71c746aa36ddd3f480beab562bb186400f`
is merged as `5422ba286b1e68fe4054a6dc70f3aec2bbfa5d5b`, preserving the newly
landed value-less method/constructor census change. The final matrix is
**220/220 registrations in eight files**, including that incoming selector
control. Current-main LOC/function, directory, layering, cycle and inventory
checks pass with only the disclosed index import and predecessor grants.

The fresh byte comparison against current main 699a2e71c7 again has exactly the
two predecessor WASI changes and 58 identical records. The mixed-boundary WAT
probe confirms `read` has an externref-to-f64 ABI; this is a legacy member-read
boundary, not an unqualified success of the new typed-field producer.


## Takeover integration and CI regression fix, 2026-10-28

Integrated the #7136 predecessor as merged with main `b6250f09f8`; the merge
had no conflicts and the numeric diff against that predecessor is unchanged.

CI then failed `tests/equivalence/issue-6798-misc-semantics.test.ts`
(i32-saturate). It was a compile error, not a wrong value:
`class P { n: i32 = 0; set(v: number): i32 { this.n = v; return this.n; } }`
stopped compiling with `class-method typeIdx parity mismatch`.

Root cause: the class-shape descriptor (`buildIrClassShapes`) types member
signatures from the checker, so `: i32` projects as f64. The legacy ABI pins the
native annotation instead (`class-bodies.ts`, i32 result). Before this branch,
`return this.n` (an i32 field) against that f64 result failed IR verification,
which is a soft fallback. The new numeric return boundary converts it, so the
body now lowers on the f64 ABI and reaches the class-member parity check. That
check is a hard invariant. Getters and static methods with a native result
regressed the same way. Main already failed this way for native parameters,
setters and constant native results (`g(): i32 { return 1; }`).

Fix: `irNativeSignatureDiverges` (next to `irNativeNumericFieldType`, same
shared alias proof) defers any member whose parameters or result carry a
non-f64 native pin. This applies to instance methods, accessors and statics,
and those members compile on their legacy ABI. Callers of a deferred member
also stay legacy. Values match a legacy-only compile, and the 6798 test is
unchanged. A new 7137 control covers a method, getter, setter and static,
asserting ToInt32 values and legacy ownership on both native targets. That
control fails without the fix.

Still open, and not changed here:
- A constructor with a native parameter still hits the same hard parity check
  on main. Deferring it would mean dropping the whole class shape.
- Legacy re-types a method's native result to f64 when it compiles the body, so
  `g(v: number): i32 { return v; }` returns 2147483648 in a legacy-only compile.
- A legacy `: u32` member result widens as signed. Behind the corrected IR
  constructor, it reads -1; before, the clamped constructor gave 2147483647.

Qualification on the integrated head:
- The PR's suites pass: 7137 72/72, 7136 70/70, and 3518 main lowering.
- With `JS2WASM_IR_I32_DOMAIN=1`, they pass 142/142.
- The six console-touching equivalence files and 6798 pass 98/98.
- The remaining failures in the related suites match `b6250f09f8` row for row.
