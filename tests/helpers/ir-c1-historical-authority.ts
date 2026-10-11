// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { c1AuthorityManifestSha256 } from "./ir-c1-authority-root.js";
import * as c1AuthorityRoot from "./ir-c1-authority-root.js";

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
const sourceMapClosureEpochs: readonly C1PathPin[] = [
  {
    path: "src/position-map.ts",
    pin: {
      bytes: 8649,
      sha256: "aed06dbcabad1d12cfd4d228c25f30dca5d0ff0006ced9e467b26bf84485b8f9",
      gitBlob: "19dd7fd273ad68976e9302fc14894b170541aa8c",
    },
  },
  {
    path: "src/shared/contracts/ir-unit-inventory.ts",
    pin: {
      bytes: 8077,
      sha256: "6b5b77eeb6865023b01891bf2bc2efb1d803fac37c9f8ac739759e15e23fef83",
      gitBlob: "180df8e4f8b7aa3eabac4cb88b54dc6b04a642bb",
    },
  },
];
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
          : (sourceMapClosureEpochs.find((record) => record.path === entry.path) ?? entry),
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
  const geometryDigest = geometryAnchorDigest(false);
  if (anchor !== canonicalAnchor && anchor !== canonicalAnchor + geometryAnchorLine(geometryDigest))
    fail("warm anchor source changed");
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
  let contract = validateLinearOptions(manifest.linearOptions);
  const authorityTexts = new Map<string, string>();
  for (const record of immutableAuthorities) {
    const text = readText(readAuthority, record.path);
    requirePin(text, record.pin, record.path);
    authorityTexts.set(record.path, text);
  }
  const instrumentTexts = new Map<string, string>();
  let successor: Data | undefined;
  for (const record of instruments) {
    const text = readText(readAuthority, record.path);
    instrumentTexts.set(record.path, text);
    const owned = geometryInstrumentPins.some((entry) => entry.path === record.path);
    if (owned && (!same(measured(text), record.pin) || successor !== undefined)) {
      successor ??= captureGeometrySuccessor(readAuthority);
      requirePin(geometryInstrumentBefore(record.path, text, successor), record.pin, record.path);
    } else requirePin(text, record.pin, record.path);
  }
  if (successor) {
    // Never combine an old supplied instrument with another instrument's successor epoch.
    for (const value of array(successor.instruments, "geometry instruments")) {
      const record = value as Data;
      requirePin(
        instrumentTexts.get(record.path as string)!,
        validatePin(record.currentPin, "geometry current pin"),
        "complete geometry instrument epoch",
      );
    }
    contract = geometryLinearOptions(contract, successor.linearOptions);
  }
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
function validateResolverTopology(resolver: Data, currentGeometry = false): void {
  const expectedRequests = currentGeometry
    ? [...fixedResolverRequests, ...geometryResolverRequests]
    : fixedResolverRequests;
  const requests = array(resolver.requests, "resolver requests");
  for (const value of requests) {
    const request = keys(value, ["containingFile", "module", "target"], "resolver request");
    safePath(request.containingFile, "request source");
    location(request.target, "request target");
  }
  if (!same(requests, expectedRequests)) fail("fixed resolver request topology");
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
  for (const request of expectedRequests) {
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

// One finite geometry successor. ROOT owns the receipt and independent anchor activation.
const geometrySuccessorPath = "tests/helpers/ir-c1-linear-layout-geometry-successor.json";
const geometryCallerContracts = [
  {
    path: "tests/issue-3518-program-data-contract-boundary.test.ts",
    beforePin: {
      bytes: 33595,
      sha256: "1a00f71d523da3247ec64ea9affc076e0afda8a2cfcd28842bbaa1b61b5cd217",
      gitBlob: "7f680c042816519f623730cb00da2f7a163d1ed2",
    },
    currentPin: {
      bytes: 33840,
      sha256: "24f0e4dd484bc4fc61cfbb46f875a61615f6c63d448c57b524f58c8f39a84469",
      gitBlob: "18a17efe93db58ab5f6f0322f845c92e86859d41",
    },
  },
  {
    path: "tests/issue-3518-runtime-program-policy-evolution.test.ts",
    beforePin: {
      bytes: 28811,
      sha256: "8989cc94cdef77bb4d1370382ba61ced109d3ebd831f08dd843e4dbded8b9974",
      gitBlob: "f840395586a06c2674db9169e2346f77ec5d3f1c",
    },
    currentPin: {
      bytes: 29161,
      sha256: "a6378da157029b0ae01492dff7f6d24e7056a89781ca608dbc139b95fe3f7bd1",
      gitBlob: "43d2493da1d08c890841f03774f5e664731a82f6",
    },
  },
  {
    path: "tests/issue-3518-well-known-symbol-policy-evolution.test.ts",
    beforePin: {
      bytes: 29570,
      sha256: "913cfae67a28e6c8437d91a1e94428236a0cd6e220b20521a38e4251d0648619",
      gitBlob: "412d3efd1a98e24c65528f246834ff919137832b",
    },
    currentPin: {
      bytes: 29764,
      sha256: "fe80426e28d77a8451d45dc6d07a1a75ec4f73296c231a3d3cc6c85592fa19d4",
      gitBlob: "a009cd0ffbd2f91d971dada7abbf239c557d79d8",
    },
  },
  {
    path: "tests/issue-3518-number-prerequisite-policy-evolution.test.ts",
    beforePin: {
      bytes: 112437,
      sha256: "f0b10a5a3d47772cb497b5dc53f202ce2182b2ee4eb2c5c7d557b7aa8b0bb44f",
      gitBlob: "82c1cc794377b26ff9f41e809c300122133de85a",
    },
    currentPin: {
      bytes: 116007,
      sha256: "546be43029e1e58f2b31fb71e2e64592f954a6b750c6bcc3fa1f1db8dab889ea",
      gitBlob: "1fb4a992f18ccad293e3030d9f0d88c40d40d78a",
    },
  },
] as const;
const geometryInstrumentPins: readonly C1PathPin[] = [
  {
    path: "tests/helpers/ir-c1-historical-authority.ts",
    pin: {
      bytes: 44161,
      sha256: "0751d41d201981cfa1e74434fd9c7d2c85bdd4a5e8d17a1efa1c31be7457dccc",
      gitBlob: "089279974bd786288ed2eb0b6624ea54f59f9f80",
    },
  },
  {
    path: "tests/helpers/ir-c1-current-source.ts",
    pin: {
      bytes: 42599,
      sha256: "3fc1c89329e7e4185f8b86e1b997f801a8681e53614be9d072e464203cd68269",
      gitBlob: "020e91dc1d9bd0646b8b16d9b5224fd513caf861",
    },
  },
  {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    pin: {
      bytes: 409599,
      sha256: "e3bd76cbcee13e469f8c5c6ec6bafb08e6fc786efa410bd8572b56f9d5193170",
      gitBlob: "2dbe6d7fa227cb7463d73d20d847c433a933dfbc",
    },
  },
  ...geometryCallerContracts.map((record) => ({ path: record.path, pin: record.beforePin })),
];
const geometryClosurePins: readonly C1PathPin[] = [
  {
    path: "src/ir/analysis/linear-memory-plan.ts",
    pin: {
      bytes: 45359,
      sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",
      gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",
    },
  },
  {
    path: "src/ir/analysis/contracts/linear-memory-layout.ts",
    pin: {
      bytes: 3161,
      sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",
      gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",
    },
  },
  {
    path: "src/shared/contracts/linear-memory-layout.ts",
    pin: {
      bytes: 7580,
      sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",
      gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",
    },
  },
];
const geometryResolverRequests: readonly C1ResolverRequest[] = [
  {
    containingFile: "src/ir/analysis/linear-memory-plan.ts",
    module: "../../shared/contracts/linear-memory-layout.js",
    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },
  },
  {
    containingFile: "src/ir/analysis/linear-memory-plan.ts",
    module: "./contracts/linear-memory-layout.js",
    target: { scope: "repository", path: "src/ir/analysis/contracts/linear-memory-layout.ts" },
  },
  {
    containingFile: "src/ir/analysis/contracts/linear-memory-layout.ts",
    module: "../../../shared/contracts/linear-memory-layout.js",
    target: { scope: "repository", path: "src/shared/contracts/linear-memory-layout.ts" },
  },
];
function geometryAnchorDigest(required: boolean): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(c1AuthorityRoot, "c1GeometrySuccessorSha256");
  if (descriptor === undefined) {
    if (required) fail("geometry instrument authority not activated");
    return undefined;
  }
  if (
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.value)
  )
    fail("geometry instrument anchor data digest required");
  return descriptor.value;
}
function geometryAnchorLine(digest: string | undefined): string {
  return digest === undefined ? "" : `export const c1GeometrySuccessorSha256 = "${digest}";\n`;
}
function captureGeometrySuccessor(readAuthority: AuthorityReader): Data {
  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");
  const digest = geometryAnchorDigest(true);
  const anchor = readText(readAuthority, anchorPath);
  const canonical =
    "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\n" +
    `export const c1AuthorityManifestSha256 = "${c1AuthorityManifestSha256}";\n` +
    geometryAnchorLine(digest);
  if (anchor !== canonical) fail("geometry instrument warm anchor source changed");
  const raw = readText(readAuthority, geometrySuccessorPath);
  if (sha(raw) !== digest) fail("geometry instrument receipt digest mismatch");
  const receipt = keys(
    parseJson(raw, geometrySuccessorPath),
    ["schema", "predecessorManifestSha256", "instruments", "linearOptions", "cabiSource", "policySource"],
    "geometry instrument receipt",
  );
  if (
    receipt.schema !== "ir-c1-linear-layout-geometry-prerequisites-successor-v2" ||
    receipt.predecessorManifestSha256 !== c1AuthorityManifestSha256
  )
    fail("geometry instrument receipt domain");
  const instruments = array(receipt.instruments, "geometry instruments");
  if (instruments.length !== geometryInstrumentPins.length) fail("geometry instrument population");
  instruments.forEach((value, index) => {
    const record = keys(value, ["path", "beforePin", "currentPin", "inverse", "forward"], "geometry instrument");
    if (
      record.path !== geometryInstrumentPins[index]!.path ||
      !same(validatePin(record.beforePin, "geometry before pin"), geometryInstrumentPins[index]!.pin)
    )
      fail("geometry instrument predecessor domain");
    const currentPin = validatePin(record.currentPin, "geometry current pin");
    const caller = geometryCallerContracts.find((entry) => entry.path === record.path);
    if (caller && !same(currentPin, caller.currentPin)) fail("fixed geometry caller current pin: " + caller.path);
    for (const direction of ["inverse", "forward"] as const) {
      const spans = array(record[direction], "geometry " + direction);
      if (!spans.length) fail("geometry instrument missing " + direction);
      spans.forEach((span) => keys(span, ["inputOffset", "outputOffset", "from", "to"], "geometry span"));
    }
  });
  validatePrerequisiteSection(receipt.cabiSource, "cabiSource");
  validatePrerequisiteSection(receipt.policySource, "policySource");
  return receipt;
}
function geometryInstrumentReplay(
  source: string,
  spans: unknown,
  target: C1Pin,
  stage = "geometry instrument",
): string {
  const bytes = Buffer.from(source, "utf8");
  const pieces: Buffer[] = [];
  let inputEnd = 0,
    outputEnd = 0,
    previousInput = -1,
    previousOutput = -1;
  for (const value of array(spans, "geometry replay spans")) {
    const span = keys(value, ["inputOffset", "outputOffset", "from", "to"], "geometry replay span");
    if (
      !Number.isSafeInteger(span.inputOffset) ||
      !Number.isSafeInteger(span.outputOffset) ||
      typeof span.from !== "string" ||
      typeof span.to !== "string"
    )
      fail(stage + " span data");
    const inputOffset = span.inputOffset as number,
      outputOffset = span.outputOffset as number;
    const from = Buffer.from(span.from),
      to = Buffer.from(span.to);
    if (
      inputOffset < inputEnd ||
      outputOffset < outputEnd ||
      inputOffset <= previousInput ||
      outputOffset <= previousOutput ||
      inputOffset - inputEnd !== outputOffset - outputEnd ||
      inputOffset + from.length > bytes.length ||
      outputOffset + to.length > target.bytes ||
      from.toString("utf8") !== span.from ||
      to.toString("utf8") !== span.to ||
      span.from === span.to ||
      !bytes.subarray(inputOffset, inputOffset + from.length).equals(from)
    )
      fail(stage + " span membership/coordinates");
    pieces.push(bytes.subarray(inputEnd, inputOffset), to);
    previousInput = inputOffset;
    previousOutput = outputOffset;
    inputEnd = inputOffset + from.length;
    outputEnd = outputOffset + to.length;
  }
  pieces.push(bytes.subarray(inputEnd));
  const output = Buffer.concat(pieces).toString("utf8");
  requirePin(output, target, stage + " replay");
  return output;
}
function geometryInstrumentBefore(path: string, source: string, receipt: Data): string {
  const record = array(receipt.instruments, "geometry instruments").find((value) => (value as Data).path === path) as
    | Data
    | undefined;
  if (!record) fail("geometry instrument path outside fixed domain: " + path);
  requirePin(source, validatePin(record.currentPin, path), path + " geometry current");
  const before = geometryInstrumentReplay(
    source,
    record.inverse,
    validatePin(record.beforePin, path),
    "geometry instrument inverse: " + path,
  );
  const replay = geometryInstrumentReplay(
    before,
    record.forward,
    validatePin(record.currentPin, path),
    "geometry instrument forward: " + path,
  );
  if (replay !== source) fail("geometry independent instrument forward equality: " + path);
  return before;
}
/** Exactly seven published instruments; primitive/path/reader checks precede IO. */
export function c1GeometryInstrumentPredecessor(
  path: string,
  source: string,
  readAuthority: AuthorityReader = readActual,
): string {
  if (typeof path !== "string" || typeof source !== "string")
    fail("geometry instrument primitive path/source required");
  if (typeof readAuthority !== "function") fail("geometry authority reader must be callable");
  const record = geometryInstrumentPins.find((entry) => entry.path === path);
  if (!record) fail("geometry instrument path outside fixed domain: " + path);
  // Exact original supplied inputs retain their pre-existing authority path.
  if (same(measured(source), record.pin)) return source;
  return geometryInstrumentBefore(path, source, captureGeometrySuccessor(readAuthority));
}
function geometryLinearOptions(before: C1LinearOptionsContract, value: unknown): C1LinearOptionsContract {
  const contract = keys(
    value,
    ["sourcePath", "declaration", "bindings", "closureInputs", "resolver"],
    "geometry linear options",
  );
  const expectedClosure = [
    ...before.closureInputs.map((entry) =>
      entry.path === geometryClosurePins[0]!.path
        ? geometryClosurePins[0]!
        : entry.path === "src/codegen-linear/c-abi.ts"
          ? { path: entry.path, pin: cabiSourceEpochContracts[1].currentPin }
          : entry,
    ),
    ...geometryClosurePins.slice(1),
  ];
  if (
    contract.sourcePath !== before.sourcePath ||
    !same(contract.declaration, before.declaration) ||
    !same(contract.bindings, before.bindings) ||
    !same(contract.closureInputs, expectedClosure)
  )
    fail("geometry-only closure successor");
  const resolver = keys(
    contract.resolver,
    ["configInputs", "optionsSource", "optionsSha256", "requests", "observations"],
    "geometry resolver",
  );
  if (
    !same(resolver.configInputs, before.resolver.configInputs) ||
    resolver.optionsSource !== before.resolver.optionsSource ||
    resolver.optionsSha256 !== before.resolver.optionsSha256
  )
    fail("geometry resolver configuration changed");
  validateResolverTopology(resolver, true);
  const observations = array(resolver.observations, "geometry observations");
  if (!same(observations.slice(0, before.resolver.observations.length), before.resolver.observations))
    fail("unrelated geometry resolver transcript drift");
  return contract as unknown as C1LinearOptionsContract;
}

