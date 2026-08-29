// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Experimental compiler sidecar for the v8x js2wasm module-backend spike.
// v8x passes canonical module names plus untouched source files. This process
// keeps the TypeScript graph intact and emits one standalone WasmGC module.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { posix, resolve } from "node:path";
import { compileMultiSource } from "../../src/compiler.ts";
import type { CompileOptions } from "../../src/index.ts";
import { ts } from "../../src/ts-api.ts";

interface Options {
  entry: string;
  manifest: string;
  output: string;
  optimize?: 1 | 2 | 3 | 4;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("usage: compile-graph.ts --manifest FILE --entry URL --output FILE");
    }
    values.set(key.slice(2), value);
  }
  const manifest = values.get("manifest");
  const entry = values.get("entry");
  const output = values.get("output");
  if (!manifest || !entry || !output) {
    throw new Error("usage: compile-graph.ts --manifest FILE --entry URL --output FILE [--optimize 1|2|3|4]");
  }
  const rawOptimize = values.get("optimize");
  const optimize = rawOptimize === undefined ? undefined : Number(rawOptimize);
  if (optimize !== undefined && ![1, 2, 3, 4].includes(optimize)) {
    throw new Error("--optimize must be 1, 2, 3, or 4");
  }
  return { manifest, entry, output, optimize: optimize as 1 | 2 | 3 | 4 | undefined };
}

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

function scriptExtension(specifier: string): (typeof SCRIPT_EXTENSIONS)[number] {
  const pathname = (() => {
    try {
      return new URL(specifier).pathname;
    } catch {
      return specifier;
    }
  })();
  return SCRIPT_EXTENSIONS.find((extension) => pathname.endsWith(extension)) ?? ".js";
}

/**
 * Map an arbitrary canonical module name to an injective in-memory filename.
 *
 * `compileMulti`'s checker wants path-shaped keys, but Deno module names are
 * URLs and may use opaque schemes such as `ext:` or `custom:`. Base64url is an
 * injective encoding of the complete UTF-8 specifier, so unlike replacing URL
 * punctuation it cannot alias `ext:a/b.js` with (for example) `ext:a:b.js`.
 */
export function compilerPath(specifier: string): string {
  const encoded = Buffer.from(specifier, "utf8").toString("base64url");
  return `__v8x_graph/${encoded || "AA"}${scriptExtension(specifier)}`;
}

function resolveOpaqueRelative(specifier: string, referrer: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) {
    return undefined;
  }
  const scheme = /^([A-Za-z][A-Za-z\d+.-]*:)(.*)$/.exec(referrer);
  if (!scheme || scheme[2]!.startsWith("//")) return undefined;
  const tail = scheme[2]!;
  const resolvedTail = specifier.startsWith("/")
    ? posix.normalize(specifier).slice(1)
    : posix.normalize(posix.join(posix.dirname(tail), specifier));
  return `${scheme[1]}${resolvedTail}`;
}

/** Resolve an import exactly as far as the closed manifest allows. */
export function resolveManifestSpecifier(
  specifier: string,
  referrer: string,
  knownSpecifiers: ReadonlySet<string>,
): string | undefined {
  if (knownSpecifiers.has(specifier)) return specifier;

  try {
    const resolved = new URL(specifier, referrer).href;
    if (knownSpecifiers.has(resolved)) return resolved;
  } catch {
    // WHATWG URLs deliberately reject relative resolution against opaque
    // schemes. Deno's extension-module names still use path-like opaque tails.
  }

  const opaque = resolveOpaqueRelative(specifier, referrer);
  return opaque !== undefined && knownSpecifiers.has(opaque) ? opaque : undefined;
}

function importMetaStaticResolve(specifier: string, referrer: string): string | undefined {
  // Bare specifiers are loader policy, not URL resolution. They must remain a
  // runtime operation so a custom ModuleLoader can decide their meaning.
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) {
    try {
      return new URL(specifier).href;
    } catch {
      return undefined;
    }
  }
  try {
    return new URL(specifier, referrer).href;
  } catch {
    return resolveOpaqueRelative(specifier, referrer);
  }
}

function isImportMeta(node: ts.Node): node is ts.MetaProperty {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta";
}

interface LoweredSource {
  source: string;
  dynamicImports: number;
  runtimeDynamicImports: number;
}

export const GRAPH_DYNAMIC_IMPORT_RUNTIME_SPECIFIER = "v8x:graph-dynamic-import-runtime.ts";
export const GRAPH_DYNAMIC_IMPORT_POLL_EXPORT = "__v8x_poll_graph_dynamic_imports";
const GRAPH_DYNAMIC_IMPORT_POLL_IMPLEMENTATION = "__v8x_poll_graph_dynamic_imports_impl";

function graphDynamicImportRuntimeSource(): string {
  return (
    String.raw`
declare function __v8x_dynamic_import_begin(length: number): void;
declare function __v8x_dynamic_import_code_unit(index: number, value: number): void;
declare function __v8x_dynamic_import_end(): number;
declare function __v8x_dynamic_import_state(requestId: number): number;
declare function __v8x_dynamic_import_result_kind(requestId: number): number;
declare function __v8x_dynamic_import_result_utf16_length(requestId: number, field: number): number;
declare function __v8x_dynamic_import_result_utf16_code_unit(requestId: number, field: number, index: number): number;
declare function __v8x_dynamic_import_dispose(requestId: number): void;
declare function __v8x_deno_error_kind(): number;
declare function __v8x_deno_error_utf16_length(): number;
declare function __v8x_deno_error_utf16_code_unit(index: number): number;
declare function __v8x_graph_dynamic_import_result_prepare(requestId: number): number;
declare function __v8x_graph_dynamic_import_result_code_unit(index: number): number;
declare function __v8x_graph_app_call_begin(length: number): void;
declare function __v8x_graph_app_call_code_unit(index: number, value: number): void;
declare function __v8x_graph_app_call_end(): number;

const __v8x_graph_import_ids: number[] = [];
const __v8x_graph_import_resolves: any[] = [];
const __v8x_graph_import_rejects: any[] = [];
const __v8x_graph_import_active: boolean[] = [];
const __v8x_graph_app_handle_ids: number[] = [];
const __v8x_graph_app_handle_kinds: string[] = [];
const __v8x_graph_app_handle_values: any[] = [];
const __v8x_graph_error_values: any[] = [];
const __v8x_graph_error_names: string[] = [];
const __v8x_graph_error_messages: string[] = [];
const __v8x_graph_error_stacks: string[] = [];

function __v8x_graph_json_quote(value: string): string {
  let result = '"';
  const slash = "\\";
  const digits = "0123456789abcdef";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34) result += slash + '"';
    else if (code === 92) result += slash + slash;
    else if (code === 8) result += slash + "b";
    else if (code === 9) result += slash + "t";
    else if (code === 10) result += slash + "n";
    else if (code === 12) result += slash + "f";
    else if (code === 13) result += slash + "r";
    else if (code < 32) {
      result += slash + "u" + digits[(code >>> 12) & 15] +
        digits[(code >>> 8) & 15] + digits[(code >>> 4) & 15] +
        digits[code & 15];
    } else result += value[index];
  }
  return result + '"';
}
` + graphDynamicImportRuntimeSourceTail()
  );
}

