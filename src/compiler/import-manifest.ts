// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "../ts-api.js";
import type { TypedAST } from "../checker/index.js";
import type { CompileError, ImportDescriptor, ImportIntent } from "../index.js";
import type { WasmModule } from "../ir/types.js";
import { hasExportModifier } from "./validation.js";

function classifyImport(name: string, mod: WasmModule): ImportIntent {
  // String literals
  const strValue = mod.stringLiteralValues.get(name);
  if (strValue !== undefined) return { type: "string_literal", value: strValue };

  // Console (log, warn, error)
  // For console.log, keep backward-compatible variant format ("number", "bool", etc.)
  if (name === "console_log_number") return { type: "console_log", variant: "number" };
  if (name === "console_log_bool") return { type: "console_log", variant: "bool" };
  if (name === "console_log_string") return { type: "console_log", variant: "string" };
  if (name === "console_log_externref") return { type: "console_log", variant: "externref" };
  for (const cm of ["warn", "error", "info", "debug"]) {
    if (name === `console_${cm}_number`) return { type: "console_log", variant: `${cm}_number` };
    if (name === `console_${cm}_bool`) return { type: "console_log", variant: `${cm}_bool` };
    if (name === `console_${cm}_string`) return { type: "console_log", variant: `${cm}_string` };
    if (name === `console_${cm}_externref`) return { type: "console_log", variant: `${cm}_externref` };
  }

  // Math
  if (name.startsWith("Math_")) return { type: "math", method: name.slice(5) };

  // String compare (lexicographic ordering)
  if (name === "string_compare") return { type: "builtin", name };

  // String methods
  if (name.startsWith("string_")) return { type: "string_method", method: name.slice(7) };

  // Builtins
  if (name === "number_toString") return { type: "builtin", name };
  if (name === "number_toFixed") return { type: "builtin", name };
  if (name === "number_toPrecision") return { type: "builtin", name };
  if (name === "number_toExponential") return { type: "builtin", name };

  // Date
  if (name === "Date_new") return { type: "date_new" };
  if (name === "__date_now") return { type: "date_now" };
  if (name.startsWith("Date_")) return { type: "date_method", method: name.slice(5) };

  // Extern classes — check mod.externClasses
  for (const ec of mod.externClasses) {
    const prefix = ec.importPrefix;
    const nsPath = ec.namespacePath.length > 0 ? ec.namespacePath : undefined;
    if (name === `${prefix}_new`)
      return { type: "extern_class", className: ec.className, action: "new", namespacePath: nsPath };
    for (const [methodName] of ec.methods) {
      if (name === `${prefix}_${methodName}`)
        return {
          type: "extern_class",
          className: ec.className,
          action: "method",
          member: methodName,
          namespacePath: nsPath,
        };
    }
    for (const [propName] of ec.properties) {
      if (name === `${prefix}_get_${propName}`)
        return {
          type: "extern_class",
          className: ec.className,
          action: "get",
          member: propName,
          namespacePath: nsPath,
        };
      if (name === `${prefix}_set_${propName}`)
        return {
          type: "extern_class",
          className: ec.className,
          action: "set",
          member: propName,
          namespacePath: nsPath,
        };
    }
  }

  // Callback maker
  if (name === "__make_callback") return { type: "callback_maker" };
  // (#4394) Same maker, constructible bridge — see closures.ts.
  if (name === "__make_callback_ctor") return { type: "callback_maker", constructible: true };
  if (name === "__make_getter_callback") return { type: "getter_callback_maker" };

  // Async/await
  if (name === "__await") return { type: "await" };

  // Dynamic import()
  if (name === "__dynamic_import") return { type: "dynamic_import" };

  // Proxy
  if (name === "__proxy_create") return { type: "proxy_create" };

  // Union type helpers
  if (name === "__typeof_number") return { type: "typeof_check", targetType: "number" };
  if (name === "__typeof_string") return { type: "typeof_check", targetType: "string" };
  if (name === "__typeof_boolean") return { type: "typeof_check", targetType: "boolean" };
  if (name === "__typeof_bigint") return { type: "typeof_check", targetType: "bigint" };
  if (name === "__typeof_undefined") return { type: "typeof_check", targetType: "undefined" };
  if (name === "__typeof_object") return { type: "typeof_check", targetType: "object" };
  if (name === "__typeof_function") return { type: "typeof_check", targetType: "function" };
  if (name === "__unbox_number") return { type: "unbox", targetType: "number" };
  if (name === "__unbox_symbol") return { type: "unbox", targetType: "symbol" };
  // Symbol-safe array-index probe (#3511): like __unbox_number (ToNumber) but
  // NEVER throws — a Symbol/BigInt key (or any ToNumber-throwing value) returns
  // NaN so the element-access caller falls to the string/symbol-keyed property
  // path instead of throwing "Cannot convert a Symbol value to a number".
  if (name === "__any_to_index") return { type: "any_to_index" };
  if (name === "__unbox_boolean") return { type: "unbox", targetType: "boolean" };
  if (name === "__box_number") return { type: "box", targetType: "number" };
  if (name === "__box_boolean") return { type: "box", targetType: "boolean" };
  if (name === "__box_bigint") return { type: "box", targetType: "bigint" };
  if (name === "__to_bigint") return { type: "unbox", targetType: "bigint" };
  if (name === "__bigint_ctor") return { type: "builtin", name: "__bigint_ctor" };
  if (name === "__bigint_ctor_ref") return { type: "builtin", name: "__bigint_ctor_ref" };
  if (name === "__is_truthy") return { type: "truthy_check" };
  if (name === "__typeof") return { type: "builtin", name: "__typeof" };

  // globalThis
  if (name === "__get_globalThis") return { type: "declared_global", name: "globalThis" };

  // defineProperty with accessor descriptor
  if (name === "__defineProperty_accessor") return { type: "builtin", name: "__defineProperty_accessor" };

  // Extern get/set
  if (name === "__extern_get") return { type: "extern_get" };
  if (name === "__extern_get_raw_callable") return { type: "extern_get", rawCallable: true };
  if (name.startsWith("__extern_call_raw_callable_")) {
    const arity = Number.parseInt(name.slice("__extern_call_raw_callable_".length), 10);
    return { type: "extern_call_raw_callable", arity };
  }
  if (name === "__extern_set") return { type: "extern_set" };
  if (name === "__extern_set_strict") return { type: "extern_set_strict" }; // (#2017) strict [[Set]]
  if (name.startsWith("__boundary_callback_call_")) {
    return { type: "boundary_callback", arity: Number.parseInt(name.slice("__boundary_callback_call_".length), 10) };
  }
  if (name === "__boundary_promise_resolve") return { type: "boundary_promise", operation: "resolve" };
  if (name === "__boundary_promise_reject") return { type: "boundary_promise", operation: "reject" };
  if (name === "__get_caught_exception") return { type: "caught_exception" };
  if (name === "__boundary_object_get") return { type: "boundary_object", operation: "get" };
  if (name === "__boundary_object_set") return { type: "boundary_object", operation: "set" };
  if (name === "__boundary_object_has") return { type: "boundary_object", operation: "has" };
  if (name === "__boundary_object_delete") return { type: "boundary_object", operation: "delete" };
  if (name === "__boundary_object_keys") return { type: "boundary_object", operation: "keys" };
  if (name === "__boundary_object_call") return { type: "boundary_object", operation: "call" };
  if (name === "__boundary_object_apply") return { type: "boundary_object", operation: "apply" };
  if (name === "__boundary_object_construct") return { type: "boundary_object", operation: "construct" };
  if (name === "__boundary_object_reflect_get") return { type: "boundary_object", operation: "reflectGet" };
  if (name === "__boundary_object_reflect_set") return { type: "boundary_object", operation: "reflectSet" };
  if (name === "__boundary_object_get_prototype") return { type: "boundary_object", operation: "getPrototypeOf" };
  if (name === "__boundary_object_set_prototype") return { type: "boundary_object", operation: "setPrototypeOf" };
  if (name === "__boundary_object_get_own_property_descriptor") {
    return { type: "boundary_object", operation: "getOwnPropertyDescriptor" };
  }
  if (name === "__boundary_object_define_property_value") {
    return { type: "boundary_object", operation: "definePropertyValue" };
  }
  if (name === "__boundary_object_define_property_accessor") {
    return { type: "boundary_object", operation: "definePropertyAccessor" };
  }
  if (name === "__boundary_object_get_own_property_names") {
    return { type: "boundary_object", operation: "getOwnPropertyNames" };
  }
  if (name === "__boundary_object_get_own_property_symbols") {
    return { type: "boundary_object", operation: "getOwnPropertySymbols" };
  }
  if (name === "__boundary_object_own_keys") return { type: "boundary_object", operation: "ownKeys" };
  if (name === "__boundary_object_is_admitted") return { type: "boundary_object", operation: "isAdmitted" };
  if (name === "__boundary_object_callable_kind") {
    return { type: "boundary_object", operation: "callableKind" };
  }
  if (name === "__boundary_object_prevent_extensions") {
    return { type: "boundary_object", operation: "preventExtensions" };
  }
  if (name === "__boundary_object_reflect_prevent_extensions") {
    return { type: "boundary_object", operation: "reflectPreventExtensions" };
  }
  if (name === "__boundary_object_seal") return { type: "boundary_object", operation: "seal" };
  if (name === "__boundary_object_freeze") return { type: "boundary_object", operation: "freeze" };
  if (name === "__boundary_object_is_extensible") return { type: "boundary_object", operation: "isExtensible" };
  if (name === "__boundary_object_is_sealed") return { type: "boundary_object", operation: "isSealed" };
  if (name === "__boundary_object_is_frozen") return { type: "boundary_object", operation: "isFrozen" };
  if (name === "__boundary_object_for_in_keys") {
    return { type: "boundary_object", operation: "forInKeys" };
  }

  // Host strict-equality for two externref operands that are not WasmGC eqrefs
  // (e.g. host functions like `Array === Array`). (#1065)
  if (name === "__host_eq") return { type: "host_eq" };

  // Host loose-equality for two externref operands (§7.2.15 Abstract Equality).
  // Used for `any`-typed loose equality where null == undefined must be true. (#1134)
  if (name === "__host_loose_eq") return { type: "host_loose_eq" };

  // Host `+` for two externref operands (§13.15.3 ApplyStringOrNumericBinaryOperator).
  // Used for `any`/externref-typed `+`/`+=` where a runtime string must concatenate
  // rather than coerce to f64 (`1 + "2"` → `"12"`, not `3`). ToPrimitive + the
  // string-if-either-is-string rule come free from JS `+`. (#2058)
  if (name === "__host_add") return { type: "host_add" };

  // Host BigInt-mixed binary operator for a BigInt combined with a
  // dynamically-object/any operand whose ToNumeric may reduce to a BigInt
  // (`Object(2n) * 2n`, `{valueOf(){return 2n}} - 2n`). The i32 opcode selects
  // the operator; struct operands are ToPrimitive-reduced via the in-module
  // dispatcher, then JS applies ToNumeric + the mix-TypeError check + BigInt
  // arithmetic. (#3481)
  if (name === "__host_bigint_binop") return { type: "host_bigint_binop" };

  // Host relational compare for two externref operands (§7.2.13 IsLessThan).
  // Returns a 4-way result -1/0/1/2 (2 = NaN/undefined-incomparable) so the
  // four relational operators (<,<=,>,>=) map without separate imports, and
  // string operands compare lexicographically rather than coercing to NaN. (#2059)
  if (name === "__host_compare") return { type: "host_compare" };

  // SameValueZero comparison (§7.2.11) — like === except NaN equals NaN.
  // Used by Array.prototype.includes on array-like receivers (#1360).
  if (name === "__same_value_zero") return { type: "same_value_zero" };

  // Browser Storage interface (#1502)
  if (name === "__get_localStorage") return { type: "web_storage", which: "local" };
  if (name === "__get_sessionStorage") return { type: "web_storage", which: "session" };

  // Node-specific module-scope values (#1494)
  if (name === "__get_dirname") return { type: "node_dirname" };
  if (name === "__get_filename") return { type: "node_filename" };
  if (name === "__get_import_meta_url") return { type: "node_import_meta_url" };

  // Node builtin module functions — typed function imports (#1491)
  // e.g. `__node_fs_readFileSync` → { moduleName: "fs", name: "readFileSync" }
  if (name.startsWith("__node_fs_")) {
    return { type: "node_builtin_fn", moduleName: "fs", name: name.slice("__node_fs_".length) };
  }

  // Node builtin modules (#1044) — module-shaped imports returning the whole module object
  if (name.startsWith("__node_")) return { type: "node_builtin", moduleName: name.slice(7) };

  // #1501 — Timer host imports.
  if (name === "__timer_set_timeout") return { type: "timer_set", mode: "timeout" };
  if (name === "__timer_set_interval") return { type: "timer_set", mode: "interval" };
  if (name === "__timer_clear_timeout") return { type: "timer_clear", mode: "timeout" };
  if (name === "__timer_clear_interval") return { type: "timer_clear", mode: "interval" };

  // #1492 — Node builtin function host imports (e.g. `crypto.randomUUID`).
  // Format: `__nodefn__<module>__<fnName>`. Both module and fnName must be
  // non-empty; we split on the first `__` boundary inside the payload.
  if (name.startsWith("__nodefn__")) {
    const payload = name.slice("__nodefn__".length);
    const sepIdx = payload.indexOf("__");
    if (sepIdx > 0) {
      // #2701 — decode the `/`→`$` encoding applied to slashed module names
      // (e.g. `fs$promises` → `fs/promises`) so the runtime resolves the real
      // `require("fs/promises")`. `$` never appears in a Node module name, so the
      // decode is unambiguous.
      const moduleName = payload.slice(0, sepIdx).replace(/\$/g, "/");
      const fnName = payload.slice(sepIdx + 2);
      if (fnName.length > 0) {
        return { type: "node_builtin_fn", moduleName, name: fnName };
      }
    }
  }

  // JSX runtime imports (#1540) — `_jsx`/`_jsxs`/`_Fragment`/`_jsxDEV` after
  // TypeScript desugars JSX with `jsx: react-jsx`. The host binding is
  // either a user-supplied `deps.jsxRuntime` or a built-in React-shaped
  // fallback. The `specifier` is recorded on the WasmModule by codegen
  // (see `mod.jsxImportSource`); we default to `"react/jsx-runtime"`.
  if (name.startsWith("__jsx_runtime_")) {
    const method = name.slice("__jsx_runtime_".length);
    const specifier = mod.jsxImportSource ?? "react/jsx-runtime";
    if (method === "jsx" || method === "jsxs" || method === "Fragment" || method === "jsxDEV") {
      return { type: "jsx_runtime", method, specifier };
    }
  }

  // Declared globals (like `declare const document: Document`)
  if (name.startsWith("global_")) return { type: "declared_global", name: name.slice(7) };

  // __new_plain_object is a builtin factory, not an extern class constructor
  if (name === "__new_plain_object") return { type: "builtin", name: "__new_plain_object" };

  // (#1467) AggregateError needs spec-specific coercion (ToString on message,
  // IterableToList on errors, CreateMethodProperty for non-enumerable own
  // properties) that the generic `extern_class` path can't provide. Route
  // through the dedicated builtin handler in the runtime.
  if (name === "__new_AggregateError") return { type: "builtin", name };

  // (#1339) SuppressedError likewise needs spec-specific construction
  // (CreateNonEnumerableDataPropertyOrThrow for error/suppressed/message,
  // InstallErrorCause via HasProperty for opaque WasmGC options struct).
  // The generic `extern_class` path drops options entirely. Route through the
  // dedicated runtime builtin like AggregateError.
  if (name === "__new_SuppressedError") return { type: "builtin", name };

  // (#2728) `Object(Symbol())` → Symbol-wrapper object. Symbol is NOT a
  // constructor, so the generic `extern_class` `new Symbol(id)` path throws.
  // Route through a dedicated builtin handler that boxes the i32 symbol id and
  // returns `Object(sym)`.
  if (name === "__new_Symbol") return { type: "builtin", name };

  // (#4394) `new Test262Error(msg)` in a module that DECLARES `function
  // Test262Error` (every literal-upstream-harness assembly does — sta.js).
  // Takes the module's own constructor value as a second argument so the
  // host-built Error carries a `.constructor` back-pointer that is `===` the
  // identifier read. Must precede the generic `__new_` extern_class arm below,
  // which would otherwise resolve it as a class named `Test262Error_ctor`.
  if (name === "__new_Test262Error_ctor") return { type: "builtin", name };

  // Unknown constructor imports (__new_ClassName)
  if (name.startsWith("__new_")) {
    return { type: "extern_class", className: name.slice(6), action: "new" };
  }

  // Fallback
  return { type: "builtin", name };
}

