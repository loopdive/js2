import re,sys
src=open('.tmp/r6-f3-census/opening/f3-opening.md').read()
edits=[
# --- critique edits (verbatim) ---
('the exact standalone-DOM lane (`environment:"none"` + `native-first`, the gate\nat `index.ts:2885-2888`)',
 'the exact standalone-DOM lane (`environment:"none"` + `native-first`, the gate\nat `index.ts:4440-4445` `hasStandaloneDomDispatcher`; `:2885-2888` is the promise-delay gate)'),
('plan flag `src/codegen/index.ts:3380`, gate\n  `:2885-2888`; reserve-time re-read',
 'plan flag `src/codegen/index.ts:3380` ←\n  `calendar-codegen-planning.ts:366`, dispatcher gate `:4440-4445`; reserve-time re-read'),
('profile (`environment:"none"`, `native-first`; gate `index.ts:2885-2888`)',
 'profile (`environment:"none"`, `native-first`; gate `index.ts:4440-4445`)'),
('`hostIndirectEvalTarget` (`:6046-6051`; consumer','`hostIndirectEvalTarget` (`:6045-6051`; consumer'),
('`import-collector.ts` (C0/M1 single-owner list, `:1015-1024`).',
 '`import-collector.ts` (on the #3526 C0/M1 single-owner list, `plan/issues/3526-ir-r6-semantic-runtime-contract.md:1017-1023`).'),
('(`:6603`) ends in the same name lookup (`:6912`).','(`:6603`) ends in the same name lookup (`:6910`).'),
('(`legality.ts:269`; `boundary-surface/104-backend-closure-emitters.txt`).',
 '(`src/ir/backend/legality.ts:269`; `boundary-surface/104-backend-closure-emitters.txt`).'),
('a selector-rejected terminal unit. 9 of 14 never reach the IR boundary at\n  all — selector coverage',
 'a selector-rejected terminal unit. Only 4 of 14 (03/05/08/13 — no `irBodyEmitted`\n  unit on any lane, `results.json`) never reach the IR boundary; 10 do, via\n  compile-once, partial (02 2/3, 12 2/4) or compile-twice units — selector coverage'),
('reads across 55 callable-path files — `codegen/index.ts` 118, `calls.ts` 57,',
 'reads in 20 of the 55 scanned callable-path files — `codegen/index.ts` 118, `calls.ts` 57,'),
('   the frozen record (`irImportFuncRef(record.module, record.field)`), binding',
 '   the static catalogue record (`resolveRuntimeHostCapabilityRecord("async.callback.wrap")`;\n   from-ast runs in Phase-1 `integration.ts:2711`, BEFORE `freeze()` at `:4176`, so the\n   frozen manifest is unreadable here — policy ADMISSION is post-freeze, item 4), binding'),
('   recognition (the `attachedExternIsUndefinedArm` shape, `integration.ts:8194`) routing to the',
 '   recognition in the `call`-on-`env`-import scan of `preregisterDynamicSupport`\n   (`integration.ts:8286-8289`; `attachedExternIsUndefinedArm` `:8194-8196` matches only\n   `intrinsic` instrs and cannot see the maker). Exact resolve arm: `resolveFunc` `:7050-7052`\n   → `resolvePreparedImportCallable` `:6959` (catalog `:4296`) when `ctx.programAbiSession`\n   is set, else `:7056-7057`; both return the pre-pass index iff the record\'s `module.field`\n   equals the `import-collector.ts:2010` key; `preregisterCallableProviders` `:7441` learns no `call` instrs — routing to the'),
('| `closure-exports.ts`, `index.ts:6038-6056`, `runtime-manifest.ts`, tests | yes',
 '| `closure-exports.ts`, `index.ts:6038-6056` (R2-locked, #3521 `:953-956` — coordinated with the R2 lane as F3-S1 does), `runtime-manifest.ts`, tests | yes'),
('F1/F2 precedent is that R6 edits only its own policy-projection and\nattached-target lines there',
 'F1/F2 precedent is that R6 edits only its own policy-projection,\nattached-target and `makeFromAstResolver`-arm lines there (F2-S1 item 3, `#3526 :3359`)'),
('**Ownership**: slice claim `#3526:f3s1`. R6 owns `runtime-manifest.ts`,',
 '**Ownership**: slice claim `#3526:f3s1`. Per `#3526 :1017-1018` (C0/M1 one-owner set) R6 is sole owner of `runtime-manifest.ts`,'),
# --- design objections not covered by the verbatim edits ---
# lane label
('Lanes: gc-host `{}` · gc-strict `{strictNoHostImports:true}` · standalone\n`{target:"standalone"}` (implies nativeStrings, `src/index.ts:517-520`) · wasi\n`{target:"wasi"}`;',
 'Lanes (runner `lane-measurement/run.ts:9-13`, names as in `results.json`): gc-host `{}` ·\ngc-strict-no-host `{strictNoHostImports:true}` · standalone `{target:"standalone"}`\n(implies nativeStrings, `src/index.ts:517-520`; derives `environment:"none"` and\n`semanticProviders:"native-first"` by itself, `src/target-profile.ts:73-74`, `:96-101`) ·\nwasi `{target:"wasi"}`;'),
('— the corpus\'s standalone cell used the plain target,\nso the `domCallbackAuthority` path',
 '— the profile is NOT a different option object: the corpus\'s\nstandalone cell already had it, but its 09/09b fixtures pass the DOM as parameters and\nnever set `requiresStandaloneDomInteractionCapability` (a closed DOM-authority plan,\n`calendar-codegen-planning.ts:190-191`; fixture precedent `tests/issue-4576-standalone-dom-builtins.test.ts:325-338`),\nso the `domCallbackAuthority` path'),
('`__register_fnctor_instance` (10; survives on gc-strict too).','`__register_fnctor_instance` (10; survives on gc-strict-no-host too).'),
('- gc-strict is a native-strings regime','- gc-strict-no-host is a native-strings regime'),
('  callback, control) + the F2 `CLEAN` control × six lanes (gc-host,\n  gc-native-strings, standalone, exact standalone-DOM, WASI, linear),',
 '  callback, control) + the F2 `CLEAN` control × six lanes named by option object:\n  gc-host `{}`, gc-strict-no-host `{strictNoHostImports:true}`, standalone\n  `{target:"standalone"}`, exact standalone-DOM (same `{target:"standalone"}` on a\n  closed-DOM-authority fixture, `hasStandaloneDomDispatcher` true), wasi `{target:"wasi"}`,\n  linear `{target:"linear"}`;'),
# F3-S1 slice row: integration.ts arm + byte-neutral rationale
('`src/ir/integration.ts` (policy projection + attached-target arm), `src/ir/from-ast.ts` (`:8313` spelling from the record)',
 '`src/ir/integration.ts` (policy projection + post-freeze admission in `preregisterDynamicSupport` `:8286-8289`), `src/ir/from-ast.ts` (`:8313` spelling from the static record)'),
('| **yes** — host arm binds the existing `env.__make_callback` import index; native arm emits nothing today and after |',
 '| **yes** — host arm binds the existing `env.__make_callback` import index (no registration, no index shift); native arm emits nothing today and after; the disabled policy is unreachable on every real lane because selection never admits the arrow (post-freeze admission, contract item 4) |'),
# P1 seam name: the record-reading seam is post-freeze
('  `preparedStringCompareProvider` analog in `intrinsic-support.ts`) and prove',
 '  `preparedStringCompareProvider` analog in `intrinsic-support.ts`, read post-freeze\n  from `preregisterDynamicSupport` / `resolveFunc`, never from from-ast) and prove'),
# open question 4: phase fork now decided for F3-S1
('   @resolve and change census output — decide build-time projection vs\n   resolve-time provider before sizing.',
 '   @resolve and change census output — decide build-time projection vs\n   resolve-time provider before sizing. F3-S1 already takes the post-freeze\n   side (items 3-4: from-ast reads only the static record, admission is\n   post-freeze, refusal surfaces as `late-preparation-unsupported`@resolve);\n   F3-S3 must either follow it or justify a build-time exception.'),
]
out=src
for i,(a,b) in enumerate(edits):
    n=out.count(a)
    if n!=1: print(f"EDIT {i} count={n}: {a[:70]!r}"); sys.exit(1)
    out=out.replace(a,b)
open('.tmp/r6-f3-census/revise/f3-opening-r2.md','w').write(out)
print("ok", len(out.splitlines()), "lines")
