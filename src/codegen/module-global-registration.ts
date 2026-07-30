// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { GlobalDef, Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { localGlobalIdx, nextModuleGlobalIdx } from "./registry/imports.js";

/**
 * Register one module-level global and expose its exact allocator object to
 * the structural ABI sidecar when the source declaration is authoritative.
 */
export function registerModuleGlobal(
  ctx: CodegenContext,
  name: string,
  wasmType: ValType,
  declaration?: ts.Declaration,
  registeredThisFile?: Map<string, number>,
): void {
  // Only a genuine user-defined function (a defined function whose index is
  // past the import prefix) shadows a module-level var. Imported host globals,
  // including wasm:js-string builtins, remain shadowable by user variables.
  // This distinction preserves #2669's concat/length/etc. collisions and
  // #3428's Test262 `var print = ...` harness binding. Treating any funcMap
  // entry as a user function leaves those variables as module-init locals,
  // making them invisible to nested/exported functions.
  const fnIdx = ctx.funcMap.get(name);
  if (fnIdx !== undefined && fnIdx >= ctx.numImportFuncs) return;

  // (#1400/#3672) Identity is the DECLARATION, not the bare name. A real
  // package graph reuses spellings across modules — `ms/index.js` declares
  // `var s = 1000; var m = s * 60;` while esquery and minimatch carry lexical
  // helpers named `s`/`m`. Keying module globals by bare name alone let one
  // package's numeric win and be loaded into another's reference slot
  // (`local.tee[0] expected (ref null N), found global.get of type f64`).
  // Each distinct declaration therefore gets its own global; only the FIRST
  // claimant of a name keeps the unsuffixed `__mod_<name>` spelling.
  if (declaration && ctx.moduleGlobalDeclarations.has(declaration)) {
    return;
  }
  if (!declaration && ctx.moduleGlobals.has(name)) return;
  if (ctx.classSet.has(name)) return;

  // Same-FILE redeclaration (`var x` twice in one scope) is ONE JavaScript
  // binding: alias this declaration onto the already-registered global.
  // Splitting them across two wasm globals made the sputnik evaluation-order
  // family (`#1: var x = 1; … #2: var x = 0; x * (x = 1)`) write its
  // initializer into one global while reads and assignments resolved the
  // other. Cross-FILE same-name vars are genuinely different bindings and
  // still mint the distinct suffixed global above.
  const sameFileIdx = registeredThisFile?.get(name);
  if (sameFileIdx !== undefined) {
    if (declaration) {
      ctx.moduleGlobalDeclarations.set(declaration, sameFileIdx);
      const existingGlobal = ctx.mod.globals[localGlobalIdx(ctx, sameFileIdx)];
      if (!existingGlobal) {
        throw new TypeError(`module global ${name} has no allocator object at index ${sameFileIdx}`);
      }
      if (ts.isVariableDeclaration(declaration)) {
        // The ABI sidecar keys bindings by DECLARATION and requires the display
        // name to match its allocator's actual spelling, which is the suffixed
        // one whenever this binding lost the race for the bare name.
        ctx.programAbiGlobals?.observeModuleValue(declaration, abiDisplayName(existingGlobal.name), existingGlobal);
      }
    }
    return;
  }

  const init: Instr[] =
    wasmType.kind === "f64"
      ? [{ op: "f64.const", value: 0 }]
      : wasmType.kind === "i32"
        ? [{ op: "i32.const", value: 0 }]
        : wasmType.kind === "i64"
          ? [{ op: "i64.const", value: 0n }]
          : wasmType.kind === "ref_null" || wasmType.kind === "ref"
            ? [{ op: "ref.null", typeIdx: wasmType.typeIdx }]
            : [{ op: "ref.null.extern" }];
  const globalType: ValType =
    wasmType.kind === "ref"
      ? {
          kind: "ref_null",
          typeIdx: wasmType.typeIdx,
        }
      : wasmType;
  const globalIdx = nextModuleGlobalIdx(ctx);
  const bareNameTaken = ctx.moduleGlobals.has(name);
  const displayName = bareNameTaken ? `${name}_${ctx.moduleGlobalDeclarations.size}` : name;
  const global: GlobalDef = {
    name: `__mod_${displayName}`,
    type: globalType,
    mutable: true,
    init,
  };
  ctx.mod.globals.push(global);
  if (!bareNameTaken) ctx.moduleGlobals.set(name, globalIdx);
  if (declaration) {
    ctx.moduleGlobalDeclarations.set(declaration, globalIdx);
    if (ts.isVariableDeclaration(declaration)) {
      ctx.programAbiGlobals?.observeModuleValue(declaration, displayName, global);
    }
  }
  registeredThisFile?.set(name, globalIdx);
}

/** Recover the ABI display name from an allocator global's `__mod_`-prefixed spelling. */
function abiDisplayName(globalName: string): string {
  return globalName.startsWith("__mod_") ? globalName.slice("__mod_".length) : globalName;
}

/** Allocate and structurally observe one retained top-level TDZ flag. */
export function registerModuleTdzGlobal(ctx: CodegenContext, sourceFile: ts.SourceFile, name: string): void {
  const canonicalGlobalIdx = ctx.moduleGlobals.get(name);
  if (canonicalGlobalIdx === undefined) return;
  const flagGlobalIdx = nextModuleGlobalIdx(ctx);
  const flagGlobal: GlobalDef = {
    name: `__tdz_${name}`,
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  };
  ctx.mod.globals.push(flagGlobal);
  ctx.tdzGlobals.set(name, flagGlobalIdx);

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
    );
    if (declaration) {
      // (#1400) `ctx.tdzGlobals` is keyed by BARE name, so the `__tdz_<name>`
      // flag belongs to whichever declaration won the bare-name global. Once
      // module globals are keyed by DECLARATION, a second file declaring the
      // same name owns a SUFFIXED global (`__mod_<name>_<n>`) and was observed
      // under that suffixed display name. Observing this file's declaration as
      // plain `<name>` then contradicts its own value observation and the ABI
      // sidecar throws `duplicate-slot-locator` — measured as
      // "module declaration KEYS was observed with contradictory tdz global
      // allocator objects", which failed the whole ESLint graph.
      //
      // Only the canonical owner gets the TDZ observation; a non-canonical
      // same-name declaration has no TDZ flag of its own to describe.
      //
      // The match must be EXACT — `undefined` is not "close enough". A
      // declaration absent from `moduleGlobalDeclarations` never got a value
      // global at all (`registerModuleGlobal` returns early when a real
      // user-defined function shadows the name), while `ctx.moduleGlobals` can
      // still hold the name on behalf of ANOTHER file's declaration. Observing
      // TDZ for it then reaches the sidecar with no value binding to pair
      // against: "module TDZ global minimatch was observed before its value
      // global".
      const declarationGlobalIdx = ctx.moduleGlobalDeclarations.get(declaration);
      if (declarationGlobalIdx !== undefined && declarationGlobalIdx === canonicalGlobalIdx) {
        ctx.programAbiGlobals?.observeModuleTdz(declaration, name, flagGlobal);
      }
      return;
    }
  }
}
