// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { captureWasmGcHelperPredecessorPolicySource } from "./helpers/ir-runtime-program-policy-evolution.js";
import { captureProgramValidatorPredecessorPolicySource } from "./helpers/ir-runtime-program-policy-evolution.js";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateNestedStackificationPolicyEvolution,
  captureNestedStackificationPredecessorPolicy,
  captureNestedStackificationPredecessorPolicySource,
  beforeCanonical489dInventoryPolicy,
  beforeCanonical489dInventoryPolicySource,
  type MutableIrRuntimeProgramPolicy as Policy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
// Independent fixed authority literals from the root-frozen receipt, never from API outputs or mutants.
const expected = {
  schema: 1,
  kind: "fixed-nested-stackification-policy-relocation",
  provenance: {
    canonicalMain: "f710603e1c11101d0135274c6218ca36cb64fa37",
    preparedHead: "c59ceb6c0c579824d903ab8746c588658cba0a6b",
    planSha256: "3e2098994389c33e4543c3dd482bf196f874fe8e1e1a9ce74dd13189e284f223",
    legacyRetained: true,
  },
  before: {
    source: {
      bytes: 579411,
      sha256: "82cc93fe5db9e58c118c46fc85db6b3cd4e09656c347358f8334945e70a99d40",
      gitBlob: "9b8282d67bd0d06b1c27ad005ec27c220c1c0d18",
    },
    dataSha256: "f0d41bf5acb4d3378a4b2fa18dd06c5e0720b52deb781ae97ee53dcc0594944c",
    fileCount: 1813,
    filesSha256: "8e5de381a3bd0165b308077ce119567fa9f4804d5143c7fcecec34118224021b",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  current: {
    source: {
      bytes: 580511,
      sha256: "81a0d94238a16cb762befa909ff057fc55d2da720996cf04af196bdd50cff7b2",
      gitBlob: "dfedad8b2e98a9479409b351db8399a342505e19",
    },
    dataSha256: "d0891226c6e20ecf3868f9979a39b68722fe240a6e3394ea953c86ab1d1754de",
    fileCount: 1814,
    filesSha256: "a7fa1f5391015e87db1b70f61b965b737c0e32f917be41630e40dcf75337cef6",
    activationCount: 102,
    activationHistorySha256: "9a7e77fdc8c67fc0683879feb8bac8a9ef7854e9b083ac0c7e9affa4ddb24020",
    layersSha256: "e7246f81b16f524db95bddcb8bf0d01faf17834948744b2a3a4bdd79b912984e",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 228005,
    sha256: "2ccb2f22084b78c45a4550b8b4e3b7048748a1e719b357155883a35e5030bea3",
    gitBlob: "c762f24f20ba032a081575ac10f04d06967cc538",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-canonical-489d.json",
    bytes: 14714,
    sha256: "52dc8a9359369565c5d1f39f01af8d9c8d853aa1e4b0a1f469622e350f3a7497",
    gitBlob: "3334ebc183519f391958b5ae34e09a85c99dc5bf",
  },
  sourcePins: [
    {
      path: "src/ir/nested-stackification.ts",
      bytes: 254,
      sha256: "4c7169e9b6b523c79b3491258e7561b72e27ebea4a8e30156002f512bd87aaf4",
      gitBlob: "def6a1d232547bbef072fd34391bf70c3f1ca57d",
    },
    {
      path: "src/ir/analysis/nested-stackification.ts",
      bytes: 3576,
      sha256: "eef74f625cb5edec3b0ff554e6b2d7546af26adbf85df6cac962a6facbfc3327",
      gitBlob: "3b6dc27662c9b8ee88975192181dd99211e7b0dc",
    },
  ],
  originalImplementation: {
    bytes: 3570,
    sha256: "f66f42492cb6aaf0c55ad3681289802c1e598ea98119edc975bd37618c905a33",
    gitBlob: "7da4f65d24f07fd2fdf08266680ceacbcb07ac87",
  },
  sourceInverse: {
    before: 'from "./nodes.js";',
    after: 'from "../core/nodes.js";',
    beforeOffset: 212,
    afterOffset: 212,
    completeInverseReplay: true,
  },
  facadeSource:
    '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\nexport { stackifyMovableNestedValues } from "./analysis/nested-stackification.js";\nexport type { NestedStackificationInput } from "./analysis/nested-stackification.js";\n',
  topLevelKeys: [
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
  ],
  delta: {
    layerIndex: 6,
    beforeLayer: {
      id: "ir-analysis",
      status: "active",
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
      ],
      required: true,
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
      ],
      minModules: 11,
    },
    currentLayer: {
      id: "ir-analysis",
      status: "active",
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
      ],
      required: true,
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
      ],
      minModules: 12,
    },
    activationIndex: 0,
    activation: {
      layer: "ir-analysis",
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
      ],
      minModules: 12,
    },
    moveIndex: 0,
    move: {
      from: "src/ir/nested-stackification.ts",
      to: "src/ir/analysis/nested-stackification.ts",
    },
    newRowIndex: 59,
    newRow: {
      path: "src/ir/analysis/nested-stackification.ts",
      state: "clean",
      layer: "ir-analysis",
    },
    newRowPrevious: {
      path: "src/ir/analysis/effects.ts",
      state: "clean",
      layer: "ir-analysis",
    },
    newRowNext: {
      path: "src/ir/analysis/intrinsics.ts",
      state: "clean",
      layer: "ir-analysis",
    },
    oldFacadeBeforeIndex: 1301,
    oldFacadeCurrentIndex: 1302,
    beforeFacade: {
      path: "src/ir/nested-stackification.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "ir-core",
      owner: "3518-coordinator",
      nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
    },
    currentFacade: {
      path: "src/ir/nested-stackification.ts",
      state: "compatibility-adapter",
      layer: "mixed-needs-split",
      destination: "ir-analysis",
      owner: "3518-coordinator",
      nextBoundary:
        "The unchanged stackification implementation and input type live in analysis/nested-stackification.ts. Retain this explicit same-identity compatibility export until existing consumers migrate and full IR parity is proved.",
    },
    facadePrevious: {
      path: "src/ir/module-init.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "ir-core",
      owner: "3518-coordinator",
      nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
    },
    facadeNext: {
      path: "src/ir/nodes.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "ir-core",
      owner: "3518-coordinator",
      nextBoundary:
        "The complete semantic instruction/function closure lives in src/ir/core/nodes.ts and its activated pure dependencies. Retain old prepared-function aliases while prepared runtime attachments and program preparation remain mixed debt. irValSigned and isDynamic remain here with unresolved production-caller obligations.",
    },
  },
  rawSpans: [
    {
      beforeOffset: 4187,
      afterOffset: 4187,
      before:
        '    {\n      "id": "ir-analysis",\n      "status": "active",\n      "roots": [\n        "src/ir/analysis/contracts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts"\n      ],\n      "required": true,\n      "entries": [\n        "src/ir/analysis/contracts/allocations.ts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts"\n      ],\n      "minModules": 11\n    },\n',
      after:
        '    {\n      "id": "ir-analysis",\n      "status": "active",\n      "roots": [\n        "src/ir/analysis/contracts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts",\n        "src/ir/analysis/nested-stackification.ts"\n      ],\n      "required": true,\n      "entries": [\n        "src/ir/analysis/contracts/allocations.ts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts",\n        "src/ir/analysis/nested-stackification.ts"\n      ],\n      "minModules": 12\n    },\n',
      beforeSha256: "23f8d181cf2d503365411f5991bec56419c10c25f990bd3133f75e93d4b778e2",
      afterSha256: "d7cba84f80ffcc2f8ef775e838a9c0b117e306a80dd01f708c8cb9c982c31eba",
    },
    {
      beforeOffset: 25457,
      afterOffset: 25561,
      before:
        '    {\n      "layer": "backend-wasmgc",\n      "entries": ["src/backend/wasmgc/resources/native-delay-combinator.ts"],\n      "minModules": 15\n    },\n',
      after:
        '    {\n      "layer": "ir-analysis",\n      "entries": [\n        "src/ir/analysis/contracts/allocations.ts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts",\n        "src/ir/analysis/nested-stackification.ts"\n      ],\n      "minModules": 12\n    },\n    {\n      "layer": "backend-wasmgc",\n      "entries": ["src/backend/wasmgc/resources/native-delay-combinator.ts"],\n      "minModules": 15\n    },\n',
      beforeSha256: "cb056d8676f66da8e0921f20fd39ccd62e25c9475872817cef92d33f108b257a",
      afterSha256: "8fd7b8d2a608dd93a627e28652bc8fea8e4d69aaf7c8adc9219d1ba88f593e25",
    },
    {
      beforeOffset: 66604,
      afterOffset: 67313,
      before:
        '    {\n      "from": "src/codegen/prepared-async-frame-engine.ts",\n      "to": "src/runtime/wasmgc/async/prepared-async-frame-engine.ts"\n    },\n',
      after:
        '    {\n      "from": "src/ir/nested-stackification.ts",\n      "to": "src/ir/analysis/nested-stackification.ts"\n    },\n    {\n      "from": "src/codegen/prepared-async-frame-engine.ts",\n      "to": "src/runtime/wasmgc/async/prepared-async-frame-engine.ts"\n    },\n',
      beforeSha256: "daa29a12281d9a4dd2971886df7fc30a06b8b8d4c1019dfcdfb6973d6d11c6fe",
      afterSha256: "02f457ad8200b11e4c258bcbb6a2b637d01e68fbfe32b693a94a15b890fb6c03",
    },
    {
      beforeOffset: 77080,
      afterOffset: 77906,
      before:
        '    {\n      "path": "src/ir/analysis/intrinsics.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n',
      after:
        '    {\n      "path": "src/ir/analysis/nested-stackification.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/intrinsics.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n',
      beforeSha256: "aa5882a40e3bc07f264d6c5648a018f2ff07e12f8ebd2a82d4dd7732cf9b8bb9",
      afterSha256: "ea597838ef4583b0f673b4a4ee8f21a9400ffcdab956c4d4fd85386a98da0100",
    },
    {
      beforeOffset: 458975,
      afterOffset: 459925,
      before:
        '    {\n      "path": "src/ir/nested-stackification.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-core",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n    },\n',
      after:
        '    {\n      "path": "src/ir/nested-stackification.ts",\n      "state": "compatibility-adapter",\n      "layer": "mixed-needs-split",\n      "destination": "ir-analysis",\n      "owner": "3518-coordinator",\n      "nextBoundary": "The unchanged stackification implementation and input type live in analysis/nested-stackification.ts. Retain this explicit same-identity compatibility export until existing consumers migrate and full IR parity is proved."\n    },\n',
      beforeSha256: "1526eb4052d5643c0637a9928a84662be4f5e9c9a2a7685b35f318df7e8f66e5",
      afterSha256: "c56e1ef62cf0ba598eab976b7e10d39118f45a64c877065e8852c2399b3b34d1",
    },
  ],
} as const;
const receiptPath = "tests/helpers/ir-runtime-program-policy-nested-stackification.json";
const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";
const receiptSha256 = "b88978d331ba72939f67a78f0091cf32b746c5ac276e29ecb24b3adbc98efdf3";
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const raw = (): string => {
  const text = captureProgramValidatorPredecessorPolicySource(
    captureWasmGcHelperPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
  );
  expect(Buffer.byteLength(text)).toBe(580511);
  expect(sha(text)).toBe("81a0d94238a16cb762befa909ff057fc55d2da720996cf04af196bdd50cff7b2");
  return text;
};
const policy = (): Policy => JSON.parse(raw());
function profile(p: Policy, current: boolean): void {
  const pin = current ? expected.current : expected.before;
  expect(sha(JSON.stringify(p))).toBe(pin.dataSha256);
  expect(p.files).toHaveLength(pin.fileCount);
  expect(p.activationHistory).toHaveLength(pin.activationCount);
  expect(sha(JSON.stringify(p.files))).toBe(pin.filesSha256);
  expect(sha(JSON.stringify(p.layers))).toBe(pin.layersSha256);
  expect(sha(JSON.stringify(p.activationHistory))).toBe(pin.activationHistorySha256);
  expect(sha(JSON.stringify(p.allowedEdges))).toBe(pin.allowedEdgesSha256);
}
function independentSemantic(p: Policy): Policy {
  const result = clone(p);
  result.layers[6] = clone(expected.delta.beforeLayer) as Policy["layers"][number];
  result.activationHistory.splice(0, 1);
  (result.moves as unknown[]).splice(0, 1);
  result.files[1302] = clone(expected.delta.beforeFacade);
  result.files.splice(59, 1);
  return result;
}
function independentReplay(p: Policy): Policy {
  const result = clone(p);
  result.layers[6] = clone(expected.delta.currentLayer) as Policy["layers"][number];
  result.activationHistory.splice(0, 0, clone(expected.delta.activation) as Policy["activationHistory"][number]);
  (result.moves as unknown[]).splice(0, 0, clone(expected.delta.move));
  result.files.splice(59, 0, clone(expected.delta.newRow));
  result.files[1302] = clone(expected.delta.currentFacade);
  return result;
}
function independentRaw(text: string, forward: boolean): string {
  const bytes = Buffer.from(text, "utf8"),
    pieces: Buffer[] = [];
  let consumed = 0;
  for (const span of expected.rawSpans) {
    const at = forward ? span.beforeOffset : span.afterOffset;
    const from = Buffer.from(forward ? span.before : span.after);
    const to = Buffer.from(forward ? span.after : span.before);
    expect(at).toBeGreaterThanOrEqual(consumed);
    expect(bytes.subarray(at, at + from.length).equals(from)).toBe(true);
    expect(bytes.indexOf(from)).toBe(at);
    expect(bytes.lastIndexOf(from)).toBe(at);
    pieces.push(bytes.subarray(consumed, at), to);
    consumed = at + from.length;
  }
  pieces.push(bytes.subarray(consumed));
  return Buffer.concat(pieces).toString("utf8");
}
const physical = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const physicalFaultAuthorities = [
  receiptPath,
  helperPath,
  "src/ir/nested-stackification.ts",
  "src/ir/analysis/nested-stackification.ts",
];
function expectMissingAuthority(action: () => void, path: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "ENOENT", path: physical(path) });
}
/** Synchronous, checkout-exclusive real faults; retain recovery bytes/lock on any unsafe restore. */
function withAuthorityFault(path: string, kind: "mutation" | "missing", action: () => void, byte: 0 = 0): void {
  if (!physicalFaultAuthorities.includes(path)) throw new Error("unapproved current-main authority fault: " + path);
  if (
    ![0].includes(byte) ||
    (byte !== 0 && (path !== "tests/helpers/ir-runtime-program-policy-evolution.ts" || kind !== "mutation"))
  )
    throw new Error("unapproved current-main authority fault byte");
  const target = physical(path);
  const scratch = resolve(import.meta.dirname, "../.tmp/nested-owner/nested-stackification-policy-authority-faults");
  mkdirSync(scratch, { recursive: true });
  const lock = join(scratch, "checkout.lock");
  // Exclusive creation fails closed if another operation owns this checkout.
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  let backupDirectory: string | undefined;
  let backup: string | undefined;
  let restored = true;
  const failures: unknown[] = [];
  const cleanupRestoredFault = (): void => {
    if (backup) {
      // Missing-input restoration renames the sole original out of this operation directory.
      try {
        lstatSync(backup);
        unlinkSync(backup);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (backupDirectory) rmdirSync(backupDirectory);
    unlinkSync(lock);
  };
  try {
    const initial = lstatSync(target);
    if (!initial.isFile() || initial.isSymbolicLink())
      throw new Error("authority target must be a regular non-symlink file: " + target);
    const original = readFileSync(target);
    const pin =
      path === receiptPath
        ? { bytes: 15523, sha256: receiptSha256 }
        : path === helperPath
          ? expected.helperPrefix
          : expected.sourcePins.find((item) => item.path === path)!;
    const authenticated = path === helperPath ? original.subarray(0, 228005) : original;
    expect(authenticated.length).toBe(pin.bytes);
    expect(createHash("sha256").update(authenticated).digest("hex")).toBe(pin.sha256);
    const mode = initial.mode & 0o7777;
    const mutated = Buffer.from(original);
    if (mutated.length === 0) throw new Error("empty authority target: " + target);
    if (byte >= mutated.length) throw new Error("authority fault byte outside target");
    mutated[byte] = mutated[byte]! ^ 1;
    backupDirectory = mkdtempSync(join(scratch, "operation-"));
    backup = join(backupDirectory, "original");
    const recovery = backup;
    writeFileSync(lock, JSON.stringify({ path, kind, backup }) + "\n", {
      flag: "r+",
    });
    const verifyTarget = (bytes: Buffer): void => {
      const stat = lstatSync(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.ino !== initial.ino ||
        stat.dev !== initial.dev ||
        (stat.mode & 0o7777) !== mode ||
        !readFileSync(target).equals(bytes)
      )
        throw new Error("unexpected authority edit; refusing to overwrite: " + target);
    };
    const restoreFault = (): void => {
      const saved = lstatSync(recovery);
      if (
        !saved.isFile() ||
        saved.isSymbolicLink() ||
        (saved.mode & 0o7777) !== mode ||
        !readFileSync(recovery).equals(original)
      )
        throw new Error("recovery copy differs from captured authority");
      if (kind === "mutation") {
        verifyTarget(mutated);
        writeFileSync(target, original);
        chmodSync(target, mode);
      } else {
        expectMissingAuthority(() => {
          lstatSync(target);
        }, path);
        if (saved.ino !== initial.ino || saved.dev !== initial.dev)
          throw new Error("renamed authority identity changed");
        renameSync(recovery, target);
        chmodSync(target, mode);
      }
      verifyTarget(original);
      restored = true;
    };
    verifyTarget(original);
    if (kind === "mutation") {
      writeFileSync(recovery, original, { flag: "wx", mode });
      chmodSync(recovery, mode);
    }
    restored = false;
    try {
      if (kind === "mutation") {
        writeFileSync(target, mutated);
        chmodSync(target, mode);
        verifyTarget(mutated);
        if (byte === 0) {
          expect(mutated[0]).not.toBe(original[0]);
          expect(mutated.subarray(1).equals(original.subarray(1))).toBe(true);
        } else {
          expect(mutated[byte]).not.toBe(original[byte]);
          expect(mutated.subarray(0, byte).equals(original.subarray(0, byte))).toBe(true);
          expect(mutated.subarray(byte + 1).equals(original.subarray(byte + 1))).toBe(true);
        }
      } else {
        renameSync(target, recovery);
        expectMissingAuthority(() => {
          readFileSync(target);
        }, path);
        expect(() => lstatSync(target)).toThrow(/ENOENT/);
      }
      action();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        restoreFault();
      } catch (error) {
        failures.push(
          new Error(
            "authority restoration failed; recovery retained at " + backup + "; checkout lock retained at " + lock,
            { cause: error },
          ),
        );
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (restored) {
      try {
        cleanupRestoredFault();
      } catch (error) {
        failures.push(
          new Error("authority cleanup failed; checkout lock/recovery retained at " + lock + " / " + backup, {
            cause: error,
          }),
        );
      }
    }
  }
  // Propagate only after every safe restoration/cleanup path has completed.
  if (failures.length > 1) throw new AggregateError(failures, "authority operation and recovery failures: " + target);
  if (failures.length === 1) throw failures[0];
}

const rawReorderDestinations = [21058, 66890, 68046, 580384, 580384] as const;
afterEach(async () => {
  await setImmediate();
});
describe("fixed nested stackification policy relocation", () => {
  it("independently reconstructs and replays the complete semantic1813 predecessor", () => {
    expect(Buffer.byteLength(read(receiptPath))).toBe(15523);
    expect(sha(read(receiptPath))).toBe(receiptSha256);
    expect(authenticateNestedStackificationPolicyEvolution()).toEqual(expected);
    const current = policy(),
      independent = independentSemantic(current);
    profile(current, true);
    profile(independent, false);
    expect(Object.keys(current)).toEqual(expected.topLevelKeys);
    expect(current.layers[6]).toEqual(expected.delta.currentLayer);
    expect(current.activationHistory[0]).toEqual(expected.delta.activation);
    expect((current.moves as unknown[])[0]).toEqual(expected.delta.move);
    expect(current.files[59]).toEqual(expected.delta.newRow);
    expect(current.files[1302]).toEqual(expected.delta.currentFacade);
    expect(independent.files[1301]).toEqual(expected.delta.beforeFacade);
    expect(independentReplay(independent)).toEqual(current);
    const captured = captureNestedStackificationPredecessorPolicy(current);
    expect(captured).toEqual(independent);
    expect(captured).not.toBe(current);
    expect(captured.files).not.toBe(current.files);
    // Genuine unchanged489d full proof still accepts this returned parent domain.
    const prior = beforeCanonical489dInventoryPolicy(captured);
    expect(prior.files).toHaveLength(1808);
    expect(sha(JSON.stringify(prior))).toBe("4cf6541e0c4677135d54cc2aa47b29763122e4fc416caff66c6165d3cb1e33ac");
    profile(current, true);
  });
  it("independently proves UTF8 raw reciprocity and exact canonical owner source inverse", () => {
    const current = raw(),
      predecessor = independentRaw(current, false);
    expect(Buffer.byteLength(predecessor)).toBe(579411);
    expect(sha(predecessor)).toBe("82cc93fe5db9e58c118c46fc85db6b3cd4e09656c347358f8334945e70a99d40");
    expect(independentRaw(predecessor, true)).toBe(current);
    expect(captureNestedStackificationPredecessorPolicySource(current)).toBe(predecessor);
    expect(JSON.parse(predecessor)).toEqual(independentSemantic(JSON.parse(current)));
    const priorRaw = beforeCanonical489dInventoryPolicySource(predecessor);
    expect(Buffer.byteLength(priorRaw)).toBe(577771);
    expect(sha(priorRaw)).toBe("2573c40f37d35a8996dab8cfb7ac5c94ef1b57be0f664845878b21e2b516777a");
    expect(read(expected.sourcePins[0].path)).toBe(expected.facadeSource);
    const owner = read(expected.sourcePins[1].path);
    expect(owner.indexOf('from "../core/nodes.js";')).toBe(212);
    expect(owner.lastIndexOf('from "../core/nodes.js";')).toBe(212);
    const original = owner.replace('from "../core/nodes.js";', 'from "./nodes.js";');
    expect(Buffer.byteLength(original)).toBe(3570);
    expect(sha(original)).toBe("f66f42492cb6aaf0c55ad3681289802c1e598ea98119edc975bd37618c905a33");
    expect(original.replace('from "./nodes.js";', 'from "../core/nodes.js";')).toBe(owner);
  });
  it("refuses a stale1813 semantic parent as current input", () => {
    expect(() => captureNestedStackificationPredecessorPolicy(independentSemantic(policy()))).toThrow(
      "nested stackification policy evolution: complete policy profile mismatch",
    );
  });
  it("refuses a stale1813 raw parent as current input", () => {
    expect(() => captureNestedStackificationPredecessorPolicySource(independentRaw(raw(), false))).toThrow(
      "nested stackification policy evolution: complete raw source profile mismatch",
    );
  });
  const invalidInputs: readonly { name: string; raw: boolean; make: () => unknown; message: string }[] = [
    { name: "boxed raw", raw: true, make: () => Object(raw()), message: "raw input must be a primitive string" },
    { name: "null", raw: false, make: () => null, message: "policy input must be a plain object" },
    { name: "array", raw: false, make: () => [], message: "policy input must be a plain object" },
    {
      name: "accessor",
      raw: false,
      make: () =>
        Object.defineProperty({}, "field", {
          enumerable: true,
          get: () => {
            throw new Error("getter executed");
          },
        }),
      message: "accessor or hidden policy field",
    },
    { name: "symbol", raw: false, make: () => ({ [Symbol("blocked")]: 1 }), message: "symbol policy key" },
    {
      name: "cycle",
      raw: false,
      make: () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
      message: "non-JSON or cyclic policy",
    },
    { name: "foreign prototype", raw: false, make: () => Object.create(null), message: "foreign prototype" },
    {
      name: "throwing proxy",
      raw: false,
      make: () =>
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("proxy descriptor blocked");
            },
          },
        ),
      message: "proxy descriptor blocked",
    },
  ];
  for (const entry of invalidInputs) {
    it(`refuses ${entry.name} before a missing receipt and proves the paired physicalENOENT`, () => {
      const goodRaw = raw(),
        goodPolicy = JSON.parse(goodRaw),
        invalid = entry.make();
      withAuthorityFault(receiptPath, "missing", () => {
        expect(() =>
          entry.raw
            ? captureNestedStackificationPredecessorPolicySource(invalid as string)
            : captureNestedStackificationPredecessorPolicy(invalid),
        ).toThrow(entry.message);
        expectMissingAuthority(() => {
          if (entry.raw) captureNestedStackificationPredecessorPolicySource(goodRaw);
          else captureNestedStackificationPredecessorPolicy(goodPolicy);
        }, receiptPath);
      });
    });
  }
  const semanticMutations: readonly [string, (p: Policy) => void][] = [
    [
      "analysis roots",
      (p) => {
        p.layers[6]!.roots.pop();
      },
    ],
    [
      "analysis entries",
      (p) => {
        p.layers[6]!.entries!.reverse();
      },
    ],
    [
      "analysis minimum",
      (p) => {
        p.layers[6]!.minModules = 11;
      },
    ],
    [
      "activation",
      (p) => {
        p.activationHistory[0]!.minModules = 11;
      },
    ],
    [
      "move",
      (p) => {
        (p.moves as Record<string, string>[])[0]!.to = "src/ir/core/nested-stackification.ts";
      },
    ],
    [
      "new owner row",
      (p) => {
        p.files[59]!.state = "unmigrated";
      },
    ],
    [
      "old adapter row",
      (p) => {
        p.files[1302]!.destination = "ir-core";
      },
    ],
    [
      "unrelated retained field",
      (p) => {
        p.description = String(p.description) + " changed";
      },
    ],
  ];
  for (const [name, change] of semanticMutations) {
    it(`refuses semantic ${name} mutation`, () => {
      const p = policy();
      change(p);
      expect(() => captureNestedStackificationPredecessorPolicy(p)).toThrow(
        "nested stackification policy evolution: complete policy profile mismatch",
      );
    });
  }
  for (const [index, span] of expected.rawSpans.entries()) {
    for (const kind of ["omission", "duplication", "valid reorder"] as const) {
      it(`refuses raw group${index} ${kind}`, () => {
        const bytes = Buffer.from(raw(), "utf8"),
          start = span.afterOffset;
        const fragment = Buffer.from(span.after, "utf8"),
          end = start + fragment.length;
        expect(bytes.subarray(start, end).equals(fragment)).toBe(true);
        let mutant: Buffer;
        if (kind === "omission") mutant = Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]);
        else if (kind === "duplication")
          mutant = Buffer.concat([bytes.subarray(0, start), fragment, bytes.subarray(start)]);
        else {
          const destination = rawReorderDestinations[index]!;
          expect(destination).toBeGreaterThan(end);
          mutant = Buffer.concat([
            bytes.subarray(0, start),
            bytes.subarray(end, destination),
            fragment,
            bytes.subarray(destination),
          ]);
          expect(mutant.length).toBe(bytes.length);
          expect(mutant.equals(bytes)).toBe(false);
          const before = JSON.parse(bytes.toString("utf8")),
            after = JSON.parse(mutant.toString("utf8"));
          const key = index === 0 ? "layers" : index === 1 ? "activationHistory" : index === 2 ? "moves" : "files";
          const multiset = (values: unknown[]) => values.map((value) => JSON.stringify(value)).sort();
          expect(multiset(after[key])).toEqual(multiset(before[key]));
          expect(after[key]).not.toEqual(before[key]);
        }
        expect(() => JSON.parse(mutant.toString("utf8"))).not.toThrow();
        expect(() => captureNestedStackificationPredecessorPolicySource(mutant.toString("utf8"))).toThrow(
          "nested stackification policy evolution: complete raw source profile mismatch",
        );
      });
    }
  }
  const apis = [
    { name: "semantic", run: (text: string): Policy => captureNestedStackificationPredecessorPolicy(JSON.parse(text)) },
    {
      name: "raw",
      run: (text: string): Policy => JSON.parse(captureNestedStackificationPredecessorPolicySource(text)) as Policy,
    },
  ] as const;
  for (const path of physicalFaultAuthorities) {
    for (const kind of ["missing", "mutation"] as const) {
      for (const api of apis) {
        it(`fresh ${api.name} refuses ${kind} authority ${path} after success`, () => {
          const text = raw();
          profile(api.run(text), false);
          withAuthorityFault(path, kind, () => {
            if (kind === "missing")
              expectMissingAuthority(() => {
                api.run(text);
              }, path);
            else
              expect(() => api.run(text)).toThrow(
                path === receiptPath
                  ? "nested stackification policy evolution: receipt digest mismatch"
                  : path === helperPath
                    ? "nested stackification policy evolution: complete predecessor helper prefix changed"
                    : "nested stackification policy evolution: current source changed: " + path,
              );
          });
          profile(api.run(text), false);
        });
      }
    }
  }
  it("recaptures a mutable semantic caller and refuses after-success retained mutations", () => {
    const p = policy(),
      first = captureNestedStackificationPredecessorPolicy(p);
    profile(first, false);
    p.description = String(p.description) + " changed";
    expect(() => captureNestedStackificationPredecessorPolicy(p)).toThrow("complete policy profile mismatch");
    profile(captureNestedStackificationPredecessorPolicy(policy()), false);
    profile(first, false);
  });
  it("refuses raw whitespace then independently succeeds with fresh canonical bytes", () => {
    const text = raw();
    expect(() => captureNestedStackificationPredecessorPolicySource(text + "\n")).toThrow(
      "complete raw source profile mismatch",
    );
    profile(JSON.parse(captureNestedStackificationPredecessorPolicySource(raw())) as Policy, false);
  });
});
