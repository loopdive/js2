// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

// Complete declaration/documentation and retained-statement receipts measured
// from f95d8a0bf318e857d981863b1018a9d776483a46. Tests need no historical Git
// object (including in shallow CI). These are preservation, not caller/cut proofs.
interface DeclarationReceipt {
  readonly old: string;
  readonly target: string;
  readonly publicNames: readonly string[];
  readonly names: readonly { readonly name: string; readonly sha256: string }[];
  readonly retainedCount: number;
  readonly retainedFunctions: number;
  readonly retainedSha256: string;
}
const receipts: readonly DeclarationReceipt[] = [
  {
    old: "src/ir/select.ts",
    target: "src/shared/contracts/ir-preparation-failure.ts",
    publicNames: ["IrFallbackReason"],
    names: [
      {
        name: "IrFallbackReason",
        sha256: "9266738809220c485621b804c77dab7eca702225b8892d605e60123652e59609",
      },
    ],
    retainedCount: 332,
    retainedFunctions: 257,
    retainedSha256: "c799eab9355530a4640e7430b53ebb70a03fca358b518ce8946ccc33ef7b57ef",
  },
  {
    old: "src/ir/outcomes.ts",
    target: "src/shared/contracts/ir-preparation-failure.ts",
    publicNames: ["IrPreparationStage", "IrUnsupportedCode", "IrInvariantCode", "IrPreparationFailure"],
    names: [
      {
        name: "IrPreparationStage",
        sha256: "648e0bb47099e893a479f4beb542291dbb9c516eca2403dd5fe81f9ea9983e5d",
      },
      {
        name: "IrUnsupportedCode",
        sha256: "ca619f05199e04050dfac7f58e7ca50dda25b297e8560134a100a272e5760289",
      },
      {
        name: "IrInvariantCode",
        sha256: "302578d8a7db30ef4902636b0c3579e6aaa7d3bab63c517625e59af90ab0f641",
      },
      {
        name: "IrPreparationFailure",
        sha256: "4f3c20a1aaaa45d29ed8810bb7870f4d42ad4aaa2bd372e0eb9b30d9ae63b926",
      },
    ],
    retainedCount: 15,
    retainedFunctions: 5,
    retainedSha256: "e997373d58b7129ea534185a83c87c1cb1c7adf12b56eaeeafe34bc84fa6fd6c",
  },
  {
    old: "src/ir/identity.ts",
    target: "src/shared/contracts/ir-unit-inventory.ts",
    publicNames: [
      "IrSourceKind",
      "IrSyntheticClassRole",
      "IrUnitKind",
      "IrTerminalObservedKind",
      "IrUnownedUnitReason",
      "IrSourceRecord",
      "IrClassRecord",
      "IrOwnedSupportUnitRecord",
      "IrUnownedSupportUnitRecord",
      "IrTerminalUnitRecord",
      "IrUnitRecord",
      "IrUnitInventory",
    ],
    names: [
      {
        name: "IrSourceKind",
        sha256: "c9bde42857d30677dbad908e91ea88b2a0ae0a8be902f3ea0b8aa4286e17703f",
      },
      {
        name: "IrSyntheticClassRole",
        sha256: "b31d394d45fa4e45fb24361ff87e5b968daf187e8b679817e114d6b2aac93c81",
      },
      {
        name: "IrUnitKind",
        sha256: "abe17b6d5c29e7298cfb6414ef5e85956a69d2631061df4fc9c42f0b1d6f59c5",
      },
      {
        name: "IrTerminalObservedKind",
        sha256: "295090544040a18e8613281dddace6e382480da7331cf492bc46a650a5547170",
      },
      {
        name: "IrUnownedUnitReason",
        sha256: "dd8de52091324b9102aa2923522e5ad4815c6386472431b5d6229148d4762839",
      },
      {
        name: "IrSourceRecord",
        sha256: "7470a9ac8efd36534bf29ad96bd723373851af5e6d25155ce9c15b0af3f53a48",
      },
      {
        name: "IrClassRecord",
        sha256: "b7c98746fa072f6f826ae4af54bb7819632a963b3fd63834efd3485e9f1501a1",
      },
      {
        name: "IrUnitRecordBase",
        sha256: "dc5b2bcd594de249e77e0a9644187740a0d4dc242e157c2f3e704d9dc324e588",
      },
      {
        name: "IrOwnedSupportUnitRecord",
        sha256: "61795606785ac69e63b7d9c95aaf296e902b09a614970088bc1d6370d6d052ea",
      },
      {
        name: "IrUnownedSupportUnitRecord",
        sha256: "95986b56a2d0d37569a6e3b234a25b9b88a8a2d896cda3679a5c93bb03539778",
      },
      {
        name: "IrTerminalUnitRecord",
        sha256: "492cfc18d7ff92c68f4b18d3bdc1da98fb773b81b30c0d189786fea906db72f0",
      },
      {
        name: "IrUnitRecord",
        sha256: "9c5846df10d049e9066f56a06c94b7b58b4ce04e91d74d0d566fbefb349585d5",
      },
      {
        name: "IrUnitInventory",
        sha256: "e08958acf343147e2e17134ed5753678b89afd04d4577643f1d40f76f10c1d9a",
      },
    ],
    retainedCount: 62,
    retainedFunctions: 34,
    retainedSha256: "085e2c77ab3f040ea2aa9b4b215a751bdbef69761c1812687f5fed4f16ff0879",
  },
  {
    old: "src/ir/program-callable-bindings.ts",
    target: "src/ir/program/callable-bindings.ts",
    publicNames: ["IrProgramCallableBindingKind", "IrProgramCallableBindingRecord"],
    names: [
      {
        name: "IrProgramCallableBindingKind",
        sha256: "1cb34c41a40fa96922e3ae026c3a116bb31f3dde7b14845c183a72a61d63f1cb",
      },
      {
        name: "IrProgramCallableBindingRecord",
        sha256: "05203e53929dfbe3217da3ff67ba912054615db96754608530da7698e1936c3f",
      },
    ],
    retainedCount: 34,
    retainedFunctions: 20,
    retainedSha256: "febe44246ac4801df0c9d78fc5e6bff8a0bda90e36156931fd2e6c90b0c82a93",
  },
  {
    old: "src/ir/alloc-registry.ts",
    target: "src/ir/analysis/contracts/allocations.ts",
    publicNames: [
      "AllocSite",
      "AllocRegistryProvenanceSnapshot",
      "AllocRegistryMetadataSnapshot",
      "AllocRegistrySnapshot",
    ],
    names: [
      {
        name: "AllocSite",
        sha256: "59e2bd2712857ace006b72841d94bf3a7d322df9a5776c23eb4efd9b941c4454",
      },
      {
        name: "AllocRegistryProvenanceSnapshot",
        sha256: "7cecb0fc5d3272748b4137dbe2c4304183ca04f8b8b958f9d25620e535588b89",
      },
      {
        name: "AllocRegistryMetadataSnapshot",
        sha256: "64c2aaf8ac119495d28d040b1ea82f9fe181418cb905e1d682342e1681060ad9",
      },
      {
        name: "AllocRegistrySnapshot",
        sha256: "54e224f9ef0a9ddf2a0fd503b2227e6ef25eb488b755cf478a916d5b6905bc8a",
      },
    ],
    retainedCount: 5,
    retainedFunctions: 2,
    retainedSha256: "d8e0e98bbf1905025daaae49d186eba708af634a441a152de2f77aa169eaa215",
  },
  {
    old: "src/ir/passes/gvn-core.ts",
    target: "src/ir/passes/contracts/gvn.ts",
    publicNames: ["IrGvnMode"],
    names: [
      {
        name: "IrGvnMode",
        sha256: "d8bb273b14849e613a64f461a2a7247377489515b63e15d5665e8407ce89373f",
      },
    ],
    retainedCount: 9,
    retainedFunctions: 7,
    retainedSha256: "8a5d9b1b10935a88468fe7a6285b792873abf899e145f4b49a1e42cce464714c",
  },
  {
    old: "src/ir/program-middleend-ir.ts",
    target: "src/ir/program/controls.ts",
    publicNames: ["IrPreparationControls"],
    names: [
      {
        name: "IrPreparationControls",
        sha256: "e05e41c3d546f166175cad60e6e62492939dfae1907bc87b989c198369f02ecd",
      },
    ],
    retainedCount: 3,
    retainedFunctions: 2,
    retainedSha256: "048b6285a02cb9932f3589f5544badf2062b1357e48ea58552883a2df17e5a5d",
  },
  {
    old: "src/ir/prepared-component-dependencies.ts",
    target: "src/ir/program/abi-lookup.ts",
    publicNames: ["PreparedComponentAbiEntry", "PreparedComponentAbiLookup"],
    names: [
      {
        name: "PreparedComponentAbiEntry",
        sha256: "4e1b8024bd1654f89cd99f33a9b098c6bdce65e5217d9098ef04ba21435c7a06",
      },
      {
        name: "PreparedComponentAbiLookup",
        sha256: "2288349eab57e51b261bafea22fbf030d877d1d249a73965d0ab1b761cbbdb5d",
      },
    ],
    retainedCount: 41,
    retainedFunctions: 28,
    retainedSha256: "7645e249fd03cedd881938e7844535d71b333b8679194e7a5d2eaabba6842121",
  },
  {
    old: "src/ir/program-input.ts",
    target: "src/ir/program/input-contracts.ts",
    publicNames: ["TypedIrProgramGlobal", "TypedIrProgramInput", "TypedIrProgramOptions"],
    names: [
      {
        name: "TypedIrProgramGlobal",
        sha256: "2edc5fb6b155321188e05f89ff6ca89041c0ae45df0887f2651eeff5364ed344",
      },
      {
        name: "TypedIrProgramInput",
        sha256: "1dc69663b93552c16a75cac76486906801e697cb33dcc3cfe1201f1717824805",
      },
      {
        name: "TypedIrProgramOptions",
        sha256: "24ee9e020ac9fab2ebd3631983e8d74d842b2fa30182e8d8e8eb5c99906a1356",
      },
    ],
    retainedCount: 6,
    retainedFunctions: 6,
    retainedSha256: "33bb1e427b4290da77315ae6657e146aa87d83ea2d4e0bf0e243f23ef6185bb7",
  },
  {
    old: "src/ir/program.ts",
    target: "src/ir/program/prepared-contracts.ts",
    publicNames: [
      "PreparedIrAbiContract",
      "PreparedIrAbiEntry",
      "PreparedIrAbiSnapshot",
      "PreparedIrProgramProducerInput",
      "PreparedIrProgramFailure",
      "PreparedIrProgramRuntimeProjection",
      "PreparedIrProgram",
      "IrProgramPreparationResult",
      "PreparedIrProgramOwner",
      "PreparedIrSourceLocation",
    ],
    names: [
      {
        name: "PreparedIrAbiContract",
        sha256: "3a8e876d7668b27a9fce1766479963847b1e6093bc309d989c86e06735cc5c71",
      },
      {
        name: "PreparedIrAbiEntry",
        sha256: "e799b68c8cbe4ecb477640c979edba826b1137441033910aba2743aaac4046e7",
      },
      {
        name: "PreparedIrAbiSnapshot",
        sha256: "d81ab0f117652ff0b2afc40fb8e237a85853b9181c344c59e06446fedc1ca70d",
      },
      {
        name: "PreparedIrProgramProducerInput",
        sha256: "3a4def785f999a5eca8bbcf59593b9ed5a7e2503e110302a4fb4f008f197d6d9",
      },
      {
        name: "PreparedIrProgramFailure",
        sha256: "56535f0ffd321db82e8ff8504282b6234ec7faad5ca599fe31b4eaa7a7516887",
      },
      {
        name: "PreparedIrProgramRuntimeProjection",
        sha256: "edb1a346a66a85e338e5d657561a996d38013968b54cd03aa4b3b183efc2f309",
      },
      {
        name: "PreparedIrProgram",
        sha256: "83eff15645a15944208dbc46f9dd83bace7fc7f74fca8fcfdf450568c6381392",
      },
      {
        name: "IrProgramPreparationResult",
        sha256: "31e9252e5d2b2b2d1f631469c20f02636b8e65b529bafe1f7e067d5cac9407ef",
      },
      {
        name: "PreparedIrProgramOwner",
        sha256: "863fe17d562230248bc10d1b05c3aff306f5762968f1b7eaf341f61393244841",
      },
      {
        name: "PreparedIrSourceLocation",
        sha256: "f498383bbd6c665f93533fbb6bb6bf537569da282f3334a0eda952d7b5290a9a",
      },
    ],
    retainedCount: 53,
    retainedFunctions: 13,
    retainedSha256: "0cecfde6532cfec329507200e65f8dde5618e39db095de2cca271eca64b67ae9",
  },
];

