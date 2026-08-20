// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Import/global registration and late index-space fixups. */
import type { Import, Instr, TagDef, ValType } from "../../ir/types.js";
import type { CodegenContext, ExternClassInfo } from "../context/types.js";
import { buildStrictHostImportError, isHostImportAllowed } from "../host-import-allowlist.js";
import { resolveWidenedVarKey } from "../widened-var-key.js";
import { hasLoneSurrogate, hexCodeUnits, STRING_CONSTANTS16_NS } from "../../string-surrogate.js";
import { addFuncType } from "./types.js";
// #808 — dependencies of the import-collection/registration functions moved
// here from index.ts (relative paths rebased for src/codegen/registry/).
import { ts, forEachChild } from "../../ts-api.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { shiftAsyncSideChannelFuncIdxs } from "../async-scheduler.js";
import { buildIsUndefinedExternBody, undefinedSingletonActive, ensureAnyValueType } from "../any-helpers.js";
import { createUnifiedCollectorState, unifiedVisitNode, finalizeUnifiedCollector } from "../declarations.js";
import { mapTsTypeToWasm } from "../../checker/type-mapper.js";
import { inLiveShiftRange } from "../../emit/resolve-layout.js";
import { UNDEF_F64_BITS } from "../value-tags.js";
import { STANDALONE_REGEXP_REFLECTION_PROPS } from "../regexp-standalone.js";
import { reconcileNativeStrFinalizeShift } from "../expressions/late-imports.js";
import { emitWasiErrorConstructor } from "./error-types.js";
import { emitNativeParseNumber } from "../parse-number-native.js";
import { boxBooleanBody } from "../interned-boolean-boxes.js"; // (#3780) interned true/false carriers
import { isTupleType, isStandaloneRegExpMatchArrayValue } from "../index.js";
import { planProgramAbiStringConstantImport } from "../program-abi-import-planning.js";
import { shiftModuleGlobalExportIndices } from "../global-export-fixup.js";

/**
 * Register an import (`module.name`) on the current module.
 *
 * Under `ctx.strictNoHostImports` (auto-on for `--target wasi`, controllable
 * via `--no-host-imports` / `--allow-host-imports` on the CLI; see #1524),
 * any `env`-module import that is not on the dual-mode allowlist
 * (`src/codegen/host-import-allowlist.ts`) is rejected with a structured
 * compile error referencing the tracking issue. The error is pushed onto
 * `ctx.errors`; the import itself is silently dropped to avoid producing a
 * module that references a nonexistent function index. Downstream code that
 * attempts to `call` the dropped function will fail validation if the
 * caller did not check `result.success` before consuming the binary.
 *
 * `wasi_snapshot_preview1` imports are always allowed; they are the canonical
 * WASI ABI, not JS-host bindings.
 *
 * `wasm:js-string` / `string_constants` are JS-host bindings but are usually
 * not requested under strict mode because `nativeStrings` is auto-enabled.
 * If they ARE requested under strict mode, the gate rejects them with a
 * dedicated error pointing the user at the nativeStrings option.
 */
export function addImport(ctx: CodegenContext, module: string, name: string, desc: Import["desc"]): Import | undefined {
  // #1984 — freeze-point discipline. Once the module's index spaces are
  // declared final (set right before `stackBalance` in generateModule/
  // generateMultiModule), any further import mutation is a producer bug:
  // it shifts indices that downstream code already emitted as final, the
  // #2043-class poisoning. Throw HERE so the offending producer self-identifies
  // with its own stack, instead of #2043's emit-time validation only naming the
  // downstream symptom. The throw is caught by the generate* try/catch and
  // surfaced as a `Codegen error:` (the compile fails loudly, never ships a
  // poisoned binary).
  if (ctx.indexSpaceFrozen) {
    throw new Error(
      `import space frozen (#1984): '${module}.${name}' added after finalize — ` +
        `this producer must register its import before the freeze point or refuse loudly`,
    );
  }
  if (ctx.strictNoHostImports) {
    // #2783 — pass `ctx.linkedNamespaces` so an arbitrary `--link`'d namespace's
    // import is actually REGISTERED (left as a link-time import for a preloaded
    // provider) rather than dropped-and-degraded here. Dropping it would leave a
    // stale funcMap index and the program could never satisfy the linked symbol.
    const decision = isHostImportAllowed(module, name, ctx.linkedNamespaces);
    if (!decision.allowed) {
      const message = buildStrictHostImportError(module, name);
      // #1921 — this per-call gate *drops* the import and lets codegen
      // continue, so the diagnostic is a deliberate `"degrade"`, not a hard
      // error: the binary is still produced (dropped imports degrade to no-op
      // / stale-index sites). The authoritative fatal backstop is the
      // emit-time import-section scan (`assertNoLeakedHostImports` →
      // `buildLeakedHostImportError`, severity "error"), which fires only if
      // an unsupported host import actually *survived* into the finished
      // binary. Classifying this as "error" instead would fail builds that
      // legitimately drop-and-degrade unsupported host APIs under WASI (e.g.
      // examples/native-messaging/nm_js2wasm.ts: setTimeout/fetch/…).
      ctx.errors.push({ message, line: 0, column: 0, severity: "degrade" });
      // (#3009) Record the dropped host import on the MODULE so finalize-time
      // handle resolution can name it. When a producer bakes this dropped
      // import's (now `undefined`) function index into a helper body coupled to
      // a stable handle — e.g. console.log's native-string extern bridge
      // `__str_to_extern` calling the dropped `__str_from_mem`/`__str_to_mem`/
      // `__str_extern_len` — `absoluteFuncIndex` would otherwise crash with an
      // opaque "stable handle undefined (ordinal NaN)". With the coupling
      // recorded, that resolution point surfaces a clean, actionable leak
      // diagnostic naming these imports instead of an internal-error stack.
      if (desc.kind === "func") {
        const recorded = (ctx.mod.strictDroppedHostImports ??= []);
        if (!recorded.some((d) => d.module === module && d.name === name)) {
          recorded.push({ module, name });
        }
      }
      // Skip registration. The caller may record a stale funcMap index if it
      // looks the import up by name; if that index is ever emitted into the
      // binary the emit-time leak scan / link step catches it.
      return undefined;
    }
  }
  ctx.mod.imports.push({ module, name, desc });
  if (desc.kind === "func") {
    ctx.funcMap.set(name, ctx.numImportFuncs);
    ctx.numImportFuncs++;
  }
  if (desc.kind === "global") {
    ctx.numImportGlobals++;
  }
  return ctx.mod.imports[ctx.mod.imports.length - 1]!;
}

/**
 * Register a string literal as a global import from the "string_constants"
 * namespace and repair already-compiled module-global references if needed.
 *
 * In `nativeStrings` mode (auto-on for `--target wasi`), no JS host runtime
 * exists to satisfy the import, so we skip the import and just record the
 * string in `stringGlobalMap` with the sentinel `-1` (the same convention
 * used by `collectStringLiterals` finalize). Call sites that materialize a
 * string constant onto the stack must check the sentinel and use the native
 * string path (`compileNativeStringLiteral` + `extern.convert_any` for the
 * externref-typed throw payload) instead of `global.get`. (#1174)
 */
export function addStringConstantGlobal(ctx: CodegenContext, value: string): void {
  if (ctx.stringGlobalMap.has(value)) return;
  if (ctx.nativeStrings) {
    // Sentinel: no host import, materialize inline at use sites.
    ctx.stringGlobalMap.set(value, -1);
    ctx.stringLiteralMap.set(value, `__str_${ctx.stringLiteralCounter}`);
    ctx.stringLiteralValues.set(`__str_${ctx.stringLiteralCounter}`, value);
    ctx.stringLiteralCounter++;
    ctx.mod.stringPool.push(value);
    return;
  }
  const hasModuleGlobals = ctx.mod.globals.length > 0 || ctx.mod.functions.length > 0;
  const oldNumImportGlobals = ctx.numImportGlobals;
  const globalIdx = ctx.numImportGlobals;
  // (#2880) A wasm import field name must be valid UTF-8. A literal containing a
  // lone surrogate cannot be its own field name (TextEncoder makes it lossy,
  // V8 rejects WTF-8), so route it through the `string_constants16` namespace
  // keyed by the hex of its UTF-16 code units (ASCII). The runtime mirrors this
  // key in `buildStringConstants16`. Surrogate-free literals are unchanged.
  const useSurrogateNs = hasLoneSurrogate(value);
  const importModule = useSurrogateNs ? STRING_CONSTANTS16_NS : "string_constants";
  const importName = useSurrogateNs ? hexCodeUnits(value) : value;
  const stableOrdinal = ctx.stringLiteralCounter;
  const importValue = addImport(ctx, importModule, importName, {
    kind: "global",
    type: { kind: "externref" },
    mutable: false,
  });
  if (importValue) planProgramAbiStringConstantImport(ctx, importValue, stableOrdinal);
  ctx.stringGlobalMap.set(value, globalIdx);
  ctx.stringLiteralMap.set(value, `__str_${ctx.stringLiteralCounter}`);
  ctx.stringLiteralValues.set(`__str_${ctx.stringLiteralCounter}`, value);
  ctx.stringLiteralCounter++;
  ctx.mod.stringPool.push(value);
  if (hasModuleGlobals) {
    fixupModuleGlobalIndices(ctx, oldNumImportGlobals, 1);
  }
}

/** Return the absolute Wasm global index for a new module-defined global. */
export function nextModuleGlobalIdx(ctx: CodegenContext): number {
  return ctx.numImportGlobals + ctx.mod.globals.length;
}

/**
 * (#2800) Record a `global.get __in_module_init` instruction for FINALIZE-time
 * index resolution. Returns a fresh `global.get` Instr with a PLACEHOLDER index
 * and registers it on `ctx.inModuleInitFlagReads`; the caller bakes this exact
 * object into its body. `finalizeInModuleInitFlag` (codegen/index.ts) allocates
 * the i32 flag global AFTER every import global has settled and patches each
 * recorded instr's `.index` to the final slot — so no read can desync when a
 * later string-constant import shifts the module-global range (the live-baked
 * index hazard #2043 across closure bodies the per-add fixup can miss).
 *
 * The flag is 1 only while `__module_init` runs; the delete-aware `any`-receiver
 * read branches on it (init → host-free `__get_member_<name>` slot dispatcher;
 * runtime → tombstone-aware host `__extern_get`). gc/host runs `__module_init`
 * via the Wasm `start` section INSIDE `WebAssembly.instantiate`, before the host
 * wires struct getters (`__setExports`), so the host read returns undefined for
 * every struct field at init — this flag is what makes init reads correct.
 */
export function recordInModuleInitFlagRead(ctx: CodegenContext): Instr {
  const flagGet: Instr = { op: "global.get", index: 0 };
  (ctx.inModuleInitFlagReads ??= []).push(flagGet);
  return flagGet;
}

/** Convert an absolute Wasm global index to a local module-globals array index. */
export function localGlobalIdx(ctx: CodegenContext, absIdx: number): number {
  return absIdx - ctx.numImportGlobals;
}

/**
 * Lazily register the exception tag used by throw/try-catch.
 * The tag has signature (externref) — all thrown values are externref.
 */
export function ensureExnTag(ctx: CodegenContext): number {
  if (ctx.exnTagIdx >= 0) return ctx.exnTagIdx;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], []);
  const tagDef: TagDef = { name: "__exn", typeIdx };
  ctx.exnTagIdx = ctx.mod.tags.length;
  ctx.mod.tags.push(tagDef);
  return ctx.exnTagIdx;
}

/**
 * Fix up module-global absolute indices in all compiled function bodies when
 * new import globals are inserted after module globals already exist.
 */
