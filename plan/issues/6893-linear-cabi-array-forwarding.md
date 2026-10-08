---
id: 6893
title: "Linear C ABI: resolve forwarded array headers before export return marshaling"
status: in-progress
created: 2026-10-07
updated: 2026-10-07
sprint: Backlog
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen-linear
language_feature: arrays
goal: correctness
related: [1835, 1938, 1977, 3518, 4539, 4542]
origin: "Session B parent-confirmed latest-main C-ABI growth repro; bounded export-return scope"
---

# Resolve array forwarding at the Linear C-ABI export boundary

## Baseline and ownership

Exact canonical baseline: `91e519587ec2d383a96cfc7d06f48bac04d2c286`.
Planning worktree: `/private/tmp/js2-6893-linear-cabi-plan-20261007`, branch
`codex/6893-linear-cabi-plan-20261007`. Sole architect write is this file.
Parent reports effect-verified specification claim
`6893:linear-cabi-plan-20261007`, owner
`ttraenkler/codex-linear-b-cabi-astra-20261007`, reserved issue and successful
PR scan. Architect performed source/logical review only: no tests, source
edits, commits, pushes or claim operations.

Parent's positive inventory covered 20 open PRs, none touching `c-abi.ts`;
no current export-wrapper claim was found. Parent reports A's 45 prepared
paths exclude this file. Local issue inspection found no competing array-return
forwarding scope. Preserve these distinct records:

- 4539, "Linear lane: import C functions, share the engine's memory instead of
  owning it": import direction, not this export return.
- 4542, "Refcount discipline for the boxed tier: a handle-scope /
  destructor-insertion pass covering exceptional paths": import ownership
  annotations and refcount machinery, not this return marshaling.
- 1650's backlog string-boundary encoding work names the same wrapper function
  but its per-argument string path, not this array-return arm.
- Historical 1835/1938 layout/f64 and 1977 runtime forwarding work is reused,
  not reopened as a broad array or ABI redesign.

Any newly discovered active claim to this exact array-return function region
requires stopping for parent comparison. Do not touch peers' Acorn/LFS or
other work, even if visible in the checkout.

## Authoritative baseline observations and their limits

Parent ran latest-main probe session `46077`, exit 0, on the exact baseline
above. These are parent-measured rows, not architect-executed results:

- `alias31`: source return type `number[]`; compilation success and Wasm
  validity both true. IR report `compiled: []`; rejection is missing return
  type annotation/override despite explicit `number[]`. Direct fallback is
  active. Actual C-ABI result `[1040, 2]`, decoded elements `[1.5, -2.25]`.
  Expected length 32, first two values preserved, last element at index 31
  equal to `3.75`. Index 31 genuinely exceeds initial capacity 16.
- `owned31`: same source return type, successful/valid output, empty IR
  compiled population and same return-type rejection/direct fallback.
  Same actual `[1040, 2]` and `[1.5, -2.25]`; expected length 32 and final
  element `3.75`, preserving the first two values. This also truly grows.
- `scalaralias31`: source scalar return, `compiled: ['run']`, `rejected: []`,
  valid Wasm true; actual `0`, expected `3.75`. This is a separate demonstrated
  IR array-read failure, plausibly inline `vec.get` reading a forwarding
  header. Attribution to a specific emitter operation remains a hypothesis.
  A owns read-emitter investigation/fix; this wrapper change cannot fix it.
- The earlier index-7 probe stayed within initial capacity and was **not a
  bug reproduction**. Preserve it as an in-capacity control; credit no
  failure-to-pass improvement from it.

Parent must retain the exact original probe sources/options and raw report
rows with these observations in its integration evidence; do not reconstruct
and relabel a similar source as the original. No additional unreported pass
counts, decoded gap contents, raw error wording, pointers or IR ownership are
claimed here. Probe process exit 0 does not mean its semantic checks passed.

## Root cause and exact source anchors

`src/codegen-linear/c-abi.ts:220`, `emitCabiWrappers`, calls the exported TS
function and, at its aggregate return arm near line 311, immediately uses
`local.tee __ret_ptr`, adds 16 for arrays and loads length at +8. Neither
operation first resolves forwarding. An original array pointer may therefore
still address the old header and payload after a real growth operation.

Existing contracts and implementation establish the correct operation:

- `src/ir/analysis/linear-memory-plan.ts:82`, `LINEAR_ARRAY_FORWARDING`, owns
  the tag and replacement-pointer layout; this issue does not duplicate it.
- `src/codegen-linear/runtime.ts:797`, `ensureArrayResolveRuntime`, registers
  `__arr_resolve(i32)->i32`, following the complete forwarding chain.
- `runtime.ts:847`, `addArrayRuntime`, ensures that resolver exists.
  `__arr_grow` near line 887 copies slots and rewrites the old header into a
  forwarding record; `__arr_set` near line 1102 resolves/grows and updates
  the new header's length. Runtime accessors already reuse the resolver.
- `src/codegen-linear/index.ts:2991` gives literals capacity
  `Math.max(elements.length, 16)`. This explains why index 7 was insufficient;
  this file is read-only and is not part of the fix.
- `src/compiler/output.ts:82`, `applyCabiTransform`, derives existing export
  descriptors and calls `emitCabiWrappers` at line 153. Output preparation,
  type inference and C-header generation remain untouched.
- `c-abi.ts:42`, `findFuncIndexByName`, already finds a runtime symbol by name
  and includes **function** imports in its absolute index. Reuse it unchanged;
  never hard-code the resolver slot or use unadjusted `functions.findIndex`.

The public wrapper failure is independently fixable without admitting a new
source IR return type. This is target-boundary correctness for the existing
public fallback path and the eventual fully implemented IR ABI, **not a
demonstrated source-IR array-return capability**.

## Implementation Plan

### K — single existing source function

