// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { c1AuthorityManifestSha256 } from "./ir-c1-authority-root.js";

export type C1HistoricalLogicalPath =
  | "src/codegen-linear/index.ts"
  | "tests/issue-3518-runtime-program-relocation.test.ts"
  | "tests/issue-3518-program-data-contract-seam.test.ts"
  | "tests/issue-3518-program-ownership-runtime-seam.test.ts"
  | "tests/issue-3518-program-pre-a-evolution.test.ts"
  | "tests/issue-3518-program-initial-graph-evolution.test.ts"
  | "tests/helpers/ir-runtime-program-policy-evolution.ts";

export interface C1Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
export interface C1PathPin {
  readonly path: string;
  readonly pin: C1Pin;
}
export type C1LinearBinding =
  | {
      readonly kind: "named-import";
      readonly localName: string;
      readonly importedName: string;
      readonly module: string;
      readonly targetPath: string;
      readonly clauseTypeOnly: boolean;
      readonly specifierTypeOnly: boolean;
    }
  | {
      readonly kind: "import-type";
      readonly qualifier: "OracleBackend";
      readonly module: "../checker/oracle-backend.js";
      readonly targetPath: "src/checker/oracle-backend.ts";
    };
export interface C1ResolverRequest {
  readonly containingFile: string;
  readonly module: string;
  readonly target: C1ResolverLocation;
}
export interface C1ResolverLocation {
  readonly scope: "repository" | "typescript-package";
  readonly path: string;
}
export type C1ResolverObservation =
  | {
      readonly operation: "readFile";
      readonly location: C1ResolverLocation;
      readonly pin: C1Pin;
    }
  | {
      readonly operation: "fileExists" | "directoryExists";
      readonly location: C1ResolverLocation;
      readonly exists: boolean;
    }
  | {
      readonly operation: "realpath";
      readonly location: C1ResolverLocation;
      readonly target: C1ResolverLocation;
    };
export interface C1LinearOptionsContract {
  readonly sourcePath: "src/codegen-linear/index.ts";
  readonly declaration: {
    readonly kind: "InterfaceDeclaration";
    readonly name: "LinearOptions";
    readonly exported: true;
    readonly typeParameterCount: 0;
    readonly heritageClauseCount: 0;
    readonly span: "getStart-to-end-utf8";
    readonly pin: C1Pin;
  };
  readonly bindings: readonly C1LinearBinding[];
  readonly closureInputs: readonly C1PathPin[];
  readonly resolver: {
    readonly configInputs: readonly C1PathPin[];
    readonly optionsSource: "tsconfig.json";
    readonly optionsSha256: string;
    readonly requests: readonly C1ResolverRequest[];
    readonly observations: readonly C1ResolverObservation[];
  };
}
export interface C1HistoricalCapture {
  readonly linearOptions: C1LinearOptionsContract;
  readonly readHistorical: (logical: C1HistoricalLogicalPath) => string;
}

export interface C1PopulationContract {
  readonly receiptPath: "tests/helpers/ir-runtime-program-relocation.json";
  readonly receiptSha256: "aeeae92fa9c31d8d7ae6aa8805c91862cb1fa2b79486fa4d69cce29d7d065763";
  readonly currentPaths: readonly string[];
  readonly dependencyPaths: readonly string[];
  readonly donorPairs: readonly (readonly [string, string])[];
  readonly transferCount: 91;
  readonly movedCount: 12;
  readonly retainedCount: 79;
}