function fixupModuleGlobalIndices(ctx: CodegenContext, threshold: number, delta: number): void {
  // Dedupe per-call: an instr (or nested array node) reachable from multiple
  // top-level bodies must only be shifted once per fixup call. The `shifted`
  // Set below dedupes top-level Instr[] arrays, but nested arrays (if.then,
  // block.body, try.body, try.catches[].body, try.catchAll) can be reached
  // from multiple top-level paths (e.g. an if-then array that's also stored
  // in a saved body via a manual swap pattern). Without per-call dedup, each
  // additional reachability path applies an extra +delta, over-shifting the
  // index past the declared global range (#1302 — lodash flow.js).
  // (#2023) Keep the cached new.target global index in step with the shift, so
  // call sites compiled after a later string-constant import still target it.
  if (ctx.newTargetGlobalIdx !== undefined && ctx.newTargetGlobalIdx >= threshold) {
    ctx.newTargetGlobalIdx += delta;
  }
  // (#2001 S1 regress) Same hazard for the `$__hole` singleton global. When a
  // string-constant import is inserted after `$Hole` was registered,
  // `shiftGlobalIndices` correctly bumps the already-emitted `global.get
  // $__hole` refs, but the CACHED `ctx.holeGlobalIdx` would go stale — so a
  // LATER `emitHoleSentinel` (a hole literal compiled after the string import)
  // would target the wrong, un-shifted slot (it pointed one below, at
  // `__current_this`), storing a null instead of `$Hole`. That null marshals to
  // the host faithfully, so a hole-array call argument's destructuring default
  // silently never fires (`f([,])` → the -39 regression in PR #1838). Keep the
  // cached index in step exactly as `newTargetGlobalIdx` does.
  if (ctx.holeGlobalIdx !== undefined && ctx.holeGlobalIdx >= threshold) {
    ctx.holeGlobalIdx += delta;
  }
  // (#3032) Same hazard for the cached `__gen_eager_mode` flag global: a
  // string-constant import inserted between two generator-expression
  // emissions left the SECOND emission's `global.get` pointing one slot low
  // (an externref global → "if[0] expected type i32, found global.get of
  // type externref" — the fn-name-gen compile_error cluster in PR #2625's
  // first merge_group cycle). Keep the cached index in step exactly as
  // `newTargetGlobalIdx`/`holeGlobalIdx` above.
  if (ctx.genEagerFlagGlobalIdx !== undefined && ctx.genEagerFlagGlobalIdx >= threshold) {
    ctx.genEagerFlagGlobalIdx += delta;
  }
  // (#3933) And again for the per-element-type shared zero-length vec backing
  // store. This is the FOURTH instance of the identical bug — the cache is a
  // Map rather than a scalar, but the failure is the same: the emitted
  // `global.get`s below are shifted correctly while the cache is not, so the
  // NEXT `[]` of that element type reuses an index that now names an unrelated
  // global. Landing on an i32/f64 global fails validation ("struct.new[1]
  // expected type (ref null N), found global.get of type i32"); landing on an
  // externref one instead validates — the coercion layer repairs it with
  // `any.convert_extern` + `ref.cast` — and traps at run time. That is the
  // 400 `wasm_compile` / 3,634 `illegal_cast` split that took PR #3933 out of
  // the merge queue at −2,621 test262 passes.
  if (ctx.sharedEmptyVecGlobals !== undefined) {
    for (const [typeIdx, globalIdx] of ctx.sharedEmptyVecGlobals) {
      if (globalIdx >= threshold) ctx.sharedEmptyVecGlobals.set(typeIdx, globalIdx + delta);
    }
  }

  const visitedInstrs = new WeakSet<object>();
  const visitedArrays = new WeakSet<Instr[]>();
  function shiftGlobalIndices(instrs: Instr[]): void {
    if (visitedArrays.has(instrs)) return;
    visitedArrays.add(instrs);
    for (const instr of instrs) {
      if ((instr.op === "global.get" || instr.op === "global.set") && instr.index >= threshold) {
        if (!visitedInstrs.has(instr as object)) {
          visitedInstrs.add(instr as object);
          instr.index += delta;
        }
      }
      // (#4415) Direct property reads, not `in`. This walk visits ~89,000
      // instructions per compile (32 calls x ~2,790 each — every string
      // constant added after code exists rewalks the whole module), and `in`
      // is a prototype-chain lookup where a plain load suffices. `Array.isArray`
      // already rejects both absent and non-array values, so the `in` guard was
      // never load-bearing.
      const nested = instr as unknown as {
        body?: unknown;
        then?: unknown;
        else?: unknown;
        catches?: { body?: unknown }[];
        catchAll?: unknown;
      };
      if (Array.isArray(nested.body)) shiftGlobalIndices(nested.body as Instr[]);
      if (Array.isArray(nested.then)) shiftGlobalIndices(nested.then as Instr[]);
      if (Array.isArray(nested.else)) shiftGlobalIndices(nested.else as Instr[]);
      if (Array.isArray(nested.catches)) {
        for (const c of nested.catches) if (Array.isArray(c.body)) shiftGlobalIndices(c.body as Instr[]);
      }
      if (Array.isArray(nested.catchAll)) shiftGlobalIndices(nested.catchAll as Instr[]);
    }
  }

  const shifted = new Set<Instr[]>();
  for (const func of ctx.mod.functions) {
    if (!shifted.has(func.body)) {
      shiftGlobalIndices(func.body);
      shifted.add(func.body);
    }
  }

  if (ctx.currentFunc) {
    if (!shifted.has(ctx.currentFunc.body)) {
      shiftGlobalIndices(ctx.currentFunc.body);
      shifted.add(ctx.currentFunc.body);
    }
    for (const sb of ctx.currentFunc.savedBodies) {
      if (shifted.has(sb)) continue;
      shiftGlobalIndices(sb);
      shifted.add(sb);
    }
  }

  for (const parentFctx of ctx.funcStack) {
    if (!shifted.has(parentFctx.body)) {
      shiftGlobalIndices(parentFctx.body);
      shifted.add(parentFctx.body);
    }
    for (const sb of parentFctx.savedBodies) {
      if (!shifted.has(sb)) {
        shiftGlobalIndices(sb);
        shifted.add(sb);
      }
    }
  }

  for (const pb of ctx.parentBodiesStack) {
    if (!shifted.has(pb)) {
      shiftGlobalIndices(pb);
      shifted.add(pb);
    }
  }

  if (ctx.pendingInitBody && !shifted.has(ctx.pendingInitBody)) {
    shiftGlobalIndices(ctx.pendingInitBody);
    shifted.add(ctx.pendingInitBody);
  }

  // (#1712) Walk all live (allocated but not yet attached to mod.functions)
  // FunctionContext bodies — same coverage the late FUNC-index shifters gained
  // in #1384 (addStringImports/addUnionImports walk ctx.liveBodies). Without
  // this, a lifted/callback closure body that is only reachable via
  // liveBodies during its emission window keeps pre-shift module-global
  // indices: compiling acorn left `FUNC_STATEMENT | FUNC_NULLABLE_ID` in
  // __closure_86 reading the neighbouring global (ref-typed) and produced
  // invalid Wasm (`f64.trunc[0] … found global.get of type (ref null 1)`).
  for (const lb of ctx.liveBodies) {
    if (!shifted.has(lb)) {
      shiftGlobalIndices(lb);
      shifted.add(lb);
    }
  }

  for (const g of ctx.mod.globals) {
    if (g.init) shiftGlobalIndices(g.init);
  }

  shiftModuleGlobalExportIndices(ctx, threshold, delta);

  function shiftMap(map: Map<string, number>): void {
    for (const [key, idx] of map) {
      if (idx >= threshold) {
        map.set(key, idx + delta);
      }
    }
  }
  shiftMap(ctx.moduleGlobals);
  shiftMap(ctx.capturedGlobals);
  // (#3039) `capturedBoxGlobals` values are objects, not bare indices — shift
  // each entry's `globalIdx` in place like `protoOverrides` below. The
  // pre-existing transitive-fn box global shared this latent staleness; a
  // late string-constant import between registration and the box's
  // `global.get`/`struct.set` would otherwise leave the recorded index
  // pointing at the wrong (shifted) slot.
  if (ctx.capturedBoxGlobals) {
    for (const entry of ctx.capturedBoxGlobals.values()) {
      if (entry.globalIdx >= threshold) {
        entry.globalIdx += delta;
      }
    }
  }
  shiftMap(ctx.staticProps);
  shiftMap(ctx.protoGlobals);
  shiftMap(ctx.classObjectGlobals); // (#1395) — same shift discipline as protoGlobals
  shiftMap(ctx.methodClosureGlobals); // (#1394) — cached per-method closure globals
  shiftMap(ctx.funcClosureGlobals); // (#1340) — cached per-function closure globals
  shiftMap(ctx.tdzGlobals);

  // (#1749) The CPR proto-override records (Array.prototype[@@iterator] /
  // .values) root each lifted override closure in a module-defined `mut
  // externref` global; the recorded absolute `globalIdx` must shift exactly
  // like every other module-global index when a late string-constant import is
  // inserted. Without this, the read-drive site (`arrayIteratorOverrideGlobalIdx`
  // → `global.get`) reads a stale slot — e.g. a spread `[...arr]` whose result
  // is later indexed (`a[0]`) adds a "Cannot access property" string global,
  // shifting the override slot out from under the captured index → the drive
  // reads null and the override is silently ignored.
  for (const inner of ctx.protoOverrides.values()) {
    for (const entry of inner.values()) {
      if (entry.globalIdx !== undefined && entry.globalIdx >= threshold) {
        entry.globalIdx += delta;
      }
    }
  }

  for (const entry of ctx.staticInitExprs) {
    if (entry.globalIdx !== undefined && entry.globalIdx >= threshold) {
      entry.globalIdx += delta;
    }
  }

  if (ctx.symbolCounterGlobalIdx >= threshold) {
    ctx.symbolCounterGlobalIdx += delta;
  }
  if (ctx.symbolDescGlobalIdx >= threshold) {
    ctx.symbolDescGlobalIdx += delta;
  }
  if (ctx.symbolRegKeysGlobalIdx >= threshold) {
    ctx.symbolRegKeysGlobalIdx += delta;
  }
  if (ctx.symbolRegIdsGlobalIdx >= threshold) {
    ctx.symbolRegIdsGlobalIdx += delta;
  }
  if (ctx.symbolRegCountGlobalIdx >= threshold) {
    ctx.symbolRegCountGlobalIdx += delta;
  }
  if (ctx.wasiBumpPtrGlobalIdx >= threshold) {
    ctx.wasiBumpPtrGlobalIdx += delta;
  }
  if (ctx.argcGlobalIdx >= threshold) {
    ctx.argcGlobalIdx += delta;
  }
  if (ctx.extrasArgvGlobalIdx >= threshold) {
    ctx.extrasArgvGlobalIdx += delta;
  }
  if (ctx.currentThisGlobalIdx >= threshold) {
    ctx.currentThisGlobalIdx += delta;
  }
  // (#4203) Explicit-null receiver marker — same reason as `currentThisGlobalIdx`.
  if (ctx.explicitNullThisGlobalIdx !== undefined && ctx.explicitNullThisGlobalIdx >= threshold) {
    ctx.explicitNullThisGlobalIdx += delta;
  }
  if (ctx.callerStrictGlobalIdx >= threshold) {
    ctx.callerStrictGlobalIdx += delta;
  }
  // (#3251 S1) Vec-overlay state global (registered at finalize; standalone
  // only — no import globals arrive that late, this is belt-and-suspenders).
  if (ctx.vecOverlayStateGlobalIdx !== undefined && ctx.vecOverlayStateGlobalIdx >= threshold) {
    ctx.vecOverlayStateGlobalIdx += delta;
  }
  // (#4504) The descriptor-aware [[Set]] result channel is a module global
  // created before some compilation paths can still lazily insert an import
  // global. Keep the cached index aligned with the emitted global.get/set
  // instructions so later Reflect/strict helpers do not read an adjacent slot.
  if (ctx.externSetResultGlobalIdx !== undefined && ctx.externSetResultGlobalIdx >= threshold) {
    ctx.externSetResultGlobalIdx += delta;
  }
}

