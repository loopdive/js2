// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// JSR's registry validates forbidden declaration syntax after upload, while
// `jsr publish --dry-run` stops before that server-side analysis. Retain only
// the public declaration graph and mirror the registry checks locally so a
// release cannot discover an augmentation failure after its tag is public.

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const distRoot = resolve("dist");
const entries = ["index", "runtime", "optimize"];
const declarationEntries = entries.map((entry) => resolve(distRoot, `${entry}.d.ts`));
const declarationResolutionOptions = {
  allowJs: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

function listDeclarationFiles(directory) {
  const files = [];
  const directories = [directory];
  while (directories.length > 0) {
    const current = directories.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && path.endsWith(".d.ts")) files.push(path);
    }
  }
  return files.sort();
}

function isInsideDist(path) {
  const fromDist = relative(distRoot, path);
  return fromDist !== "" && fromDist !== ".." && !fromDist.startsWith(`..${sep}`) && !isAbsolute(fromDist);
}

function resolveDeclaration(from, specifier) {
  const resolved = ts.resolveModuleName(specifier, from, declarationResolutionOptions, ts.sys).resolvedModule;
  if (!resolved || resolved.isExternalLibraryImport || !isInsideDist(resolved.resolvedFileName)) return undefined;
  if (!resolved.resolvedFileName.endsWith(".d.ts")) {
    throw new Error(
      `JSR declaration ${relative(distRoot, from)} resolves ${specifier} to non-declaration ${relative(distRoot, resolved.resolvedFileName)}`,
    );
  }
  return resolve(resolved.resolvedFileName);
}

function collectDeclarationClosure() {
  const retained = new Set();
  const queue = [...declarationEntries];
  while (queue.length > 0) {
    const path = queue.shift();
    if (retained.has(path)) continue;
    if (!existsSync(path)) throw new Error(`JSR declaration closure is missing ${relative(distRoot, path)}`);
    retained.add(path);

    const source = readFileSync(path, "utf8");
    const imports = ts.preProcessFile(source, true, true);
    if (imports.libReferenceDirectives.length > 0 || imports.isLibFile) {
      throw new Error(`JSR declaration ${relative(distRoot, path)} contains a forbidden triple-slash lib directive`);
    }
    for (const imported of imports.importedFiles) {
      const target = resolveDeclaration(path, imported.fileName);
      if (imported.fileName.startsWith(".") && !target) {
        throw new Error(
          `JSR declaration ${relative(distRoot, path)} has an unresolved relative import ${imported.fileName}`,
        );
      }
      if (target && !retained.has(target)) queue.push(target);
    }
    for (const referenced of imports.referencedFiles) {
      const target = resolve(dirname(path), referenced.fileName);
      if (!existsSync(target) || !target.endsWith(".d.ts") || !isInsideDist(target)) {
        throw new Error(
          `JSR declaration ${relative(distRoot, path)} has an invalid triple-slash path ${referenced.fileName}`,
        );
      }
      if (!retained.has(target)) queue.push(target);
    }
    for (const typeReference of imports.typeReferenceDirectives) {
      const resolved = ts.resolveTypeReferenceDirective(
        typeReference.fileName,
        path,
        declarationResolutionOptions,
        ts.sys,
      ).resolvedTypeReferenceDirective;
      if (!resolved || resolved.isExternalLibraryImport || !isInsideDist(resolved.resolvedFileName)) continue;
      const target = resolve(resolved.resolvedFileName);
      if (!target.endsWith(".d.ts")) {
        throw new Error(
          `JSR declaration ${relative(distRoot, path)} resolves type reference ${typeReference.fileName} to a non-declaration file`,
        );
      }
      if (!retained.has(target)) queue.push(target);
    }
  }
  return retained;
}

function assertRegistrySafeDeclarations(paths) {
  const violations = [];
  for (const path of paths) {
    const sourceFile = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let reason;
      if (
        ts.isModuleDeclaration(node) &&
        ((node.flags & ts.NodeFlags.GlobalAugmentation) !== 0 || ts.isStringLiteral(node.name))
      ) {
        reason = "global/module augmentation";
      } else if (ts.isNamespaceExportDeclaration(node)) {
        reason = "namespace export";
      } else if (ts.isExportAssignment(node) && node.isExportEquals) {
        reason = "CommonJS export assignment";
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        reason = "CommonJS import assignment";
      }
      if (reason) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(`${relative(distRoot, path)}:${line + 1}:${character + 1} (${reason})`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  if (violations.length > 0) {
    throw new Error(`JSR declarations contain registry-forbidden syntax:\n${violations.join("\n")}`);
  }
}

for (const entry of entries) {
  const javascriptPath = resolve(distRoot, `${entry}.js`);
  const declarationPath = resolve(distRoot, `${entry}.d.ts`);
  if (!existsSync(javascriptPath) || !existsSync(declarationPath)) {
    throw new Error(`JSR build is missing dist/${entry}.js or dist/${entry}.d.ts`);
  }
}

const allDeclarations = listDeclarationFiles(distRoot);
const retainedDeclarations = collectDeclarationClosure();
for (const path of allDeclarations) {
  if (!retainedDeclarations.has(path)) unlinkSync(path);
}

const rebuiltClosure = collectDeclarationClosure();
assertRegistrySafeDeclarations(rebuiltClosure);
console.log(
  `JSR declaration closure: retained ${rebuiltClosure.size.toLocaleString()} / ${allDeclarations.length.toLocaleString()} files; registry-forbidden syntax: none`,
);

for (const entry of entries) {
  const javascriptPath = resolve(distRoot, `${entry}.js`);
  const source = readFileSync(javascriptPath, "utf8");
  if (source.includes("@ts-self-types")) {
    throw new Error(`JSR build already contains an unexpected @ts-self-types directive in dist/${entry}.js`);
  }

  const directive = `/* @ts-self-types="./${entry}.d.ts" */`;
  writeFileSync(javascriptPath, `${directive}\n${source}`);
}
