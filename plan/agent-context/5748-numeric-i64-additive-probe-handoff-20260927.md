# Numeric-i64 String constructor/call pair — SOURCE ONLY, unrun

2026-09-27. Parent/Hume identified a new source-level counterexample after the wide-carrier pair reproduced24/25 on both trees. Parent owns compiler/hooks during archive push. This turn adds a diagnostic test only; no compiler, tests, formatter, typecheck, commit, push, merge or production semantic edit. No existing fixture or first receipt altered. No brand-gate fix applied.

## Additive test

`tests/issue-5748-numeric-i64-string-pair.test.ts`

SHA256 **`705bc72f648b977aed9aac6c3702710c2400701df34297cbb717352805d69184`**.

Two ordinary Vitest cases, each compiling its own full source with standalone/nativeStrings, hostBridge off, optimize:false, emitWat:true. Both pass raw Wasm-JS i64 argument `1152921504606846976n` (2\*\*60). This host BigInt transports integer bits; it does not brand the source numeric-i64 value.

1. Numeric: `type i64 = number; probe(x:i64) { return new String(x).valueOf() === String(x) ? 1 : 0; }`.
2. Branded control: same observations, parameter `x:bigint`.

Five exported observations per source: exact original equality probe plus constructor/direct-call length and code-unit functions. Each actual string is reconstructed without host string boxing from bounded UTF-16 units (length0..128, units0..65535). BOTH strings and equality result are collected before semantic assertions. No shared source-level helper changes the original probe's direct new/call shape.

Each case runs a separate Node vm oracle using numeric `2 ** 60` or branded `1152921504606846976n`, asserting expected text `1152921504606847000` versus `1152921504606846976`, respectively. Those are expected observations, **not measured results yet**. Zero-import assertion uses actual WebAssembly.Module imports and binary instantiation. No fabricated imports/provider mocks.

The finally JSON record captures complete source/hash, raw argument, oracle values, compile result/errors, WAT hash, emitted root function bodies, module direct-call index/name edges, type declarations, actual strings/units and failure if any. It resolves root bodies from actual export indexes, not guessed wrapper names. Direct call operands are resolved against ordered imported/defined functions; unresolved root call indexes or missing roots fail rather than report an empty route as proof. Shared WAT signatures may be `(type N)`; declarations are retained for explicit ABI review rather than asserting an inline `(param i64)` spelling. The collector is tied to the repository's full unoptimized WAT format, inspected in src/emit/wat.ts; it is not a generic Wasm analyzer. Indirect dispatch is not certified by this direct-edge list.

The record deliberately does NOT assert a preselected bigint/number formatter route: it captures emitted route evidence for both subjects, preserving a wrong answer and its route without baking a hypothesized repair into the diagnostic. No claim of verified i64 ABI or formatter reachability exists until emitted records are inspected after execution.

## Source evidence and proposed paired use

### Mandatory manual review before interpreting any paired result

The test's non-null-root and resolved-direct-call assertions are instrument checks ONLY. They do not prove the following obligations, all still UNMEASURED:

1. Follow each actual export index to its emitted function and resolve its inline or referenced function signature. Verify the first parameter is physically Wasm i64 on BOTH numeric and branded subjects, not externref/f64 or a wrapper accepting a boxed value. Read corresponding type declarations, not the TypeScript annotation alone.
2. Wasm i64 itself carries no JavaScript BigInt brand. Establish the numeric source's unbranded status from the compiler's native alias resolution/ValType path, contrasting the bigint parameter's branded path. Do not infer a brand from passing the JS BigInt argument through the host ABI. WAT cannot independently encode or certify that compiler metadata.
3. Inspect the numeric constructor and direct-call emitted roots and follow concrete call indexes through wrappers to the actual engine formatter. Record the reachable `bigint_toString` or `number_toString` calls and any preceding `f64.convert_i64_s`, not merely the presence of either helper somewhere in the module. Verify the equality probe and both length/unit observation paths agree in conversion routing. If branching or indirect calls prevent proof, state unresolved rather than select the presumed route.
4. Repeat route inspection for the branded control. Do not require a guessed exact helper spelling to pass; explain the actual boxed/narrowed/native path using its emitted calls and result observations. Direct calls can preserve wide operand preparation independently of the constructor route.
5. Compare both complete reconstructed strings and probe results to the actual per-case Node oracle, retain mismatches, and verify identical test-file bytes on candidate and the fresh baseline overlay before/after each run. Source-declared expected strings alone are not a native measurement.

This checklist can be completed only once the authorized compile emits evidence; it is not marked verified by authoring the test. Parent requested the obligations explicitly before execution. Current parent push8077 is live; no test/compiler execution started and no immutable baseline tree edited.

Actual constructor caller is `src/codegen/expressions/new-builtin-globals.ts`, final static lowering in prepareStringWrapperValue (around745): compiles value then calls `emitToString(ctx,fctx,valueType,valueTsType,"string")`. Candidate coercion-engine's PR5399 native-i64 arm currently ignores the BigInt brand. Direct String uses the upstream handler after the approved five-line deletion. The new probe is intended to measure that potential difference, not permission to fix it in advance.

Later grant: run this same two-case file, unchanged, on candidate and exact main7443 using the same dependency/Node/worker settings as prior pair, each with separate first JSON/full log and hashes. Do not modify the already-frozen baseline/candidate evidence or silently replace original test populations. If a new baseline overlay is needed, prepare it separately from the existing immutable measurement checkout. Inspect raw parameter signature and root-to-formatter calls alongside both actual strings and oracle results. No broad extras requested.

Existing source hashes, unchanged this turn:

- coercion-engine.ts `3796f9e6ebeae49de2a40fcd0bfaaffb7a4d8a42a8ba1f396854926e425c6b2b`.
- call-identifier.ts `8341e693cb4d3e96c4dd553486eb718cd91a0682e2341e7ded5a41b1a07ee087`.

All artifacts in `.tmp/5748-approved-deletion-artifacts.sha256` verified unchanged. No tracked test diff; only this new untracked additive test and handoff. Test count2 is source-declared, **0 executed**. No compiler slot consumed; awaiting parent grant/review. Original effect-order gap and other acceptance boundaries remain separate.
