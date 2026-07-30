import { expect } from "vitest";
import { compile, type CompileResult } from "../../src/index.js";
import { isWasiErrorName } from "../../src/codegen/registry/error-types.js";
import { buildStringConstants, buildImports as buildRuntimeImports } from "../../src/runtime.js";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

/**
 * Build the full WebAssembly.Imports for a compiled result,
 * including env stubs, Math host imports, string constants,
 * and wasm:js-string polyfill.
 */
export function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    Math_sin: Math.sin,
    Math_cos: Math.cos,
    Math_tan: Math.tan,
    Math_asin: Math.asin,
    Math_acos: Math.acos,
    Math_atan: Math.atan,
    Math_atan2: Math.atan2,
    Math_exp: Math.exp,
    Math_log: Math.log,
    Math_log2: Math.log2,
    Math_log10: Math.log10,
    Math_pow: Math.pow,
    Math_random: Math.random,
    Math_acosh: Math.acosh,
    Math_asinh: Math.asinh,
    Math_atanh: Math.atanh,
    Math_cbrt: Math.cbrt,
    Math_expm1: Math.expm1,
    Math_log1p: Math.log1p,
    number_toString: (v: number) => String(v),
    __typeof_number: (v: unknown) => (typeof v === "number" ? 1 : 0),
    __typeof_string: (v: unknown) => (typeof v === "string" ? 1 : 0),
    __typeof_boolean: (v: unknown) => (typeof v === "boolean" ? 1 : 0),
    __typeof_bigint: (v: unknown) => (typeof v === "bigint" ? 1 : 0),
    __typeof: (v: unknown) => typeof v,
    __instanceof: (v: any, ctorName: string) => {
      try {
        const ctor = (globalThis as any)[ctorName];
        if (typeof ctor !== "function") return 0;
        return v instanceof ctor ? 1 : 0;
      } catch {
        return 0;
      }
    },
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    parseFloat: (s: any) => parseFloat(String(s)),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    __unbox_number: (v: unknown) => Number(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    // (#1644) bigint boxing: JS-BigInt-integration delivers the i64 as a JS
    // bigint already, so box is identity; __to_bigint is §7.1.13 ToBigInt.
    __box_bigint: (v: bigint) => v,
    __to_bigint: (v: any): bigint => {
      if (typeof v === "bigint") return v;
      if (typeof v === "number") throw new TypeError("Cannot convert a Number to a BigInt");
      if (typeof v === "symbol") throw new TypeError("Cannot convert a Symbol value to a BigInt");
      return BigInt(v);
    },
    // (#1644 Slice B) __bigint_ctor: §21.2.1.1 BigInt(value). Number →
    // NumberToBigInt (RangeError unless safe integer); string → StringToBigInt
    // (SyntaxError on malformed); Symbol → TypeError; bigint/boolean identity.
    __bigint_ctor: (v: any): bigint => {
      if (typeof v === "number") {
        if (!Number.isInteger(v)) {
          throw new RangeError(`The number ${v} cannot be converted to a BigInt because it is not an integer`);
        }
        return BigInt(v);
      }
      if (typeof v === "symbol") throw new TypeError("Cannot convert a Symbol value to a BigInt");
      return BigInt(v);
    },
    __make_callback: () => null,
    __extern_get: (obj: any, key: any) => (obj == null ? undefined : obj[key]),
    __extern_set: (obj: any, key: any, val: any) => {
      if (obj != null) obj[key] = val;
    },
    __extern_length: (obj: any) => (obj == null ? 0 : obj.length),
    __extern_is_undefined: (v: any) => (v === undefined ? 1 : 0),
    __throw_type_error: (msg: any) => {
      throw new TypeError(String(msg ?? ""));
    },
    __extern_slice: (arr: any, start: number) => (Array.isArray(arr) ? arr.slice(start) : []),
    JSON_stringify: (v: any) => JSON.stringify(v),
    JSON_parse: (s: any) => JSON.parse(s),
    // Generator support: buffer management and generator creation
    __gen_create_buffer: () => [] as any[],
    __gen_push_f64: (buf: any[], v: number) => {
      buf.push(v);
    },
    __gen_push_i32: (buf: any[], v: number) => {
      buf.push(v);
    },
    __gen_push_ref: (buf: any[], v: any) => {
      buf.push(v);
    },
    // (#2035) Stash the generator's `return` value on the buffer instead of
    // pushing it as a yielded element; surfaced once as the terminal result.
    __gen_set_return: (buf: any, v: any) => {
      if (buf != null) {
        Object.defineProperty(buf, "__genReturn", { value: v, writable: true, enumerable: false, configurable: true });
      }
    },
    __create_generator: (buf: any[]) => {
      let index = 0;
      let retDone = false;
      const retVal = (buf as any)?.__genReturn;
      return {
        next() {
          if (index < buf.length) {
            return { value: buf[index++], done: false };
          }
          // Terminal result carries the return value exactly once. (#2035)
          if (!retDone) {
            retDone = true;
            return { value: retVal, done: true };
          }
          return { value: undefined, done: true };
        },
        return(value: any) {
          index = buf.length;
          retDone = true;
          return { value, done: true };
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    },
    __gen_next: (gen: any) => gen.next(),
    __gen_return: (gen: any, val: any) => gen.return(val),
    __gen_throw: (gen: any, err: any) => gen.throw(err),
    __gen_result_value: (result: any) => result.value,
    __gen_result_value_f64: (result: any) => Number(result.value),
    __gen_result_done: (result: any) => (result.done ? 1 : 0),
    // Iterator protocol: host-delegated iteration for non-array types
    __iterator: (obj: any) => obj[Symbol.iterator](),
    __async_iterator: (obj: any) => {
      const asyncIter = obj[Symbol.asyncIterator];
      if (asyncIter) return asyncIter.call(obj);
      return obj[Symbol.iterator]();
    },
    // #1620 v2: multi-value result [i32 done, externref value]; __iterator_done
    // and __iterator_value imports are eliminated.
    __iterator_next: (iter: any): [number, any] => {
      const r = iter.next();
      return [r.done ? 1 : 0, r.value];
    },
    __iterator_return: (iter: any) => {
      if (iter && typeof iter.return === "function") iter.return();
    },
    // String method host imports (non-fast mode)
    string_trim: (s: string) => s.trim(),
    string_trimStart: (s: string) => s.trimStart(),
    string_trimEnd: (s: string) => s.trimEnd(),
    string_toUpperCase: (s: string) => s.toUpperCase(),
    string_toLowerCase: (s: string) => s.toLowerCase(),
    string_charAt: (s: string, i: number) => s.charAt(i),
    string_charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    string_at: (s: string, i: number) => s.at(i),
    string_slice: (s: string, start: number, end: number) => s.slice(start, end === 0 ? undefined : end),
    string_substring: (s: string, start: number, end: number) => s.substring(start, end === 0 ? undefined : end),
    string_indexOf: (s: string, search: any, fromIndex?: any) => s.indexOf(search, fromIndex),
    string_lastIndexOf: (s: string, search: any, fromIndex?: any) =>
      fromIndex == null ? s.lastIndexOf(search) : s.lastIndexOf(search, fromIndex),
    string_includes: (s: string, search: any) => (s.includes(search) ? 1 : 0),
    string_startsWith: (s: string, search: any) => (s.startsWith(search) ? 1 : 0),
    string_endsWith: (s: string, search: any) => (s.endsWith(search) ? 1 : 0),
    string_replace: (s: string, search: any, replacement: any) => s.replace(search, replacement),
    string_replaceAll: (s: string, search: any, replacement: any) => s.replaceAll(search, replacement),
    string_repeat: (s: string, count: number) => s.repeat(count),
    string_padStart: (s: string, targetLength: number, padString?: any) => s.padStart(targetLength, padString),
    string_padEnd: (s: string, targetLength: number, padString?: any) => s.padEnd(targetLength, padString),
    string_split: (s: string, separator: any) => s.split(separator),
    string_match: (s: string, regexp: any) => s.match(regexp),
    string_search: (s: string, regexp: any) => s.search(regexp),
    // Object.defineProperty / getOwnPropertyDescriptor host imports
    __defineProperty_value: (obj: any, prop: any, value: any, flags: number) => {
      if (obj == null) return obj;
      const desc: PropertyDescriptor = {};
      if (flags & (1 << 7)) desc.value = value;
      if (flags & (1 << 3)) desc.writable = !!(flags & 1);
      if (flags & (1 << 4)) desc.enumerable = !!(flags & (1 << 1));
      if (flags & (1 << 5)) desc.configurable = !!(flags & (1 << 2));
      try {
        Object.defineProperty(obj, prop, desc);
      } catch (_) {
        /* swallow for frozen/sealed */
      }
      return obj;
    },
    __getOwnPropertyDescriptor: (obj: any, prop: any) => {
      if (obj == null) return undefined;
      return Object.getOwnPropertyDescriptor(obj, prop);
    },
  };

  // #3529 P5 — manual-instantiation equivalence tests still need faithful
  // host constructors for the eight built-in Error-family manifest imports.
  // Reuse the production resolver for only those exact descriptors so
  // constructor argument trimming, AggregateError, and native prototypes stay
  // aligned with `src/runtime.ts::buildImports` without turning this compact
  // helper into an unrestricted second runtime implementation.
  const errorConstructorImports = result.imports.filter((descriptor) => {
    if (descriptor.module !== "env" || descriptor.kind !== "func") {
      return false;
    }
    if (descriptor.name === "__new_AggregateError") {
      return descriptor.intent.type === "builtin" && descriptor.intent.name === "__new_AggregateError";
    }
    if (!descriptor.name.startsWith("__new_")) return false;
    const errorName = descriptor.name.slice("__new_".length);
    // The seven ordinary Error-family constructors use the generic exact-class
    // bridge. AggregateError is intentionally excluded here: only its
    // specialised builtin intent owns the iterable/message/options ABI above.
    return (
      errorName !== "AggregateError" &&
      isWasiErrorName(errorName) &&
      descriptor.intent.type === "extern_class" &&
      descriptor.intent.action === "new" &&
      descriptor.intent.className === errorName
    );
  });
  if (errorConstructorImports.length > 0) {
    Object.assign(env, buildRuntimeImports(errorConstructorImports, undefined, result.stringPool).env);
  }

  return {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports;
}

/**
 * Instantiate a compiled result with full host-import fidelity (#1659).
 *
 * Unlike calling `buildImports` + `WebAssembly.instantiate` directly, this
 * overlays the runtime's faithful host imports (struct sidecar reads,
 * iterator protocol) AND registers the wasm instance via `setInstance` so
 * runtime callbacks like `__extern_get`'s `__sget_<field>` struct-getter
 * fallback work. Direct `buildImports` callers that skip `setInstance` see
 * `undefined` for opaque WasmGC struct fields, which makes destructuring
 * defaults wrongly fire in the harness even when the real runtime is correct.
 */
export async function instantiateWithRuntime(result: CompileResult) {
  const imports = buildImports(result);
  let setInstanceFn: ((instance: WebAssembly.Instance) => void) | undefined;
  if (result.imports && result.imports.length > 0) {
    const runtimeResult = buildRuntimeImports(result.imports, undefined, result.stringPool);
    setInstanceFn = runtimeResult.setInstance;
    imports.env = { ...(imports.env as Record<string, Function>), ...runtimeResult.env };
    if (runtimeResult.string_constants) imports.string_constants = runtimeResult.string_constants;
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  setInstanceFn?.(instance);
  return instance;
}

/**
 * Compile TS source to Wasm, instantiate it, and return exports.
 */
export async function compileToWasm(source: string) {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary (WebAssembly.validate failed)\nWAT:\n${result.wat}`);
  }
  // Use the runtime's buildImports for full host import support (iterator protocol, etc.)
  // Merge with the manual buildImports for wasm:js-string polyfill and string_constants.
  const manualImports = buildImports(result);
  let setInstanceFn: ((instance: WebAssembly.Instance) => void) | undefined;
  if (result.imports && result.imports.length > 0) {
    const runtimeResult = buildRuntimeImports(result.imports, undefined, result.stringPool);
    setInstanceFn = runtimeResult.setInstance;
    // Merge: runtime env overrides manual env, keep manual wasm:js-string and string_constants
    const mergedEnv = { ...(manualImports.env as Record<string, Function>), ...runtimeResult.env };
    manualImports.env = mergedEnv;
    // Use runtime string_constants if available
    if (runtimeResult.string_constants) {
      manualImports.string_constants = runtimeResult.string_constants;
    }
  }
  const { instance } = await WebAssembly.instantiate(result.binary, manualImports);
  // Set exports so runtime callbacks (iterator protocol, struct field getters) can access them
  setInstanceFn?.(instance);
  return instance.exports as Record<string, Function>;
}

/**
 * Transpile TS source to JS and evaluate it, returning exported functions.
 * Uses TypeScript's transpileModule to strip types, then evaluates as JS.
 */
export function evaluateAsJs(source: string): Record<string, Function> {
  const jsOutput = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });

  const exports: Record<string, unknown> = {};
  const module = { exports };
  const fn = new Function("exports", "module", "Math", jsOutput.outputText);
  fn(exports, module, Math);
  return exports as Record<string, Function>;
}

/**
 * Test that Wasm output matches native JS output for a set of inputs.
 */
export async function assertEquivalent(source: string, testCases: { fn: string; args: unknown[]; approx?: boolean }[]) {
  const wasmExports = await compileToWasm(source);
  const jsExports = evaluateAsJs(source);

  for (const { fn, args, approx } of testCases) {
    const wasmResult = wasmExports[fn]!(...args);
    const jsResult = jsExports[fn]!(...args);

    if (approx) {
      expect(wasmResult).toBeCloseTo(jsResult as number, 3);
    } else {
      expect(wasmResult).toBe(jsResult);
    }
  }
}

// Re-export for convenience
export { compile, readFileSync, resolve };