// ---------------------------------------------------------------------------
// #808 — import collection & registration functions extracted from index.ts.
// Behaviour-preserving verbatim move (byte-identity guarded via
// scripts/prove-emit-identity.mjs). See plan/issues/808-*.
// ---------------------------------------------------------------------------

export function collectAllSourceImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const state = createUnifiedCollectorState(sourceFile);
  forEachChild(sourceFile, (node) => unifiedVisitNode(ctx, state, node));
  finalizeUnifiedCollector(ctx, state);
}

/** Register wasm:js-string builtin imports (called on demand when strings are used) */
export function addStringImports(ctx: CodegenContext): void {
  if (ctx.hasStringImports) return;
  // #1470: standalone target must never register the wasm:js-string namespace.
  // The nativeStrings path is the standalone alternative and is forced on for
  // ctx.standalone in createCodegenContext. If a caller still reaches this
  // path under standalone (e.g. via a missed gate), no-op so the resulting
  // module remains JS-host-free. WASI mode keeps the historical no-op
  // behavior via the same nativeStrings forcing.
  if (ctx.targetProfile.semanticProviders === "native-first") {
    ctx.hasStringImports = true;
    return;
  }
  ctx.hasStringImports = true;

  // Record import count before adding so we can shift function indices
  // if this is called after collectDeclarations has run.
  const importsBefore = ctx.numImportFuncs;

  // concat: (externref, externref) -> (ref extern)
  const concatType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "ref_extern" }]);
  addImport(ctx, "wasm:js-string", "concat", {
    kind: "func",
    typeIdx: concatType,
  });

  // length: (externref) -> i32
  const lengthType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "wasm:js-string", "length", {
    kind: "func",
    typeIdx: lengthType,
  });

  // equals: (externref, externref) -> i32
  const equalsType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "wasm:js-string", "equals", {
    kind: "func",
    typeIdx: equalsType,
  });

  // substring: (externref, i32, i32) -> (ref extern)
  const substringType = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "ref_extern" }],
  );
  addImport(ctx, "wasm:js-string", "substring", {
    kind: "func",
    typeIdx: substringType,
  });

  // charCodeAt: (externref, i32) -> i32
  const charCodeAtType = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }]);
  addImport(ctx, "wasm:js-string", "charCodeAt", {
    kind: "func",
    typeIdx: charCodeAtType,
  });

  // Store wasm:js-string import indices separately so user-defined functions
  // with the same name (e.g. user's "charCodeAt") don't shadow them (#1072).
  for (const name of ["concat", "length", "equals", "substring", "charCodeAt"]) {
    const idx = ctx.funcMap.get(name);
    if (idx !== undefined) ctx.jsStringImports.set(name, idx);
  }

  // If imports were added after defined functions were registered (late addition),
  // shift all defined-function indices.
  const delta = ctx.numImportFuncs - importsBefore;
  if (delta > 0 && ctx.mod.functions.length > 0) {
    const newImportNames = new Set(["concat", "length", "equals", "substring", "charCodeAt"]);
    for (const [name, idx] of ctx.funcMap) {
      if (!newImportNames.has(name) && inLiveShiftRange(idx, importsBefore)) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && inLiveShiftRange(exp.desc.index, importsBefore)) {
        exp.desc.index += delta;
      }
    }
    // Track ALL instruction arrays (top-level AND nested) to prevent
    // double-shifting when fctx.body is a nested block reachable from savedBodies (#1109).
    const shifted = new Set<Instr[]>();
    function shiftFuncIndices(instrs: Instr[]): void {
      if (shifted.has(instrs)) return;
      shifted.add(instrs);
      for (const instr of instrs) {
        if ((instr.op === "call" || instr.op === "return_call") && inLiveShiftRange(instr.funcIdx, importsBefore)) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && inLiveShiftRange(instr.funcIdx, importsBefore)) {
          instr.funcIdx += delta;
        }
        const a = instr as any;
        if (a.body && Array.isArray(a.body)) shiftFuncIndices(a.body);
        if (a.then && Array.isArray(a.then)) shiftFuncIndices(a.then);
        if (a.else && Array.isArray(a.else)) shiftFuncIndices(a.else);
        if (a.catches && Array.isArray(a.catches)) {
          for (const c of a.catches) {
            if (Array.isArray(c.body)) shiftFuncIndices(c.body);
          }
        }
        if (a.catchAll && Array.isArray(a.catchAll)) shiftFuncIndices(a.catchAll);
      }
    }
    for (const func of ctx.mod.functions) {
      shiftFuncIndices(func.body);
    }
    if (ctx.currentFunc) {
      shiftFuncIndices(ctx.currentFunc.body);
      for (const sb of ctx.currentFunc.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const parentFctx of ctx.funcStack) {
      shiftFuncIndices(parentFctx.body);
      for (const sb of parentFctx.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const pb of ctx.parentBodiesStack) {
      shiftFuncIndices(pb);
    }
    // (#1384) Walk all live (allocated but not yet attached to mod.functions)
    // FunctionContext bodies — covers cbFctx.body / liftedFctx.body during
    // their captures-extraction + param-coercion setup phases.
    for (const lb of ctx.liveBodies) {
      shiftFuncIndices(lb);
    }
    // (#1839) The module-init body holds `call`/`ref.func` indices too. When
    // the first string usage occurs inside a function body (not module-init),
    // this body is NOT reachable via funcStack/liveBodies yet, so it would be
    // missed and `__module_init` would call the wrong functions after the late
    // string-import shift. Matches addUnionImports / shiftLateImportIndices.
    if (ctx.pendingInitBody) {
      shiftFuncIndices(ctx.pendingInitBody);
    }
    for (const elem of ctx.mod.elements) {
      if (elem.funcIndices) {
        for (let i = 0; i < elem.funcIndices.length; i++) {
          if (inLiveShiftRange(elem.funcIndices[i]!, importsBefore)) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) =>
        inLiveShiftRange(idx, importsBefore) ? idx + delta : idx,
      );
    }
    // (#1525b) Shift pendingMethodTrampolines side-channel indices in lockstep
    // — see the matching block in addUnionImports / shiftLateImportIndices.
    for (const t of ctx.pendingMethodTrampolines) {
      if (inLiveShiftRange(t.methodFuncIdx, importsBefore)) t.methodFuncIdx += delta;
      if (inLiveShiftRange(t.trampolineFuncIdx, importsBefore)) t.trampolineFuncIdx += delta;
    }
    // (#1839) `nativeStrHelpers` is read directly by string-lowering call sites
    // and helper emitters — it is NOT a copy of funcMap, so it must be shifted
    // on its own. All entries are defined functions (>= numImportFuncs), so
    // every entry >= importsBefore moves up by `delta`. Omitting this left the
    // map stale under plain `--nativeStrings` JS-host mode.
    for (const [name, idx] of ctx.nativeStrHelpers) {
      if (inLiveShiftRange(idx, importsBefore)) {
        ctx.nativeStrHelpers.set(name, idx + delta);
      }
    }
    // (#1913) Regex helper map moves in lockstep too — regexp-standalone call
    // sites bake `call` indices straight from this map.
    for (const [name, idx] of ctx.nativeRegexHelpers) {
      if (inLiveShiftRange(idx, importsBefore)) {
        ctx.nativeRegexHelpers.set(name, idx + delta);
      }
    }
    // (#2162) Map/Set/WeakMap/WeakSet helper map moves in lockstep too —
    // map-runtime.ts / weak-collections-runtime.ts call sites bake `call`
    // indices straight from this map (see shiftLateImportIndices for the full
    // rationale / the WeakMap stale-index validation failure it fixes).
    for (const [name, idx] of ctx.mapHelpers) {
      if (inLiveShiftRange(idx, importsBefore)) {
        ctx.mapHelpers.set(name, idx + delta);
      }
    }
    // (#2918) Async-scheduler + Promise.all/race combinator side-channel funcIdxs
    // move in lockstep too. The string-import shifter used to miss them entirely
    // — a native `.then`/combinator baked its `call`/`ref.func` from a stale-low
    // stored index whenever a string import landed between registration and the
    // bake site. Same complete key list as the other two shifters.
    shiftAsyncSideChannelFuncIdxs(ctx, importsBefore, delta);
    // (#2039 slice 2) Re-base so reconcileNativeStrFinalizeShift doesn't apply
    // the same `delta` a second time — this inline shift already repaired the
    // helper bodies and the map. Matches addUnionImports (#1677-fast-path) and
    // shiftLateImportIndices.
    if (ctx.nativeStrHelperImportBase >= 0) {
      ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
    }
    // (#1839) The module start function index also moves if it was a defined
    // function at or above the insertion point. Matches addUnionImports.
    if (ctx.mod.startFuncIdx !== undefined && inLiveShiftRange(ctx.mod.startFuncIdx, importsBefore)) {
      ctx.mod.startFuncIdx += delta;
    }
  }
}

