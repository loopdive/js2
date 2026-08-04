// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "./ts-api.js";
import {
  PositionMap,
  type CompilerSourceOriginSpan,
  type CompilerSourceProducer,
  type SourceEdit,
} from "./position-map.js";

interface ClassUsageInfo {
  constructorArgCounts: number[];
  properties: Set<string>;
  methods: Map<string, number>; // method name → max arg count
}

interface NestedNamespaceInfo {
  properties: Set<string>;
  methods: Map<string, number>; // method name → max arg count
}

/** Recognized Node.js builtin module specifiers (#1044). */
export const NODE_BUILTIN_MODULES = new Set([
  "http",
  "https",
  "http2",
  "url",
  "querystring",
  "stream",
  "stream/web",
  "events",
  "buffer",
  "zlib",
  "util",
  "path",
  "process",
  "net",
  "tls",
  "fs",
  "crypto",
  "os",
  "module",
  "fs/promises",
  "child_process",
  "assert",
  "dns",
  "dgram",
  "cluster",
  "readline",
  "string_decoder",
  "timers",
  "tty",
  "vm",
  "worker_threads",
  "perf_hooks",
  "async_hooks",
  "diagnostics_channel",
  "console",
]);

/**
 * #1492 — Typed stubs for known Node.js builtin functions that are exposed
 * as named imports. The MVP covers `crypto.randomBytes` and `crypto.randomUUID`
 * (the most-requested standalone-host-bridge functions for backend code).
 *
 * When the user writes `import { randomBytes } from "node:crypto"` and calls
 * `randomBytes(n)`, `preprocessImports` substitutes a declare-function host
 * import named `__nodefn__crypto__randomBytes` (typed `(number) => Uint8Array`)
 * plus a thin TS wrapper `function randomBytes(n) { return
 * __nodefn__crypto__randomBytes(n); }`. The codegen registers the host import
 * via the standard declare-function path; `compiler/import-manifest.ts` then
 * classifies the `__nodefn__*` prefix into the `node_builtin_fn` ImportIntent
 * so `runtime.ts:resolveImport` can bind it at runtime.
 *
 * Adding a new module/function: extend this table.
 */
/**
 * (#1794) Named node-builtin CLASS imports (`import { EventEmitter } from
 * "node:events"`). The generic fallback bound the local name to `declare
 * const X: any` (a null externref — every method call silently no-opped).
 * Instead, substitute the established #1044 extern-class shape:
 *
 *   declare namespace events { class EventEmitter { …typed members… } }
 *   declare const EventEmitter: typeof events.EventEmitter;
 *
 * `collectExternClass` registers the class with `namespacePath: ["events"]`,
 * so construction lowers to the `events_EventEmitter_new` host import whose
 * ImportIntent carries the namespace path — `runtime.ts`
 * `_resolveNamespacedClass` resolves it via `deps.events` ??
 * `require("events")`. Instance methods ride the extern-method imports;
 * listener closures cross via the #1382 callback bridge, and the
 * listener-registering methods are on the #1695 deferred-callback allowlist
 * (persistent capture writebacks) — see closures/callback-classification.ts.
 * The `typeof` const makes the BARE name resolve to the same class symbol,
 * so `new EventEmitter()` and `new events.EventEmitter()` are one path.
 *
 * Adding a new module/class: extend this table (members are the declare-class
 * body). Keep members typed — the extern collector maps them to Wasm sigs.
 */
const NODE_BUILTIN_CLASS_TYPED_STUBS: Record<string, Record<string, string>> = {
  events: {
    EventEmitter: [
      "constructor();",
      "on(event: string, listener: any): any;",
      "once(event: string, listener: any): any;",
      "off(event: string, listener: any): any;",
      "addListener(event: string, listener: any): any;",
      "removeListener(event: string, listener: any): any;",
      "removeAllListeners(event?: string): any;",
      "prependListener(event: string, listener: any): any;",
      "prependOnceListener(event: string, listener: any): any;",
      "emit(event: string, a0?: any, a1?: any, a2?: any): boolean;",
      "listenerCount(event: string): number;",
      "listeners(event: string): any;",
      "eventNames(): any;",
      "setMaxListeners(n: number): any;",
    ].join("\n    "),
  },
  // (#1792) node:url — the WHATWG `URL` / `URLSearchParams` classes as named
  // imports (`import { URL } from "node:url"`). The global form `new URL(...)`
  // is served by the registerBuiltinExternClasses global registration; this
  // stub gives the IMPORT form the same #1794 extern-class shape with
  // namespacePath ["url"] so runtime `_resolveNamespacedClass` binds it to
  // `deps.url ?? require("url")` — functionally the same host constructor as
  // the global (`require("url").URL === globalThis.URL` in Node).
  url: {
    URL: [
      "constructor(url: any, base?: any);",
      "readonly href: string;",
      "readonly origin: string;",
      "readonly protocol: string;",
      "readonly username: string;",
      "readonly password: string;",
      "readonly host: string;",
      "readonly hostname: string;",
      "readonly port: string;",
      "readonly pathname: string;",
      "readonly search: string;",
      "readonly searchParams: any;",
      "readonly hash: string;",
      "toString(): string;",
      "toJSON(): string;",
    ].join("\n    "),
    URLSearchParams: [
      "constructor(init?: any);",
      "readonly size: number;",
      "append(name: string, value: string): any;",
      "delete(name: string, value?: string): any;",
      "get(name: string): any;",
      "getAll(name: string): any;",
      "has(name: string, value?: string): boolean;",
      "set(name: string, value: string): any;",
      "sort(): any;",
      "toString(): string;",
      "forEach(cb: any): any;",
      "entries(): any;",
      "keys(): any;",
      "values(): any;",
    ].join("\n    "),
  },
};

/** (#1794) Lookup: is `name` a known node-builtin class export of `moduleName`? */
export function nodeBuiltinClassStub(moduleName: string, name: string): string | null {
  const members = NODE_BUILTIN_CLASS_TYPED_STUBS[moduleName]?.[name];
  if (!members) return null;
  return (
    `declare namespace ${moduleName} {\n  class ${name} {\n    ${members}\n  }\n}\n` +
    `declare const ${name}: typeof ${moduleName}.${name};`
  );
}

const NODE_BUILTIN_FN_TYPED_STUBS: Record<
  string,
  Record<string, { params: string; returns: string; passthrough: string }>
