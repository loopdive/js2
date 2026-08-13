// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * WIT (WebAssembly Interface Types) generator.
 *
 * Generates a .wit file from TypeScript exported functions and interfaces.
 * This is the first step toward Component Model support.
 *
 * TypeScript -> WIT type mapping:
 *   number    -> f64
 *   string    -> string
 *   boolean   -> bool
 *   void      -> (no return type)
 *   null/undefined -> (omitted)
 *   number[]  -> list<f64>
 *   string[]  -> list<string>
 *   boolean[] -> list<bool>
 *   interface { x: number } -> record name { x: f64 }
 *   T | null  -> option<T>
 */

import { ts } from "./ts-api.js";
import type { PlatformCapabilityRequirement } from "./capability-registry.js";
import type { TypedAST } from "./checker/index.js";
import type { Import, TypeDef, ValType } from "./ir/types.js";

/** Options for {@link generateWit} — controls the generated WIT world's naming. */
export interface WitGeneratorOptions {
  /** Package name for the WIT world (default: derived from the source filename) */
  packageName?: string;
  /** World name (default: "module") */
  worldName?: string;
  /** Compiled module imports to include in the world import surface. */
  imports?: readonly Import[];
  /** Compiled module type table used to render import function signatures. */
  types?: readonly TypeDef[];
  /** Versioned capability contracts used to project provider imports. */
  capabilities?: readonly PlatformCapabilityRequirement[];
}

interface WitRecord {
  name: string;
  fields: { name: string; type: string }[];
}

interface WitFunc {
  name: string;
  params: { name: string; type: string }[];
  result: string | null;
}

interface WitImportFunc extends WitFunc {
  sourceModule: string;
  sourceName: string;
  capability?: PlatformCapabilityRequirement;
}

/**
 * Generate a WIT interface definition from a TypedAST.
 * Extracts all exported functions and referenced interfaces/type aliases,
 * then maps them to WIT types.
 */
export function generateWit(ast: TypedAST, options?: WitGeneratorOptions): string {
  const packageName = options?.packageName ?? defaultPackageNameForSource(ast.sourceFile.fileName);
  const worldName = options?.worldName ?? "module";

  const records: WitRecord[] = [];
  const recordNames = new Set<string>();
  const funcs: WitFunc[] = [];
  const importResources = new Set<string>();
  const usedImportNames = new Set<string>();
  const capabilityRequirements = options?.capabilities ?? [];
  const capabilityImportKeys = new Set(
    capabilityRequirements.flatMap((requirement) =>
      requirement.imports.map((entry) => `${entry.module}\0${entry.name}`),
    ),
  );
  const importFuncs = [
    ...capabilitiesToWit(capabilityRequirements, importResources, usedImportNames),
    ...importsToWit(
      options?.imports ?? [],
      options?.types ?? [],
      importResources,
      usedImportNames,
      capabilityImportKeys,
    ),
  ];

  const sf = ast.sourceFile;
  const checker = ast.checker;

  // First pass: collect all exported interfaces as records
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && hasExportModifier(stmt)) {
      const rec = interfaceToRecord(stmt, sf, checker, records, recordNames);
      if (rec && !recordNames.has(rec.name)) {
        records.push(rec);
        recordNames.add(rec.name);
      }
    }

    // Also handle exported type aliases that resolve to object types
    if (ts.isTypeAliasDeclaration(stmt) && hasExportModifier(stmt)) {
      const rec = typeAliasToRecord(stmt, sf, checker, records, recordNames);
      if (rec && !recordNames.has(rec.name)) {
        records.push(rec);
        recordNames.add(rec.name);
      }
    }
  }

  // Second pass: collect exported functions
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const witFunc = functionToWit(stmt, sf, checker, records, recordNames);
      if (witFunc) {
        funcs.push(witFunc);
      }
    }
  }

  // Build the WIT output
  const lines: string[] = [];
  lines.push(`package ${packageName};`);
  lines.push("");
  lines.push(`world ${worldName} {`);

  for (const resource of importResources) {
    lines.push(`  resource ${resource};`);
  }
  if (importResources.size > 0 && (records.length > 0 || importFuncs.length > 0 || funcs.length > 0)) {
    lines.push("");
  }

  // Emit records
  for (const rec of records) {
    lines.push(`  record ${rec.name} {`);
    for (const field of rec.fields) {
      lines.push(`    ${field.name}: ${field.type},`);
    }
    lines.push("  }");
    lines.push("");
  }

  // Emit compiled module imports
  for (const func of importFuncs) {
    const params = func.params.map((p) => `${p.name}: ${p.type}`).join(", ");
    const returnPart = func.result ? ` -> ${func.result}` : "";
    if (func.capability) {
      lines.push(
        `  /// Capability: ${func.capability.abiNamespace}@${func.capability.abiVersion}`,
        `  /// Permissions: ${func.capability.permissions.join(", ") || "none"}`,
        `  /// Selected provider: ${func.capability.selectedProviders.join(", ")}`,
      );
      lines.push(`  /// Core provider import: ${func.sourceModule}.${func.sourceName}`);
    } else {
      lines.push(`  /// Core import: ${func.sourceModule}.${func.sourceName}`);
    }
    lines.push(`  import ${func.name}: func(${params})${returnPart};`);
  }
  if (importFuncs.length > 0 && funcs.length > 0) {
    lines.push("");
  }

  // Emit exported functions
  for (const func of funcs) {
    const params = func.params.map((p) => `${p.name}: ${p.type}`).join(", ");
    const returnPart = func.result ? ` -> ${func.result}` : "";
    lines.push(`  export ${func.name}: func(${params})${returnPart};`);
  }

  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