function buildImportManifest(mod: WasmModule): ImportDescriptor[] {
  const manifest: ImportDescriptor[] = [];
  for (const imp of mod.imports) {
    if (imp.module !== "env") continue;
    // (#4150) Carry the declared parameter count for func imports so the host
    // side can build fixed-arity wrappers (see ImportDescriptor.paramCount).
    let paramCount: number | undefined;
    if (imp.desc.kind === "func") {
      const t = mod.types[imp.desc.typeIdx];
      if (t && t.kind === "func") paramCount = t.params.length;
    }
    manifest.push({
      module: "env",
      name: imp.name,
      kind: imp.desc.kind === "func" ? "func" : "global",
      intent: classifyImport(imp.name, mod),
      paramCount,
    });
  }
  return manifest;
}

/** Check if TS syntax errors look like the source is plain JavaScript (no type annotations). */
function looksLikeTsSyntaxOnJs(
  diagnostics: readonly { code: number; messageText: string | ts.DiagnosticMessageChain }[],
): boolean {
  // TS error codes that indicate TS-specific syntax was expected but not found,
  // or the parser hit JS-only patterns it can't handle in .ts mode.
  // Common: 1005 (';' expected), 2304 (cannot find name), 2552 (cannot find name, did you mean),
  // 1109 (expression expected — happens with arrow functions returning JSX-like).
  // We also check message text for typical TS-on-JS confusion.
  for (const d of diagnostics) {
    const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
    // These patterns strongly suggest the user passed JS to the TS parser
    if (msg.includes("Type annotations can only be used in TypeScript files")) return true;
    if (msg.includes("types can only be used in a .ts file")) return true;
    if (msg.includes("'type' modifier cannot be used in a JavaScript file")) return true;
  }
  return false;
}