> = {
  // #1795 — node:http/https Tier 0 (client GET round-trip, the axios
  // unblocker). `get`/`request` take a wasm-closure callback; the
  // `node_builtin_fn` runtime adapter wraps closure-shaped args as JS
  // callables (identity-cached), and the response object flows back into the
  // callback as an externref whose `.on(...)` listeners ride the same
  // closure-callback contract as #1794 EventEmitter.
  http: {
    get: { params: "url: any, cb: any", returns: "any", passthrough: "url, cb" },
    request: { params: "url: any, cb: any", returns: "any", passthrough: "url, cb" },
  },
  https: {
    get: { params: "url: any, cb: any", returns: "any", passthrough: "url, cb" },
    request: { params: "url: any, cb: any", returns: "any", passthrough: "url, cb" },
  },
  crypto: {
    randomBytes: { params: "size: number", returns: "Uint8Array", passthrough: "size" },
    randomUUID: { params: "", returns: "string", passthrough: "" },
  },
  // #2699 — the destructured/named `node:url` function surface ESLint + npm libs
  // import (`const { pathToFileURL } = require("node:url")`). Routes to
  // `__nodefn__url__*` → `require("node:url")[fn]` (host) via the existing
  // `node_builtin_fn` adapter. The namespace form (`url.pathToFileURL`) already
  // worked via the `__node_url` module route; this fixes the destructured form,
  // which otherwise fell through to a broken generic `env` stub.
  url: {
    pathToFileURL: { params: "path: any", returns: "any", passthrough: "path" },
    fileURLToPath: { params: "url: any", returns: "any", passthrough: "url" },
  },
  // #2699 — `node:module` (not previously a recognized builtin). `createRequire`
  // is used by ESLint's config loader and by many ESM/CJS-interop shims.
  module: {
    createRequire: { params: "filename: any", returns: "any", passthrough: "filename" },
  },
  // #2701 — `node:fs/promises` function surface ESLint's CLI/config layers
  // import (`const { mkdir, stat, writeFile } = require("node:fs/promises")`).
  // These return Promises; the host adapter passes the Promise through. The `/`
  // in the module name is encoded `/`→`$` in the `__nodefn__` host name (see
  // `nodeBuiltinFnTypedStub`) and decoded back in the import-manifest classifier.
  "fs/promises": {
    readFile: { params: "a0: any, a1: any", returns: "any", passthrough: "a0, a1" },
    writeFile: { params: "a0: any, a1: any, a2: any", returns: "any", passthrough: "a0, a1, a2" },
    unlink: { params: "a0: any", returns: "any", passthrough: "a0" },
    stat: { params: "a0: any, a1: any", returns: "any", passthrough: "a0, a1" },
    mkdir: { params: "a0: any, a1: any", returns: "any", passthrough: "a0, a1" },
  },
  // #2699 — `node:os` destructured function surface (`const { platform } =
  // require("node:os")`). The namespace form (`os.platform()`) already worked
  // via `__node_os`; this covers the destructured form ESLint's deps use.
  os: {
    platform: { params: "", returns: "any", passthrough: "" },
    release: { params: "", returns: "any", passthrough: "" },
  },
};

/**
 * #1791 — `node:path` posix surface implemented as a pure-TS shim compiled into
 * the module. `path` is pure string compute (no I/O), so a single TS port serves
 * BOTH the JS-host and standalone (WASI/browser) targets — no host import, no
 * standalone trap. This is the highest-leverage Node builtin (blocks ESLint,
 * prettier, TypeScript). win32 semantics + `path.posix`/`path.win32`/`parse`/
 * `format` namespaces are deferred (posix-only Tier 0).
 *
 * The methods covered are exactly the surface ESLint + its deps call
 * (resolve/sep/join/dirname/relative/isAbsolute/extname/normalize) plus
 * `basename` (Tier 0 acceptance).
 */
const PATH_SHIM_METHODS = [
  "join",
  "resolve",
  "normalize",
  "dirname",
  "basename",
  "extname",
  "isAbsolute",
  "relative",
] as const;
const PATH_PRELUDE_FUNCTION_ROLES: Readonly<Record<string, string>> = {
  __js2wasm_path_normStr: "normalize-segments",
  __js2wasm_path_normalize: "normalize",
  __js2wasm_path_isAbsolute: "is-absolute",
  __js2wasm_path_join: "join",
  __js2wasm_path_resolve: "resolve",
  __js2wasm_path_dirname: "dirname",
  __js2wasm_path_basename: "basename",
  __js2wasm_path_extname: "extname",
  __js2wasm_path_relative: "relative",
};
const PATH_BINDING_FUNCTION_ROLES: Readonly<Record<string, string>> = {
  join: "named-join",
  resolve: "named-resolve",
  normalize: "named-normalize",
  dirname: "named-dirname",
  basename: "named-basename",
  extname: "named-extname",
  isAbsolute: "named-is-absolute",
  relative: "named-relative",
};
/** Recognised data properties on the `path` module object (posix). */
const PATH_SHIM_PROPS: Record<string, string> = { sep: '"/"', delimiter: '":"' };

/**
 * The prepended prelude: top-level posix path functions (`__js2wasm_path_*`).
 * Variadic (`join`/`resolve`) are top-level functions — variadic dispatch
 * through an object field is currently miscompiled (#1791 dev note), so the
 * default-import object's methods are FIXED-arity wrappers that forward here
 * (the wrappers pad unused slots with `""`, which `join`/`resolve` skip).
 * Faithful port of Node's `lib/path.js` posix subset.
 */
