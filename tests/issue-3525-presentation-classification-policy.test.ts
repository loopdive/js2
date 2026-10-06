// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { capturePositionFinallyMainPredecessorPolicySource } from "./helpers/ir-position-finally-main-successor.js";
import { capturePositionClassFieldsMainPredecessorPolicySource } from "./helpers/ir-position-class-fields-main-successor.js";
import { captureSourceMapPositionInventoryPredecessorPolicySource } from "./helpers/ir-source-map-position-inventory-successor.js";
import { captureMainInventoryPredecessorPolicySource } from "./helpers/ir-main-inventory-source-successor.js";
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
  captureArrayBufferIsViewMainPredecessorPolicySource,
  capturePresentationClassificationPredecessorPolicy,
  capturePresentationClassificationPredecessorPolicySource,
  type MutableIrRuntimeProgramPolicy as Policy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
// Independent authority literals; no expected pin is derived from mutated bytes.
const expected = {
  schema: 1,
  kind: "fixed-prepared-presentation-classification-policy-evolution",
  provenance: {
    preparationCommit: "5a633bf93ec0e7b9d2992334d00f1279c7bd2c25",
    planSha256: "1d332bd357bb3867a187f8841308f82e3f0518e400eb684c2b7f71b5567d89b1",
    legacyRetained: true,
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 356816,
    sha256: "f195d0c432429bfb43c3f8a65617c886ef176e24fa81c2c6539845575fc01a54",
    gitBlob: "ea6cef6bbd168ab0f68f412ae3bc270184fd8e9c",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-lowering-analysis.json",
    bytes: 13393,
    sha256: "72db51a0e892a4fa8a2d9762042eacc8d88609ccd0ae1ac80f9f548852e04f9b",
    gitBlob: "3c7ce06a7075d66f786e01b79d44527e86ae0f3f",
  },
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
  before: {
    source: {
      bytes: 583986,
      sha256: "0cbff25993c92150c6c7cd45934b25552b315266833adc84301f49287d3982ee",
      gitBlob: "37d83315305278b25047fa4ed6b38af24b3cf9ce",
    },
    dataSha256: "2d3c02197bd25875755aa64a0d7f9f8cdaba6f08f2394448e2e70870e327e738",
    fileCount: 1824,
    filesSha256: "04e5d8f08098f2f3f0d30813353c3521762c2f2f266b777083796549c3654156",
    activationCount: 104,
    activationHistorySha256: "27cbdad6be8299ff447e8407b2d04adbb44a28e11999c3dd56d75948f47b44ab",
    layersSha256: "45c79ff9c27d08c74dfab859be8cec1ef6a85acbc1cae121e096c0ca35026eeb",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    moveCount: 12,
    movesSha256: "050fb62b7369179b0b3bd81193ec9bc275a77db1ebb45ac5fdef1a136ab037f2",
  },
  current: {
    source: {
      bytes: 584358,
      sha256: "b1693461855cc60546bb29bee370c02ad3cf21e17e539d521c8f2b6598b0e411",
      gitBlob: "b77bcc4a76f1a959bc77db8c37cf8ef48ad2da0f",
    },
    dataSha256: "475ebcec73e71dddd9b3cca9ec1e8c36c9e345436b3e2a7173e13da29c09427a",
    fileCount: 1825,
    filesSha256: "2155c33a508f2f0177541878b0b50e4b11b5f7ccba4aceb762e90877023203a0",
    activationCount: 104,
    activationHistorySha256: "27cbdad6be8299ff447e8407b2d04adbb44a28e11999c3dd56d75948f47b44ab",
    layersSha256: "45c79ff9c27d08c74dfab859be8cec1ef6a85acbc1cae121e096c0ca35026eeb",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    moveCount: 12,
    movesSha256: "050fb62b7369179b0b3bd81193ec9bc275a77db1ebb45ac5fdef1a136ab037f2",
  },
  delta: {
    addedRowIndex: 1824,
    addedRow: {
      path: "src/compiler/ir-program-presentation.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "compiler",
      owner: "3525-prepared-presentation",
      nextBoundary:
        "Separate AST declaration capture and finalizer presentation from prepared-program output association before compiler-layer activation.",
    },
    previousRow: {
      path: "src/ir/analysis/backend-legality.ts",
      state: "clean",
      layer: "ir-analysis",
    },
    activationHistoryUnchanged: true,
    movesUnchanged: true,
  },
  rawSpans: [
    {
      beforeOffset: 583862,
      afterOffset: 583862,
      before:
        '    {\n      "path": "src/ir/analysis/backend-legality.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    }\n',
      after:
        '    {\n      "path": "src/ir/analysis/backend-legality.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/compiler/ir-program-presentation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3525-prepared-presentation",\n      "nextBoundary": "Separate AST declaration capture and finalizer presentation from prepared-program output association before compiler-layer activation."\n    }\n',
    },
  ],
} as const;
const receiptPath = "tests/helpers/ir-runtime-program-policy-presentation-classification.json";
const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";
const receiptSha256 = "dd0273b99eb2f96ed66e033bec6a4365b65137359d3a9b7fc2e3b0e7b4b80dee";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const physical = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const physicalFaultAuthorities = [receiptPath, helperPath, expected.predecessorReceipt.path];
const raw = () =>
  captureArrayBufferIsViewMainPredecessorPolicySource(
    captureMainInventoryPredecessorPolicySource(
      captureSourceMapPositionInventoryPredecessorPolicySource(
        capturePositionClassFieldsMainPredecessorPolicySource(
          capturePositionFinallyMainPredecessorPolicySource(
            readFileSync(physical("scripts/compiler-boundaries.json"), "utf8"),
          ),
        ),
      ),
    ),
  );
