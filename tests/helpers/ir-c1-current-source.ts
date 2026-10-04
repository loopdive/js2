// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  captureProgramValidatorRelocation,
  type ProgramValidatorRelocationCapture,
  type ProgramValidatorDonorPath,
} from "./ir-program-validator-relocation.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  captureC1HistoricalAuthority,
  type C1LinearOptionsContract,
  type C1PathPin,
  type C1Pin,
  type C1ResolverLocation,
  type C1ResolverObservation,
} from "./ir-c1-historical-authority.js";
import {
  assertRuntimeProgramRelocationSource,
  authenticateRuntimeProgramRelocationReceipt,
  reconstructRuntimeProgramRelocationPopulation,
  runtimeProgramRelocationPopulationPaths,
  runtimeProgramRelocationReceiptPath,
  type C1DonorPath,
  type RuntimeProgramRelocationReader,
} from "./ir-runtime-program-relocation.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const linearPath = "src/codegen-linear/index.ts";
const slash = (path: string): string => path.split(sep).join("/");
const hash = (source: string): string => createHash("sha256").update(source).digest("hex");
function fail(detail: string): never {
  throw new Error("C1 current source: " + detail);
}
function primitive(source: unknown, path: string): asserts source is string {
  if (typeof source !== "string") fail("primitive source required: " + path);
}
function pin(source: string): C1Pin {
  return Object.freeze({
    bytes: Buffer.byteLength(source),
    sha256: hash(source),
    gitBlob: createHash("sha1")
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest("hex"),
  });
}
function assertPin(source: string, expected: C1Pin, label: string): void {
  primitive(source, label);
  if (JSON.stringify(pin(source)) !== JSON.stringify(expected)) fail("full pin mismatch: " + label);
}
const canonicalInputEpochs = [
  {
    path: "src/wasm/model/instructions.ts",
    beforePin: {
      bytes: 14904,
      sha256: "b305b96583e473272f26032cd1e4ad4653a32d4f56db74df50dac7f1c2461b6d",
      gitBlob: "699c7b386f529b6017659a2f4b0f3c5671235969",
    },
    currentPin: {
      bytes: 15135,
      sha256: "8c4c9a27c00e57caafe29e64f465b49b6ab13d77744d9d071b80609bb65d4360",
      gitBlob: "d3c10d8a8e4c1ecd45d2a7c13e372daa8ae378d0",
    },
    spans: [
      {
        beforeOffset: 2703,
        afterOffset: 2703,
        before: '  | { kind: "i32"; boolean?: true; symbol?: true }\n',
        after:
          '  // (#6798) `int32` marks a `type i32 = number` destination: an f64 entering it\n  // converts with ToInt32 (wrap, like `x | 0`), not the saturating truncation\n  // the generic f64 → i32 coercion keeps for indices.\n  | { kind: "i32"; boolean?: true; symbol?: true; int32?: true }\n',
      },
    ],
  },
  {
    path: "package.json",
    beforePin: {
      bytes: 29631,
      sha256: "6dcd7ca0c6895e71d3bc3373c05b49b6d6b0a07df8732131386e557d82dc6434",
      gitBlob: "57ab56f8f065cf84e366bc0f61269336444b0b7b",
    },
    currentPin: {
      bytes: 29828,
      sha256: "bc084f6c2a17667e42d0c985330cbe064715984a7007201a5635c1622b10c395",
      gitBlob: "e25ea8aa13863815c93d511ba78f5e629b4b4121",
    },
    spans: [
      {
        beforeOffset: 1789,
        afterOffset: 1789,
        before: '    "binaryen": "^132.0.0",\n    "bun": ">=1.3.14",\n    "deno": ">=2.8.1"\n',
        after: '    "binaryen": "^132.0.0"\n',
      },
      {
        beforeOffset: 1913,
        afterOffset: 1867,
        before: '      "optional": true\n    },\n    "bun": {\n      "optional": true\n    },\n    "deno": {\n',
        after: "",
      },
      {
        beforeOffset: 2282,
        afterOffset: 2149,
        before: '    "build": "vite build --config vite.config.lib.ts && node scripts/build-test262-cli.mjs",\n',
        after:
          '    "build": "vite build --config vite.config.lib.ts && node scripts/prune-dist-declarations.mjs && node scripts/build-test262-cli.mjs",\n',
      },
      {
        beforeOffset: 4780,
        afterOffset: 4691,
        before: "",
        after:
          '    "check:import-cycles": "node scripts/check-import-cycles.mjs",\n    "check:flat-dir-budget": "node scripts/check-flat-dir-budget.mjs",\n',
      },
      {
        beforeOffset: 7427,
        afterOffset: 7476,
        before: "",
        after: '    "check:orphaned-scripts": "node scripts/check-orphaned-scripts.mjs",\n',
      },
      {
        beforeOffset: 8284,
        afterOffset: 8406,
        before: "",
        after: '    "check:tracked-ignored": "node scripts/check-tracked-ignored.mjs",\n',
      },
      {
        beforeOffset: 29143,
        afterOffset: 29336,
        before: '    "vitest": "^3",\n',
        after: '    "vitest": "^3.2.6",\n',
      },
    ],
  },
  {
    path: "pnpm-lock.yaml",
    beforePin: {
      bytes: 292598,
      sha256: "cd18b2b644544c06017f91c790c44156d6ad178e568b5ae2b3746b0740728273",
      gitBlob: "70f62186954477b320c5af66514303e024d8e9c1",
    },
    currentPin: {
      bytes: 292602,
      sha256: "6a8b59fd4430c6600dc16ac33a749d0f5fed4ef0c100425de8490e43d916f2ac",
      gitBlob: "03fbaf3f914c0dcd1ebbda6a1d2bce86491d0e3a",
    },
    spans: [
      {
        beforeOffset: 3290,
        afterOffset: 3290,
        before:
          "        specifier: ^3\n        version: 3.2.4(@types/node@22.19.13)(jsdom@30.0.1)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3)\n",
        after:
          "        specifier: ^3.2.6\n        version: 3.2.7(@types/node@22.19.13)(jsdom@30.0.1)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3)\n",
      },
      {
        beforeOffset: 77978,
        afterOffset: 77982,
        before:
          "  '@vitest/expect@3.2.4':\n    resolution: {integrity: sha512-Io0yyORnB6sikFlt8QW5K7slY4OjqNX9jmJQ02QDda8lyM6B5oNgVWoSoKPac8/kgnCUzuHQKrSLtu/uOqqrig==}\n",
        after:
          "  '@vitest/expect@3.2.7':\n    resolution: {integrity: sha512-E8eBXaKibuvH2pSZErOjdVb5vF4PbKYcrnluBTYxEk1l/VhhwZg1kZQsdtjq+CsF5CFydf2Rdkz7jDHKSisi3w==}\n",
      },
      {
        beforeOffset: 78130,
        afterOffset: 78134,
        before:
          "  '@vitest/mocker@3.2.4':\n    resolution: {integrity: sha512-46ryTE9RZO/rfDd7pEqFl7etuyzekzEhUbTW3BvmeO/BcCMEgq59BKhek3dXDWgAj4oMK6OZi+vRr1wPW6qjEQ==}\n",
        after:
          "  '@vitest/mocker@3.2.7':\n    resolution: {integrity: sha512-Trr0hYO9CM3Wj6ksWHRhK9IZpIY6wTMO5u/MqXurMxT57sWBaOPEtP3Oq60ihZuh5JsiagKfz95OcxdEP6dBrA==}\n",
      },
      {
        beforeOffset: 78458,
        afterOffset: 78462,
        before:
          "  '@vitest/pretty-format@3.2.4':\n    resolution: {integrity: sha512-IVNZik8IVRJRTr9fxlitMKeJeXFFFN0JaB9PHPGQ8NKQbGpfjlTx9zO4RefN8gp7eqjNy8nyK3NZmBzOPeIxtA==}\n",
        after:
          "  '@vitest/pretty-format@3.2.7':\n    resolution: {integrity: sha512-KUHlwqVu0sRlhCdyPdQ/wBoTfRahjUky1MubOmYw9fWfIZy1gNoHpuaaQBPAaMaVYdQYHJLurzj8ECCj5OwTqA==}\n",
      },
      {
        beforeOffset: 78617,
        afterOffset: 78621,
        before:
          "  '@vitest/runner@3.2.4':\n    resolution: {integrity: sha512-oukfKT9Mk41LreEW09vt45f8wx7DordoWUZMYdY/cyAk7w5TWkTRCNZYF7sX7n2wB7jyGAl74OxgwhPgKaqDMQ==}\n",
        after:
          "  '@vitest/runner@3.2.7':\n    resolution: {integrity: sha512-sB9y4ovltoQP+WaUPwmSxO9WIg9Ig694Di5PalVPsYHklAdE027mehpWF2SQSVq+k6sFgaivbTjTJwZLSHbedA==}\n",
      },
      {
        beforeOffset: 78769,
        afterOffset: 78773,
        before:
          "  '@vitest/snapshot@3.2.4':\n    resolution: {integrity: sha512-dEYtS7qQP2CjU27QBC5oUOxLE/v5eLkGqPE0ZKEIDGMs4vKWe7IjgLOeauHsR0D5YuuycGRO5oSRXnwnmA78fQ==}\n",
        after:
          "  '@vitest/snapshot@3.2.7':\n    resolution: {integrity: sha512-7C+MwShwtBSI5Buwoyg3s/iY1eHL9PKAf+O1wVh/TdnjXUtkoL/9YQtre90i4MtNXM6edP1wJ2zOBpfCyhIS7g==}\n",
      },
      {
        beforeOffset: 78923,
        afterOffset: 78927,
        before:
          "  '@vitest/spy@3.2.4':\n    resolution: {integrity: sha512-vAfasCOe6AIK70iP5UD11Ac4siNUNJ9i/9PZ3NKx07sG6sUxeag1LWdNrMWeKKYBLlzuK+Gn65Yd5nyL6ds+nw==}\n",
        after:
          "  '@vitest/spy@3.2.7':\n    resolution: {integrity: sha512-Q2eQGI6d2L/hBtZ0qNuKcAGid68XK6cv1xsoaIma6PaJhHPoqcEJhYpXZ/5myCMqkNgtP6UKuBhbc0nHKnrkuQ==}\n",
      },
      {
        beforeOffset: 79072,
        afterOffset: 79076,
        before:
          "  '@vitest/utils@3.2.4':\n    resolution: {integrity: sha512-fB2V0JFrQSMsCo9HiSq3Ezpdv4iYaXRG1Sx8edX3MwxfyNn83mKiGzOcH+Fkxt4MHxr3y42fQi1oeAInqgX2QA==}\n",
        after:
          "  '@vitest/utils@3.2.7':\n    resolution: {integrity: sha512-x6BDOd7dyo3PFLY3I9/HJ25X/6OurhGXk2/B9gOZNPF7XDVjeBK4k01lQE5uvDpbuheErh91qYuE1E2OEjK3Rw==}\n",
      },
      {
        beforeOffset: 185798,
        afterOffset: 185802,
        before:
          "  vitest@3.2.4:\n    resolution: {integrity: sha512-LUCP5ev3GURDysTWiP47wRRUpLKMOfPh+yKTx3kVIEiu5KOMeqzpnYNsKyOoVrULivR8tLcks4+lga33Whn90A==}\n",
        after:
          "  vitest@3.2.7:\n    resolution: {integrity: sha512-KrxIJ62Fd89gfysR4WotlgZABiz2dqFPgqGzX7s+CwsqLFomRH7777ZcrOD6+WVAh7khPQP41A+BKbpcJFrdEg==}\n",
      },
      {
        beforeOffset: 186142,
        afterOffset: 186146,
        before: "      '@vitest/browser': 3.2.4\n      '@vitest/ui': 3.2.4\n",
        after: "      '@vitest/browser': 3.2.7\n      '@vitest/ui': 3.2.7\n",
      },
      {
        beforeOffset: 229045,
        afterOffset: 229049,
        before: "  '@vitest/expect@3.2.4':\n",
        after: "  '@vitest/expect@3.2.7':\n",
      },
      {
        beforeOffset: 229116,
        afterOffset: 229120,
        before: "      '@vitest/spy': 3.2.4\n      '@vitest/utils': 3.2.4\n",
        after: "      '@vitest/spy': 3.2.7\n      '@vitest/utils': 3.2.7\n",
      },
      {
        beforeOffset: 229216,
        afterOffset: 229220,
        before: "  '@vitest/mocker@3.2.4(vite@6.4.1(@types/node@22.19.13)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3))':\n",
        after: "  '@vitest/mocker@3.2.7(vite@6.4.1(@types/node@22.19.13)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3))':\n",
      },
      {
        beforeOffset: 229333,
        afterOffset: 229337,
        before: "      '@vitest/spy': 3.2.4\n",
        after: "      '@vitest/spy': 3.2.7\n",
      },
      {
        beforeOffset: 229521,
        afterOffset: 229525,
        before: "  '@vitest/pretty-format@3.2.4':\n",
        after: "  '@vitest/pretty-format@3.2.7':\n",
      },
      {
        beforeOffset: 229598,
        afterOffset: 229602,
        before: "  '@vitest/runner@3.2.4':\n",
        after: "  '@vitest/runner@3.2.7':\n",
      },
      {
        beforeOffset: 229642,
        afterOffset: 229646,
        before: "      '@vitest/utils': 3.2.4\n",
        after: "      '@vitest/utils': 3.2.7\n",
      },
      {
        beforeOffset: 229718,
        afterOffset: 229722,
        before: "  '@vitest/snapshot@3.2.4':\n",
        after: "  '@vitest/snapshot@3.2.7':\n",
      },
      {
        beforeOffset: 229764,
        afterOffset: 229768,
        before: "      '@vitest/pretty-format': 3.2.4\n",
        after: "      '@vitest/pretty-format': 3.2.7\n",
      },
      {
        beforeOffset: 229849,
        afterOffset: 229853,
        before: "  '@vitest/spy@3.2.4':\n",
        after: "  '@vitest/spy@3.2.7':\n",
      },
      {
        beforeOffset: 229912,
        afterOffset: 229916,
        before: "  '@vitest/utils@3.2.4':\n",
        after: "  '@vitest/utils@3.2.7':\n",
      },
      {
        beforeOffset: 229955,
        afterOffset: 229959,
        before: "      '@vitest/pretty-format': 3.2.4\n",
        after: "      '@vitest/pretty-format': 3.2.7\n",
      },
      {
        beforeOffset: 288211,
        afterOffset: 288215,
        before: "  vitest@3.2.4(@types/node@22.19.13)(jsdom@30.0.1)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3):\n",
        after: "  vitest@3.2.7(@types/node@22.19.13)(jsdom@30.0.1)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3):\n",
      },
      {
        beforeOffset: 288347,
        afterOffset: 288351,
        before:
          "      '@vitest/expect': 3.2.4\n      '@vitest/mocker': 3.2.4(vite@6.4.1(@types/node@22.19.13)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3))\n      '@vitest/pretty-format': 3.2.4\n      '@vitest/runner': 3.2.4\n      '@vitest/snapshot': 3.2.4\n      '@vitest/spy': 3.2.4\n      '@vitest/utils': 3.2.4\n",
        after:
          "      '@vitest/expect': 3.2.7\n      '@vitest/mocker': 3.2.7(vite@6.4.1(@types/node@22.19.13)(terser@5.46.1)(tsx@4.23.1)(yaml@2.8.3))\n      '@vitest/pretty-format': 3.2.7\n      '@vitest/runner': 3.2.7\n      '@vitest/snapshot': 3.2.7\n      '@vitest/spy': 3.2.7\n      '@vitest/utils': 3.2.7\n",
      },
    ],
  },
] as const;
function beforeCanonicalCurrentInput(path: string, source: string): string {
  const record = canonicalInputEpochs.find((entry) => entry.path === path);
  if (!record) fail("unknown canonical input epoch: " + path);
  assertPin(source, record.currentPin, path);
  const current = Buffer.from(source, "utf8");
  const pieces: Buffer[] = [];
  let cursor = 0;
  let previousBeforeEnd = 0;
  let delta = 0;
  for (const span of record.spans) {
    const before = Buffer.from(span.before, "utf8");
    const after = Buffer.from(span.after, "utf8");
    if (
      span.beforeOffset < previousBeforeEnd ||
      span.afterOffset < cursor ||
      span.afterOffset !== span.beforeOffset + delta ||
      !current.subarray(span.afterOffset, span.afterOffset + after.length).equals(after)
    )
      fail("canonical input epoch span membership: " + path);
    pieces.push(current.subarray(cursor, span.afterOffset), before);
    cursor = span.afterOffset + after.length;
    previousBeforeEnd = span.beforeOffset + before.length;
    delta += after.length - before.length;
  }
  pieces.push(current.subarray(cursor));
  const predecessor = Buffer.concat(pieces);
  assertPin(predecessor.toString("utf8"), record.beforePin, "canonical input epoch predecessor: " + path);
  const replayPieces: Buffer[] = [];
  cursor = 0;
  for (const span of record.spans) {
    const before = Buffer.from(span.before, "utf8");
    const after = Buffer.from(span.after, "utf8");
    if (!predecessor.subarray(span.beforeOffset, span.beforeOffset + before.length).equals(before))
      fail("canonical input epoch predecessor membership: " + path);
    replayPieces.push(predecessor.subarray(cursor, span.beforeOffset), after);
    cursor = span.beforeOffset + before.length;
  }
  replayPieces.push(predecessor.subarray(cursor));
  const replay = Buffer.concat(replayPieces);
  if (!replay.equals(current)) fail("canonical input epoch reciprocal bytes: " + path);
  assertPin(replay.toString("utf8"), record.currentPin, "canonical input epoch replay: " + path);
  return predecessor.toString("utf8");
}