/** Register union type helper imports (typeof checks, boxing/unboxing) */
export function addUnionImports(ctx: CodegenContext): void {
  if (ctx.hasUnionImports) return;
  ctx.hasUnionImports = true;

  // #2039: settle any deferred ensureLateImport batch before this pass bakes
  // or shifts funcIdx values. With native semantic providers the helper
  // registration below computes indices from the post-batch `numImportFuncs`;
  // the compatibility provider's internal shift uses `importsBefore`. Either
  // way, a still-pending batch flush would later re-apply its delta on top —
  // an over-shift that desyncs funcMap/bodies from actual function positions
  // (same mechanism as the ensureObjectRuntime guard; see object-runtime.ts).
  flushLateImportShifts(ctx, null);

  // With native semantic providers (#1180/#1471/#4397), emit Wasm-native
  // implementations of the box / unbox / typeof / is_truthy helpers instead of
  // `env::*` host imports. The native implementations preserve the
  // same name + signature so existing call sites
  // (`ctx.funcMap.get("__unbox_number")` etc.) work unchanged.
  // Same dual-mode pattern as #679 (strings) and #682 (RegExp).
  if (ctx.targetProfile.semanticProviders === "native-first") {
    addUnionImportsAsNativeFuncs(ctx);
    return;
  }

  // Record the import count before adding, so we can adjust defined-function
  // indices if imports are added after collectDeclarations has run.
  const importsBefore = ctx.numImportFuncs;

  // __typeof_number: (externref) → i32
  const typeofType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__typeof_number", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_string", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_boolean", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_bigint", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_undefined", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_object", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_function", {
    kind: "func",
    typeIdx: typeofType,
  });

  // __is_truthy: (externref) → i32
  addImport(ctx, "env", "__is_truthy", { kind: "func", typeIdx: typeofType });

  // __unbox_number: (externref) → f64
  const unboxNumType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
  addImport(ctx, "env", "__unbox_number", {
    kind: "func",
    typeIdx: unboxNumType,
  });

  // __unbox_boolean: (externref) → i32
  addImport(ctx, "env", "__unbox_boolean", {
    kind: "func",
    typeIdx: typeofType,
  });

  // __box_number: (f64) → externref
  const boxNumType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxNumType });

  // __box_boolean: (i32) → externref
  const boxBoolType = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_boolean", {
    kind: "func",
    typeIdx: boxBoolType,
  });

  // __box_symbol: (i32) → externref  (#2792 — boxes a symbol-handle i32 as a JS
  // Symbol via the identity-stable host symbol cache. The F1 `symbol[]` OOB read
  // routes here (HOST mode only — standalone defers `symbol[]`; see
  // `f1ElementBoxType`). Same (i32)→externref signature as __box_boolean. Only
  // reached on the compatibility-provider path; with native providers
  // `addUnionImports` returns before this block.)
  addImport(ctx, "env", "__box_symbol", {
    kind: "func",
    typeIdx: boxBoolType,
  });

  // __box_bigint: (i64) → externref  (#1644 — boxes a branded-bigint i64 as a
  // JS bigint; JS-BigInt-integration makes the host body identity)
  const boxBigType = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_bigint", { kind: "func", typeIdx: boxBigType });

  // __to_bigint: (externref) → i64  (#1644 — §7.1.13 ToBigInt)
  const toBigType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i64" }]);
  addImport(ctx, "env", "__to_bigint", { kind: "func", typeIdx: toBigType });

  // __bigint_ctor: (externref) → i64  (#1644 Slice B — §21.2.1.1 BigInt(value):
  // ToPrimitive(number) then NumberToBigInt (RangeError) for Number, else
  // ToBigInt (SyntaxError on bad string syntax). Distinct from __to_bigint,
  // which throws TypeError on a Number per §7.1.13.)
  const ctorBigType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i64" }]);
  addImport(ctx, "env", "__bigint_ctor", { kind: "func", typeIdx: ctorBigType });

  // __bigint_ctor_ref: (externref) → externref (#2846 follow-up). The ordinary
  // i64 constructor above remains the arithmetic carrier; this variant keeps
  // arbitrary-width host BigInts exact when the surrounding value is already
  // nullable/dynamic externref (Acorn's `bigint | null` stringToBigInt result).
  const ctorBigRefType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__bigint_ctor_ref", { kind: "func", typeIdx: ctorBigRefType });

  // __typeof: (externref) → externref (returns type string)
  const typeofStrType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__typeof", {
    kind: "func",
    typeIdx: typeofStrType,
  });

  // If imports were added after defined functions were registered (late addition),
  // shift all defined-function indices and fix exports/funcMap/call instructions.
  // The new imports themselves (at indices importsBefore..numImportFuncs-1) are already
  // correct, so we only shift indices that were >= importsBefore BEFORE the addition,
  // i.e., the defined functions that start at index importsBefore in the old scheme.
  const delta = ctx.numImportFuncs - importsBefore;
  if (delta > 0 && ctx.mod.functions.length > 0) {
    // Build a set of the new import names to skip them during funcMap update
    const newImportNames = new Set([
      "__typeof_number",
      "__typeof_string",
      "__typeof_boolean",
      "__typeof_bigint",
      "__typeof_undefined",
      "__typeof_object",
      "__typeof_function",
      "__is_truthy",
      "__unbox_number",
      "__unbox_boolean",
      "__box_number",
      "__box_boolean",
      "__box_symbol",
      "__box_bigint",
      "__to_bigint",
      "__bigint_ctor",
      "__bigint_ctor_ref",
      "__typeof",
    ]);
    // Update funcMap entries for defined functions (not imports)
    for (const [name, idx] of ctx.funcMap) {
      if (!newImportNames.has(name) && inLiveShiftRange(idx, importsBefore)) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    // (#2162) `mapHelpers` (Map/Set/WeakMap/WeakSet helper funcIdx) is NOT a
    // copy of funcMap — its entries are read directly by map-runtime.ts /
    // weak-collections-runtime.ts call sites to bake `call` funcIdx. It must be
    // shifted UNCONDITIONALLY in lockstep with the defined-function shift (the
    // nativeStr/nativeRegex shifts below are gated on the string-helper base and
    // would miss this in plain-Map programs). Leaving it stale let a late import
    // (e.g. `__box_number` for a numeric key/value) land between helper
    // registration and the call, so `wm.has` called `__map_get` → invalid Wasm.
    for (const [name, idx] of ctx.mapHelpers) {
      if (inLiveShiftRange(idx, importsBefore)) {
        ctx.mapHelpers.set(name, idx + delta);
      }
    }
    // Update export indices
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && inLiveShiftRange(exp.desc.index, importsBefore)) {
        exp.desc.index += delta;
      }
    }
    // Track ALL instruction arrays (top-level AND nested) to prevent
    // double-shifting when fctx.body is a nested block reachable from savedBodies (#1109).
    const shifted = new Set<Instr[]>();
    function shiftFuncIndices(instrs: Instr[]): void {
      if (shifted.has(instrs)) return;
      shifted.add(instrs);
      for (const instr of instrs) {
        if ((instr.op === "call" || instr.op === "return_call") && inLiveShiftRange(instr.funcIdx, importsBefore)) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && inLiveShiftRange(instr.funcIdx, importsBefore)) {
          instr.funcIdx += delta;
        }
        const a = instr as any;
        if (a.body && Array.isArray(a.body)) shiftFuncIndices(a.body);
        if (a.then && Array.isArray(a.then)) shiftFuncIndices(a.then);
        if (a.else && Array.isArray(a.else)) shiftFuncIndices(a.else);
        if (a.catches && Array.isArray(a.catches)) {
          for (const c of a.catches) {
            if (Array.isArray(c.body)) shiftFuncIndices(c.body);
          }
        }
        if (a.catchAll && Array.isArray(a.catchAll)) shiftFuncIndices(a.catchAll);
      }
    }
    for (const func of ctx.mod.functions) {
      shiftFuncIndices(func.body);
    }
    if (ctx.currentFunc) {
      shiftFuncIndices(ctx.currentFunc.body);
      for (const sb of ctx.currentFunc.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const parentFctx of ctx.funcStack) {
      shiftFuncIndices(parentFctx.body);
      for (const sb of parentFctx.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const pb of ctx.parentBodiesStack) {
      shiftFuncIndices(pb);
    }
    // (#1384) Walk all live (allocated but not yet attached to mod.functions)
    // FunctionContext bodies — covers cbFctx.body / liftedFctx.body during
    // their captures-extraction + param-coercion setup phases, BEFORE the
    // savedFunc swap puts them on funcStack/parentBodiesStack.
    for (const lb of ctx.liveBodies) {
      shiftFuncIndices(lb);
    }
    if (ctx.pendingInitBody) {
      shiftFuncIndices(ctx.pendingInitBody);
    }
    // Update table elements
    for (const elem of ctx.mod.elements) {
      if (elem.funcIndices) {
        for (let i = 0; i < elem.funcIndices.length; i++) {
          if (inLiveShiftRange(elem.funcIndices[i]!, importsBefore)) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    // Update declaredFuncRefs
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) =>
        inLiveShiftRange(idx, importsBefore) ? idx + delta : idx,
      );
    }
    // Update Wasm start function index (#907) — late-added imports shift the
    // defined-function index that __module_init lives at.
    if (ctx.mod.startFuncIdx !== undefined && inLiveShiftRange(ctx.mod.startFuncIdx, importsBefore)) {
      ctx.mod.startFuncIdx += delta;
    }
    // Sync nativeStrHelpers and re-base so reconcileNativeStrFinalizeShift is a no-op
    // for this import batch — the inline shiftFuncIndices above already corrected all
    // native-string helper bodies. Without this, reconcile double-shifts them (#1677-fast-path).
    if (ctx.nativeStrHelperImportBase >= 0) {
      for (const [name, idx] of ctx.nativeStrHelpers) {
        if (inLiveShiftRange(idx, importsBefore)) ctx.nativeStrHelpers.set(name, idx + delta);
      }
      // (#1913) Regex helper map shares the same lifecycle.
      for (const [name, idx] of ctx.nativeRegexHelpers) {
        if (inLiveShiftRange(idx, importsBefore)) ctx.nativeRegexHelpers.set(name, idx + delta);
      }
      ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
    }
    // (#1525b) Shift pendingMethodTrampolines side-channel indices in lockstep.
    // The captured methodFuncIdx / trampolineFuncIdx are plain numbers not
    // reachable from any Instr — without this, finalizeMethodTrampolines later
    // resolves the wrong (import) signature, producing invalid Wasm.
    for (const t of ctx.pendingMethodTrampolines) {
      if (inLiveShiftRange(t.methodFuncIdx, importsBefore)) t.methodFuncIdx += delta;
      if (inLiveShiftRange(t.trampolineFuncIdx, importsBefore)) t.trampolineFuncIdx += delta;
    }
    // (#2918) Async-scheduler + Promise.all/race combinator side-channel funcIdxs
    // move in lockstep too (addUnionImports missed them). Same complete key list
    // as shiftLateImportIndices / addStringImports.
    shiftAsyncSideChannelFuncIdxs(ctx, importsBefore, delta);
  }
}

/**
 * Wasm-native implementation of the union helper functions (#1180).
 *
 * Used under `--target wasi`, where the standard `env::*` host imports
 * cannot be satisfied by wasmtime. Instead of importing the helpers, we
 * register a small set of WasmGC struct types (`__box_number_struct`,
 * `__box_boolean_struct`) plus a synthesized function for each helper
 * with the SAME name and signature as the host-mode import. Existing
 * call sites that look helpers up via `ctx.funcMap.get("__unbox_number")`
 * etc. transparently call the native version.
 *
 * Semantics mirror the JS host runtime where possible:
 *   - `__box_number(f64)` wraps the value in a `__box_number_struct` and
 *     converts to externref via `extern.convert_any`.
 *   - `__unbox_number(externref)` returns 0 for null (matches `Number(null)`),
 *     extracts the value if the externref is a `__box_number_struct`,
 *     otherwise returns `NaN` (matches `Number(opaque host value)`).
 *   - `__box_boolean(i32)` / `__unbox_boolean(externref)` mirror the
 *     number variants with an `i32` payload.
 *   - `__is_truthy(externref)` returns 0 for null and for boxed-zero /
 *     boxed-NaN / boxed-false; returns 1 for any other ref (any non-null
 *     reference is truthy in JS).
 *   - `__typeof_number/string/boolean(externref)` use `ref.test` against
 *     the appropriate boxed struct (string under wasi/nativeStrings is
 *     the NativeString struct at `ctx.anyStrTypeIdx`).
 *   - `__typeof_undefined(externref)` is `ref.is_null`.
 *   - `__typeof_object/function(externref)` are conservatively 0 — wasi
 *     binaries don't have a JS-side function or generic object value to
 *     surface here.
 *   - `__typeof(externref)` returns null externref. Producing a real
 *     type-tag string under nativeStrings would require constructing a
 *     NativeString per tag, which is deferred until a wasi caller
 *     actually needs the result of `typeof v` as a string. Today's
 *     callers either pre-fold the typeof at the AST level or compare
 *     against a string literal (which uses `__typeof_*` instead).
 *
 * Why a struct-based box rather than letting the externref carry a raw
 * f64: externref is opaque at the Wasm level — there's no way to read a
 * payload back out without going through the WasmGC any.* / ref.cast
 * machinery against a registered struct type. The struct gives us a
 * stable shape the unbox helper can pattern-match against, and the
 * `extern.convert_any` / `any.convert_extern` round-trip is a no-op at
 * the Wasm engine level.
 */