const policy = () => JSON.parse(raw()) as Policy;
afterEach(async () => {
  await setImmediate();
});
function profile(value: Policy, current: boolean): void {
  const pin = current ? expected.current : expected.before;
  expect(Object.keys(value)).toEqual(expected.topLevelKeys);
  expect(sha(JSON.stringify(value))).toBe(pin.dataSha256);
  expect(value.files).toHaveLength(pin.fileCount);
  expect(sha(JSON.stringify(value.files))).toBe(pin.filesSha256);
  expect(value.activationHistory).toHaveLength(pin.activationCount);
  expect(sha(JSON.stringify(value.activationHistory))).toBe(pin.activationHistorySha256);
  expect(sha(JSON.stringify(value.layers))).toBe(pin.layersSha256);
  expect(sha(JSON.stringify(value.allowedEdges))).toBe(pin.allowedEdgesSha256);
  expect(value.moves).toHaveLength(pin.moveCount);
  expect(sha(JSON.stringify(value.moves))).toBe(pin.movesSha256);
}
function reciprocal(text: string, forward: boolean): string {
  const bytes = Buffer.from(text),
    pieces: Buffer[] = [];
  let end = 0;
  for (const span of expected.rawSpans) {
    const at = forward ? span.beforeOffset : span.afterOffset,
      from = Buffer.from(forward ? span.before : span.after),
      to = Buffer.from(forward ? span.after : span.before);
    expect(at).toBeGreaterThanOrEqual(end);
    expect(bytes.subarray(at, at + from.length).equals(from)).toBe(true);
    pieces.push(bytes.subarray(end, at), to);
    end = at + from.length;
  }
  pieces.push(bytes.subarray(end));
  return Buffer.concat(pieces).toString();
}
function expectMissingAuthority(action: () => void, path: string): void {
  let caught = false;
  let failure: unknown;
  try {
    action();
  } catch (error) {
    caught = true;
    failure = error;
  }
  expect(caught).toBe(true);
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
  const scratch = resolve(import.meta.dirname, "../.tmp/plugin-plan/function-allocation-policy/authority-faults");
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
        ? { bytes: 4227, sha256: receiptSha256 }
        : path === helperPath
          ? expected.helperPrefix
          : expected.predecessorReceipt;
    const authenticated = path === helperPath ? independentHelperHistoricalPrefix(original) : original;
    expect(authenticated.length).toBe(pin.bytes);
    expect(sha(authenticated)).toBe(pin.sha256);
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

describe("fixed prepared presentation classification policy predecessor capture", () => {
  it("authenticates independent receipt and full current domain", () => {
    const bytes = readFileSync(physical(receiptPath));
    expect(bytes.length).toBe(4227);
    expect(sha(bytes)).toBe(receiptSha256);
    expect(JSON.parse(bytes.toString())).toEqual(expected);
    const text = raw();
    expect(Buffer.byteLength(text)).toBe(expected.current.source.bytes);
    expect(sha(text)).toBe(expected.current.source.sha256);
    profile(JSON.parse(text), true);
    const before = capturePresentationClassificationPredecessorPolicySource(text);
    profile(JSON.parse(before), false);
    expect(sha(before)).toBe(expected.before.source.sha256);
    expect(before).toBe(reciprocal(text, false));
    expect(reciprocal(before, true)).toBe(text);
  });
  it("detaches semantic input and replays exact row without retained-field changes", () => {
    const value = policy(),
      snapshot = JSON.stringify(value),
      before = capturePresentationClassificationPredecessorPolicy(value);
    profile(before, false);
    expect(JSON.stringify(value)).toBe(snapshot);
    expect(before).not.toBe(value);
    expect(before.files).not.toBe(value.files);
    expect(before.activationHistory).toEqual(value.activationHistory);
    expect(before.moves).toEqual(value.moves);
    expect(before.layers).toEqual(value.layers);
    expect(before.allowedEdges).toEqual(value.allowedEdges);
    before.files.splice(1824, 0, { ...expected.delta.addedRow });
    expect(before).toEqual(value);
    profile(before, true);
  });
  it("refuses genuine predecessor raw domain", () => {
    const text = reciprocal(raw(), false);
    expect(sha(text)).toBe(expected.before.source.sha256);
    expect(() => capturePresentationClassificationPredecessorPolicySource(text)).toThrow(
      "complete raw source profile mismatch",
    );
  });
  it("refuses genuine predecessor semantic domain", () => {
    const value = JSON.parse(reciprocal(raw(), false));
    profile(value, false);
    expect(() => capturePresentationClassificationPredecessorPolicy(value)).toThrow("complete policy profile mismatch");
  });
  const mutations: readonly [string, (value: Policy) => void][] = [
    [
      "missing added row",
      (v) => {
        v.files.splice(1824, 1);
      },
    ],
    [
      "duplicate added row",
      (v) => {
        v.files.push({ ...v.files[1824]! });
      },
    ],
    [
      "extra row schema",
      (v) => {
        Object.assign(v.files[1824]!, { unexpected: true });
      },
    ],
    [
      "wrong added row layer",
      (v) => {
        v.files[1824]!.layer = "ir-program";
      },
    ],
    [
      "changed retained edge",
      (v) => {
        v.allowedEdges.foundation!.push("ir-analysis");
      },
    ],
    ...(["path", "state", "layer", "destination", "owner", "nextBoundary"] as const).map(
      (field): [string, (value: Policy) => void] => [
        "changed added row " + field,
        (v) => {
          v.files[1824]![field] += "-changed";
        },
      ],
    ),
    [
      "reordered added row keys",
      (v) => {
        const row = v.files[1824]!;
        v.files[1824] = Object.fromEntries(Object.entries(row).reverse());
      },
    ],
    [
      "reordered added row position",
      (v) => {
        [v.files[1823], v.files[1824]] = [v.files[1824]!, v.files[1823]!];
      },
    ],
    [
      "changed retained neighbor",
      (v) => {
        v.files[1823]!.layer = "compiler";
      },
    ],
    [
      "changed retained root",
      (v) => {
        v.layers[6]!.roots[0] += "-changed";
      },
    ],
    [
      "changed retained history",
      (v) => {
        v.activationHistory.reverse();
      },
    ],
    [
      "changed retained moves",
      (v) => {
        if (!Array.isArray(v.moves)) throw new Error("fixture moves must be an array");
        v.moves.reverse();
      },
    ],
    [
      "extra debt row",
      (v) => {
        v.files.push({ ...expected.delta.addedRow, path: "src/compiler/extra.ts" });
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    it("refuses " + name, () => {
      const value = policy();
      mutate(value);
      expect(sha(JSON.stringify(value))).not.toBe(expected.current.dataSha256);
      expect(() => capturePresentationClassificationPredecessorPolicy(value)).toThrow(
        "complete policy profile mismatch",
      );
    });
  for (const [index, span] of expected.rawSpans.entries())
    for (const kind of ["missing", "duplicate", "relocated"] as const)
      it(`refuses raw span ${index} ${kind}`, () => {
        const text = raw(),
          at = span.afterOffset,
          end = at + Buffer.byteLength(span.after);
        expect(text.slice(at, end)).toBe(span.after);
        const mutant =
          kind === "missing"
            ? text.slice(0, at) + text.slice(end)
            : kind === "duplicate"
              ? text.slice(0, end) + span.after + text.slice(end)
              : span.after + text.slice(0, at) + text.slice(end);
        expect(mutant).not.toBe(text);
        expect(() => capturePresentationClassificationPredecessorPolicySource(mutant)).toThrow(
          "complete raw source profile mismatch",
        );
      });
  it("refuses semantic-equivalent raw whitespace", () => {
    const text = raw(),
      mutant = " " + text;
    expect(JSON.parse(mutant)).toEqual(JSON.parse(text));
    expect(() => capturePresentationClassificationPredecessorPolicySource(mutant)).toThrow(
      "complete raw source profile mismatch",
    );
  });
  it("refuses a valid JSON same-length row field mutation", () => {
    const text = raw(),
      token = '"owner": "3525-prepared-presentation"';
    expect(text.split(token)).toHaveLength(2);
    const mutant = text.replace(token, '"owner": "3525-prepared-presentatioN"');
    expect(Buffer.byteLength(mutant)).toBe(Buffer.byteLength(text));
    expect(JSON.parse(mutant).files[1824].owner).not.toBe(expected.delta.addedRow.owner);
    expect(() => capturePresentationClassificationPredecessorPolicySource(mutant)).toThrow(
      "complete raw source profile mismatch",
    );
  });
  let getterInvocations = 0;
  let coercionInvocations = 0;
  const invalids: readonly [string, () => void, string][] = [
    [
      "boxed raw",
      () => {
        coercionInvocations = 0;
        const value = Object.assign(new String("x"), {
          toString() {
            coercionInvocations++;
            throw new Error("unexpected coercion sentinel");
          },
          valueOf() {
            coercionInvocations++;
            throw new Error("unexpected coercion sentinel");
          },
        });
        capturePresentationClassificationPredecessorPolicySource(value as unknown as string);
      },
      "raw input must be a primitive string",
    ],
    [
      "numeric raw",
      () => capturePresentationClassificationPredecessorPolicySource(1 as unknown as string),
      "raw input must be a primitive string",
    ],
    [
      "null semantic",
      () => capturePresentationClassificationPredecessorPolicy(null),
      "policy input must be a plain object",
    ],
    [
      "accessor semantic",
      () => {
        getterInvocations = 0;
        const value = {};
        Object.defineProperty(value, "files", {
          enumerable: true,
          get() {
            getterInvocations++;
            throw new Error("unexpected getter side effect sentinel");
          },
        });
        capturePresentationClassificationPredecessorPolicy(value);
      },
      "accessor",
    ],
    [
      "symbol semantic",
      () => capturePresentationClassificationPredecessorPolicy({ [Symbol("unexpected")]: 1 }),
      "symbol policy key",
    ],
    [
      "hidden semantic",
      () => {
        const value = {};
        Object.defineProperty(value, "files", { value: [], enumerable: false });
        capturePresentationClassificationPredecessorPolicy(value);
      },
      "hidden policy field",
    ],
  ];
  for (const [name, action, message] of invalids)
    it("guards " + name + " before missing authority with positive IO witness", () => {
      const text = raw();
      withAuthorityFault(receiptPath, "missing", () => {
        expect(action).toThrow(message);
        if (name === "accessor semantic") expect(getterInvocations).toBe(0);
        if (name === "boxed raw") expect(coercionInvocations).toBe(0);
        expectMissingAuthority(() => capturePresentationClassificationPredecessorPolicySource(text), receiptPath);
      });
    });
  const diagnostic: Record<string, string> = {
    [receiptPath]: "receipt digest mismatch",
    [helperPath]: "complete predecessor helper prefix changed",
    [expected.predecessorReceipt.path]: "predecessor receipt changed",
  };
  for (const path of physicalFaultAuthorities)
    for (const kind of ["missing", "mutation"] as const)
      for (const form of ["raw", "semantic"] as const)
        it(`fresh ${form} refuses ${path} ${kind} after success and admits restored authority`, () => {
          const text = raw(),
            value = JSON.parse(text),
            action = () =>
              form === "raw"
                ? capturePresentationClassificationPredecessorPolicySource(text)
                : capturePresentationClassificationPredecessorPolicy(value);
          const check = () => {
            const result = action();
            profile(typeof result === "string" ? JSON.parse(result) : result, false);
          };
          check();
          withAuthorityFault(path, kind, () => {
            if (kind === "missing") expectMissingAuthority(action, path);
            else expect(action).toThrow(diagnostic[path]);
          });
          check();
        });
});

// Root-fixed current-helper pin and reciprocal fragments; independent from production projection.
const earlyReturnWholeHelperPin = {
  bytes: 390466,
  sha256: "bb2d3a7e6bcfb54237cb03fbe4bdc61f128a508ccfb7425bdde6a150d0add55c",
  gitBlob: "c5a6659926bd635a4fe56d7459d120cffa9eeb58",
} as const;
const earlyReturnPrefixProof = {
  before: {
    bytes: 356816,
    sha256: "f195d0c432429bfb43c3f8a65617c886ef176e24fa81c2c6539845575fc01a54",
    gitBlob: "ea6cef6bbd168ab0f68f412ae3bc270184fd8e9c",
  },
  current: {
    bytes: 357119,
    sha256: "91f4c65528072df09092f47ac11f2a6d9d944ae90bd58aa4c29258d2aec71dd2",
    gitBlob: "996123d86af1f162e19f37fff2c19339ce203440",
  },
  edits: [
    {
      beforeOffset: 332028,
      afterOffset: 332028,
      before: "  captureLoweringLegalityPredecessor as loweringAnalysisLegalityProof,\n",
      after: "  captureCurrentLoweringLegalityPredecessor as loweringAnalysisLegalityProof,\n",
    },
    {
      beforeOffset: 346469,
      afterOffset: 346476,
      before: "    loweringAnalysisPin(bytes, expected, path);\n",
      after:
        '    loweringAnalysisPin(\n      bytes,\n      path === "src/ir/analysis/backend-legality.ts" ? earlyReturnCurrentOwnerPin : expected,\n      path,\n    );\n',
    },
    {
      beforeOffset: 348569,
      afterOffset: 348679,
      before:
        "  loweringAnalysisPin(implementation, receipt.componentImplementation, receipt.componentImplementation.path);\n",
      after:
        '  loweringAnalysisPin(implementation, earlyReturnComponentPin, receipt.componentImplementation.path);\n  loweringAnalysisPin(\n    implementation.subarray(0, receipt.componentImplementation.bytes),\n    receipt.componentImplementation,\n    receipt.componentImplementation.path + " historical prefix",\n  );\n',
    },
  ],
} as const;
function independentHelperHistoricalPrefix(actual: Buffer): Buffer {
  const original = independentSourceMapPolicyPredecessor(actual);
  const wholePin = earlyReturnWholeHelperPin;
  const beforePin = earlyReturnPrefixProof.before;
  const currentPin = earlyReturnPrefixProof.current;
  const currentPrefixBytes = currentPin.bytes;
  const edits = earlyReturnPrefixProof.edits;
  const blob = (bytes: Buffer) =>
    createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
  expect(blob(original)).toBe(wholePin.gitBlob);
  expect(original.length).toBe(wholePin.bytes);
  expect(sha(original)).toBe(wholePin.sha256);
  expect(Number.isSafeInteger(currentPrefixBytes)).toBe(true);
  expect(currentPrefixBytes).toBeGreaterThan(0);
  expect(currentPrefixBytes).toBeLessThanOrEqual(original.length);
  const current = original.subarray(0, currentPrefixBytes);
  expect(sha(current)).toBe(currentPin.sha256);
  expect(blob(current)).toBe(currentPin.gitBlob);
  const inverse: Buffer[] = [];
  let beforeCursor = 0,
    afterCursor = 0;
  for (const edit of edits) {
    expect(Number.isSafeInteger(edit.beforeOffset)).toBe(true);
    expect(Number.isSafeInteger(edit.afterOffset)).toBe(true);
    expect(edit.beforeOffset).toBeGreaterThanOrEqual(beforeCursor);
    expect(edit.afterOffset).toBeGreaterThanOrEqual(afterCursor);
    expect(edit.beforeOffset - beforeCursor).toBe(edit.afterOffset - afterCursor);
    const before = Buffer.from(edit.before),
      after = Buffer.from(edit.after);
    expect(edit.beforeOffset + before.length).toBeLessThanOrEqual(beforePin.bytes);
    expect(edit.afterOffset + after.length).toBeLessThanOrEqual(current.length);
    expect(current.subarray(edit.afterOffset, edit.afterOffset + after.length)).toEqual(after);
    inverse.push(current.subarray(afterCursor, edit.afterOffset), before);
    beforeCursor = edit.beforeOffset + before.length;
    afterCursor = edit.afterOffset + after.length;
  }
  expect(beforePin.bytes - beforeCursor).toBe(current.length - afterCursor);
  inverse.push(current.subarray(afterCursor));
  const historical = Buffer.concat(inverse);
  expect(historical.length).toBe(beforePin.bytes);
  expect(sha(historical)).toBe(beforePin.sha256);
  expect(blob(historical)).toBe(beforePin.gitBlob);
  const forward: Buffer[] = [];
  beforeCursor = 0;
  for (const edit of edits) {
    const before = Buffer.from(edit.before),
      after = Buffer.from(edit.after);
    expect(historical.subarray(edit.beforeOffset, edit.beforeOffset + before.length)).toEqual(before);
    forward.push(historical.subarray(beforeCursor, edit.beforeOffset), after);
    beforeCursor = edit.beforeOffset + before.length;
  }
  forward.push(historical.subarray(beforeCursor));
  expect(Buffer.concat(forward)).toEqual(current);
  return historical;
}

const sourceMapPolicyOuterExpected = [
  {
    beforeOffset: 254123,
    afterOffset: 254123,
    before: "  captureProgramValidatorRelocation,\n",
    after: "  captureSourceMapProgramValidatorRelocation,\n",
  },
  {
    beforeOffset: 285052,
    afterOffset: 285061,
    before: "  const sources = captureProgramValidatorRelocation((path) =>\n",
    after:
      '  programValidatorPolicyPin(\n    readFileSync(new URL("./ir-program-validator-relocation.ts", import.meta.url)),\n    sourceMapPolicyComponentPin,\n    "complete current source map component changed",\n  );\n  const sources = captureSourceMapProgramValidatorRelocation((path) =>\n',
  },
  {
    beforeOffset: 285259,
    afterOffset: 285481,
    before: "      Buffer.from(sources.readCurrent(pin.path as ProgramValidatorCurrentPath)),\n",
    after: "      Buffer.from(sources.readRelocationCurrent(pin.path as ProgramValidatorCurrentPath)),\n",
  },
  {
    beforeOffset: 322798,
    afterOffset: 323030,
    before:
      "  const prefix = readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url)).subarray(\n    0,\n",
    after:
      "  const prefix = sourceMapProgramValidatorPolicyHistoricalPrefix(\n    readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url)),\n",
  },
  {
    beforeOffset: 347924,
    afterOffset: 348193,
    before:
      "  const prefix = readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url)).subarray(\n    0,\n",
    after:
      "  const prefix = sourceMapProgramValidatorPolicyHistoricalPrefix(\n    readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url)),\n",
  },
  {
    beforeOffset: 362950,
    afterOffset: 363256,
    before: '      readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n',
    after:
      '      sourceMapProgramValidatorPolicyHistoricalPrefix(\n        readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n        357119,\n      ),\n',
  },
  {
    beforeOffset: 376430,
    afterOffset: 376818,
    before: '      readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n',
    after:
      '      sourceMapProgramValidatorPolicyHistoricalPrefix(\n        readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n        369684,\n      ),\n',
  },
] as const;
function independentSourceMapPolicyPredecessor(actual: Buffer): Buffer {
  expect(actual.length).toBe(402646);
  expect(createHash("sha256").update(actual).digest("hex")).toBe(
    "0ddf7556360e8937b25ba58b23629533c8042e026a4b6e6fc05df3d1263c97b8",
  );
  const current = actual.subarray(0, 390936);
  const inverse: Buffer[] = [];
  let beforeCursor = 0,
    currentCursor = 0;
  for (const edit of sourceMapPolicyOuterExpected) {
    const before = Buffer.from(edit.before),
      after = Buffer.from(edit.after);
    expect(edit.beforeOffset - beforeCursor).toBe(edit.afterOffset - currentCursor);
    expect(current.subarray(edit.afterOffset, edit.afterOffset + after.length)).toEqual(after);
    inverse.push(current.subarray(currentCursor, edit.afterOffset), before);
    beforeCursor = edit.beforeOffset + before.length;
    currentCursor = edit.afterOffset + after.length;
  }
  inverse.push(current.subarray(currentCursor));
  const historical = Buffer.concat(inverse);
  expect(historical.length).toBe(390466);
  expect(createHash("sha256").update(historical).digest("hex")).toBe(
    "bb2d3a7e6bcfb54237cb03fbe4bdc61f128a508ccfb7425bdde6a150d0add55c",
  );
  const forward: Buffer[] = [];
  beforeCursor = 0;
  for (const edit of sourceMapPolicyOuterExpected) {
    const before = Buffer.from(edit.before);
    expect(historical.subarray(edit.beforeOffset, edit.beforeOffset + before.length)).toEqual(before);
    forward.push(historical.subarray(beforeCursor, edit.beforeOffset), Buffer.from(edit.after));
    beforeCursor = edit.beforeOffset + before.length;
  }
  forward.push(historical.subarray(beforeCursor));
  expect(Buffer.concat(forward)).toEqual(current);
  return historical;
}
