// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as schema from "../src/runtime/contracts/host-capability-schema.js";
import * as catalog from "../src/ir/runtime-host-capabilities.js";
import { ASYNC_HOST_CAPABILITY_RECORDS, asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";

const root = resolve(import.meta.dirname, "..");
const schemaPath = "src/runtime/contracts/host-capability-schema.ts";
const typeNames = [
  "RuntimeHostCapabilityFuncId",
  "RuntimeHostCapabilityFuncFamilyId",
  "RuntimeHostCapabilityGlobalId",
  "RuntimeHostCapabilityExportId",
  "RuntimeHostCapabilityId",
  "RuntimeHostCapabilityValueType",
  "RuntimeHostCapabilityFuncModule",
  "RuntimeHostCapabilityGlobalModule",
  "RuntimeHostCapabilityKind",
  "RuntimeHostCapabilityFieldScheme",
  "RuntimeHostCapabilityGlobalField",
  "RuntimeHostCapabilityFuncFamilyFieldScheme",
  "RuntimeHostCapabilityExportPublication",
  "RuntimeHostCapabilityHostSelectionEnvVar",
  "RuntimeHostCapabilityHostSelectionCondition",
  "RuntimeHostCapabilityHostSelection",
  "RuntimeHostCapabilityFuncFamilyField",
  "RuntimeHostCapabilityFuncFamilyParams",
  "RuntimeHostCapabilityFuncRecord",
  "RuntimeHostCapabilityGlobalRecord",
  "RuntimeHostCapabilityFuncFamilyRecord",
  "RuntimeHostCapabilityExportRecord",
  "RuntimeHostCapabilityRecord",
  "HostCallbackExceptionPolicy",
  "ResolvedRuntimeHostCapabilityFuncFamilyRow",
] as const;
const constantNames = [
  "RUNTIME_HOST_CAPABILITY_FUNC_IDS",
  "RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS",
  "RUNTIME_HOST_CAPABILITY_GLOBAL_IDS",
  "RUNTIME_HOST_CAPABILITY_EXPORT_IDS",
  "RUNTIME_HOST_CAPABILITY_IDS",
  "RUNTIME_HOST_CAPABILITY_FUNC_MODULES",
  "RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES",
  "RUNTIME_HOST_CAPABILITY_KINDS",
  "RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES",
  "RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEMES",
  "RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATIONS",
  "RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VARS",
  "RUNTIME_HOST_CAPABILITY_HOST_SELECTIONS",
  "HOST_CALLBACK_EXCEPTION_POLICY",
] as const;

function typeDiagnostics(source: string) {
  const fileName = resolve(root, ".tmp/capability-schema-contract.ts");
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2022.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === fileName
      ? ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
      : original(path, languageVersion, onError, shouldCreateNewSourceFile);
  return ts.getPreEmitDiagnostics(ts.createProgram([fileName], options, host));
}

describe("capability schema relocation", () => {
  it.each(constantNames)("retains the exact old-path %s binding", (name) => {
    expect(catalog[name]).toBe(schema[name]);
    if (Array.isArray(schema[name])) expect(Object.isFrozen(schema[name])).toBe(true);
  });

  it("loads the import-free schema alone in a fresh process", () => {
    const script = [
      "import assert from 'node:assert/strict';",
      "import { registerHooks } from 'node:module';",
      "import { realpathSync } from 'node:fs';",
      "import { relative } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const root = realpathSync(process.cwd()), visited = new Set();",
      "registerHooks({ resolve(specifier, context, next) {",
      "  const result = next(specifier, context);",
      "  if (!result.url.startsWith('file:')) throw Error('forbidden dependency: ' + result.url);",
      "  const path = relative(root, realpathSync(fileURLToPath(result.url)));",
      "  if (path !== 'src/runtime/contracts/host-capability-schema.ts') throw Error('forbidden dependency: ' + path);",
      "  visited.add(path); return result;",
      "}});",
      "const schema = await import('./src/runtime/contracts/host-capability-schema.ts');",
      "assert.equal(schema.RUNTIME_HOST_CAPABILITY_IDS.length, 32);",
      "assert.equal(Object.isFrozen(schema.RUNTIME_HOST_CAPABILITY_IDS), true);",
      "await assert.rejects(import('./src/ir/runtime-host-capabilities.ts'), /forbidden dependency:/);",
      "console.log(JSON.stringify([...visited]));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr + child.stdout).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([schemaPath]);
  });

  it("preserves all 32 IDs, their ordering, and the mutually exclusive runtime kind guards", () => {
    const parts = [
      [schema.RUNTIME_HOST_CAPABILITY_FUNC_IDS, catalog.isRuntimeHostCapabilityFuncId],
      [schema.RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS, catalog.isRuntimeHostCapabilityFuncFamilyId],
      [schema.RUNTIME_HOST_CAPABILITY_GLOBAL_IDS, catalog.isRuntimeHostCapabilityGlobalId],
      [schema.RUNTIME_HOST_CAPABILITY_EXPORT_IDS, catalog.isRuntimeHostCapabilityExportId],
    ] as const;
    expect(parts.map(([ids]) => ids.length)).toEqual([21, 3, 2, 6]);
    const all = parts.flatMap(([ids]) => [...ids]);
    expect(new Set(all).size).toBe(32);
    expect(schema.RUNTIME_HOST_CAPABILITY_IDS).toEqual([...all].sort());
    for (const id of schema.RUNTIME_HOST_CAPABILITY_IDS) {
      expect(catalog.isRuntimeHostCapabilityId(id)).toBe(true);
      expect(parts.filter(([ids]) => (ids as readonly string[]).includes(id))).toHaveLength(1);
      for (const [ids, guard] of parts) expect(guard(id)).toBe((ids as readonly string[]).includes(id));
    }
    expect(catalog.isRuntimeHostCapabilityId("unregistered.capability")).toBe(false);
    for (const [, guard] of parts) expect(guard("unregistered.capability")).toBe(false);
  });

  it("keeps the full catalog canonical and rejects structurally exact reconstructed records", () => {
    const original = catalog.RUNTIME_HOST_CAPABILITY_RECORDS;
    expect(original).toHaveLength(32);
    expect(original.map((row) => row.capability)).toEqual(schema.RUNTIME_HOST_CAPABILITY_IDS);
    expect(Object.isFrozen(original)).toBe(true);
    const reordered = catalog.canonicalizeRuntimeHostCapabilityCatalog([...original].reverse());
    expect(Object.isFrozen(reordered)).toBe(true);
    for (const [index, row] of original.entries()) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(reordered[index]).toBe(row);
      expect(catalog.resolveRuntimeHostCapabilityRecord(original, row.capability)).toBe(row);
      expect(() => catalog.assertCanonicalRuntimeHostCapabilityRecord(row)).not.toThrow();
      const rebuilt = { ...row };
      expect(() => catalog.assertRuntimeHostCapabilityRecord(rebuilt)).not.toThrow();
      expect(() => catalog.assertCanonicalRuntimeHostCapabilityRecord(rebuilt)).toThrow(
        "not the canonical catalog record",
      );
      expect(() => catalog.resolveRuntimeHostCapabilityRecord([rebuilt], row.capability)).toThrow(
        "not the canonical catalog record",
      );
    }
    expect(() => catalog.canonicalizeRuntimeHostCapabilityCatalog(original.slice(1))).toThrow("incomplete");
    expect(() => catalog.canonicalizeRuntimeHostCapabilityCatalog([...original, original[0]])).toThrow("duplicates");
    expect(catalog.HOST_CALLBACK_WRAP_CAPABILITY_RECORD).toBe(
      catalog.resolveRuntimeHostCapabilityFuncRecord(original, "async.callback.wrap"),
    );
    expect(catalog.HOST_CALLBACK_WRAP_CAPABILITY_RECORD.exceptionPolicy).toBe(schema.HOST_CALLBACK_EXCEPTION_POLICY);
  });

  it("keeps synthesized family rows distinct and preserves leading parameters, shared results, and arity guards", () => {
    const records = catalog.RUNTIME_HOST_CAPABILITY_RECORDS;
    const family = catalog.resolveRuntimeHostCapabilityRecord(records, "callable.host_call.fixed");
    const concrete = catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "callable.host_call.fixed", 2);
    expect(concrete).toEqual({
      module: "env",
      field: "__call_function_2",
      params: ["externref", "externref", "externref", "externref"],
      results: ["externref"],
    });
    expect(concrete).not.toHaveProperty("capability");
    expect(concrete).not.toHaveProperty("kind");
    expect(family.kind === "func-family" && concrete.results === family.results).toBe(true);
    expect(Object.isFrozen(concrete)).toBe(true);
    expect(Object.isFrozen(concrete.params)).toBe(true);
    expect(() => catalog.assertCanonicalRuntimeHostCapabilityRecord(concrete)).toThrow();
    expect(() => catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "callable.host_call.fixed", 5)).toThrow(
      "does not cover arity",
    );
    expect(() => catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "string.concat.many", 2)).toThrow(
      "does not cover arity",
    );
    expect(catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "string.concat.many", 9).params).toHaveLength(
      9,
    );
    for (const invalid of [-1, 0.5, NaN, Infinity]) {
      expect(() =>
        catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "callable.host_call.fixed", invalid),
      ).toThrow("does not cover arity");
    }
  });

  it("preserves the async projection's eight exact catalog objects and rejects every non-async record", () => {
    expect(ASYNC_HOST_CAPABILITY_RECORDS).toHaveLength(8);
    for (const row of catalog.RUNTIME_HOST_CAPABILITY_RECORDS) {
      if (row.capability.startsWith("async.")) {
        expect(asAsyncHostAdapter(row)).toBe(row);
        expect(ASYNC_HOST_CAPABILITY_RECORDS.find((entry) => entry.capability === row.capability)).toBe(row);
        expect(
          row.kind === "func" &&
            [...row.params, ...row.results].every((value) => value === "externref" || value === "i32"),
        ).toBe(true);
      } else {
        expect(() => asAsyncHostAdapter(row)).toThrow("not an async capability");
      }
    }
    expect(() => asAsyncHostAdapter({ ...catalog.HOST_CALLBACK_WRAP_CAPABILITY_RECORD, params: ["f64"] })).toThrow(
      "cannot carry value type f64",
    );
  });

  it("compiles old/new generic compatibility and all four record discriminants, with real negative controls", () => {
    const source = [
      "import type * as New from '../src/runtime/contracts/host-capability-schema.js';",
      "import type * as Old from '../src/ir/runtime-host-capabilities.js';",
      ...typeNames.map((name) => "{ let old!: Old." + name + "; let next: New." + name + " = old; old = next; }"),
      "type Narrow = New.RuntimeHostCapabilityFuncRecord<'async.callback.wrap', 'externref' | 'i32'>;",
      "let narrow!: Narrow; let oldNarrow: Old.RuntimeHostCapabilityFuncRecord<'async.callback.wrap', 'externref' | 'i32'> = narrow; narrow = oldNarrow;",
      "let all!: New.RuntimeHostCapabilityRecord;",
      "let func!: New.RuntimeHostCapabilityFuncRecord; all = func;",
      "let global!: New.RuntimeHostCapabilityGlobalRecord; all = global;",
      "let family!: New.RuntimeHostCapabilityFuncFamilyRecord; all = family;",
      "let exported!: New.RuntimeHostCapabilityExportRecord; all = exported;",
      "let resolved!: New.ResolvedRuntimeHostCapabilityFuncFamilyRow<'externref'>;",
      "let narrowed!: New.RuntimeHostCapabilityRecord<'number.box', 'f64' | 'externref'>;",
      "if (narrowed.kind === 'func') { const id: 'number.box' = narrowed.capability; }",
      "function discriminate(row: New.RuntimeHostCapabilityRecord): string {",
      " switch (row.kind) {",
      " case 'func': return row.module + row.field + row.params.length;",
      " case 'func-family': return row.module + row.field.prefix + row.params.repeat;",
      " case 'global': return row.module + row.field.scheme + row.valueType;",
      " case 'export': return row.name + row.alias + row.publication;",
      " default: { const unreachable: never = row; return unreachable; }",
      " }}",
      "// @ts-expect-error a family is not a concrete callable ID",
      "type BadFamily = New.RuntimeHostCapabilityFuncRecord<'string.concat.many'>;",
      "// @ts-expect-error global IDs cannot be callables",
      "type BadGlobal = New.RuntimeHostCapabilityFuncRecord<'string.const'>;",
      "// @ts-expect-error export IDs cannot be callables",
      "type BadExport = New.RuntimeHostCapabilityFuncRecord<'callable.export.arity'>;",
      "// @ts-expect-error value generic stays closed",
      "type BadValue = New.RuntimeHostCapabilityFuncFamilyParams<'i64'>;",
      "// @ts-expect-error narrowed async ABI cannot carry f64",
      "const invalidParams: Narrow['params'] = ['f64'];",
      "// @ts-expect-error synthesized rows lack canonical identity and kind",
      "all = resolved;",
      "// @ts-expect-error export direction has no module namespace",
      "exported.module;",
      "// @ts-expect-error the global namespace is not a func namespace",
      "const moduleName: New.RuntimeHostCapabilityFuncModule = 'string_constants';",
      "// @ts-expect-error literal field derivation is not an arity derivation",
      "const fieldScheme: New.RuntimeHostCapabilityFuncFamilyFieldScheme = 'literal';",
      "// @ts-expect-error host selection is a closed declared condition",
      "const selection: New.RuntimeHostCapabilityHostSelectionCondition = 'zero';",
    ].join("\n");
    const valid = typeDiagnostics(source);
    expect(valid.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n"))).toEqual([]);
    const invalid = typeDiagnostics(source.replaceAll("@ts-expect-error", "negative control"));
    expect(invalid).toHaveLength(10);
    expect(invalid.every((entry) => entry.category === ts.DiagnosticCategory.Error)).toBe(true);
  });
});