Write only `src/codegen-linear/c-abi.ts::emitCabiWrappers`, in its array-return
marshaling region. Immediately after the original call has put an array header
pointer on the stack, and before the existing return-pointer `local.tee`:

1. For `info.result.semantic === 'array'` only, resolve the existing symbol
   `__arr_resolve` using `findFuncIndexByName(mod, '__arr_resolve')`.
2. If lookup returns -1, throw an actionable compiler-side error identifying
   the C-ABI array return, export name and missing `__arr_resolve`. Do not
   emit a negative-index call, silently continue with the raw header, register
   a new helper, or add a fallback implementation. This is a module assembly
   invariant failure, not a new runtime array/null check.
3. Emit one `{ op: 'call', funcIdx: resolverIndex }` before the existing
   `local.tee`. The resolved pointer must feed **both** outputs.

Resulting array-return instruction sequence:

```wasm
call $original_export      ;; existing invocation, exactly once
call $__arr_resolve        ;; new, only for array return
local.tee $__ret_ptr       ;; existing local index = wrapper parameter count
i32.const 16
i32.add                   ;; first result: current payload
local.get $__ret_ptr
i32.load offset=8 align=4  ;; second result: current element count
```

`Instr` load alignment remains the existing exponent `align: 2`; WAT above
expresses alignment in bytes. No extra locals are needed. A non-forwarded
header is returned unchanged by the resolver; a multi-hop stale alias resolves
to the same current header as runtime accessors. This adds no allocation,
ownership transfer, payload copy or refcount traffic.

Keep string/scalar/object/void returns, parameter constructors and their
existing behavior, import declaration/ownership/address roles, original call,
wrapper signatures, export replacement, C headers and runtime registration
unchanged. Do not make string/scalar wrappers depend on resolver presence.
The new missing-resolver refusal must not be extended to existing parameter
constructor fallback paths under this issue.

Resolve by existing symbol lookup in the current module index regime; retain
the existing `absoluteFuncIndexCached` handling of original export handles.
No late-import shifting, symbol registry redesign or shared layout edits.
Import-offset tests below verify the actual emitted call, not just a lookup
integer. If final serialization exposes a separate handle-layout defect,
stop and report it rather than editing shared wiring.

### T — one new issue-specific test file

Write only `tests/issue-6893-linear-cabi-array-forwarding.test.ts`.
Keep original fixtures and legacy suites unchanged. Follow existing actual
binary execution patterns in `tests/issue-1835.test.ts` (C-ABI strings/arrays),
`tests/issue-1938-number-array-f64.test.ts` (fractional slots), and
`tests/issue-1977.test.ts` (growth/aliases). K and T are disjoint slices.

1. **Public source reproduction:** use the parent's preserved `alias31` and
   `owned31` sources/options, with `target:'linear', abi:'c'`. Require success,
   valid binary and the actual C-ABI pair. For these original sparse index-31
   probes, assert only the proven length 32, preserved first two values and
   last value 3.75. They create JavaScript holes: do not assert zero-filled
   padding as exact JS parity or change hole semantics. Record actual
   IR compiled/rejected/owner report beside each source execution. Never
   assert a fabricated positive IR owner, modify annotations to conceal
   fallback, or count rejection as satisfying IR-return coverage. Preserve
   the no-growth index-7 control separately.
   Add the parent's distinct dense-growth positive, without replacing or
   relabeling either original reproduction:

   ```ts
   export function run(): number[] {
     const values = [1.5, -2.25];
     const alias = values;
     for (let i = 2; i < 32; i++) alias[i] = i + 0.25;
     return values;
   }
   ```

   Require all 32 JS numbers exactly, decoded at an 8-byte f64 stride; the
   expected tail is 31.25. Add the same bounded dense fixture through length
   96 to cross multiple growth boundaries, expected tail 95.25. Derive the
   complete expected lists from the dense JS operation, not raw hole storage.
   Record actual route ownership for these new fixtures as well; they are
   proposed tests, not already measured parent rows.
2. **Actual runtime forwarding chain:** build a minimal module with real
   `addRuntime`, `addArrayRuntime` and `emitCabiWrappers`, plus a tiny raw
   header-identity function with direct i32 input and array-semantic result.
   Expose the existing runtime new/set/resolve functions for this test only.
   Allocate capacity 1, write index 0 as 1.5 and index 1 as -2.25, then fill
   every index 2 through 95 with i+0.25 through the original alias. Capture
   headers at actual growth transitions. Require at least two distinct
   forwarding links formed by the real growth runtime;
   inspect them via the shared forwarding contract, not hand-written tags.
   Pass the oldest header through the real C wrapper. Require data pointer
   `finalResolvedHeader+16`, length 96 equal to its +8 field, and every f64
   slot against the dense expected list, including fractional endpoints.
   There are no hole/padding parity assertions. Do not resolve
   the pointer in the test before supplying it to the wrapper. This is a
   runtime/wrapper unit contract, explicitly **not source-IR admission proof**.
3. **Bounds and immutability:** reacquire DataView after runtime calls; ensure
   payload pointer is 8-byte aligned, length <= final capacity and the full
   `pointer + length*8` region fits memory. Snapshot old forwarding headers,
   final header/payload and a separately allocated neighboring sentinel record
   after growth but before wrapper invocation; wrapper must leave them
   unchanged. It must not allocate or copy payload. Compare wrapper results
   for original alias and already-current pointer. Do not index an unchecked
   host view into a corrupt/unbounded length.
4. **No-growth and unrelated returns:** capacity-sufficient/empty array
   results stay correct; fractional no-growth arrays retain 8-byte stride.
   Existing string UTF-8 pointer/byte-length and scalar direct results remain
   unchanged, with unchanged signatures/C-header text on identical sources.
   Their modules need not supply `__arr_resolve`. Do not credit fixing the
   separately failing scalaralias31 IR probe.