export function addUnionImportsAsNativeFuncs(ctx: CodegenContext): void {
  // #1807: settle any pending native-string finalize shift BEFORE registering
  // the union helpers. `reconcileNativeStrFinalizeShift` applies a SINGLE
  // uniform `(numImportFuncs - base)` delta to every defined function with a
  // baked `call funcIdx >= base`. That uniform model is only correct when all
  // those defined functions were registered at the SAME import count (`base`).
  //
  // The native-string helpers snapshot `base = numImportFuncs` at their first
  // emission (often `numImportFuncs == 0`, before any host import). If another
  // import is then added (e.g. `__make_callback`, or the generator-bridge
  // imports) BEFORE this union-helper block runs, the union helpers are
  // registered at a HIGHER import count — their `numImportFuncs + arrayPos`
  // indices already bake in those intervening imports. The end-of-finalize
  // reconcile would then over-shift them by exactly `(numImportFuncs_now -
  // base)`, pushing every `__typeof_*` / `__unbox_*` call target in callers
  // like the test262 `isSameValue` harness helper +N too high. After dead-import
  // elimination compacts the index space that surfaces as
  // `isSameValue ... call[0] expected type i32, found local.get of type
  // externref` — a stale call into an adjacent boxing helper (277 standalone
  // async-generator tests).
  //
  // Flushing here advances `base` to the current `numImportFuncs`, so the
  // already-registered native-string helpers absorb the intervening imports now
  // and the union helpers register at the SAME (re-based) `base`. The final
  // reconcile then applies one consistent delta to BOTH groups. No-op on the
  // default GC path (base stays -1) and when no import drifted the count.
  if (ctx.nativeStrHelperImportBase >= 0 && ctx.numImportFuncs > ctx.nativeStrHelperImportBase) {
    reconcileNativeStrFinalizeShift(ctx);
  }

  // 1. Register the boxed-value struct types. Both are immutable singletons.
  const boxNumStructIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__box_number_struct",
    fields: [{ name: "value", type: { kind: "f64" }, mutable: false }],
  });

  const boxBoolStructIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__box_boolean_struct",
    fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
  });

  const bigIntStructIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$BigInt",
    fields: [{ name: "value", type: { kind: "i64", bigint: true }, mutable: false }],
  });
  ctx.nativeBoxNumberTypeIdx = boxNumStructIdx;
  ctx.nativeBoxBooleanTypeIdx = boxBoolStructIdx;
  ctx.nativeBigIntTypeIdx = bigIntStructIdx;

  // 2. Pre-compute func types — addFuncType de-dupes by signature so
  //    repeated calls return the same typeIdx.
  const externrefToI32 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  const externrefToF64 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
  const externrefToI64 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i64", bigint: true }]);
  const f64ToExternref = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
  const i32ToExternref = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "externref" }]);
  const i64ToExternref = addFuncType(ctx, [{ kind: "i64", bigint: true }], [{ kind: "externref" }]);
  const externrefToExternref = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);

  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && !ctx.funcMap.has("__str_to_number")) {
    emitNativeParseNumber(ctx, new Set(["__str_to_number"]));
  }
  const strToNumberIdx = ctx.funcMap.get("__str_to_number");

  // (#2106 S1) `undefinedSingleton` regime support for the union natives:
  // when active, `undefined` is a non-null extern-wrapped tag-1 `$AnyValue`
  // (never `ref.null.extern`), so ToBoolean must classify it FALSY, the
  // typeof cluster must answer "undefined" for the singleton and "object"
  // for null, and `__typeof_undefined` flips off bare `ref.is_null`.
  // Inactive (default): every body below is byte-identical to legacy.
  const s1Active = undefinedSingletonActive(ctx);
  if (s1Active) ensureAnyValueType(ctx);
  const s1AnyValIdx = s1Active ? ctx.anyValueTypeIdx : -1;

  /**
   * Synthesize a native helper function. The funcIdx is allocated as
   * `numImportFuncs + mod.functions.length` to match how every other
   * synthesized function (e.g. `__toUint32` from #1094) gets its slot.
   */
  const registerNative = (
    name: string,
    typeIdx: number,
    body: Instr[],
    locals: { name: string; type: ValType }[] = [],
  ): void => {
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set(name, funcIdx);
    ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false });
  };

  const throwNativeError = (errorName: "TypeError" | "RangeError" | "SyntaxError", message: string): Instr[] => {
    emitWasiErrorConstructor(ctx, errorName, 1);
    addStringConstantGlobal(ctx, message);
    const ctorIdx = ctx.funcMap.get(`__new_${errorName}`)!;
    const tagIdx = ensureExnTag(ctx);
    return [...stringConstantExternrefInstrs(ctx, message), { op: "call", funcIdx: ctorIdx }, { op: "throw", tagIdx }];
  };

  // 3. __box_number(f64) -> externref
  // (#3673) i31 fast path: an integral value in the signed-31-bit range is
  // encoded as an UNBOXED `(ref i31)` — no allocation. Every consumer that
  // discriminates boxed numbers carries a matching i31 arm. Excluded: -0
  // (i31 cannot carry the sign — `1/x` and Object.is would lose it), NaN and
  // infinities (fail the trunc round-trip), and values outside [-2^30, 2^30-1]
  // (fail the shl/shr round-trip).
  registerNative(
    "__box_number",
    f64ToExternref,
    [
      { op: "local.get", index: 0 },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.tee", index: 1 },
      { op: "f64.convert_i32_s" },
      { op: "local.get", index: 0 },
      { op: "f64.eq" }, // integral (and clamp-free) round-trip
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 1 },
      { op: "i32.shl" },
      { op: "i32.const", value: 1 },
      { op: "i32.shr_s" },
      { op: "local.get", index: 1 },
      { op: "i32.eq" }, // fits signed 31 bits
      { op: "i32.and" },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "local.get", index: 0 },
      { op: "i64.reinterpret_f64" },
      { op: "i64.const", value: 0n },
      { op: "i64.lt_s" },
      { op: "i32.eqz" },
      { op: "i32.or" }, // t != 0 || sign bit clear (rejects -0 only)
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [{ op: "local.get", index: 1 }, { op: "ref.i31" }, { op: "extern.convert_any" }],
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.new", typeIdx: boxNumStructIdx },
          { op: "extern.convert_any" },
        ],
      },
    ],
    [{ name: "$i31_temp", type: { kind: "i32" } as ValType }],
  );

  // 4. __unbox_number(externref) -> f64
  //    Local 1 is an anyref temp used to ref.test then ref.cast without
  //    re-evaluating the parameter (which is fine — it's a local.get —
  //    but the temp shape mirrors the spec'd structure for symmetry).
  registerNative(
    "__unbox_number",
    externrefToF64,
    [
      // if (ref.is_null param) return 0   // Number(null) === 0
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "f64.const", value: 0 }, { op: "return" }],
      },
      // any = any.convert_extern(param)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      // (#3673) i31-boxed small int → its value.
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: -20 },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: -20 },
          { op: "i31.get_s" },
          { op: "f64.convert_i32_s" },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 1 },
      // if (ref.test $box_number_struct any) return any.value
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxNumStructIdx },
          { op: "struct.get", typeIdx: boxNumStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      // #1910 R3 — a boxed boolean (the [[BooleanData]] slot of a
      // `new Boolean(x)` wrapper, recovered by `__to_primitive`) coerces per
      // §7.1.4 ToNumber(true)=1, ToNumber(false)=0. Without this arm a boxed
      // boolean fell through to the opaque-ref NaN fallback, so
      // `Number(new Boolean(true))` returned NaN instead of 1.
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "f64.convert_i32_s" },
          { op: "return" },
        ],
      },
      ...(strToNumberIdx !== undefined && ctx.anyStrTypeIdx >= 0
        ? ([
            // StringToNumber (§7.1.4.1): object ToPrimitive can yield a native
            // string; parse it with the existing pure-Wasm scanner before the
            // opaque-ref NaN fallback.
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: strToNumberIdx }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      // not a recognized boxed number → NaN (matches Number(opaque))
      { op: "f64.const", value: NaN },
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // 5. __box_boolean(i32) -> externref — interned carriers (#3780).
  registerNative("__box_boolean", i32ToExternref, boxBooleanBody(ctx, boxBoolStructIdx));

  // #1644 Slice E1 — __box_bigint(i64) -> externref. In no-JS-host mode a
  // bigint-branded i64 needs a WasmGC carrier so it cannot fall through to the
  // number-box path and lose its BigInt identity at the externref frontier.
  registerNative("__box_bigint", i64ToExternref, [
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: bigIntStructIdx },
    { op: "extern.convert_any" },
  ]);

  // 6. __unbox_boolean(externref) -> i32
  //    Returns the boxed value if it's a __box_boolean_struct, otherwise
  //    falls back to Boolean-coercion: null → false, any non-null ref
  //    that isn't a boxed bool → ALSO false (under wasi we don't
  //    distinguish other truthy refs at the unbox level; the runtime
  //    fallback in `helpers.ts` does `v ? 1 : 0` which would say true,
  //    but for unbox-as-typed-call-arg the safe default is false).
  //    Boxed numbers go through __unbox_number first, then truthy-check.
  registerNative(
    "__unbox_boolean",
    externrefToI32,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      // not a boxed bool → false (conservative under wasi)
      { op: "i32.const", value: 0 },
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // #1644 Slice E1 — __to_bigint(externref) -> i64. This is the native
  // ToBigInt frontier for values already represented by the standalone
  // BigInt struct, plus boolean -> 0n/1n. Boxed numbers throw TypeError per
  // ECMA-262 §7.1.13; native string parsing is deferred to the constructor
  // slice, so unsupported non-BigInt refs also throw instead of becoming 0.
  registerNative(
    "__to_bigint",
    externrefToI64,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: throwNativeError("TypeError", "Cannot convert null or undefined to a BigInt"),
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: bigIntStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: bigIntStructIdx },
          { op: "struct.get", typeIdx: bigIntStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "i64.extend_i32_u" },
          { op: "return" },
        ],
      },
      ...throwNativeError("TypeError", "Cannot convert value to a BigInt"),
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // #1644 Slice E1/E2 bridge — minimal no-JS-host BigInt(value). Handles the
  // standalone carriers that can be represented without a string parser:
  // bigint identity, boolean -> 0n/1n, and integral finite boxed numbers.
  registerNative(
    "__bigint_ctor",
    externrefToI64,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: throwNativeError("TypeError", "Cannot convert null or undefined to a BigInt"),
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: bigIntStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: bigIntStructIdx },
          { op: "struct.get", typeIdx: bigIntStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "i64.extend_i32_u" },
          { op: "return" },
        ],
      },
      // (#3673) i31 small int → i64.
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: -20 },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: -20 },
          { op: "i31.get_s" },
          { op: "i64.extend_i32_s" },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxNumStructIdx },
          { op: "struct.get", typeIdx: boxNumStructIdx, fieldIdx: 0 },
          { op: "local.tee", index: 2 },
          { op: "local.get", index: 2 },
          { op: "f64.ne" },
          { op: "local.get", index: 2 },
          { op: "f64.floor" },
          { op: "local.get", index: 2 },
          { op: "f64.ne" },
          { op: "i32.or" },
          { op: "local.get", index: 2 },
          { op: "f64.const", value: 2 ** 63 },
          { op: "f64.ge" },
          { op: "i32.or" },
          { op: "local.get", index: 2 },
          { op: "f64.const", value: -(2 ** 63) },
          { op: "f64.lt" },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: throwNativeError(
              "RangeError",
              "The number cannot be converted to a BigInt because it is not an integer",
            ),
          },
          { op: "local.get", index: 2 },
          { op: "i64.trunc_sat_f64_s" },
          { op: "return" },
        ],
      },
      ...throwNativeError("SyntaxError", "Cannot convert string to a BigInt in standalone mode"),
    ],
    [
      { name: "$any_temp", type: { kind: "anyref" } as ValType },
      { name: "$num_temp", type: { kind: "f64" } },
    ],
  );

  // 7. __is_truthy(externref) -> i32
  //    null → 0; boxed number → value !== 0 && !NaN; boxed bool → value;
  //    anything else (other refs) → 1 (any non-null ref is truthy in JS).
  registerNative(
    "__is_truthy",
    externrefToI32,
    [
      // if (ref.is_null param) return 0
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // (#2106 S1) `$AnyValue` box: tag 0 (null) / 1 (undefined) → FALSY
      // (§7.1.2); other wrapped tags (5 string / 6 object) keep the non-null-
      // ref default (truthy). Without this arm the non-null `$undefined`
      // singleton would be truthy — `if (undefined)` taking the then-branch.
      // (#4173, flag-gated) The legacy body internalized the operand TWICE
      // (once for this arm, once for the ladder below); with `fastStrictEq`
      // on, convert once and let the teed value feed whichever test is next.
      ...(s1AnyValIdx >= 0
        ? ([
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: 1 },
            { op: "ref.test", typeIdx: s1AnyValIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: s1AnyValIdx },
                { op: "struct.get", typeIdx: s1AnyValIdx, fieldIdx: 0 },
                { op: "i32.const", value: 1 },
                { op: "i32.gt_u" },
                { op: "return" },
              ],
            },
          ] satisfies Instr[])
        : []),
      // any = any.convert_extern(param) — skipped under fastStrictEq when the
      // $AnyValue arm above already converted (local 1 holds the anyref).
      ...((ctx.fastStrictEq === true && s1AnyValIdx >= 0
        ? [{ op: "local.get", index: 1 }]
        : [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: 1 },
          ]) satisfies Instr[]),
      // (#3673) i31 small int → value !== 0 (no NaN possible in i31).
      { op: "ref.test", typeIdx: -20 },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: -20 },
          { op: "i31.get_s" },
          { op: "i32.const", value: 0 },
          { op: "i32.ne" },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 1 },
      // boxed number? → value !== 0 && value === value
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxNumStructIdx },
          { op: "struct.get", typeIdx: boxNumStructIdx, fieldIdx: 0 },
          { op: "local.tee", index: 2 },
          // value !== 0
          { op: "f64.const", value: 0 },
          { op: "f64.ne" },
          { op: "local.get", index: 2 },
          // value === value (NaN check — NaN !== NaN)
          { op: "local.get", index: 2 },
          { op: "f64.eq" },
          { op: "i32.and" },
          { op: "return" },
        ],
      },
      // boxed bool? → value
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      // boxed bigint? → value !== 0n
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: bigIntStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: bigIntStructIdx },
          { op: "struct.get", typeIdx: bigIntStructIdx, fieldIdx: 0 },
          { op: "i64.eqz" },
          { op: "i32.eqz" },
          { op: "return" },
        ],
      },
      // (#2080) native string? → length !== 0 (ToBoolean §7.1.2: "" → false).
      // In standalone/nativeStrings mode an `any`-held string is a $AnyString
      // (the supertype of $NativeString / $ConsString, all carrying $len at
      // field 0) wrapped as externref — NOT a $AnyValue box. Without this arm
      // it falls through to the "any non-null ref → truthy" default, so the
      // empty string is wrongly truthy. Guarded on anyStrTypeIdx so the GC /
      // host-string path (no native-string type registered) is unaffected.
      ...(ctx.anyStrTypeIdx >= 0
        ? ([
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
                { op: "i32.const", value: 0 },
                { op: "i32.ne" },
                { op: "return" },
              ],
            },
          ] satisfies Instr[])
        : []),
      // any other non-null ref → truthy
      { op: "i32.const", value: 1 },
    ],
    [
      { name: "$any_temp", type: { kind: "anyref" } as ValType },
      { name: "$f64_temp", type: { kind: "f64" } },
    ],
  );

  // 8. __typeof_number(externref) -> i32 — `ref.test $box_number_struct`.
  registerNative("__typeof_number", externrefToI32, [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: boxNumStructIdx },
    // (#3673) …or an i31-boxed small int.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: -20 },
    { op: "i32.or" },
  ]);

  // 9. __typeof_boolean(externref) -> i32 — `ref.test $box_boolean_struct`.
  registerNative("__typeof_boolean", externrefToI32, [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: boxBoolStructIdx },
  ]);

  // 10. __typeof_bigint(externref) -> i32 — `ref.test $BigInt`.
  registerNative("__typeof_bigint", externrefToI32, [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: bigIntStructIdx },
  ]);

  // 11. __typeof_string(externref) -> i32. Under nativeStrings (auto-on
  //     for wasi) strings are NativeString structs at `ctx.anyStrTypeIdx`.
  //     If that type isn't registered, return 0 (no string in scope).
  if (ctx.anyStrTypeIdx >= 0) {
    const strTypeIdx = ctx.anyStrTypeIdx;
    registerNative("__typeof_string", externrefToI32, [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: strTypeIdx },
    ]);
  } else {
    registerNative("__typeof_string", externrefToI32, [{ op: "i32.const", value: 0 }]);
  }

  // 12. __typeof_undefined(externref) -> i32 — `ref.is_null` (legacy: null and
  //     undefined share the null-extern bit pattern). (#2106 S1) Under the
  //     `undefinedSingleton` regime: tag-1 `$AnyValue` ∨ UNDEF_F64 box; a null
  //     externref answers 0 (typeof null is "object", not "undefined").
  {
    const s1Body = s1Active ? buildIsUndefinedExternBody(ctx, 1, UNDEF_F64_BITS) : undefined;
    registerNative(
      "__typeof_undefined",
      externrefToI32,
      s1Body ?? [{ op: "local.get", index: 0 }, { op: "ref.is_null" }],
      s1Body !== undefined ? [{ name: "$any_temp", type: { kind: "anyref" } as ValType }] : [],
    );
  }

  // 13. __typeof_object(externref) -> i32 — non-null AND not number AND
  //     not boolean AND not bigint AND not function. We approximate as "non-null and
  //     not a boxed primitive" — sufficient for the common typeof
  //     dispatch use cases. Returns 0 conservatively for boxed numbers
  //     and boxed booleans.
  registerNative(
    "__typeof_object",
    externrefToI32,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        // (#2106 S1) typeof null IS "object" (§13.5.3) — under the singleton
        // regime a null externref means JS null, so answer 1. Legacy: null
        // means null-or-undefined; keep the historical 0.
        then: [{ op: "i32.const", value: s1Active ? 1 : 0 }, { op: "return" }],
      },
      // (#2106 S1) the tag-1 `$undefined` singleton is NOT an object.
      ...(s1AnyValIdx >= 0
        ? ([
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: 1 },
            { op: "ref.test", typeIdx: s1AnyValIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: s1AnyValIdx },
                { op: "struct.get", typeIdx: s1AnyValIdx, fieldIdx: 0 },
                { op: "i32.const", value: 1 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                },
              ],
            },
          ] satisfies Instr[])
        : []),
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // (#3673) i31 small int is a number → not this type.
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: -20 },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: bigIntStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // (#2107) native string ($AnyString) → "string", NOT "object". Under
      // nativeStrings/standalone a string value is a `$AnyString` GC struct
      // carried as externref; without this guard `typeof (s: any) === "object"`
      // wrongly held and `=== "string"` was the only true arm via the separate
      // __typeof_string helper, so both string-tagged comparisons disagreed.
      ...(ctx.anyStrTypeIdx >= 0
        ? ([
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 0 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      // non-null, not a boxed primitive → object
      { op: "i32.const", value: 1 },
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // 14. __typeof_function(externref) -> i32 — wasi binaries don't expose
  //     callable JS functions to the outside, so this is conservatively 0.
  registerNative("__typeof_function", externrefToI32, [{ op: "i32.const", value: 0 }]);

  // 15. __typeof(externref) -> externref — the MATERIALIZED typeof result.
  //     (#2965) This was a `ref.null.extern` stub ("defer until a wasi caller
  //     needs the typeof RESULT as a string"), which silently broke every
  //     standalone site where the typeof string is a VALUE rather than an
  //     inline `typeof x === "…"` compare: `var t = typeof x`,
  //     `assert_sameValue_str(typeof(o.p), "undefined")` (the test262 runner's
  //     paren-form transform miss), any typeof flowing through a param. The
  //     result was a null externref, so `t === "undefined"` was false for
  //     EVERY tag and `t.length` trapped. Classify with the same dispatch the
  //     `__typeof_*` predicates above use (null → "undefined", box_number →
  //     "number", box_boolean → "boolean", $BigInt → "bigint", $AnyString →
  //     "string", else → "object"). (#2175 V2-S1) A closure/function value read
  //     back here would otherwise fall through to "object";
  //     `fillStandaloneTypeofClosureArms` splices a closure `ref.test` →
  //     "function" arm before the terminal at finalize (closures aren't all
  //     registered yet at this registration point), so the materialized result
  //     agrees with the `__typeof_function` predicate. The tag is returned as
  //     an inline NativeString (sentinel-safe, no funcidx baked — the #2515
  //     discipline; string literals here are type-index-only instructions, so
  //     the late-import finalize shift cannot desync this body). Falls back to
  //     the old stub only when no native-string type is registered (then no
  //     string content could be represented anyway).
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const typeofTagArm = (test: Instr[], tag: string): Instr[] => [
      ...test,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...stringConstantExternrefInstrs(ctx, tag), { op: "return" }],
      },
    ];
    registerNative(
      "__typeof",
      externrefToExternref,
      [
        // null externref → undefined (matches __typeof_undefined = ref.is_null).
        // (#2106 S1) Under the singleton regime null means JS null → "object"
        // (§13.5.3), and the tag-1/UNDEF-box arm below answers "undefined".
        ...typeofTagArm([{ op: "local.get", index: 0 }, { op: "ref.is_null" }], s1Active ? "object" : "undefined"),
        ...(s1Active
          ? (() => {
              const test = buildIsUndefinedExternBody(ctx, 1, UNDEF_F64_BITS);
              return test !== undefined ? typeofTagArm(test, "undefined") : [];
            })()
          : []),
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 1 },
        ...typeofTagArm(
          [
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: boxNumStructIdx },
            // (#3673) …or an i31-boxed small int.
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: -20 },
            { op: "i32.or" },
          ],
          "number",
        ),
        ...typeofTagArm(
          [
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: boxBoolStructIdx },
          ],
          "boolean",
        ),
        ...typeofTagArm(
          [
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: bigIntStructIdx },
          ],
          "bigint",
        ),
        ...(ctx.anyStrTypeIdx >= 0
          ? typeofTagArm(
              [
                { op: "local.get", index: 1 },
                { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
              ],
              "string",
            )
          : []),
        // non-null, not a boxed primitive, not a string → object
        ...stringConstantExternrefInstrs(ctx, "object"),
      ],
      [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
    );
  } else {
    registerNative("__typeof", externrefToExternref, [{ op: "ref.null.extern" }]);
  }

  // #2508 — native `__host_eq` (Strict Equality, §7.2.16) and
  // `__same_value_zero` (SameValueZero, §7.2.11) over two boxed externrefs, so
  // standalone `any[].indexOf/lastIndexOf/includes` need no JS host import. Tag
  // dispatch mirrors the inline `===` lowering (#1776, binary-ops.ts): both
  // number → unbox f64 & compare; both boolean → unbox i32; both bigint →
  // i64; else reference identity on the WasmGC `eq` heap type. The ONLY
  // difference between Strict and SameValueZero is the number arm's NaN case:
  // Strict has NaN ≠ NaN (`f64.eq`), SameValueZero has NaN = NaN. Both treat
  // +0 = -0 as equal, which `f64.eq` already gives.
  {
    const externref2ToI32 = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
    const typeofBoolIdx = ctx.funcMap.get("__typeof_boolean")!;
    const typeofBigIdx = ctx.funcMap.get("__typeof_bigint")!;
    const unboxNumIdx = ctx.funcMap.get("__unbox_number")!;
    const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean")!;
    const toBigIdx = ctx.funcMap.get("__to_bigint")!;
    const EQ_HEAP = -19; // WasmGC `eq` abstract heap type

    // params: l=0, r=1 ; locals: la=2 (anyref), ra=3 (anyref)
    const bothTag = (tagIdx: number): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: tagIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: tagIdx },
      { op: "i32.and" },
    ];
    // Reference-identity arm (else): both refs convert to anyref (locals 2/3);
    // if both are eq heap refs, ref.eq; otherwise unequal.
    const refIdentityArm: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: EQ_HEAP },
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: EQ_HEAP },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: EQ_HEAP },
          { op: "local.get", index: 3 },
          { op: "ref.cast", typeIdx: EQ_HEAP },
          { op: "ref.eq" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];
    // String VALUE equality is NOT inlined here. A boxed-any STRING element
    // compares by content (`["x"].indexOf("x")` must match), which needs a
    // `__str_flatten`+`__str_equals` call. But those helpers live in the
    // native-string regime BELOW the union-helper base, and any call to them
    // baked into THIS union-helper body drifts under the late-import finalize
    // shift (`reconcileNativeStrFinalizeShift` re-bases every `call funcIdx >=
    // base`), landing on the wrong function — the encoder then patches the stack
    // with `extern.convert_any; …; drop`, which the GC validator accepts but
    // wasm-opt rejects ("popping from empty stack", surfaced as the
    // native-messaging-smoke CI failure). Rather than fight the cross-regime
    // index shift, the string arm falls back to `eq`-heap ref identity here:
    // VALID Wasm, correct for interned/same-ref strings. String-element `any[]`
    // search-by-VALUE is a tracked #2508 follow-up that belongs in a
    // `__any_str_value_eq` helper registered in the native-string regime.
    const stringOrIdentityArm: Instr[] = refIdentityArm;
    // Materialise the anyref temps (locals 2/3) once, then dispatch string/ref.
    const identityArm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 3 },
      ...stringOrIdentityArm,
    ];
    const bigintArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofBigIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: toBigIdx },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: toBigIdx },
          { op: "i64.eq" },
        ],
        else: elseArm,
      },
    ];
    const boolArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofBoolIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: unboxBoolIdx },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: unboxBoolIdx },
          { op: "i32.eq" },
        ],
        else: elseArm,
      },
    ];
    // numberArm: sameValueZero=true adds a NaN==NaN recovery (a!=a && b!=b).
    const numberArm = (sameValueZero: boolean, elseArm: Instr[]): Instr[] => {
      const cmp: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: unboxNumIdx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: unboxNumIdx },
      ];
      if (!sameValueZero) {
        cmp.push({ op: "f64.eq" });
      } else {
        // (la == ra) || (la != la && ra != ra)   [NaN === NaN under SVZ]
        // Stack has la, ra. Tee both into anyref-free f64 temps via locals 4/5.
        cmp.length = 0;
        cmp.push(
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: unboxNumIdx },
          { op: "local.set", index: 4 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: unboxNumIdx },
          { op: "local.set", index: 5 },
          // la == ra
          { op: "local.get", index: 4 },
          { op: "local.get", index: 5 },
          { op: "f64.eq" },
          // || (la!=la && ra!=ra)
          { op: "local.get", index: 4 },
          { op: "local.get", index: 4 },
          { op: "f64.ne" },
          { op: "local.get", index: 5 },
          { op: "local.get", index: 5 },
          { op: "f64.ne" },
          { op: "i32.and" },
          { op: "i32.or" },
        );
      }
      return [
        ...bothTag(typeofNumIdx),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: cmp,
          else: elseArm,
        },
      ];
    };

    // __host_eq: Strict Equality. null === null (both ref.null extern) → the
    // identity arm's ref.test EQ fails for null (ref.null isn't an eq ref), so
    // handle the both-null case up front: ref.is_null l && ref.is_null r → 1.
    const nullArm = (rest: Instr[]): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: rest,
      },
    ];

    const eqLocals = [
      { name: "la", type: { kind: "anyref" } as ValType },
      { name: "ra", type: { kind: "anyref" } as ValType },
      { name: "fa", type: { kind: "f64" } as ValType },
      { name: "fb", type: { kind: "f64" } as ValType },
    ];

    registerNative("__host_eq", externref2ToI32, nullArm(numberArm(false, boolArm(bigintArm(identityArm)))), eqLocals);
    registerNative(
      "__same_value_zero",
      externref2ToI32,
      nullArm(numberArm(true, boolArm(bigintArm(identityArm)))),
      eqLocals,
    );
  }
}