type AuthorityReader = (path: string) => string;
type Data = Record<string, unknown>;
const manifestPath = "tests/helpers/ir-c1-authority.json";
const anchorPath = "tests/helpers/ir-c1-authority-root.ts";
const historicalBase = "bfcf326c9426988e66fa6cc446132ed9ad9c1965";
const currentBase = "3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8";
const artifacts = [
  {
    logicalPath: "src/codegen-linear/index.ts",
    artifactPath: "tests/fixtures/issue-3518-c1-historical-authority/linear-index.ts.txt",
    pin: {
      bytes: 224418,
      sha256: "c4648365cfa0fa4526ea64e76cd72b932998a09a4056a8321384b7ef62abbbae",
      gitBlob: "9f573d33589ec51a39d2939ada4743eb9651881f",
    },
    purpose: "historical-dependency",
  },
  {
    logicalPath: "tests/issue-3518-runtime-program-relocation.test.ts",
    artifactPath: "tests/fixtures/issue-3518-c1-historical-authority/runtime-program-relocation.test.ts.txt",
    pin: {
      bytes: 21449,
      sha256: "324fa026106c484167f6631158043bf16298d07d6f82f1136808fa07054dcc6b",
      gitBlob: "3b90e68bbc2baa5c07305a5c5bc64e536f9cf9b8",
    },
    purpose: "historical-caller",
  },
  {
    logicalPath: "tests/issue-3518-program-data-contract-seam.test.ts",
    artifactPath: "tests/fixtures/issue-3518-c1-historical-authority/program-data-contract-seam.test.ts.txt",
    pin: {
      bytes: 35973,
      sha256: "84f249d70f2546cb9ac025f72c7817d5d58e4950c00691fd585caba7bd0cffda",
      gitBlob: "275e1e1b6760719720d040ff4ebe0813efc5e7d8",
    },
    purpose: "historical-caller",
  },
  {
    logicalPath: "tests/issue-3518-program-ownership-runtime-seam.test.ts",
    artifactPath: "tests/fixtures/issue-3518-c1-historical-authority/program-ownership-runtime-seam.test.ts.txt",
    pin: {
      bytes: 36546,
      sha256: "66dfa1235ce24d821a9530a5c3531b56eef2817033d89f0d3e8109f9ead13220",
      gitBlob: "858c8395d3d4d4c3ae3a912b64cb2a53f568475b",
    },
    purpose: "historical-caller",
  },
  {
    logicalPath: "tests/issue-3518-program-pre-a-evolution.test.ts",
    artifactPath: "tests/fixtures/issue-3518-c1-historical-authority/program-pre-a-evolution.test.ts.txt",
    pin: {
      bytes: 17640,
      sha256: "0ee5b4d09d0efd9bd5f084fde4fb87bf316ad4aae85867c30d9903cce9353068",
      gitBlob: "f59d61d925a7c29d770b3e2c82cb3c4f49570644",
    },
    purpose: "historical-caller",
  },
  {
    logicalPath: "tests/issue-3518-program-initial-graph-evolution.test.ts",
    artifactPath: "tests/fixtures/issue-3518-c1-historical-authority/program-initial-graph-evolution.test.ts.txt",
    pin: {
      bytes: 24556,
      sha256: "44f5ac79766e9046aa4ed3ccc32c5e609209d0000ffe4d7b06d9afcc8049c2e6",
      gitBlob: "b776f75396a99c2b0a4b94b1c989b9c85a298c14",
    },
    purpose: "historical-caller",
  },
  {
    logicalPath: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    artifactPath: "tests/fixtures/issue-3518-c1-historical-authority/runtime-program-policy-evolution.ts.txt",
    pin: {
      bytes: 93405,
      sha256: "e243101b31f29b2b4aa2637fdd3f9c814a5b6bada558ce565d3d3c132e71892f",
      gitBlob: "2c3781d77ada0953993a57ebe3ce7316c9324e07",
    },
    purpose: "historical-policy-prefix",
  },
] as const;
const immutableAuthorities = [
  {
    path: "tests/helpers/ir-runtime-program-relocation.ts",
    pin: {
      bytes: 19615,
      sha256: "6be4b992fb5a3aafab89112e7f3a4dfcacb67ad7f53edb1c99a17fe55c7c5141",
      gitBlob: "fcccc8b7bfaefe8844f8d3eda19612f2dc087cc7",
    },
  },
  {
    path: "tests/helpers/ir-runtime-program-relocation.json",
    pin: {
      bytes: 680099,
      sha256: "aeeae92fa9c31d8d7ae6aa8805c91862cb1fa2b79486fa4d69cce29d7d065763",
      gitBlob: "e241d372cc2daf18bc23cc0d1ba001e55fb23c62",
    },
  },
  {
    path: "tests/helpers/ir-validation-policy-evolution.ts",
    pin: {
      bytes: 11095,
      sha256: "a962c04960b945705e9ac5a354da3e96c8e0cf5543382847231dd3df9204fb40",
      gitBlob: "e87bca78dd15e16ee7d9fb9b86caeff327d0c076",
    },
  },
  {
    path: "tests/helpers/ir-validation-policy-evolution.json",
    pin: {
      bytes: 51450,
      sha256: "39dacc9d17fb52b6a369ed81d7498afc30b00bc06d89362bba039305aa96fa0e",
      gitBlob: "dc2c5f2f32d607b3bf6732c89711d058d2f9b4d6",
    },
  },
  {
    path: "tests/helpers/ir-runtime-program-policy-evolution.json",
    pin: {
      bytes: 6804,
      sha256: "8e2589e90fbc697dceba56e1bbe53447250a94f3bcb03d99317ad4878bc1f58c",
      gitBlob: "e762f3159a2756477cb87d412483d4f3709f2b61",
    },
  },
  {
    path: "tests/helpers/ir-runtime-program-policy-well-known-symbols.json",
    pin: {
      bytes: 9470,
      sha256: "5b28556311bb1548e3fb399fc8dee458fcec60f0d5366714e6298af123b73a61",
      gitBlob: "e48472b1abefd4531b0e8d79193f3f95b40c3eca",
    },
  },
  {
    path: "tests/helpers/ir-runtime-program-policy-number-prerequisites.json",
    pin: {
      bytes: 12726,
      sha256: "92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845",
      gitBlob: "f603d3bee621e18faec594ebe776c8f540029017",
    },
  },
  {
    path: "tests/helpers/ir-runtime-program-policy-runtime-preparation.json",
    pin: {
      bytes: 6239,
      sha256: "3ebfca62d268ca5bcc8b1c461ef6e71b55bd513a5649bf6bce3fe6ee689032ca",
      gitBlob: "167136d1f4ffeb6ca938573ae6bc460d04babd94",
    },
  },
  {
    path: "tests/helpers/ir-runtime-program-policy-dynamic-code.json",
    pin: {
      bytes: 6159,
      sha256: "785ef0a740ac17ba636bb75b15cf4eed2266ac4ca0ec588e1eb4cff3642a708f",
      gitBlob: "4a63f349277bb69ac595ff9e13cd299f0839fce8",
    },
  },
  {
    path: "tests/helpers/ir-runtime-program-policy-host-carrier.json",
    pin: {
      bytes: 4673,
      sha256: "30c0912d7868e4da44c083243bb68073e48e70e7eb4b26dbc1b1e73090a5f583",
      gitBlob: "e355f998d680b09ca5e221900021740970ec20a0",
    },
  },
  {
    path: "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json",
    pin: {
      bytes: 4693,
      sha256: "5d78bc26201d43531d1a299d42f0ac0ae91a638de71620b94f675378572ccc8c",
      gitBlob: "e1ceeb12d63073f2f19b714c4e988dd3e2b4e26d",
    },
  },
] as const;
const beforeInstruments = [
  {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    pin: {
      bytes: 93405,
      sha256: "e243101b31f29b2b4aa2637fdd3f9c814a5b6bada558ce565d3d3c132e71892f",
      gitBlob: "2c3781d77ada0953993a57ebe3ce7316c9324e07",
    },
  },
  {
    path: "tests/issue-3518-program-data-contract-boundary.test.ts",
    pin: {
      bytes: 28535,
      sha256: "cd1938063fa11485d4ec15fd260aeb3e65b6fa7a220e46932978f7a06528b8e0",
      gitBlob: "7e22a6829277d6475df4714de8d48ad2e76e3ada",
    },
  },
  {
    path: "tests/issue-3518-program-data-contract-seam.test.ts",
    pin: {
      bytes: 35973,
      sha256: "84f249d70f2546cb9ac025f72c7817d5d58e4950c00691fd585caba7bd0cffda",
      gitBlob: "275e1e1b6760719720d040ff4ebe0813efc5e7d8",
    },
  },
  {
    path: "tests/issue-3518-program-ownership-runtime-seam.test.ts",
    pin: {
      bytes: 36546,
      sha256: "66dfa1235ce24d821a9530a5c3531b56eef2817033d89f0d3e8109f9ead13220",
      gitBlob: "858c8395d3d4d4c3ae3a912b64cb2a53f568475b",
    },
  },
  {
    path: "tests/issue-3518-program-pre-a-evolution.test.ts",
    pin: {
      bytes: 17640,
      sha256: "0ee5b4d09d0efd9bd5f084fde4fb87bf316ad4aae85867c30d9903cce9353068",
      gitBlob: "f59d61d925a7c29d770b3e2c82cb3c4f49570644",
    },
  },
  {
    path: "tests/issue-3518-program-initial-graph-evolution.test.ts",
    pin: {
      bytes: 24556,
      sha256: "44f5ac79766e9046aa4ed3ccc32c5e609209d0000ffe4d7b06d9afcc8049c2e6",
      gitBlob: "b776f75396a99c2b0a4b94b1c989b9c85a298c14",
    },
  },
  {
    path: "tests/issue-3518-runtime-program-relocation.test.ts",
    pin: {
      bytes: 21449,
      sha256: "324fa026106c484167f6631158043bf16298d07d6f82f1136808fa07054dcc6b",
      gitBlob: "3b90e68bbc2baa5c07305a5c5bc64e536f9cf9b8",
    },
  },
  {
    path: "tests/issue-3518-runtime-program-policy-evolution.test.ts",
    pin: {
      bytes: 23017,
      sha256: "ef8c3253054203d0576aa0029ce86baee73d8d4a4c639901fc83e936ed4f62da",
      gitBlob: "27cdb3a1209d874b401e7de30b0bd7e731bdff6c",
    },
  },
  {
    path: "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",
    pin: {
      bytes: 25860,
      sha256: "a93174185368356b0be2527e3f253fc49cc31e01cd8bbd4ba6cb2431bb66e831",
      gitBlob: "65873b916d8cfd49804377d0e5045f2e77ee5fe9",
    },
  },
  {
    path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
    pin: {
      bytes: 102608,
      sha256: "ada05306b0868fc4fcf6c9816042bc4cfeca00a1fef8fec68d85e95622474e34",
      gitBlob: "924eadef80e2aa3936c895f3d39d42973e1537b5",
    },
  },
] as const;
const population = {
  receiptPath: "tests/helpers/ir-runtime-program-relocation.json",
  receiptSha256: "aeeae92fa9c31d8d7ae6aa8805c91862cb1fa2b79486fa4d69cce29d7d065763",
  currentPaths: [
    "src/ir/program.ts",
    "src/ir/program/owner.ts",
    "src/ir/program-abi-contracts.ts",
    "src/ir/program/draft-abi-lookup.ts",
    "src/ir/prepared-component-dependencies.ts",
    "src/ir/program/runtime-support-dependencies.ts",
    "src/ir/generator-support.ts",
    "src/ir/runtime/generator-support.ts",
  ],
  dependencyPaths: [
    "src/codegen-linear/index.ts",
    "src/ir/abi-bindings.ts",
    "src/ir/backend/legality.ts",
    "src/ir/callable-bindings.ts",
    "src/ir/capability-abi-validation.ts",
    "src/ir/core/callable-bindings.ts",
    "src/ir/core/nodes.ts",
    "src/ir/core/type-binding-keys.ts",
    "src/ir/core/types.ts",
    "src/ir/core/value-references.ts",
    "src/ir/identity-values.ts",
    "src/ir/identity.ts",
    "src/ir/nodes.ts",
    "src/ir/prepared-component-ownership.ts",
    "src/ir/prepared-instruction-support.ts",
    "src/ir/program-abi.ts",
    "src/ir/program-callable-contract.ts",
    "src/ir/program-runtime-abi.ts",
    "src/ir/program-validation.ts",
    "src/ir/program/abi-lookup.ts",
    "src/ir/program/abi-signatures.ts",
    "src/ir/program/abi.ts",
    "src/ir/program/callable-bindings.ts",
    "src/ir/program/data.ts",
    "src/ir/program/errors.ts",
    "src/ir/program/formatter-support.ts",
    "src/ir/program/input-contracts.ts",
    "src/ir/program/prepared-contracts.ts",
    "src/ir/program/runtime-support.ts",
    "src/ir/program/startup.ts",
    "src/ir/runtime-callable-declarations.ts",
    "src/ir/runtime-manifest.ts",
    "src/ir/runtime/contracts/prepared.ts",
    "src/ir/runtime/native-async-callables.ts",
    "src/ir/string-runtime.ts",
    "src/ir/types.ts",
    "src/shared/contracts/ir-identity.ts",
    "src/shared/contracts/ir-unit-inventory.ts",
  ],
  donorPairs: [
    ["src/ir/program.ts", "src/ir/program/owner.ts"],
    ["src/ir/program-abi-contracts.ts", "src/ir/program/draft-abi-lookup.ts"],
    ["src/ir/prepared-component-dependencies.ts", "src/ir/program/runtime-support-dependencies.ts"],
    ["src/ir/generator-support.ts", "src/ir/runtime/generator-support.ts"],
  ],
  transferCount: 91,
  movedCount: 12,
  retainedCount: 79,
} as const;
const predecessorClosureInputs = [
  {
    path: "src/ir/identity.ts",
    pin: {
      bytes: 61452,
      sha256: "ac9bcf913f1bbe4358f020307b3fd25b47c0fac26be88dfde449ba1d33694e44",
      gitBlob: "4a47d555bb511e921e2e9fd70902fa9275d3329a",
    },
  },
  {
    path: "src/ir/analysis/linear-memory-plan.ts",
    pin: {
      bytes: 52704,
      sha256: "382cb4acee2de86904da1c0162ecc8b9de4250f9f9cb49dcba57b1a056c1cc3c",
      gitBlob: "ae6f9ab03e01c80622e56a69c5b05c6826366d69",
    },
  },
  {
    path: "src/checker/oracle-backend.ts",
    pin: {
      bytes: 12541,
      sha256: "870ae53149999324e1a71e6f1b818c139e2710d92ffcd4a78f42317becb58d60",
      gitBlob: "1f3d24ed9bb8d07dcbfe5d7a88c16d7059160d93",
    },
  },
  {
    path: "src/codegen-linear/c-abi.ts",
    pin: {
      bytes: 26965,
      sha256: "fba055c0a5ed1b823b1bb8644c5cb495e0b26bb087bf36b5d746efda708fb308",
      gitBlob: "37eb30e8691a7e30033c74bc03bd386dc08e9d49",
    },
  },
  {
    path: "src/codegen-linear/refcount/ownership.ts",
    pin: {
      bytes: 12067,
      sha256: "35a3de8fc817744c5465444e7057652b508c8c8c099d0389a06ee4182fa061e6",
      gitBlob: "1f82b3498530a5e7c262b6d2f8aa024605c24d96",
    },
  },
  {
    path: "src/ir/types.ts",
    pin: {
      bytes: 7744,
      sha256: "d82e92ee276dd9a57bd69d9dee16410d24225a028bd9dca53bc406f69b9623ac",
      gitBlob: "f7717d7c70bb57bd73d799a1d26d1825aa0a41e8",
    },
  },
  {
    path: "src/wasm/model/instructions.ts",
    pin: {
      bytes: 14904,
      sha256: "b305b96583e473272f26032cd1e4ad4653a32d4f56db74df50dac7f1c2461b6d",
      gitBlob: "699c7b386f529b6017659a2f4b0f3c5671235969",
    },
  },
  {
    path: "src/position-map.ts",
    pin: {
      bytes: 6306,
      sha256: "18e228f204079171a28bfc763514fe54aa30030b3e1529dae706f86488b0aecb",
      gitBlob: "a79a6f460eae2d51028e1eef673b3f7b363ae243",
    },
  },
  {
    path: "src/shared/contracts/source-origin.ts",
    pin: {
      bytes: 689,
      sha256: "cc8e05036afdaca04c3e7055ad22f82c57f6e2e31b7e49a69e9081823c2eacde",
      gitBlob: "7d9e62164db0594b761ea88eac9a07ac2d142f73",
    },
  },
  {
    path: "src/shared/contracts/ir-unit-inventory.ts",
    pin: {
      bytes: 4708,
      sha256: "f6f253cefa3b4618bd5f2daf2555b6c0d734a715f2dd44a30a83921c0d9b6496",
      gitBlob: "e7f088edffda5ef76b726b6786341e5bcc744078",
    },
  },
  {
    path: "src/ts-api.ts",
    pin: {
      bytes: 13456,
      sha256: "0b717e14e79b0378e1f350cd23953a63a8df772816c10d9232f36ad54716cc57",
      gitBlob: "703ba16ec711d51d26696f76d9b0c34bd28d1d24",
    },
  },
  {
    path: "src/frontend/typescript.ts",
    pin: {
      bytes: 213,
      sha256: "9ac41b7a2454026a43ecd3a4358405cfe79d613902680909a30e1b0fe5f0a915",
      gitBlob: "31601e20682fee617baef9eb35ff68a8ce981332",
    },
  },
] as const;
// Fixed current epoch binds the audited instructions input and exact layout-declaration successor.
const closureInputs = predecessorClosureInputs.map((entry) =>
  entry.path === "src/ir/analysis/linear-memory-plan.ts"
    ? {
        path: entry.path,
        pin: {
          bytes: 49040,
          sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
          gitBlob: "a44148b86cf60d75a8ebcd9decd2f0fc3a5aad1c",
        },
      }
    : entry.path === "src/wasm/model/instructions.ts"
      ? {
          path: entry.path,
          pin: {
            bytes: 15135,
            sha256: "8c4c9a27c00e57caafe29e64f465b49b6ab13d77744d9d071b80609bb65d4360",
            gitBlob: "d3c10d8a8e4c1ecd45d2a7c13e372daa8ae378d0",
          },
        }
      : entry.path === "src/ir/types.ts"
        ? {
            path: entry.path,
            pin: {
              bytes: 7756,
              sha256: "0282ae61c6a43f837a9a3c7b12d879151e67ec155939c541cd9b5ea662979140",
              gitBlob: "bdf9d6ace5f7f5530373cea6007a1ad7dfe905d0",
            },
          }
        : entry.path === "src/shared/contracts/source-origin.ts"
          ? {
              path: entry.path,
              pin: {
                bytes: 719,
                sha256: "cb199a6040c361256dc244d4e4e8183490524a0ee9505920a660e34eea3cc9b4",
                gitBlob: "d6d98de15c656d3ecb32653b447b31486d3b9f05",
              },
            }
          : entry,
);
const linearDeclarationPin = {
  bytes: 1633,
  sha256: "5294c0fce2be6c6974b61a3686c05e60aa66d5bb4599fc97cb315ee53cab71be",
  gitBlob: "8c594e598e0d946ed92fd658cbe2efe3063ca2c4",
} as const;
const currentInstrumentPaths = [
  "tests/helpers/ir-c1-historical-authority.ts",
  "tests/helpers/ir-c1-current-source.ts",
  ...beforeInstruments.map((record) => record.path),
] as const;
const linearBindings = [
  {
    kind: "named-import",
    localName: "BuildIrUnitInventoryOptions",
    importedName: "BuildIrUnitInventoryOptions",
    module: "../ir/identity.js",
    targetPath: "src/ir/identity.ts",
    clauseTypeOnly: true,
    specifierTypeOnly: false,
  },
  {
    kind: "named-import",
    localName: "LinearAllocatorPolicyId",
    importedName: "LinearAllocatorPolicyId",
    module: "../ir/analysis/linear-memory-plan.js",
    targetPath: "src/ir/analysis/linear-memory-plan.ts",
    clauseTypeOnly: false,
    specifierTypeOnly: true,
  },
  {
    kind: "named-import",
    localName: "ExternCImportSpec",
    importedName: "ExternCImportSpec",
    module: "./c-abi.js",
    targetPath: "src/codegen-linear/c-abi.ts",
    clauseTypeOnly: false,
    specifierTypeOnly: true,
  },
  {
    kind: "import-type",
    qualifier: "OracleBackend",
    module: "../checker/oracle-backend.js",
    targetPath: "src/checker/oracle-backend.ts",
  },
] as const;

