// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { TypedAST } from "../checker/index.js";
import type { JavaScriptAdapterManifestV1 } from "../adapter-manifest.js";
import { analyzeSource } from "../checker/index.js";
import type { CabiExportInfo, ParamDef, TsSemanticType } from "../codegen-linear/c-abi.js";
import { emitCabiWrappers, inferSemantic, mapParamsToCabi, mapResultToCabi } from "../codegen-linear/c-abi.js";
import { absoluteFuncIndexCached } from "../emit/resolve-layout.js"; // (#1916 S3)
import { generateModule } from "../codegen/index.js";
import { isFatalCodegenDiagnostic } from "../codegen/context/errors.js";
import { extractCHeaderExports, generateCHeader } from "../emit/c-header.js";
import { emitObject } from "../emit/object.js";
import { preprocessImports } from "../import-resolver.js";
import type { CompileError, CompileOptions } from "../index.js";
import type { Instr, ValType, WasmModule } from "../ir/types.js";
import { resolveCompileTargetProfile } from "../target-profile.js";
import { DOWNGRADE_DIAG_CODES } from "./import-manifest.js";
import { hasExportModifier, pushSourceAnchoredDiagnostic } from "./validation.js";

/** TS-level type text for an exported function's params + return. */
interface CabiTsTypes {
  paramTypes: (string | undefined)[];
  returnType: string | undefined;
}

/**
 * Collect TS param/return type text for each exported top-level function so
 * the C ABI transform can classify string/array aggregates (which lower to
 * an i32 header pointer indistinguishable from a plain number at the Wasm
 * level). Keyed by exported function name (#1835).
 */
function collectCabiTsTypes(ast: TypedAST): Map<string, CabiTsTypes> {
  const map = new Map<string, CabiTsTypes>();
  const sf = ast.sourceFile;
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const paramTypes = stmt.parameters.map((p) => p.type?.getText(sf));
      map.set(stmt.name.text, {
        paramTypes,
        returnType: stmt.type?.getText(sf),
      });
    }
  }
  return map;
}

/**
 * Apply C ABI transformation to a compiled WasmModule.
 * Rewrites exported function signatures for C compatibility and generates a C header.
 */
function applyCabiTransform(mod: WasmModule, moduleName: string, ast?: TypedAST): { cHeader: string } {
  const numImportFuncs = mod.imports.filter((i) => i.desc.kind === "func").length;
  const tsTypes = ast ? collectCabiTsTypes(ast) : new Map<string, CabiTsTypes>();

  // Build CabiExportInfo for each exported function
  const exportInfos: CabiExportInfo[] = [];
  for (const exp of mod.exports) {
    if (exp.desc.kind !== "func") continue;
    if (exp.name === "memory") continue;

    // (#1916 S3) normalize a possibly-stable handle to the absolute index.
    const funcIdx = absoluteFuncIndexCached(mod, numImportFuncs, exp.desc.index);
    const localIdx = funcIdx - numImportFuncs;
    if (localIdx < 0 || localIdx >= mod.functions.length) continue;

    const func = mod.functions[localIdx];
    const typeDef = mod.types[func.typeIdx];
    if (!typeDef || typeDef.kind !== "func") continue;

    // String/array params + returns lower to i32 header pointers, so we can
    // only distinguish them from plain numbers using the TS source types.
    // Only apply TS-type inference when the declared param count matches the
    // Wasm param count — otherwise a prepended `this`/closure param would skew
    // the mapping, so we fall back to scalar treatment (#1835).
    const declared = tsTypes.get(exp.name);
    const useTsTypes = declared !== undefined && declared.paramTypes.length === typeDef.params.length;

    // Build ParamDefs from the function type
    const paramDefs: ParamDef[] = typeDef.params.map((wt, i) => {
      let semantic: TsSemanticType;
      if (useTsTypes) {
        semantic = inferSemantic(wt, declared!.paramTypes[i]);
        // string/array lower to i32; if the TS type disagrees with the Wasm
        // type (e.g. a number that happens to be i32), inferSemantic already
        // reconciles via the wasmType, so the result is consistent.
      } else {
        semantic = wt.kind === "f64" ? "number_f64" : "number_i32";
      }
      return { name: `p${i}`, wasmType: wt, semantic };
    });

    const cabiParams = mapParamsToCabi(paramDefs);

    let resultSemantic: TsSemanticType | "void";
    if (typeDef.results.length === 0) {
      resultSemantic = "void";
    } else if (useTsTypes && declared!.returnType) {
      const inferred = inferSemantic(typeDef.results[0], declared!.returnType);
      // A string/array return must be backed by an i32 header pointer.
      resultSemantic =
        (inferred === "string" || inferred === "array") && typeDef.results[0].kind !== "i32"
          ? typeDef.results[0].kind === "f64"
            ? "number_f64"
            : "number_i32"
          : inferred;
    } else {
      resultSemantic = typeDef.results[0].kind === "f64" ? "number_f64" : "number_i32";
    }
    const cabiResult = mapResultToCabi(typeDef.results.length > 0 ? typeDef.results[0] : null, resultSemantic);

    const cabiName = exp.name; // mangleCabiName is identity for simple names

    exportInfos.push({
      tsName: exp.name,
      cabiName,
      params: cabiParams,
      result: cabiResult,
    });
  }

  // Apply wrappers for functions that need them
  emitCabiWrappers(mod, exportInfos);

  // Generate C header from the final module state
  const headerExports = extractCHeaderExports(mod);
  const cHeader = generateCHeader(moduleName, headerExports);

  return { cHeader };
}

