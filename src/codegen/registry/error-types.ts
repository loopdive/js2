// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Wasm-native Error construction for standalone / WASI mode (#1104 Phase 1).
 *
 * In JS-host mode, `new Error("msg")` lowers to a `__new_Error` host import
 * that resolves to the JS `Error` constructor. In standalone mode (`--target
 * wasi`) there is no JS host, so the import is unsatisfied and the wasm
 * module fails to instantiate with `Import #N "env": module is not an object
 * or function`.
 *
 * Phase 1 scope (this module): replace the `__new_<ErrorName>` host imports
 * with internal Wasm functions that build a WasmGC `$Error_struct` and return
 * it as externref. This unblocks instantiation and lets `throw new Error(...)`
 * (which already coerces the value to externref via the existing exception
 * tag) work in standalone mode.
 *
 * **Out of scope for Phase 1** (deferred to follow-up phases):
 *   - Property access for `err.message` / `err.name` — still routes through
 *     the JS-host `__extern_get` import.
 *   - `error instanceof TypeError` — still routes through the JS-host
 *     `__instanceof` import. The `$tag` field on `$Error_struct` is populated
 *     here so a future Phase 3 can drive ref.test/struct.get-based instanceof.
 *   - Stack traces — `error.stack` returns undefined (option 1 from the issue).
 *
 * The struct shape is intentionally minimal:
 *
 * ```
 * (type $Error_struct (struct
 *   (field $tag       i32)               ;; from BUILTIN_TYPE_TAGS
 *   (field $message   (mut externref))   ;; the constructor argument
 *   (field $name      externref)         ;; "Error" / "TypeError" / etc.
 * ))
 * ```
 *
 * The `$message` field is mutable because spec §20.5.1.1 allows
 * `error.message = "x"` writes. `$name` and `$tag` are immutable — the spec
 * does allow `error.name = "x"` overrides on subclasses, but Phase 2 will
 * decide whether to mirror that into the struct field or via a sidecar map.
 *
 * Issue: plan/issues/backlog/1104-wasm-native-error-construction-and.md
 * Related: src/codegen/builtin-tags.ts (#1325 type-tag registry)
 */

import type { CodegenContext } from "../context/types.js";
import type { Instr, ValType } from "../../ir/types.js";

import { BUILTIN_TYPE_TAGS } from "../builtin-tags.js";
import { addFuncType } from "./types.js";
import { addStringConstantGlobal } from "./imports.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";

/**
 * The 8 built-in JS Error constructors that Phase 1 supports as Wasm-native
 * struct construction in WASI mode. Order matches the order in which test262
 * tests typically reference them.
 */
const WASI_ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
] as const;

export type WasiErrorName = (typeof WASI_ERROR_NAMES)[number];

/** Returns true if `name` is one of the 8 Error constructors handled by Phase 1. */
export function isWasiErrorName(name: string): name is WasiErrorName {
  return (WASI_ERROR_NAMES as readonly string[]).includes(name);
}

/**
 * Get or register the `$Error_struct` WasmGC type. Idempotent — returns the
 * cached type index on subsequent calls.
 */
export function getOrRegisterErrorStructType(ctx: CodegenContext): number {
  if (ctx.errorStructTypeIdx >= 0) return ctx.errorStructTypeIdx;

  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$Error_struct",
    fields: [
      { name: "tag", type: { kind: "i32" }, mutable: false },
      { name: "message", type: { kind: "externref" }, mutable: true },
      { name: "name", type: { kind: "externref" }, mutable: false },
      // (#1536) $stack — fieldIdx 3, kept AFTER message(1)/name(2) so their
      // indices stay stable. `error.stack` is non-standard (no normative
      // test262 coverage); materializing a real stack trace needs no Wasm
      // primitive, so standalone constructs it as `ref.null.extern` (reads
      // back as `undefined`, not a trap). Mutable so a future `err.stack = …`
      // write can land here without a struct-type change.
      { name: "stack", type: { kind: "externref" }, mutable: true },
    ],
  });
  ctx.errorStructTypeIdx = idx;
  return idx;
}

/**
 * Emit an internal Wasm function `__new_<errorName>` that constructs a new
 * `$Error_struct` and returns it as externref. The function takes `argCount`
 * externref params (the constructor arguments seen at call sites — typically
 * 0 or 1 for `new Error(msg)`).
 *
 * Idempotent — does nothing if `__new_<errorName>` is already registered
 * (whether as a host import or a previously-emitted internal function).
 *
 * #1536 Phase 2 — the `$name` field is now materialized with the error
 * class's name string ("Error" / "TypeError" / …) instead of the Phase-1
 * `ref.null extern` placeholder, so `err.name` reads the correct value in
 * standalone mode (the property-access fast path in `property-access.ts`
 * already does `struct.get $Error_struct[2]` for `.name` under
 * `ctx.wasi || ctx.standalone`). The constant is materialized via the
 * shared `stringConstantExternrefInstrs` dual-mode helper: nativeStrings
 * mode builds the FlatString struct inline + `extern.convert_any`;
 * host-strings mode emits a `global.get` of the interned string constant.
 * The string is registered via `addStringConstantGlobal` first so the
 * helper finds it in `ctx.stringGlobalMap`.
 */
export function emitWasiErrorConstructor(ctx: CodegenContext, errorName: WasiErrorName, argCount: number): void {
  const importName = `__new_${errorName}`;
  if (ctx.funcMap.has(importName)) return;

  const structIdx = getOrRegisterErrorStructType(ctx);
  const tagValue = BUILTIN_TYPE_TAGS[errorName];

  // #1536 Phase 2 — register the class-name string so the $name field can be
  // materialized below. Must run BEFORE building the body so the dual-mode
  // helper finds the interned global.
  addStringConstantGlobal(ctx, errorName);
  const nameInstrs = stringConstantExternrefInstrs(ctx, errorName);

  const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `${importName}_type`);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(importName, funcIdx);

  // Body: push fields in struct field order (tag, message, name), then
  // `struct.new $Error_struct`, then `extern.convert_any` so the result has
  // the externref ABI shape that the `__new_<Name>` callers expect.
  const body: Instr[] = [
    { op: "i32.const", value: tagValue },
    // $message — first arg if present, else null
    argCount > 0 ? { op: "local.get", index: 0 } : { op: "ref.null.extern" },
    // $name — #1536 Phase 2: materialized class-name string ("TypeError" …)
    // as externref, replacing the Phase-1 `ref.null.extern` placeholder.
    ...nameInstrs,
    // $stack — (#1536) non-standard; standalone has no stack-capture
    // primitive, so initialize to null (reads back as `undefined`).
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: structIdx },
    { op: "extern.convert_any" },
  ];

  ctx.mod.functions.push({
    name: importName,
    typeIdx,
    locals: [],
    body,
    exported: false,
  });
}
