// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { compileSource } from "./compiler.js";
import { buildImports, jsString } from "./runtime.js";
import { STRING_CONSTANTS16_NS } from "./string-surrogate.js";

const JS_STRINGS_NATIVE_BUILTIN = true;

/** Instantiate a Wasm module, trying native wasm:js-string builtins first
 *  (Chrome 130+, Firefox 135+), falling back to the JS polyfill.
 *  Uses importedStringConstants to provide string literals as globals. */
export async function instantiateWasm(
  binary: ArrayBuffer | ArrayBufferView,
  env: Record<string, Function>,
  stringConstants?: Record<string, WebAssembly.Global>,
  // (#2880) hex-keyed namespace for surrogate-containing string constants.
  stringConstants16?: Record<string, WebAssembly.Global>,
): Promise<{ instance: WebAssembly.Instance; nativeBuiltins: boolean }> {
  const sc = stringConstants ?? {};
  const sc16 = stringConstants16 ?? {};
  const bytes = binary as BufferSource;
  if (JS_STRINGS_NATIVE_BUILTIN) {
    try {
      const { instance } = await (WebAssembly.instantiate as Function)(
        bytes,
        { env, string_constants: sc, [STRING_CONSTANTS16_NS]: sc16 },
        { builtins: ["js-string"], importedStringConstants: "string_constants" },
      );
      return { instance, nativeBuiltins: true };
    } catch {
      // Fall through to the JS polyfill path.
    }
  }
  const { instance } = await WebAssembly.instantiate(bytes, {
    env,
    "wasm:js-string": jsString,
    string_constants: sc,
    [STRING_CONSTANTS16_NS]: sc16,
  } as WebAssembly.Imports);
  return { instance, nativeBuiltins: false };
}

/** Instantiate a precompiled Wasm module from a Response/URL using streaming compilation
 *  when available, falling back to byte instantiation if needed.
 *  Shared runtime helpers stay outside the module-specific payload. */
export async function instantiateWasmStreaming(
  source: Response | Promise<Response> | RequestInfo | URL,
  env: Record<string, Function>,
  stringConstants?: Record<string, WebAssembly.Global>,
  // (#2880) hex-keyed namespace for surrogate-containing string constants.
  stringConstants16?: Record<string, WebAssembly.Global>,
): Promise<{ instance: WebAssembly.Instance; nativeBuiltins: boolean }> {
  const sc = stringConstants ?? {};
  const sc16 = stringConstants16 ?? {};
  const response = source instanceof Response ? source : source instanceof Promise ? await source : await fetch(source);
  const byteFallback = response.clone();

  if (typeof WebAssembly.instantiateStreaming === "function") {
    if (JS_STRINGS_NATIVE_BUILTIN) {
      try {
        const { instance } = await (WebAssembly.instantiateStreaming as Function)(
          response,
          { env, string_constants: sc, [STRING_CONSTANTS16_NS]: sc16 },
          { builtins: ["js-string"], importedStringConstants: "string_constants" },
        );
        return { instance, nativeBuiltins: true };
      } catch {
        // Fall back to clone and try non-streaming below.
      }
    } else {
      try {
        const { instance } = await WebAssembly.instantiateStreaming(response, {
          env,
          "wasm:js-string": jsString,
          string_constants: sc,
          [STRING_CONSTANTS16_NS]: sc16,
        } as WebAssembly.Imports);
        return { instance, nativeBuiltins: false };
      } catch {
        // Fall back to byte instantiation below.
      }
    }
  }

  const bytes = new Uint8Array(await byteFallback.arrayBuffer());
  return instantiateWasm(bytes, env, sc, sc16);
}

/** Compile TypeScript source and instantiate the Wasm module. */
export async function compileAndInstantiate(source: string, deps?: Record<string, any>): Promise<WebAssembly.Exports> {
  const result = await compileSource(source);
  if (!result.success) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  const imports = buildImports(result.imports, deps, result.stringPool);
  const binary = new Uint8Array(result.binary);
  const { instance } = await instantiateWasm(binary, imports.env, imports.string_constants, imports.string_constants16);
  imports.setInstance?.(instance);
  return instance.exports;
}