// ── Type mapping ─────────────────────────────────────────────────────

/**
 * Map a TypeScript type node to a WIT type string.
 * Returns null if the type cannot be mapped.
 */
function mapTypeToWit(
  typeNode: ts.TypeNode | undefined,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): string | null {
  if (!typeNode) return null;

  // Keyword types
  if (ts.isToken(typeNode)) {
    switch (typeNode.kind) {
      case ts.SyntaxKind.NumberKeyword:
        return "f64";
      case ts.SyntaxKind.StringKeyword:
        return "string";
      case ts.SyntaxKind.BooleanKeyword:
        return "bool";
      case ts.SyntaxKind.VoidKeyword:
        return null;
      case ts.SyntaxKind.UndefinedKeyword:
        return null;
      case ts.SyntaxKind.NullKeyword:
        return null;
      case ts.SyntaxKind.AnyKeyword:
        // 'any' has no WIT equivalent; best-effort map to string
        return "string";
    }
  }

  // Array types: number[] -> list<f64>
  if (ts.isArrayTypeNode(typeNode)) {
    const elemType = mapTypeToWit(typeNode.elementType, sf, checker, records, recordNames);
    if (elemType) return `list<${elemType}>`;
    return null;
  }

  // Array<T> generic
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sf);

    if (typeName === "Array" && typeNode.typeArguments?.length === 1) {
      const elemType = mapTypeToWit(typeNode.typeArguments[0], sf, checker, records, recordNames);
      if (elemType) return `list<${elemType}>`;
      return null;
    }

    // Named type reference -> check if it's a known record
    const witName = toWitIdentifier(typeName);
    if (recordNames.has(witName)) {
      return witName;
    }

    // Try to resolve the type and create a record if it's an object type
    const type = checker.getTypeAtLocation(typeNode);
    const rec = resolveObjectTypeToRecord(witName, type, checker, records, recordNames);
    if (rec) {
      return witName;
    }

    return null;
  }

  // Union types: T | null -> option<T>, T | undefined -> option<T>
  if (ts.isUnionTypeNode(typeNode)) {
    const nonNullTypes = typeNode.types.filter((t) => {
      if (ts.isToken(t)) {
        return t.kind !== ts.SyntaxKind.NullKeyword && t.kind !== ts.SyntaxKind.UndefinedKeyword;
      }
      if (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) {
        return false;
      }
      return true;
    });

    const hasNull = nonNullTypes.length < typeNode.types.length;

    if (nonNullTypes.length === 1) {
      const inner = mapTypeToWit(nonNullTypes[0], sf, checker, records, recordNames);
      if (inner && hasNull) return `option<${inner}>`;
      return inner;
    }

    // Multiple non-null types: cannot map cleanly
    return null;
  }

  // Type literal: { x: number; y: number } -> inline record
  if (ts.isTypeLiteralNode(typeNode)) {
    const fields: { name: string; type: string }[] = [];
    for (const member of typeNode.members) {
      if (ts.isPropertySignature(member) && member.name && member.type) {
        const fieldName = toWitIdentifier(member.name.getText(sf));
        const fieldType = mapTypeToWit(member.type, sf, checker, records, recordNames);
        if (fieldType) {
          fields.push({ name: fieldName, type: fieldType });
        }
      }
    }
    if (fields.length > 0) {
      // Create an anonymous record with a generated name
      const anonName = `anon-record-${records.length}`;
      if (!recordNames.has(anonName)) {
        records.push({ name: anonName, fields });
        recordNames.add(anonName);
      }
      return anonName;
    }
    return null;
  }

  // Parenthesized type: (T) -> T
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return mapTypeToWit(typeNode.type, sf, checker, records, recordNames);
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function interfaceToRecord(
  node: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): WitRecord | null {
  const name = toWitIdentifier(node.name.text);
  const fields: { name: string; type: string }[] = [];

  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name && member.type) {
      const fieldName = toWitIdentifier(member.name.getText(sf));
      const fieldType = mapTypeToWit(member.type, sf, checker, records, recordNames);
      if (fieldType) {
        fields.push({ name: fieldName, type: fieldType });
      }
    }
  }

  if (fields.length === 0) return null;
  return { name, fields };
}