function graphDynamicImportLocalSource(prefix: string, runtimeBinding: string, localBinding: string): string {
  return String.raw`
declare function __v8x_graph_dynamic_import_result_code_unit(index: number): number;
declare function __v8x_graph_app_call_begin(length: number): void;
declare function __v8x_graph_app_call_code_unit(index: number, value: number): void;
declare function __v8x_graph_app_call_end(): number;
const ${prefix}_handle_ids: number[] = [];
const ${prefix}_handle_values: any[] = [];
const ${prefix}_error_values: any[] = [];
const ${prefix}_error_names: string[] = [];
const ${prefix}_error_messages: string[] = [];
const ${prefix}_error_stacks: string[] = [];

function ${prefix}_quote(value: string): string {
  let result = '"';
  const slash = "\\";
  const digits = "0123456789abcdef";
  for (let cursor = 0; cursor < value.length; cursor++) {
    const code = value.charCodeAt(cursor);
    if (code === 34) result += slash + '"';
    else if (code === 92) result += slash + slash;
    else if (code === 8) result += slash + "b";
    else if (code === 9) result += slash + "t";
    else if (code === 10) result += slash + "n";
    else if (code === 12) result += slash + "f";
    else if (code === 13) result += slash + "r";
    else if (code < 32) {
      result += slash + "u" + digits[(code >>> 12) & 15] +
        digits[(code >>> 8) & 15] + digits[(code >>> 4) & 15] + digits[code & 15];
    } else result += value[cursor];
  }
  return result + '"';
}

function ${prefix}_error(name: string, message: string, stack: string): Error {
  let error: any;
  if (name === "EvalError") error = new EvalError(message);
  else if (name === "RangeError") error = new RangeError(message);
  else if (name === "ReferenceError") error = new ReferenceError(message);
  else if (name === "SyntaxError") error = new SyntaxError(message);
  else if (name === "TypeError") error = new TypeError(message);
  else if (name === "URIError") error = new URIError(message);
  else if (name === "AggregateError") error = new AggregateError([], message);
  else error = new Error(message);
  error.name = name === "" ? "Error" : name;
  if (stack !== "") {
    Object.defineProperty(error, "stack", {
      value: stack,
      writable: true,
      configurable: true,
    });
  }
  ${prefix}_error_values.push(error);
  ${prefix}_error_names.push(error.name);
  ${prefix}_error_messages.push(message);
  ${prefix}_error_stacks.push(stack);
  return error;
}

function ${prefix}_handle_value(handle: number): any {
  for (let cursor = 0; cursor < ${prefix}_handle_ids.length; cursor++) {
    if (${prefix}_handle_ids[cursor] === handle) return ${prefix}_handle_values[cursor];
  }
  return undefined;
}

function ${prefix}_register_handle(handle: number, value: any): any {
  const existing = ${prefix}_handle_value(handle);
  if (existing !== undefined) return existing;
  ${prefix}_handle_ids.push(handle);
  ${prefix}_handle_values.push(value);
  return value;
}

function ${prefix}_handle(value: any): number {
  for (let cursor = 0; cursor < ${prefix}_handle_values.length; cursor++) {
    if (${prefix}_handle_values[cursor] === value) return ${prefix}_handle_ids[cursor];
  }
  return 0;
}

function ${prefix}_number(value: number): string {
  if (value !== value) return '["d","nan"]';
  if (value === Infinity) return '["d","+inf"]';
  if (value === -Infinity) return '["d","-inf"]';
  if (value === 0 && 1 / value === -Infinity) return '["d","-0"]';
  return '["d",' + String(value) + ']';
}

function ${prefix}_encode(value: any, seen: any): string {
  if (value === undefined) return '["u"]';
  if (value === null) return '["l"]';
  const type = typeof value;
  if (type === "boolean") return '["b",' + (value ? "true" : "false") + ']';
  if (type === "number") return ${prefix}_number(value);
  if (type === "string") return '["s",' + ${prefix}_quote(value) + ']';
  if (type === "bigint") return '["i",' + ${prefix}_quote(String(value)) + ']';
  for (let cursor = 0; cursor < ${prefix}_error_values.length; cursor++) {
    if (${prefix}_error_values[cursor] !== value) continue;
    return '["e",' + ${prefix}_quote(${prefix}_error_names[cursor]) + ',' +
      ${prefix}_quote(${prefix}_error_messages[cursor]) + ',' +
      ${prefix}_quote(${prefix}_error_stacks[cursor]) + ']';
  }
  const appHandle = ${prefix}_handle(value);
  if (appHandle !== 0) {
    return '["h",' + ${prefix}_quote(type === "function" ? "function" : "object") +
      ',' + String(appHandle) + ']';
  }
  if (type === "function" || type === "symbol") {
    throw new TypeError("source graph values cannot cross into an app callable");
  }
  let name = "";
  let message = "";
  let stack = "";
  try {
    name = typeof value.name === "string" ? value.name : "";
    message = typeof value.message === "string" ? value.message : "";
    stack = typeof value.stack === "string" ? value.stack : "";
  } catch (_error) {}
  if (
    name === "Error" || name === "EvalError" || name === "RangeError" ||
    name === "ReferenceError" || name === "SyntaxError" ||
    name === "TypeError" || name === "URIError" || name === "AggregateError"
  ) {
    return '["e",' + ${prefix}_quote(name) + ',' + ${prefix}_quote(message) +
      ',' + ${prefix}_quote(stack) + ']';
  }
  for (let cursor = 0; cursor < seen.length; cursor++) {
    if (seen[cursor] === value) throw new TypeError("cyclic source graph call argument");
  }
  seen.push(value);
  if (value instanceof Array || Array.isArray(value)) {
    let encoded = '["a",[';
    for (let cursor = 0; cursor < value.length; cursor++) {
      if (cursor !== 0) encoded += ',';
      encoded += ${prefix}_encode(value[cursor], seen);
    }
    seen.pop();
    return encoded + ']]';
  }
  let encoded = '["o",[';
  let first = true;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (!first) encoded += ',';
    first = false;
    encoded += '[' + ${prefix}_quote(key) + ',' + ${prefix}_encode(value[key], seen) + ']';
  }
  seen.pop();
  return encoded + ']]';
}

function ${prefix}_result_text(length: number): string {
  let packet = "";
  for (let cursor = 0; cursor < length; cursor++) {
    packet += String.fromCharCode(__v8x_graph_dynamic_import_result_code_unit(cursor));
  }
  return packet;
}

function ${prefix}_write_call_unit(index: any, value: any): void {
  __v8x_graph_app_call_code_unit(Number(index), Number(value));
}

function ${prefix}_call(handle: number, receiver: any, args: any): any {
  const request = '[' + String(handle) + ',' + ${prefix}_encode(receiver, []) +
    ',' + ${prefix}_encode(args, []) + ']';
  __v8x_graph_app_call_begin(request.length);
  for (let cursor = 0; cursor < request.length; cursor++) {
    ${prefix}_write_call_unit(cursor, request.charCodeAt(cursor));
  }
  const packet: any = JSON.parse(${prefix}_result_text(__v8x_graph_app_call_end()));
  const result = ${prefix}_decode(packet[1]);
  if (packet[0] === "r") return result;
  if (packet[0] === "e") throw result;
  throw new TypeError("source graph app call returned an invalid outcome");
}

function ${prefix}_decode(value: any): any {
  if (!(value instanceof Array) || value.length === 0) {
    throw new TypeError("source graph dynamic import returned an invalid wire value");
  }
  const tag = value[0];
  if (tag === "u") return undefined;
  if (tag === "l") return null;
  if (tag === "b" || tag === "s") return value[1];
  if (tag === "d") {
    if (value[1] === "nan") return NaN;
    if (value[1] === "+inf") return Infinity;
    if (value[1] === "-inf") return -Infinity;
    if (value[1] === "-0") return -0;
    return value[1];
  }
  if (tag === "i") return BigInt(value[1]);
  if (tag === "a") {
    const result: any[] = [];
    for (let cursor = 0; cursor < value[1].length; cursor++) {
      result.push(${prefix}_decode(value[1][cursor]));
    }
    return result;
  }
  if (tag === "o") {
    const result: any = {};
    for (let cursor = 0; cursor < value[1].length; cursor++) {
      const entry = value[1][cursor];
      result[entry[0]] = ${prefix}_decode(entry[1]);
    }
    return result;
  }
  if (tag === "e") return ${prefix}_error(value[1], value[2], value[3]);
  if (tag === "h") {
    const handle = value[2];
    const existing = ${prefix}_handle_value(handle);
    if (existing !== undefined) return existing;
    if (value[1] === "function") {
      const callable = function(this: any, ...args: any[]): any {
        return ${prefix}_call(handle, this, args);
      };
      return ${prefix}_register_handle(handle, callable);
    }
    return ${prefix}_register_handle(handle, {});
  }
  if (tag === "n") {
    const handle = value[1];
    const existing = ${prefix}_handle_value(handle);
    if (existing !== undefined) return existing;
    return ${prefix}_register_handle(handle, ${prefix}_decode(value[2]));
  }
  throw new TypeError("source graph dynamic import returned an unknown wire tag");
}

function ${localBinding}(packetText: any): any {
  const packet: any = JSON.parse(String(packetText));
  if (!(packet instanceof Array) || packet.length !== 2) {
    throw new TypeError("source graph dynamic import returned an invalid outcome");
  }
  const value = ${prefix}_decode(packet[1]);
  if (packet[0] === "r") return value;
  if (packet[0] === "e") throw value;
  throw new TypeError("source graph dynamic import returned an unknown outcome");
}
`;
}