5. **Import-offset positive/negative controls:** create imports *before*
   runtime builders, including at least two function imports and an interleaved
   non-function import (e.g. immutable global). Supply real host imports and
   execute the grown-array wrapper. Resolve the emitted call's target using
   the existing layout API; verify it names the defined `__arr_resolve`, not
   an import, neighboring runtime helper or raw definition index. A test-only
   same-signature decoy import can throw if wrongly called. No production
   import-registration edits. Include original export represented by the
   existing supported stable-handle fixture pattern if applicable; do not
   invent a new handle representation to claim support.
6. **Missing resolver must fail closed:** in a separate new minimal module,
   provide an original i32-return export with array result metadata but no
   resolver; wrapper emission must throw the named invariant error. Do not
   strip the resolver from existing positive fixtures or weaken their setup.
   Equivalent string/scalar-only fixtures without that resolver must still
   emit normally. Assert array wrapper body resolves exactly once after the
   original call and before pointer/length marshaling.

The two original public failures must fail their length/last-value assertions on the
exact baseline and pass on the candidate. Use identical new test bytes on
both; report expected baseline failures separately from already-passing
controls. Do not require the whole baseline new suite to pass. Retain exact
source/options, full commits, test/source digests, Node/V8, report ownership,
actual pairs/payloads/errors, and pass/fail/skip denominators. Parent runs
existing `tests/c-abi.test.ts`, `tests/issue-1835.test.ts`, fractional-array,
growth and import-direction controls unchanged. No performance claim or new
benchmark is part of this issue.

## Architecture, dependencies and explicit remaining failures

Generic semantic/ABI preparation precedes target-specific consumption. This
leaf consumes the existing array semantic descriptor, forwarding contract and
runtime resolver; it introduces no alternate type/admission authority and no
duplicated forwarding algorithm. Related code stays inside the existing
target C-ABI module. No broad helper, optimizer, inlining/DCE or orchestration
refactor is justified by a one-call return-boundary correction.

A owns frontend normalization, return signatures/ABI preparation, shared
LinearEmitter array reads and final integration. The following remain explicit
global obligations under 3518, "IR-only default and direct front-end
retirement", and parent/A coordination:

- Admit and correctly prepare real source `number[]` returns, then prove the
  exact source owner compiled through IR, with no direct fallback, reaches
  this C-ABI wrapper and returns the grown payload.
- Diagnose/fix `scalaralias31` returning 0 instead of 3.75 on its confirmed
  IR-owned path; do not attribute that result to this return-boundary fix.

Neither obligation requires expanding this independently useful public C-ABI
fix, but neither is discharged by it. Preserve their raw failures globally;
do not pin the current rejection as a permanent acceptance requirement or
close full IR coverage using synthetic exports. Positive source-IR return
coverage remains outstanding until A's change and fresh execution establish it.

## Acceptance and release boundary

- [ ] Parent-preserved sparse index-31 repro fails on exact baseline and passes
  its proven length/first/last assertions on candidate, with no hole-parity claim.
- [ ] Separate dense 32/96-element public fixtures return the complete exact
  fractional payload from the current header; original sparse repros retained.
- [ ] Real two-hop growth, current/no-growth/empty, bounds and sentinel controls pass.
- [ ] Resolver call uses the correct import-adjusted symbol and fails closed
  only for missing array-return resolver; no silent raw-header fallback.
- [ ] String/scalar/import/constructor contracts, ownership and C headers preserved.
- [ ] Diff contains only K's array-return region and T's new test file.
- [ ] Actual route reports retained; array-return admission and scalar IR read
  failure remain explicitly unresolved under A/global integration tracking.

This plan supports a finite independent K/T implementation release after
parent effect-verifies their exact claims. It is not itself an implementation
claim, a test result, permission to modify shared files, or final integration
acceptance. No changes are released to `src/compiler/output.ts`, compiler
entrypoints, `src/codegen-linear/index.ts`, shared IR/layout/metadata,
`linear-integration.ts`, `linear-emitter.ts`, runtime, imports/refcount, C-header
generation, source-map paths or existing tests.

## Validation amendment — finite no-resolver string-fixture repair

### Preserve v1 evidence and classify the failure

Parent reports identical-test v1 baseline execution on exact
`91e519587ec2d383a96cfc7d06f48bac04d2c286`: **10 failed, 6 passed / 16**.
The v1 test SHA-256 is
`d84af82e9bd232380753227d0ff3424c501f267a7a8258db1c797be2ccc37894`.
One failure is an instrument setup defect: the no-resolver string unit calls
`addStringRuntime`, which throws for missing `__u8arr_len` during module
construction, before emitting/executing the intended wrapper control.
The parent is running the immutable v1 file on the candidate; its results
remain pending at amendment time and must be recorded without substitution.
No candidate count is inferred from the baseline or a predicted 15/16 split.

Source inspection confirms the dependency:
`src/codegen-linear/runtime.ts::addStringRuntime` (line 1399) resolves
`__u8arr_len` near line 2065. The intentionally minimal absence fixture does
not install that runtime. This is not evidence that the production C-ABI
change broke strings, nor that the new absence assertion executed successfully.
The earlier read-only test review missed this setup dependency; it does not
override the actual red result. Preserve all v1 test bytes, raw logs and
provenance, including this failure and the separate A-owned scalar failure.

### T-only repair; K source remains unchanged

Edit only the existing new test
`tests/issue-6893-linear-cabi-array-forwarding.test.ts`, specifically the
`"emits and executes %s without any resolver"` string setup. Remove its
`addStringRuntime` call and unused import and its `__str_from_data` export/use.
Keep `addRuntime`, the existing raw-header identity and actual
`emitCabiWrappers`/binary execution. Expose the existing `__malloc` function
through the test's existing export helper; do not define any substitute
constructor/provider or new Wasm helper. No source change is needed.

For the string arm only, prepare a canonical record as follows:

