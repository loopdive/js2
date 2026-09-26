---
id: 6687
title: "S3-a: class async-generator methods with destructured params emit invalid Wasm under the native regime in a JS environment"
status: in-progress
assignee: ttraenkler/opus-6687
created: 2026-09-26
updated: 2026-09-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: destructuring
goal: architecture
sprint: current
parent: 5385
depends_on: [6685]
related: [2039, 2043, 2868, 6686]
---

# #6687 — S3-a: `C_method` invalid Wasm under the native regime (JS env)

Slice S3-a of the #5385 "Implementation Plan v2". ~600 nightly rows
(`language/statements/class/dstr/async-gen-meth-*`, `async-gen-private-meth-*`)
in the native-first measurement lane fail with

```
invalid Wasm binary (WebAssembly.Module(): Compiling function #110:"C_method" failed:
  not enough arguments on the stack for call (need 4, got 1)
```

(`C___priv_method` for the private-method siblings; the "stack-balance" variant
is the same defect caught earlier by the #N balance checker). The same tests
pass in BOTH the host lane and the standalone lane.

## Reproduction (measured 2026-09-26, main @ 0631fa543e)

Compile `test262/test/language/statements/class/dstr/async-gen-meth-static-ary-init-iter-close.js`
through the real assembled harness (`assembleOriginalHarness(source, parseMeta(source)).primary.source`,
`skipSemanticDiagnostics: true`, `inferModuleStrictArguments: false`) under three
profiles:

| profile                                                | result                           |
| ------------------------------------------------------ | -------------------------------- |
| `semanticProviders: "native-first"` + `JS2WASM_NATIVE_REGIME_JS=1` | **INVALID** (need 4, got 1)      |
| `target: "standalone"`                                 | valid                            |
| default `gc`                                           | valid                            |

A bare `compile()` of the class alone (no harness) is valid in all three
profiles — the defect needs the harness's iterator shapes in the module, i.e.
the late-import / index-shift regime described below. Do not reduce it to a
snippet; use the assembled source (the probe is in
`.tmp/` style: read file → `parseMeta` → `assembleOriginalHarness` → `compile`
with `emitWat: true`).

## Root cause (from the WAT diff regime vs standalone, same source)

In `C_method`, the array-pattern parameter materializer boxes an f64 element
to externref. The regime build emits

```
local.get 11            ;; f64 element
i32.trunc_sat_f64_s
call 81                 ;; resolves to __num_ryu_to_buf (4 params) — WRONG callee
```

while the standalone build inlines the smi box (`$smi_box_f64` / `ref.i31`
sequence) at the same site. `call 81` is a **stale-low function index**: the
arm captured `ctx.funcMap.get("__box_number")` before `addUnionImports` /
`ensureObjectRuntime` inserted imports and shifted every defined-function
index — the exact hazard the comment at
`src/codegen/destructuring-params.ts` ≈ L628–L636 documents for
`__extern_length` / `__extern_get_idx` (and fixes there by re-reading the name
post-shift). Under standalone the `__box_number` name is never consulted on
this path (the `(ctx.standalone || ctx.wasi)` arm inlines instead); under the
regime in a JS environment an environment-shaped sibling arm still registers
the host `__box_number` import late, so the name resolves to a stale index.

Candidate sites in `src/codegen/destructuring-params.ts` (all read
`ctx.funcMap.get("__box_number")` without a post-shift re-read):
≈ L591, L603, L650, L673 (`boxElementInstrs`-style helper by `storageKind`),
≈ L1140–L1145 (default-initializer boxing), and the fallback materializer
around ≈ L2269 (`i32.trunc_sat_f64_s` site). Confirm which one owns byte
offset `@+276996` by dumping the WAT (the probe prints `call N` lines).

## Fix (spec)

1. Route every f64/i32 → externref box in this file through the ONE shared
   boxing helper that already honors the regime (the standalone inline smi-box
   path used by `boxToExternref` in `src/codegen/type-coercion.ts`); do not
   add a fourth copy of the `__box_number` lookup.
2. Where a host `__box_number` call is legitimately kept (host-assisted
   profile only), resolve the index AFTER `flushLateImportShifts` / by name at
   emit time, matching the ≈ L633 pattern.
3. Add the assembled-harness repro as a focused test (three profiles; assert
   `new WebAssembly.Module(binary)` validates under the regime, and that the
   default `gc` and `standalone` binaries are byte-identical to before).

Do NOT change the async-generator carrier or the class-method dispatch
trampolines; the WAT diff shows the divergence is confined to the element
boxing site.

## Acceptance

- [ ] The three repro files (`async-gen-meth-static-ary-init-iter-close.js`,
      `async-gen-meth-ary-name-iter-val.js`,
      `async-gen-meth-static-dflt-ary-ptrn-rest-ary-elem.js`) validate and
      pass under `JS2WASM_EVAL_ENGINE=interpreter TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER=… pnpm run test:262`.
- [ ] `tests/issue-4396-target-profile.test.ts` byte-identity green; standalone
      output for the repro byte-identical (assert in the focused test).
- [ ] 321-row sample not below the S1/S2 number.
- [ ] Nightly lane: the `C_method`/`C___priv_method` "not enough arguments" and
      "stack-balance" signatures drop to zero (record the before/after).
