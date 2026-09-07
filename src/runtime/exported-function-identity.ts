// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#5337) "Is this the same exported Wasm function?" — engine-neutral.
 *
 * Every host-bridge family authenticates a helper by comparing the frozen
 * export (`instance.exports.$d1`) with the entry the compiler placed in its
 * binding table (`bindings.get(1)`). The JS API says both reads yield the one
 * cached Exported Function object for that function address, and V8 does so.
 * JavaScriptCore (WebKitGTK 2.52 / iOS Safari) does not: the export object and
 * the table element are two distinct wrapper objects for the same function,
 * each stable on its own but never `===` to the other. Under strict identity
 * every closure and data-struct helper then reads as forged and is masked to
 * `undefined` — `__call_fn_0 is not available`, `__struct_field_names` gone,
 * compiled object literals enumerating as `{}`.
 *
 * Strict identity stays the first and, on a canonicalizing engine, the only
 * test. The fallback runs only where a one-time probe has shown the engine
 * splits identities, and it still demands both sides be genuine Wasm functions
 * (only those can enter a funcref table) with the same function index (an
 * Exported Function's `name` is its index). What that cannot distinguish is
 * the same index in a *different instance of the same module* — which runs
 * the same code — while every forgery the strict check catches (JS impostors,
 * a different function of the same instance) still fails closed.
 */

let canonicalizesExportedFunctions: boolean | undefined;
let canonicalizesReexportedGlobals: boolean | undefined;
let funcrefScratchTable: WebAssembly.Table | undefined;

// (module (func $f (export "f")) (table (export "t") 1 1 funcref) (elem (i32.const 0) $f))
const IDENTITY_PROBE_MODULE = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 4, 5, 1, 112, 1, 1, 1, 7, 9, 2, 1, 102, 0, 0, 1, 116, 1,
  0, 9, 7, 1, 0, 65, 0, 11, 1, 0, 10, 4, 1, 2, 0, 11,
];

// (module (global (import "e" "g") i32) (export "x" (global 0)))
const GLOBAL_PROBE_MODULE = [0, 97, 115, 109, 1, 0, 0, 0, 2, 8, 1, 1, 101, 1, 103, 3, 127, 0, 7, 5, 1, 1, 120, 3, 0];

/** Does `table.get` return the very object `instance.exports` holds for the same function? */
export function engineCanonicalizesExportedFunctions(): boolean {
  if (canonicalizesExportedFunctions !== undefined) return canonicalizesExportedFunctions;
  try {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(IDENTITY_PROBE_MODULE)));
    const exports = instance.exports as { f: Function; t: WebAssembly.Table };
    canonicalizesExportedFunctions = exports.t.get(0) === exports.f;
  } catch {
    // A probe that cannot run says nothing about the engine; keep the strict
    // path, which is the spec'd behaviour.
    canonicalizesExportedFunctions = true;
  }
  return canonicalizesExportedFunctions;
}

/** Only an Exported Function may be stored in a funcref table; a JS function throws. */
function isWasmExportedFunction(value: unknown): boolean {
  if (typeof value !== "function") return false;
  try {
    funcrefScratchTable ??= new WebAssembly.Table({ element: "anyfunc", initial: 1, maximum: 1 });
    funcrefScratchTable.set(0, value as unknown as WebAssembly.ExportValue);
    funcrefScratchTable.set(0, null);
    return true;
  } catch {
    return false;
  }
}

export function sameExportedFunction(helper: unknown, binding: unknown): boolean {
  if (helper === binding) return true;
  if (typeof helper !== "function" || typeof binding !== "function") return false;
  if (engineCanonicalizesExportedFunctions()) return false;
  return helper.name === binding.name && isWasmExportedFunction(helper) && isWasmExportedFunction(binding);
}

/** Is an imported `WebAssembly.Global`, re-exported, the same object the host passed in? */
function engineCanonicalizesReexportedGlobals(): boolean {
  if (canonicalizesReexportedGlobals !== undefined) return canonicalizesReexportedGlobals;
  try {
    const global = new WebAssembly.Global({ value: "i32", mutable: false }, 0);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(GLOBAL_PROBE_MODULE)), {
      e: { g: global },
    });
    canonicalizesReexportedGlobals = (instance.exports as { x: unknown }).x === global;
  } catch {
    canonicalizesReexportedGlobals = true;
  }
  return canonicalizesReexportedGlobals;
}

/**
 * Same association token? The data-struct bridge re-exports the immutable
 * externref Global `buildImports` handed the module, and the runtime later
 * matches that export against the Global it still holds. On an engine that
 * mints a new wrapper for a re-exported import, identity cannot hold; the
 * fallback compares the Globals' VALUES, which is exact because
 * `buildImports` stores a fresh per-call object in the token (see
 * `installFreshDataStructAssociationToken`) — a Global from another `buildImports`
 * carries a different object and still fails closed.
 */
export function sameAssociationToken(token: unknown, expected: unknown): boolean {
  if (token === expected) return true;
  if (!(token instanceof WebAssembly.Global) || !(expected instanceof WebAssembly.Global)) return false;
  if (engineCanonicalizesReexportedGlobals()) return false;
  const value = expected.value;
  return typeof value === "object" && value !== null && token.value === value;
}

/**
 * Re-mint the association-token Global `buildStringConstants` created so its
 * value is a fresh frozen object per `buildImports` rather than the string
 * every build shares — the per-call identity `sameAssociationToken`'s value
 * fallback compares. The string stays on the object for anyone inspecting the
 * export. No-op when the module has no data-struct bridge.
 */
export function installFreshDataStructAssociationToken(
  constants: Record<string, WebAssembly.Global>,
  tokenName: string,
): void {
  if (constants[tokenName] === undefined) return;
  constants[tokenName] = new WebAssembly.Global(
    { value: "externref", mutable: false },
    Object.freeze({ token: tokenName }),
  );
}
