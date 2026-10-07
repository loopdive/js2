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