export function beforeCanonicalInstructionsSource(source: unknown): string {
  primitive(source, "src/wasm/model/instructions.ts");
  return beforeCanonicalCurrentInput("src/wasm/model/instructions.ts", source);
}

// Exactly the audited current-main script insertion; no earlier package epoch is accepted.
function assertCurrentPackageScriptEpoch(source: unknown): void {
  primitive(source, "current package script epoch");
  const currentPin: C1Pin = {
    bytes: 29631,
    sha256: "6dcd7ca0c6895e71d3bc3373c05b49b6d6b0a07df8732131386e557d82dc6434",
    gitBlob: "57ab56f8f065cf84e366bc0f61269336444b0b7b",
  };
  const beforePin: C1Pin = {
    bytes: 29560,
    sha256: "86f91d71aa0d5094ae95368df26379bb4a54e448bad612a07db1f41e5ec356ae",
    gitBlob: "bd4ea397a4ba48ed3ee023adf39ecd9429f2abac",
  };
  assertPin(source, currentPin, "current package script epoch");
  const insertion = Buffer.from('    "check:claude-md-paths": "node scripts/check-claude-md-paths.mjs",\n', "utf8");
  const current = Buffer.from(source, "utf8");
  const offset = 8473;
  if (insertion.length !== 71 || current.indexOf(insertion) !== offset || current.lastIndexOf(insertion) !== offset)
    fail("current package script epoch insertion membership");
  const before = Buffer.concat([current.subarray(0, offset), current.subarray(offset + insertion.length)]);
  assertPin(before.toString("utf8"), beforePin, "current package script epoch predecessor");
  const replay = Buffer.concat([before.subarray(0, offset), insertion, before.subarray(offset)]);
  if (!replay.equals(current)) fail("current package script epoch reciprocal bytes");
  assertPin(replay.toString("utf8"), currentPin, "current package script epoch replay");
}
function safeRelative(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !/[\\:?#]/.test(path) &&
    !path.split("/").some((part) => part === "." || part === ".." || part === "")
  );
}
function within(path: string, root: string): boolean {
  const rest = relative(root, path);
  return !isAbsolute(rest) && rest !== ".." && !rest.startsWith(".." + sep);
}
function packageRoots(): { actual: string; alias: string } {
  const alias = resolve(repository, "node_modules/typescript");
  if (!existsSync(alias) || !statSync(alias).isDirectory()) fail("missing explicit TypeScript package link");
  const actual = realpathSync(dirname(createRequire(import.meta.url).resolve("typescript/package.json")));
  if (realpathSync(alias) !== actual) fail("TypeScript package link differs from loaded package");
  return { actual, alias };
}
/** Reader channels use repository paths, or typescript-package/<canonical relative path>. */
const readActual: RuntimeProgramRelocationReader = (path) => {
  if (path.startsWith("typescript-package/")) {
    const suffix = path.slice("typescript-package/".length);
    if (
      !safeRelative(suffix) ||
      ![
        "package.json",
        "lib/typescript.ts",
        "lib/typescript.tsx",
        "lib/typescript.d.ts",
        "lib/typescript.js",
        "lib/typescript.jsx",
      ].includes(suffix)
    )
      fail("unknown or unsafe package read");
    return readFileSync(resolve(packageRoots().actual, suffix), "utf8");
  }
  if (!safeRelative(path)) fail("unsafe repository read");
  return readFileSync(resolve(repository, path), "utf8");
};
function parse(path: string, source: string): ts.SourceFile {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    fail("unparsed source: " + path);
  return file;
}
function declaration(file: ts.SourceFile, contract: C1LinearOptionsContract): ts.InterfaceDeclaration {
  const declarations: ts.InterfaceDeclaration[] = [];
  const walk = (node: ts.Node): void => {
    if (
      (ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name?.getText(file) === "LinearOptions"
    ) {
      if (!ts.isInterfaceDeclaration(node) || node.parent !== file) fail("alternate LinearOptions declaration");
      declarations.push(node);
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.exportClause) fail("unbounded export alternative");
      if (
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some(
          (item) => item.name.text === "LinearOptions" || item.propertyName?.text === "LinearOptions",
        )
      )
        fail("alternate LinearOptions export");
      if (
        node.exportClause &&
        ts.isNamespaceExport(node.exportClause) &&
        node.exportClause.name.text === "LinearOptions"
      )
        fail("alternate LinearOptions namespace export");
    }
    if (ts.isImportEqualsDeclaration(node) && node.name.text === "LinearOptions")
      fail("alternate LinearOptions import-equals binding");
    if (ts.isVariableDeclaration(node) && bindingNames(node.name).includes("LinearOptions"))
      fail("alternate LinearOptions value binding");
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause,
        named = clause?.namedBindings;
      if (
        clause?.name?.text === "LinearOptions" ||
        (named && ts.isNamespaceImport(named) && named.name.text === "LinearOptions") ||
        (named && ts.isNamedImports(named) && named.elements.some((item) => item.name.text === "LinearOptions"))
      )
        fail("alternate LinearOptions imported binding");
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  if (declarations.length !== 1) fail("missing or merged LinearOptions declaration");
  const result = declarations[0]!;
  if (
    result.typeParameters?.length ||
    result.heritageClauses?.length ||
    result.modifiers?.length !== 1 ||
    result.modifiers[0]!.kind !== ts.SyntaxKind.ExportKeyword
  )
    fail("LinearOptions export/generic/heritage form");
  assertPin(file.text.slice(result.getStart(file), result.end), contract.declaration.pin, "LinearOptions declaration");
  return result;
}
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((item) => (ts.isOmittedExpression(item) ? [] : bindingNames(item.name)));
}
function checkBindings(file: ts.SourceFile, target: ts.InterfaceDeclaration, contract: C1LinearOptionsContract): void {
  for (const binding of contract.bindings) {
    if (binding.kind === "import-type") {
      const operands: ts.ImportTypeNode[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isImportTypeNode(node)) operands.push(node);
        ts.forEachChild(node, walk);
      };
      walk(target);
      if (operands.length !== 1) fail("inline import-type membership");
      const operand = operands[0]!;
      if (
        !ts.isLiteralTypeNode(operand.argument) ||
        !ts.isStringLiteral(operand.argument.literal) ||
        operand.argument.literal.text !== binding.module ||
        operand.qualifier?.getText(file) !== binding.qualifier ||
        operand.isTypeOf ||
        operand.typeArguments?.length ||
        operand.attributes
      )
        fail("inline import-type role");
      continue;
    }
    let matching = 0;
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.name?.text === binding.localName) fail("default import shadows contract binding");
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named) && named.name.text === binding.localName)
          fail("namespace import shadows contract binding");
        if (named && ts.isNamedImports(named))
          for (const element of named.elements) {
            if (element.name.text !== binding.localName) continue;
            matching++;
            if (
              !ts.isStringLiteral(statement.moduleSpecifier) ||
              statement.moduleSpecifier.text !== binding.module ||
              (element.propertyName?.text ?? element.name.text) !== binding.importedName ||
              !!clause?.isTypeOnly !== binding.clauseTypeOnly ||
              element.isTypeOnly !== binding.specifierTypeOnly
            )
              fail("named import binding role: " + binding.localName);
          }
      } else if (ts.isVariableStatement(statement)) {
        if (statement.declarationList.declarations.some((item) => bindingNames(item.name).includes(binding.localName)))
          fail("local binding shadows contract import: " + binding.localName);
      } else if (
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isFunctionDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement)) &&
        statement.name?.getText(file) === binding.localName
      ) {
        fail("declaration shadows contract import: " + binding.localName);
      }
    }
    if (matching !== 1) fail("missing or duplicate contract import: " + binding.localName);
  }
}