function parse(path: string, text = read(path)) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  expect((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics, path).toEqual([]);
  return file;
}

function declarationText(node: ts.Statement): string {
  // A new import-free leaf's first declaration also owns the file header trivia.
  // Strip only that shared license line; all original declaration comments stay.
  return node
    .getFullText()
    .trim()
    .replace(/^\/\/ Copyright[^\n]*\n\s*/, "");
}

function dataDeclarations(file: ts.SourceFile) {
  return file.statements.filter((node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node));
}

function verifyDestination(path: string, text = read(path)) {
  const file = parse(path, text);
  const expected = receipts.filter((row) => row.target === path).flatMap((row) => row.names);
  expect(expected.length).toBeGreaterThan(0);
  const declarations = dataDeclarations(file);
  expect(declarations.map((node) => node.name.text).sort()).toEqual(expected.map((row) => row.name).sort());
  for (const node of file.statements) {
    if (ts.isImportDeclaration(node)) {
      expect(node.importClause?.isTypeOnly, path).toBe(true);
    } else {
      expect(ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node), path).toBe(true);
    }
  }
  for (const row of expected) {
    const declaration = declarations.find((node) => node.name.text === row.name)!;
    expect(digest(declarationText(declaration)), `${path}:${row.name}`).toBe(row.sha256);
  }
  return file;
}

