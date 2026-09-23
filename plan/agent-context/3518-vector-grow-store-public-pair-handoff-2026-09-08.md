# Vector grow/store public preservation handoff

Astra Low, 2026-09-08. Repository-path handoff for parent composition; no
implementation commit or push. All three production files and both focused
test files remain at the frozen revision-2 hashes.

## Measured result and limits

Revision 2 measured **14 historical pairs / 28 compilation-and-instantiation
rows / 56 expected export calls**. Each row calls the actual public compiler
once and invokes its actual instantiated export twice. All 28 rows executed;
all expected values matched; all modules have zero imports.

All 14 baseline/candidate evidence rows are deep-equal, without stripping
checkout prefixes or normalizing bytes, WAT, diagnostics, values, or order.
The rows retain complete base64 binaries, exact instantiation inputs, full WAT,
resource-declaration order, import/export order, string pools and IR outcomes.
The 14 binaries total **1,056,357 bytes per arm**.

Five comparator negatives rejected: dropped row, substituted root, altered
instantiation byte, altered expected value, and a changed outcome.

The recorder reports preservationOK=true and acceptanceOK=true, but the latter
is scoped to its fixture/value/emitted-path checks. It is **not** an Inspector
execution witness, whole-family acceptance, ABI30 closure or retirement proof.
See the post-run classifier finding below before reusing its path metadata.

## Exact inputs

Both roots have HEAD 2b9cb408c18446361fcf9837045067d1fd97c642.

- Baseline, read-only:
  /private/tmp/js2-3518-explicit-rec-integration-20260908
  on codex/3518-explicit-rec-integration-20260908.
  Whole-tree status was empty before execution and after both arms.
- Candidate:
  /private/tmp/js2-3518-vector-grow-store-20260908
  on codex/3518-vector-grow-store-20260908.
  Its source census differs from the baseline at exactly the three files below.
  The two new focused tests are also frozen, but are not compiler inputs.

Candidate production identities:

- src/runtime/wasmgc/values/vector-grow-store.ts
  - SHA256: 461a182a837158a9e6f112b52cf0f02bd3c346bf04bd82abae810c2866feeb08
  - Git blob: 36c525d1b4da3e7616d1e4e38c6501cdb673a8be
- src/codegen/vec-elem-set.ts
  - SHA256: 468056d3ea1da423d2ca40b5271ddc37cc080d3508c4800cdc5d582680237201
  - Git blob: ae912182ac1d5c9fed29570bf769b3caded212f9
- src/codegen/registry/types.ts
  - SHA256: 0001ca01391b5c85cc16f4db8cde593729dec80843443f7466812c8ea63a8cd5
  - Git blob: c20db5621268b82fa4f4e5ff710bd1aff788e27f

The recursive src census includes every regular source-tree file, not merely
compiler module files. It was identical before/after each arm:

- Baseline: 1,316 files;
  48f52a45be1b9b37622d146297ec630dd4a2e3d8458852e804f30d57951bff18.
- Candidate: 1,317 files;
  b67a1b49e5a2cba2ba2bf30d83fb9f7c5c0490038503914eb492c03ae30708a8.

## Frozen denominator

Each of these seven source recipes runs with experimentalIR=false and true,
all under target=standalone. A fixture label is not itself proof of a physical
representation: the integer-valued numeric push specializes to i32.

1. Existing native any[] push positive: expected 1.
2. Existing numeric push/new-length expression: expected 279.
3. Existing top-level new Array/filter growth-gap fixture: expected 1.
4. Numeric indexed growth with a same-module literal hole: expected 609.
5. Existing Uint8Array plus ArrayBuffer branding positive: expected 10.
6. Existing wrong Uint8Array species result: expected caught TypeError value 1.
7. Existing local sparse-IR store/filter positive: expected undefined.

The exact sources, provenance labels, compile options and order are retained
in the accompanying source snapshot and each report row.
Matrix SHA256:
4dfbea211acf422bb22af81760337ae66e8e6a18c6b469f096f403d4b498e120.

Every compile explicitly sets emitWat=true, allowJs=true,
skipSemanticDiagnostics=true, trackFallbacks=true and trackIrOutcomes=true.
No physical implementation or synthetic compiler caller is introduced.

## Commands, runtime and terminals

Original command, from the candidate root (the output directory must be fresh;
never delete or overwrite a prior run to repeat it):

~~~sh
NODE_OPTIONS=--max-old-space-size=2048 \
TSX_TSCONFIG_PATH=/private/tmp/js2-3518-vector-grow-store-20260908/tsconfig.json \
TSX_DISABLE_CACHE=1 \
node --import tsx .tmp/vector-grow-store-public-pair-r2.mts \
  --pair /private/tmp/js2-3518-vector-grow-store-20260908/.tmp/vector-grow-store-public-r2 \
  > .tmp/vector-grow-store-public-r2-controller.log 2>&1
~~~

Controller session 82714, terminal dccac6, exit 0.
Sequential baseline child PID 59771 and candidate child PID 59837 both exited
0 with signal=null and error=null. No child is killed on a timer.
Heavy slot was explicitly released after these terminals.