export interface C1ResolverObservationIO {
  readonly fileExists: (absolutePath: string) => boolean;
  readonly directoryExists: (absolutePath: string) => boolean;
  readonly realpath: (absolutePath: string) => string;
}
function freshResolverIO(supplied?: C1ResolverObservationIO): C1ResolverObservationIO {
  if (supplied === undefined)
    return Object.freeze({
      fileExists: (path: string) => existsSync(path) && statSync(path).isFile(),
      directoryExists: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      realpath: (path: string) => realpathSync(path),
    });
  if (!supplied || typeof supplied !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(supplied)))
    fail("resolver IO must be plain data");
  const keys = ["fileExists", "directoryExists", "realpath"] as const;
  if (JSON.stringify(Reflect.ownKeys(supplied)) !== JSON.stringify(keys)) fail("resolver IO key membership");
  const descriptors = Object.getOwnPropertyDescriptors(supplied);
  for (const key of keys)
    if (
      !Object.hasOwn(descriptors[key]!, "value") ||
      typeof descriptors[key]!.value !== "function" ||
      !descriptors[key]!.enumerable
    )
      fail("resolver IO data-function required: " + key);
  return Object.freeze({
    fileExists: descriptors.fileExists!.value as C1ResolverObservationIO["fileExists"],
    directoryExists: descriptors.directoryExists!.value as C1ResolverObservationIO["directoryExists"],
    realpath: descriptors.realpath!.value as C1ResolverObservationIO["realpath"],
  });
}