1. Encode the unchanged `"é😀"` fixture with `TextEncoder` (six UTF-8 bytes).
2. Call the real exported `__malloc` with
   `LINEAR_STRING_ELEMENTS_OFFSET + bytes.length` (18 bytes before allocator
   alignment). Reacquire DataView/Uint8Array after that call, which may grow
   memory. Validate the allocated header/payload range before writing.
3. The real allocator clears the header word at +0 (`runtime.ts:302–323`);
   leave that responsibility there. Do not install an array tag or resolver.
   Optionally assert the observed cleared word before host initialization;
   do not overwrite it to make a broken allocator appear correct.
4. Use shared constants from `src/ir/analysis/linear-memory-plan.ts:92–96`:
   store `bytes.length + LINEAR_STRING_PAYLOAD_PREFIX_BYTES` at
   `raw + LINEAR_STRING_PAYLOAD_SIZE_OFFSET` and `bytes.length` at
   `raw + LINEAR_STRING_LENGTH_OFFSET`, both u32 little-endian. Copy the exact
   UTF-8 bytes to `raw + LINEAR_STRING_ELEMENTS_OFFSET`. This is layout-driven
   test initialization, not a new production string-building algorithm.
5. Take the memory snapshot and arena-usage observation **after** allocation
   and initialization, then call the actual identity wrapper with `raw`.
   Require exactly `[raw + LINEAR_STRING_ELEMENTS_OFFSET, bytes.length]`,
   exact six output bytes and decoded text, the unchanged C header signature,
   unchanged memory and unchanged arena usage across wrapper execution.
6. Assert `__arr_resolve` remains absent before and after wrapper emission.
   Do not add array/Uint8Array runtime merely to satisfy string-builder
   dependencies; that would invalidate the absence control.

This unit is explicitly **raw-record wrapper coverage**, not string-provider
construction or source-IR execution proof. Its direct i32 identity parameter
must remain direct; it must not exercise missing-constructor fallback by
pretending to be a C-ABI string parameter. Keep the existing public UTF-8
source-compile case unchanged as the separate real production-path control.

Do not alter any other case, especially the original scalar IR assertion of
`3.75`, ownership assertions, sparse probes, dense fixtures, import/stable
controls or missing-array-resolver refusal. No skip, expected-failure wrapper,
observed-zero expectation, helper stub or changed fixture semantics is allowed.
The scalar `0` result remains A-owned and must remain visible if still present.

### Paired v2 validation and attribution

Parent retains the immutable v1 candidate execution and archives v1 bytes/logs
before using v2. Run identical v2 test bytes on exact baseline and the actual
source-fix candidate, sequentially as coordinated. Record each full revision,
new test digest, source digest, Node/V8/options and actual pass/fail totals out
of the unchanged 16 cases. Use distinct v2 log names; never overwrite or
relabel d84 v1 results. No heavy validation is performed by this architect.

Any no-resolver string case that changes from setup failure to pass on both
sides is an **instrument-repair gain**, not a production C-ABI improvement.
Credit the production wrapper only for actual same-v2 baseline-to-candidate
improvements, retaining exact payload/route/error rows and unchanged controls.
Do not assume either outcome before execution. If another concrete fixture
defect appears, stop and report it rather than broadening this repair.

Correctness acceptance for the bounded C-ABI change is separate from full
integration acceptance. Even if all C-ABI-owned checks pass, a remaining
scalar IR failure keeps the suite red and the PR held for coordinated A
integration. Array-return source-IR admission also remains unproved until its
own positive source-owner evidence exists. No new claims, source edits,
commits, benchmark work or shared-wiring authority arise from this amendment.

## Containment amendment — defined resolver, not a namesake host import

### Source-derived supported risk; execution evidence pending

Read-only review found a supported configuration that the original K lookup
does not distinguish. This is a source-derived risk, **not a runtime-tested
reproduction**; no extra pass/fail counts are claimed. The relevant API chain
on the reviewed baseline/source implementation is:

- `src/index.ts:1141`, `CompileOptions.linearExternImports`, accepts external
  C import descriptors. `src/compiler/linear-options.ts:18` forwards them to
  `LinearOptions.externImports` without a runtime-name restriction.
- `src/codegen-linear/c-abi.ts::declareExternCImports` (baseline line 538;
  first K candidate line 548) registers the supplied import field name.
  Its checks concern declaration ordering and ownership; there is no reserved
  `__arr_resolve` name check. A non-engine `(i32)->i32` import can use that name.
- `src/codegen-linear/index.ts:196` declares imports before runtime builders;
  lines 221–224 install the array runtime. The defined resolver is still
  registered: `ensureArrayResolveRuntime` checks definitions, not imports.
  Runtime `findFuncIndex` near `runtime.ts:4225` also searches definitions
  and adds the function-import count, so runtime accessors use their helper.
- In contrast, `c-abi.ts:42`, `findFuncIndexByName`, searches function imports
  first by unqualified field name. The initial K addition therefore selects
  the foreign import rather than the defined runtime resolver when both exist.

A same-signature throwing host import would cause the new array-return call
to throw even for an ordinary no-growth array. The baseline wrapper never
made this call. An imported namesake without any definition would also
incorrectly satisfy the intended missing-runtime-resolver check. These are
concrete source mechanisms to validate, not claims of an executed regression.

### K — replace only the new array-return lookup

This amendment supersedes the earlier instruction to use
`findFuncIndexByName` for the array-return resolver. Write only inside
`emitCabiWrappers`' existing `info.result.semantic === 'array'` guard:

1. Find the position of the **defined** function named `__arr_resolve` in
   `mod.functions`, without consulting imports for the provider identity.
2. If no definition exists, throw the existing named C-ABI array-return
   invariant error, even if an import has that field name.