function buildPathShim(): string {
  return `// #1791 node:path posix shim (pure string compute; host + standalone)
function __js2wasm_path_normStr(path: string, allowAboveRoot: boolean): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; i++) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === 47) break;
    else code = 47;
    if (code === 47) {
      if (lastSlash === i - 1 || dots === 1) {
        // empty segment or "."
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 ||
            res.charCodeAt(res.length - 1) !== 46 ||
            res.charCodeAt(res.length - 2) !== 46) {
          if (res.length > 2) {
            const lsi = res.lastIndexOf("/");
            if (lsi === -1) { res = ""; lastSegmentLength = 0; }
            else { res = res.slice(0, lsi); lastSegmentLength = res.length - 1 - res.lastIndexOf("/"); }
            lastSlash = i; dots = 0; continue;
          } else if (res.length !== 0) {
            res = ""; lastSegmentLength = 0; lastSlash = i; dots = 0; continue;
          }
        }
        if (allowAboveRoot) {
          if (res.length > 0) res = res + "/.."; else res = "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res = res + "/" + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i; dots = 0;
    } else if (code === 46 && dots !== -1) {
      dots = dots + 1;
    } else {
      dots = -1;
    }
  }
  return res;
}
function __js2wasm_path_normalize(path: string): string {
  if (path.length === 0) return ".";
  const isAbs = path.charCodeAt(0) === 47;
  const trail = path.charCodeAt(path.length - 1) === 47;
  let p = __js2wasm_path_normStr(path, !isAbs);
  if (p.length === 0) {
    if (isAbs) return "/";
    return trail ? "./" : ".";
  }
  if (trail) p = p + "/";
  return isAbs ? "/" + p : p;
}
function __js2wasm_path_isAbsolute(path: string): boolean {
  return path.length > 0 && path.charCodeAt(0) === 47;
}
function __js2wasm_path_join(...args: string[]): string {
  let joined = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.length > 0) {
      if (joined.length === 0) joined = arg;
      else joined = joined + "/" + arg;
    }
  }
  if (joined.length === 0) return ".";
  return __js2wasm_path_normalize(joined);
}
function __js2wasm_path_resolve(...args: string[]): string {
  let resolvedPath = "";
  let resolvedAbsolute = false;
  for (let i = args.length - 1; i >= 0; i--) {
    if (resolvedAbsolute) break;
    const seg = args[i];
    if (seg.length === 0) continue;
    resolvedPath = seg + "/" + resolvedPath;
    resolvedAbsolute = seg.charCodeAt(0) === 47;
  }
  // No absolute segment found → prepend the (standalone) cwd root "/". Keeping
  // the literal in a concat (not a reassigned \`let\`) avoids a string-constant /
  // array-element WasmGC type merge under nativeStrings.
  if (!resolvedAbsolute) {
    resolvedPath = "/" + resolvedPath;
    resolvedAbsolute = true;
  }
  resolvedPath = __js2wasm_path_normStr(resolvedPath, !resolvedAbsolute);
  if (resolvedAbsolute) {
    if (resolvedPath.length > 0) return "/" + resolvedPath;
    return "/";
  }
  if (resolvedPath.length > 0) return resolvedPath;
  return ".";
}
function __js2wasm_path_dirname(path: string): string {
  if (path.length === 0) return ".";
  const hasRoot = path.charCodeAt(0) === 47;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) { end = i; break; }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}
function __js2wasm_path_basename(path: string, ext: string = ""): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  if (ext.length > 0 && ext.length <= path.length) {
    if (ext === path) return "";
    let extIdx = ext.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      const code = path.charCodeAt(i);
      if (code === 47) {
        if (!matchedSlash) { start = i + 1; break; }
      } else {
        if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1; }
        if (extIdx >= 0) {
          if (code === ext.charCodeAt(extIdx)) {
            extIdx = extIdx - 1;
            if (extIdx === -1) end = i;
          } else {
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; i--) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) { start = i + 1; break; }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return "";
  return path.slice(start, end);
}
function __js2wasm_path_extname(path: string): string {
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    const code = path.charCodeAt(i);
    if (code === 47) {
      if (!matchedSlash) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === 46) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return "";
  }
  return path.slice(startDot, end);
}
function __js2wasm_path_relative(from: string, to: string): string {
  if (from === to) return "";
  const f = __js2wasm_path_resolve(from);
  const t = __js2wasm_path_resolve(to);
  if (f === t) return "";
  const fromStart = 1;
  const fromEnd = f.length;
  const fromLen = fromEnd - fromStart;
  const toStart = 1;
  const toLen = t.length - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = f.charCodeAt(fromStart + i);
    if (fromCode !== t.charCodeAt(toStart + i)) break;
    else if (fromCode === 47) lastCommonSep = i;
  }
  if (i === length) {
    if (toLen > length) {
      if (t.charCodeAt(toStart + i) === 47) return t.slice(toStart + i + 1);
      if (i === 0) return t.slice(toStart + i);
    } else if (fromLen > length) {
      if (f.charCodeAt(fromStart + i) === 47) lastCommonSep = i;
      else if (i === 0) lastCommonSep = 0;
    }
  }
  let out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; i++) {
    if (i === fromEnd || f.charCodeAt(i) === 47) {
      if (out.length === 0) out = ".."; else out = out + "/..";
    }
  }
  return out + t.slice(toStart + lastCommonSep);
}
`;
}

/** Fixed-arity (optional-param) object-method wrapper text for a path method. */
function pathObjectMethod(name: string): string {
  // Variadic methods → fixed 8-slot wrappers padded with "" (join/resolve skip
  // empty args, so padding is semantically inert).
  if (name === "join" || name === "resolve") {
    return `  ${name}(a: string = "", b: string = "", c: string = "", d: string = "", e: string = "", f: string = "", g: string = "", h: string = ""): string { return __js2wasm_path_${name}(a, b, c, d, e, f, g, h); }`;
  }
  if (name === "basename") {
    return `  basename(p: string, ext: string = ""): string { return __js2wasm_path_basename(p, ext); }`;
  }
  if (name === "isAbsolute") {
    return `  isAbsolute(p: string): boolean { return __js2wasm_path_isAbsolute(p); }`;
  }
  if (name === "relative") {
    return `  relative(from: string, to: string): string { return __js2wasm_path_relative(from, to); }`;
  }
  // single-string-arg methods: normalize / dirname / extname
  return `  ${name}(p: string): string { return __js2wasm_path_${name}(p); }`;
}

/** Build the default/namespace `const <local> = { ...methods..., sep: "/" }` object. */
function buildPathDefaultObject(localName: string): string {
  const methods = PATH_SHIM_METHODS.map(pathObjectMethod);
  for (const [prop, val] of Object.entries(PATH_SHIM_PROPS)) {
    methods.push(`  ${prop}: ${val}`);
  }
  return `const ${localName} = {\n${methods.join(",\n")}\n};`;
}

/**
 * Forwarding binding for a named import (`import { join } from "node:path"`).
 * Returns null for an unrecognised name (caller falls through to the generic
 * stub so unsupported names don't regress).
 */
function buildPathNamedBinding(name: string): string | null {
  if (name === "join" || name === "resolve") {
    return `function ${name}(...a: string[]): string { return __js2wasm_path_${name}(...a); }`;
  }
  if (name === "basename") {
    return `function basename(p: string, ext: string = ""): string { return __js2wasm_path_basename(p, ext); }`;
  }
  if (name === "isAbsolute") {
    return `function isAbsolute(p: string): boolean { return __js2wasm_path_isAbsolute(p); }`;
  }
  if (name === "relative") {
    return `function relative(from: string, to: string): string { return __js2wasm_path_relative(from, to); }`;
  }
  if (name === "normalize" || name === "dirname" || name === "extname") {
    return `function ${name}(p: string): string { return __js2wasm_path_${name}(p); }`;
  }
  if (name in PATH_SHIM_PROPS) {
    return `const ${name} = ${PATH_SHIM_PROPS[name]};`;
  }
  return null;
}

/**
 * #1791 — true when every `<local>.<member>` access in the source is within the
 * shim's supported posix surface. A default `import path from "node:path"` is
 * only shimmed when fully supported; otherwise it stays on the legacy
 * `__node_path` host path so programs using `path.parse`/`path.win32`/etc. (out
 * of Tier 0 scope) don't regress in JS-host mode.
 */
function pathDefaultFullySupported(sf: ts.SourceFile, localName: string): boolean {
  const supported = new Set<string>([...PATH_SHIM_METHODS, ...Object.keys(PATH_SHIM_PROPS)]);
  let allOk = true;
  let sawAny = false;
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === localName) {
      sawAny = true;
      if (!supported.has(node.name.text)) allOk = false;
    }
    forEachChild(node, walk);
  };
  walk(sf);
  // If the binding is imported but never accessed via member, shimming is still
  // safe (the object is inert) — treat as supported.
  return sawAny ? allOk : true;
}