const readActual: AuthorityReader = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
function fail(detail: string): never {
  throw new Error("C1 historical authority: " + detail);
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function measured(text: string): C1Pin {
  const encoded = Buffer.from(text, "utf8");
  const bytes = encoded.length;
  return {
    bytes,
    sha256: createHash("sha256").update(encoded).digest("hex"),
    gitBlob: createHash("sha1").update(`blob ${bytes}\0`).update(encoded).digest("hex"),
  };
}
function keys(value: unknown, expected: readonly string[], label: string): Data {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !same(Reflect.ownKeys(value), expected)
  )
    fail("exact object keys: " + label);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) fail("non-data property: " + label);
  }
  return value as Data;
}
function array(value: unknown, label: string): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !same(Reflect.ownKeys(value), [...value.keys()].map(String).concat("length"))
  )
    fail("plain array: " + label);
  return value;
}
function safePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    !/^[A-Za-z0-9_@.+/-]+$/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("canonical path: " + label);
  return value;
}
function validatePin(value: unknown, label: string): C1Pin {
  const p = keys(value, ["bytes", "sha256", "gitBlob"], label);
  if (
    !Number.isSafeInteger(p.bytes) ||
    (p.bytes as number) < 0 ||
    typeof p.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.sha256) ||
    typeof p.gitBlob !== "string" ||
    !/^[a-f0-9]{40}$/.test(p.gitBlob)
  )
    fail("pin: " + label);
  return p as unknown as C1Pin;
}
function validatePathPin(value: unknown, label: string): C1PathPin {
  const record = keys(value, ["path", "pin"], label);
  safePath(record.path, label);
  validatePin(record.pin, label);
  return record as unknown as C1PathPin;
}
function readText(read: AuthorityReader, path: string): string {
  const text = read(path);
  if (typeof text !== "string") fail("primitive source text: " + path);
  return text;
}
function requirePin(text: string, expected: C1Pin, label: string): void {
  if (!same(measured(text), expected)) fail("full-file pin changed: " + label);
}
// Digest checks precede this strict duplicate-key census; JSON.parse alone loses duplicate keys.
function parseJson(text: string, label: string): unknown {
  let at = 0;
  const whitespace = () => {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++]!;
      if (ch === "\\") at++;
      else if (ch === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    fail("unterminated JSON string: " + label);
  };
  const value = (depth: number): void => {
    if (depth > 128) fail("JSON depth: " + label);
    whitespace();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{") {
      at++;
      whitespace();
      const seen = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      for (;;) {
        whitespace();
        if (text[at] !== '"') fail("JSON object key: " + label);
        const key = string();
        if (seen.has(key)) fail("duplicate JSON key: " + label);
        seen.add(key);
        whitespace();
        if (text[at++] !== ":") fail("JSON object separator: " + label);
        value(depth + 1);
        whitespace();
        const end = text[at++];
        if (end === "}") return;
        if (end !== ",") fail("JSON object terminator: " + label);
      }
    }
    if (text[at] === "[") {
      at++;
      whitespace();
      if (text[at] === "]") {
        at++;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        const end = text[at++];
        if (end === "]") return;
        if (end !== ",") fail("JSON array terminator: " + label);
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!token) fail("JSON token: " + label);
    at += token[0].length;
  };
  value(0);
  whitespace();
  if (at !== text.length) fail("JSON trailing input: " + label);
  return JSON.parse(text) as unknown;
}
function detachedFrozen<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (v: unknown): void => {
    if (v !== null && typeof v === "object") {
      for (const item of Object.values(v)) freeze(item);
      Object.freeze(v);
    }
  };
  freeze(copy);
  return copy;
}
function location(value: unknown, label: string, allowRoot = false): C1ResolverLocation {
  const record = keys(value, ["scope", "path"], label);
  if (record.scope !== "repository" && record.scope !== "typescript-package") fail("resolver root: " + label);
  if (!(allowRoot && record.path === "")) safePath(record.path, label);
  return record as unknown as C1ResolverLocation;
}
function validateLinearOptions(value: unknown): C1LinearOptionsContract {
  const contract = keys(value, ["sourcePath", "declaration", "bindings", "closureInputs", "resolver"], "linearOptions");
  if (contract.sourcePath !== "src/codegen-linear/index.ts") fail("linear source domain");
  const declaration = keys(
    contract.declaration,
    ["kind", "name", "exported", "typeParameterCount", "heritageClauseCount", "span", "pin"],
    "linear declaration",
  );
  validatePin(declaration.pin, "linear declaration");
  if (
    !same(declaration, {
      kind: "InterfaceDeclaration",
      name: "LinearOptions",
      exported: true,
      typeParameterCount: 0,
      heritageClauseCount: 0,
      span: "getStart-to-end-utf8",
      pin: linearDeclarationPin,
    })
  )
    fail("fixed linear declaration contract");
  const bindings = array(contract.bindings, "bindings");
  if (!same(bindings, linearBindings)) fail("fixed binding population");
  for (const binding of bindings) {
    const named = (binding as Data).kind === "named-import";
    keys(
      binding,
      named
        ? ["kind", "localName", "importedName", "module", "targetPath", "clauseTypeOnly", "specifierTypeOnly"]
        : ["kind", "qualifier", "module", "targetPath"],
      "linear binding",
    );
  }
  const closure = array(contract.closureInputs, "closure inputs");
  closure.forEach((record) => validatePathPin(record, "closure input"));
  if (!same(closure, closureInputs)) fail("fixed closure input population");
  const resolver = keys(
    contract.resolver,
    ["configInputs", "optionsSource", "optionsSha256", "requests", "observations"],
    "resolver",
  );
  const configs = array(resolver.configInputs, "config inputs");
  configs.forEach((record) => validatePathPin(record, "config input"));
  if (
    !same(
      configs.map((record) => (record as Data).path),
      ["tsconfig.json", "package.json", "pnpm-lock.yaml"],
    ) ||
    resolver.optionsSource !== "tsconfig.json" ||
    typeof resolver.optionsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(resolver.optionsSha256)
  )
    fail("fixed resolver configuration");
  validateResolverTopology(resolver);
  return contract as unknown as C1LinearOptionsContract;
}
function validateInstrumentEdits(value: unknown, instruments: readonly C1PathPin[]): void {
  const edits = array(value, "instrument edits");
  if (edits.length !== beforeInstruments.length) fail("instrument edit count");
  for (const [index, value] of edits.entries()) {
    const edit = keys(value, ["path", "beforePin", "afterPin", "spans"], "instrument edit"),
      before = beforeInstruments[index]!;
    if (
      edit.path !== before.path ||
      !same(validatePin(edit.beforePin, "before instrument"), before.pin) ||
      !same(validatePin(edit.afterPin, "after instrument"), instruments[index + 2]!.pin)
    )
      fail("instrument edit domain");
    const spans = array(edit.spans, "edit spans");
    if (!spans.length) fail("missing edit spans");
    let beforeEnd = 0,
      afterEnd = 0,
      previousBefore = -1,
      previousAfter = -1;
    for (const value of spans) {
      const span = keys(value, ["beforeOffset", "afterOffset", "before", "after"], "edit span");
      if (
        !Number.isSafeInteger(span.beforeOffset) ||
        !Number.isSafeInteger(span.afterOffset) ||
        (span.beforeOffset as number) < beforeEnd ||
        (span.afterOffset as number) < afterEnd ||
        (span.beforeOffset as number) <= previousBefore ||
        (span.afterOffset as number) <= previousAfter ||
        typeof span.before !== "string" ||
        typeof span.after !== "string" ||
        span.before === span.after
      )
        fail("ordered nonoverlapping edit spans");
      previousBefore = span.beforeOffset as number;
      previousAfter = span.afterOffset as number;
      beforeEnd = previousBefore + Buffer.byteLength(span.before as string);
      afterEnd = previousAfter + Buffer.byteLength(span.after as string);
      if (beforeEnd > before.pin.bytes || afterEnd > instruments[index + 2]!.pin.bytes) fail("edit span outside input");
    }
  }
}