function typeAliasToRecord(
  node: ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): WitRecord | null {
  const name = toWitIdentifier(node.name.text);

  if (ts.isTypeLiteralNode(node.type)) {
    const fields: { name: string; type: string }[] = [];
    for (const member of node.type.members) {
      if (ts.isPropertySignature(member) && member.name && member.type) {
        const fieldName = toWitIdentifier(member.name.getText(sf));
        const fieldType = mapTypeToWit(member.type, sf, checker, records, recordNames);
        if (fieldType) {
          fields.push({ name: fieldName, type: fieldType });
        }
      }
    }
    if (fields.length > 0) return { name, fields };
  }

  return null;
}

function resolveObjectTypeToRecord(
  witName: string,
  type: ts.Type,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): WitRecord | null {
  if (recordNames.has(witName)) return null; // already exists

  const props = type.getProperties();
  if (props.length === 0) return null;

  // Temporarily add the name to prevent infinite recursion
  recordNames.add(witName);

  const fields: { name: string; type: string }[] = [];
  for (const prop of props) {
    const decl = prop.valueDeclaration;
    if (!decl) continue;

    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    const witType = mapTsTypeToWit(propType, checker, records, recordNames);
    if (witType) {
      fields.push({ name: toWitIdentifier(prop.name), type: witType });
    }
  }

  if (fields.length === 0) {
    recordNames.delete(witName);
    return null;
  }

  const rec = { name: witName, fields };
  records.push(rec);
  return rec;
}

/**
 * Map a ts.Type (resolved type) to a WIT type string.
 * Used when we have a resolved type from the checker rather than a type node.
 */
