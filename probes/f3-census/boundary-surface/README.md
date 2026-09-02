# R6 family-3 boundary-surface census — raw evidence index

Grounded on origin/main 33ea8606aa (2026-09-02 13:01 UTC). Working tree HEAD was
079332e3 (one `[skip ci]` baseline-refresh commit past it, touching only
benchmarks/website data); `git diff --quiet 33ea8606aa 079332e3 -- src plan/issues/3526* plan/issues/3521*`
is empty, so every line number below equals 33ea8606aa's.

No compile/measurement was run; this probe is grep/read only.

| file | what |
|---|---|
| 00-src-ir-listing.txt | `ls src/ir` |
| 01-intrinsics-grep.txt | call/closure/fnctor/bound/callback/construct/apply/env/host grep of `src/ir/intrinsics.ts` (42 hits, all comments) |
| 02-intrinsics-id-vocab.txt | every `INTRINSIC_IDS`/`RUNTIME_FEATURES` line |
| 03-intrinsics-tail.txt | signature/definition/verifier tail of intrinsics.ts |
| 04-host-caps-grep.txt | same grep of `runtime-host-capabilities.ts` |
| 05-manifest-grep.txt, 05b-… | same grep of `runtime-manifest.ts` |
| 06-intrinsic-support-grep.txt | same grep of `intrinsic-support.ts` |
| 07-host-caps-schema-and-records.txt | id lists, value/module/kind unions, record interfaces, `RUNTIME_HOST_CAPABILITY_RECORDS` |
| 08-manifest-policy-and-provider-shapes.txt | `RuntimeManifestPolicy`, provider ids, `RuntimeProviderImplementation` |
| 10-15 | IR node kinds: `call`/`intrinsic`/`closure.*`/`fnctor.*`/`class.*`/`coerce.to_externref`, `IrFuncRef`/`IrCallableBinding` |
| 20-26 | lower.ts cases, every `provider` read, every `??`, fnctor/call/closure/class/extern lowering bodies |
| 30-32 | from-ast emission census, builder methods, `__make_callback` site, `emitCallablePack` |
| 40 | `src/codegen/program-abi-*.ts` inventory + `ir-prepared-free-functions.ts` callable grep |
| 50-51, 93 | #3526 headings, family list (:990-1010), F2-S1 census anatomy (:3293-3460), locks/out-of-scope |
| 60-63 | src/ir callable-file headers, #3521 ownership grep, backend contract/emitter/legality |
| 70-72, 85-89 | `__make_callback` registration + runtime dispatch, trampolines/exports, host-import policy |
| 73-74, 90 | fnctor shape, DOM callback authority, closure registry |
| 80-84, 91 | integration.ts policy assembly + resolver impls, direct-call plans |
| 92, 97, 101-110 | codegen callable ABI file headers, header layout, closure call, legality per backend, native `__apply_closure`, docs |
