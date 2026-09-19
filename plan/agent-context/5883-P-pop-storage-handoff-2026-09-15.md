# PR5883 P: canonical externref pop storage read

## September 19 integration revalidation

The exact P-only partition was independently reapplied to parent `e2357fbbc9`,
which includes upstream main `4a6cbdf1ee`. It applies without conflicts and
preserves upstream's added vector helpers. Fresh paired execution still finds
six runtime corrections across the original thirty sources; twenty-four runtime
outcomes remain equal. Parent alone fails 16/30 assertions (fourteen include
pop-body reachability); parent plus P passes 30/30, with the same eight
known-defect lookup-preservation receipts, not conformance gains.

The combined portable suite, vector callable ABI, and original observable
Promise suite pass 62/62; TypeScript7 passes. Exact evidence and hashes:
`/private/tmp/js2-5883-P-parent-check-20260919/.tmp/P-parent-collision-handoff.md`.
The parent's integration copy has identical SHA256 for vec-access-exports,
vec-pop-body and the portable test. Wider incomplete Promise work, original
diagnostics, and all sixteen setter failures remain excluded and preserved.
Normal commit and pre-push checks are still required; keep PR5883 held.

## Scope and integration boundary

Base: `647343cc11496d6ca85f23609475dd9f4b766f42`.
Implementation: `/private/tmp/js2-5883-live-vector-20260915`,
branch `codex/5883-live-vector-20260915`.
Independent P-only validation: `/private/tmp/js2-5883-P-portable-validation-20260915`
at that exact base, with only the P source, new portable test, and pop inventory addition.

This patch is **not full PR5883 acceptance**. Parent composes the published merge
and its separate Promise inventory correction. No push or new PR.

Only nonempty, actually externref-backed pop changes: read the genuinely allocated,
filled canonical `__vec_get(receiver, oldLength - 1)` before decrementing length,
retaining that result. The Hole Get arm uses the existing canonical undefined
provider and its actual reservation, with the selected-native missing-reservation
throw intact; its fallback clones the already-built OOB provider instructions.

`vec-pop-body.ts` contains complete locals/instruction/dispatch construction.
Types-only imports; immutable current per-entry physical facts and box handle;
no context, callback, registry, reservation, or owner backedge. Existing owner
performs allocation-object/filled-body validation and fill. Facts are prepared at
the original pop site after Get/push fill, with no intervening module allocation.
Reverse order, skips, locals, empty/unsupported behavior, boxing, and all other
carriers are unchanged. Volta's allocator/publication-map partition is untouched.
The new inventory record honestly says unmigrated / mixed-needs-split /
backend-wasmgc / 3518-coordinator; this is not a migrated semantic IR producer.

## Portable regression boundary

`tests/issue-5883-pop-storage-regression.test.ts` has separate denominators:

- **14/14 P runtime + final-body reachability**, seven original P sources at O0/O2:
  dense, Hole, unbacked, explicit undefined, null, NaN, object identity.
  Actual source pop calls the selected dispatcher; its real pop/Get read precedes
  decrement, including the inlined form. These selected bodies are direct/legacy,
  not a claim that source IR reads or numeric pop dispatch were repaired.
- **8/8 direct published Get**, four sources at O0/O2. The normal existing
  `hostBridge: "always"` option retains the real allocated/filled Get export.
  Direct calls use source-created receivers and compiled identity classification;
  emitted receiver construction pins actual externref/f64 backing. No context mock,
  private registry, rewritten binary, or unstaged Promise implementation.
- **8/8 fixed lookup-preservation receipts, NOT JavaScript conformance**.
  Own shadow, Array.prototype override, getter and ordering sources all return
  310 on baseline and candidate. This records the existing ignored-override defect;
  it does not validate JavaScript method lookup, accessors, or evaluation order.

All 30 compile successfully, instantiate, and have zero imports. Artifacts use
`mkdtempSync(join(tmpdir(), "js2-5883-P-"))`; no private baseline import in CI tests.
Source hashes and full source strings are emitted as compact JSON; WAT is saved
separately, never dumped to stdout. The original diagnostic file remains entirely
unchanged and untracked; its original absolute baseline import and hard N reds are
not included in this commit.

## Exact paired baseline evidence

The same 30 source strings were separately compiled with the immutable published
baseline compiler in `/private/tmp/js2-5883-published-baseline-20260915`.
Same Node 22.23.2, standalone/nativeStrings, O0/O2 and file names; direct Get alone
retains host bridges on both sides. Source text for every hash is in the portable
test and full JSONL. Baseline 647343cc versus base plus only the P patch:
**six runtime differences, 24 identical outcomes**. Baseline compilation and
zero-import instantiation succeeded for every row; the two unbacked pop invocations
then trapped. No source or expectation was weakened to accommodate the baseline.