function verifyRetained(row: (typeof receipts)[number], text = read(row.old)) {
  const file = parse(row.old, text);
  const retained = file.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
  expect(retained, row.old).toHaveLength(row.retainedCount);
  expect(retained.filter(ts.isFunctionDeclaration), row.old).toHaveLength(row.retainedFunctions);
  expect(digest(JSON.stringify(retained.map((node) => node.getFullText().trim()))), row.old).toBe(row.retainedSha256);
}

const inputExports = ["TypedIrProgramGlobal", "TypedIrProgramInput", "TypedIrProgramOptions"];
const preparedExports = [
  "PreparedIrAbiContract",
  "PreparedIrAbiEntry",
  "PreparedIrAbiSnapshot",
  "PreparedIrProgramProducerInput",
  "PreparedIrProgramFailure",
  "PreparedIrProgramRuntimeProjection",
  "PreparedIrProgram",
  "IrProgramPreparationResult",
  "PreparedIrProgramOwner",
  "PreparedIrSourceLocation",
];

interface FixtureDiagnostic {
  readonly code: number;
  readonly file?: string;
  readonly start?: number;
  readonly message: string;
}

interface FixtureCompilation {
  readonly configuredRootNames: readonly string[];
  readonly fixtureTexts: readonly (readonly [string, string | undefined])[];
  readonly diagnostics: readonly FixtureDiagnostic[];
}