/** No Program or global resolution cache: all resolver observations are checked against H1's frozen contract. */
function resolveContract(
  contract: C1LinearOptionsContract,
  captured: ReadonlyMap<string, string>,
  readAuthority: RuntimeProgramRelocationReader,
  io: C1ResolverObservationIO,
): void {
  const roots = packageRoots();
  const location = (path: string): C1ResolverLocation => {
    const absolute = resolve(path);
    // Recognize the explicit package alias before its containing repository.
    for (const root of [roots.actual, roots.alias])
      if (within(absolute, root)) return { scope: "typescript-package", path: slash(relative(root, absolute)) };
    if (within(absolute, repository)) return { scope: "repository", path: slash(relative(repository, absolute)) };
    fail("resolver location outside reviewed roots: " + absolute);
  };
  let ordinal = 0;
  function before(operation: C1ResolverObservation["operation"], at: C1ResolverLocation): void {
    const expected = contract.resolver.observations[ordinal];
    if (!expected || expected.operation !== operation || JSON.stringify(expected.location) !== JSON.stringify(at))
      fail(
        "resolver operation/location mismatch before IO at " +
          ordinal +
          ": " +
          JSON.stringify({ operation, location: at }),
      );
  }
  function observe(observation: C1ResolverObservation): void {
    const expected = contract.resolver.observations[ordinal];
    if (!expected || JSON.stringify(observation) !== JSON.stringify(expected))
      fail("resolver observation mismatch at " + ordinal + ": " + JSON.stringify(observation));
    ordinal++;
  }
  const host: ts.ModuleResolutionHost = {
    readFile(path) {
      const at = location(path);
      before("readFile", at);
      const key = at.scope === "repository" ? at.path : "typescript-package/" + at.path;
      // Each read is a fresh reader call; reused captured data is equality checked, never a success cache.
      const source = readAuthority(key);
      primitive(source, key);
      const prior = captured.get(key);
      if (prior !== undefined && prior !== source) fail("source changed during resolver capture: " + key);
      observe({ operation: "readFile", location: at, pin: pin(source) });
      return source;
    },
    fileExists(path) {
      const at = location(path);
      before("fileExists", at);
      const exists = io.fileExists(path);
      if (typeof exists !== "boolean") fail("resolver fileExists primitive boolean required");
      observe({ operation: "fileExists", location: at, exists });
      return exists;
    },
    directoryExists(path) {
      const at = location(path);
      before("directoryExists", at);
      const exists = io.directoryExists(path);
      if (typeof exists !== "boolean") fail("resolver directoryExists primitive boolean required");
      observe({ operation: "directoryExists", location: at, exists });
      return exists;
    },
    realpath(path) {
      const at = location(path);
      before("realpath", at);
      const target = io.realpath(path);
      if (typeof target !== "string" || !isAbsolute(target)) fail("resolver realpath primitive absolute path required");
      observe({ operation: "realpath", location: at, target: location(target) });
      return target;
    },
    getCurrentDirectory: () => repository,
  };
  const configText = captured.get("tsconfig.json");
  if (configText === undefined) fail("missing authenticated tsconfig");
  const config = ts.parseConfigFileTextToJson("tsconfig.json", configText);
  if (
    config.error ||
    !config.config ||
    hash(JSON.stringify(config.config.compilerOptions)) !== contract.resolver.optionsSha256
  )
    fail("compiler options source mismatch");
  const options = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, repository, "tsconfig.json");
  if (options.errors.length) fail("unconverted compiler options");
  for (const request of contract.resolver.requests) {
    const source = captured.get(request.containingFile);
    if (source === undefined) fail("uncaptured resolver containing file: " + request.containingFile);
    let references = 0;
    const walk = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === request.module
      )
        references++;
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        node.argument.literal.text === request.module
      )
        references++;
      ts.forEachChild(node, walk);
    };
    walk(parse(request.containingFile, source));
    if (!references)
      fail("missing actual import/export resolver role: " + request.containingFile + " -> " + request.module);
    const result = ts.resolveModuleName(
      request.module,
      resolve(repository, request.containingFile),
      options.options,
      host,
    );
    if (
      !result.resolvedModule ||
      JSON.stringify(location(result.resolvedModule.resolvedFileName)) !== JSON.stringify(request.target)
    )
      fail("resolver target mismatch: " + request.containingFile + " -> " + request.module);
  }
  if (ordinal !== contract.resolver.observations.length) fail("missing resolver observations");
}