/** Register the iterator protocol host imports if not already registered */
export function addIteratorImports(ctx: CodegenContext): void {
  // Guard: only register once
  if (ctx.funcMap.has("__iterator")) return;

  // (#2689) Add via the late-import batch (`ensureLateImport`) + an IMMEDIATE
  // `flushLateImportShifts`. This helper has TWO call contexts: the EARLY
  // collect-finalize (declarations.ts, before any function is registered) and
  // the LATE lazy fallback (compileForOfStatement, after functions already
  // baked `call`/`return_call` funcIdx values). Raw `addImport` bumps
  // `numImportFuncs` WITHOUT shifting already-baked defined-function indices, so
  // the LATE context silently desynced every earlier function's funcIdx — the
  // ESLint `SourceCode_new` tail call ended up pointing at `__iterator_next`
  // ("return_call: tail call type error"). The flushed batch shift fixes the
  // late context AND is a clean no-op early (no functions to shift, and the
  // immediate flush leaves NO lingering pending shift that would later
  // over-shift functions registered after these imports).
  const ER: ValType = { kind: "externref" };
  // __iterator: (externref) → externref — calls obj[Symbol.iterator]()
  ensureLateImport(ctx, "__iterator", [ER], [ER]);
  // __iterator_next: (externref) → (i32 done, externref value) — calls iter.next()
  // Multi-value result avoids the $IteratorResult struct: a freshly-built WasmGC
  // struct cannot survive the JS import hop (it surfaces as undefined in V8/Node;
  // see #1620 BLOCKED). The two primitives (i32 + externref) cross the JS↔Wasm
  // multi-value ABI cleanly, eliminating __iterator_done / __iterator_value.
  ensureLateImport(ctx, "__iterator_next", [ER], [{ kind: "i32" }, ER]);
  // __iterator_return: (externref) → void — calls iter.return() if it exists
  ensureLateImport(ctx, "__iterator_return", [ER], []);
  // __iterator_rest: (externref) → externref — drains a partially-consumed
  // iterator into a real JS Array for the `[...rest]` binding pattern (#1052).
  ensureLateImport(ctx, "__iterator_rest", [ER], [ER]);
  // Apply the batch's index shift NOW so a late call repairs already-baked
  // funcIdx immediately and no deferred shift lingers (the #2689 fix).
  flushLateImportShifts(ctx, ctx.currentFunc);
}

