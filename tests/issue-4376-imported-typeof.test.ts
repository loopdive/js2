// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

it.each(["gc", "standalone"] as const)("classifies imported runtime bindings in %s", async (target) => {
  const result = await compileMulti(
    {
      "/imports/owner.ts": `
      export const object:any={answer:42};
      export function callable():number {return 42;}
      export const absent:any=undefined;
      export interface Shape { answer:number; }
      export let changing:any={answer:1};
      export function clear():void {changing=undefined;}
      export default object;
    `,
      "/imports/main.ts": `
      import defaultObject,{object as alias,callable,absent,changing,clear} from "./owner.ts";
      import type {Shape} from "./owner.ts";
      import * as namespace from "./owner.ts";
      if (typeof alias==="undefined") throw new Error("import alias is bound");
      export function run():number {
        if (typeof alias!=="object" || typeof defaultObject!=="object") return -1;
        if (typeof callable!=="function" || typeof namespace!=="object") return -2;
        if (typeof absent!=="undefined" || typeof missingName!=="undefined") return -3;
        if (typeof Shape!=="undefined") return -5;
        const objectKind=typeof alias;
        const functionKind=typeof callable;
        const namespaceKind=typeof namespace;
        if (objectKind!=="object" || functionKind!=="function" || namespaceKind!=="object") return -4;
        if (typeof changing!=="object") return -6;
        clear();
        if (typeof changing!=="undefined") return -7;
        return alias.answer;
      }
    `,
    },
    "/imports/main.ts",
    { target, skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void } | undefined)?.__setInstance?.(
    instance,
  );
  expect((instance.exports.run as () => number)()).toBe(42);
});

it.each(["gc", "standalone"] as const)(
  "preserves import erasure and live re-export typeof forms in %s",
  async (target) => {
    const result = await compileMulti(
      {
        "/composition/owner.ts": `
          export function callable():number {return 42;}
          export default callable;
          export let changing:any={answer:1};
          export function clear():void {changing=undefined;}
        `,
        "/composition/reexport.ts": `
          export {callable as renamed,changing as current,clear} from "./owner.ts";
        `,
        "/composition/main.ts": `
          import type ErasedDefault from "./owner.ts";
          import type {callable as ErasedCallable} from "./owner.ts";
          import type * as ErasedNamespace from "./owner.ts";
          import {type callable as ErasedInline,callable as Live} from "./owner.ts";
          import {renamed,current,clear} from "./reexport.ts";
          import * as namespace from "./reexport.ts";
          export function run():number {
            const defaultKind=typeof ErasedDefault;
            const callableKind=typeof ErasedCallable;
            const namespaceKind=typeof ErasedNamespace;
            const inlineKind=typeof ErasedInline;
            if (defaultKind!=="undefined" || typeof ErasedDefault!=="undefined" || !(typeof ErasedDefault==="undefined")) return -1;
            if (callableKind!=="undefined" || typeof ErasedCallable!=="undefined" || !(typeof ErasedCallable==="undefined")) return -2;
            if (namespaceKind!=="undefined" || typeof ErasedNamespace!=="undefined" || !(typeof ErasedNamespace==="undefined")) return -3;
            if (inlineKind!=="undefined" || typeof ErasedInline!=="undefined" || !(typeof ErasedInline==="undefined")) return -4;
            const liveKind=typeof Live;
            const renamedKind=typeof renamed;
            const runtimeNamespaceKind=typeof namespace;
            if (liveKind!=="function" || typeof Live!=="function" || Live()!==42) return -5;
            if (renamedKind!=="function" || typeof renamed!=="function" || renamed()!==42) return -6;
            if (runtimeNamespaceKind!=="object" || typeof namespace!=="object" || namespace.renamed()!==42) return -7;
            const beforeKind=typeof current;
            if (beforeKind!=="object" || typeof current!=="object" || typeof namespace.current!=="object") return -8;
            clear();
            const afterKind=typeof current;
            const afterNamespaceKind=typeof namespace.current;
            if (afterKind!=="undefined" || typeof current!=="undefined" || afterNamespaceKind!=="undefined" || typeof namespace.current!=="undefined") return -9;
            const missingKind=typeof missingName;
            if (missingKind!=="undefined" || typeof missingName!=="undefined") return -10;
            return 42;
          }
        `,
      },
      "/composition/main.ts",
      { target, skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
    (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void } | undefined)?.__setInstance?.(
      instance,
    );
    expect((instance.exports.run as () => number)()).toBe(42);
  },
);

import { TsCheckerOracle } from "../src/checker/oracle.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { typeofOperandIsDeclared } from "../src/codegen/expressions/typeof-import-binding.js";
import { ts } from "../src/ts-api.js";

it("keeps unresolved runtime imports declared despite an actual checker diagnostic", () => {
  const fileName = "/unresolved/main.ts";
  const source = 'import { missing } from "./unavailable.ts"; export const kind = typeof missing;';
  const options: ts.CompilerOptions = {
    noLib: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  host.getSourceFile = (name) => (name === fileName ? sourceFile : undefined);
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? source : undefined);
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const oracle = new TsCheckerOracle(checker);
  const declaration = sourceFile.statements[1] as ts.VariableStatement;
  const operand = (declaration.declarationList.declarations[0].initializer as ts.TypeOfExpression).expression;
  expect(ts.isIdentifier(operand)).toBe(true);
  const identifier = operand as ts.Identifier;
  expect(ts.isImportSpecifier(oracle.valueDeclarationOf(identifier)!)).toBe(true);
  expect(oracle.aliasedValueDeclarationOf(identifier)).toBeUndefined();
  expect(program.getSemanticDiagnostics().some((diagnostic) => diagnostic.code === 2307)).toBe(true);
  expect(
    typeofOperandIsDeclared({ oracle } as CodegenContext, identifier, checker.getSymbolAtLocation(identifier)),
  ).toBe(true);
});
