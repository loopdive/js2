// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import ts from "typescript";
// Exact independent textual oracle from e4737c9f1dcb632c56f3cc3a31e3ad47cd7f848e.
// Entire historical module SHA256: 693befe89f7d5533c7ce41c7df465973fc48a2f6873201bac3229a0634f65210.
// The literal is fixed test evidence, never fetched from Git or the changed comparator.
export const ORIGINAL_TEXTUAL_ALGORITHM = [
  "function dataText(data: PhysicalData): string {",
  "  const active = new Set<object>();",
  "  const numberBits = new DataView(new ArrayBuffer(8));",
  "  const encode = (value: object | string | number | bigint | boolean | undefined | null): string => {",
  '    if (value === null) return "null";',
  '    if (value === undefined) return "undefined";',
  "    switch (typeof value) {",
  '      case "string":',
  "        return `string:${JSON.stringify(value)}`;",
  '      case "boolean":',
  "        return `boolean:${value}`;",
  '      case "bigint":',
  "        return `bigint:${value}`;",
  '      case "number":',
  "        // Same Float64 store as WasmEncoder.f64: even distinct NaN payloads",
  "        // can change emitted bytes. Do not normalize or stringify the value.",
  "        numberBits.setFloat64(0, value, true);",
  '        return `number:${numberBits.getUint32(4, true).toString(16).padStart(8, "0")}${numberBits.getUint32(0, true).toString(16).padStart(8, "0")}`;',
  '      case "object": {',
  '        if (active.has(value)) throw new Error("cyclic physical descriptor");',
  "        active.add(value);",
  '        const tag = Array.isArray(value) ? `array:${value.length}` : value instanceof Uint8Array ? "bytes" : "object";',
  "        const fields = Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry)}`);",
  "        active.delete(value);",
  '        return `${tag}{${fields.join(",")}}`;',
  "      }",
  "      default:",
  '        throw new Error("unsupported physical descriptor value");',
  "    }",
  "  };",
  "  return encode(data);",
  "}",
].join("\n");
export const ORIGINAL_TEXTUAL_SHA256 = "8779b9b6ff208763e3a251c41c7bc808a4a66aa45592ce0b6b24bc095a4e87c1";
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");

if (hash(ORIGINAL_TEXTUAL_ALGORITHM) !== ORIGINAL_TEXTUAL_SHA256) throw Error("changed pinned textual snapshot oracle");
const javascript = ts.transpileModule(ORIGINAL_TEXTUAL_ALGORITHM, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
export const originalText = new Function(javascript + ";return dataText;")() as (value: unknown) => string;