3. Add the current count of imports whose `desc.kind === 'func'` to that
   definition position. Reuse the wrapper's already-derived `numImportFuncs`
   (imports are not mutated in this function); never count non-function
   imports or emit the raw definition position as a call index.
4. Emit the same single resolver call before `local.tee __ret_ptr`, preserving
   the original call and both return outputs exactly as in the first K patch.

Do not change the general `findFuncIndexByName` helper, parameter-constructor
selection, `declareExternCImports`, import-name acceptance, ownership/address
roles, runtime registration, ABI, C headers, shared layout or compiler wiring.
The import remains legal; it simply cannot impersonate this defined runtime
dependency. No new registry, name-reservation policy or provider framework.
Original export stable-handle normalization remains unchanged.

### T — two additive controls; all 16 v2 cases retained

Only `tests/issue-6893-linear-cabi-array-forwarding.test.ts` is writable by T.
Retain every current v2 case and assertion, including the corrected raw-record
string absence fixture and the A-owned scalar assertion expecting `3.75`.
Add these two independent cases, without replacing existing import controls:

1. **Public namesake import:** compile a separate no-growth fractional array
   source, such as `export function run(): number[] { return [1.5, -2.25]; }`,
   with the existing public Linear/C-ABI options and
   `linearExternImports: [{ module: 'host', name: '__arr_resolve',
   params: [{kind:'i32'}], results: [{kind:'i32'}] }]`. Use `optimize:false`;
   no TS declaration or source call to the host function is required. Verify
   the emitted import inventory actually includes that function. Instantiate
   with a counted host implementation that throws when called. The actual
   array export must return length 2 and both exact f64 elements, with host
   call count zero and its C header unchanged. Record full source/options,
   imports and actual route; this fixture is not an IR-return admission proof.
   Parameterize the existing public-fixture setup minimally or make a narrow
   local setup in this case: do not weaken its zero-import assertions for
   existing no-import cases. The import must not be pruned/missing while the
   test silently claims a collision was exercised.
2. **Import-only absence:** use a distinct minimal module with a legal
   `(i32)->i32` function import named `__arr_resolve`, registered before the
   ordinary allocator/runtime setup, but no defined array resolver. Add the
   same raw-header identity/array-return descriptor as the existing missing
   resolver negative. Assert the import exists and the definition does not;
   actual `emitCabiWrappers` must throw the named missing-resolver invariant
   error. Do not add array runtime or accept a successful host substitute.

Existing real-growth, interleaved non-function import, stable-handle and exact
call-target assertions remain in place. The public no-growth control isolates
new shadowing from the baseline's separate growth defect; the synthetic
negative proves fail-closed definition custody, not source admission.

### Evidence and acceptance classification

Preserve v1 and v2 test bytes, digests, every raw result and the original
instrument-setup failure. Do not overwrite running/archived tests or logs.
The architect has neither executed these two additions nor inferred results
from the paired v2 run. Parent records that run's actual outcomes separately.

After K/T completion, parent runs identical amended test bytes on exact
`91e519587ec2d383a96cfc7d06f48bac04d2c286` and the newly recorded candidate,
with fresh names/digests and actual denominators (18 cases if exactly these
two are added). If checking the initial K revision to establish the shadowing
regression, record that third exact revision separately, not as the baseline.
No extra run is performed or scheduled by this specification author.

Expected obligations, not measured outcomes: the no-growth namesake control
should remain correct on original baseline and the amended candidate; the
import-only absence control should fail closed only after the scoped fix.
Any gain from the earlier string-fixture repair stays classified as instrument
repair. Public growth fixes, namesake-regression prevention and the unresolved
A-owned scalar-read/array-return-admission obligations remain separate.
Keep the PR held while coordinated A integration requirements remain unmet.

## Parent-measured checkpoint outcome

Final candidate witness `f23aa8afd7d8cc483b3ec92cfde45b525d6d13ae`,
source implementation `608edfabf404aba0e69691eeccbda7518ca7988d`;
exact baseline `91e519587ec2d383a96cfc7d06f48bac04d2c286`.
Identical final test digest
`7612ec537bd3876f3a872e029629601442b7593b1150c30cd25d49db7351be62`.
New regressions: baseline8 pass/10 fail versus candidate17 pass/1 fail /18.
Unchanged controls: both78 pass/2 fail /80. Candidate combined95 pass/3 fail
/98. All retained original cases run; no skips or expected-failure wrappers.

Three positive scalar requirements remain failing under A's shared ownership:
new alias read0 vs3.75; existing issue1977 relocation24 vs69 and alias16 vs40.
These tests/paths remain unchanged; scalar controls do not exercise array
return marshaling. No full IR migration or source-return admission acceptance.
Public array-return functions still report actual legacy fallback.

Both v3 logs contain33 structured records. Ten recorded route/control kinds
are exactly deeply equal, and growth custody observations are unchanged
apart from the deliberately repaired oldest-alias pair/payload. Raw v1/v2/v3
results, original instruments, full memory observations, environment and
hashes live in `plan/log/6893-linear-cabi-20261007/`; see
`final-comparison.json` and the Session B handoff for A's integration request.
Retain status in-progress and PR hold until coordinated acceptance.

## Current-main composition qualification — 2026-10-07

This append specifies a new measurement epoch, not a measured result or a source
release. All preceding plans, failures, fixtures and evidence remain immutable.
Planning slice `6893:linear-cabi-main-composition-plan-20261007` belongs to
`ttraenkler/codex-linear-b-cabi-main-astra-20261007`; its only write is this append.
Parent owns execution/evidence. A retains shared source ownership and final
integration/queue authority; PR6568 remains HOLD pending reviewed acceptance.

### Frozen operands and dependency attribution

- Baseline: canonical main `e1e07bd4683faafcd69846bc757cce36ebb9fb61`.
- Composed candidate: `3cba5b08c59fa4d63c238629c0fad456c8c5eae4`, merging that main
  into the existing B packet. Static comparison confirms its entire production
  delta against baseline is `src/codegen-linear/c-abi.ts`, the ten-line array-return
  resolver selection/call before `local.tee`; no shared source delta is authorized.