interface CurrentCapture {
  readonly receiptText: string;
  readonly historicalPopulation: ReadonlyMap<string, string>;
  readonly originals: ReadonlyMap<C1DonorPath, string>;
  readonly observedCurrentPins: readonly C1PathPin[];
}

/** Actual receipt+46 ordered inputs on one channel; independently fresh H1/type/resolver authority on the other. */
export function captureC1CurrentPopulation(
  readPopulation: RuntimeProgramRelocationReader = readActual,
  readAuthority: RuntimeProgramRelocationReader = readActual,
  resolverIO?: C1ResolverObservationIO,
): CurrentCapture {
  const authority = captureC1HistoricalAuthority(readAuthority);
  const contract = authority.linearOptions;
  const io = freshResolverIO(resolverIO);
  const receiptText = readPopulation(runtimeProgramRelocationReceiptPath);
  primitive(receiptText, runtimeProgramRelocationReceiptPath);
  const current = new Map<string, string>();
  for (const path of runtimeProgramRelocationPopulationPaths) {
    const source = readPopulation(path);
    primitive(source, path);
    current.set(path, source);
  }
  // Retain the old receipt/source diagnostics before any narrower contract work.
  // No historical replacement is supplied to the old reconstruction until the live seam passes.
  const receipt = authenticateRuntimeProgramRelocationReceipt(receiptText);
  let validatorRelocation: ProgramValidatorRelocationCapture | undefined;
  const relocatedDependencies = ["src/ir/program-runtime-abi.ts", "src/ir/program-validation.ts"] as const;
  for (const record of [...receipt.current, ...receipt.dependencies]) {
    if (record.path === linearPath) continue;
    const rawSource = current.get(record.path)!;
    if (relocatedDependencies.includes(record.path as (typeof relocatedDependencies)[number])) {
      validatorRelocation ??= captureProgramValidatorRelocation(readAuthority);
      // Authenticate the already-read population operand against the independent physical authority channel.
      // A supplied mutant is refused, never replaced by the healthy authority copy.
      if (rawSource !== validatorRelocation.readCurrent(record.path as ProgramValidatorDonorPath))
        fail("population source differs from current validator facade: " + record.path);
      assertRuntimeProgramRelocationSource(
        validatorRelocation.readBefore(record.path as ProgramValidatorDonorPath),
        record,
        record.path,
      );
    } else assertRuntimeProgramRelocationSource(rawSource, record, record.path);
  }
  // Three closure inputs reuse the already captured population; nine are genuinely extra reads.
  const closure = new Map(current);
  let predecessorPackage: string | undefined;
  for (const record of [...contract.closureInputs, ...contract.resolver.configInputs]) {
    let source = closure.get(record.path);
    if (source === undefined) {
      source = readAuthority(record.path);
      primitive(source, record.path);
      closure.set(record.path, source);
    }
    assertPin(source, record.pin, record.path);
    if (
      record.path === "src/wasm/model/instructions.ts" ||
      record.path === "package.json" ||
      record.path === "pnpm-lock.yaml"
    ) {
      const predecessor = beforeCanonicalCurrentInput(record.path, source);
      if (record.path === "package.json") predecessorPackage = predecessor;
    }
  }
  if (predecessorPackage === undefined) fail("missing canonical package predecessor");
  assertCurrentPackageScriptEpoch(predecessorPackage);
  const live = current.get(linearPath);
  if (live === undefined) fail("missing live linear source");
  const file = parse(linearPath, live);
  const liveDeclaration = declaration(file, contract);
  checkBindings(file, liveDeclaration, contract);
  // Full current program pin is retained by the unchanged C1 guard. Also assert its named seam explicitly.
  const program = parse("src/ir/program.ts", current.get("src/ir/program.ts")!);
  const imports = program.statements.filter(ts.isImportDeclaration).filter((item) => {
    const named = item.importClause?.namedBindings;
    return named && ts.isNamedImports(named) && named.elements.some((element) => element.name.text === "LinearOptions");
  });
  const programImport = imports[0];
  if (
    imports.length !== 1 ||
    !programImport?.importClause?.isTypeOnly ||
    !ts.isStringLiteral(programImport.moduleSpecifier) ||
    programImport.moduleSpecifier.text !== "../codegen-linear/index.js"
  )
    fail("program LinearOptions import role");
  resolveContract(contract, closure, readAuthority, io);
  const historical = authority.readHistorical(linearPath);
  const oldFile = parse(linearPath, historical);
  checkBindings(oldFile, declaration(oldFile, contract), contract);
  const historicalPopulation = new Map(current);
  historicalPopulation.set(linearPath, historical);
  if (validatorRelocation === undefined) fail("missing validator relocation capture");
  for (const path of relocatedDependencies) historicalPopulation.set(path, validatorRelocation.readBefore(path));
  const originals = reconstructRuntimeProgramRelocationPopulation(historicalPopulation, receiptText);
  return Object.freeze({
    receiptText,
    historicalPopulation,
    originals: new Map(originals),
    observedCurrentPins: Object.freeze([...current].map(([path, source]) => Object.freeze({ path, pin: pin(source) }))),
  });
}

export function reconstructC1CurrentSources(
  readPopulation: RuntimeProgramRelocationReader = readActual,
  readAuthority: RuntimeProgramRelocationReader = readActual,
  resolverIO?: C1ResolverObservationIO,
): ReadonlyMap<C1DonorPath, string> {
  return captureC1CurrentPopulation(readPopulation, readAuthority, resolverIO).originals;
}
