# PR 5883 array-length repair: source-only handoff

## Ownership and state

Worktree `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-array-length-repair-20260927`,
branch `codex/5883-array-length-repair-20260927`, verified base
`608be80f6beef338665fdcdb834e7d9b9f20b925` (parent reports upstream main
`9be5011449` included). Completed Error22 artifacts in the old tree were not
changed. Curie's iterator/live-array and Mendel's generator files were not
touched. No commits, pushes, compiler or test runs.

Initial whole-tree git status hit the LFS clean filter attempting to write the
shared .git/lfs/tmp directory, denied by the sandbox. Scoped source diff reads
work; no LFS file or configuration was changed to bypass this. Review the scoped
patch and preserve any unrelated worktree changes.

## Baseline receipt (parent execution, not rerun here)

Parent source:
`/Users/thomas/Code/js2/.codex-worktrees/codex-5883-preservation-repair-20260927/tests/issue-5197-array-length-mutation.test.ts`.
Copied via apply_patch to the same relative test path here, byte-for-byte cmp
verified; no case or expectation altered. SHA-256:
`ae99467df091ac998553992e5847d2b546ef0e49fa92d5a921b61e2ec397a12d`.

Parent full log:
`/Users/thomas/Code/js2/.codex-worktrees/codex-5883-preservation-repair-20260927/.tmp/5883-array-length-baseline-608be80.log`.
Preserved in full at `plan/agent-context/5883-array-length-baseline-608be80.log`,
including trailing newlines; cmp verified. Both SHA-256:
`70076ce9a4f1ff7178cdc7f5cf8cd1c6edd18e8fad1ec0c51d6a1ed4072e3cb9`.

The test contains all six full source bodies and strict CommonJS-transpiled
native oracle evaluation. The log contains all six exact compiler source strings
and runtime outcomes. Parent baseline at 608be80: native 6/6, standalone Wasm 3/6.
Failing (-1 versus 1): reference assignment shrink/regrow, reference descriptor
shrink/regrow, dynamic length key shrink/regrow. Passing: numeric shrink/regrow,
reference append, refused shrink preserves elements. None is reclassified as an
acceptable old-compiler result.

## Concrete patch

- `src/codegen/expressions/assignment.ts`: build the overlay store first. Only
  the non-overlay store includes backing fill, and both fill and field write
  execute inside the existing receiver guard. This avoids erasing values before
  overlay validation rejects a frozen length or non-configurable index. Opt
  reference carriers into the fill. Retain shrink-only mode: this site also
  carries append writeback after an element was already stored.
- `src/codegen/array-length-define.ts`: opt reference carriers into the existing
  post-validation, post-reallocation, pre-length-store fill for descriptor
  shrink/growth. Existing descriptor gates and overlay routing are preserved.
- `src/codegen/vec-length-hole-fill.ts`: unsigned min/shrink comparisons for
  uint32 lengths; document numeric and opted-in reference carrier behavior.
  Existing object-ops pre-grow caller remains unchanged.
- `src/codegen/array-holes.ts`: computed bracket writes that may name length
  arm the same early hole-demand flag as `.length =`. Numeric literal and known
  other string keys do not gain this demand. Unknown computed keys conservatively
  may be length; the flag only enables hole-aware representation/read machinery,
  not type-only receiver admission.
- `src/codegen/vec-length-set.ts`: after valid conversion and optional growth,
  fill `[min(oldLen,newLen), capacity)` with numeric/reference hole markers before
  storing length. Finalize-time reference fill uses only `ctx.holeGlobalIdx`;
  absence of that required reservation raises an explicit compiler invariant
  error instead of minting a late type or silently storing defaults. Growth and
  shrink comparisons use unsigned lengths. Arguments-object handling still
  returns before the Array path. Existing later overlay and typed-view prepends
  retain precedence over this arm (both index.ts finalization sequences).

Backing readers affected are element-read hole mapping and own-index predicates;
the pre-scan must arm them before function compilation. Mutators are static
assignment, descriptor length store, dynamic length store, and the pre-existing
append/writeback path. The latter is why static fill must remain shrink-only.
No shared context fields were moved or newly introduced.