function mapTsTypeToWit(
  type: ts.Type,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): string | null {
  if (type.flags & ts.TypeFlags.Number) return "f64";
  if (type.flags & ts.TypeFlags.String) return "string";
  if (type.flags & ts.TypeFlags.Boolean || type.flags & ts.TypeFlags.BooleanLiteral) return "bool";
  if (type.flags & ts.TypeFlags.Void) return null;
  if (type.flags & ts.TypeFlags.Undefined) return null;
  if (type.flags & ts.TypeFlags.Null) return null;

  // Check for array type
  const numberIndex = type.getNumberIndexType();
  if (numberIndex && checker.isArrayType(type)) {
    const elemType = mapTsTypeToWit(numberIndex, checker, records, recordNames);
    if (elemType) return `list<${elemType}>`;
  }

  return null;
}

function functionToWit(
  node: ts.FunctionDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): WitFunc | null {
  if (!node.name) return null;

  const name = toWitIdentifier(node.name.text);
  const params: { name: string; type: string }[] = [];

  for (const param of node.parameters) {
    const paramName = ts.isIdentifier(param.name) ? toWitIdentifier(param.name.text) : `p${params.length}`;
    const paramType = mapTypeToWit(param.type, sf, checker, records, recordNames);
    if (paramType) {
      params.push({ name: paramName, type: paramType });
    }
  }

  const result = mapTypeToWit(node.type, sf, checker, records, recordNames);

  return { name, params, result };
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Convert a camelCase or PascalCase identifier to kebab-case for WIT.
 * WIT uses kebab-case for all identifiers.
 */
function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

const WIT_KEYWORDS = new Set([
  "as",
  "bool",
  "borrow",
  "char",
  "constructor",
  "enum",
  "export",
  "flags",
  "f32",
  "f64",
  "from",
  "func",
  "future",
  "import",
  "include",
  "interface",
  "list",
  "option",
  "own",
  "package",
  "record",
  "resource",
  "result",
  "s8",
  "s16",
  "s32",
  "s64",
  "static",
  "stream",
  "string",
  "tuple",
  "type",
  "u8",
  "u16",
  "u32",
  "u64",
  "use",
  "variant",
  "with",
  "world",
]);

const KNOWN_IMPORT_PARAM_NAMES = new Map<string, string[]>([
  ["wasi_snapshot_preview1.fd_write", ["fd", "iovs", "iovs-len", "nwritten"]],
  ["wasi_snapshot_preview1.fd_read", ["fd", "iovs", "iovs-len", "nread"]],
  ["wasi_snapshot_preview1.proc_exit", ["code"]],
  ["wasi_snapshot_preview1.random_get", ["buf", "buf-len"]],
  ["wasi_snapshot_preview1.poll_oneoff", ["in", "out", "nsubscriptions", "nevents"]],
  ["wasi_snapshot_preview1.environ_sizes_get", ["count", "buf-size"]],
  ["wasi_snapshot_preview1.environ_get", ["environ", "environ-buf"]],
  ["wasi_snapshot_preview1.clock_time_get", ["clock-id", "precision", "time"]],
  [
    "wasi_snapshot_preview1.path_open",
    ["fd", "dirflags", "path", "path-len", "oflags", "rights-base", "rights-inheriting", "fdflags", "fd-out"],
  ],
  ["wasi_snapshot_preview1.fd_close", ["fd"]],
  ["env.__wasi_env_get_str", ["key"]],
]);

function importsToWit(
  imports: readonly Import[],
  types: readonly TypeDef[],
  resources: Set<string>,
  usedNames: Set<string>,
  skipImports: ReadonlySet<string>,
): WitImportFunc[] {
  const funcs: WitImportFunc[] = [];

  for (const imp of imports) {
    if (imp.desc.kind !== "func") continue;
    if (skipImports.has(`${imp.module}\0${imp.name}`)) continue;
    const typeDef = types[imp.desc.typeIdx];
    if (!typeDef || typeDef.kind !== "func") continue;

    const sourceKey = `${imp.module}.${imp.name}`;
    const knownParamNames = KNOWN_IMPORT_PARAM_NAMES.get(sourceKey) ?? [];
    const params = typeDef.params.map((paramType, i) => ({
      name: toWitIdentifier(knownParamNames[i] ?? `p${i}`),
      type: mapWasmValTypeToWit(paramType, resources),
    }));
    const results = typeDef.results.map((resultType) => mapWasmValTypeToWit(resultType, resources));
    const result = results.length === 0 ? null : results.length === 1 ? results[0]! : `tuple<${results.join(", ")}>`;

    funcs.push({
      name: uniqueWitImportName(toWitIdentifier(imp.name), imp.module, usedNames),
      params,
      result,
      sourceModule: imp.module,
      sourceName: imp.name,
    });
  }

  return funcs;
}

function capabilitiesToWit(
  requirements: readonly PlatformCapabilityRequirement[],
  resources: Set<string>,
  usedNames: Set<string>,
): WitImportFunc[] {
  const funcs: WitImportFunc[] = [];
  for (const requirement of [...requirements].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const entry of requirement.imports) {
      if (entry.kind !== "func" || !entry.params || !entry.results) continue;
      const sourceKey = `${entry.module}.${entry.name}`;
      const knownParamNames = KNOWN_IMPORT_PARAM_NAMES.get(sourceKey) ?? [];
      const params = entry.params.map((type, index) => ({
        name: toWitIdentifier(knownParamNames[index] ?? `p${index}`),
        type: mapCapabilityAbiTypeToWit(type, resources),
      }));
      const results = entry.results.map((type) => mapCapabilityAbiTypeToWit(type, resources));
      funcs.push({
        name: uniqueWitImportName(toWitIdentifier(entry.name), entry.module, usedNames),
        params,
        result: results.length === 0 ? null : results.length === 1 ? results[0]! : `tuple<${results.join(", ")}>`,
        sourceModule: entry.module,
        sourceName: entry.name,
        capability: requirement,
      });
    }
  }
  return funcs;
}