// ── .d.ts generation ─────────────────────────────────────────────────

function generateDts(ast: TypedAST, mod: WasmModule): string {
  const lines: string[] = ["// Generated by js2wasm", ""];

  // Exports interface
  const exportLines: string[] = [];
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const name = stmt.name.text;
      const isAsync = mod.asyncFunctions.has(name);
      const params = stmt.parameters
        .map((p) => {
          const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
          const typeText = mapTypeForDts(p.type, ast.sourceFile);
          const optional = p.questionToken ? "?" : "";
          return `${paramName}${optional}: ${typeText}`;
        })
        .join(", ");
      let returnType = mapTypeForDts(stmt.type, ast.sourceFile);
      // For async functions, preserve the Promise<T> wrapper in the .d.ts output
      if (isAsync && !returnType.startsWith("Promise<")) {
        returnType = `Promise<${returnType}>`;
      }
      exportLines.push(`  ${name}(${params}): ${returnType};`);
    }
  }

  if (exportLines.length > 0) {
    lines.push(
      ...exportLines.map((l) => {
        // Convert "  name(params): ret;" to "export declare function name(params): ret;"
        const m = l.match(/^\s+(\w+)\(([^)]*)\):\s*(.+);$/);
        if (m) return `export declare function ${m[1]}(${m[2]}): ${m[3]};`;
        return l;
      }),
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ── Imports helper generation ────────────────────────────────────────

function generateImportsHelper(adapterManifest: JavaScriptAdapterManifestV1): string {
  const manifestJson = JSON.stringify(adapterManifest, null, 2);

  return [
    "// Generated by js2wasm — shared runtime imports helper",
    "// Shared host glue comes from the js2wasm runtime so it only needs to ship once.",
    '// Usage: import { createImports, instantiateBytes, instantiateFromUrl } from "./module.imports.js";',
    "",
    'import { buildCompiledAdapterImports, instantiateWasm, instantiateWasmStreaming } from "js2wasm";',
    "",
    `const adapterManifest = ${manifestJson};`,
    "",
    "export function createImports(deps, options) {",
    "  return buildCompiledAdapterImports(adapterManifest, deps, options);",
    "}",
    "",
    "export async function instantiateBytes(wasmBytes, deps, options) {",
    "  const imports = createImports(deps, options);",
    "  const result = await instantiateWasm(wasmBytes, imports.env, imports.string_constants, imports.string_constants16);",
    "  if (imports.setInstance) imports.setInstance(result.instance);",
    "  return { ...result, imports };",
    "}",
    "",
    "export async function instantiateFromResponse(response, deps, options) {",
    "  const imports = createImports(deps, options);",
    "  const result = await instantiateWasmStreaming(response, imports.env, imports.string_constants, imports.string_constants16);",
    "  if (imports.setInstance) imports.setInstance(result.instance);",
    "  return { ...result, imports };",
    "}",
    "",
    "export async function instantiateFromUrl(url, deps, options) {",
    "  return instantiateFromResponse(fetch(url), deps, options);",
    "}",
    "",
  ].join("\n");
}

function mapTypeForDts(typeNode: ts.TypeNode | undefined, sf: ts.SourceFile): string {
  if (!typeNode) return "void";
  const text = typeNode.getText(sf);
  if (text === "number" || text === "boolean" || text === "string" || text === "void") {
    return text;
  }
  // Handle Promise<T> type references
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sf);
    if (typeName === "Promise" && typeNode.typeArguments?.length === 1) {
      const innerType = mapTypeForDts(typeNode.typeArguments[0], sf);
      return `Promise<${innerType}>`;
    }
  }
  return "any";
}