Each child resolves tsx/esm from its selected root, runs with that root as cwd,
and dynamically imports only that root's actual src/index.ts public entry.
The receipt binds source before/after, selected URLs, harness hash, Node binary,
tsx implementation files, esbuild implementation and native binary, TypeScript,
tsconfig, launch environment and terminal report hashes.

Measured Node: v22.23.2. Child environment removes inherited compiler/loader
overrides, sets TSX_TSCONFIG_PATH to its own root/tsconfig.json, disables the
tsx cache, removes ESBUILD_BINARY_PATH, and sets these exact controls to 0:

- JS2WASM_IR_GVN
- JS2WASM_IR_OWNERSHIP
- JS2WASM_IR_ESCAPE
- IR_VERIFY_ALLOC
- JS2WASM_IR_VERIFY_DOMINANCE_NAIVE
- JS2WASM_IR_INLINE

## Retained artifacts

The exact historical r2 harness is archived next to this document as
3518-vector-grow-store-public-pair-r2.source.txt. This is a byte-for-byte source
archive, not a relocated runnable script: its existing path-resolution behavior
is intentionally unchanged.

Harness SHA256:
9be7e89aeb88d580d588d6d44bd1a83a94830854039caf397ae1ba64cddaf919.

Worker-relative report paths:

- .tmp/vector-grow-store-public-r2/baseline.json
  SHA256 c8485ef9466590bce55c81299e03828d918464dc1eea1f56e0c3fcabdead8507.
- .tmp/vector-grow-store-public-r2/candidate.json
  SHA256 9bbeeff372b1a569d11753c4b0528009e0d104faeb48a7878c077d8995066645.
- .tmp/vector-grow-store-public-r2/comparison.json
  SHA256 537671700ca6752e074d1e8cb20168daa5f1510ed1e4d24c1065918c7ac7377c.
- The same directory retains both .launch.json/.terminal.json receipts,
  stdout/stderr logs, full per-row progress records and expected.json.
- .tmp/vector-grow-store-frozen-r2.json: five exact source/test hashes.
- .tmp/vector-grow-store-validation-r3.json: body 22/22, donor 20/20,
  and prior TS7 session 70823 exit 0 on the unchanged snapshot.

Revision 1 is also retained: controller 70966 exited 1 after both children
exited 0; all original 12 pairs were raw-equal, but its named-reference
classifier found coverage gaps. Revision 2 retained all those rows and added
only the existing local sparse-IR positive. No historical hash was reseeded.
The earlier body test's one-boundary-newline receipt repair and its initial
14/22 result remain recorded separately.

## Post-run classifier finding — do not conceal

WAT elides some function-type declarations while retaining physical numeric
coordinates. Therefore indexing a list of printed type forms by a physical
type index is not generally valid. One concrete r2 row is
dense-f64-push-ir: helper __vec_elem_set_46 stores into physical array 45,
but r2's list position 45 names a function type, not __arr_i32. It falls into
the diagnostic default-reference category. Some later non-core helpers have
the same issue.

The required core externref/f64 arrays are at early coordinates 1/3, where
this particular elision does not precede them; the hole-global helper uses
array 1. Packed branding is inspected by exact named declarations. The raw
baseline/candidate binary/WAT/value preservation result does not depend on
this classification and remains valid.

A public execution plus an emitted helper/call-site census is not an exact
per-helper runtime execution trace. In particular, generic runtime support
functions may be emitted without that particular branch executing. Do not
promote this record into a universal executed-donor-path claim.

## Bounded tracked portability proposal

Proposed runnable owner: scripts/verify-vector-grow-store-public-pair.mts.
Parent owns adopting it; no tracked script or package/policy edit is made here.

The harness architecture is reusable, but r2 is not currently host-path
independent. The bounded patch should:

1. Replace hardcoded roots and instrument-relative worker derivation with
   required --baseline, --candidate and --output options. Resolve/realpath
   each; require distinct roots and a fresh output directory within the
   explicitly selected candidate scratch directory.
2. Preserve the exact baseline commit check. Replace the private .tmp frozen
   manifest dependency with the three explicit source SHA256 receipts above,
   and continue comparing the complete source census so unrelated production
   differences cannot enter the pair.
3. Resolve every compiler/loader dependency from its selected root; preserve
   clean-baseline checks, launch controls, complete evidence, independent
   value/binary checks, sequential children and bound terminal receipts.
4. Preserve all 14 rows and five existing negative controls. Repair the
   classifier with actual physical type identity (or report unresolved);
   do not equate printed WAT order with physical coordinates. Do not waive
   missing/unknown cases or silently change the denominator.
5. Keep historical r1/r2 source/receipts immutable. The portable revision needs
   its own hash and validation slot; report any new source fixture or stronger
   execution witness as additional evidence, not retroactive r2 evidence.

The source archive prevents the required instrument from existing only in
.tmp while keeping the portability/classification follow-up explicit.