/** Returns true if `spec` is a recognized Node.js builtin (with or without `node:` prefix). */
export function isNodeBuiltin(spec: string): boolean {
  return NODE_BUILTIN_MODULES.has(spec.replace(/^node:/, ""));
}

/**
 * Recognized JSX runtime module specifiers (#1540).
 *
 * TypeScript emits auto-imports from these specifiers when
 * `compilerOptions.jsx === "react-jsx"` (or `jsxImportSource` is set).
 * The default is `"react"` so the specifier is `"react/jsx-runtime"`;
 * Preact uses `"preact/jsx-runtime"`, SolidJS uses
 * `"solid-js/h/jsx-runtime"`, etc.
 */
export const JSX_RUNTIME_SPECIFIERS = new Set([
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "preact/jsx-runtime",
  "preact/jsx-dev-runtime",
  "solid-js/h/jsx-runtime",
  "vue/jsx-runtime",
  "@emotion/react/jsx-runtime",
]);

export function isJsxRuntime(spec: string): boolean {
  return JSX_RUNTIME_SPECIFIERS.has(spec);
}

/**
 * Local-binding names for a detected JSX runtime import (#1540).
 *
 * TypeScript usually emits these as `import { jsx as _jsx, jsxs as _jsxs,
 * Fragment as _Fragment } from "react/jsx-runtime"`, but the aliases are
 * configurable via the user's source / TS options. We record the *local*
 * names so codegen can route identifier references to the right host
 * imports without hardcoding `_jsx`/`_jsxs`/`_Fragment`.
 */
export interface JsxRuntimeImport {
  /** The module specifier (e.g. `"react/jsx-runtime"`). */
  specifier: string;
  /** Local binding for the `jsx` named export, if imported. */
  localJsx?: string;
  /** Local binding for the `jsxs` named export, if imported. */
  localJsxs?: string;
  /** Local binding for the `Fragment` named export, if imported. */
  localFragment?: string;
  /** Local binding for the `jsxDEV` named export (dev runtime), if imported. */
  localJsxDev?: string;
}

/** Normalizes a module specifier by stripping the `node:` prefix if present. */
export function normalizeNodeBuiltin(spec: string): string {
  return spec.replace(/^node:/, "");
}

/** Info about a Node builtin import discovered during preprocessing. */
export interface NodeBuiltinImport {
  /** The local binding name (e.g., `http` from `import http from 'node:http'`). */
  localName: string;
  /** The normalized module name (e.g., `http`). */
  moduleName: string;
  /** Named bindings imported (e.g., `['createServer', 'get']` from `import { createServer, get } from 'http'`). */
  namedBindings?: string[];
}

/** Result of `preprocessImports`. */
export interface PreprocessResult {
  /** The transformed source code with import stubs. */
  source: string;
  /**
   * Whether preprocessing injected TypeScript-only declarations or
   * annotations into a JavaScript input. Callers must preserve JavaScript
   * checking semantics while selecting the TypeScript grammar for the
   * transformed source.
   */
  requiresTsGrammar: boolean;
  /** Node builtin modules detected during preprocessing. */
  nodeBuiltins: NodeBuiltinImport[];
  /** JSX runtime import (if any) detected during preprocessing (#1540). */
  jsxRuntime?: JsxRuntimeImport;
  /**
   * #1928 — maps an offset in `source` (the processed output) back to an
   * offset in the input this function consumed, covering the import-stub
   * replacements and the prepended timer shim. Identity when neither fired.
   * Lets the diagnostic layer report the user's line numbers, not the
   * rewritten ones.
   */
  positionMap: PositionMap;
}

/**
 * #1928 — build the `PositionMap` for `preprocessImports`. The import-stub
 * `replacements` are expressed in INPUT coordinates as `[start, end) → text`;
 * a prepended `timerShim` is an edit at offset 0 with an empty original span.
 */
interface PreprocessReplacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly compilerOrigins?: readonly CompilerSourceOriginSpan[];
}

function generatedFunctionOrigins(
  text: string,
  producer: CompilerSourceProducer,
  roles: Readonly<Record<string, string>>,
): CompilerSourceOriginSpan[] {
  const sf = ts.createSourceFile(`__${producer}_origins__.ts`, text, ts.ScriptTarget.Latest, true);
  const origins: CompilerSourceOriginSpan[] = [];
  for (const statement of sf.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body || !statement.name) continue;
    const role = roles[statement.name.text];
    if (!role) throw new Error(`missing compiler provenance role for ${producer} helper ${statement.name.text}`);
    origins.push({
      start: statement.getStart(sf),
      end: statement.end,
      origin: { producer, role },
    });
  }
  return origins;
}

function generatedClassOrigins(
  text: string,
  producer: CompilerSourceProducer,
  roles: Readonly<Record<string, string>>,
): CompilerSourceOriginSpan[] {
  const sf = ts.createSourceFile(`__${producer}_class_origins__.ts`, text, ts.ScriptTarget.Latest, true);
  const origins: CompilerSourceOriginSpan[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const role = roles[node.name.text];
      if (!role) throw new Error(`missing compiler provenance role for ${producer} class ${node.name.text}`);
      origins.push({
        start: node.getStart(sf),
        end: node.end,
        origin: { producer, role },
      });
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(sf, visit);
  return origins;
}

function pathBindingOrigins(
  text: string,
  functionRoles: Readonly<Record<string, string>> = PATH_BINDING_FUNCTION_ROLES,
): CompilerSourceOriginSpan[] {
  const sf = ts.createSourceFile("__node_path_binding_origins__.ts", text, ts.ScriptTarget.Latest, true);
  const origins = generatedFunctionOrigins(text, "node-path-binding", functionRoles);
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isObjectLiteralExpression(node.parent) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      const methodRole = PATH_BINDING_FUNCTION_ROLES[node.name.text];
      if (!methodRole) throw new Error(`missing compiler provenance role for node:path method ${node.name.text}`);
      origins.push({
        start: node.getStart(sf),
        end: node.end,
        origin: { producer: "node-path-binding", role: `default-${methodRole.replace(/^named-/, "")}` },
      });
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(sf, visit);
  return origins;
}

function buildPreprocessPositionMap(
  replacements: readonly PreprocessReplacement[],
  pathShim: string,
  timerShim: string,
): PositionMap {
  const edits: SourceEdit[] = [];
  if (pathShim.length > 0) {
    edits.push({
      origStart: 0,
      origEnd: 0,
      newLength: pathShim.length,
      compilerOrigins: generatedFunctionOrigins(pathShim, "node-path-prelude", PATH_PRELUDE_FUNCTION_ROLES),
    });
  }
  if (timerShim.length > 0) {
    edits.push({
      origStart: 0,
      origEnd: 0,
      newLength: timerShim.length,
      compilerOrigins: generatedFunctionOrigins(timerShim, "timer-shim", TIMER_FUNCTION_ROLES),
    });
  }
  for (const r of replacements) {
    edits.push({
      origStart: r.start,
      origEnd: r.end,
      newLength: r.text.length,
      ...(r.compilerOrigins ? { compilerOrigins: r.compilerOrigins } : {}),
    });
  }
  return new PositionMap(edits);
}

/**
 * Pre-process source code to replace import statements with auto-generated
 * declare blocks based on usage analysis.
 *
 * Handles:
 * - `import * as X from "mod"` → `declare namespace X { ... }`
 * - `import X from "mod"` → `declare const X: any;`
 * - `import { a, b } from "mod"` → `declare function a(...): any;` or `declare const a: any;`
 */
/**
 * #1501 — Timer host-import shim.
 *
 * Bare identifiers `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`
 * are global functions on the JS host but unbound from compiled Wasm — the
 * `declared_global` resolver returns a getter, not a callable, so user
 * `setTimeout(cb, 100)` calls silently no-op (in the best case) or pass a
 * WasmGC closure to `globalThis.setTimeout`, which the host coerces to
 * `"[object Object]"` and the timer never fires.
 *
 * The shim below replaces those identifiers with `function` declarations
 * that delegate to `__timer_set_timeout` / `__timer_clear_interval` host
 * imports. Those names are classified by `compiler/import-manifest.ts` into
 * the `timer_set` / `timer_clear` `ImportIntent` variants, and
 * `runtime.resolveImport` binds them to `globalThis.{set,clear}{Timeout,
 * Interval}` (with the same `_wrapWasmClosure` callback-bridging
 * machinery future-proofed for #1382).
 *
 * Scope: this is the "doesn't crash" passthrough path requested by the
 * tech lead while #1382 (Wasm closure → JS-callable bridge) is in flight.
 * `clearTimeout` / `clearInterval` already work end-to-end (the handle is
 * an externref that round-trips); `setTimeout` / `setInterval` callbacks
 * will fire fully once #1382 lands.
 */
const TIMER_SHIM_FNS = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] as const;