// Compile in a separate, awaited process: TypeScript's synchronous checker must
// not starve the Vitest worker's RPC event loop. Use the repository's actual
// tsconfig roots, including unimported CodegenContext module augmentations.
// Nothing is emitted, written, stubbed or removed from the diagnostic set.
const compilerFixtureChild = String.raw`
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const { root, entries } = JSON.parse(input);
    if (resolve(process.cwd()) !== root) throw new Error("foreign fixture root");
    const ts = createRequire(resolve(root, "package.json"))("typescript");
    const configPath = resolve(root, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root, undefined, configPath);
    if (!parsed.fileNames.length) throw new Error("empty configured source denominator");
    const sources = new Map(entries);
    const options = {
      ...parsed.options,
      noEmit: true,
      incremental: false,
      tsBuildInfoFile: undefined,
      // The virtual probes are below .tmp, not src. Widen placement only;
      // preserve every repository semantic/checking option and source root.
      rootDir: root,
    };
    const host = ts.createCompilerHost(options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
      const source = sources.get(path);
      return source === undefined
        ? originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(path, source, languageVersion, true);
    };
    const program = ts.createProgram({
      rootNames: [...parsed.fileNames, ...sources.keys()],
      options,
      host,
      projectReferences: parsed.projectReferences,
    });
    const diagnostics = [
      ...(config.error ? [config.error] : []),
      ...parsed.errors,
      ...ts.getPreEmitDiagnostics(program),
    ];
    process.stdout.write(JSON.stringify({
      configuredRootNames: parsed.fileNames,
      fixtureTexts: [...sources.keys()].map(path => [path, program.getSourceFile(path)?.text]),
      diagnostics: diagnostics.map(diagnostic => ({
        code: diagnostic.code,
        file: diagnostic.file?.fileName,
        start: diagnostic.start,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      })),
    }));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
});
`;

