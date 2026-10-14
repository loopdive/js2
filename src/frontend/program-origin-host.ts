// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "./typescript.js";
import { invalidProgramOrigin, originData } from "./program-origin-census.js";

const OBSERVED = new Set([
  "fileExists",
  "readFile",
  "directoryExists",
  "getDirectories",
  "readDirectory",
  "realpath",
  "getCurrentDirectory",
  "getDefaultLibFileName",
  "useCaseSensitiveFileNames",
  "getCanonicalFileName",
  "getScriptFileNames",
  "getScriptVersion",
  "getProjectVersion",
  "getScriptKind",
  "resolveModuleNameLiterals",
  "resolveModuleNames",
  "resolveTypeReferenceDirectives",
  "resolveTypeReferenceDirectiveReferences",
  "getSourceFile",
  "getScriptSnapshot",
]);

function resultData(key: string, value: unknown): string {
  if (value === undefined) return "undefined";
  if (key === "getSourceFile") {
    const source = value as ts.SourceFile;
    return originData([source.fileName, source.text, source.languageVersion, source.languageVariant]);
  }
  if (key === "getScriptSnapshot") {
    const snapshot = value as ts.IScriptSnapshot;
    return originData(snapshot.getText(0, snapshot.getLength()));
  }
  return originData(value);
}

/** Observe actual positive AND negative host answers used while constructing a Program. */
export function observeProgramHost<T extends ts.CompilerHost | ts.LanguageServiceHost>(
  host: T,
): {
  host: T;
  currentness: () => () => void;
  clear: () => void;
} {
  let probes: (() => void)[] = [];
  const wrappers = new Map<string, (...args: unknown[]) => unknown>();
  const wrapped = new Proxy(host, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof key !== "string" || !OBSERVED.has(key) || typeof method !== "function") return method;
      let wrapper = wrappers.get(key);
      if (!wrapper) {
        wrapper = (...args: unknown[]) => {
          const result: unknown = Reflect.apply(method, target, args);
          const expected = resultData(key, result);
          probes.push(() => {
            if (
              Reflect.get(target, key) !== method ||
              resultData(key, Reflect.apply(method, target, args)) !== expected
            )
              invalidProgramOrigin(`host ${key} answer changed`);
          });
          return result;
        };
        wrappers.set(key, wrapper);
      }
      return wrapper;
    },
  });
  return {
    host: wrapped,
    currentness: () => {
      const captured = [...probes];
      return () => {
        for (const probe of captured) probe();
      };
    },
    clear: () => {
      probes = [];
    },
  };
}