function graphDynamicImportRuntimeSourceTail(): string {
  return String.raw`
function __v8x_graph_bridge_error(): Error | undefined {
  const kind = __v8x_deno_error_kind();
  if (kind === 0) return undefined;
  let message = "";
  const length = __v8x_deno_error_utf16_length();
  for (let index = 0; index < length; index++) {
    message += String.fromCharCode(__v8x_deno_error_utf16_code_unit(index));
  }
  return kind === 1 ? new TypeError(message) : new Error(message);
}

function __v8x_graph_error(name: string, message: string, stack: string): Error {
  let error: any;
  if (name === "EvalError") error = new EvalError(message);
  else if (name === "RangeError") error = new RangeError(message);
  else if (name === "ReferenceError") error = new ReferenceError(message);
  else if (name === "SyntaxError") error = new SyntaxError(message);
  else if (name === "TypeError") error = new TypeError(message);
  else if (name === "URIError") error = new URIError(message);
  else if (name === "AggregateError") error = new AggregateError([], message);
  else error = new Error(message);
  error.name = name === "" ? "Error" : name;
  if (stack !== "") {
    Object.defineProperty(error, "stack", {
      value: stack,
      writable: true,
      configurable: true,
    });
  }
  __v8x_graph_error_values.push(error);
  __v8x_graph_error_names.push(error.name);
  __v8x_graph_error_messages.push(message);
  __v8x_graph_error_stacks.push(stack);
  return error;
}

function __v8x_graph_app_handle_value(handle: number): any {
  for (let index = 0; index < __v8x_graph_app_handle_ids.length; index++) {
    if (__v8x_graph_app_handle_ids[index] === handle) {
      return __v8x_graph_app_handle_values[index];
    }
  }
  return undefined;
}

function __v8x_graph_register_app_handle(handle: number, kind: string, value: any): any {
  const existing = __v8x_graph_app_handle_value(handle);
  if (existing !== undefined) return existing;
  __v8x_graph_app_handle_ids.push(handle);
  __v8x_graph_app_handle_kinds.push(kind);
  __v8x_graph_app_handle_values.push(value);
  return value;
}

function __v8x_graph_app_handle(value: any): number {
  for (let index = 0; index < __v8x_graph_app_handle_values.length; index++) {
    if (__v8x_graph_app_handle_values[index] === value) {
      return __v8x_graph_app_handle_ids[index];
    }
  }
  return 0;
}

function __v8x_graph_number_packet(value: number): string {
  if (value !== value) return '["d","nan"]';
  if (value === Infinity) return '["d","+inf"]';
  if (value === -Infinity) return '["d","-inf"]';
  if (value === 0 && 1 / value === -Infinity) return '["d","-0"]';
  return '["d",' + String(value) + ']';
}

function __v8x_graph_encode(value: any, seen: any): string {
  if (value === undefined) return '["u"]';
  if (value === null) return '["l"]';
  const type = typeof value;
  if (type === "boolean") return '["b",' + (value ? "true" : "false") + ']';
  if (type === "number") return __v8x_graph_number_packet(value);
  if (type === "string") return '["s",' + __v8x_graph_json_quote(value) + ']';
  if (type === "bigint") return '["i",' + __v8x_graph_json_quote(String(value)) + ']';
  for (let index = 0; index < __v8x_graph_error_values.length; index++) {
    if (__v8x_graph_error_values[index] !== value) continue;
    return '["e",' + __v8x_graph_json_quote(__v8x_graph_error_names[index]) + ',' +
      __v8x_graph_json_quote(__v8x_graph_error_messages[index]) + ',' +
      __v8x_graph_json_quote(__v8x_graph_error_stacks[index]) + ']';
  }
  const appHandle = __v8x_graph_app_handle(value);
  if (appHandle !== 0) {
    const kind = type === "function" ? "function" : "object";
    return '["h",' + __v8x_graph_json_quote(kind) + ',' + String(appHandle) + ']';
  }
  if (type === "function" || type === "symbol") {
    throw new TypeError("source graph values cannot cross into an app callable");
  }
  let name = "";
  let message = "";
  let stack = "";
  try {
    name = typeof value.name === "string" ? value.name : "";
    message = typeof value.message === "string" ? value.message : "";
    stack = typeof value.stack === "string" ? value.stack : "";
  } catch (_error) {}
  if (
    name === "Error" || name === "EvalError" || name === "RangeError" ||
    name === "ReferenceError" || name === "SyntaxError" ||
    name === "TypeError" || name === "URIError" || name === "AggregateError"
  ) {
    return '["e",' + __v8x_graph_json_quote(name) + ',' +
      __v8x_graph_json_quote(message) + ',' + __v8x_graph_json_quote(stack) + ']';
  }
  for (let index = 0; index < seen.length; index++) {
    if (seen[index] === value) throw new TypeError("cyclic source graph call argument");
  }
  seen.push(value);
  if (value instanceof Array || Array.isArray(value)) {
    let encoded = '["a",[';
    for (let index = 0; index < value.length; index++) {
      if (index !== 0) encoded += ',';
      encoded += __v8x_graph_encode(value[index], seen);
    }
    seen.pop();
    return encoded + ']]';
  }
  let encoded = '["o",[';
  let first = true;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (!first) encoded += ',';
    first = false;
    encoded += '[' + __v8x_graph_json_quote(key) + ',' +
      __v8x_graph_encode(value[key], seen) + ']';
  }
  seen.pop();
  return encoded + ']]';
}

function __v8x_graph_result_text(length: number): string {
  if (length < 0 || length > 9007199254740991 || Math.floor(length) !== length) {
    throw new RangeError("source graph host returned an invalid packet length");
  }
  let packet = "";
  for (let index = 0; index < length; index++) {
    packet += String.fromCharCode(__v8x_graph_dynamic_import_result_code_unit(index));
  }
  return packet;
}

// Keep the string-loop cursor in JS2's integer representation. Passing that
// cursor directly to an f64 host import makes the local inference straddle
// string indexing and the scalar ABI, which can otherwise emit an invalid
// f64-to-f64 conversion in the standalone backend.
function __v8x_graph_write_app_call_unit(index: any, value: any): void {
  __v8x_graph_app_call_code_unit(Number(index), Number(value));
}

function __v8x_graph_write_import_unit(index: any, value: any): void {
  __v8x_dynamic_import_code_unit(Number(index), Number(value));
}

function __v8x_graph_call_app_handle(handle: number, receiver: any, args: any): any {
  const request = '[' + String(handle) + ',' +
    __v8x_graph_encode(receiver, []) + ',' + __v8x_graph_encode(args, []) + ']';
  __v8x_graph_app_call_begin(request.length);
  for (let index = 0; index < request.length; index++) {
    __v8x_graph_write_app_call_unit(index, request.charCodeAt(index));
  }
  const packet: any = JSON.parse(__v8x_graph_result_text(__v8x_graph_app_call_end()));
  if (!(packet instanceof Array) || packet.length !== 2) {
    throw new TypeError("source graph app call returned an invalid packet");
  }
  const value = __v8x_graph_decode(packet[1]);
  if (packet[0] === "r") return value;
  if (packet[0] === "e") throw value;
  throw new TypeError("source graph app call returned an unknown outcome");
}

function __v8x_graph_decode(value: any): any {
  if (!(value instanceof Array) || value.length === 0) {
    throw new TypeError("source graph dynamic import returned an invalid wire value");
  }
  const tag = value[0];
  if (tag === "u") return undefined;
  if (tag === "l") return null;
  if (tag === "b" || tag === "s") return value[1];
  if (tag === "d") {
    if (value[1] === "nan") return NaN;
    if (value[1] === "+inf") return Infinity;
    if (value[1] === "-inf") return -Infinity;
    if (value[1] === "-0") return -0;
    return value[1];
  }
  if (tag === "i") return BigInt(value[1]);
  if (tag === "a") {
    const result: any[] = [];
    for (let index = 0; index < value[1].length; index++) {
      result.push(__v8x_graph_decode(value[1][index]));
    }
    return result;
  }
  if (tag === "o") {
    const result: any = {};
    for (let index = 0; index < value[1].length; index++) {
      const entry = value[1][index];
      result[entry[0]] = __v8x_graph_decode(entry[1]);
    }
    return result;
  }
  if (tag === "e") return __v8x_graph_error(value[1], value[2], value[3]);
  if (tag === "h") {
    const kind = value[1];
    const handle = value[2];
    const existing = __v8x_graph_app_handle_value(handle);
    if (existing !== undefined) return existing;
    if (kind === "function") {
      const callable = function(this: any): any {
        const args: any[] = [];
        for (let index = 0; index < arguments.length; index++) args.push(arguments[index]);
        return __v8x_graph_call_app_handle(handle, this, args);
      };
      return __v8x_graph_register_app_handle(handle, kind, callable);
    }
    return __v8x_graph_register_app_handle(handle, kind, {});
  }
  if (tag === "n") {
    const handle = value[1];
    const existing = __v8x_graph_app_handle_value(handle);
    if (existing !== undefined) return existing;
    return __v8x_graph_register_app_handle(handle, "object", __v8x_graph_decode(value[2]));
  }
  throw new TypeError("source graph dynamic import returned an unknown wire tag");
}

function __v8x_graph_attributes(options: any): string {
  if (options === undefined) return "[]";
  if (options === null || (typeof options !== "object" && typeof options !== "function")) {
    throw new TypeError("dynamic import options must be an object");
  }
  const attributes = options.with;
  if (attributes === undefined) return "[]";
  if (attributes === null || (typeof attributes !== "object" && typeof attributes !== "function")) {
    throw new TypeError("dynamic import attributes must be an object");
  }
  let packet = "[";
  let first = true;
  const keys = Object.keys(attributes);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const value = attributes[key];
    if (typeof value !== "string") {
      throw new TypeError("dynamic import attribute values must be strings");
    }
    if (!first) packet += ",";
    first = false;
    packet += "[" + __v8x_graph_json_quote(key) + "," +
      __v8x_graph_json_quote(value) + "]";
  }
  return packet + "]";
}

function __v8x_graph_rejection_packet(requestId: number): string {
  const fields: string[] = [];
  for (let field = 0; field < 3; field++) {
    const length = __v8x_dynamic_import_result_utf16_length(requestId, field);
    let value = "";
    for (let index = 0; index < length; index++) {
      value += String.fromCharCode(
        __v8x_dynamic_import_result_utf16_code_unit(requestId, field, index),
      );
    }
    fields.push(value);
  }
  return '["e",' + __v8x_graph_json_quote(fields[0]) + ',' +
    __v8x_graph_json_quote(fields[1]) + ',' +
    __v8x_graph_json_quote(fields[2]) + ']';
}

function __v8x_graph_poll_one(index: number): void {
  if (!__v8x_graph_import_active[index]) return;
  const requestId = __v8x_graph_import_ids[index];
  const state = __v8x_dynamic_import_state(requestId);
  if (state === 0) return;
  let fulfilled = state === 1;
  let encodedResult = '["u"]';
  try {
    if (fulfilled) {
      const kind = __v8x_dynamic_import_result_kind(requestId);
      if (kind !== 1) throw new TypeError("dynamic import fulfillment has an invalid result kind");
      encodedResult = __v8x_graph_result_text(
        __v8x_graph_dynamic_import_result_prepare(requestId),
      );
    } else if (state === 2) {
      encodedResult = __v8x_graph_rejection_packet(requestId);
    } else {
      throw new RangeError("dynamic import host returned an invalid state");
    }
  } catch (error) {
    fulfilled = false;
    encodedResult = __v8x_graph_encode(error, []);
  }
  try {
    __v8x_dynamic_import_dispose(requestId);
  } catch (error) {
    fulfilled = false;
    encodedResult = __v8x_graph_encode(error, []);
  }
  __v8x_graph_import_active[index] = false;
  const callback: any = __v8x_graph_import_resolves[index];
  callback(
    fulfilled
      ? '["r",' + encodedResult + ']'
      : '["e",' + encodedResult + ']',
  );
}

export function __v8x_graph_runtime_dynamic_import(
  specifier: string,
  options: any,
  referrer: string,
): Promise<any> {
  let resolveCallback: any = undefined;
  let rejectCallback: any = undefined;
  const promise = new Promise((resolve: any, reject: any) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  try {
    const request = "[" + __v8x_graph_json_quote(specifier) + "," +
      __v8x_graph_json_quote(referrer) + ",0," +
      __v8x_graph_attributes(options) + "]";
    __v8x_dynamic_import_begin(request.length);
    for (let codeUnitIndex = 0; codeUnitIndex < request.length; codeUnitIndex++) {
      __v8x_graph_write_import_unit(
        codeUnitIndex,
        request.charCodeAt(codeUnitIndex),
      );
    }
    const requestId = __v8x_dynamic_import_end();
    if (requestId === 0) {
      const error = __v8x_graph_bridge_error();
      throw error === undefined ? new Error("dynamic import host rejected the request") : error;
    }
    const queueIndex = __v8x_graph_import_ids.length;
    __v8x_graph_import_ids.push(requestId);
    __v8x_graph_import_resolves.push(resolveCallback);
    __v8x_graph_import_rejects.push(rejectCallback);
    __v8x_graph_import_active.push(true);
    __v8x_graph_poll_one(queueIndex);
  } catch (error) {
    resolveCallback('["e",' + __v8x_graph_encode(error, []) + ']');
  }
  return promise;
}

export function __v8x_poll_graph_dynamic_imports_impl(): void {
  for (let index = 0; index < __v8x_graph_import_ids.length; index++) {
    __v8x_graph_poll_one(index);
  }
}
`;
}

function declarationBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) declarationBindingNames(element.name, names);
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function collectManifestExportNames(
  specifier: string,
  modules: ReadonlyMap<string, string>,
  seen = new Set<string>(),
): string[] {
  if (seen.has(specifier)) return [];
  seen.add(specifier);
  const source = modules.get(specifier);
  if (source === undefined) return [];
  const sourceFile = ts.createSourceFile(
    compilerPath(specifier),
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        names.add(statement.exportClause.name.text);
      } else if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const target = resolveManifestSpecifier(statement.moduleSpecifier.text, specifier, new Set(modules.keys()));
        if (target !== undefined) {
          for (const name of collectManifestExportNames(target, modules, seen)) {
            if (name !== "default") names.add(name);
          }
        }
      }
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      names.add("default");
      continue;
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        declarationBindingNames(declaration.name, names);
      }
    }
  }
  return Array.from(names).sort();
}

/**
 * Statically lower module-record facts known from the complete manifest.
 *
 * A literal internal `import()` becomes a namespace import plus
 * `Promise.resolve(namespace)`. This preserves the Promise/namespace value and
 * lets compileMulti's existing dependency ordering evaluate the target once.
 * Unknown targets remain dynamic and retain the compiler's fail-loud policy.
 */
export function lowerManifestModule(
  source: string,
  specifier: string,
  entrySpecifier: string,
  modules: ReadonlyMap<string, string>,
): LoweredSource {
  const knownSpecifiers = new Set(modules.keys());
  const sourceFile = ts.createSourceFile(
    compilerPath(specifier),
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const namespaceImports = new Map<
    string,
    {
      identifier: ts.Identifier;
      request: string;
      bindings: Array<{ exported: string; local: ts.Identifier }>;
      materialize: boolean;
    }
  >();
  const staticallyReadNamespaces = new Map<string, ReadonlyMap<string, ts.Identifier>>();
  let dynamicImports = 0;
  let runtimeDynamicImports = 0;
  const defaultExportBinding = `__v8x_default_${Buffer.from(specifier, "utf8").toString("hex")}`;
  // Use an injective suffix so the generated module-local bridge cannot
  // collide with another source module's helpers when compileMulti flattens
  // the graph. The prefix is deliberately not a createUniqueName: the same
  // spelling is also interpolated into the generated helper source below.
  const runtimeDynamicImportSuffix = Buffer.from(specifier, "utf8").toString("hex") || "00";
  const runtimeDynamicImportBindingName = `__v8x_runtime_dynamic_import_${runtimeDynamicImportSuffix}`;
  const localDynamicImportBindingName = `__v8x_local_dynamic_import_${runtimeDynamicImportSuffix}`;
  const localDynamicImportPrefix = `__v8x_local_dynamic_${runtimeDynamicImportSuffix}`;

  const transformed = ts.transform(sourceFile, [
    (context) => {
      const { factory } = context;
      const runtimeDynamicImport = factory.createIdentifier(runtimeDynamicImportBindingName);
      const localDynamicImport = factory.createIdentifier(localDynamicImportBindingName);
      const runtimeImportCall = (node: ts.CallExpression): ts.CallExpression =>
        factory.createCallExpression(runtimeDynamicImport, undefined, [
          factory.createCallExpression(factory.createIdentifier("String"), undefined, [
            ts.visitNode(node.arguments[0]!, visitor) as ts.Expression,
          ]),
          node.arguments[1]
            ? (ts.visitNode(node.arguments[1]!, visitor) as ts.Expression)
            : factory.createIdentifier("undefined"),
          factory.createStringLiteral(specifier),
        ]);
      const namespaceFor = (request: string): ts.Identifier | undefined => {
        const target = resolveManifestSpecifier(request, specifier, knownSpecifiers);
        if (target === undefined) return undefined;
        let namespace = namespaceImports.get(target);
        if (namespace === undefined) {
          namespace = {
            identifier: factory.createUniqueName("__v8x_dynamic_namespace"),
            request,
            bindings: collectManifestExportNames(target, modules).map((exported) => ({
              exported,
              local: factory.createUniqueName(
                `__v8x_dynamic_${exported === "default" ? "default" : exported.replaceAll(/[^A-Za-z\d_$]/g, "_")}`,
              ),
            })),
            materialize: true,
          };
          namespaceImports.set(target, namespace);
        }
        dynamicImports++;
        return namespace.identifier;
      };
      const visitor: ts.Visitor = (node) => {
        if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
          const declaration = node.declarationList.declarations[0]!;
          const awaited = declaration.initializer;
          if (
            awaited &&
            ts.isAwaitExpression(awaited) &&
            ts.isCallExpression(awaited.expression) &&
            awaited.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
            awaited.expression.arguments.length >= 1 &&
            awaited.expression.arguments.length <= 2 &&
            !(
              ts.isStringLiteralLike(awaited.expression.arguments[0]!) &&
              resolveManifestSpecifier(awaited.expression.arguments[0]!.text, specifier, knownSpecifiers) !== undefined
            )
          ) {
            // Keep the awaited carrier scalar. JS2's module async frame can
            // resume a tagged JSON string exactly, after which this consuming
            // module constructs the namespace synchronously and assigns it to
            // the original binding. Returning the object from an async helper
            // would erase its WasmGC RTT before the continuation reads it.
            runtimeDynamicImports++;
            const packet = factory.createUniqueName("__v8x_runtime_dynamic_packet");
            const packetStatement = factory.createVariableStatement(
              undefined,
              factory.createVariableDeclarationList(
                [
                  factory.createVariableDeclaration(
                    packet,
                    undefined,
                    undefined,
                    factory.createAwaitExpression(runtimeImportCall(awaited.expression)),
                  ),
                ],
                ts.NodeFlags.Const,
              ),
            );
            const decodedStatement = factory.updateVariableStatement(
              node,
              node.modifiers,
              factory.updateVariableDeclarationList(node.declarationList, [
                factory.updateVariableDeclaration(
                  declaration,
                  declaration.name,
                  declaration.exclamationToken,
                  declaration.type,
                  factory.createCallExpression(localDynamicImport, undefined, [packet]),
                ),
              ]),
            );
            return [packetStatement, decodedStatement];
          }
        }

        if (
          ts.isExpressionStatement(node) &&
          ts.isAwaitExpression(node.expression) &&
          ts.isCallExpression(node.expression.expression) &&
          node.expression.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.expression.expression.arguments.length >= 1 &&
          node.expression.expression.arguments.length <= 2 &&
          !(
            ts.isStringLiteralLike(node.expression.expression.arguments[0]!) &&
            resolveManifestSpecifier(node.expression.expression.arguments[0]!.text, specifier, knownSpecifiers) !==
              undefined
          )
        ) {
          runtimeDynamicImports++;
          const packet = factory.createUniqueName("__v8x_runtime_dynamic_packet");
          return [
            factory.createVariableStatement(
              undefined,
              factory.createVariableDeclarationList(
                [
                  factory.createVariableDeclaration(
                    packet,
                    undefined,
                    undefined,
                    factory.createAwaitExpression(runtimeImportCall(node.expression.expression)),
                  ),
                ],
                ts.NodeFlags.Const,
              ),
            ),
            factory.createExpressionStatement(factory.createCallExpression(localDynamicImport, undefined, [packet])),
          ];
        }

        if (
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.length === 1 &&
          ts.isArrayBindingPattern(node.declarationList.declarations[0]!.name) &&
          node.declarationList.declarations[0]!.initializer &&
          ts.isAwaitExpression(node.declarationList.declarations[0]!.initializer!)
        ) {
          const declaration = node.declarationList.declarations[0]!;
          const bindingElements = declaration.name.elements;
          const awaited = declaration.initializer!.expression;
          if (
            ts.isCallExpression(awaited) &&
            ts.isPropertyAccessExpression(awaited.expression) &&
            ts.isIdentifier(awaited.expression.expression) &&
            awaited.expression.expression.text === "Promise" &&
            awaited.expression.name.text === "all" &&
            awaited.arguments.length === 1 &&
            ts.isArrayLiteralExpression(awaited.arguments[0]!) &&
            awaited.arguments[0]!.elements.length === bindingElements.length
          ) {
            const requests: string[] = [];
            let supported = true;
            for (let index = 0; index < bindingElements.length; index++) {
              const binding = bindingElements[index]!;
              const element = awaited.arguments[0]!.elements[index]!;
              if (
                ts.isOmittedExpression(binding) ||
                binding.dotDotDotToken ||
                binding.initializer ||
                !ts.isIdentifier(binding.name) ||
                ts.isSpreadElement(element) ||
                !ts.isCallExpression(element) ||
                element.expression.kind !== ts.SyntaxKind.ImportKeyword ||
                element.arguments.length !== 1 ||
                !ts.isStringLiteralLike(element.arguments[0]!) ||
                resolveManifestSpecifier(element.arguments[0]!.text, specifier, knownSpecifiers) === undefined
              ) {
                supported = false;
                break;
              }
              requests.push(element.arguments[0]!.text);
            }
            if (supported) {
              const namespaceIdentifiers = requests.map((request) => namespaceFor(request)!);
              for (let index = 0; index < bindingElements.length; index++) {
                const binding = bindingElements[index] as ts.BindingElement;
                const namespace = Array.from(namespaceImports.values()).find(
                  (candidate) => candidate.identifier === namespaceIdentifiers[index],
                )!;
                namespace.materialize = false;
                staticallyReadNamespaces.set(
                  (binding.name as ts.Identifier).text,
                  new Map(namespace.bindings.map(({ exported, local }) => [exported, local])),
                );
              }
              return factory.createEmptyStatement();
            }
          }
        }

        if (
          ts.isAwaitExpression(node) &&
          ts.isCallExpression(node.expression) &&
          ts.isPropertyAccessExpression(node.expression.expression) &&
          ts.isIdentifier(node.expression.expression.expression) &&
          node.expression.expression.expression.text === "Promise" &&
          node.expression.expression.name.text === "all" &&
          node.expression.arguments.length === 1 &&
          ts.isArrayLiteralExpression(node.expression.arguments[0]!)
        ) {
          const namespaces: ts.Identifier[] = [];
          for (const element of node.expression.arguments[0]!.elements) {
            if (
              ts.isSpreadElement(element) ||
              !ts.isCallExpression(element) ||
              element.expression.kind !== ts.SyntaxKind.ImportKeyword ||
              element.arguments.length !== 1 ||
              !ts.isStringLiteralLike(element.arguments[0]!)
            ) {
              namespaces.length = 0;
              break;
            }
            const namespace = namespaceFor(element.arguments[0]!.text);
            if (namespace === undefined) {
              namespaces.length = 0;
              break;
            }
            namespaces.push(namespace);
          }
          // All targets are already eagerly evaluated by the closed graph, so
          // awaiting Promise.all(import(...)) is exactly the namespace tuple.
          if (namespaces.length === node.expression.arguments[0]!.elements.length) {
            return factory.createArrayLiteralExpression(namespaces);
          }
        }

        if (
          ts.isAwaitExpression(node) &&
          ts.isCallExpression(node.expression) &&
          node.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.expression.arguments.length === 1 &&
          ts.isStringLiteralLike(node.expression.arguments[0]!)
        ) {
          const namespace = namespaceFor(node.expression.arguments[0]!.text);
          // The complete manifest has already made the target an eagerly
          // evaluated dependency. Returning its namespace directly is the
          // synchronous equivalent of awaiting the fulfilled import Promise,
          // and avoids manufacturing a top-level async state machine.
          if (namespace !== undefined) return namespace;
        }

        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length >= 1 &&
          node.arguments.length <= 2
        ) {
          if (ts.isStringLiteralLike(node.arguments[0]!)) {
            const request = node.arguments[0]!.text;
            const namespace = namespaceFor(request);
            if (namespace !== undefined) {
              return factory.createCallExpression(
                factory.createPropertyAccessExpression(factory.createIdentifier("Promise"), "resolve"),
                undefined,
                [namespace],
              );
            }
          }
          runtimeDynamicImports++;
          const pendingPacket = runtimeImportCall(node);
          return factory.createCallExpression(
            factory.createPropertyAccessExpression(pendingPacket, "then"),
            undefined,
            [localDynamicImport],
          );
        }

        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
          const binding = staticallyReadNamespaces.get(node.expression.text)?.get(node.name.text);
          if (binding !== undefined) return binding;
        }
        if (
          ts.isElementAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.argumentExpression &&
          ts.isStringLiteralLike(node.argumentExpression)
        ) {
          const binding = staticallyReadNamespaces.get(node.expression.text)?.get(node.argumentExpression.text);
          if (binding !== undefined) return binding;
        }

        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          isImportMeta(node.expression.expression) &&
          node.expression.name.text === "resolve" &&
          node.arguments.length === 1 &&
          ts.isStringLiteralLike(node.arguments[0]!)
        ) {
          const resolved = importMetaStaticResolve(node.arguments[0]!.text, specifier);
          if (resolved !== undefined) return factory.createStringLiteral(resolved);
        }

        if (ts.isPropertyAccessExpression(node) && isImportMeta(node.expression)) {
          if (node.name.text === "url") return factory.createStringLiteral(specifier);
          if (node.name.text === "main")
            return specifier === entrySpecifier ? factory.createTrue() : factory.createFalse();
        }

        return ts.visitEachChild(node, visitor, context);
      };
      return (root) => {
        const visited = ts.visitNode(root, visitor) as ts.SourceFile;
        const normalizedStatements: ts.Statement[] = [];
        for (const statement of visited.statements) {
          if (ts.isExportAssignment(statement) && !statement.isExportEquals && !ts.isIdentifier(statement.expression)) {
            const binding = factory.createIdentifier(defaultExportBinding);
            normalizedStatements.push(
              factory.createVariableStatement(
                undefined,
                factory.createVariableDeclarationList(
                  [factory.createVariableDeclaration(binding, undefined, undefined, statement.expression)],
                  ts.NodeFlags.Const,
                ),
              ),
              factory.updateExportAssignment(statement, statement.modifiers, binding),
            );
          } else {
            normalizedStatements.push(statement);
          }
        }
        const normalized = factory.updateSourceFile(visited, normalizedStatements);
        if (namespaceImports.size === 0 && runtimeDynamicImports === 0) return normalized;
        const imports = Array.from(namespaceImports.values(), ({ request, bindings }) =>
          factory.createImportDeclaration(
            undefined,
            factory.createImportClause(
              false,
              undefined,
              factory.createNamedImports(
                bindings.map(({ exported, local }) =>
                  factory.createImportSpecifier(
                    false,
                    ts.isIdentifierText(exported, ts.ScriptTarget.Latest)
                      ? factory.createIdentifier(exported)
                      : factory.createStringLiteral(exported),
                    local,
                  ),
                ),
              ),
            ),
            factory.createStringLiteral(request),
            undefined,
          ),
        );
        if (runtimeDynamicImports !== 0) {
          imports.push(
            factory.createImportDeclaration(
              undefined,
              factory.createImportClause(
                false,
                undefined,
                factory.createNamedImports([
                  factory.createImportSpecifier(
                    false,
                    factory.createIdentifier("__v8x_graph_runtime_dynamic_import"),
                    runtimeDynamicImport,
                  ),
                ]),
              ),
              factory.createStringLiteral(GRAPH_DYNAMIC_IMPORT_RUNTIME_SPECIFIER),
              undefined,
            ),
          );
        }
        const namespaces = Array.from(namespaceImports.values())
          .filter(({ materialize }) => materialize)
          .map(({ identifier, bindings }) =>
            factory.createVariableStatement(
              undefined,
              factory.createVariableDeclarationList(
                [
                  factory.createVariableDeclaration(
                    identifier,
                    undefined,
                    undefined,
                    factory.createObjectLiteralExpression(
                      bindings.map(({ exported, local }) =>
                        factory.createPropertyAssignment(factory.createStringLiteral(exported), local),
                      ),
                    ),
                  ),
                ],
                ts.NodeFlags.Const,
              ),
            ),
          );
        return factory.updateSourceFile(normalized, [...imports, ...namespaces, ...normalized.statements]);
      };
    },
  ]);
  try {
    let printed = ts
      .createPrinter({ newLine: ts.NewLineKind.LineFeed })
      .printFile(transformed.transformed[0] as ts.SourceFile);
    if (runtimeDynamicImports !== 0) {
      // This state must be initialized before user top-level code. In
      // particular, a rejected TLA must not leave the decoder/call bridge in
      // its temporal dead zone. Static imports remain module-hoisted even
      // though this generated prelude text precedes their printed spelling.
      printed =
        graphDynamicImportLocalSource(
          localDynamicImportPrefix,
          runtimeDynamicImportBindingName,
          localDynamicImportBindingName,
        ) +
        "\n" +
        printed;
    }
    return {
      source: printed,
      dynamicImports,
      runtimeDynamicImports,
    };
  } finally {
    transformed.dispose();
  }
}