// Fixed Git identities and full pins independently checked against the adopted Astra amendment.
const cabiSourceEpochContracts = [
  {
    commit: "867c74ac7aa962f0412e37d842b077a96c6283da",
    parent: "efa7a96d605914961f0ea2d106093fc967bcd80a",
    beforePin: {
      bytes: 26965,
      sha256: "fba055c0a5ed1b823b1bb8644c5cb495e0b26bb087bf36b5d746efda708fb308",
      gitBlob: "37eb30e8691a7e30033c74bc03bd386dc08e9d49",
    },
    currentPin: {
      bytes: 27414,
      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",
      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",
    },
  },
  {
    commit: "608edfabf404aba0e69691eeccbda7518ca7988d",
    parent: "880e9eaa288861eeadc7a6e5936d89bc4d2c35c1",
    beforePin: {
      bytes: 27414,
      sha256: "d0e185f51a5d24b480241375b4a3e7ec6e5cfcab99c00a789cd0a676db81dc3f",
      gitBlob: "e54d176cd915b61bed623db4ff3ec6d898c99322",
    },
    currentPin: {
      bytes: 27454,
      sha256: "d303abd67069493c08dedc6cd124482f80675c06e0ca1748cea168098fc82d46",
      gitBlob: "b7d04be3e51eafc7aa3257d6da808750e4dbaee4",
    },
  },
] as const;
const policySourceEpochContracts = [
  {
    commit: "5c0129e085c58d295044c5a6a0daebd6d50d4e9f",
    parent: "20297ba9ae3537b5bd36f618d77205265f5220ad",
    beforePin: {
      bytes: 599721,
      sha256: "644219143ca7262a03ae74c559b1dcc9bd20c0bdc6b8f09a059d659523d93d53",
      gitBlob: "c24af976b5c991c28e7ccafaf87f0ec656f3fff0",
    },
    currentPin: {
      bytes: 600520,
      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",
      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",
    },
  },
  {
    commit: "1156d385765f06d675bc6f6c25caa138501fef58",
    parent: "fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8",
    beforePin: {
      bytes: 600520,
      sha256: "769a24c149005fdbaad682a120d36099d40f3cafa660a2989e30220540d4abf1",
      gitBlob: "4fbc5c48d77ac35223935447fde55c6ddc3af880",
    },
    currentPin: {
      bytes: 601510,
      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",
      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",
    },
  },
  {
    commit: "e5edf36d15e1895dbc25c85a0fb2c0966ea15363",
    parent: "e7760d1c2af4636ede6a352154d193b234af5fc4",
    beforePin: {
      bytes: 601510,
      sha256: "312bb982b2c20ddbc64412adb166fe63a5e4bf6061439acaa9a16d42c62a6150",
      gitBlob: "d728ff1b4e79208c1d325173f7e567233c3d8e0a",
    },
    currentPin: {
      bytes: 602174,
      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",
      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",
    },
  },
  {
    commit: "534620a636c63c257bc5afb8d543d0306b26928c",
    parent: "a5c5689f9c85090d44f940204ae3c65605f01ce5",
    beforePin: {
      bytes: 602174,
      sha256: "3c26411dda04b40f68501f6ae65450d22c7b84318bb4b4767240e9a20255da1e",
      gitBlob: "dcbdfb141d38ef1cd851299cba555883e3d75516",
    },
    currentPin: {
      bytes: 602572,
      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",
      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",
    },
  },
  {
    commit: "3c671f11506f91f4eb91624cf9a8456ca95a6ce8",
    parent: "26091eabd4561e5be154741e7e18143070d3ce59",
    beforePin: {
      bytes: 602572,
      sha256: "1cfa9d85f325bdca79b3818cef6fbe5f7eb97c538f41b45c7cce2c969c7b6e8f",
      gitBlob: "08ab24ffd7a4d611a831472e936955b5e1bd499a",
    },
    currentPin: {
      bytes: 602694,
      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",
      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",
    },
  },
  {
    commit: "522ca55b7cf57fdbe5a5b45cbf0272c9a58e63db",
    parent: "6e5a583e56553c6066646591d1637c45c15e99e8",
    beforePin: {
      bytes: 602694,
      sha256: "5c616ef7e4cdc1e7c30a9294254fba72f696d81ca6ba3d60cf270f3e959f61f5",
      gitBlob: "0dd92d6d2b319ff2bde6bb5586a709bef93b1780",
    },
    currentPin: {
      bytes: 603019,
      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",
      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",
    },
  },
  {
    commit: "e02ed67eb91bbe0d3ffeec1359a599ad17004ecd",
    parent: "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",
    beforePin: {
      bytes: 603019,
      sha256: "7e9850c366bdcc5290800d36c0e47da7b8b8b96bc1b5de361273929a696dc042",
      gitBlob: "93c5b88c494bb3b3652f0710f11c34d1ccba09ca",
    },
    currentPin: {
      bytes: 603481,
      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",
      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",
    },
  },
  {
    commit: "484c8921649d6a8ee762f50f90bc762bd4c8d572",
    parent: "1e9f050e98a25334379c8e8caa46c5e43af307d3",
    beforePin: {
      bytes: 603481,
      sha256: "4779cceaf84b38ecd15e148c8a288a7bb4956af609d0104be6cffaf9446b7e6f",
      gitBlob: "04715236e365e1b9fac36f5634c2d0bbe10b08fd",
    },
    currentPin: {
      bytes: 603831,
      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",
      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",
    },
  },
  {
    commit: "3146af9a349bb20a5a398fba37e8b69b16fb4ab9",
    parent: "484c8921649d6a8ee762f50f90bc762bd4c8d572",
    beforePin: {
      bytes: 603831,
      sha256: "a36503a8108fe7314b7d7f550301c4e723b1761c8007d7991adcb825f51de3bb",
      gitBlob: "6dc39b16d83d92c1c43a176bd53c5e8ad4a5add5",
    },
    currentPin: {
      bytes: 603953,
      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",
      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",
    },
  },
  {
    commit: "9466fb720b9fed667f84726bcb561e8d5d1b46ca",
    parent: "fefc9c0e79f4fbf70191f69ab0fdd76a07cc1206",
    beforePin: {
      bytes: 603953,
      sha256: "8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1",
      gitBlob: "4bfd478d9480496fcef7dc7287eec7a785f18e0a",
    },
    currentPin: {
      bytes: 604615,
      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",
      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",
    },
  },
  {
    commit: "088046348f71f3fc7a2301dbcff6444fe2967bbc",
    parent: "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438",
    beforePin: {
      bytes: 604615,
      sha256: "8a934171572cd7a255db836fbc9937bbf4bd8200be83175c94959863fec262e0",
      gitBlob: "7c12638e2de24207ccdcfc32d2ba16da3afbb3f8",
    },
    currentPin: {
      bytes: 605605,
      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",
      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",
    },
  },
  {
    commit: "58994f7b4d2cbc1a239b8fb0c0e3f39644066489",
    parent: "e610189829ad1554b813d6ca224515666b0e2d28",
    beforePin: {
      bytes: 605605,
      sha256: "424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da",
      gitBlob: "bbaeb9f80fbdae4a4a411ba670b54f52b4b4558e",
    },
    currentPin: {
      bytes: 606787,
      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",
      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",
    },
  },
  {
    commit: "b932e3a05e353acc59e7b547ef4e417a5d8637e1",
    parent: "e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f",
    beforePin: {
      bytes: 606787,
      sha256: "b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9",
      gitBlob: "47808eea7a41637438ed783d8a35dc18d99c4382",
    },
    currentPin: {
      bytes: 606971,
      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",
      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",
    },
  },
  {
    commit: "b38ef77ca7b35efb4e9d8c5a889295d8dd8a9771",
    parent: "dbf5b4f74b37d67e525b2af36fd1fe49803b1348",
    beforePin: {
      bytes: 606971,
      sha256: "d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896",
      gitBlob: "da3dbc17db188f312f6dd90e13f7464ed0c995cd",
    },
    currentPin: {
      bytes: 607104,
      sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",
      gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",
    },
  },
  {
    commit: "320399e7e8e6866b81560ecdc8f60a260cf10991",
    parent: "43b1f746771bf266f15b285fc8bac93d3c8d22d8",
    beforePin: {
      bytes: 607104,
      sha256: "4a35a4e2d4eebca1d05f7bd053a9bbb8fe04058a95d2bb1572ac7fb8079dcec3",
      gitBlob: "df48a10ab47a3b92923667e55bb4eb070b1872a8",
    },
    currentPin: {
      bytes: 608189,
      sha256: "f487c77b820a775e38fc7669a8b62b4e6ccc5cc9a991fa3cdff35a0ab135964a",
      gitBlob: "c2cdd079e91ea797b25d6239d97b8610fd437070",
    },
  },
  {
    commit: "dd5452e4c0be68ec6582bba3eb5d3aba0756c5a1",
    parent: "a3cccd199b24865b1ea3f77a519e1a8bcc34ad3a",
    beforePin: {
      bytes: 608189,
      sha256: "f487c77b820a775e38fc7669a8b62b4e6ccc5cc9a991fa3cdff35a0ab135964a",
      gitBlob: "c2cdd079e91ea797b25d6239d97b8610fd437070",
    },
    currentPin: {
      bytes: 608556,
      sha256: "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",
      gitBlob: "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba",
    },
  },
  {
    commit: "5d7c261f46ca5dc06d09f47da8665d3151335224",
    parent: "6720ce5198f5252239ff4800b383de2072830d99",
    beforePin: {
      bytes: 608556,
      sha256: "e49d9d96b2657aa7f36afb69c05d390331db4ecf6045afa7dfb427e98443226e",
      gitBlob: "7d167b2ff0b281408eacb5fbbcfe9d93b7d024ba",
    },
    currentPin: {
      bytes: 608912,
      sha256: "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",
      gitBlob: "1af8a4f11e3b69d23930cc388dd614f76750de8d",
    },
  },
  {
    commit: "0c65834a6cf2f99c6183f0fb171d0d3db56b0800",
    parent: "c902aea8db3a566afd32c9749eb1d740df6d5a4f",
    beforePin: {
      bytes: 608912,
      sha256: "e30223ad3a1b8cdc572bcd7f5086ee5a66ec4c78522722e6d6101c397c65cbfd",
      gitBlob: "1af8a4f11e3b69d23930cc388dd614f76750de8d",
    },
    currentPin: {
      bytes: 609239,
      sha256: "cda02a8bc8daf371ea61ea49fb6e98c9d2214f04b700b15b35159db1fcc662e3",
      gitBlob: "82d1fcd8623827c904eb2158d1c8361969f996fe",
    },
  },
] as const;
const prerequisitePolicyTopLevelKeys = [
  "schema",
  "description",
  "sourceRoot",
  "tsconfig",
  "requireGitProvenance",
  "externalAssets",
  "frontendWrapper",
  "moduleExtensions",
  "layers",
  "allowedEdges",
  "externalPackages",
  "activationHistory",
  "nonModules",
  "moves",
  "evidence",
  "files",
] as const;
const prerequisitePolicySemanticRules = [
  {
    beforeFileCount: 1874,
    currentFileCount: 1876,
    additions: [
      {
        index: 122,
        row: {
          path: "src/checker/js-collection-inference.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "frontend-ts",
          owner: "3518-coordinator",
          nextBoundary:
            "New #6651 V12 leaf of src/checker/index.ts (synthetic ambient root for `.js` checker programs); it depends only on the TS wrapper and moves with its parent when the checker's TS-wrapper dependencies are separated at frontend closure.",
        },
        previousPath: "src/checker/inhouse-oracle.ts",
        nextPath: "src/checker/language-service.ts",
      },
      {
        index: 905,
        row: {
          path: "src/codegen/object-model/global-var-binding-exotic.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/object-model/module-namespace-exotic.ts",
        nextPath: "src/codegen/object-model/proxy-trap-read.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1876,
    currentFileCount: 1879,
    additions: [
      {
        index: 576,
        row: {
          path: "src/codegen/analysis/fnctor-ctor-self-dynamic.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/fnctor-ctor-param-types.ts",
        nextPath: "src/codegen/fnctor-escape-gate.ts",
      },
      {
        index: 976,
        row: {
          path: "src/codegen/expressions/spread-elem-extern.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/spread-arg-list.ts",
        nextPath: "src/codegen/stack-balance.ts",
      },
      {
        index: 978,
        row: {
          path: "src/codegen/expressions/standalone-any-length.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/stack-balance.ts",
        nextPath: "src/codegen/standalone-class-instance-proto.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1879,
    currentFileCount: 1881,
    additions: [
      {
        index: 343,
        row: {
          path: "src/codegen/closures/closure-binding-identity.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/closures/capture-source-slot.ts",
        nextPath: "src/codegen/closures/closure-dispatch-rest.ts",
      },
      {
        index: 1059,
        row: {
          path: "src/codegen/object-model/struct-field-name-tags.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/struct-hierarchy-layout.ts",
        nextPath: "src/codegen/object-model/struct-optional-widen.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1881,
    currentFileCount: 1882,
    additions: [
      {
        index: 331,
        row: {
          path: "src/codegen/object-model/generator-function-proto-arm.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate codegen-context generator-function identity registration and physical function/global allocation from the native [[Prototype]] arm bodies.",
        },
        previousPath: "src/codegen/object-model/closed-object-prototype-edges.ts",
        nextPath: "src/codegen/closed-struct-extern-set.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1882,
    currentFileCount: 1883,
    additions: [
      {
        index: 1494,
        row: {
          path: "src/runtime/native-regime-view.ts",
          state: "unmigrated",
          layer: "legacy-host",
        },
        previousPath: "src/runtime/native-function-source.ts",
        nextPath: "src/runtime/object-create-class-instance.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1883,
    currentFileCount: 1884,
    additions: [
      {
        index: 1113,
        row: {
          path: "src/codegen/array/vec-receiver-identity.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/array/vec-elem-fidelity.ts",
        nextPath: "src/codegen/vec-externref-hole-presence.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1884,
    currentFileCount: 1885,
    additions: [
      {
        index: 1335,
        row: {
          path: "src/ir/lowering/string-operations.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "compiler",
          owner: "3518-coordinator",
          nextBoundary:
            "Generic string operation orchestration uses an injected emitter and only type-imports the clean semantic IR nodes and the still-unmigrated string emitter contract; establish a complete generic lowering contract closure before activation.",
        },
        previousPath: "src/ir/lower-generic.ts",
        nextPath: "src/ir/lower.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1885,
    currentFileCount: 1886,
    additions: [
      {
        index: 911,
        row: {
          path: "src/codegen/closures/function-intrinsic-construct.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly.",
        },
        previousPath: "src/codegen/closures/promoted-capture-value.ts",
        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1886,
    currentFileCount: 1887,
    additions: [
      {
        index: 1498,
        row: {
          path: "src/runtime/process-capability.ts",
          state: "unmigrated",
          layer: "legacy-host",
        },
        previousPath: "src/runtime/native-regime-view.ts",
        nextPath: "src/runtime/object-create-class-instance.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1887,
    currentFileCount: 1889,
    additions: [
      {
        index: 237,
        row: {
          path: "src/codegen/async-frame-binding-continuity.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/async-await-hoist.ts",
        nextPath: "src/codegen/async-cps-ast.ts",
      },
      {
        index: 440,
        row: {
          path: "src/codegen/expressions/identifier-receiver-slot.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/dynamic-proto.ts",
        nextPath: "src/codegen/dynamic-read-narrowing.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1889,
    currentFileCount: 1892,
    additions: [
      {
        index: 914,
        row: {
          path: "src/codegen/expressions/primitive-newtarget-default.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",
        },
        previousPath: "src/codegen/closures/function-intrinsic-construct.ts",
        nextPath: "src/codegen/expressions/uncalled-shim-eval.ts",
      },
      {
        index: 915,
        row: {
          path: "src/codegen/expressions/uncalled-shim-eval.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",
        },
        previousPath: "src/codegen/expressions/primitive-newtarget-default.ts",
        nextPath: "src/codegen/object-model/construct-default-proto.ts",
      },
      {
        index: 916,
        row: {
          path: "src/codegen/object-model/construct-default-proto.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/expressions/uncalled-shim-eval.ts",
        nextPath: "src/codegen/closures/proxy-trap-closure-return.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1892,
    currentFileCount: 1898,
    additions: [
      {
        index: 1865,
        row: {
          path: "src/ir/analysis/allocation-evidence/contracts.ts",
          state: "clean",
          layer: "ir-analysis",
        },
        previousPath: "src/ir/analysis/alloc-verification.ts",
        nextPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",
      },
      {
        index: 1866,
        row: {
          path: "src/ir/analysis/allocation-evidence/effect-rules.ts",
          state: "clean",
          layer: "ir-analysis",
        },
        previousPath: "src/ir/analysis/allocation-evidence/contracts.ts",
        nextPath: "src/ir/analysis/allocation-evidence/census.ts",
      },
      {
        index: 1867,
        row: {
          path: "src/ir/analysis/allocation-evidence/census.ts",
          state: "clean",
          layer: "ir-analysis",
        },
        previousPath: "src/ir/analysis/allocation-evidence/effect-rules.ts",
        nextPath: "src/ir/analysis/allocation-evidence/metadata.ts",
      },
      {
        index: 1868,
        row: {
          path: "src/ir/analysis/allocation-evidence/metadata.ts",
          state: "clean",
          layer: "ir-analysis",
        },
        previousPath: "src/ir/analysis/allocation-evidence/census.ts",
        nextPath: "src/ir/analysis/allocation-evidence/verify.ts",
      },
      {
        index: 1869,
        row: {
          path: "src/ir/analysis/allocation-evidence/verify.ts",
          state: "clean",
          layer: "ir-analysis",
        },
        previousPath: "src/ir/analysis/allocation-evidence/metadata.ts",
        nextPath: "src/ir/runtime/verify.ts",
      },
      {
        index: 1872,
        row: {
          path: "src/ir/program/allocation-body-validation.ts",
          state: "clean",
          layer: "ir-program",
        },
        previousPath: "src/ir/program/allocations.ts",
        nextPath: "src/ir/program/class-layouts.ts",
      },
    ],
    layers: [
      {
        index: 6,
        id: "ir-analysis",
        fields: ["roots", "entries", "minModules"],
        beforeValues: {
          roots: [
            "src/ir/analysis/contracts",
            "src/ir/analysis/alloc-registry.ts",
            "src/ir/analysis/effects.ts",
            "src/ir/analysis/intrinsics.ts",
            "src/ir/analysis/async-plan.ts",
            "src/ir/analysis/lattice.ts",
            "src/ir/analysis/ownership.ts",
            "src/ir/analysis/encoding.ts",
            "src/ir/analysis/escape.ts",
            "src/ir/analysis/dominance.ts",
            "src/ir/analysis/alloc-verification.ts",
            "src/ir/analysis/nested-stackification.ts",
            "src/ir/analysis/backend-legality.ts",
          ],
          entries: [
            "src/ir/analysis/contracts/allocations.ts",
            "src/ir/analysis/alloc-registry.ts",
            "src/ir/analysis/effects.ts",
            "src/ir/analysis/intrinsics.ts",
            "src/ir/analysis/async-plan.ts",
            "src/ir/analysis/lattice.ts",
            "src/ir/analysis/ownership.ts",
            "src/ir/analysis/encoding.ts",
            "src/ir/analysis/escape.ts",
            "src/ir/analysis/dominance.ts",
            "src/ir/analysis/alloc-verification.ts",
            "src/ir/analysis/nested-stackification.ts",
            "src/ir/analysis/contracts/linear-memory-layout.ts",
            "src/ir/analysis/backend-legality.ts",
          ],
          minModules: 14,
        },
        currentValues: {
          roots: [
            "src/ir/analysis/contracts",
            "src/ir/analysis/allocation-evidence",
            "src/ir/analysis/alloc-registry.ts",
            "src/ir/analysis/effects.ts",
            "src/ir/analysis/intrinsics.ts",
            "src/ir/analysis/async-plan.ts",
            "src/ir/analysis/lattice.ts",
            "src/ir/analysis/ownership.ts",
            "src/ir/analysis/encoding.ts",
            "src/ir/analysis/escape.ts",
            "src/ir/analysis/dominance.ts",
            "src/ir/analysis/alloc-verification.ts",
            "src/ir/analysis/nested-stackification.ts",
            "src/ir/analysis/backend-legality.ts",
          ],
          entries: [
            "src/ir/analysis/contracts/allocations.ts",
            "src/ir/analysis/alloc-registry.ts",
            "src/ir/analysis/effects.ts",
            "src/ir/analysis/intrinsics.ts",
            "src/ir/analysis/async-plan.ts",
            "src/ir/analysis/lattice.ts",
            "src/ir/analysis/ownership.ts",
            "src/ir/analysis/encoding.ts",
            "src/ir/analysis/escape.ts",
            "src/ir/analysis/dominance.ts",
            "src/ir/analysis/alloc-verification.ts",
            "src/ir/analysis/nested-stackification.ts",
            "src/ir/analysis/contracts/linear-memory-layout.ts",
            "src/ir/analysis/backend-legality.ts",
            "src/ir/analysis/allocation-evidence/contracts.ts",
            "src/ir/analysis/allocation-evidence/effect-rules.ts",
            "src/ir/analysis/allocation-evidence/census.ts",
            "src/ir/analysis/allocation-evidence/metadata.ts",
            "src/ir/analysis/allocation-evidence/verify.ts",
          ],
          minModules: 19,
        },
      },
      {
        index: 9,
        id: "ir-program",
        fields: ["entries", "minModules"],
        beforeValues: {
          entries: [
            "src/ir/program/abi-inventory.ts",
            "src/ir/program/abi.ts",
            "src/ir/program/startup.ts",
            "src/ir/program/abi-lookup.ts",
            "src/ir/program/callable-bindings.ts",
            "src/ir/program/controls.ts",
            "src/ir/program/index.ts",
            "src/ir/program/input-contracts.ts",
            "src/ir/program/prepared-contracts.ts",
            "src/ir/program/errors.ts",
            "src/ir/program/data.ts",
            "src/ir/program/input.ts",
            "src/ir/program/native-vector-resources.ts",
            "src/ir/program/native-promise-resources.ts",
            "src/ir/program/native-value-resources.ts",
            "src/ir/program/native-string-value-demands.ts",
            "src/ir/program/runtime-support.ts",
            "src/ir/program/formatter-support.ts",
            "src/ir/program/native-number-format-requirements.ts",
            "src/ir/program/async-frame-setup.ts",
            "src/ir/program/prepared-async-frame-plan.ts",
            "src/ir/program/abi-signatures.ts",
            "src/ir/program/host-async-dynamic.ts",
            "src/ir/program/host-import-plan.ts",
            "src/ir/program/host-number-boundary-setup.ts",
            "src/ir/program/runtime-abi-identity.ts",
            "src/ir/program/native-string-output-requirements.ts",
            "src/ir/program/callable-results.ts",
            "src/ir/program/native-source-closure-requirements.ts",
            "src/ir/program/population.ts",
            "src/ir/program/native-ref-cell-requirements.ts",
            "src/ir/program/native-invocation-requirements.ts",
            "src/ir/program/native-object-access-requirements.ts",
            "src/ir/program/native-getter-invocation-requirements.ts",
            "src/ir/program/native-object-result-requirements.ts",
            "src/ir/program/native-object-result-values.ts",
            "src/ir/program/native-prototype-requirements.ts",
            "src/ir/program/native-realm-requirements.ts",
            "src/ir/program/allocations.ts",
            "src/ir/program/class-layouts.ts",
            "src/ir/program/owner.ts",
            "src/ir/program/draft-abi-lookup.ts",
            "src/ir/program/runtime-support-dependencies.ts",
            "src/ir/program/runtime-demands.ts",
            "src/ir/program/runtime-abi.ts",
            "src/ir/program/runtime-manifest.ts",
            "src/ir/program/runtime-validation.ts",
            "src/ir/program/validation.ts",
          ],
          minModules: 48,
        },
        currentValues: {
          entries: [
            "src/ir/program/abi-inventory.ts",
            "src/ir/program/abi.ts",
            "src/ir/program/startup.ts",
            "src/ir/program/abi-lookup.ts",
            "src/ir/program/callable-bindings.ts",
            "src/ir/program/controls.ts",
            "src/ir/program/index.ts",
            "src/ir/program/input-contracts.ts",
            "src/ir/program/prepared-contracts.ts",
            "src/ir/program/errors.ts",
            "src/ir/program/data.ts",
            "src/ir/program/input.ts",
            "src/ir/program/native-vector-resources.ts",
            "src/ir/program/native-promise-resources.ts",
            "src/ir/program/native-value-resources.ts",
            "src/ir/program/native-string-value-demands.ts",
            "src/ir/program/runtime-support.ts",
            "src/ir/program/formatter-support.ts",
            "src/ir/program/native-number-format-requirements.ts",
            "src/ir/program/async-frame-setup.ts",
            "src/ir/program/prepared-async-frame-plan.ts",
            "src/ir/program/abi-signatures.ts",
            "src/ir/program/host-async-dynamic.ts",
            "src/ir/program/host-import-plan.ts",
            "src/ir/program/host-number-boundary-setup.ts",
            "src/ir/program/runtime-abi-identity.ts",
            "src/ir/program/native-string-output-requirements.ts",
            "src/ir/program/callable-results.ts",
            "src/ir/program/native-source-closure-requirements.ts",
            "src/ir/program/population.ts",
            "src/ir/program/native-ref-cell-requirements.ts",
            "src/ir/program/native-invocation-requirements.ts",
            "src/ir/program/native-object-access-requirements.ts",
            "src/ir/program/native-getter-invocation-requirements.ts",
            "src/ir/program/native-object-result-requirements.ts",
            "src/ir/program/native-object-result-values.ts",
            "src/ir/program/native-prototype-requirements.ts",
            "src/ir/program/native-realm-requirements.ts",
            "src/ir/program/allocations.ts",
            "src/ir/program/class-layouts.ts",
            "src/ir/program/owner.ts",
            "src/ir/program/draft-abi-lookup.ts",
            "src/ir/program/runtime-support-dependencies.ts",
            "src/ir/program/runtime-demands.ts",
            "src/ir/program/runtime-abi.ts",
            "src/ir/program/runtime-manifest.ts",
            "src/ir/program/runtime-validation.ts",
            "src/ir/program/validation.ts",
            "src/ir/program/allocation-body-validation.ts",
          ],
          minModules: 49,
        },
      },
    ],
  },
  {
    beforeFileCount: 1898,
    currentFileCount: 1899,
    additions: [
      {
        index: 1532,
        row: {
          path: "src/shared/contracts/linear-memory-layout.ts",
          state: "clean",
          layer: "foundation",
        },
        previousPath: "src/shared/contracts/identity-values.ts",
        nextPath: "src/shared/contracts/ir-identity.ts",
      },
    ],
    layers: [
      {
        index: 0,
        id: "foundation",
        fields: ["entries", "minModules"],
        beforeValues: {
          entries: [
            "src/shared/contracts/source-origin.ts",
            "src/shared/contracts/ir-identity.ts",
            "src/shared/contracts/identity-values.ts",
            "src/shared/contracts/ir-counted-string-identity.ts",
            "src/shared/contracts/ir-preparation-failure.ts",
            "src/shared/contracts/ir-unit-inventory.ts",
            "src/shared/contracts/ir-preparation-errors.ts",
            "src/shared/contracts/ir-counted-string-site-id.ts",
            "src/shared/contracts/string-surrogate.ts",
          ],
          minModules: 9,
        },
        currentValues: {
          entries: [
            "src/shared/contracts/source-origin.ts",
            "src/shared/contracts/ir-identity.ts",
            "src/shared/contracts/identity-values.ts",
            "src/shared/contracts/ir-counted-string-identity.ts",
            "src/shared/contracts/ir-preparation-failure.ts",
            "src/shared/contracts/ir-unit-inventory.ts",
            "src/shared/contracts/ir-preparation-errors.ts",
            "src/shared/contracts/ir-counted-string-site-id.ts",
            "src/shared/contracts/string-surrogate.ts",
            "src/shared/contracts/linear-memory-layout.ts",
          ],
          minModules: 10,
        },
      },
    ],
  },
  {
    beforeFileCount: 1899,
    currentFileCount: 1900,
    additions: [
      {
        index: 155,
        row: {
          path: "src/codegen-linear/runtime/string-slice.ts",
          state: "unmigrated",
          layer: "legacy-linear",
        },
        previousPath: "src/codegen-linear/runtime.ts",
        nextPath: "src/codegen-linear/simd.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1900,
    currentFileCount: 1903,
    additions: [
      {
        index: 198,
        row: {
          path: "src/codegen/array/array-search-core.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Pure instruction builders for the array-like search scan; move to the backend once the late-import funcIdx resolution is a backend service.",
        },
        previousPath: "src/codegen/array-element-typing.ts",
        nextPath: "src/codegen/array/array-search-proto-value.ts",
      },
      {
        index: 199,
        row: {
          path: "src/codegen/array/array-search-proto-value.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core.",
        },
        previousPath: "src/codegen/array/array-search-core.ts",
        nextPath: "src/codegen/array/array-generic-value-bodies.ts",
      },
      {
        index: 200,
        row: {
          path: "src/codegen/array/array-generic-value-bodies.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction.",
        },
        previousPath: "src/codegen/array/array-search-proto-value.ts",
        nextPath: "src/codegen/array/array-fill-proto-value.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1903,
    currentFileCount: 1904,
    additions: [
      {
        index: 201,
        row: {
          path: "src/codegen/array/array-copy-methods-value.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction.",
        },
        previousPath: "src/codegen/array/array-generic-value-bodies.ts",
        nextPath: "src/codegen/array/array-fill-proto-value.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1904,
    currentFileCount: 1905,
    additions: [
      {
        index: 202,
        row: {
          path: "src/codegen/array/array-sort-value.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.",
        },
        previousPath: "src/codegen/array/array-copy-methods-value.ts",
        nextPath: "src/codegen/array/array-fill-proto-value.ts",
      },
    ],
    layers: [],
  },
  {
    beforeFileCount: 1905,
    currentFileCount: 1906,
    additions: [
      {
        index: 354,
        row: {
          path: "src/codegen/closures/closure-type-sources.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previousPath: "src/codegen/closures/closure-header-layout.ts",
        nextPath: "src/codegen/closures/conditional-capture-box.ts",
      },
    ],
    layers: [],
  },
] as const;

type PrerequisiteSectionName = "cabiSource" | "policySource";
function validatePrerequisiteSection(value: unknown, name: PrerequisiteSectionName): Data {
  const source = keys(value, ["path", "beforePin", "currentPin", "epochs"], name);
  const contracts = name === "cabiSource" ? cabiSourceEpochContracts : policySourceEpochContracts;
  const path = name === "cabiSource" ? "src/codegen-linear/c-abi.ts" : "scripts/compiler-boundaries.json";
  if (
    source.path !== path ||
    !same(validatePin(source.beforePin, name + " before"), contracts[0].beforePin) ||
    !same(validatePin(source.currentPin, name + " current"), contracts[contracts.length - 1]!.currentPin)
  )
    fail(name + " fixed source domain");
  const epochs = array(source.epochs, name + " epochs");
  if (epochs.length !== contracts.length) fail(name + " fixed epoch count");
  for (const [index, value] of epochs.entries()) {
    const epoch = keys(value, ["commit", "parent", "beforePin", "currentPin", "inverse", "forward"], name + " epoch");
    const contract = contracts[index]!;
    if (
      epoch.commit !== contract.commit ||
      epoch.parent !== contract.parent ||
      !same(validatePin(epoch.beforePin, name), contract.beforePin) ||
      !same(validatePin(epoch.currentPin, name), contract.currentPin) ||
      (index > 0 && !same(contract.beforePin, contracts[index - 1]!.currentPin))
    )
      fail(name + " fixed epoch identity/pins");
    for (const direction of ["inverse", "forward"] as const) {
      const spans = array(epoch[direction], name + " " + direction);
      if (!spans.length) fail(name + " missing " + direction);
      for (const span of spans) keys(span, ["inputOffset", "outputOffset", "from", "to"], name + " span");
    }
  }
  return source;
}
function prerequisitePolicySemantic(beforeRaw: string, currentRaw: string, index: number, stage: string): void {
  const before = keys(
    parseJson(beforeRaw, stage + " before"),
    [...prerequisitePolicyTopLevelKeys],
    stage + " before policy",
  );
  const current = keys(
    parseJson(currentRaw, stage + " current"),
    [...prerequisitePolicyTopLevelKeys],
    stage + " current policy",
  );
  const rule = prerequisitePolicySemanticRules[index]!;
  const beforeFiles = array(before.files, stage + " before files"),
    currentFiles = array(current.files, stage + " current files");
  if (beforeFiles.length !== rule.beforeFileCount || currentFiles.length !== rule.currentFileCount)
    fail(stage + " semantic file counts");
  const removed = new Set<number>();
  for (const addition of rule.additions) {
    const at: number = addition.index;
    const row = currentFiles[at];
    const previous = at === 0 ? null : (currentFiles[at - 1] as Data)?.path;
    const next = at + 1 === currentFiles.length ? null : (currentFiles[at + 1] as Data)?.path;
    if (
      removed.has(addition.index) ||
      !same(row, addition.row) ||
      previous !== addition.previousPath ||
      next !== addition.nextPath
    )
      fail(stage + " semantic ordered row/neighbors");
    removed.add(addition.index);
  }
  if (
    !same(
      currentFiles.filter((_, at) => !removed.has(at)),
      beforeFiles,
    )
  )
    fail(stage + " semantic retained file rows");
  const beforeLayers = array(before.layers, stage + " before layers"),
    currentLayers = array(current.layers, stage + " current layers");
  if (beforeLayers.length !== currentLayers.length) fail(stage + " semantic layer count");
  const replayLayers = JSON.parse(JSON.stringify(beforeLayers)) as Data[];
  for (const change of rule.layers) {
    const old = beforeLayers[change.index] as Data,
      actual = currentLayers[change.index] as Data;
    if (old?.id !== change.id || actual?.id !== change.id || !same(Reflect.ownKeys(old), Reflect.ownKeys(actual)))
      fail(stage + " semantic layer identity/keys");
    for (const field of change.fields) {
      if (
        !same(old[field], (change.beforeValues as Data)[field]) ||
        !same(actual[field], (change.currentValues as Data)[field])
      )
        fail(stage + " semantic changed layer field: " + change.id + "/" + field);
      replayLayers[change.index]![field] = actual[field];
    }
  }
  if (!same(replayLayers, currentLayers)) fail(stage + " semantic unrelated layer drift");
  const replay = { ...before, files: currentFiles, layers: replayLayers };
  if (!same(replay, current)) fail(stage + " complete semantic replay/retained content");
}
function prerequisiteSourceBefore(rawCurrent: string, reader: AuthorityReader, name: PrerequisiteSectionName): string {
  const receipt = captureGeometrySuccessor(reader);
  const source = validatePrerequisiteSection(receipt[name], name);
  requirePin(rawCurrent, validatePin(source.currentPin, name), name + " supplied current");
  const physical = readText(reader, source.path as string);
  requirePin(physical, validatePin(source.currentPin, name), name + " actual current");
  if (physical !== rawCurrent) fail(name + " supplied current differs from authority");
  const epochs = array(source.epochs, name + " epochs") as Data[];
  let before = rawCurrent;
  const authenticatedCurrents: string[] = [];
  for (let index = epochs.length - 1; index >= 0; index--) {
    const epoch = epochs[index]!;
    const stage = name + " inverse epoch " + (index + 1);
    requirePin(before, validatePin(epoch.currentPin, stage), stage + " input");
    authenticatedCurrents[index] = before;
    const predecessor = geometryInstrumentReplay(before, epoch.inverse, validatePin(epoch.beforePin, stage), stage);
    if (name === "policySource") prerequisitePolicySemantic(predecessor, before, index, stage);
    before = predecessor;
  }
  requirePin(before, validatePin(source.beforePin, name), name + " complete authentic predecessor");
  let replay = before;
  for (const [index, epoch] of epochs.entries()) {
    const stage = name + " forward epoch " + (index + 1);
    requirePin(replay, validatePin(epoch.beforePin, stage), stage + " input");
    const current = geometryInstrumentReplay(replay, epoch.forward, validatePin(epoch.currentPin, stage), stage);
    if (current !== authenticatedCurrents[index]) fail(stage + " independent complete equality");
    if (name === "policySource") prerequisitePolicySemantic(replay, current, index, stage);
    replay = current;
  }
  if (replay !== rawCurrent) fail(name + " independent complete source equality");
  return before;
}
/** Only the exact two-epoch current C-ABI source; historical readers retain the original API route. */
export function captureC1LinearCabiPredecessor(
  rawCurrent: string,
  readAuthority: AuthorityReader = readActual,
): string {
  if (typeof rawCurrent !== "string") fail("C-ABI source must be a primitive string");
  if (typeof readAuthority !== "function") fail("C-ABI authority reader must be callable");
  return prerequisiteSourceBefore(rawCurrent, readAuthority, "cabiSource");
}
/** Eighteen fixed current-main/geometry epochs; the unchanged downstream Deno API is not called here. */
export function captureGeometryCurrentMainPredecessorPolicySource(
  rawCurrent: string,
  readAuthority: AuthorityReader = readActual,
): string {
  if (typeof rawCurrent !== "string") fail("current-main geometry policy must be a primitive string");
  if (typeof readAuthority !== "function") fail("current-main geometry policy authority reader must be callable");
  return prerequisiteSourceBefore(rawCurrent, readAuthority, "policySource");
}