## Validation and remaining risks

Only source inspection, installed Prettier formatting of the five owned source
files, scoped git diff whitespace checking, and byte/hash comparisons were run.
Compiler and tests remain SOURCE ONLY until the parent explicitly grants a slot.

1. Run the unchanged six cases first. There is no claimed post-patch numerator.
2. Prove the early Hole reservation precedes dynamic filling in both single-source
   and project finalization; a missing reservation now fails loudly. Source shows
   existing vec read/store helpers reserve Hole when demand is active, but this
   has not been executed for all module shapes.
3. Dynamic fills rely on overlay prepends winning for descriptor-aware receivers.
   Additive rejected dynamic-shrink/non-configurable-index controls should verify
   this, including partial shrink semantics. The supplied refused static shrink
   control must remain passing.
4. Uint32 lengths above 2^31 must not spuriously erase lower live values. Capacity
   allocation ceilings are unchanged; sparse capacity/length edge cases remain
   existing limitations, not newly proven conformance.
5. The six tests check read values, not complete own-index/descriptor absence.
   Follow-up checks should inspect holes versus explicit undefined and growth
   beyond backing capacity, plus dynamic numeric carriers and append writeback.
6. Broad computed-key hole demand can change representation in other modules;
   measure preservation under the parent's serialized broader controls before
   integration. No test count, expectation or gate was weakened.

The source patch is ready for parent review and serialized verification, not
declared merge-ready. The parent owns integration into existing PR 5883.

## Serialized measurements and review follow-up

The source-only statements above describe the first handoff. The parent then
granted a bounded slot, extended it for route diagnosis/refusal controls, and
all commands used one fork, `VITEST_FORK_MAX_OLD_SPACE_SIZE=2048`, no parallel files.

- **12921**, terminal exit 1: unchanged six, **5/6**, 14.46 s. Static reference
  and dynamic-key shrink/regrow changed to 1. Descriptor reference still -1.
  Numeric, append and refused-static-shrink controls stayed 1. Full first-run log
  `.tmp/5883-array-length/focused6-first.log`, SHA-256
  `bf5ca1c4684c061f00491141db36c8acb7d0001786bebf44bc48801f1a0968c9`.
- Refactored dynamic fill into `buildVecLengthHoleFill` beside the existing
  compile-time emitter; no duplicate 74-line ladder remains. Shared fill includes
  null-backing guard. Dynamic grow treats null backing as capacity zero and skips
  the copy when capacity is zero. Reference marker still must be pre-reserved.
- **37042**, terminal exit 0: **2/2** minimal setter-only dependency/validation
  probes, no array literals or element reads. Sources are recorded in
  `tests/issue-5197-array-length-setter-closure.test.ts`. `any[]` compilation has
  an IR-FALLBACK warning for string element-store index, retained in full at
  `.tmp/5883-array-length/setter-closure.log`, SHA-256
  `4b14f7a31263930dab1de7ee2ca808ccc0193af182b84cddc3f2f59acd797f54`.
  These prove these two modules compile/validate/instantiate without incidental
  read/literal seeding; they do not measure execution of the exported setter.
- **90204**, terminal exit 0: one emitted-route diagnostic. Full WAT and source
  `.tmp/5883-array-length/descriptor-route.log`, SHA-256
  `6df775e6a2c5560c423d71eb67678cdae1ff7226ae7f2f5d77b1752f1e5c21d5`.
  It contains NUL string data; use `rg -a` when inspecting it.
- **67798**, terminal exit 1: focused six plus four controls, **8/10** in 17.54 s.
  Original six still **5/6**. Setter closure **2/2**, non-writable descriptor
  shrink **1/1**, non-configurable-index descriptor shrink **0/1** (-1 versus
  strict native 1). Full log `.tmp/5883-array-length/focused6-plus-controls.log`,
  SHA-256 `5e82a99e5c4f03f990a3695c8599e7e3a6dc2d4ca6499ea0939840aac528509a`.

**Compiler slot released after terminal 67798.** No kill/restart, concurrent or
broad run, commit or push. Six original fixtures still byte-identical to parent.