// ── Object file compilation ─────────────────────────────────────────

export interface ObjectCompileResult {
  /** Relocatable Wasm object file (.o) */
  object: Uint8Array;
  /** true if compilation was successful */
  success: boolean;
  /** Error messages with line numbers */
  errors: CompileError[];
}

/**
 * Compile TypeScript source to a relocatable Wasm object file (.o).
 * Uses the same pipeline as compileSource but emits LLVM-style
 * linking metadata instead of a final executable module.
 */
export function compileToObjectSource(source: string, options: CompileOptions = {}): ObjectCompileResult {
  const errors: CompileError[] = [];

  // The relocatable-object path predates the shared target-aware pipeline and
  // still calls generateModule(ast) without the caller's target/codegen
  // options. Accepting `target: "standalone"` here therefore lies: it emits a
  // default GC/JS-host legacy-front-end object, not a standalone artifact.
  // Fail closed until object allocation consumes the same whole-program
  // Prepared IR transaction as executable standalone output.
  if (resolveCompileTargetProfile(options).target === "standalone") {
    return {
      object: new Uint8Array(0),
      success: false,
      errors: [
        {
          message:
            "compileToObject target 'standalone' is unavailable until relocatable object emission consumes the Prepared IR program",
          line: 0,
          column: 0,
          severity: "error",
        },
      ],
    };
  }

  const preprocessed = preprocessImports(source);
  const processedSource = preprocessed.source;
  const defaultFileName = options.fileName ?? (options.allowJs ? "input.js" : "input.ts");
  const effectiveFileName = options.moduleName ?? defaultFileName;
  const ast = analyzeSource(processedSource, effectiveFileName, {
    allowJs: options.allowJs,
    emulateNode: options.emulateNode,
    forceTsGrammar: preprocessed.requiresTsGrammar,
  });

  for (const diag of ast.diagnostics) {
    if (diag.category === 1) {
      const pos = diag.file ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0) : { line: 0, character: 0 };
      const severity = DOWNGRADE_DIAG_CODES.has(diag.code) ? "warning" : "error";
      let message = typeof diag.messageText === "string" ? diag.messageText : diag.messageText.messageText;
      // #2603: TS2580 ("Cannot find name 'X'. Do you need to install type
      // definitions for node?") flags a Node global. When node-emulation is
      // off, point the user at the flag that turns it on (and silences this)
      // rather than at @types/node.
      if (!options.emulateNode && diag.code === 2580) {
        const name = message.match(/Cannot find name '([^']+)'/)?.[1] ?? "process";
        message = `Cannot find name '${name}'. Add \`--emulate node\` to enable Node API emulation (or install @types/node).`;
      }
      errors.push({
        message,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: severity as "error" | "warning",
        code: diag.code,
      });
    }
  }

  const TOLERATED_SYNTAX_CODES = new Set([
    1156, // "'let' declarations can only be declared inside a block"
    1313, // "The body of an 'if' statement cannot be the empty statement"
    1344, // "A label is not allowed here"
    1182, // "A destructuring declaration must have an initializer"
    1228, // "A type predicate is only allowed in return type position"
    1163, // "A 'yield' expression is only allowed in a generator body"
    1206, // "Decorators are not valid here"
    1207, // "Decorators cannot be applied to multiple get/set accessors"
    1435, // "Unknown keyword or identifier. Did you mean 'X'?" — yield in nested generator contexts (#521)
    1436, // "Decorators must precede the name and all keywords of property declarations"
    1486, // "Decorator used before 'export' here"
    1497, // "Expression must be enclosed in parentheses to be used as a decorator"
    1498, // "Invalid syntax in decorator"
    8038, // "Decorators may not appear after 'export' or 'export default'"
    1184, // "Modifiers cannot appear here" (#537)
    1109, // "Expression expected" (#537)
    1135, // "Argument expression expected" (#537)
    1262, // "Identifier expected. 'X' is a reserved word at the top-level of a module" (#537)
    1503, // "This regular expression flag is only available when targeting 'es2024'" (#654)
    1232, // "An import declaration can only be used at the top level of a namespace or module" (#654)
  ]);
  const hasSyntaxErrors = ast.syntacticDiagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile && !TOLERATED_SYNTAX_CODES.has(d.code),
  );

  if (hasSyntaxErrors && errors.length > 0) {
    return { object: new Uint8Array(0), success: false, errors };
  }

  let mod;
  try {
    const result = generateModule(ast);
    mod = result.module;
    // #1921 — surface each diagnostic with its real severity (a deliberate
    // "degrade" becomes a non-fatal "warning"); gate on severity, not on a
    // "Codegen error:" message prefix.
    for (const err of result.errors) {
      errors.push({
        message: err.message,
        line: err.line,
        column: err.column,
        severity: isFatalCodegenDiagnostic(err) ? "error" : "warning",
        ...(err.file ? { file: err.file } : {}),
      });
    }
    if (result.errors.some(isFatalCodegenDiagnostic)) {
      return { object: new Uint8Array(0), success: false, errors };
    }
  } catch (e) {
    pushSourceAnchoredDiagnostic(
      errors,
      ast.sourceFile,
      `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return { object: new Uint8Array(0), success: false, errors };
  }

  let object: Uint8Array;
  try {
    object = emitObject(mod);
  } catch (e) {
    pushSourceAnchoredDiagnostic(
      errors,
      ast.sourceFile,
      `Object emit error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return { object: new Uint8Array(0), success: false, errors };
  }

  return { object, success: true, errors };
}