/** Register array iterator host imports (entries/keys/values) if not already registered */
export function addArrayIteratorImports(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__array_entries")) return;

  // (#2689) Batch + immediate flush — see addIteratorImports for the rationale.
  // Lazily called during body compilation (array-methods.ts), raw addImport
  // would desync already-baked defined-function funcIdx values.
  const ER: ValType = { kind: "externref" };
  // All three: (externref) → externref — take a vec struct, return a JS iterator
  ensureLateImport(ctx, "__array_entries", [ER], [ER]);
  ensureLateImport(ctx, "__array_keys", [ER], [ER]);
  ensureLateImport(ctx, "__array_values", [ER], [ER]);
  flushLateImportShifts(ctx, ctx.currentFunc);
}

/**
 * Register the generator host imports if not already registered.
 *
 * The legacy generator codegen (eager-buffer model) uses these imports to
 * push yielded values into a JS array on the host side, then wrap that
 * buffer with `__create_generator` (or `__create_async_generator`) to
 * produce a Generator-like / AsyncGenerator-like object. The IR path
 * (slice 7 — #1169f) reuses the same set of imports — extracting this
 * registration out of `declarations.ts:1014-1062` into a standalone
 * exported helper so both legacy and IR can call it without duplicating
 * the import-shape declarations.
 *
 * Imports registered (all under `env`):
 *   - `__gen_create_buffer`   () → externref
 *   - `__gen_push_f64`        (externref, f64) → ()
 *   - `__gen_push_i32`        (externref, i32) → ()
 *   - `__gen_push_ref`        (externref, externref) → ()
 *   - `__gen_yield_star`      (externref, externref) → ()  (same shape as push_ref)
 *   - `__create_generator`    (externref, externref) → externref  (buf, pendingThrow)
 *   - `__create_async_generator` (externref, externref) → externref  (same shape)
 *   - `__gen_next`            (externref) → externref
 *   - `__gen_return`          (externref, externref) → externref
 *   - `__gen_throw`           (externref, externref) → externref
 *   - `__gen_result_value`    (externref) → externref
 *   - `__gen_result_value_f64` (externref) → f64
 *   - `__gen_result_done`     (externref) → i32
 *   - `__get_caught_exception` () → externref  (for the body's try/catch wrapper)
 */
export function addGeneratorImports(ctx: CodegenContext, options?: { allowNoJsHost?: boolean }): void {
  if ((ctx.standalone || ctx.wasi) && !options?.allowNoJsHost) return;
  // Guard: only register once
  if (ctx.funcMap.has("__gen_create_buffer")) return;

  // (#2689) Batch + immediate flush — see addIteratorImports for the rationale.
  // Can be registered lazily (IR-path generator claim / body compilation) after
  // other functions baked their funcIdx; raw addImport would desync them. The
  // `__gen_*` / `__create_*` / `__get_caught_exception` names are not in any
  // standalone-refusal / native-helper set, so the `allowNoJsHost` fallback
  // behaves exactly as the previous raw additions did.
  const ER: ValType = { kind: "externref" };
  ensureLateImport(ctx, "__gen_create_buffer", [], [ER]);
  ensureLateImport(ctx, "__gen_push_f64", [ER, { kind: "f64" }], []);
  ensureLateImport(ctx, "__gen_push_i32", [ER, { kind: "i32" }], []);
  ensureLateImport(ctx, "__gen_push_ref", [ER, ER], []);
  // __gen_yield_star: (externref, externref) → void  (iterates inner iterable, pushes all values into outer buffer)
  ensureLateImport(ctx, "__gen_yield_star", [ER, ER], []);
  // __gen_set_return: (externref, externref) → void  (#2035 — stashes the
  // generator's `return` value on the buffer instead of pushing it as a yield)
  ensureLateImport(ctx, "__gen_set_return", [ER, ER], []);
  // __create_generator: (buf: externref, pendingThrow: externref) -> externref
  // Takes a buffer of yielded values and an optional pending exception,
  // returns a Generator-like object that defers the throw to the first next() call.
  ensureLateImport(ctx, "__create_generator", [ER, ER], [ER]);
  // __create_async_generator: same Wasm signature as __create_generator, but .next()/.return()/.throw()
  // return Promise-wrapped results as required by the ES spec for async generators.
  ensureLateImport(ctx, "__create_async_generator", [ER, ER], [ER]);
  ensureLateImport(ctx, "__gen_next", [ER], [ER]);
  ensureLateImport(ctx, "__gen_return", [ER, ER], [ER]);
  ensureLateImport(ctx, "__gen_throw", [ER, ER], [ER]);
  ensureLateImport(ctx, "__gen_result_value", [ER], [ER]);
  ensureLateImport(ctx, "__gen_result_value_f64", [ER], [{ kind: "f64" }]);
  ensureLateImport(ctx, "__gen_result_done", [ER], [{ kind: "i32" }]);
  // Ensure __get_caught_exception is available for generator body try/catch wrappers
  ensureLateImport(ctx, "__get_caught_exception", [], [ER]);
  flushLateImportShifts(ctx, ctx.currentFunc);
}

