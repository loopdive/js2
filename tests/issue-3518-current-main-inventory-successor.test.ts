// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { capturePositionFinallyMainPredecessorPolicySource } from "./helpers/ir-position-finally-main-successor.js";
import { capturePositionClassFieldsMainPredecessorPolicySource } from "./helpers/ir-position-class-fields-main-successor.js";
import { captureSourceMapPositionInventoryPredecessorPolicySource } from "./helpers/ir-source-map-position-inventory-successor.js";
import { captureMainInventoryPredecessorPolicySource } from "./helpers/ir-main-inventory-source-successor.js";
import {
  captureArrayBufferIsViewMainPredecessorPolicySource,
  capturePresentationClassificationPredecessorPolicySource,
  captureLoweringAnalysisPredecessorPolicySource,
  captureWasmGcHelperPredecessorPolicySource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
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
  captureNestedStackificationPredecessorPolicySource,
  captureCanonical489dPredecessorPolicySource,
  beforeCanonical3c6InventoryPolicySource,
  authenticateCurrentMainInventoryEvolution,
  beforeCurrentMainInventoryPolicy,
  beforeCurrentMainInventoryPolicySource,
  beforeGeneratorInventoryPolicy,
  beforeGeneratorInventoryPolicySource,
  authenticateGeneratorInventoryPolicy,
  type MutableIrRuntimeProgramPolicy as Policy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
afterEach(async () => {
  await setImmediate();
});
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const receiptPath = "tests/helpers/ir-runtime-program-policy-main-inventory-20261002.json";
const raw = (): string =>
  beforeCanonical3c6InventoryPolicySource(
    captureCanonical489dPredecessorPolicySource(
      captureNestedStackificationPredecessorPolicySource(
        captureProgramValidatorPredecessorPolicySource(
          captureWasmGcHelperPredecessorPolicySource(
            captureLoweringAnalysisPredecessorPolicySource(
              capturePresentationClassificationPredecessorPolicySource(
                captureArrayBufferIsViewMainPredecessorPolicySource(
                  captureMainInventoryPredecessorPolicySource(
                    captureSourceMapPositionInventoryPredecessorPolicySource(
                      capturePositionClassFieldsMainPredecessorPolicySource(
                        capturePositionFinallyMainPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
const policy = (): Policy => JSON.parse(raw());
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown): string => sha(JSON.stringify(value));
// Literal independent expected receipt, fixed before any mutation is inspected.
const expected = {
  schema: 1,
  kind: "fixed-main-inventory-four-row-successor",
  provenance: {
    checkpoint: "bfcf326c9426988e66fa6cc446132ed9ad9c1965",
    inputBase: "6fce22a8bbeaec91828e8b5b6922c3c1b1fa9b97",
    incomingMain: "a93d489420fac74aaba490a249f51251f90584c2",
    sourceInput: "fcf4b188d0bd19f23665a318316af766e641f737",
    planSha256: "25dea34fa24ff59f10b20b5a70da1a2a91061017aa3bcec9be3239c65bc03697",
  },
  before: {
    source: {
      bytes: 568552,
      sha256: "64103a2fb337874fd435614d461bdd0d46cdfdc8a8dbd61603a4c7cbaf3915ff",
      gitBlob: "b9b8b1787cc202906c4e76cebc598cf460a7f0ae",
    },
    dataSha256: "2f35e7e2045dd0d024a13b48c8f413fc7fb9e74c63503fafee4e56993d1da1a6",
    fileCount: 1780,
    filesSha256: "bcd724252a8ff0cdf6799b01f7e0b9eeceead2c6a3e1f49f9625de233b6710e6",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  current: {
    source: {
      bytes: 569224,
      sha256: "68b09ea540cbd7c40c2d42d66071b5c096a992729afa865d143bba5d8f894c91",
      gitBlob: "6dfe8603219039d3be53ff7c8804dbd58fa8534a",
    },
    dataSha256: "e0f089362ce0e56697978858e2d2ab1767b9cf53425f60b76a8cd2d5d17f8057",
    fileCount: 1782,
    filesSha256: "d9bb59233a38f7e4f074e54b9f1b22761fff2fc00b7805a62e910b4a1fefa02e",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 94912,
    sha256: "8b7b061100ffe195437058401fa904a65ccee3302322a97aae899e51f5d84f68",
    gitBlob: "8e979e9b3f6bb6831df63bf6a65c38a6098e6a85",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json",
    bytes: 4693,
    sha256: "5d78bc26201d43531d1a299d42f0ac0ae91a638de71620b94f675378572ccc8c",
    gitBlob: "e1ceeb12d63073f2f19b714c4e988dd3e2b4e26d",
  },
  sourcePins: [
    {
      path: "src/codegen/class-builtin-species-read.ts",
      bytes: 2143,
      sha256: "12ddf3f2e454845b58f8d2669533d2dd0e596d1d8ccbda1a43cb960e83da31eb",
      gitBlob: "5a7d3ef78ee34bc7fce3d0d6d92911907141f49f",
    },
    {
      path: "src/codegen/date-proto-to-json.ts",
      bytes: 6733,
      sha256: "448717146265ea56a128eaef010338f6511a03ea61230f830deb8179f27f7e2b",
      gitBlob: "4a587c01bc1e68ea519c5e9b290a5d389d3ce13b",
    },
    {
      path: "src/codegen/expressions/to-primitive-method-call.ts",
      bytes: 4481,
      sha256: "fb45a5292e6275ca40b3ee5d190bdd88ecedc6cba933d6b6dc5640b0162d4001",
      gitBlob: "0e3f192257e0437b29fce56205a129529587f4d3",
    },
  ],
  rowChanges: [
    {
      operation: "addition",
      beforeIndex: 366,
      currentIndex: 366,
      row: {
        path: "src/codegen/class-builtin-species-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/date-parse-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/date-proto-to-primitive.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/date-parse-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/date-proto-to-json.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 366,
      currentIndex: 367,
      row: {
        path: "src/codegen/date-proto-to-json.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/date-parse-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/date-proto-to-primitive.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/class-builtin-species-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/date-proto-to-primitive.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 512,
      currentIndex: 514,
      row: {
        path: "src/codegen/expressions/to-primitive-method-call.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/expressions/this-keyword.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/expressions/transferred-native-proto-call.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/expressions/this-keyword.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/expressions/transferred-native-proto-call.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "removal",
      beforeIndex: 1381,
      currentIndex: 1384,
      row: {
        path: "src/runtime-containment.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
      beforePrevious: {
        path: "src/resolve/consumer-driven-barrels.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
      beforeNext: {
        path: "src/runtime-eval.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
      currentPrevious: {
        path: "src/resolve/consumer-driven-barrels.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
      currentNext: {
        path: "src/runtime-eval.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
    },
  ],
  raw: {
    spans: [
      {
        beforeOffset: 162175,
        afterOffset: 162175,
        before: "",
        after:
          '    {\n      "path": "src/codegen/class-builtin-species-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/date-proto-to-json.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "6f6dd24f93539ececc43e1423a466543e5e42e4051f56b33b3954e1c5da0193c",
      },
      {
        beforeOffset: 209899,
        afterOffset: 210539,
        before: "",
        after:
          '    {\n      "path": "src/codegen/expressions/to-primitive-method-call.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "c7a524e5649650927432dc4be13732268461780e960355dc3b45faf2a4b4db31",
      },
      {
        beforeOffset: 485383,
        afterOffset: 486357,
        before:
          '    {\n      "path": "src/runtime-containment.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Review the frontend, orchestration, runtime and shared-contract split before migration."\n    },\n',
        after: "",
        beforeSha256: "45f82bcd707e361470f6ea1ee6543cb54c2a0f5dd248c5b1583499a7b3b38cce",
        afterSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    ],
  },
} as const;
const primitiveReceiptPin = {
  bytes: 12856,
  sha256: "b14b779229974856210fb3907aab7c7d0d97537c3f9d8a6324b083f3b3ef8c5e",
};
const physical = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const physicalFaultAuthorities: readonly string[] = [
  "tests/helpers/ir-runtime-program-policy-main-inventory-20261002.json",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
  "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json",
  "src/codegen/class-builtin-species-read.ts",
  "src/codegen/date-proto-to-json.ts",
  "src/codegen/expressions/to-primitive-method-call.ts",
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
function withAuthorityFault(
  path: string,
  kind: "mutation" | "missing",
  action: () => void,
  byte: 0 | 5477 | 5585 | 94640 = 0,
): void {
  if (!physicalFaultAuthorities.includes(path)) throw new Error("unapproved current-main authority fault: " + path);
  if (
    ![0, 5477, 5585, 94640].includes(byte) ||
    (byte !== 0 && (path !== "tests/helpers/ir-runtime-program-policy-evolution.ts" || kind !== "mutation"))
  )
    throw new Error("unapproved current-main authority fault byte");
  const target = physical(path);
  const scratch = resolve(import.meta.dirname, "../.tmp/c1-main-epoch/physical-authority-faults");
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
    const mode = initial.mode & 0o7777;
    const mutated = Buffer.from(original);
    if (mutated.length === 0) throw new Error("empty authority target: " + target);
    if (byte >= mutated.length) throw new Error("authority fault byte outside target");
    mutated[byte] = mutated[byte]! ^ 1;
    backupDirectory = mkdtempSync(join(scratch, "operation-"));
    backup = join(backupDirectory, "original");
    const recovery = backup;
    writeFileSync(lock, JSON.stringify({ path, kind, backup }) + "\n", { flag: "r+" });
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

function acceptAll(p = policy(), text = raw()): void {
  expect(authenticateCurrentMainInventoryEvolution()).toEqual(expected);
  const previous = beforeCurrentMainInventoryPolicy(p);
  const previousRaw = beforeCurrentMainInventoryPolicySource(text);
  expect(JSON.parse(previousRaw)).toEqual(previous);
  expect(authenticateGeneratorInventoryPolicy(previous)).toEqual(previous);
}
function rejectSemantic(p: Policy): void {
  expect(() => beforeCurrentMainInventoryPolicy(p)).toThrow(
    "current main inventory evolution: complete policy profile mismatch",
  );
  expect(() => beforeCurrentMainInventoryPolicySource(JSON.stringify(p))).toThrow(
    "current main inventory evolution: complete raw source profile mismatch",
  );
}
function removeEpochWithoutAuthenticating(p: Policy): Policy {
  p.files.splice(1384, 0, clone(expected.rowChanges[3].row));
  for (const i of [514, 367, 366]) p.files.splice(i, 1);
  return p;
}
describe("fixed current-main four-row inventory successor", () => {
  it("independently pins the complete current, predecessor, receipt, sources, prefix and fixed four-row domain", () => {
    const text = raw(),
      p = policy(),
      receiptText = read(receiptPath);
    expect(Buffer.byteLength(receiptText)).toBe(primitiveReceiptPin.bytes);
    expect(sha(receiptText)).toBe(primitiveReceiptPin.sha256);
    expect(JSON.parse(receiptText)).toEqual(expected);
    expect(Buffer.byteLength(text)).toBe(569224);
    expect(sha(text)).toBe("68b09ea540cbd7c40c2d42d66071b5c096a992729afa865d143bba5d8f894c91");
    expect(digest(p)).toBe(expected.current.dataSha256);
    expect(p.files).toHaveLength(1782);
    expect(digest(p.files)).toBe(expected.current.filesSha256);
    expect(digest(p.layers)).toBe(expected.current.layersSha256);
    expect(digest(p.activationHistory)).toBe(expected.current.activationHistorySha256);
    expect(p.activationHistory).toHaveLength(101);
    expect(digest(p.allowedEdges)).toBe(expected.current.allowedEdgesSha256);
    for (const pin of expected.sourcePins) {
      const source = read(pin.path);
      expect(Buffer.byteLength(source)).toBe(pin.bytes);
      expect(sha(source)).toBe(pin.sha256);
      expect(createHash("sha1").update(`blob ${pin.bytes}\0`).update(source).digest("hex")).toBe(pin.gitBlob);
    }
    const currentPrefix = Buffer.from(read(expected.helperPrefix.path)).subarray(0, 94641);
    expect(currentPrefix.length).toBe(94641);
    expect(createHash("sha256").update(currentPrefix).digest("hex")).toBe(
      "4cf63b340b245b0f4f5ef297dc5a4b56b06507e981a7801ffcfb7e5c101f5103",
    );
    expect(createHash("sha1").update(`blob ${currentPrefix.length}\0`).update(currentPrefix).digest("hex")).toBe(
      "b33536a95c8b88e84f8e7c60c3c39bce3e2c7d82",
    );
    const oldKernel = Buffer.from(
      "    // defineProperty also preserves a literal __proto__ key as ordinary owned data.\n    const result: Record<string, unknown> = {};\n    for (const key of keys as string[])\n      Object.defineProperty(result, key, {\n        value: capture(descriptors[key]!.value, active),\n        enumerable: true,\n        writable: true,\n        configurable: true,\n      });\n    return result;\n",
      "utf8",
    );
    const newKernel = Buffer.from(
      "    return Object.fromEntries(keys.map((key) => [key, capture(descriptors[key as string]!.value, active)]));\n",
      "utf8",
    );
    expect(oldKernel.length).toBe(380);
    expect(newKernel.length).toBe(109);
    expect(currentPrefix.subarray(5477, 5586).equals(newKernel)).toBe(true);
    expect(currentPrefix.indexOf(newKernel)).toBe(5477);
    expect(currentPrefix.indexOf(newKernel, 5478)).toBe(-1);
    const prefix = Buffer.concat([currentPrefix.subarray(0, 5477), oldKernel, currentPrefix.subarray(5586)]);
    expect(prefix.subarray(5477, 5857).equals(oldKernel)).toBe(true);
    const replay = Buffer.concat([prefix.subarray(0, 5477), newKernel, prefix.subarray(5857)]);
    expect(replay.equals(currentPrefix)).toBe(true);
    expect(prefix.length).toBe(94912);
    expect(createHash("sha256").update(prefix).digest("hex")).toBe(expected.helperPrefix.sha256);
    expect(expected.rowChanges.map((r) => [r.operation, r.beforeIndex, r.currentIndex])).toEqual([
      ["addition", 366, 366],
      ["addition", 366, 367],
      ["addition", 512, 514],
      ["removal", 1381, 1384],
    ]);
    for (const change of expected.rowChanges) {
      expect(Object.keys(change.row)).toEqual(["path", "state", "layer", "destination", "owner", "nextBoundary"]);
      if (change.operation === "addition") expect(p.files[change.currentIndex]).toEqual(change.row);
      else expect(p.files.some((row) => row.path === change.row.path)).toBe(false);
    }
    expect(
      expected.raw.spans.map((s) => [
        s.beforeOffset,
        s.afterOffset,
        Buffer.byteLength(s.before),
        Buffer.byteLength(s.after),
      ]),
    ).toEqual([
      [162175, 162175, 0, 640],
      [209899, 210539, 0, 334],
      [485383, 486357, 302, 0],
    ]);
    acceptAll(p, text);
  });
  it("derives genuine1780 bytes and proves exact semantic and raw generator-chain agreement", () => {
    const text = raw(),
      p = policy(),
      previous = beforeCurrentMainInventoryPolicy(p),
      previousRaw = beforeCurrentMainInventoryPolicySource(text);
    expect(Buffer.byteLength(previousRaw)).toBe(568552);
    expect(sha(previousRaw)).toBe("64103a2fb337874fd435614d461bdd0d46cdfdc8a8dbd61603a4c7cbaf3915ff");
    expect(digest(previous)).toBe(expected.before.dataSha256);
    expect(previous.files).toHaveLength(1780);
    expect(JSON.parse(previousRaw)).toEqual(previous);
    expect(beforeGeneratorInventoryPolicy(previous)).toEqual(
      JSON.parse(beforeGeneratorInventoryPolicySource(previousRaw)),
    );
    const replay = clone(previous);
    replay.files.splice(1381, 1);
    for (const change of expected.rowChanges.slice(0, 3))
      replay.files.splice(change.currentIndex, 0, clone(change.row));
    expect(replay).toEqual(p);
    expect(previous.files[1381]).toEqual(expected.rowChanges[3].row);
    expect(previous.files[1779]).toEqual({
      path: "src/ir/runtime/intrinsic-preparation.ts",
      state: "clean",
      layer: "ir-runtime",
    });
    expect(p.files[1781]).toEqual(previous.files[1779]);
    expect(previous.layers).toEqual(p.layers);
    expect(previous.activationHistory).toEqual(p.activationHistory);
    expect(previous.allowedEdges).toEqual(p.allowedEdges);
    expect(p).toEqual(policy());
  });
  it("refuses the exact successfully derived old raw profile on a later outer action", () => {
    const previous = beforeCurrentMainInventoryPolicySource(raw());
    expect(Buffer.byteLength(previous)).toBe(568552);
    expect(sha(previous)).toBe("64103a2fb337874fd435614d461bdd0d46cdfdc8a8dbd61603a4c7cbaf3915ff");
    expect(() => beforeCurrentMainInventoryPolicySource(previous)).toThrow(
      "current main inventory evolution: complete raw source profile mismatch",
    );
    acceptAll();
  });
  it("refuses duplicate receipt keys before parsing or authority IO", () => {
    const text = read(receiptPath).replace('"schema": 1,', '"schema": 1, "schema": 1,');
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => {
        authenticateCurrentMainInventoryEvolution();
      }, receiptPath);
      expect(() => authenticateCurrentMainInventoryEvolution(text)).toThrow(
        "current main inventory evolution: receipt digest mismatch",
      );
    });
  });
  it("returns fresh detached predecessors and freshly frozen receipt snapshots", () => {
    const p = policy(),
      a = beforeCurrentMainInventoryPolicy(p),
      b = beforeCurrentMainInventoryPolicy(p);
    expect(a).not.toBe(b);
    expect(a.files).not.toBe(b.files);
    a.files[0]!.state = "changed";
    expect(b).toEqual(beforeCurrentMainInventoryPolicy(p));
    expect(p).toEqual(policy());
    const r = authenticateCurrentMainInventoryEvolution(),
      again = authenticateCurrentMainInventoryEvolution();
    expect(r).not.toBe(again);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.rowChanges[0]!.row)).toBe(true);
  });
  for (const [name, mutate] of [
    ["stale predecessor", (p: Policy) => removeEpochWithoutAuthenticating(p)],
    ["first addition only absent", (p: Policy) => p.files.splice(366, 1)],
    ["second addition only absent", (p: Policy) => p.files.splice(367, 1)],
    ["third addition only absent", (p: Policy) => p.files.splice(514, 1)],
    ["containment restoration only", (p: Policy) => p.files.splice(1384, 0, clone(expected.rowChanges[3].row))],
    ["double first addition", (p: Policy) => p.files.splice(366, 0, clone(expected.rowChanges[0].row))],
    ["unknown extra row", (p: Policy) => p.files.push({ path: "src/unknown.ts", state: "clean", layer: "ir-runtime" })],
  ] as const)
    it(`refuses ${name} without accepting a partial epoch`, () => {
      const p = policy();
      mutate(p);
      rejectSemantic(p);
    });
  for (const index of [366, 367, 514]) {
    for (const key of ["path", "state", "layer", "destination", "owner", "nextBoundary"])
      it(`refuses changed ${key} in fixed current row ${index}`, () => {
        const p = policy();
        p.files[index]![key] += " changed";
        rejectSemantic(p);
      });
    for (const operation of ["missing", "duplicate", "reordered"])
      it(`refuses ${operation} fixed current row ${index}`, () => {
        const p = policy();
        if (operation === "missing") p.files.splice(index, 1);
        else if (operation === "duplicate") p.files.splice(index, 0, clone(p.files[index]!));
        else [p.files[index - 1], p.files[index]] = [p.files[index]!, p.files[index - 1]!];
        rejectSemantic(p);
      });
  }
  for (const key of ["path", "state", "layer", "destination", "owner", "nextBoundary"])
    it(`refuses changed ${key} on an attempted containment restoration`, () => {
      const p = policy(),
        row: Record<string, string> = clone(expected.rowChanges[3].row);
      row[key] += " changed";
      p.files.splice(1384, 0, row);
      rejectSemantic(p);
    });
  for (const index of [365, 368, 513, 515, 1383, 1384, 0, 1781])
    it(`refuses changed retained row or neighbor ${index}`, () => {
      const p = policy();
      p.files[index]!.state += " changed";
      rejectSemantic(p);
    });
  for (const [name, mutate] of [
    [
      "top-level description",
      (p: Policy) => {
        p.description = "changed";
      },
    ],
    [
      "unknown top-level field",
      (p: Policy) => {
        p.extra = true;
      },
    ],
    [
      "activation",
      (p: Policy) => {
        p.activationHistory.pop();
      },
    ],
    [
      "edge",
      (p: Policy) => {
        p.allowedEdges["ir-runtime"]!.push("frontend-ts");
      },
    ],
    [
      "layer",
      (p: Policy) => {
        p.layers[0]!.status += " changed";
      },
    ],
    [
      "row key order",
      (p: Policy) => {
        const row = p.files[366]!;
        p.files[366] = {
          state: row.state!,
          path: row.path!,
          layer: row.layer!,
          destination: row.destination!,
          owner: row.owner!,
          nextBoundary: row.nextBoundary!,
        };
      },
    ],
  ] as const)
    it(`refuses ${name} mutation`, () => {
      const p = policy();
      mutate(p);
      rejectSemantic(p);
    });
  for (const [name, mutate] of [
    ["whitespace", (text: string) => text + " "],
    ["reformatted current", (text: string) => JSON.stringify(JSON.parse(text))],
    ["missing first raw block", (text: string) => text.replace(expected.raw.spans[0].after, "")],
    [
      "duplicated third raw block",
      (text: string) =>
        text.replace(expected.raw.spans[1].after, expected.raw.spans[1].after + expected.raw.spans[1].after),
    ],
    [
      "restored containment raw block",
      (text: string) => text.slice(0, 486357) + expected.raw.spans[2].before + text.slice(486357),
    ],
  ] as const)
    it(`refuses ${name} raw source`, () => {
      expect(() => beforeCurrentMainInventoryPolicySource(mutate(raw()))).toThrow(
        "current main inventory evolution: complete raw source profile mismatch",
      );
    });
  for (const field of [
    "schema",
    "kind",
    "provenance",
    "before",
    "current",
    "helperPrefix",
    "predecessorReceipt",
    "sourcePins",
    "rowChanges",
    "raw",
  ])
    it(`refuses missing or unknown receipt field ${field}`, () => {
      const r = JSON.parse(read(receiptPath));
      delete r[field];
      r.unknown = field;
      expect(() => authenticateCurrentMainInventoryEvolution(JSON.stringify(r))).toThrow(
        "current main inventory evolution: receipt digest mismatch",
      );
    });
  for (const index of [0, 1, 2, 3])
    for (const key of ["beforeIndex", "currentIndex", "beforePrevious", "beforeNext", "currentPrevious", "currentNext"])
      it(`refuses changed receipt row${index} coordinate or neighbor ${key}`, () => {
        const r = JSON.parse(read(receiptPath));
        r.rowChanges[index][key] = "changed";
        expect(() => authenticateCurrentMainInventoryEvolution(JSON.stringify(r))).toThrow(
          "current main inventory evolution: receipt digest mismatch",
        );
      });
  for (const index of [0, 1, 2])
    for (const key of ["beforeOffset", "afterOffset", "before", "after", "beforeSha256", "afterSha256"])
      it(`refuses changed raw span${index} ${key}`, () => {
        const r = JSON.parse(read(receiptPath));
        r.raw.spans[index][key] = "changed";
        expect(() => authenticateCurrentMainInventoryEvolution(JSON.stringify(r))).toThrow(
          "current main inventory evolution: receipt digest mismatch",
        );
      });
  for (const part of ["rowChanges", "sourcePins"])
    it(`refuses reordered ${part} receipt domain`, () => {
      const r = JSON.parse(read(receiptPath));
      r[part].reverse();
      expect(() => authenticateCurrentMainInventoryEvolution(JSON.stringify(r))).toThrow("receipt digest mismatch");
    });
  it("refuses reordered raw spans and source/span coordinate confusion", () => {
    const r = JSON.parse(read(receiptPath));
    r.raw.spans.reverse();
    r.rowChanges[0].currentIndex = 162175;
    expect(() => authenticateCurrentMainInventoryEvolution(JSON.stringify(r))).toThrow("receipt digest mismatch");
  });
  for (const value of [null, 7, {}, new String("boxed")])
    it(`refuses nonprimitive raw operand ${Object.prototype.toString.call(value)} before authority IO`, () => {
      const validRaw = raw();
      withAuthorityFault(receiptPath, "missing", () => {
        expectMissingAuthority(() => {
          beforeCurrentMainInventoryPolicySource(validRaw);
        }, receiptPath);
        expect(() => beforeCurrentMainInventoryPolicySource(value as unknown as string)).toThrow(
          "raw input must be a primitive string",
        );
      });
    });
  it("refuses accessor descriptors without caller reads or authority IO", () => {
    let reads = 0;
    const p = policy();
    Object.defineProperty(p, "description", {
      enumerable: true,
      get() {
        reads++;
        return "changed";
      },
    });
    const validPolicy = policy();
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => {
        beforeCurrentMainInventoryPolicy(validPolicy);
      }, receiptPath);
      expect(() => beforeCurrentMainInventoryPolicy(p)).toThrow("accessor or hidden policy field");
      expect(reads).toBe(0);
    });
  });
  it("propagates proxy descriptor refusal before authority IO", () => {
    const validPolicy = policy(),
      p = new Proxy(policy(), {
        ownKeys() {
          throw new Error("descriptor trap");
        },
      });
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => {
        beforeCurrentMainInventoryPolicy(validPolicy);
      }, receiptPath);
      expect(() => beforeCurrentMainInventoryPolicy(p)).toThrow("descriptor trap");
    });
  });
  it("does not invoke caller JSON or primitive conversion hooks", () => {
    let calls = 0;
    const p = policy();
    p.toJSON = () => {
      calls++;
      return {};
    };
    const validPolicy = policy(),
      validRaw = raw(),
      operand = {
        toString() {
          calls++;
          return validRaw;
        },
      };
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => {
        beforeCurrentMainInventoryPolicy(validPolicy);
      }, receiptPath);
      expectMissingAuthority(() => {
        beforeCurrentMainInventoryPolicySource(validRaw);
      }, receiptPath);
      expect(() => beforeCurrentMainInventoryPolicy(p)).toThrow("non-JSON or cyclic policy");
      expect(calls).toBe(0);
      expect(() => beforeCurrentMainInventoryPolicySource(operand as unknown as string)).toThrow(
        "raw input must be a primitive string",
      );
      expect(calls).toBe(0);
    });
  });
  const authorities = [
    receiptPath,
    expected.helperPrefix.path,
    expected.predecessorReceipt.path,
    ...expected.sourcePins.map((pin) => pin.path),
  ];
  for (const path of authorities) {
    it(`freshly refuses mutated physical authority ${path} after success and restores`, () => {
      const p = policy(),
        text = raw(),
        original = read(path);
      acceptAll(p, text);
      withAuthorityFault(path, "mutation", () => {
        expect(read(path)).not.toBe(original);
        expect(() => authenticateCurrentMainInventoryEvolution()).toThrow();
        expect(() => beforeCurrentMainInventoryPolicy(p)).toThrow();
        expect(() => beforeCurrentMainInventoryPolicySource(text)).toThrow();
      });
      expect(read(path)).toBe(original);
      acceptAll(p, text);
    });
    it(`propagates missing physical authority ${path} without stale fallback`, () => {
      const p = policy(),
        text = raw(),
        original = read(path);
      acceptAll(p, text);
      withAuthorityFault(path, "missing", () => {
        expectMissingAuthority(() => {
          read(path);
        }, path);
        expectMissingAuthority(() => {
          authenticateCurrentMainInventoryEvolution();
        }, path);
        expectMissingAuthority(() => {
          beforeCurrentMainInventoryPolicy(p);
        }, path);
        expectMissingAuthority(() => {
          beforeCurrentMainInventoryPolicySource(text);
        }, path);
      });
      expect(read(path)).toBe(original);
      acceptAll(p, text);
    });
  }
});

describe("fixed policy-capture kernel prefix authority", () => {
  for (const byte of [0, 5477, 5585, 94640] as const)
    it(`freshly refuses actual policy-capture prefix byte ${byte} and restores`, () => {
      const path = "tests/helpers/ir-runtime-program-policy-evolution.ts";
      const original = read(path);
      authenticateCurrentMainInventoryEvolution();
      withAuthorityFault(
        path,
        "mutation",
        () => {
          expect(() => authenticateCurrentMainInventoryEvolution()).toThrow(
            "current main inventory evolution: complete predecessor helper prefix changed",
          );
        },
        byte,
      );
      expect(read(path)).toBe(original);
      authenticateCurrentMainInventoryEvolution();
    });
});
