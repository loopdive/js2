// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6982) `import.meta.url` when strings are native but a JavaScript embedder
 * supplies the value (the native regime in a JS environment).
 *
 * `__get_import_meta_url` (#1494) returns the loader-injected value as a host
 * externref — a JS string, or `undefined` when no loader supplied one. Under
 * native strings the `string`-typed read expected a `$AnyString`, so the
 * externref → string coercion's `ref.test` failed on the JS string and the
 * value read as null. Marshal it through the native-string extern bridge
 * instead, keeping an absent value `undefined` (the bridge would throw on it).
 *
 * Host-free environments keep their previous lowering — the caller only asks
 * when {@link hostStringBridgeUsable} holds — and so does the host-strings
 * lane, which never sets `nativeStrings`.
 */
import type { ValType } from "../../ir/types.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { ensureNativeStringExternBridge, hostStringBridgeUsable } from "../native-strings.js";
import { ensureExternIsUndefinedImport, ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/**
 * Emit `import.meta.url` as an externref holding a native string (or the
 * canonical `undefined`). Returns null, emitting nothing, when this module does
 * not pair native strings with a usable JS string bridge.
 */
export function emitNativeImportMetaUrl(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0 || !hostStringBridgeUsable(ctx)) return null;
  const externref: ValType = { kind: "externref" };
  // Register every import before reading any index, then flush once.
  ensureLateImport(ctx, "__get_import_meta_url", [], [externref]);
  ensureExternIsUndefinedImport(ctx);
  ensureNativeStringExternBridge(ctx);
  flushLateImportShifts(ctx, fctx);
  const undefinedInstrs = canonicalUndefinedExternInstrs(ctx);
  const metaIdx = ctx.funcMap.get("__get_import_meta_url");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern");
  if (metaIdx === undefined || isUndefinedIdx === undefined || fromExternIdx === undefined) return null;
  const tmp = allocTempLocal(fctx, externref);
  fctx.body.push(
    { op: "call", funcIdx: metaIdx },
    { op: "local.tee", index: tmp },
    { op: "ref.is_null" },
    { op: "local.get", index: tmp },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: undefinedInstrs,
      else: [{ op: "local.get", index: tmp }, { op: "call", funcIdx: fromExternIdx }, { op: "extern.convert_any" }],
    },
  );
  releaseTempLocal(fctx, tmp);
  return externref;
}