```jsonl
{"cohort":"5883-P","case":"dense","sourceHash":"7229d44950c784189ecf5b851c3b1d53ea1d17b30177b20f1d58d0a9d2e29929","O0":{"baseline":100,"candidate":100},"O2":{"baseline":100,"candidate":100}}
{"cohort":"5883-P","case":"Hole","sourceHash":"6a0c167ea2c544e6608079aa0d93ffdd81b835587596d4fc953e042206cf7dc6","O0":{"baseline":901,"candidate":1},"O2":{"baseline":901,"candidate":1}}
{"cohort":"5883-P","case":"unbacked","sourceHash":"dd5b652912867ee51b51fe34a08db3dc22c23304eec89bfc0dde6ba2375dd97d","O0":{"baseline":"RuntimeError: array element access out of bounds","candidate":2},"O2":{"baseline":"RuntimeError: array element access out of bounds","candidate":2}}
{"cohort":"5883-P","case":"undefined","sourceHash":"6f50ff25d744a6d758639379cb742527d3f239437f1ef54f7735e209857c4680","O0":{"baseline":0,"candidate":0},"O2":{"baseline":0,"candidate":0}}
{"cohort":"5883-P","case":"null","sourceHash":"27760061bad3a7bf0a2196817708ce7fa6e1d62dd9de229228f7f7f9b33421a0","O0":{"baseline":400,"candidate":400},"O2":{"baseline":400,"candidate":400}}
{"cohort":"5883-P","case":"NaN","sourceHash":"71741c33dc03100d45d854c00d4489eef10a7013c218f731aff8360de1be904d","O0":{"baseline":800,"candidate":800},"O2":{"baseline":800,"candidate":800}}
{"cohort":"5883-P","case":"identity","sourceHash":"50903c3fdc2b0762d75cb2249d132703a17bd0e80be23c67489ed7ce066e6150","O0":{"baseline":700,"candidate":700},"O2":{"baseline":700,"candidate":700}}
{"cohort":"5883-direct-storage-Get","case":"externref-values","sourceHash":"e3ab01727daba67775686e6fbae4ce1761d5ffd144e0ffb811ecdab9c05aeb60","O0":{"baseline":[1,4,0,4,8,7],"candidate":[1,0,0,4,8,7]},"O2":{"baseline":[1,4,0,4,8,7],"candidate":[1,0,0,4,8,7]}}
{"cohort":"5883-direct-storage-Get","case":"f64-values","sourceHash":"4b585ec794f8461ca310a4a3b68a9fb96e5ba8b8d5ec184ca355c49832cabf4d","O0":{"baseline":[1,0,0,8],"candidate":[1,0,0,8]},"O2":{"baseline":[1,0,0,8],"candidate":[1,0,0,8]}}
{"cohort":"5883-direct-storage-Get","case":"externref-unbacked","sourceHash":"a360a97aab85628ee1655c616897cd9564f6a9f9e30a91bac56f2eea2892595d","O0":{"baseline":[1,0,0],"candidate":[1,0,0]},"O2":{"baseline":[1,0,0],"candidate":[1,0,0]}}
{"cohort":"5883-direct-storage-Get","case":"f64-unbacked","sourceHash":"b86441a4d621462181701f0078987f98898cf33fa034ff07150188175d9157f8","O0":{"baseline":[1,0,0],"candidate":[1,0,0]},"O2":{"baseline":[1,0,0],"candidate":[1,0,0]}}
{"cohort":"5883-P-lookup-preservation-not-conformance","case":"own","sourceHash":"697d594ab0355c254caee416e66f65dd9878497a8ad10f60204721a71887ac70","O0":{"baseline":310,"candidate":310},"O2":{"baseline":310,"candidate":310}}
{"cohort":"5883-P-lookup-preservation-not-conformance","case":"prototype","sourceHash":"d8d6c3f289fabf4657afd7dab15e418db73d114bf7c9171bce25b7e674d056de","O0":{"baseline":310,"candidate":310},"O2":{"baseline":310,"candidate":310}}
{"cohort":"5883-P-lookup-preservation-not-conformance","case":"getter","sourceHash":"909e274a2228d576046fb055d0927de7341377e1a1f76026c0abfd207b0fc962","O0":{"baseline":310,"candidate":310},"O2":{"baseline":310,"candidate":310}}
{"cohort":"5883-P-lookup-preservation-not-conformance","case":"order","sourceHash":"bf5827a4933ad2dead1c7f0fe11af351f0c983c2adc559e97d14af61d33b916c","O0":{"baseline":310,"candidate":310},"O2":{"baseline":310,"candidate":310}}
```

