// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4262) A compiler-minted TypeError must BE a TypeError in standalone mode.
 *
 * `typeErrorThrowInstrs` (property-access.ts) and its siblings threw a native
 * STRING whose text merely BEGINS with `"TypeError: "`. Consequences, all
 * measured on the ES5 standalone failing set (`.tmp/es5-buckets.json`,
 * 1,077 files):
 *
 *   - `catch (e) { e instanceof TypeError }` answers `false` — 19 files;
 *   - the upstream harness's `assert.throws(TypeError, fn)` rejects it before
 *     it even compares constructors, because `typeof thrown !== 'object'`
 *     short-circuits first ("Thrown value was not an object!") — 2 files;
 *   - `e.name` / `e.message` read `undefined` off a string.
 *
 * The repair mints the SAME `$Error_struct` the user-level `new TypeError(msg)`
 * path already builds (`emitWasiErrorConstructor`), so tag-driven `instanceof`
 * (#1536), `.name` / `.message` / `.constructor` (#3130) and `String(e)`
 * (#2962 native exception rendering) all answer through machinery that already
 * exists. Nothing new is invented for the value; only its representation
 * changes.
 *
 * ## Why this is index-safe mid-body
 *
 * `emitWasiErrorConstructor` mints through `mintDefinedFunc`, which since
 * #1916 S3 returns a STABLE handle (`>= STABLE_FUNC_BASE`) that no late-import
 * shifter renumbers and that `resolveLayout` maps to a position exactly once,
 * at emit. Appending a defined function therefore cannot move an index already
 * baked into a partially-built instruction array — which is what makes it legal
 * to call from inside a `then:` arm being constructed. This is the same
 * property `ensureNullThisTypeError` (#2025) leans on for its `noJsHost` arm.
 *
 * ## Why standalone / WASI only
 *
 * In JS-host mode `__new_TypeError` is an `env` IMPORT, and registering an
 * import mid-body is exactly the #1839/#117/#1886 index-shift trap. Host mode
 * keeps the historical string throw, so the gc lane stays byte-identical.
 *
 * ## Demand gating
 *
 * A module that never reaches a throw site never calls in here, so its output
 * is unchanged to the byte. A module that does reach one gains exactly the
 * `$Error_struct` type, one `__new_<Name>` function and one string constant —
 * all of which the standalone scaffold already emits for most modules.
 */
import type { CodegenContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";
import { emitWasiErrorConstructor, type WasiErrorName } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/**
 * True when this module can mint a native `$Error_struct` error constructor
 * in-module — i.e. with no `env` import and therefore no index shift.
 */
export function canMintNativeErrorStruct(ctx: CodegenContext): boolean {
  return ctx.standalone || ctx.wasi;
}

/**
 * Instructions that construct a native `$Error_struct` of class `errorName`
 * carrying `message`, then `throw` it through the module's exception tag.
 *
 * Returns `null` when the native constructor is unavailable (JS-host mode, or
 * a registration that did not take) so the caller keeps its existing
 * string-throw fallback rather than emitting a call to nothing.
 *
 * Stack effect is identical to the string throw it replaces: one externref
 * pushed, then `throw` (which does not return).
 */
export function standaloneErrorThrowInstrs(
  ctx: CodegenContext,
  errorName: WasiErrorName,
  message: string,
): Instr[] | null {
  if (!canMintNativeErrorStruct(ctx)) return null;
  // Idempotent + append-only (stable-handle minting) — safe mid-body.
  emitWasiErrorConstructor(ctx, errorName, 1);
  const ctorIdx = ctx.funcMap.get(`__new_${errorName}`);
  if (ctorIdx === undefined) return null;
  const tagIdx = ensureExnTag(ctx);
  if (tagIdx < 0) return null;
  addStringConstantGlobal(ctx, message);
  return [...stringConstantExternrefInstrs(ctx, message), { op: "call", funcIdx: ctorIdx }, { op: "throw", tagIdx }];
}