### Actual descriptor route: do not patch an unused helper

The route probe's emitted `$test` (WAT line 6573 onward) directly stores
`struct.set 2 0` with constants 1 and 3 (around lines 6706/6721). Its only calls
are numeric boxing and `__extern_is_undefined`. It contains no array.fill and
does not call `__vec_set_len` or `__vec_dp_value`/`__defineProperty_value`.
`__vec_set_len` exists at line 55258, but existence is not call-route evidence.
Therefore **vec-define-writeback.ts was NOT changed** under the parent's
conditional authorization.

Source inspection identifies the matching direct-store mechanism in
`src/codegen/object-ops.ts:compileObjectDefineProperty`, the `valueExpr && useStruct`
branch around line 2240. The dedicated `maybeEmitVecLengthDefine` call around
line 1240 is gated to non-standalone, so changing it cannot affect this fixture.
Routing array length out of this generic struct fast path must preserve actual
ArraySetLength descriptor semantics (especially non-configurable indices), not
just add a blind fill around a field store. The retained overlay path also needs
backing-deletion verification once it is the actual route. This requires parent
ownership/authorization for object-ops.ts (and possibly its overlay length owner),
not the presently conditional vec-define-writeback scope. No such edit was made.

### Patch preservation

Full current reviewed production diff against base is preserved at
`plan/agent-context/5883-array-length-reviewed-source.patch`, SHA-256
`8fcbb885136b87b51d70b27aa307043864dc30db62420a371081bb8c64dae0ce`.
This snapshot includes the post-first-run factoring/null guards. The first-run
log and original test hash are preserved; a separate immutable pre-refactor
patch snapshot was not taken before that refactor, so this hash must NOT be
attributed to the exact first-run source revision. The first handoff describes
that earlier patch, but is not a substitute for a byte-identical patch receipt.

Remaining blockers: reference descriptor shrink/regrow, non-configurable-index
descriptor refusal, and broader hole/unsigned/sparse preservation. No full
ArraySetLength or Promise live-iteration equivalence is claimed.

### Descriptor source v2 — unexecuted checkpoint

Following the parent's instruction to continue descriptor repair source-only,
the actual route is now patched in `object-ops.ts` and `vec-overlay.ts`:

- `compileObjectDefineProperty` excludes standalone, known vec `length` from
  the ordinary struct-field fast path, leaving existing descriptor dispatch
  responsible for runtime validation. No ordinary-object admission is widened.
- `fillVecOverlayHelpers` uses the shared, null-guarded backing fill after
  successful shrink validation; a non-configurable stop clears only above the
  blocked index before restoring length to that index plus one. Growth fills
  from the saved old logical boundary after the existing grow helper.
- Finalized reference fill requires the pre-reserved Hole global. No late Hole
  type creation or silent missing-marker success is introduced. Append writeback
  and `vec-define-writeback.ts` remain untouched.

Full seven-file production diff against unchanged base `608be80f6`:
`plan/agent-context/5883-array-length-descriptor-source-v2.patch`, SHA-256
`89e4d23f61c8ae4fc810a28a0e3ef5299fe028f4fa9bcf2dfd5d6631bda9b798`.
The earlier reviewed-source snapshot remains unchanged. Source formatting and
diff whitespace checks only were performed; **no compiler/test execution of v2**.
Terminal handle **67798**, exit **1**, **8/10**, remains the latest measured
result and applies only to the preceding patch, not this checkpoint.

Remaining dependency edges: confirm emitted descriptor dispatch reaches the
overlay; validate finalized fill dependencies and local indices; rerun the six
unchanged fixtures and refusal controls under a new serialized grant; pair the
non-configurable-index failure against exact `608be80f6` before attribution.
Partial-refusal deletion, growth within/beyond capacity, unsigned length limits,
and descriptor accessor variants still need bounded evidence. No repaired or
complete constructor/array contract is claimed. Compiler slot remains released;
no new starts after 67798, no commits/push, no other worktree mutations.

Parent-reported exhaustion diagnostic (Wasm latch 1, Node native -2) is separate
evidence, not part of these denominators; expectations are retained unchanged.

### Descriptor v2 serialized verification