- Both arms use identical `tests/issue-6893-linear-cabi-array-forwarding.test.ts`,
  SHA-256 `7612ec537bd3876f3a872e029629601442b7593b1150c30cd25d49db7351be62`.
  Freeze every control test and relevant production input before/after execution.
  Record actual commits, tree/input hashes and dirty state; later main movement
  does not silently change either operand or inherit these results.
- Main contains A's `2a98b75de9` forwarding repair. Its published contract is
  [issue6897](6897-linear-ir-vector-read-forwarding.md): the closed vector
  `resolve-forwarding` operation, `LinearEmitter.emitVecLen/emitVecDataPtr`
  resolver calls, and integration demand/typed defined-helper preflight before
  frozen-body consumption. Demand includes reads with no allocation. Both arms
  consume that same landed implementation; B does not copy or modify it.
- Historical combined **95 pass/3 fail of98** remains historical. The retained
  scalar requirements **3.75,69,40** (previously **0,24,16**) must now pass in BOTH
  arms with their original source/options. Attribute that improvement to A6897,
  not B's return marshaling. A's independent results do not substitute for this run.

### One paired, unchanged 98-case population

Parent runs both frozen arms sequentially with identical harness/environment and
test bytes, preserving all names, statuses, complete failures, raw stdout/stderr,
exit codes and deadlines. Record Linear lane, C ABI where selected by the original
fixture, effective compiler options, `JS2WASM_LINEAR_IR`, Node/V8/execArgv and other
environment settings; do not force one suite-wide routing configuration over the
existing controls. Use the established serial Vitest protocol and retain the exact
command. No competing heavy job, alternate fixture, instrumentation rewrite or
charCodeAt qualification is part of this packet.

- `tests/issue-6893-linear-cabi-array-forwarding.test.ts`:18.
- `tests/c-abi.test.ts`:38; `tests/issue-1835.test.ts`:8.
- `tests/issue-1938-number-array-f64.test.ts`:17; `tests/issue-1977.test.ts`:8.
- `tests/issue-4539-c-link.test.ts`:9. Existing controls total80; combined total98.

Require collection and terminal identities/statuses to account for every case.
No skip, `it.fails`, changed assertion, green unsupported marker or reduced
population is allowed. Preserve the old V1/V2/V3 instruments, setup diagnostics,
raw logs and `final-comparison.json`; write new evidence separately, not over them.
Do not predict a new baseline pass count from historical arithmetic: measure it.

### Exact records, semantics and custody

Require **33 structured issue6893 records in each arm**, with matching kind/case
multiplicities, not just a total. Compare the existing ten route/control kinds
deeply and exactly between these two new arms: `public-compile`, `public-string`,
`public-scalar`, `runtime-no-growth`, `no-resolver-string`, `no-resolver-scalar`,
`public-namesake-compile`, `public-namesake-imports`, `public-namesake-invocation`,
`public-namesake-array`. Keep provenance separate: revisions/source hashes differ
deliberately. New scalar values need not equal the historical wrong values.

For native array results, retain the original index31 length/tail assertions
without claiming JS hole-padding parity; compare every initialized fractional
element in the dense32/96 fixtures against their existing independent JS oracle.
For all three real-runtime growth rows, preserve real multihop links, original/current
headers, capacity, sentinel, full memory snapshots and allocator-used observations.
Within each arm require reads to leave complete memory and allocation state
unchanged. Across arms compare every existing `growthCustody.unchangedFields`
field exactly; only oldest-alias `actual` pair/payload is the intended growth-row
delta. Candidate oldest/current pairs and complete initialized payloads must agree.
Inspect all remaining record differences, including expected wrapper-contract and
missing-resolver diagnostic improvements; do not blanket-normalize failures or bytes.

Retain real function-import offsets (excluding table imports), stable-handle
finalization, and host namesake controls. Candidate must call the DEFINED runtime
`__arr_resolve`, with zero namesake host calls; import-only absence must reject.
String/scalar no-resolver controls remain valid. ABI signatures, C headers, f64
stride, ownership and import contracts remain unchanged. Record actual binary
validation/hashes; do not require whole binaries to match across a production fix.

Source array-return cases remain honest fallback controls, not new PreparedIR or
overlay admission proof. Record their actual compile/rejection evidence unchanged
between arms. Preserve genuine scalar IR owner requirements; use A's published
attribution only as dependency context, not as a replacement for native results.
Runtime-built wrapper controls likewise earn boundary/runtime credit only.

### Gates, acceptance and stop boundary

Parent runs strict new-test-inclusive typing with the unchanged18-case file included,
plus normal source typing, scoped format/lint, build and required architecture/LOC/
function-budget gates against this actual main base. Retain commands and diagnostics;
no casts, exclusions, borrowed allowances or weakened configuration to obtain green.
Classify any inherited gate failure with an identical baseline check, never conceal it.

Acceptance requires candidate **98/98 pass, zero skips**, baseline controls **80/80**,
all three scalar requirements passing in both arms, exact33-record/ten-kind checks,
and all stated native/memory/import/ABI obligations. Baseline boundary failures must
be recorded individually and the candidate improvement attributable to the sole
C ABI production delta. Unexpected routes, populations, shared failures, custody
changes or gate failures stop acceptance for parent review; they authorize no edits.
No fresh fixtures, shared wiring, registry/ABI change, IR retirement or performance
claim follows. Array-return IR admission remains separately unresolved and gains no
coverage credit from boundary acceptance. Parent may recommend this bounded fix
after reviewing actual evidence; only A can authorize final integration/queue release.

### Measured current-main composition (2026-10-07, pending typing review)