function crossCheckHistorical(texts: ReadonlyMap<string, string>, authorityTexts: ReadonlyMap<string, string>): void {
  const relocation = JSON.parse(authorityTexts.get(population.receiptPath)!) as Data;
  const dependencyPins = relocation.dependencies as (C1Pin & { path: string })[];
  const originalLinear = dependencyPins.find((record) => record.path === artifacts[0].logicalPath);
  if (
    !originalLinear ||
    !same(
      { bytes: originalLinear.bytes, sha256: originalLinear.sha256, gitBlob: originalLinear.gitBlob },
      artifacts[0].pin,
    )
  )
    fail("linear original receipt cross-check");
  const donors = relocation.donorOwners as { donor: string; owner: string }[];
  const transfers = relocation.transfers as { moved: boolean }[];
  if (
    !same(
      (relocation.current as { path: string }[]).map((record) => record.path),
      population.currentPaths,
    ) ||
    !same(
      dependencyPins.map((record) => record.path),
      population.dependencyPaths,
    ) ||
    !same(
      donors.map((record) => [record.donor, record.owner]),
      population.donorPairs,
    ) ||
    transfers.length !== 91 ||
    transfers.filter((record) => record.moved).length !== 12 ||
    transfers.filter((record) => !record.moved).length !== 79
  )
    fail("original C1 population cross-check");
  const policyReceipts = immutableAuthorities
    .slice(4)
    .map((record) => JSON.parse(authorityTexts.get(record.path)!) as Data);
  for (const receipt of policyReceipts.slice(0, 3)) {
    const inputs = (receipt.provenance as Data).immutableInputs as { path: string; bytes: number; sha256: string }[];
    for (const artifact of artifacts.slice(1, 6)) {
      const input = inputs.find((record) => record.path === artifact.logicalPath);
      if (!input || input.bytes !== artifact.pin.bytes || input.sha256 !== artifact.pin.sha256)
        fail("historical caller receipt cross-check: " + artifact.logicalPath);
    }
  }
  const policy = texts.get("tests/helpers/ir-runtime-program-policy-evolution.ts")!;
  const prefixPins = [
    (policyReceipts[1]!.provenance as Data).c1HelperPrefix,
    (policyReceipts[2]!.provenance as Data).wksHelperPrefix,
    policyReceipts[3]!.helperPrefix,
    policyReceipts[4]!.helperPrefix,
    policyReceipts[5]!.helperPrefix,
    policyReceipts[6]!.helperPrefix,
  ] as { bytes: number; sha256: string }[];
  const bytes = Buffer.from(policy);
  const prefixHash = createHash("sha256");
  let cursor = 0;
  for (const prefix of prefixPins) {
    if (!Number.isSafeInteger(prefix.bytes) || prefix.bytes < 0 || prefix.bytes > bytes.length || prefix.bytes < cursor)
      fail("historical policy prefix cross-check");
    prefixHash.update(bytes.subarray(cursor, prefix.bytes));
    if (prefixHash.copy().digest("hex") !== prefix.sha256) fail("historical policy prefix cross-check");
    cursor = prefix.bytes;
  }
}