function detectTimerCallSites(sf: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if ((TIMER_SHIM_FNS as readonly string[]).includes(name)) {
        found.add(name);
      }
    }
    forEachChild(node, visit);
  };
  for (const stmt of sf.statements) {
    forEachChild(stmt, visit);
  }
  return found;
}

function buildTimerShim(used: Set<string>, definedNames: Set<string>): string {
  if (used.size === 0) return "";
  const lines: string[] = [];
  const hostFor: Record<string, string> = {
    setTimeout: "__timer_set_timeout",
    setInterval: "__timer_set_interval",
    clearTimeout: "__timer_clear_timeout",
    clearInterval: "__timer_clear_interval",
  };
  // declares + wrapper functions. Skip any name that the user has already
  // defined to avoid shadowing user functions.
  for (const name of TIMER_SHIM_FNS) {
    if (!used.has(name) || definedNames.has(name)) continue;
    const hostName = hostFor[name]!;
    if (name === "clearTimeout" || name === "clearInterval") {
      lines.push(`declare function ${hostName}(h: any): void;`);
      lines.push(`function ${name}(h: number): void { ${hostName}(h); }`);
    } else {
      lines.push(`declare function ${hostName}(cb: any, ms: any): any;`);
      lines.push(`function ${name}(cb: () => void, ms: number): number { return ${hostName}(cb, ms); }`);
    }
  }
  if (lines.length === 0) return "";
  return `// #1501 timer host-import shim (auto-injected)\n${lines.join("\n")}\n`;
}

const TIMER_FUNCTION_ROLES: Readonly<Record<string, string>> = {
  setTimeout: "set-timeout",
  setInterval: "set-interval",
  clearTimeout: "clear-timeout",
  clearInterval: "clear-interval",
};

