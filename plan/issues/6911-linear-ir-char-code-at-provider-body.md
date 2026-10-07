---
id: 6911
title: "Linear IR charCodeAt provider: reusable emission body and exact preservation"
status: ready
sprint: current
created: 2026-10-07
updated: 2026-10-07
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen-linear
goal: ir-full-coverage
related: [2956, 3673, 3502, 3518, 6905]
files:
  - plan/issues/6911-linear-ir-char-code-at-provider-body.md
  - src/codegen-linear/runtime.ts
  - src/codegen-linear/runtime/strings/char-code-at.ts
  - tests/issue-6911-linear-ir-char-code-at-provider-body.test.ts
  - src/codegen-linear/runtime/README.md
  - src/codegen-linear/runtime/strings/README.md
---

# Linear IR charCodeAt provider: reusable emission body and exact preservation

## Authority, evidence and purpose

Exact baseline: `6c88d157444ea4ae377a7ef1b82b15ef2f4f6603`.
Planning branch: `codex/6911-linear-char-code-at-provider-20261007`.
Parent verified reservation/prScan and planning claim
`6911:char-code-at-plan-20261007`, owner
`ttraenkler/codex-linear-b-char-code-at-astra-20261007`.
This is a specification, not a measured compiler fix or new Prepared admission.

Parent's completed 25-PR inventory (including checked file counts
135/294/397/402) found only three runtime-file overlaps: PR6572 array new/grow,
PR6575 string slice, PR6577 vector initialization. Their function regions are
disjoint. The pre-allocation 974-claim snapshot contained no 3502/3673 or target
char-code-at claim; A's published 45-path packet excludes runtime.ts. Broader
3518 GC-native string/provider claims do not release their shared interfaces.
Parent must acquire fresh exact source/test claims before dispatch.

Foreign [Heap coexistence in one linear memory: relocate the bump arena above
the engine’s heap base, passive data segments only](4540-linear-heap-coexistence-arena-relocation.md)
retains allocator/linked-heap ownership. A retains all shared compiler, emitter,
frontend, provider-contract, integration and source-map paths. Do not adopt
6896 allocation guards or 6897 forwarding regions. Legacy remains.

## Current production contract

- `runtime.ts::addLinearIrStringRuntime` (2547) registers appendASCII, charAt,
  then the guarded `LINEAR_IR_STRING_CHAR_CODE_AT_FN` definition (2736–2969).
  That final callback is the complete extraction target, not the whole function.
- `src/codegen-linear/index.ts::sourceMayUseLinearIrStringRuntime` (71) and the
  flag-enabled generator register this provider for real charCodeAt source use.
- `linear-integration.ts::makeLinearIrResolver` exposes `stringMethodPlan`
  (2001) and `emitStringCharCodeAt` (2079); the latter checks the memory plan
  and calls this runtime helper. Both callers remain unchanged and read-only.
- ABI is `(i32 stringPointer, i32 utf16Index) -> f64`, five i32 extra locals:
  byteLen, bytePos, unitPos, lead, codePoint. Current first extra local is 2.
- Canonical `LINEAR_STRING_LENGTH_OFFSET` is 8 and
  `LINEAR_STRING_ELEMENTS_OFFSET` is 12 in `ir/analysis/linear-memory-plan.ts`.
  UTF-8 storage is decoded into UTF-16 code units. The ASCII dependency is
  `__str_is_ascii(i32)->i32`; it may memoize at string-header byte 1.
- Existing `tests/issue-2956.test.ts` includes ASCII/BMP/astral/omitted/bounds
  source assertions. `tests/linear-charcodeat-ascii-fast-path.test.ts` includes
  source and runtime controls; its historical ASCII-only comment is not current
  admission proof. Neither file has been run for this plan.

## Implementation Plan

### Source slice — two files, one existing function region

Sol source owns only the new import in `src/codegen-linear/runtime.ts`, its
charCodeAt body-factory delegation, and new
`src/codegen-linear/runtime/strings/char-code-at.ts`. Keep the exported runtime
symbol, function guard, registration arguments/order, five-local count and
neighboring appendASCII/charAt code byte-for-byte unchanged where possible.
No edits to `addRuntime`, `addStringRuntime`, `__str_is_ascii`, findFuncIndex,
addRuntimeFunc, registry, indexes, GC paths, or existing tests.