/**
 * Post-processing pass: widen all non-defaultable `ref` types to `ref_null`
 * throughout the module. This fixes two classes of Wasm validation errors:
 *
 * 1. "uninitialized non-defaultable local" -- locals with `ref $T` type have
 *    no implicit default value, so any code path that reads them before writing
 *    causes a validation error. Widening to `ref null $T` gives them a null default.
 *
 * 2. "struct.get/set expected type (ref null N), found ..." -- when function
 *    signatures use `ref` but callers/callees produce `ref_null` (or vice versa),
 *    the Wasm validator rejects the type mismatch. Consistently using `ref_null`
 *    in function types, locals, and globals avoids this.
 */
function widenNonDefaultableTypes(mod: WasmModule): void {
  function widenValType(t: ValType): ValType {
    return t.kind === "ref" ? { kind: "ref_null", typeIdx: t.typeIdx } : t;
  }

  // Widen all type definitions (func types, struct fields, array elements)
  function widenTypeDef(typeDef: (typeof mod.types)[number]): void {
    switch (typeDef.kind) {
      case "func":
        for (let i = 0; i < typeDef.params.length; i++) {
          typeDef.params[i] = widenValType(typeDef.params[i]!);
        }
        for (let i = 0; i < typeDef.results.length; i++) {
          typeDef.results[i] = widenValType(typeDef.results[i]!);
        }
        break;
      case "struct":
        for (const field of typeDef.fields) {
          field.type = widenValType(field.type);
        }
        break;
      case "array":
        typeDef.element = widenValType(typeDef.element);
        break;
      case "rec":
        for (const inner of typeDef.types) {
          widenTypeDef(inner);
        }
        break;
      case "sub":
        widenTypeDef(typeDef.type);
        break;
    }
  }

  for (const typeDef of mod.types) {
    widenTypeDef(typeDef);
  }

  // Widen function locals and block types in bodies
  for (const func of mod.functions) {
    for (const local of func.locals) {
      local.type = widenValType(local.type);
    }
    // Widen block types (if/block/loop/try) in instruction bodies
    widenBlockTypesInBody(func.body, widenValType);
  }

  // Widen global types
  for (const global of mod.globals) {
    global.type = widenValType(global.type);
  }

  // Widen import desc type for non-func imports (globals)
  for (const imp of mod.imports) {
    if (imp.desc.kind === "global") {
      imp.desc.type = widenValType(imp.desc.type);
    }
  }
}

/**
 * Recursively walk an instruction body and widen block types (if/block/loop/try)
 * from `ref` to `ref_null`, matching the widened function type signatures.
 */
function widenBlockTypesInBody(body: Instr[], widenValType: (t: ValType) => ValType): void {
  for (const instr of body) {
    const a = instr as any;
    // Widen block type if it's a val type with ref kind
    if (a.blockType && a.blockType.kind === "val") {
      a.blockType.type = widenValType(a.blockType.type);
    }
    // Recurse into nested instruction arrays
    if (a.then) widenBlockTypesInBody(a.then, widenValType);
    if (a.else) widenBlockTypesInBody(a.else, widenValType);
    if (a.body && Array.isArray(a.body)) widenBlockTypesInBody(a.body, widenValType);
    if (a.catches) {
      for (const c of a.catches) {
        if (c.body) widenBlockTypesInBody(c.body, widenValType);
      }
    }
    if (a.catchAll) widenBlockTypesInBody(a.catchAll, widenValType);
  }
}

export { applyCabiTransform, generateDts, generateImportsHelper, widenBlockTypesInBody, widenNonDefaultableTypes };