/** Exact seven-entry routing; never consult the live logical path as a fallback. */
export function c1HistoricalArtifactPath(logical: C1HistoricalLogicalPath): string {
  if (typeof logical !== "string") fail("historical operand must be a primitive string");
  const record = artifacts.find((artifact) => artifact.logicalPath === logical);
  if (!record) fail("unknown historical operand: " + logical);
  return record.artifactPath;
}

/** Every operation rechecks physical authority; returned texts are only a local historical snapshot. */
export function captureC1HistoricalAuthority(readAuthority: AuthorityReader = readActual): C1HistoricalCapture {
  if (!/^[a-f0-9]{64}$/.test(c1AuthorityManifestSha256)) fail("loaded manifest anchor");
  const anchor = readText(readAuthority, anchorPath);
  const canonicalAnchor =
    "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\n" +
    `export const c1AuthorityManifestSha256 = "${c1AuthorityManifestSha256}";\n`;
  if (anchor !== canonicalAnchor) fail("warm anchor source changed");
  const raw = readText(readAuthority, manifestPath);
  if (sha(raw) !== c1AuthorityManifestSha256) fail("manifest digest mismatch");
  const manifest = keys(
    parseJson(raw, manifestPath),
    [
      "schema",
      "historicalBase",
      "currentBase",
      "artifacts",
      "immutableAuthorities",
      "currentInstruments",
      "instrumentEdits",
      "population",
      "linearOptions",
    ],
    "manifest",
  );
  if (
    manifest.schema !== "ir-c1-historical-current-authority-v1" ||
    manifest.historicalBase !== historicalBase ||
    manifest.currentBase !== currentBase
  )
    fail("fixed schema/base");
  const artifactRecords = array(manifest.artifacts, "artifacts");
  for (const value of artifactRecords) {
    const record = keys(value, ["logicalPath", "artifactPath", "pin", "purpose"], "artifact");
    safePath(record.logicalPath, "logical artifact");
    safePath(record.artifactPath, "physical artifact");
    validatePin(record.pin, "artifact");
  }
  if (!same(artifactRecords, artifacts)) fail("exact artifact population");
  const immutableRecords = array(manifest.immutableAuthorities, "immutable authorities");
  immutableRecords.forEach((record) => validatePathPin(record, "immutable authority"));
  if (!same(immutableRecords, immutableAuthorities)) fail("exact immutable authority population");
  const instruments = array(manifest.currentInstruments, "current instruments").map((record) =>
    validatePathPin(record, "current instrument"),
  );
  if (
    !same(
      instruments.map((record) => record.path),
      currentInstrumentPaths,
    )
  )
    fail("exact current instrument population");
  validateInstrumentEdits(manifest.instrumentEdits, instruments);
  keys(
    manifest.population,
    [
      "receiptPath",
      "receiptSha256",
      "currentPaths",
      "dependencyPaths",
      "donorPairs",
      "transferCount",
      "movedCount",
      "retainedCount",
    ],
    "population",
  );
  if (!same(manifest.population, population)) fail("exact C1 historical population");
  const contract = validateLinearOptions(manifest.linearOptions);
  const authorityTexts = new Map<string, string>();
  for (const record of immutableAuthorities) {
    const text = readText(readAuthority, record.path);
    requirePin(text, record.pin, record.path);
    authorityTexts.set(record.path, text);
  }
  for (const record of instruments) requirePin(readText(readAuthority, record.path), record.pin, record.path);
  const historicalTexts = new Map<string, string>();
  for (const record of artifacts) {
    const text = readText(readAuthority, record.artifactPath);
    requirePin(text, record.pin, record.artifactPath);
    historicalTexts.set(record.logicalPath, text);
  }
  crossCheckHistorical(historicalTexts, authorityTexts);
  const linearOptions = detachedFrozen(contract);
  const readHistorical = (logical: C1HistoricalLogicalPath): string => {
    c1HistoricalArtifactPath(logical);
    const text = historicalTexts.get(logical);
    if (text === undefined) fail("missing captured historical operand");
    return text;
  };
  return Object.freeze({ linearOptions, readHistorical: Object.freeze(readHistorical) });
}

