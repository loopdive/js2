# Branded String binary-root v2 — source-only, awaiting review/grant

2026-09-27. Parent explicitly redirected v2 away from chasing unsupported numeric-i64 aliases. Parent owns compiler/hooks. No executions (including formatter/typecheck), no production edits, no merge refresh, no changes to original pair trees or first evidence. Existing uncommitted main7443 integration remains pinned.

## New additive source

`tests/issue-5748-branded-string-binary-routes-v2.test.ts`

SHA256 **`f635cd069727e3125c7b6c29b3327a9d3fedec324c37f6e1b762e234dc7dda74`**.

Two source-declared cases, **zero executed**: branded constructor arm and branded direct String arm. Each compiles the same five-export source independently at optimize:false. Each captures both reconstructed UTF16 strings, exact equality probe, Node-native BigInt oracle, full source/hash, binary hash, import inventory, raw debug-WAT export lines and authenticated binary inspection. Per-arm text expectations stay exact; equality probe must agree with the two actual captured strings. Constructor failure cannot be waived by the direct arm's output.

Frozen v1 remains at SHA `705bc72f648b977aed9aac6c3702710c2400701df34297cbb717352805d69184`, with its original numeric Number-ABI rejection and branded null-root assertion preserved in both first reports. Numeric-i64 is recorded as an unmeasured/unsupported-source gap, not a passing refusal case. No numeric row rerun or compiler annotation map change is proposed.

## Binary-root and ABI correction

Uses installed Binaryen's existing repository compatibility seam `readBinary(bytes, Features.All)` via the same typed adapter used by original host-delegation tests. No decoder optimization or binary rewrite. Module disposed in finally.

For each of the five actual export names:

1. Query decoded binary export with getExport/getExportInfo; require a function export.
2. Match its resolved function name to getFunctionInfo of the decoded module, never raw debug-WAT export handle arithmetic or guessed source name.
3. Require exact physical parameters `[i64]` for probe/length, `[i64,f64]` for code-unit access, and f64 result, **before** raw host BigInt invocation.
4. Capture actual decoded expression bodies. Enumerate direct call/return_call edges from decoder-produced text, resolving names against the decoded module. Require visible root calls, reject quoted root direct-call names, and fail on unresolved direct targets.
5. Traverse cycle-safely from each root to named actual formatter boundaries number_toString/bigint_toString/bigint_carrier_toString_radix. Require at least one path; retain paths and formatter bodies, not merely a list of helpers present somewhere in the module. Root bodies retain conversions such as f64.convert_i64_s. A partial binaryRootInspection is attached before signature assertions, preserving evidence on an instrument failure.

Limit: this establishes static reachable direct-call paths in emitted binary plus actual string observations. It is **not dynamic call-edge coverage**, and a helper with conditional branches may expose multiple paths. Indirect calls and quoted helper-call names are not fully modeled by this bounded direct-edge extractor. They remain in captured bodies; Hume/parent must review whether these affect the exercised route. Missing paths fail rather than fabricate fallback readiness. No expected formatter name is imposed as semantic correctness; original exact native/string assertions decide each arm.

Source reviewed for APIs: Binaryen declarations getExportInfo/getFunctionInfo/expandType/emitText, existing issue-2856 binary signature inspection and issue-5398 decoder feature-mask adapter. This is source review only, not a typecheck or proven decoder compatibility result.

## Review and next grant boundary

Sent the full file path and design to Hume task `01a0e064-8d32-7443-a455-32d147b109ca` with native task messaging, requesting full signature/route review; no approval inferred from message delivery. Parent must grant execution independently after Hume review. Freeze this SHA for review; if corrections are required, version/hash them before a new pair.

Proposed eventual pair: fresh exact7443 baseline overlay first, then unchanged current integration, identical final v2 bytes, same Node/dependencies/heap/single-worker options, full2-case reports and all first failures preserved. Do not write into immutable prior baseline trees. Include additive-test typecheck only under grant; no result claimed now.

No change to coercion-engine (`3796f9e6ebeae49de2a40fcd0bfaaffb7a4d8a42a8ba1f396854926e425c6b2b`) or prior approved call-identifier (`8341e693cb4d3e96c4dd553486eb718cd91a0682e2341e7ded5a41b1a07ee087`). No engine fix or acceptance inference from the failed v1 pair. Numeric-i64, effect-order gap, wider BigInt limits, hold and compiler-retirement conditions remain separate. No live process; parent retains slot.