The leaf exports `buildLinearCharCodeAtBody(asciiFuncIdx: number,
firstLocalIdx: number): Instr[]`. Import the instruction type from the Wasm
model and the two existing canonical layout constants. No WasmModule, context,
AST/checker, allocation policy, registry, frame allocator or resolver callback
enters the builder. These numeric inputs are supplied by the actual caller;
they are not self-authenticating ownership tokens or newly assigned indices.

The existing callback delegates with `findFuncIndex(mod, "__str_is_ascii")`
and its supplied `firstLocalIdx`. Resolve inside the existing callback, after
the existing idempotence guard and registration setup; do not move lookup ahead
of those effects. The defined-function lookup already accounts for imported
functions. Never substitute name lookup inside the leaf, index guessing, module
cloning/rebasing, resource adoption, or an unverified numeric receipt.

Move the full existing decoder and its local instruction factories together:

1. Signed-negative index returns f64 NaN before any string read/helper call.
2. Load byte length; unsigned index >= byte length returns NaN before ASCII call.
3. Call the supplied ASCII helper; true loads payload[index] and widens unsigned
   i32 to f64. Keep this call and its cache effects, not a copied ASCII detector.
4. Otherwise walk bytes and UTF-16 units. Preserve one-/two-/three-byte handling,
   four-byte high/low surrogate formulas, unit increments, branch depths and
   final NaN. Keep all mask/shift constants and instruction order unchanged.

Replace only layout literals 8/12 used as length/payload offsets with the canonical
constants; do not mistake decoding shifts or UTF-8 widths for layout offsets.
Each invocation creates fresh arrays, instruction objects and nested block types,
including decodeTwo/Three/Four and every then/else/body array. No module-scope
instruction cache, shallow shared templates or instruction reuse across functions.
The builder emits no malloc, store or memory growth; its emitted ASCII call still
has the existing header-cache effect. No malformed-UTF8 policy or numeric argument
conversion changes belong here; the helper boundary receives signed i32 indices.

This is a used target-side body, not a new umbrella runtime or generic semantic
layer. Reuse small decoder factories within this leaf; no new optimization pass,
dispatch registry or orchestration. Future A-owned reservation wiring may provide
the resolved helper index after authentic reservation; that wiring is NOT delivered.

### Test slice — one new file, ten ordinary tests

Sol test owns only `tests/issue-6911-linear-ir-char-code-at-provider-body.test.ts`.
Use existing public runtime/compiler APIs on both arms; do not import the new leaf
on baseline, alter existing fixtures, or fabricate a successful IR body. Arrange
independent tests so one failure does not prevent the other observations:

1. Independent native-JS oracle for the finite strings/indices below; compare
   actual compiler/helper results against it, never baseline alone.
2. Production ASCII source: `export function at(i:number):number {
   const s="Ab9~"; return s.charCodeAt(i); }`. Public `compile`, explicit
   `moduleName:"issue-6911.ts"`, target linear, optimize/maps off,
   experimentalIR false, disableIrFirst true, `JS2WASM_LINEAR_IR=1`.
   Require call-through generator/overlay/runtime registration observations,
   current compilation's admitted owner/body and actual provider call, validated
   binary and execution for indices -1,0,1,3,4. No stale global report alone.
3. Real runtime ASCII helper with all indices of `Ab9~`, including repeated calls
   on the same allocation to exercise both cold and cached ASCII verdicts.
4. Runtime BMP/mixed UTF-8: `aéb€c`, all UTF-16 positions, length and byte-length
   boundaries; include a prefix-ASCII string ending in é to guard full detection.
5. Runtime astral: `a😀b`, all units, high 0xd83d and low 0xde00, then bounds.
6. Runtime empty and signed-i32 extremes: empty at -1/0/1; valid nonempty input
   at INT_MIN/INT_MAX. Require typed NaN, no giant allocation or unbounded scan.
7. Registered symbol/ABI/five-local inventory and idempotence of the existing
   builder; retain unchanged sibling helper bodies and resource counts.