/**
 * Detect untyped parameters in JS mode and add helpful warnings suggesting JSDoc annotations.
 * Returns warning CompileErrors for each function parameter that resolved to 'any'.
 */
function checkJsTypeCoverage(ast: TypedAST): CompileError[] {
  const warnings: CompileError[] = [];
  const sf = ast.sourceFile;

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      const fnName = node.name.text;
      for (const param of node.parameters) {
        const paramType = ast.checker.getTypeAtLocation(param);
        if (paramType.flags & ts.TypeFlags.Any) {
          const paramName = ts.isIdentifier(param.name) ? param.name.text : "?";
          const { line, character } = sf.getLineAndCharacterOfPosition(param.getStart());
          warnings.push({
            message:
              `Parameter '${paramName}' in function '${fnName}' has implicit 'any' type. ` +
              `Add a JSDoc annotation: /** @param {number} ${paramName} */`,
            line: line + 1,
            column: character + 1,
            severity: "warning",
          });
        }
      }
      // Check return type
      const sig = ast.checker.getSignatureFromDeclaration(node);
      if (sig) {
        const retType = ast.checker.getReturnTypeOfSignature(sig);
        if (retType.flags & ts.TypeFlags.Any) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.name.getStart());
          warnings.push({
            message:
              `Function '${fnName}' has implicit 'any' return type. ` +
              `Add a JSDoc annotation: /** @returns {number} */`,
            line: line + 1,
            column: character + 1,
            severity: "warning",
          });
        }
      }
    }
    forEachChild(node, visit);
  }

  visit(sf);
  return warnings;
}