const fixedResolverRequests = [
  {
    containingFile: "src/codegen-linear/index.ts",
    module: "../ir/identity.js",
    target: {
      scope: "repository",
      path: "src/ir/identity.ts",
    },
  },
  {
    containingFile: "src/codegen-linear/index.ts",
    module: "../ir/analysis/linear-memory-plan.js",
    target: {
      scope: "repository",
      path: "src/ir/analysis/linear-memory-plan.ts",
    },
  },
  {
    containingFile: "src/codegen-linear/index.ts",
    module: "./c-abi.js",
    target: {
      scope: "repository",
      path: "src/codegen-linear/c-abi.ts",
    },
  },
  {
    containingFile: "src/codegen-linear/index.ts",
    module: "../checker/oracle-backend.js",
    target: {
      scope: "repository",
      path: "src/checker/oracle-backend.ts",
    },
  },
  {
    containingFile: "src/ir/identity.ts",
    module: "../position-map.js",
    target: {
      scope: "repository",
      path: "src/position-map.ts",
    },
  },
  {
    containingFile: "src/ir/identity.ts",
    module: "../shared/contracts/ir-unit-inventory.js",
    target: {
      scope: "repository",
      path: "src/shared/contracts/ir-unit-inventory.ts",
    },
  },
  {
    containingFile: "src/ir/identity.ts",
    module: "../ts-api.js",
    target: {
      scope: "repository",
      path: "src/ts-api.ts",
    },
  },
  {
    containingFile: "src/codegen-linear/c-abi.ts",
    module: "../ir/types.js",
    target: {
      scope: "repository",
      path: "src/ir/types.ts",
    },
  },
  {
    containingFile: "src/codegen-linear/c-abi.ts",
    module: "./refcount/ownership.js",
    target: {
      scope: "repository",
      path: "src/codegen-linear/refcount/ownership.ts",
    },
  },
  {
    containingFile: "src/ir/types.ts",
    module: "../wasm/model/instructions.js",
    target: {
      scope: "repository",
      path: "src/wasm/model/instructions.ts",
    },
  },
  {
    containingFile: "src/position-map.ts",
    module: "./shared/contracts/source-origin.js",
    target: {
      scope: "repository",
      path: "src/shared/contracts/source-origin.ts",
    },
  },
  {
    containingFile: "src/ts-api.ts",
    module: "./frontend/typescript.js",
    target: {
      scope: "repository",
      path: "src/frontend/typescript.ts",
    },
  },
  {
    containingFile: "src/frontend/typescript.ts",
    module: "typescript",
    target: {
      scope: "typescript-package",
      path: "lib/typescript.d.ts",
    },
  },
] as const;