The frozen main epoch above is now tested. Baseline production is exactly main
e1e07bd4683faafcd69846bc757cce36ebb9fb61; test-only baseline HEAD is
a8341b8de729ec1926d940dd31ade3616d5044b0. Candidate execution HEAD is
696d73bee17e0d1a47b2357ad233769b90d2c70f (production unchanged from3cba5b08).
Both retain the unchanged676-line test hash7612ec537bd3876f3a872e029629601442b7593b1150c30cd25d49db7351be62.

- Baseline:89 pass/9 fail of98; all80 existing controls pass. Exit1.
- Candidate:98 pass/0 fail of98, all6 files pass, no skips. Exit0.
- Both original scalar-return3.75 and issue1977's69/40 assertions pass. This
  improvement belongs to A's landed read repair, not B's boundary fix.
- The new count-floored `compare-main-composition.mjs` verifies33 records per
  arm, every kind multiplicity, exact unchanged controls, all full-memory and
  allocator custody observations, and all13 explicitly inspected record deltas.
  All three candidate oldest-alias results exactly equal their current-header
  results and all96 initialized elements. Missing defined resolvers reject.
- Raw logs and comparison are retained separately in
  `plan/log/6893-linear-cabi-20261007/main-e1e/`; all historical failures and
  instruments remain unchanged. Runtime-boundary success does not establish
  source array-return IR admission, performance equality or legacy retirement.

Strict test-inclusive TS7 exposed BufferSource/instantiate typing errors in the
unchanged test. Acceptance remains pending matched-baseline diagnosis and repair
planning; passing runtime tests do not waive this gate. PR6568 remains HOLD, with
Session A owning final integration and queue submission.

Matched-baseline typing is now measured: candidate and test-only main baseline
both exit1 with exactly the same ten diagnostics (full logs byte-equal). The
baseline uses its own worktree-relative configuration, not candidate sources.
Diagnostics concern Uint8Array<ArrayBufferLike> at WebAssembly BufferSource calls
and the resulting instantiate overload; runtime equality does not repair these
types. Raw logs and unchanged strict configuration are archived in `main-e1e/`.
An earlier run used the candidate configuration from the baseline cwd and is not
baseline evidence; the valid rerun uses baseline's own identical configuration.
Astra's read-only review agrees the nine boundary failures are attributable to
the bounded fix. Existing1977 asserts69/40 but does not record their IR route;
retain A6897 attribution rather than claiming independent route proof here.

## Cast-free test byte-buffer repair and requalification — 2026-10-07

Parent reports the unchanged current-main population at baseline89 pass/9 fail
and candidate98/98, with33 records per arm and all strict comparator custody/delta
checks passing. Strict test-inclusive TS7 nevertheless exits1 in BOTH arms with
the same ten diagnostics. Preserve the original676-line test, its SHA-256
`7612ec537bd3876f3a872e029629601442b7593b1150c30cd25d49db7351be62`, all runtime
evidence, and `main-e1e/strict-{candidate,baseline}.log.gz` under this issue's
existing evidence directory. This is an instrument typing repair, not a compiler
fix or a reason to describe the original strict gate as green.

Original test writer Noether has explicitly handed off this bounded test-only
scope to parent/new Sol6.1 worker. This architect retains only append-only issue
ownership under `6893:linear-cabi-main-composition-plan-20261007`; parent handles
writer dispatch and integration onto its frozen successor of `def4c3befd`.
No shared source, API, registry, configuration or fixture ownership is released.

### Exact four-site implementation scope

Only `tests/issue-6893-linear-cabi-array-forwarding.test.ts` may change:

1. `publicFixture`: after the compile/report capture and before recording the
   result, introduce `const binary = new Uint8Array(result.binary)`. Use this local
   for both `WebAssembly.validate` calls and `new WebAssembly.Module` (original
   lines111,116,117). Leave the returned original result and route capture intact.
2. The public namesake-host-import test: introduce the same local after its
   compile/report capture; use it for both validations and module construction
   (original lines151,156,157). Preserve imports, host callback and assertions.
3. `runtimeFixture`: replace only its binary initialization with
   `const binary = new Uint8Array(emitBinary(module))` (original line391).
4. The parameterized string/scalar no-resolver test: make that same initialization
   replacement (original line625), leaving both cases and their assertions intact.

The typed-array copy produces ArrayBuffer-backed bytes without casts and preserves
exactly the input view's bytes and boundaries. Do not pass bare `.buffer`, introduce
a shared adapter, change compiler return types, or add `any`, suppression, overload
casts or typecheck exclusions. Once bytes match the BufferSource overload, the two
`instantiate` result diagnostics should disappear; retain existing `{ instance }`
destructuring and module-input instantiation elsewhere. This is a source-derived
expectation, not a claimed successful strict run. No new assertions, cases, source
strings, options, provider wiring or semantics are authorized.

### Paired requalification before acceptance

Parent freezes identical repaired test bytes in the actual test-only e1e baseline
and composed candidate, recording exact revisions, hashes and input custody.
Retain prior operands/evidence rather than silently relabeling them as new runs.

- Run the unchanged strict test-inclusive TS7 command on both arms; require zero
  diagnostics. Preserve both new logs alongside the original ten-diagnostic logs.
- Rerun the entire unchanged98-case population serially with the same harness and
  options: baseline89 pass/9 fail, candidate98/98, zero skips. Require identical
  case identities and baseline failed assertions/semantic failures; source-line
  shifts from this edit are not new failures and must not mask message changes.
- Require all33 semantic records per arm to equal that arm's pre-repair records.
  Exclude only explicitly enumerated provenance changes such as test hash/revision;
  retain original provenance and do not normalize routes, values or memory bytes.
  Re-run the paired ten-kind equality and complete growth-custody/delta checks.
- Finish normal scoped formatting/lint and required gates without weakening them.
  An unexpected diagnostic, route, population or semantic delta stops acceptance
  for parent review; it does not authorize expanding this repair.

