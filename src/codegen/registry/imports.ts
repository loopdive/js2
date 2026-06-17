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
    const decision = isHostImportAllowed(module, name);
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
  addImport(ctx, "string_constants", value, {
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