/** Finite syntax/resolution domain derived only from the independently specified 13 requests. */
function validateResolverTopology(resolver: Data): void {
  const requests = array(resolver.requests, "resolver requests");
  for (const value of requests) {
    const request = keys(value, ["containingFile", "module", "target"], "resolver request");
    safePath(request.containingFile, "request source");
    location(request.target, "request target");
  }
  if (!same(requests, fixedResolverRequests)) fail("fixed resolver request topology");
  const repositoryFiles = new Set<string>(["tsconfig.json", "package.json", "pnpm-lock.yaml"]);
  const repositoryDirectories = new Set<string>([""]);
  const extensions = [".ts", ".tsx", ".d.ts", ".js", ".jsx"];
  const addParents = (path: string): void => {
    let directory = path.slice(0, path.lastIndexOf("/"));
    for (;;) {
      repositoryDirectories.add(directory);
      repositoryFiles.add(directory ? directory + "/package.json" : "package.json");
      if (!directory) break;
      const at = directory.lastIndexOf("/");
      directory = at === -1 ? "" : directory.slice(0, at);
    }
  };
  for (const request of fixedResolverRequests) {
    addParents(request.containingFile);
    if (request.target.scope === "repository") {
      addParents(request.target.path);
      const stem = request.target.path.slice(0, -3);
      for (const extension of extensions) repositoryFiles.add(stem + extension);
    }
  }
  for (const directory of ["src/frontend/node_modules", "src/node_modules", "node_modules"]) {
    repositoryDirectories.add(directory);
    repositoryDirectories.add(directory + "/@types");
  }
  const packageDirectories = new Set(["", "lib"]);
  const packageFiles = new Set(["package.json", ...extensions.map((extension) => "lib/typescript" + extension)]);
  const allowed = (where: C1ResolverLocation, operation: "file" | "directory" | "either"): boolean => {
    const files = where.scope === "repository" ? repositoryFiles : packageFiles;
    const directories = where.scope === "repository" ? repositoryDirectories : packageDirectories;
    return operation === "file"
      ? files.has(where.path)
      : operation === "directory"
        ? directories.has(where.path)
        : files.has(where.path) || directories.has(where.path);
  };
  const negativeRepositoryFileProbes = new Set([
    "node_modules/typescript.ts",
    "node_modules/typescript.tsx",
    "node_modules/typescript.d.ts",
  ]);
  const observations = array(resolver.observations, "resolver observations");
  if (!observations.length) fail("missing measured resolver transcript");
  for (const value of observations) {
    const operation = (value as Data)?.operation;
    if (operation === "readFile") {
      const observation = keys(value, ["operation", "location", "pin"], "resolver read");
      const where = location(observation.location, "resolver read");
      validatePin(observation.pin, "resolver read");
      if (!allowed(where, "file")) fail("out-of-domain resolver read");
    } else if (operation === "fileExists" || operation === "directoryExists") {
      const observation = keys(value, ["operation", "location", "exists"], "resolver existence");
      const where = location(observation.location, "resolver existence", operation === "directoryExists");
      const negativeRepositoryFileProbe =
        operation === "fileExists" &&
        observation.exists === false &&
        where.scope === "repository" &&
        negativeRepositoryFileProbes.has(where.path);
      if (
        typeof observation.exists !== "boolean" ||
        (!allowed(where, operation === "fileExists" ? "file" : "directory") && !negativeRepositoryFileProbe)
      )
        fail("out-of-domain resolver existence");
    } else if (operation === "realpath") {
      const observation = keys(value, ["operation", "location", "target"], "resolver realpath");
      const where = location(observation.location, "resolver realpath", true),
        target = location(observation.target, "resolver realpath target", true);
      if (!allowed(where, "either") || !allowed(target, "either")) fail("out-of-domain resolver realpath");
    } else fail("unsupported resolver observation");
  }
}