async function compileFixtures(sources: ReadonlyMap<string, string>): Promise<FixtureCompilation> {
  return await new Promise((resolveCompilation, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=2048", "--input-type=commonjs", "-e", compilerFixtureChild],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let processError: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      processError = error;
    });
    child.stdin.on("error", (error) => {
      processError ??= error;
    });
    // close, rather than exit, also waits for stdout/stderr to drain. No timed
    // kill: the test awaits the actual terminal result of its sole child.
    child.on("close", (code, signal) => {
      if (processError || code !== 0 || signal !== null) {
        reject(
          new Error(
            `compiler fixture failed (code=${code}, signal=${signal}): ${processError?.message ?? ""}\n${stderr}`,
          ),
        );
        return;
      }
      try {
        resolveCompilation(JSON.parse(stdout) as FixtureCompilation);
      } catch (error) {
        reject(new Error(`invalid compiler fixture report: ${String(error)}\n${stderr}\n${stdout}`));
      }
    });
    child.stdin.end(JSON.stringify({ root, entries: [...sources] }));
  });
}

async function compiledControls() {
  const goodPath = resolve(root, ".tmp/program-data-compatibility-positive.ts");
  const badPath = resolve(root, ".tmp/program-data-compatibility-negative.ts");
  const imports: string[] = [];
  const assertions: string[] = [];
  for (const [index, row] of receipts.entries()) {
    imports.push(`import type * as Old${index} from "../${row.old.replace(/\.ts$/, ".js")}";`);
    imports.push(`import type * as New${index} from "../${row.target.replace(/\.ts$/, ".js")}";`);
    for (const name of row.publicNames) {
      assertions.push(`type Check${index}_${name} = Assert<Equal<Old${index}.${name}, New${index}.${name}>>;`);
    }
  }
  expect(assertions).toHaveLength(40);
  const prelude = `
import type * as Input from "../src/ir/program/input-contracts.js";
import type * as Prepared from "../src/ir/program/prepared-contracts.js";
import type * as Barrel from "../src/ir/program/index.js";
import type * as Core from "../src/ir/core/nodes.js";
import type * as Runtime from "../src/ir/runtime/contracts/prepared.js";
import type * as Identity from "../src/shared/contracts/ir-identity.js";
import type * as Inventory from "../src/shared/contracts/ir-unit-inventory.js";
import type * as Failure from "../src/shared/contracts/ir-preparation-failure.js";
import type * as Callables from "../src/ir/program/callable-bindings.js";
import type * as Lookup from "../src/ir/program/abi-lookup.js";
import type * as Allocations from "../src/ir/analysis/contracts/allocations.js";
import type * as Controls from "../src/ir/program/controls.js";
import type * as Gvn from "../src/ir/passes/contracts/gvn.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
`;
  const good = [
    prelude,
    ...imports,
    ...assertions,
    ...inputExports.map((name) => `type Barrel_${name} = Assert<Equal<Barrel.${name}, Input.${name}>>;`),
    ...preparedExports.map((name) => `type Barrel_${name} = Assert<Equal<Barrel.${name}, Prepared.${name}>>;`),
    `
type BarrelControls = Assert<Equal<Barrel.IrPreparationControls, Controls.IrPreparationControls>>;
type SemanticInput = Assert<Equal<Input.TypedIrProgramInput["ir"], Core.IrModule>>;
type PreparedOutput = Assert<Equal<Prepared.PreparedIrProgram["ir"], Runtime.PreparedIrModule>>;
type PreparedProducer = Assert<Equal<Prepared.PreparedIrProgramProducerInput["ir"], Runtime.PreparedIrModule>>;
type AttachedFunction = Prepared.PreparedIrProgram["ir"]["functions"][number];
type RetainedAttachment = Assert<Equal<AttachedFunction["asyncRuntime"], Runtime.PreparedIrAsyncRuntime | undefined>>;
type SemanticHasNoAttachment = Assert<Equal<"asyncRuntime" extends keyof Core.IrFunction ? true : false, false>>;
type StorageSourceBrand = Assert<Equal<Input.TypedIrProgramGlobal["identity"]["sourceId"], Identity.IrSourceId>>;
type StorageOwnerBrand = Assert<Equal<Input.TypedIrProgramGlobal["identity"]["storageOwnerUnitId"], Identity.IrUnitId>>;
type CallableKinds = Assert<Equal<Callables.IrProgramCallableBindingKind, "source" | "import-alias" | "export-alias">>;
type GvnModes = Assert<Equal<Gvn.IrGvnMode, "off" | "on" | "poison">>;
type ControlKeys = Assert<Equal<keyof Controls.IrPreparationControls, "gvnMode" | "ownership" | "escape" | "verifyIntermediateAllocations" | "verifyDominanceNaive">>;
type NoCounters = Assert<Equal<"counters" extends keyof Input.TypedIrProgramOptions ? true : false, false>>;
type InertSupportOwner = Assert<Equal<Inventory.IrUnownedSupportUnitRecord["terminalOwnerId"], null>>;
type OwnedSupportReason = Assert<Equal<Inventory.IrOwnedSupportUnitRecord["unownedReason"], undefined>>;
type FailureCause = Assert<Equal<Failure.IrPreparationFailure["cause"], unknown>>;
type AllocationMetadata = Assert<Equal<Allocations.AllocRegistryMetadataSnapshot["entries"][number][1], unknown>>;
type AbiUnion = Assert<Equal<Prepared.PreparedIrAbiContract["kind"], "callable" | "global" | "type" | "class" | "export" | "support">>;
type OwnerFields = Assert<Equal<keyof Prepared.PreparedIrProgramOwner, "unitId" | "location" | "sourceFile">>;
type LocationFields = Assert<Equal<keyof Prepared.PreparedIrSourceLocation, "sourceId" | "line" | "column" | "declarationStart" | "declarationEnd">>;
const minimalLookup: Lookup.PreparedComponentAbiLookup = { get: (_id) => undefined };
const fullLookup: Lookup.PreparedComponentAbiLookup = { get: (_id) => undefined, entries: () => [], bindingIdsForStructuralReference: (_key) => [] };
declare const allocationId: Core.AllocSiteId;
const metadata: Allocations.AllocRegistryMetadataSnapshot = { id: allocationId, entries: [["custom", undefined], ["unknown", { future: true }]] };
declare const global: Input.TypedIrProgramGlobal;
const nullableTdz: Input.TypedIrProgramGlobal["binding"]["tdzGlobalRef"] = null;
declare const attached: Runtime.PreparedIrFunction;
const preparedFunction: AttachedFunction = attached;
const semanticFunction: Core.IrFunction = attached;
const unsupported: Failure.IrPreparationFailure = { kind: "unsupported", code: "method-call-unsupported", stage: "verify", detail: "located elsewhere", cause: undefined };
const invariant: Failure.IrPreparationFailure = { kind: "invariant", code: "body-emission-evidence", stage: "patch", detail: "preserved", cause: new Error("sentinel") };
`,
  ].join("\n");
  // These controls intentionally produce diagnostics; each line must fail for
  // its own expected reason. A green empty/missing checker run cannot pass.
  const negatives = [
    [2322, 'const unbranded: Identity.IrUnitId = "unit";'],
    [2322, "declare const sourceId: Identity.IrSourceId; const wrongBrand: Identity.IrUnitId = sourceId;"],
    [2540, "declare const global: Input.TypedIrProgramGlobal; global.binding.type = {kind: 'i32'};"],
    [2322, 'const badReason: Inventory.IrOwnedSupportUnitRecord["unownedReason"] = "no-r0-attempt-root";'],
    [2322, 'const badStage: Extract<Failure.IrPreparationFailure, {kind: "invariant"}>["stage"] = "select";'],
    [2322, 'const badMode: Gvn.IrGvnMode = "auto";'],
    [2339, 'type MissingSemanticAttachment = Core.IrFunction["asyncRuntime"];'],
    [2322, 'const droppedAttachment: Assert<Equal<Prepared.PreparedIrProgram["ir"], Core.IrModule>> = true;'],
    [2305, 'import type { ProgramAbiMap } from "../src/ir/program/index.js";'],
    [2724, 'import type { AcceptedPreparedIrProgram } from "../src/ir/program/index.js";'],
    [2724, 'import type { IrUnitRecordBase } from "../src/shared/contracts/ir-unit-inventory.js";'],
    [2307, 'import type { Missing } from "../src/ir/program/missing-program-data-contract.js";'],
  ] as const;
  const bad = prelude + "\n" + negatives.map(([, source]) => source).join("\n");
  const sources = new Map([
    [goodPath, good],
    [badPath, bad],
  ]);
  const report = await compileFixtures(sources);
  expect(report.configuredRootNames).toContain(resolve(root, "src/codegen/ir-program-callable-context.ts"));
  expect(report.configuredRootNames).toContain(resolve(root, "src/ir/program-callable-selection.ts"));
  expect(report.fixtureTexts).toEqual([...sources]);
  const diagnostics = report.diagnostics;
  const print = (diagnostic: FixtureDiagnostic) =>
    `${diagnostic.file ?? "<configuration>"}:${diagnostic.start ?? 0} TS${diagnostic.code}: ${diagnostic.message}`;
  expect(diagnostics.filter((diagnostic) => diagnostic.file !== badPath).map(print)).toEqual([]);
  const rejected = diagnostics.filter((diagnostic) => diagnostic.file === badPath);
  for (const [expectedCode, source] of negatives) {
    const start = bad.indexOf(source);
    expect(start).toBeGreaterThan(-1);
    const matches = rejected.filter(
      (diagnostic) => diagnostic.start! >= start && diagnostic.start! < start + source.length,
    );
    expect(
      matches.map((diagnostic) => diagnostic.code),
      `${source}: ${matches.map(print).join("; ")}`,
    ).toContain(expectedCode);
  }
  expect(new Set(rejected.map((diagnostic) => diagnostic.start)).size).toBeGreaterThanOrEqual(negatives.length);
}