/** Register for-in key enumeration host imports if not already registered */
export function addForInImports(ctx: CodegenContext): void {
  // Guard: only register once
  if (ctx.funcMap.has("__for_in_keys")) return;

  // (#2689) Batch + immediate flush — see addIteratorImports for the rationale.
  // Only registered in JS-host mode (caller-guarded `!standalone && !wasi`), so
  // the standalone `__for_in_*` refusal inside ensureLateImport never triggers
  // here. Raw addImport on this lazy path would desync already-baked funcIdx.
  const ER: ValType = { kind: "externref" };
  // __for_in_keys: (externref) -> externref — returns JS array of enumerable string keys
  ensureLateImport(ctx, "__for_in_keys", [ER], [ER]);
  // __for_in_len: (externref) -> i32 — returns keys.length
  ensureLateImport(ctx, "__for_in_len", [ER], [{ kind: "i32" }]);
  // __for_in_get: (externref, i32) -> externref — returns keys[i]
  ensureLateImport(ctx, "__for_in_get", [ER, { kind: "i32" }], [ER]);
  // __for_in_has: (externref obj, externref key) -> i32 — per-visit liveness
  // check so a property deleted mid-enumeration is skipped (#2066).
  ensureLateImport(ctx, "__for_in_has", [ER, ER], [{ kind: "i32" }]);
  // (#3323) __array_forin_keys: (externref vec, i32 len) -> externref — for an
  // ARRAY receiver, returns the full OrdinaryOwnPropertyKeys string list: integer
  // indices "0".."len-1" ascending (len is the vec length, read in Wasm via the
  // `$__vec_base` length field and passed in — the host has no reliable opaque-vec
  // length otherwise), THEN the own enumerable non-index string keys added via
  // `arr.k = v` / `Object.defineProperty` (sidecar), in insertion order with
  // `__get_`/`__set_` accessor keys normalized to their user key and deduped. The
  // native emitArrayForIn index loop only covered the indices and dropped the
  // string keys entirely.
  ensureLateImport(ctx, "__array_forin_keys", [ER, { kind: "i32" }], [ER]);
  flushLateImportShifts(ctx, ctx.currentFunc);
}

/** Scan user code and register only the extern class imports actually used */
export function collectUsedExternImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const registered = new Set<string>();
  const useNativeEncodingApi = ctx.wasi || ctx.standalone || ctx.strictNoHostImports;
  const isNativeEncodingClass = (className: string | undefined): boolean =>
    useNativeEncodingApi && (className === "TextEncoder" || className === "TextDecoder");

  // Pre-scan source for user-defined class names. A user-defined class shadows
  // any extern class with the same name (e.g. user `class Node` shadows DOM
  // `Node`). Without this guard, `${ClassName}_new` would be added as a host
  // import here, then collide on funcMap when class compilation later assigns
  // the same key to a defined-function index (#1284). The orphan import slot
  // then sits at the funcMap idx that the user-class registration overwrote,
  // and the late-import shift skips that key (it appears in importNames),
  // leaving funcMap[`${ClassName}_new`] pointing at an *adjacent* import slot
  // after subsequent late imports are added — so `new UserClass(...)` lowers
  // to a call against an unrelated host import (e.g. `__extern_set`).
  const userClassNames = new Set<string>();
  // Bare built-in constructors can be checker-unresolved in JavaScript files
  // that preprocessing upgrades to TypeScript grammar (for example when timer
  // declarations are injected). Keep a conservative source-wide binding set so
  // the syntactic extern fallback below never captures a user-shadowed name.
  const userValueNames = new Set<string>();
  // (#1794) A class is only a USER class if it is not ambient. `declare class X`
  // and classes inside `declare namespace N { class X }` ARE the extern-class
  // declarations themselves — collecting them here made the #1284 shadow guard
  // block its own extern registration, so every declare-namespace extern ctor
  // lowered to `undefined` (funcMap miss → muted reportError → null) and every
  // extern method/property import was suppressed. Latent since #1284
  // (2026-05-02); surfaced by the tests/externref.test.ts suite (5/5 failing)
  // while wiring node:events EventEmitter (#1794), which rides the
  // declare-namespace extern path.
  const isAmbientClassDecl = (node: ts.Node): boolean => {
    // Ancestor walk for a `declare` modifier: covers `declare class X` (own
    // modifier) and `declare namespace N { class X }` (the enclosing
    // ModuleDeclaration carries it). The ts-api shim does not expose
    // NodeFlags.Ambient, so the modifier walk is the portable check.
    for (let cur: ts.Node | undefined = node; cur !== undefined; cur = cur.parent) {
      const mods = (cur as { modifiers?: readonly ts.Node[] }).modifiers;
      if (mods?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
    }
    return false;
  };
  function collectUserClassNames(node: ts.Node): void {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name && !isAmbientClassDecl(node)) {
      userClassNames.add(node.name.text);
      userValueNames.add(node.name.text);
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      userValueNames.add(node.name.text);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
      userValueNames.add(node.name.text);
    }
    if (ts.isImportClause(node) && node.name) {
      userValueNames.add(node.name.text);
    }
    if (ts.isImportSpecifier(node)) {
      userValueNames.add(node.name.text);
    }
    if (ts.isNamespaceImport(node)) {
      userValueNames.add(node.name.text);
    }
    forEachChild(node, collectUserClassNames);
  }
  collectUserClassNames(sourceFile);
  const nativeRegExpProvider = ctx.targetProfile.semanticProviders === "native-first";

  function resolveExtern(className: string, memberName: string, kind: "method" | "property"): ExternClassInfo | null {
    // User-defined classes shadow extern classes — never resolve to extern (#1284).
    if (userClassNames.has(className)) return null;
    let current: string | undefined = className;
    while (current) {
      const info = ctx.externClasses.get(current);
      if (info) {
        if (kind === "method" && info.methods.has(memberName)) return info;
        if (kind === "property" && info.properties.has(memberName)) return info;
      }
      current = ctx.externClassParent.get(current);
    }
    return null;
  }

  function register(importName: string, params: ValType[], results: ValType[]) {
    if (registered.has(importName)) return;
    registered.add(importName);
    const t = addFuncType(ctx, params, results);
    addImport(ctx, "env", importName, { kind: "func", typeIdx: t });
  }

  function visit(node: ts.Node) {
    // new ClassName()
    if (ts.isNewExpression(node)) {
      const type = ctx.checker.getTypeAtLocation(node);
      const inferredClassName = type.getSymbol()?.name;
      const bareClassName = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      const className =
        inferredClassName ??
        (bareClassName && !userValueNames.has(bareClassName) && ctx.externClasses.has(bareClassName)
          ? bareClassName
          : undefined);
      if (
        className &&
        !(nativeRegExpProvider && className === "RegExp") &&
        !userClassNames.has(className) &&
        !isNativeEncodingClass(className)
      ) {
        const info = ctx.externClasses.get(className);
        if (info) register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // RegExp literal (/pattern/flags) → needs RegExp_new import
    if (!nativeRegExpProvider && node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const info = ctx.externClasses.get("RegExp");
      if (info) {
        register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // RegExp(pattern, flags) call without `new` — compileCallExpression
    // emits the RegExp_new host call directly. Register it here so the
    // import exists by the time codegen runs. (#1055)
    if (
      !nativeRegExpProvider &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp"
    ) {
      const info = ctx.externClasses.get("RegExp");
      if (info) {
        register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // obj.prop or obj.method(...)
    if (ts.isPropertyAccessExpression(node)) {
      // Skip if this is the target of an assignment (setter handled below)
      const isAssignTarget =
        node.parent &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.parent.left === node;

      if (!isAssignTarget) {
        const objType = ctx.checker.getTypeAtLocation(node.expression);
        const className = objType.getSymbol()?.name;
        const memberName = node.name.text;
        if (className && !isNativeEncodingClass(className)) {
          const isCall = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
          if (isCall) {
            const info =
              nativeRegExpProvider && className === "RegExp" ? null : resolveExtern(className, memberName, "method");
            if (info) {
              const sig = info.methods.get(memberName)!;
              register(`${info.importPrefix}_${memberName}`, sig.params, sig.results);
            }
          } else {
            // #1914 — standalone answers RegExp reflection reads natively
            // (struct fields); never pre-register the env.RegExp_get_* host
            // import for them, matching the compile-path interception in
            // property-access.ts. Same set on both sides keeps a non-handled
            // prop on the (refusing) extern path instead of silently losing
            // its import.
            const isStandaloneNativeRegExpProp =
              nativeRegExpProvider && className === "RegExp" && STANDALONE_REGEXP_REFLECTION_PROPS.has(memberName);
            const info = isStandaloneNativeRegExpProp ? null : resolveExtern(className, memberName, "property");
            if (info) {
              const propInfo = info.properties.get(memberName)!;
              register(`${info.importPrefix}_get_${memberName}`, [{ kind: "externref" }], [propInfo.type]);
            }
          }
        }
      }
    }

    // obj.prop = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const objType = ctx.checker.getTypeAtLocation(node.left.expression);
      const className = objType.getSymbol()?.name;
      const propName = node.left.name.text;
      // #1914 — `re.lastIndex = v` is a native struct.set in standalone; do
      // not pre-register env.RegExp_set_lastIndex.
      const isStandaloneNativeRegExpWrite = nativeRegExpProvider && className === "RegExp" && propName === "lastIndex";
      if (className && !isNativeEncodingClass(className) && !isStandaloneNativeRegExpWrite) {
        const info = resolveExtern(className, propName, "property");
        if (info) {
          const propInfo = info.properties.get(propName)!;
          register(`${info.importPrefix}_set_${propName}`, [{ kind: "externref" }, propInfo.type], []);
        }
      }
    }

    // obj[idx] on externref (e.g. HTMLCollection) → __extern_get
    if (ts.isElementAccessExpression(node)) {
      // Skip when element access is the callee of a call expression (e.g. obj['method']())
      // — the call handler compiles this as a direct method call, not a property read
      const isCallCallee = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
      const isNativeStandaloneRegExpMatchArray =
        nativeRegExpProvider && isStandaloneRegExpMatchArrayValue(ctx, node.expression);
      const objType = ctx.checker.getTypeAtLocation(node.expression);
      const sym = objType.getSymbol();
      // Skip Array and tuple types — those use Wasm GC struct/array ops, not host import
      // Skip widened empty objects — those use struct.get, not host import
      // (#3364) resolve to the receiver's declaration key, not the bare name.
      const isWidenedVar =
        ts.isIdentifier(node.expression) &&
        ((): boolean => {
          const key = resolveWidenedVarKey(ctx, node.expression);
          return key !== undefined && ctx.widenedVarStructMap.has(key);
        })();
      if (
        !isCallCallee &&
        !isNativeStandaloneRegExpMatchArray &&
        sym?.name !== "Array" &&
        sym?.name !== "__type" &&
        sym?.name !== "__object" &&
        !isTupleType(objType) &&
        !isWidenedVar
      ) {
        const wasmType = mapTsTypeToWasm(objType, ctx.checker);
        if (wasmType.kind === "externref") {
          // (#2908) Host-free modes: DO NOT eagerly seed the `env::__extern_get`
          // HOST import here. `__extern_get` is a member of
          // OBJECT_RUNTIME_HELPER_NAMES, so under `--target standalone`/`wasi`
          // the compile-path `ensureLateImport(ctx, "__extern_get", …)` at every
          // dynamic-read site routes the name to the Wasm-native `__extern_get`
          // defined by `ensureObjectRuntime` (object-runtime.ts) — a DEFINED
          // function, no host import. But `ensureLateImport` short-circuits on
          // `funcMap.has(name)`: if THIS pre-scan has already registered the
          // host import into funcMap, that native routing never fires and the
          // module ships an unsatisfiable `env::__extern_get` (the standalone
          // dynamic-object-property leak — the single largest host-import leak
          // class, harness `verifyProperty`/`obj[name]` drives it into ~4.5k
          // tests). Skipping the pre-registration lets the native routing win;
          // host/gc mode is unchanged (still eagerly seeds the host import).
          if (!(ctx.standalone || ctx.wasi)) {
            register("__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
          }
        }
      }
    }

    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    forEachChild(stmt, visit);
  }
}