function mapCapabilityAbiTypeToWit(type: string, resources: Set<string>): string {
  switch (type) {
    case "i8":
      return "s8";
    case "i16":
      return "s16";
    case "i32":
      return "s32";
    case "i64":
      return "s64";
    case "f32":
    case "f64":
      return type;
    case "v128":
      return "list<u8>";
    default:
      resources.add("host-ref");
      return "host-ref";
  }
}

function mapWasmValTypeToWit(type: ValType, resources: Set<string>): string {
  switch (type.kind) {
    case "i8":
      return "s8";
    case "i16":
      return "s16";
    case "i32":
      return "s32";
    case "i64":
      return "s64";
    case "f32":
      return "f32";
    case "f64":
      return "f64";
    case "v128":
      return "list<u8>";
    case "funcref":
      resources.add("host-func");
      return "host-func";
    case "externref":
    case "ref_extern":
    case "eqref":
    case "anyref":
    case "ref":
    case "ref_null":
      resources.add("host-ref");
      return "host-ref";
  }
}

function uniqueWitImportName(baseName: string, moduleName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  const modulePrefixed = `${toWitIdentifier(moduleName)}-${baseName}`;
  if (!usedNames.has(modulePrefixed)) {
    usedNames.add(modulePrefixed);
    return modulePrefixed;
  }

  let suffix = 2;
  while (usedNames.has(`${modulePrefixed}-${suffix}`)) suffix++;
  const unique = `${modulePrefixed}-${suffix}`;
  usedNames.add(unique);
  return unique;
}

function defaultPackageNameForSource(fileName: string): string {
  return `js2wasm:${toPackageIdentifier(baseNameWithoutExtension(fileName))}`;
}

function baseNameWithoutExtension(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1) || "module";
  return base.replace(/\.[^.]+$/, "") || "module";
}

function toPackageIdentifier(name: string): string {
  const ident = toKebabCase(name)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
  if (!ident) return "module";
  return /^[0-9]/.test(ident) ? `x-${ident}` : ident;
}

function toWitIdentifier(name: string): string {
  const ident = toPackageIdentifier(name);
  return WIT_KEYWORDS.has(ident) ? `%${ident}` : ident;
}
