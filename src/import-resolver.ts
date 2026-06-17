// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "./ts-api.js";
import { PositionMap, type SourceEdit } from "./position-map.js";

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
const NODE_BUILTIN_FN_TYPED_STUBS: Record<
  string,
  Record<string, { params: string; returns: string; passthrough: string }>
> = {
  crypto: {
    randomBytes: { params: "size: number", returns: "Uint8Array", passthrough: "size" },
    randomUUID: { params: "", returns: "string", passthrough: "" },
  },
};

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
function buildPreprocessPositionMap(
  replacements: { start: number; end: number; text: string }[],
  timerShimLen: number,
): PositionMap {
  const edits: SourceEdit[] = [];
  if (timerShimLen > 0) {
    edits.push({ origStart: 0, origEnd: 0, newLength: timerShimLen });
  }
  for (const r of replacements) {
    edits.push({ origStart: r.start, origEnd: r.end, newLength: r.text.length });
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
      lines.push(`function ${name}(h: any): void { ${hostName}(h); }`);
    } else {
      lines.push(`declare function ${hostName}(cb: any, ms: any): any;`);
      lines.push(`function ${name}(cb: any, ms: any): any { return ${hostName}(cb, ms); }`);
    }
  }
  if (lines.length === 0) return "";
  return `// #1501 timer host-import shim (auto-injected)\n${lines.join("\n")}\n`;
}

export function preprocessImports(source: string): PreprocessResult {
  const sf = ts.createSourceFile("__preprocess__.ts", source, ts.ScriptTarget.Latest, true);

  // #1501 — detect bare-identifier calls to timer globals BEFORE the early
  // return for source-without-imports, so a file that uses `setTimeout`
  // without any `import` statements still gets the shim. (The
  // `definedNames` reachable at this point includes the same scan used
  // below for the existing import resolution path.)
  const timerCalls = detectTimerCallSites(sf);

  // Step 1: Find all imports
  const nsImports = new Map<string, { start: number; end: number; moduleSpec: string }>();
  const otherImports: {
    start: number;
    end: number;
    defaultName?: string;
    namedBindings?: string[];
    moduleSpec: string;
  }[] = [];
  const nodeBuiltins: NodeBuiltinImport[] = [];
  // (#1540) Per-source JSX runtime import — we only support one
  // `jsxImportSource` per compile unit (matches the TypeScript model).
  // If multiple JSX runtime imports appear, the last one wins.
  let jsxRuntime: JsxRuntimeImport | undefined;
  const jsxRuntimeImportRanges: { start: number; end: number; specifier: string }[] = [];

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    // Import attributes (TS 5.3+ / TS7) — `import x from "m" with { type: "json" }`.
    // We don't yet resolve JSON imports at compile time (tracked as a
    // follow-up to #1288 — JSON imports COULD be inlined statically by reading
    // the JSON file at compile time, but that's out of scope for the shim).
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
    otherImports.push({
      start: stmt.getStart(sf),
      end: stmt.end,
      defaultName,
      namedBindings: namedBindings.length > 0 ? namedBindings : undefined,
      moduleSpec,
    });
    if (isNodeBuiltin(moduleSpec)) {
      nodeBuiltins.push({
        localName: defaultName || namedBindings[0] || normalizeNodeBuiltin(moduleSpec),
        moduleName: normalizeNodeBuiltin(moduleSpec),
        namedBindings: namedBindings.length > 0 ? namedBindings : undefined,
      });
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
      nodeBuiltins,
      jsxRuntime,
      // #1928 — no imports here; only the (optional) timer-shim prepend shifts positions.
      positionMap: buildPreprocessPositionMap([], timerShim.length),
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
  const replacements: { start: number; end: number; text: string }[] = [];

  // Namespace imports → declare namespace
  for (const [nsName, { start, end }] of nsImports) {
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
    replacements.push({ start, end, text: declare });
  }

  // Default and named imports → declare stubs
  for (const imp of otherImports) {
    const lines: string[] = [];
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
    const nodeBuiltinFnTypedStub = (name: string): string | null => {
      if (!isBuiltin) return null;
      const stub = NODE_BUILTIN_FN_TYPED_STUBS[moduleName]?.[name];
      if (!stub) return null;
      const hostName = `__nodefn__${moduleName}__${name}`;
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

    replacements.push({
      start: imp.start,
      end: imp.end,
      text: lines.length > 0 ? lines.join("\n") : `/* side-effect import removed */`,
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

  // #1928 — capture the import-stub edits (in INPUT coordinates) for the
  // position map BEFORE the reverse-order apply mutates `result`. The map
  // constructor re-sorts ascending, so the apply order here is irrelevant to it.
  const positionMap = buildPreprocessPositionMap(replacements, timerShim.length);

  // Apply replacements in reverse order to preserve positions
  let result = source;
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    result = result.substring(0, r.start) + r.text + result.substring(r.end);
  }

  return { source: timerShim ? timerShim + result : result, nodeBuiltins, jsxRuntime, positionMap };
}
