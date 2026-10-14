// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "./typescript.js";
import { IrUnsupportedError } from "../shared/contracts/ir-preparation-errors.js";

/** A provenance failure is a refusal to use a checker, never an empty source census. */
export function invalidProgramOrigin(detail: string): never {
  throw new IrUnsupportedError(
    "type-resolution-unsupported",
    "build",
    `TypeScript Program origin is not current: ${detail}`,
  );
}

/** Compiler options and resolution records are DATA. Accessors cannot issue evidence. */
export function originData(value: unknown, seen = new Set<object>()): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
    if (["string", "boolean"].includes(typeof value) || value === null) return JSON.stringify(value);
    return invalidProgramOrigin("non-DATA compiler input");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) return invalidProgramOrigin("symbol compiler input");
  if (seen.has(value)) return invalidProgramOrigin("cyclic compiler input");
  seen.add(value);
  const rows = Object.keys(value)
    .sort()
    .map((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !("value" in field)) return invalidProgramOrigin("accessor compiler input");
      return `${JSON.stringify(key)}:${originData(field.value, seen)}`;
    });
  seen.delete(value);
  return `${Array.isArray(value) ? `array:${value.length}` : "object"}{${rows.join(",")}}`;
}

// TypeScript writes this private cache flag on expression nodes after type queries.
// Read the installed producer's named bit; no parser/semantic flag is discarded.
const typeCachedFlag: unknown = Reflect.get(ts.NodeFlags, "TypeCached");
if (typeof typeCachedFlag !== "number") invalidProgramOrigin("unknown TypeScript checker cache flag");
const TYPE_CACHED_FLAG = typeCachedFlag as number;

const SYNTAX_FIELDS = [
  "kind",
  "pos",
  "end",
  "flags",
  "text",
  "escapedText",
  "operator",
  "isTypeOnly",
  "multiLine",
  "hasExtendedUnicodeEscape",
  "isUnterminated",
  "numericLiteralFlags",
  "tokenFlags",
  "originalKeywordKind",
  "languageVersion",
  "languageVariant",
  "scriptKind",
  "isDeclarationFile",
  "impliedNodeFormat",
  "fileName",
  "version",
  "hasNoDefaultLib",
  "referencedFiles",
  "typeReferenceDirectives",
  "libReferenceDirectives",
] as const;

function syntaxData(node: ts.Node): string {
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(node)))
    if (!("value" in descriptor)) invalidProgramOrigin("accessor syntax node");
  return SYNTAX_FIELDS.flatMap((key) => {
    const field = Object.getOwnPropertyDescriptor(node, key);
    if (field && !("value" in field)) return invalidProgramOrigin(`accessor syntax field ${key}`);
    const value: unknown = field?.value;
    const semantic =
      key === "flags" && ts.isExpression(node) && typeof value === "number" ? value & ~TYPE_CACHED_FLAG : value;
    return field ? [`${key}:${originData(semantic)}`] : [];
  }).join(";");
}

const sourceChecks = new WeakMap<ts.SourceFile, () => void>();

/** Capture real syntax identities and token payloads, without compiler bind/check caches. */
export function sourceCurrentness(source: ts.SourceFile): () => void {
  const existing = sourceChecks.get(source);
  if (existing) {
    existing();
    return existing;
  }
  const rows: { node: ts.Node; data: string; children: readonly ts.Node[] }[] = [];
  const visit = (node: ts.Node): void => {
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    rows.push({ node, data: syntaxData(node), children });
    for (const child of children) visit(child);
  };
  visit(source);
  const check = () => {
    for (const row of rows) {
      if (syntaxData(row.node) !== row.data) invalidProgramOrigin(`syntax changed in ${source.fileName}`);
      const children: ts.Node[] = [];
      ts.forEachChild(row.node, (child) => {
        children.push(child);
      });
      if (children.length !== row.children.length || children.some((child, index) => child !== row.children[index]))
        invalidProgramOrigin(`syntax identity changed in ${source.fileName}`);
    }
  };
  sourceChecks.set(source, check);
  return check;
}

export function optionsData(options: ts.CompilerOptions): string {
  // TS attaches a parsed config SourceFile separately from the DATA option table.
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(options))) {
    if (!("value" in field)) invalidProgramOrigin("accessor compiler option");
    if (key !== "configFile") fields[key] = field.value;
  }
  return originData(fields);
}

/** Prevent mutation of an authenticated checker or substitution of Program query methods. */
export function methodCurrentness(value: object): () => void {
  const methods = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
    ([, descriptor]) => "value" in descriptor && typeof descriptor.value === "function",
  );
  return () => {
    for (const [key, descriptor] of methods) {
      const current = Object.getOwnPropertyDescriptor(value, key);
      if (!current || !("value" in current) || current.value !== descriptor.value)
        invalidProgramOrigin(`issued method ${key} changed`);
    }
  };
}