8. Deep fresh-object custody across two independently built modules and a third
   after mutating one test-owned nested instruction/block type. Compare structural
   equality and recursively disjoint mutable objects, not just root-array identity.
9. Real harmless function-import prefix and an imported ASCII-helper namesake:
   verify the emitted call targets the actual defined helper with import offset;
   the namesake throws if invoked. Do not patch/rebase generated call operands.
10. Cache effects and early exits on one real allocated string: snapshot memory
   and arena state after construction. Valid calls may change only cache byte 1
   (unknown to the existing yes/no verdict); negative/byte-bound exits must not
   call the helper or warm that cache. Repeated calls allocate nothing. Payload,
   length, other header bytes and adjacent memory remain unchanged.

For runtime rows use real addRuntime/addUint8ArrayRuntime/addArrayRuntime/
addStringRuntime/addLinearIrStringRuntime and `__str_from_data`, as existing
controls do, with bounded strings. Construct first, then snapshot/call repeatedly;
do not rematerialize per read or fake headers/ASCII caches. Unit wrappers resolve
actual helper indices. These rows prove runtime preservation, not Unicode source
admission. Do not add a Unicode source success assumption; preserve all genuine
existing source failures and any separately requested positive requirement as red.
Restore environment/spies in finally; no any casts or weak typecheck configuration.

### Evidence, ownership and quality gates

Parent alone owns documentation, evidence and serialized heavy validation.
`src/codegen-linear/runtime/README.md` is B's 6905 parent-owned document, published
at the parent-reported `69d2` checkpoint; parent may reuse its exact published
bytes under the explicit docs handoff. Parent creates only the new
`src/codegen-linear/runtime/strings/README.md` boundary documentation. Neither
README belongs to source/test workers. Declare body-only target builders using
canonical layout contracts and fresh mutable instruction trees; no frontend
imports, module registration/mutation or index/ownership authority. No A transfer.

Freeze identical new test bytes on baseline 6c88 and the exact candidate. Emit
ten uniquely identified nonempty observation rows, including failures, with each
finite case array explicitly counted. Record source/options/runtime/test hashes,
call ownership, helper ABI/indices, binaryBase64 plus SHA256, memory/cache effects
and native expected/actual values. Encode NaN explicitly (e.g. `{kind:"nan"}`),
not JSON null; tag ordinary numbers separately and preserve -0 if encountered.
Require exact full-row equality and exact artifact bytes for matching arm/config,
apart from separately recorded epoch/timing provenance. No digest exclusions,
normalization hiding changes, performance claim or configuration tuning.

Parent runs unchanged relevant populations in issue-2956 and the ASCII-fast-path
test on both arms, preserving original fixtures and all red outcomes. Run strict
test-inclusive TS7, lint/format and existing size/ownership gates with unchanged
settings. An instrument repair requires separately retained versions/diagnostics
and identical paired reruns; no skips, it.fails or pinning failures as success.

Parent's completed baseline on 6c88: both unchanged control files together
**28 pass / 3 fail / 31**, exit 1, total 49.81s (external deadline 300s).
The original issue-2956 charCodeAt source case fails compilation. Unicode runtime
units do not prove frontend admission. Preserve all 31 original controls and all
three failures; parent retains exact diagnostics for attribution, without assuming
the other two causes here. Candidate must retain the same population and behavior.
This releases only the reviewed extraction after parent's exact K/T claims and
source freeze: actual body/ABI/five locals/cache/caller preservation, no admission fix.

No budget grant is issued here. runtime.ts/addLinearIrStringRuntime must shrink;
measure any new leaf/function gate failure before requesting an exact issue-owned
grant for the moved body only. Never borrow another issue's allowance, inflate a
baseline, or broadly exempt the directory. No tests/heavy jobs were run in planning.

## Acceptance

- [ ] Fresh exact K/T claims and parent-reviewed partition before implementation.
- [ ] Existing real caller delegates; only the released two source files change.
- [ ] All ten new tests measured; source route/callee attribution is non-vacuous.
- [ ] Identical paired rows/artifacts, native oracles and cache/custody controls.
- [ ] Existing controls and strict test-inclusive checks retain their full results.
- [ ] Parent publishes coherent evidence; no new Prepared coverage/retirement claim.