Source-array fallback remains fallback, scalar repair remains A6897's contribution,
and this test repair earns no source admission or migration credit. PR6568 remains
HOLD until reviewed evidence and A's integration/queue authorization. All preceding
sections, including the108-line composition append, remain unchanged.

### Implemented instrument repair (paired validation pending)

Sol6.1 Medium completed the exact four-site repair in commit
cf07ca68c160c46155e0b4d4819a649224fc9d07, integrated unchanged as
b023378983 on the canonical PR branch. Only the owned test file changed,
10 insertions/8 deletions; all fixtures and assertions remain intact. The test-
only baseline mirrors it at2a866ff9d3. Both repaired files have SHA-256
d3dec54184b30de6aea6c25c9b6e6adb99eca98f2f603bd1b05d958ca764585a.
The original676-line test is saved separately as `typing-repair/original-v3-test.ts.gz`.

Fresh upstream claim `6893:linear-cabi-test-typing-20261007`, unique owner
`ttraenkler/codex-linear-b-cabi-typing-sol61-20261007`, was verified before dispatch.
Canonical main b5991f6 changes only benchmark artifacts from the frozen e1e
production baseline. No shared source contract was modified or transferred.
Parent's new `compare-instrument-repair.mjs` requires all32 semantic records per
arm to remain exactly equal; only revision/testSha256 provenance may change.
The paired comparator accepts an explicit frozen test hash for this new epoch,
retaining its historical default and all existing count/custody requirements.

Canonical PR6587 replaces fork-headed PR6568, which the upstream push did not
update. Both remain HOLD; older PR is not yet closed. Exact earlier publication
def4c3befda0d31a312332296aa55af2519b5beb and its acceptance blocker were shared
with A in GitHub comment6043055409. No response or queue delegation is inferred.

### Measured repaired-instrument epoch

Candidate44dd2415dc8422939c313c72b3034943eadcf997 and test-only baseline
2a866ff9d31dc0a7c0d18cc7489c6bee79c0705a have the identical repaired test hash
d3dec54184b30de6aea6c25c9b6e6adb99eca98f2f603bd1b05d958ca764585a.
Both strict new-test-inclusive TS7 runs exit0 with zero diagnostics, using each
worktree's own identical unchanged configuration. The original ten errors remain
preserved. The cast-free repair resolves the demonstrated typing blocker.

Final paired runtime result: baseline89 pass/9 fail/98 (exit1), candidate98/98
(exit0), zero skips and all80 existing controls passing both. Identical JSON
reporting added to both arms captures all98 named case statuses; case identity
sets match exactly. A preliminary default-reporter baseline89/9 is also preserved.
All32 semantic records per arm are exactly equal to their pre-repair epoch;
only revision/testSha256 provenance changes. Paired33-record/kind/custody checks
pass unchanged. Thirty baseline failure identity/message lines match exactly;
raw stack/source frames remain archived, including the expected line shifts.

Full evidence, reproduction commands and review boundaries live in
`plan/log/6893-linear-cabi-20261007/typing-repair/README.md` and its compressed
raw logs/reports/comparisons. Production build is still live; architecture gates
and final normal push remain pending. Do not convert these results into whole-
program IR equality, source-array admission, performance or retirement credit.

Production build is terminal, exit134: after1762 transformed modules, Vite
rendering exhausted Node's default roughly4GiB heap (`Reached heap limit`).
Raw failure is preserved as `typing-repair/build-failed.log.gz`. This is NOT a
passing build or an attributed inherited failure: matched baseline build remains
pending. No heap/configuration override, source repair or protection weakening
was applied. The dialect gate passes27 canonical declarations; flat-directory
budget passes829 existing codegen files. Compiler inventory gate is pending.
Keep HOLD until the remaining build/gate obligations and A acceptance are met.

### Matched baseline build result and verified publication

The original `pnpm run build` is now terminal on BOTH frozen operands:
candidate production44dd2415dc8422939c313c72b3034943eadcf997 and test-only main
baseline2a866ff9d31dc0a7c0d18cc7489c6bee79c0705a. Both exit134 after1762 transformed
modules, during Vite rendering, with `Reached heap limit` at roughly4GiB. Both
use empty NODE_OPTIONS and identical Vite config SHA256
a658cb99507555a3a15527375590f76940311cf4ee6bca825ab687b6594956e4.
No source or configuration changed while either build ran; subsequent candidate
commits append documentation/evidence only. Baseline production is exact e1e.

This demonstrates an inherited baseline resource failure for the same gate,
not a green build or proof that no later build error exists. Preserve both raw
logs (`build-failed.log.gz`, `build-baseline-failed.log.gz`) without normalizing
their allocator/GC traces. No heap increase, gate waiver, or build-source fix
is taken. A retains the acceptance decision and final queue authority.

Compiler inventory is also terminal, exit0, actual e1e comparison base. Its
explicit status is `inventory-valid-architecture-incomplete`, with
architectureComplete=false, graphComplete=false and inventoryValid=true.
It accounts for1885 modules (1556 unmigrated,315 clean,14 compatibility adapters)
and reports no activated-policy errors; this is not an IR-only completion claim.
Dialect guard27 declarations and flat-directory guard829 files both pass.

Prior repaired checkpoint3a8443ec26d647f93e9107dc074bddedd5361a96 was verified
by remote branch and PR6587 APIs; all normal push gates passed, including18
numeric parity tests. PR6587 is non-draft HOLD with auto-merge=null. Fork-headed
PR6568 is now closed as ancestry-verified superseded; its branch is retained.
A received the checkpoint and dependencies in GitHub comment6043613775, with
no response when checked. Main has independently advanced to3146af9a349bb20a5a398fba37e8b69b16fb4ab9;
that later epoch is not relabeled as these frozen results.