function staticModuleRequests(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const requests: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      requests.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return requests;
}

export interface PreparedManifestGraph {
  files: Record<string, string>;
  entry: string;
  projectResolutions: Record<string, Record<string, string>>;
  dynamicImportsLowered: number;
  runtimeDynamicImportsLowered: number;
}

export function prepareManifestGraph(
  modules: ReadonlyMap<string, string>,
  entrySpecifier: string,
): PreparedManifestGraph {
  if (!modules.has(entrySpecifier)) throw new Error(`manifest does not contain entry module: ${entrySpecifier}`);
  const knownSpecifiers = new Set(modules.keys());
  const files: Record<string, string> = {};
  const projectResolutions: Record<string, Record<string, string>> = {};
  let dynamicImportsLowered = 0;
  let runtimeDynamicImportsLowered = 0;

  for (const [specifier, source] of modules) {
    const fileName = compilerPath(specifier);
    const lowered = lowerManifestModule(source, specifier, entrySpecifier, modules);
    files[fileName] = lowered.source;
    dynamicImportsLowered += lowered.dynamicImports;
    runtimeDynamicImportsLowered += lowered.runtimeDynamicImports;
    const resolutions: Record<string, string> = {};
    for (const request of staticModuleRequests(lowered.source, fileName)) {
      const target = resolveManifestSpecifier(request, specifier, knownSpecifiers);
      if (target !== undefined) resolutions[request] = compilerPath(target);
      else if (request === GRAPH_DYNAMIC_IMPORT_RUNTIME_SPECIFIER) {
        resolutions[request] = compilerPath(GRAPH_DYNAMIC_IMPORT_RUNTIME_SPECIFIER);
      }
    }
    if (Object.keys(resolutions).length > 0) projectResolutions[fileName] = resolutions;
  }

  if (runtimeDynamicImportsLowered !== 0) {
    const runtimePath = compilerPath(GRAPH_DYNAMIC_IMPORT_RUNTIME_SPECIFIER);
    files[runtimePath] = graphDynamicImportRuntimeSource();
    const entryPath = compilerPath(entrySpecifier);
    files[entryPath] =
      `import { ${GRAPH_DYNAMIC_IMPORT_POLL_IMPLEMENTATION} } from ${JSON.stringify(GRAPH_DYNAMIC_IMPORT_RUNTIME_SPECIFIER)};\n` +
      `export function ${GRAPH_DYNAMIC_IMPORT_POLL_EXPORT}(): void { ${GRAPH_DYNAMIC_IMPORT_POLL_IMPLEMENTATION}(); }\n` +
      files[entryPath];
    projectResolutions[entryPath] = {
      ...(projectResolutions[entryPath] ?? {}),
      [GRAPH_DYNAMIC_IMPORT_RUNTIME_SPECIFIER]: runtimePath,
    };
  }

  return {
    files,
    entry: compilerPath(entrySpecifier),
    projectResolutions,
    dynamicImportsLowered,
    runtimeDynamicImportsLowered,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const modules = new Map<string, string>();

  for (const line of readFileSync(options.manifest, "utf8").split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator < 1) throw new Error(`invalid manifest row: ${line}`);
    const specifier = line.slice(0, separator);
    const sourcePath = line.slice(separator + 1);
    modules.set(specifier, readFileSync(sourcePath, "utf8"));
  }

  const graph = prepareManifestGraph(modules, options.entry);
  const compileOptions: CompileOptions = {
    target: "standalone",
    platform: "deno",
    emitWat: false,
    moduleName: "v8x-js2wasm-spike",
    externImportModule: "v8x:deno",
    standaloneGlobalThisImport: {
      module: "v8x:context",
      name: "__v8x_context_global_this",
      call: "__v8x_context_call",
    },
    link: ["v8x:context"],
    allowJs: true,
    // v8x is the host for these modules. Keep the exception-rendering ABI
    // (and the rest of the explicit host bridge surface) so it can decode the
    // externref payload carried by the standardized Wasm exception tag.
    hostBridge: "always",
    // Keep user top-level code out of Wasm instantiation. v8x must first own
    // the Instance so a standardized Wasm exception can be rendered through
    // its `__exn_render_*` exports and surfaced as Module::Evaluate's rejected
    // Promise instead of losing the payload at InstancePre::instantiate.
    deferTopLevelInit: true,
    ...(options.optimize === undefined ? {} : { optimize: options.optimize }),
  };
  const result = await compileMultiSource(
    graph.files,
    graph.entry,
    compileOptions,
    undefined,
    graph.projectResolutions,
  );
  if (!result.success) {
    const diagnostics = result.errors
      .map((diagnostic) => `${graph.entry}:${diagnostic.line ?? 0}:${diagnostic.column ?? 0} ${diagnostic.message}`)
      .join("\n");
    throw new Error(diagnostics || "js2wasm compilation failed without diagnostics");
  }
  if (options.optimize !== undefined) {
    const optimizerWarnings = result.errors.filter(
      (diagnostic) => diagnostic.severity === "warning" && diagnostic.message.includes("wasm-opt"),
    );
    if (optimizerWarnings.length > 0) {
      throw new Error(optimizerWarnings.map((diagnostic) => diagnostic.message).join("\n"));
    }
  }

  writeFileSync(options.output, result.binary);
  process.stdout.write(
    `${JSON.stringify({ bytes: result.binary.byteLength, modules: modules.size, dynamicImportsLowered: graph.dynamicImportsLowered, runtimeDynamicImportsLowered: graph.runtimeDynamicImportsLowered, optimize: options.optimize ?? 0 })}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