Parent granted exclusive bounded execution after its main comparison runs.
Production snapshot remains v2 hash above, on base
`608be80f6beef338665fdcdb834e7d9b9f20b925`; no main merge into this owned tree.

- Handle **52816**, terminal exit **0**, **10/10 passed**, 17.05 s: unchanged
  six mutation cases **6/6**, setter-only dependency probes **2/2**, refused
  descriptor cases **2/2**. Typed setter's existing IR-FALLBACK warning remains.
  Full source/actual/error log `.tmp/5883-array-length/descriptor-v2-focused10.log`,
  SHA-256 `fd2c12c973ceee87121e085ebd134e8c605b3accd72e151886b97289b9dae1f8`.
- Handle **72446**, terminal exit **1**, **0/1 selected passed**, three skipped,
  13.91 s: exact-base non-configurable-last-index comparison returns Wasm -1,
  strict native 1. Candidate same source returns 1. This is a reproduced base
  limitation improved by v2, not evidence of a new regression from the repair.
  Full failure log `.tmp/5883-array-length/base608-refusal.log`, SHA-256
  `96932b61d700724e4c133eda0556f8f91dbc14bbe7290f918f5d1b191f510904`.

Baseline compiler/config/scripts were extracted with git archive from exact base
inside this worktree at `.tmp/5883-array-length/base608-refusal`; dependencies
reuse this tree's node_modules. The control file was copied byte-identically via
apply_patch and cmp-verified, SHA-256
`8c917ee2cfe062e171e2bcc965e10b6dc7a33c0208b262fdeac351340b47ef84`.
Both use standalone/nativeStrings, existing strict-native oracle and zero-import
assertion. Baseline filter was exactly
`^refused descriptor shrink: non-configurable last index$`.
Both commands used one fork, 2048 MB, no parallel files, verbose full logs.
Original six fixture SHA-256 remains
`ae99467df091ac998553992e5847d2b546ef0e49fa92d5a921b61e2ec397a12d`.

**Slot released after terminal 72446.** No commits/push or parent-tree changes.
No expectations changed. Broader partial-refusal, sparse/unsigned boundary and
descriptor accessor coverage remain unmeasured; this is bounded 10-case evidence,
not full ArraySetLength or live-iteration equivalence. New emitted WAT route
confirmation has not been run; v2 runtime outcomes above are directly measured.

## Independent prerequisite PR integration

Parent isolated the same seven production-file patch on upstream main
`2a58b9fe9f95dc17bd5d2ba44ecd564b9695356b` in
`codex/5883-array-length-prerequisite-20260927`. No live-iterator, Promise drive,
prototype-storage, or generator changes are in this slice. Original worktrees
and source snapshots remain intact. This PR directly unblocks held PR 5883;
it is not a new migration branch of work.

- Original ten checks: **10/10**, terminal handle 84765, exit 0.
- Two additive partial-refusal cases check numeric/reference arrays: higher
  configurable elements stay deleted after regrowth, the blocked element and
  lower own undefined remain. Both pass; all six setter/refusal controls pass
  in terminal handle 50750, exit 0. Original six mutation fixtures unchanged.
- Existing length validation **14/14**, arguments ordinary-length **5/5**,
  hole-literal **35/36**. The one unchanged hole-reduce expectation fails with
  `s,number,number` versus `s,number,undefined,number`; exact baseline 608be80
  reproduces it (terminal 82326, exit 1). It is not waived or changed here.
- Pregrow controls initially could not load `test262/harness/propertyHelper.js`.
  Linking the already-pinned b363 corpus harness into this worktree restored
  execution: **4/4**, terminal 84103, exit 0. No harness source was changed.
- Isolated candidate formatting passes. Size allowances document only owner
  dispatch growth; no size baseline, CI workflow, or semantic oracle changes.

Published evidence files `5883-array-length-v2-focused10.log` and
`5883-array-length-base608-refusal.log` preserve the agent's full observations.
The original 3/6 baseline and both source snapshots are retained alongside
this handoff. This does not prove the complete ArraySetLength contract or IR
equivalence, and does not authorize retiring the old compiler.