Paired JSONL: `/private/tmp/js2-5883-P-portable-validation-20260915/.tmp/portable-P-paired.jsonl`
SHA256 `79dbc38f5ef29c8b7824d4f7b8b3d444365e14d264bc52998f5e36c862edd470`.
Runner: `/private/tmp/js2-5883-P-portable-validation-20260915/.tmp/portable-P-baseline.mts` (local evidence only; not a CI import).
Initial portable log: `/private/tmp/js2-5883-P-portable-validation-20260915/.tmp/portable-P-first.log`,
SHA256 `0eea6153dd2051c821c530626f116f23ef7a8607365d3b75d46143da466c9516`.

## Checks and exact commands

Executed from the independent P-only validation tree:

- `VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 pnpm exec vitest run tests/issue-5883-pop-storage-regression.test.ts`: 30/30, split above; `.tmp/portable-P-first.log`.
- `VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 pnpm exec vitest run tests/issue-3520-vec-support-callable-abi.test.ts tests/issue-5197-promise-observable-combinator-r3-2.test.ts`: **19/19 ABI +13/13 original observable =32/32**, with the published, unchanged Promise body; `.tmp/portable-P-integration.log`.
- `node --import tsx .tmp/portable-P-parity.mts after`: **26/26 exact full binary/WAT/import equality** to preserved prefactor P artifacts: seven P cases plus empty, f64, native string, TypedArray, struct and no-demand, O0/O2. Excluded carriers are byte-parity checks, not new conformance claims; `.tmp/portable-P-parity.jsonl`.
- `pnpm run typecheck`: pass, `.tmp/portable-P-typecheck.log`.
- `pnpm exec prettier --check src/codegen/vec-access-exports.ts src/codegen/vec-pop-body.ts tests/issue-5883-pop-storage-regression.test.ts scripts/compiler-boundaries.json`: pass, `.tmp/portable-P-final-format.log`.
- `pnpm exec biome lint --diagnostic-level=error tests/issue-5883-pop-storage-regression.test.ts src/codegen/vec-access-exports.ts src/codegen/vec-pop-body.ts`: pass, `.tmp/portable-P-final-lint.log`.
- LOC/function checks before staging pass; normal commit hooks must recheck with the new files in the index. No budget files or allowances changed.

Earlier factor evidence remains in the implementation tree's `.tmp/`:
`5883-P-factor-before.jsonl`, `5883-P-factor-after.jsonl` (26/26),
`5883-P-factor-controls.log` (14 P +8 former Promise-based Get +8 paired controls),
`5883-factor-controls.log` and `5883-factor-host-parity.log` (flag-false/host parity).
Earlier failed budget and assertion logs remain untouched. The former direct-Get
cohort was Promise-dependent; the portable eight above are independently executed
published storage Get controls, not a relabeling of the old source cohort.

## Preserved held work and hashes

No changes to original 57/73 source fixtures or the original diagnostic file.
All 16 original setter reds remain open and unpublished. N numeric dispatch,
f64/TypedArray pop changes, IR semantic read activation, raw IR set_length,
marker production and setter repair remain HELD. Canonical Get is storage access,
not full prototype-aware Get. Neither P nor diagnostic numeric attribution waives
any held row. Parent's full review and composition remain required.

SHA256 at this checkpoint:

- vec-access-exports.ts: `20b247e665237a43d4948f5245e7ff1ccb471c29adb41ce5dbc3b0c132f3d6a8`
- vec-pop-body.ts: `41127e8f632ead983610b914ab1d636f7927ed5c27713b5e794aef3d3d68dcf9`
- portable regression: `b263fb99a908425acad4e49ab7994a82b0135fe2bb27b672d07e746bcaff1ff8`
- untouched entire tests/issue-5883-vector-hole-read.test.ts:
  `0b7b9b34b5a7dc805c0f18ef6f3d4e35e3feccc96b171dfe517a839744fcb8ea`

Commit partition: vec-access, new vec-pop-body, new portable regression, only the
new pop inventory record, and this P-specific handoff. Dirty Promise body, its
inventory record, broad 5197 status, broad storage-closure report, and all original
diagnostics stay out.
