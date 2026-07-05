// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Import/global registry ownership for the backend.
 *
 * This module owns low-level Wasm import registration plus the global-index
 * fixups required when late import globals are inserted during codegen.
 */
import type { Import, Instr, TagDef } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { buildStrictHostImportError, isHostImportAllowed } from "../host-import-allowlist.js";
import { hasLoneSurrogate, hexCodeUnits, STRING_CONSTANTS16_NS } from "../../string-surrogate.js";
import { addFuncType } from "./types.js";

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
export function addImport(ctx: CodegenContext, module: string, name: string, desc: Import["desc"]): void {
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
      return;
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
  addImport(ctx, importModule, importName, {
    kind: "global",
    type: { kind: "externref" },
    mutable: false,
  });
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
      if ("body" in instr && Array.isArray((instr as any).body)) {
        shiftGlobalIndices((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        shiftGlobalIndices((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        shiftGlobalIndices((instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) shiftGlobalIndices(c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        shiftGlobalIndices((instr as any).catchAll);
      }
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

  function shiftMap(map: Map<string, number>): void {
    for (const [key, idx] of map) {
      if (idx >= threshold) {
        map.set(key, idx + delta);
      }
    }
  }
  shiftMap(ctx.moduleGlobals);
  shiftMap(ctx.capturedGlobals);
  // (#3036) `capturedBoxGlobals` values are objects, not bare indices — shift
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
}