export function preprocessImports(source: string, opts?: { wasi?: boolean }): PreprocessResult {
  const sf = ts.createSourceFile("__preprocess__.ts", source, ts.ScriptTarget.Latest, true);

  // #1501 — detect bare-identifier calls to timer globals BEFORE the early
  // return for source-without-imports, so a file that uses `setTimeout`
  // without any `import` statements still gets the shim. (The
  // `definedNames` reachable at this point includes the same scan used
  // below for the existing import resolution path.)
  //
  // #2632 Phase 1 — under `--target wasi` the timer shim is SUPPRESSED: the
  // standalone event-loop reactor lowers setTimeout/setInterval/clearTimeout/
  // clearInterval natively (no `__timer_set_*` host import, no injected
  // `function setTimeout` stub). Injecting the stub here would (a) pull in an
  // unresolvable host import and (b) make `setTimeout` resolve to a user-file
  // declaration, defeating the codegen reactor lowering (the call would inline
  // the no-op stub instead). So skip it entirely for WASI.
  const timerCalls = opts?.wasi ? new Set<string>() : detectTimerCallSites(sf);

  // Step 1: Find all imports
  const nsImports = new Map<string, { start: number; end: number; moduleSpec: string }>();
  const otherImports: {
    start: number;
    end: number;
    defaultName?: string;
    namedBindings?: string[];
    moduleSpec: string;
    /** #1791 — when set, emit the pure-TS `node:path` shim instead of a stub. */
    shimPath?: boolean;
  }[] = [];
  const nodeBuiltins: NodeBuiltinImport[] = [];
  // #1791 — set when any import binds the node:path shim, so the prelude is
  // prepended exactly once.
  let usesPathShim = false;
  // (#1540) Per-source JSX runtime import — we only support one
  // `jsxImportSource` per compile unit (matches the TypeScript model).
  // If multiple JSX runtime imports appear, the last one wins.
  let jsxRuntime: JsxRuntimeImport | undefined;
  const jsxRuntimeImportRanges: { start: number; end: number; specifier: string }[] = [];

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    // Import attributes (TS 5.3+ / TS7) — `import x from "m" with { type: "json" }`.
    // ESM JSON imports with attributes are not resolved here. #3655 handles
    // only compileProject's static CommonJS `require("./relative.json")`
    // during filesystem graph expansion; import attributes remain #1288.
    // Per #1288: emit a one-line note and continue; do NOT throw. The TS7
    // native-preview parser surfaces this shape unconditionally, and TS5 has
    // supported the syntax since 5.3.
    const attrs = (stmt as ts.ImportDeclaration & { attributes?: { elements?: readonly unknown[] } }).attributes;
    if (attrs && Array.isArray(attrs.elements) && attrs.elements.length > 0) {
      const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "<unknown>";
      console.warn(
        `[js2wasm] Import attributes on \`${spec}\` are accepted but not yet acted on (#1288); ` +
          `the import is processed as if no attributes were present. JSON inlining tracked as a follow-up.`,
      );
    }

    const moduleSpec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "";
    const clause = stmt.importClause;
    if (!clause) {
      // Side-effect import: `import "mod"` — just remove
      otherImports.push({ start: stmt.getStart(sf), end: stmt.end, moduleSpec });
      continue;
    }

    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      // import * as X from "mod"
      const name = clause.namedBindings.name.text;
      nsImports.set(name, { start: stmt.getStart(sf), end: stmt.end, moduleSpec });
      if (isNodeBuiltin(moduleSpec)) {
        nodeBuiltins.push({ localName: name, moduleName: normalizeNodeBuiltin(moduleSpec) });
      }
      continue;
    }

    // Default and/or named imports
    const defaultName = clause.name?.text;
    const namedBindings: string[] = [];
    // (#1540) Track the `originalName -> localName` alias map for JSX
    // runtime imports so `import { jsx as h } from "react/jsx-runtime"`
    // is recognized regardless of the local alias.
    const namedAliases: { propertyName: string; localName: string }[] = [];
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        namedBindings.push(el.name.text);
        // el.propertyName is set when the user wrote `jsx as _jsx`; otherwise
        // the property name equals the local name.
        const propertyName = el.propertyName?.text ?? el.name.text;
        namedAliases.push({ propertyName, localName: el.name.text });
      }
    }
    // (#1540) JSX runtime import detection. Recognize `import { jsx as
    // _jsx, jsxs as _jsxs, Fragment as _Fragment, jsxDEV as _jsxDEV }
    // from "react/jsx-runtime"` (or any other supported jsxImportSource).
    // We will emit typed declare stubs below for whatever names were
    // imported, so downstream codegen can route call expressions to the
    // host import.
    if (isJsxRuntime(moduleSpec)) {
      const entry: JsxRuntimeImport = jsxRuntime ?? { specifier: moduleSpec };
      // The last JSX runtime import wins on specifier (multiple-jsxImportSource
      // sources are out of scope; we keep the *last* observed specifier so
      // intent classification is stable).
      entry.specifier = moduleSpec;
      for (const { propertyName, localName } of namedAliases) {
        if (propertyName === "jsx") entry.localJsx = localName;
        else if (propertyName === "jsxs") entry.localJsxs = localName;
        else if (propertyName === "Fragment") entry.localFragment = localName;
        else if (propertyName === "jsxDEV") entry.localJsxDev = localName;
      }
      jsxRuntime = entry;
      jsxRuntimeImportRanges.push({ start: stmt.getStart(sf), end: stmt.end, specifier: moduleSpec });
      // Skip the generic "otherImports" path — we'll emit our own stubs
      // for JSX runtime bindings at the end so they get the right typed
      // declare signatures.
      continue;
    }
    // #1791 — decide whether to bind `node:path` to the pure-TS posix shim
    // (works in BOTH host + standalone). A NAMED-only path import always shims
    // (the legacy named-path stub is broken anyway); a DEFAULT import shims only
    // when every `path.<member>` access is in the supported surface (else keep
    // legacy host `__node_path`, so `path.parse`/win32 don't regress).
    let shimPath = false;
    if (isNodeBuiltin(moduleSpec) && normalizeNodeBuiltin(moduleSpec) === "path") {
      if (defaultName) shimPath = pathDefaultFullySupported(sf, defaultName);
      else if (namedBindings.length > 0) shimPath = true;
    }
    otherImports.push({
      start: stmt.getStart(sf),
      end: stmt.end,
      defaultName,
      namedBindings: namedBindings.length > 0 ? namedBindings : undefined,
      moduleSpec,
      shimPath,
    });
    // A shimmed path import must NOT also register the `__node_path` host import
    // (it would create a conflicting global for the same local name).
    if (isNodeBuiltin(moduleSpec) && !shimPath) {
      // (#1794) Named bindings served by an extern-CLASS stub must not double-bind
      // the local name to the module-object thunk (`__node_<mod>` declaredGlobal) —
      // the class identifier would then resolve to the MODULE externref instead of
      // the class. Exclude them; skip the registration entirely when nothing is left.
      const mod = normalizeNodeBuiltin(moduleSpec);
      const nonClassBindings = namedBindings.filter((n) => nodeBuiltinClassStub(mod, n) === null);
      if (defaultName || nonClassBindings.length > 0 || namedBindings.length === 0) {
        nodeBuiltins.push({
          localName: defaultName || nonClassBindings[0] || mod,
          moduleName: mod,
          namedBindings: nonClassBindings.length > 0 ? nonClassBindings : undefined,
        });
      }
    }
  }

  // #1501 — Build the timer shim if the source uses any timer call site.
  // The shim is prepended to the (possibly otherwise-unchanged) source.
  // We compute `definedNames` before the early-return so the shim can
  // skip any timer name the user has already defined locally.
  //
  // Collect names already defined in the source (functions, variables, classes)
  // to avoid generating conflicting declare stubs.
  const definedNames = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      definedNames.add(stmt.name.text);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          definedNames.add(decl.name.text);
        }
      }
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      definedNames.add(stmt.name.text);
    }
  }
  const timerShim = buildTimerShim(timerCalls, definedNames);

  if (nsImports.size === 0 && otherImports.length === 0 && jsxRuntimeImportRanges.length === 0) {
    return {
      source: timerShim ? timerShim + source : source,
      requiresTsGrammar: timerShim.length > 0,
      nodeBuiltins,
      jsxRuntime,
      // #1928 — no imports here; only the (optional) timer-shim prepend shifts positions.
      positionMap: buildPreprocessPositionMap([], "", timerShim),
    };
  }

  // Step 2: Analyze usage for namespace imports
  const namespaces = new Map<string, Map<string, ClassUsageInfo>>();
  const nestedNs = new Map<string, Map<string, NestedNamespaceInfo>>();
  for (const ns of nsImports.keys()) {
    namespaces.set(ns, new Map());
    nestedNs.set(ns, new Map());
  }

  // Track typed variables: varName → { ns, className }
  const typedVars = new Map<string, { ns: string; className: string }>();

  // Track which named/default imports are called as functions
  const calledAsFunction = new Set<string>();
  const maxCallArgs = new Map<string, number>();

  function getOrCreateClass(ns: string, className: string): ClassUsageInfo {
    const classes = namespaces.get(ns)!;
    if (!classes.has(className)) {
      classes.set(className, {
        constructorArgCounts: [],
        properties: new Set(),
        methods: new Map(),
      });
    }
    return classes.get(className)!;
  }

  function getOrCreateNestedNs(ns: string, subNs: string): NestedNamespaceInfo {
    const map = nestedNs.get(ns)!;
    if (!map.has(subNs)) {
      map.set(subNs, { properties: new Set(), methods: new Map() });
    }
    return map.get(subNs)!;
  }

  function tryResolveQualifiedName(typeRef: ts.TypeReferenceNode): { ns: string; className: string } | null {
    if (ts.isQualifiedName(typeRef.typeName)) {
      if (ts.isIdentifier(typeRef.typeName.left) && nsImports.has(typeRef.typeName.left.text)) {
        return {
          ns: typeRef.typeName.left.text,
          className: typeRef.typeName.right.text,
        };
      }
    }
    return null;
  }

  function visit(node: ts.Node) {
    // new X.Y(args...)
    if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (ts.isIdentifier(node.expression.expression) && nsImports.has(node.expression.expression.text)) {
        const ns = node.expression.expression.text;
        const cls = getOrCreateClass(ns, node.expression.name.text);
        cls.constructorArgCounts.push(node.arguments?.length ?? 0);
      }
    }

    // X.Y.method() — nested namespace access (e.g., THREE.MathUtils.lerp())
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const outer = node.expression.expression;
      if (ts.isIdentifier(outer.expression) && nsImports.has(outer.expression.text)) {
        const ns = outer.expression.text;
        const subNsName = outer.name.text;
        const methodName = node.expression.name.text;
        const info = getOrCreateNestedNs(ns, subNsName);
        const existing = info.methods.get(methodName) ?? 0;
        info.methods.set(methodName, Math.max(existing, node.arguments.length));
      }
    }

    // X.Y.prop (nested namespace property access, not a call)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      nsImports.has(node.expression.expression.text) &&
      !(node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const ns = node.expression.expression.text;
      const subNsName = node.expression.name.text;
      // Only if not already treated as a class
      const classes = namespaces.get(ns)!;
      if (!classes.has(subNsName)) {
        const info = getOrCreateNestedNs(ns, subNsName);
        info.properties.add(node.name.text);
      }
    }

    // Parameter with type X.Y
    if (ts.isParameter(node) && node.type && ts.isTypeReferenceNode(node.type)) {
      const info = tryResolveQualifiedName(node.type);
      if (info && ts.isIdentifier(node.name)) {
        getOrCreateClass(info.ns, info.className);
        typedVars.set(node.name.text, info);
      }
    }

    // Variable declaration with type X.Y
    if (ts.isVariableDeclaration(node) && node.type && ts.isTypeReferenceNode(node.type)) {
      const info = tryResolveQualifiedName(node.type);
      if (info && ts.isIdentifier(node.name)) {
        getOrCreateClass(info.ns, info.className);
        typedVars.set(node.name.text, info);
      }
    }

    // Return type X.Y on function declarations
    if (ts.isFunctionDeclaration(node) && node.type && ts.isTypeReferenceNode(node.type)) {
      const info = tryResolveQualifiedName(node.type);
      if (info) {
        getOrCreateClass(info.ns, info.className);
      }
    }

    // Property access on typed variable: varName.prop or varName.method()
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const varInfo = typedVars.get(node.expression.text);
      if (varInfo) {
        const cls = getOrCreateClass(varInfo.ns, varInfo.className);
        const memberName = node.name.text;

        if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
          // Method call
          const existing = cls.methods.get(memberName) ?? 0;
          cls.methods.set(memberName, Math.max(existing, node.parent.arguments.length));
        } else {
          // Property access (read or write)
          cls.properties.add(memberName);
        }
      }
    }

    // Track calls to named/default imported identifiers: func(args...)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      calledAsFunction.add(name);
      const existing = maxCallArgs.get(name) ?? 0;
      maxCallArgs.set(name, Math.max(existing, node.arguments.length));
    }

    forEachChild(node, visit);
  }

  visit(sf);

  // Step 3: Generate replacements
  const replacements: PreprocessReplacement[] = [];

  // Namespace imports → declare namespace
  for (const [nsName, { start, end, moduleSpec }] of nsImports) {
    const classes = namespaces.get(nsName)!;
    const nested = nestedNs.get(nsName)!;

    if (classes.size === 0 && nested.size === 0) {
      replacements.push({
        start,
        end,
        text: `/* import ${nsName}: no usage detected */`,
      });
      continue;
    }

    let declare = `declare namespace ${nsName} {\n`;

    // Classes
    for (const [className, usage] of classes) {
      declare += `  class ${className} {\n`;

      const maxCtorArgs = Math.max(0, ...usage.constructorArgCounts);
      if (maxCtorArgs > 0) {
        const params = Array.from({ length: maxCtorArgs }, (_, i) => `a${i}: any`).join(", ");
        declare += `    constructor(${params});\n`;
      } else {
        declare += `    constructor(...args: any[]);\n`;
      }

      for (const prop of usage.properties) {
        declare += `    ${prop}: any;\n`;
      }

      for (const [method, argCount] of usage.methods) {
        const params = Array.from({ length: argCount }, (_, i) => `a${i}: any`).join(", ");
        declare += `    ${method}(${params}): any;\n`;
      }

      declare += `  }\n`;
    }

    // Nested namespaces (e.g., THREE.MathUtils)
    for (const [subNsName, info] of nested) {
      // Skip if already registered as a class
      if (classes.has(subNsName)) continue;

      declare += `  namespace ${subNsName} {\n`;
      for (const prop of info.properties) {
        declare += `    const ${prop}: any;\n`;
      }
      for (const [method, argCount] of info.methods) {
        const params = Array.from({ length: argCount }, (_, i) => `a${i}: any`).join(", ");
        declare += `    function ${method}(${params}): any;\n`;
      }
      declare += `  }\n`;
    }

    declare += `}`;
    const moduleRole = isNodeBuiltin(moduleSpec) ? `node:${normalizeNodeBuiltin(moduleSpec)}` : moduleSpec;
    const classRoles = Object.fromEntries(
      [...classes.keys()].map((className) => [className, `namespace-class:${moduleRole}:${className}`]),
    );
    replacements.push({
      start,
      end,
      text: declare,
      ...(Object.keys(classRoles).length > 0
        ? { compilerOrigins: generatedClassOrigins(declare, "import-wrapper", classRoles) }
        : {}),
    });
  }

  // Default and named imports → declare stubs
  for (const imp of otherImports) {
    const lines: string[] = [];

    // #1791 — bind `node:path` to the pure-TS posix shim (default object +
    // named forwarding functions). The shim function prelude itself is
    // prepended once (see `usesPathShim`).
    if (imp.shimPath) {
      if (imp.defaultName && !definedNames.has(imp.defaultName)) {
        lines.push(buildPathDefaultObject(imp.defaultName));
        usesPathShim = true;
      }
      if (imp.namedBindings) {
        for (const name of imp.namedBindings) {
          if (definedNames.has(name)) continue;
          const binding = buildPathNamedBinding(name);
          if (binding) {
            lines.push(binding);
            usesPathShim = true;
          } else {
            // Unsupported named path export (e.g. parse) — fall back to the
            // generic stub so it doesn't regress.
            lines.push(`declare const ${name}: any;`);
          }
        }
      }
      const replacementText = lines.length > 0 ? lines.join("\n") : `/* node:path shim import removed */`;
      replacements.push({
        start: imp.start,
        end: imp.end,
        text: replacementText,
        compilerOrigins: pathBindingOrigins(replacementText),
      });
      continue;
    }

    // #1492 — when a Node builtin is imported by named bindings (e.g.
    // `import { randomBytes, randomUUID } from "node:crypto"`), emit a typed
    // host-import stub for each known function instead of a plain
    // `declare function ...(a0: any): any`. The stub name uses the
    // `__nodefn__<module>__<fn>` prefix so the import-manifest classifier
    // can route it to a `node_builtin_fn` ImportIntent and the runtime
    // resolver can bind it to `require("crypto")[fn]` (or the browser
    // `globalThis.crypto` fallback).
    const isBuiltin = isNodeBuiltin(imp.moduleSpec);
    const moduleName = isBuiltin ? normalizeNodeBuiltin(imp.moduleSpec) : "";
    const wrapperRoles: Record<string, string> = {};
    const classRoles: Record<string, string> = {};
    const nodeBuiltinFnTypedStub = (name: string): string | null => {
      if (!isBuiltin) return null;
      const stub = NODE_BUILTIN_FN_TYPED_STUBS[moduleName]?.[name];
      if (!stub) return null;
      // #2701 — a `/` in the module name (e.g. `fs/promises`) is not a valid TS
      // identifier char, which would make `__nodefn__fs/promises__readFile` a
      // syntax error. Encode `/` → `$` (a valid identifier char that never
      // appears in a Node module/fn name); the import-manifest classifier
      // decodes `$` → `/` so the runtime resolves `require("fs/promises")`.
      const hostName = `__nodefn__${moduleName.replace(/\//g, "$")}__${name}`;
      wrapperRoles[name] = `node-builtin:${moduleName}:${name}`;
      return (
        `declare function ${hostName}(${stub.params}): ${stub.returns};\n` +
        `function ${name}(${stub.params}): ${stub.returns} { return ${hostName}(${stub.passthrough}); }`
      );
    };

    if (imp.defaultName && !definedNames.has(imp.defaultName)) {
      const typed = nodeBuiltinFnTypedStub(imp.defaultName);
      if (typed) {
        lines.push(typed);
      } else if (calledAsFunction.has(imp.defaultName)) {
        const argCount = maxCallArgs.get(imp.defaultName) ?? 0;
        const params = Array.from({ length: argCount }, (_, i) => `a${i}: any`).join(", ");
        lines.push(`declare function ${imp.defaultName}(${params}): any;`);
      } else {
        lines.push(`declare const ${imp.defaultName}: any;`);
      }
    }

    if (imp.namedBindings) {
      for (const name of imp.namedBindings) {
        // Skip if the name is already defined as a function/variable/class in source
        if (definedNames.has(name)) continue;

        // (#1794) Known node-builtin CLASS exports → extern-class declare stub
        // (namespaced, so the runtime resolves `require(module)[Class]`).
        if (isBuiltin) {
          const classStub = nodeBuiltinClassStub(moduleName, name);
          if (classStub) {
            lines.push(classStub);
            classRoles[name] = `node-builtin-class:${moduleName}:${name}`;
            continue;
          }
        }

        const typed = nodeBuiltinFnTypedStub(name);
        if (typed) {
          lines.push(typed);
          continue;
        }
        if (calledAsFunction.has(name)) {
          const argCount = maxCallArgs.get(name) ?? 0;
          const params = Array.from({ length: argCount }, (_, i) => `a${i}: any`).join(", ");
          lines.push(`declare function ${name}(${params}): any;`);
        } else {
          lines.push(`declare const ${name}: any;`);
        }
      }
    }

    const replacementText = lines.length > 0 ? lines.join("\n") : `/* side-effect import removed */`;
    const compilerOrigins = [
      ...(Object.keys(wrapperRoles).length > 0
        ? generatedFunctionOrigins(replacementText, "import-wrapper", wrapperRoles)
        : []),
      ...(Object.keys(classRoles).length > 0
        ? generatedClassOrigins(replacementText, "import-wrapper", classRoles)
        : []),
    ];
    replacements.push({
      start: imp.start,
      end: imp.end,
      text: replacementText,
      ...(compilerOrigins.length > 0 ? { compilerOrigins } : {}),
    });
  }

  // (#1540) Emit typed declare stubs for JSX runtime bindings. Typed
  // signatures (`(any, any, any) => any` / `() => any`) are important
  // because they make codegen treat the call args / return values as
  // externref. The stubs replace the original `import { jsx as _jsx ...
  // } from "react/jsx-runtime"` statement. We emit them in the position
  // of the *first* JSX runtime import; any subsequent JSX runtime imports
  // are collapsed to a stub comment.
  if (jsxRuntime && jsxRuntimeImportRanges.length > 0) {
    const lines: string[] = [];
    if (jsxRuntime.localJsx) {
      lines.push(`declare function ${jsxRuntime.localJsx}(type: any, props: any, key: any): any;`);
    }
    if (jsxRuntime.localJsxs) {
      lines.push(`declare function ${jsxRuntime.localJsxs}(type: any, props: any, key: any): any;`);
    }
    if (jsxRuntime.localJsxDev) {
      lines.push(
        `declare function ${jsxRuntime.localJsxDev}(type: any, props: any, key: any, isStatic: any, source: any, self: any): any;`,
      );
    }
    if (jsxRuntime.localFragment) {
      // Fragment is referenced as an identifier (e.g. `_jsx(_Fragment, ...)`);
      // codegen routes the identifier to a `() -> externref` host import,
      // but at the TS-checker level it's a const.
      lines.push(`declare const ${jsxRuntime.localFragment}: any;`);
    }
    const replacementText = lines.length > 0 ? lines.join("\n") : `/* JSX runtime import stub */`;
    const [first, ...rest] = jsxRuntimeImportRanges;
    replacements.push({ start: first.start, end: first.end, text: replacementText });
    for (const r of rest) {
      replacements.push({ start: r.start, end: r.end, text: `/* JSX runtime import (merged): ${r.specifier} */` });
    }
  }

  // #1791 — the path-shim function prelude is prepended once, alongside the
  // timer shim. Both are top-level declarations (hoisted), so the relative
  // order is irrelevant; the position map only needs the combined prepend
  // length.
  const pathShim = usesPathShim ? buildPathShim() : "";
  const prelude = pathShim + timerShim;

  // #1928 — capture the import-stub edits (in INPUT coordinates) for the
  // position map BEFORE the reverse-order apply mutates `result`. The map
  // constructor re-sorts ascending, so the apply order here is irrelevant to it.
  const positionMap = buildPreprocessPositionMap(replacements, pathShim, timerShim);

  // Apply replacements in reverse order to preserve positions
  let result = source;
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    result = result.substring(0, r.start) + r.text + result.substring(r.end);
  }

  return {
    source: prelude ? prelude + result : result,
    // Import replacement emits `declare` stubs (and the optional path/timer
    // preludes carry annotations), all of which require TS grammar even when
    // the original source is a `.js` file.
    requiresTsGrammar: true,
    nodeBuiltins,
    jsxRuntime,
    positionMap,
  };
}