describe("connected program-data declaration seam", () => {
  it("pins the complete 41-declaration, 40-public-name, ten-owner extraction", () => {
    expect(receipts).toHaveLength(10);
    expect(receipts.flatMap((row) => row.names)).toHaveLength(41);
    expect(receipts.flatMap((row) => row.publicNames)).toHaveLength(40);
    expect(new Set(receipts.map((row) => row.target)).size).toBe(9);
    expect(receipts.reduce((count, row) => count + row.retainedCount, 0)).toBe(560);
    expect(receipts.reduce((count, row) => count + row.retainedFunctions, 0)).toBe(374);
  });

  it.each([...new Set(receipts.map((row) => row.target))])("preserves exact declarations and docs in %s", (path) => {
    verifyDestination(path);
  });

  it.each(receipts)("preserves every retained statement in $old", (row) => {
    verifyRetained(row);
  });

  it.each(receipts)("keeps explicit old-path compatibility exports in $old", (row) => {
    const file = parse(row.old);
    const movedNames = row.names.map((declaration) => declaration.name);
    expect(dataDeclarations(file).filter((node) => movedNames.includes(node.name.text))).toEqual([]);
    const found: string[] = [];
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause))
        continue;
      for (const binding of statement.exportClause.elements) {
        if (!row.publicNames.includes(binding.name.text)) continue;
        expect(statement.isTypeOnly).toBe(true);
        expect(binding.propertyName).toBeUndefined();
        expect(statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        expect(resolve(root, row.old, "..", specifier).replace(/\.js$/, ".ts")).toBe(resolve(root, row.target));
        found.push(binding.name.text);
      }
    }
    expect(found.sort()).toEqual([...row.publicNames].sort());
  });

  it("exports exactly three input, one controls and ten prepared types, with no runtime authority", () => {
    const file = parse("src/ir/program/index.ts");
    expect(file.statements).toHaveLength(3);
    const expected = new Map([
      ["./input-contracts.js", inputExports],
      ["./controls.js", ["IrPreparationControls"]],
      ["./prepared-contracts.js", preparedExports],
    ]);
    for (const statement of file.statements) {
      expect(ts.isExportDeclaration(statement)).toBe(true);
      if (!ts.isExportDeclaration(statement)) throw new Error("non-export in data barrel");
      expect(statement.isTypeOnly).toBe(true);
      expect(statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
      expect(statement.exportClause && ts.isNamedExports(statement.exportClause)).toBe(true);
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause))
        throw new Error("non-explicit data export");
      const names = expected.get((statement.moduleSpecifier as ts.StringLiteral).text);
      expect(names).toBeDefined();
      expect(statement.exportClause.elements.map((binding) => binding.name.text)).toEqual(names);
    }
  });

  it.each([
    ["missing declaration", (text: string) => text.replace(/export interface TypedIrProgramOptions[\s\S]*?\n}/, "")],
    ["changed readonly field", (text: string) => text.replace("readonly inventory:", "inventory:")],
    [
      "changed documentation",
      (text: string) => text.replace("Only semantic storage facts", "Other semantic storage facts"),
    ],
    ["extra runtime authority", (text: string) => text + "\nexport class ProgramAbiMap {}\n"],
    ["malformed declaration", (text: string) => text + "\nexport interface Broken {\n"],
  ] as const)("rejects a %s in the declaration detector", (_label, change) => {
    const path = "src/ir/program/input-contracts.ts";
    verifyDestination(path);
    const original = read(path);
    expect(change(original)).not.toBe(original);
    expect(() => verifyDestination(path, change(original))).toThrow();
  });

  it("detects a changed retained ownership algorithm", () => {
    const row = receipts.find((entry) => entry.old === "src/ir/program.ts")!;
    verifyRetained(row);
    const original = read(row.old);
    const changed = original.replace("if (!owner) return undefined;", "if (owner) return undefined;");
    expect(changed).not.toBe(original);
    expect(() => verifyRetained(row, changed)).toThrow();
  });

  it("actually compiles old/new identities, attachment joins and positive/negative type controls", async () => {
    await compiledControls();
  }, 180_000);
});