// TS diagnostics that the wasm codegen can handle gracefully —
// downgrade from error to warning so they don't block compilation.
const DOWNGRADE_DIAG_CODES = new Set([
  2304, // "Cannot find name 'X'" — unknown identifiers compiled as externref/unreachable
  2580, // "Cannot find name 'X'. Do you need to install type definitions for node?" — e.g. `process` under --target wasi, supported natively (node-fs-api.ts)
  2591, // "Cannot find name 'X'. Do you need to install type definitions for a web worker?" — DOM/worker globals codegen handles or stubs
  2339, // "Property 'X' does not exist on type 'Y'" — dynamic property access
  2551, // "Property 'X' does not exist on type 'Y'. Did you mean 'Z'?" — variant of 2339 with suggestion (#613)
  2454, // "Variable 'X' is used before being assigned"
  2531, // "Object is possibly 'null'" — codegen has null guards (#406)
  2532, // "Object is possibly 'undefined'" — codegen has null guards (#406)
  2533, // "Object is possibly 'null' or 'undefined'" — codegen has null guards (#406)
  2367, // "This comparison appears to be unintentional" (always truthy/falsy)
  2554, // "Expected N arguments, but got M"
  2683, // "'this' implicitly has type 'any'"
  2695, // "Left side of comma operator is unused and has no side effects"
  2769, // "No overload matches this call"
  18047, // "'X' is possibly 'null'" — codegen has null guards (#406)
  18049, // "'X' is possibly 'null' or 'undefined'" — codegen has null guards (#406)
  2358, // "The left-hand side of an 'instanceof' expression must be..."
  2356, // "An arithmetic operand must be of type 'any', 'number', 'bigint' or an enum type" — prefix/postfix inc/dec on non-number
  2362, // "The left-hand side of an arithmetic operation must be..."
  2365, // "Operator 'X' cannot be applied to types 'Y' and 'Z'"
  1503, // "This regular expression flag is only available when targeting 'es2024'" (#654)
  1232, // "An import declaration can only be used at the top level of a namespace or module" (#654)
  18050, // "The value 'null'/'undefined' cannot be used here"
  2698, // "Spread types may only be created from object types" — codegen handles spread generically (#536)
  2872, // "This kind of expression is always truthy"
  2873, // "This kind of expression is always falsy"
  2363, // "The right-hand side of an arithmetic operation must be..."
  2869, // "Right operand of ?? is unreachable because the left operand is never nullish"
  2349, // "This expression is not callable"
  2552, // "Cannot find name 'X'. Did you mean 'Y'?"
  18046, // "'X' is of type 'unknown'"
  2881, // "This expression is never nullish" — false positive in allowJs mode
  2871, // "This expression is always nullish"
  18048, // "'X' is possibly 'undefined'"
  2839, // "This condition will always return true/false since JS compares objects by reference"
  2703, // "The operand of a 'delete' operator must be a property reference"
  2704, // "The operand of a 'delete' operator cannot be a read-only property" — valid JS delete (#520)
  2790, // "The operand of a 'delete' operator must be optional" — valid JS delete (#520)
  2630, // "Cannot assign to 'X' because it is a function"
  2447, // "The '|'/'&' operator is not allowed for boolean types"
  2300, // "Duplicate identifier 'X'"
  2408, // "Setters cannot return a value" — valid in JS, codegen handles it
  1345, // "An expression of type 'void' cannot be tested for truthiness"
  2350, // "Only a void function can be called with the 'new' keyword"
  2403, // "Subsequent variable declarations must have the same type" — var re-declarations legal in JS
  2377, // "Constructors for derived classes must contain a 'super' call" — valid JS pattern
  2376, // "A 'super' call must be the first statement in the constructor" — valid JS pattern
  17009, // "'super' must be called before accessing 'this' in derived class constructor"
  17011, // "'super' must be called before accessing a property of 'super' in derived class constructor"
  2540, // "Cannot assign to 'X' because it is a read-only property" — private fields are writable in JS
  2803, // "Cannot assign to private method 'X'. Private methods are not writable" — valid JS pattern
  2806, // "Private accessor was defined without a getter" — valid JS pattern
  18030, // "An optional chain cannot contain private identifiers" — valid JS pattern
  2729, // "Property 'X' is used before its initialization" — valid JS pattern
  1163, // "A 'yield' expression is only allowed in a generator body" — #267
  1435, // "Unknown keyword or identifier. Did you mean 'X'?" — yield in nested generator contexts (#521)
  1220, // "Generators are not allowed in an ambient context" — valid JS pattern (#267)
  1166, // "A computed property name in a class property declaration must have a simple literal type" — #265
  2464, // "A computed property name must be of type 'string', 'number', 'symbol', or 'any'" — #276
  2488, // "Type must have a '[Symbol.iterator]()' method" — #268
  2489, // "An iterator must have a 'next()' method" — iterator protocol (#153)
  1103, // "'for await' loops are only allowed within async functions and at the top levels of modules" — #612
  2504, // "Type must have a '[Symbol.asyncIterator]()' method that returns an async iterator" — #612
  2519, // "An async iterator must have a 'next()' method" — async iterator protocol (#612)
  2547, // "The type returned by the 'next()' method of an async iterator must be a promise for a type with a 'value' property" — #612
  2548, // "Type is not an array type or does not have '[Symbol.iterator]()'" — #268
  2549, // "Type is not an array/string type or does not have '[Symbol.iterator]()'" — #268
  2768, // "The 'next' property of an async iterator must be a method" — #612
  2763, // "Cannot iterate value because the 'next' method expects type X" — for-of iteration (#153)
  2764, // "Cannot iterate value because the 'next' method expects type X (array spread)" — (#153)
  2765, // "Cannot iterate value because the 'next' method expects type X (destructuring)" — (#153)
  18014, // "The property '#x' cannot be accessed on type 'X' within this class because it is shadowed" — valid JS
  2538, // "Type 'X' cannot be used as an index type" — valid JS pattern (e.g. symbol/boolean as index)
  1468, // "A computed property name must be of type 'string', 'number', 'symbol', or 'any'" — valid JS
  2556, // "A spread argument must either have a tuple type or be passed to a rest parameter" — valid JS spread (#382)
  2741, // "Property 'X' is missing in type 'Y' but required in type 'Z'" — valid JS object patterns
  2493, // "Tuple type '[]' of length 'N' has no element at index 'M'" — destructuring empty/short tuples (#379)
  2689, // "Cannot extend an interface 'X'. Did you mean 'implements'?" — Iterator/Generator class patterns (#616)
  2700, // "Rest types may only be created from object types" — object rest on primitives (#379)
  1212, // "Identifier expected. 'X' is a reserved word in strict mode" — valid in sloppy JS (#270)
  1214, // "Identifier expected. 'yield' is a reserved word in strict mode. Modules are automatically in strict mode." — yield as identifier in sloppy JS (#241)
  1308, // "'await' expressions are only allowed within async functions and at the top levels of modules" — codegen handles await in non-async as identity (#666)
  2378, // "A 'get' accessor must return a value" — valid JS pattern, getter can return undefined implicitly (#377)
  1052, // "A 'set' accessor parameter cannot have an initializer" — valid JS pattern, setter params can have defaults (#377)
  7033, // "Property 'X' implicitly has type 'any', because its get accessor lacks a return type annotation" — valid JS (#377)
  1100, // "Invalid use of 'X' in strict mode" — sloppy-mode JS allows assignment to eval/arguments (#331)
  1215, // "Invalid use of 'X'. Modules are automatically in strict mode" — sloppy-mode JS allows eval/arguments as targets (#331)
  1210, // "Code contained in a class is evaluated in strict mode which does not allow this use of 'X'" — sloppy-mode JS pattern (#331)
  1156, // "'let' declarations can only be declared inside a block" — sloppy-mode JS pattern (#383)
  1313, // "The body of an 'if' statement cannot be the empty statement" — sloppy-mode JS pattern (#383)
  1344, // "A label is not allowed here" — labeled function declarations in sloppy-mode JS (#383)
  1182, // "A destructuring declaration must have an initializer" — valid JS pattern (#383)
  1228, // "A type predicate is only allowed in return type position" — valid JS pattern (#383)
  7053, // "Element implicitly has an 'any' type because expression can't be used to index type" — numeric/string index on plain objects (#391)
  2318, // "Cannot find global type 'X'" — e.g. ClassDecoratorContext, AsyncIterableIterator (#271)
  2468, // "Cannot find global value 'X'" — e.g. Promise (#271)
  2583, // "Cannot find name 'X'. Do you need to change your target library?" — e.g. BigInt, Reflect (#271)
  2585, // "'X' only refers to a type, but is being used as a value here" (target library) (#271)
  2693, // "'X' only refers to a type, but is being used as a value here" (#271)
  2697, // "An async function or method must return a 'Promise'" (#271)
  2705, // "An async function or method in ES5 requires the 'Promise' constructor" (#271)
  1206, // "Decorators are not valid here" — decorator syntax suppressed, decorators ignored (#376)
  1207, // "Decorators cannot be applied to multiple get/set accessors of the same name" (#376)
  1236, // "The return type of a property decorator function must be either 'void' or 'any'" (#376)
  1237, // "The return type of a parameter decorator function must be either 'void' or 'any'" (#376)
  1238, // "Unable to resolve signature of class decorator when called as an expression" (#271)
  1239, // "Unable to resolve signature of parameter decorator when called as an expression" (#271)
  1240, // "Unable to resolve signature of property decorator when called as an expression" (#271)
  1241, // "Unable to resolve signature of method decorator when called as an expression" (#271)
  1249, // "A decorator can only decorate a method implementation, not an overload" (#376)
  1270, // "Decorator function return type is not assignable" (#376)
  1271, // "Decorator function return type is not void or any" (#376)
  1278, // "The runtime will invoke the decorator with N arguments, but the decorator expects M" (#376)
  1279, // "The runtime will invoke the decorator with N arguments, but the decorator expects at least M" (#376)
  1329, // "Decorator accepts too few arguments" (#376)
  1433, // "Neither decorators nor modifiers may be applied to 'this' parameters" (#376)
  1436, // "Decorators must precede the name and all keywords of property declarations" (#376)
  1486, // "Decorator used before 'export' here" (#376)
  1497, // "Expression must be enclosed in parentheses to be used as a decorator" (#376)
  1498, // "Invalid syntax in decorator" (#376)
  8038, // "Decorators may not appear after 'export' or 'export default'" (#376)
  18036, // "Class decorators can't be used with static private identifier" (#376)
  2372, // "Parameter 'x' cannot reference itself" — valid JS pattern (#413)
  2373, // "Parameter 'x' cannot reference identifier 'y' declared after it" — valid JS pattern (#413)
  2735, // "Initializer of parameter 'x' cannot reference identifier 'y'" — valid JS pattern (#413)
  1106, // "The left-hand side of a 'for...of' statement may not be 'async'" — valid in sloppy-mode JS (#425)
  2711, // "A dynamic import call returns a 'Promise'" — dynamic import() (#440)
  2792, // "Cannot find module 'X'" — dynamic import() module resolution (#440)
  2739, // "Type 'X' is missing properties: next, return, throw" — generator type mismatch (#439)
  2802, // "Type 'X' can only be iterated through when using '--downlevelIteration'" — generators in for-of (#439)
  1102, // "'delete' cannot be called on an identifier in strict mode" — valid sloppy-mode JS (#535)
  1184, // "Modifiers cannot appear here" — valid JS patterns in test262 (#537)
  1109, // "Expression expected" — valid JS patterns in test262 (#537)
  1135, // "Argument expression expected" — valid JS patterns in test262 (#537)
  2351, // "This expression is not constructable" — valid JS patterns in test262 (#537)
  2335, // "'super' can only be referenced in a derived class" — valid JS patterns in test262 (#537)
  2660, // "'super' can only be referenced in members of derived classes or object literal expressions" — valid JS (#537)
  2508, // "No base constructor has the specified number of type arguments" — valid JS patterns in test262 (#537)
  1262, // "Identifier expected. 'X' is a reserved word at the top-level of a module" — await as identifier (#537)
  2393, // "Duplicate function implementation" — valid JS function re-declarations (#537)
  2721, // "Cannot invoke an object which is possibly 'null' or 'undefined'" — codegen has null guards (#406)
  2722, // "Cannot invoke an object which is possibly 'null'" — codegen has null guards (#406)
  2723, // "Cannot invoke an object which is possibly 'undefined'" — codegen has null guards (#406)
  2448, // "Block-scoped variable 'X' used before its declaration" — valid JS TDZ pattern, runtime ReferenceError (#723)
  2474, // "Cannot access 'X' before initialization" — valid JS TDZ pattern, runtime ReferenceError (#723)
  1489, // "Decimals with leading zeros are not allowed" — valid sloppy-mode JS octal literals
  1121, // "Octal literals are not allowed in strict mode" — valid sloppy-mode JS
  // #2708 — legacy string-literal escapes are valid in sloppy mode (Annex B
  // §12.9.4: LegacyOctalEscapeSequence + NonOctalDecimalEscapeSequence). Downgrade
  // the TS scanner errors so non-strict code compiles; the strict-mode SyntaxError
  // is re-enforced by the ES early-error pass (node-checks.ts), mirroring the
  // numeric-octal treatment above.
  1487, // "Octal escape sequences are not allowed. Use the syntax '\\xNN'." (string '\251')
  1488, // "Escape sequence '\\8'/'\\9' is not allowed." (NonOctalDecimalEscapeSequence)
]);

export { buildImportManifest, checkJsTypeCoverage, classifyImport, DOWNGRADE_DIAG_CODES, looksLikeTsSyntaxOnJs };
