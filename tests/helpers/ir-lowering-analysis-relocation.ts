// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type AuthorityReader = (path: string) => string;
interface Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob?: string;
}
interface SourcePin extends Pin {
  readonly path: string;
  readonly gitBlob: string;
  readonly mode: number;
}
interface BeforePin extends Pin {
  readonly path: string;
  readonly gitBlob: string;
}
type InverseLiteral = {
  [Kind in "literal-import" | "literal-trailer"]: {
    readonly kind: Kind;
    readonly beforeOffset: number;
    readonly text: string;
  };
}["literal-import" | "literal-trailer"];
interface InverseSource {
  readonly kind: "moved" | "retained";
  readonly name: string;
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly sourceSha256: string;
  readonly leading: string;
  readonly reverseModifier: readonly [string, string] | null;
  readonly beforeOffset: number;
}
interface ForwardLiteral {
  readonly kind: "literal-header-or-forward" | "literal-trailer";
  readonly text: string;
  readonly afterOffset: number;
}
interface ForwardSource {
  readonly kind: "original-declaration";
  readonly name: string;
  readonly original: string;
  readonly offset: number;
  readonly length: number;
  readonly sourceSha256: string;
  readonly leading: string;
  readonly forwardModifier: readonly [string, string] | null;
  readonly afterOffset: number;
}
interface Forward {
  readonly path: string;
  readonly currentPin: Pin;
  readonly completeCoverage: boolean;
  readonly forwardFromAuthenticOriginal: boolean;
  readonly pieces: readonly (ForwardLiteral | ForwardSource)[];
}
interface Pair {
  readonly name: string;
  readonly donorPath: string;
  readonly beforePin: BeforePin;
  readonly currentPaths: readonly string[];
  readonly inverse: {
    readonly label: string;
    readonly beforePin: Pin;
    readonly beforeDerivedFromActualCurrent: boolean;
    readonly completeCoverage: boolean;
    readonly pieces: readonly (InverseLiteral | InverseSource)[];
  };
  readonly forward: readonly Forward[];
}
interface Receipt {
  readonly schema: string;
  readonly sourceBase: string;
  readonly sourceFreezeSha256: string;
  readonly sourceInputs: readonly SourcePin[];
  readonly pairs: readonly Pair[];
}

const receiptPath = "tests/helpers/ir-lowering-analysis-relocation.json";
const receiptPin = {
  bytes: 111423,
  sha256: "dc8241d36da5b2fe29abe12ed6ee348fc456ef22939c61aabe05d09daad92134",
  gitBlob: "6fee96e10bb22a1f3071ddc41b4a2af39ee96763",
} as const;
const sources = [
  {
    path: "src/ir/analysis/linear-memory-plan.ts",
    bytes: 49040,
    sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
    gitBlob: "a44148b86cf60d75a8ebcd9decd2f0fc3a5aad1c",
    mode: 420,
  },
  {
    path: "src/ir/analysis/contracts/linear-memory-layout.ts",
    bytes: 4670,
    sha256: "dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72",
    gitBlob: "cac9d1e33659380a6ee8d8e03014af53e1123533",
    mode: 420,
  },
  {
    path: "src/ir/backend/legality.ts",
    bytes: 5833,
    sha256: "5b67993fe312a0f5a52f9ef816c76a10cd32470f7e2a53819dec736764f45878",
    gitBlob: "c38edb2f3d1350b0ea23f887c9349ac768d48afa",
    mode: 420,
  },
  {
    path: "src/ir/analysis/backend-legality.ts",
    bytes: 21362,
    sha256: "e6bdc35fbf47fc26581c24cbecb08f27a4d590a7006d005031b6a309db26b506",
    gitBlob: "34a1399bdd963163f2155f0de0933d085dbc4f25",
    mode: 420,
  },
] as const;
const pairs = [
  {
    name: "linear-layout",
    label: "planner",
    beforePin: {
      path: sources[0].path,
      bytes: 52704,
      sha256: "382cb4acee2de86904da1c0162ecc8b9de4250f9f9cb49dcba57b1a056c1cc3c",
      gitBlob: "ae6f9ab03e01c80622e56a69c5b05c6826366d69",
    },
    currentPaths: [sources[0].path, sources[1].path],
    inverseCount: 99,
    forwardCounts: [86, 20],
  },
  {
    name: "backend-legality",
    label: "legality",
    beforePin: {
      path: sources[2].path,
      bytes: 26410,
      sha256: "6a64764b2691d6b2994258a966afabdac0b981fc036f611be5d8969032a3db98",
      gitBlob: "d4854103ad1fae2f12c105fc0e1a66e2d20a5c6e",
    },
    currentPaths: [sources[2].path, sources[3].path],
    inverseCount: 30,
    forwardCounts: [9, 25],
  },
] as const;
const reverseBase = ["export interface LinearLayoutBase", "interface LinearLayoutBase"] as const;
const forwardBase = ["interface LinearLayoutBase", "export interface LinearLayoutBase"] as const;

function requireProof(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`lowering analysis relocation: ${detail}`);
}
function exact(value: unknown, expected: unknown, detail: string): void {
  requireProof(JSON.stringify(value) === JSON.stringify(expected), detail);
}
function keys(value: unknown, expected: readonly string[]): void {
  requireProof(value !== null && typeof value === "object" && !Array.isArray(value), "record required");
  exact(Object.keys(value), expected, "exact ordered record keys required");
}
function integer(value: number): void {
  requireProof(Number.isSafeInteger(value) && value >= 0, "nonnegative safe byte coordinate required");
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function pin(bytes: Buffer, expected: Pin, path: string): void {
  requireProof(bytes.length === expected.bytes && digest(bytes) === expected.sha256, `full pin changed ${path}`);
  if (expected.gitBlob !== undefined) {
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    requireProof(blob === expected.gitBlob, `Git blob changed ${path}`);
  }
}
function primitive(raw: string): void {
  requireProof(typeof raw === "string", "primitive source required");
}
function read(path: string, reader: AuthorityReader): Buffer {
  requireProof(path === receiptPath || sources.some((source) => source.path === path), "fixed reader path required");
  const raw = reader(path);
  requireProof(typeof raw === "string", `primitive authority text required ${path}`);
  return Buffer.from(raw, "utf8");
}
function physicalReader(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}
function readerFor(reader: AuthorityReader | undefined): AuthorityReader {
  requireProof(reader === undefined || typeof reader === "function", "authority reader must be a function");
  return reader ?? physicalReader;
}
function sourcePin(path: string): SourcePin {
  const source = sources.find((candidate) => candidate.path === path);
  requireProof(source, `unknown fixed source ${path}`);
  return source;
}
function modifier(value: readonly [string, string] | null, name: string, expected: readonly [string, string]): void {
  if (value === null) return;
  requireProof(name === "LinearLayoutBase", "only the private base export modifier is permitted");
  exact(value, expected, "exact private base export modifier required");
}
function sourcePiece(piece: InverseSource | ForwardSource): void {
  requireProof(typeof piece.name === "string" && piece.name.length > 0, "named declaration required");
  integer(piece.offset);
  integer(piece.length);
  requireProof(piece.length > 0, "nonempty source fragment required");
  requireProof(typeof piece.leading === "string" && /^\s*$/.test(piece.leading), "exact leading separator required");
  requireProof(/^[a-f0-9]{64}$/.test(piece.sourceSha256), "fragment digest required");
}
function authenticateReceipt(reader: AuthorityReader): Receipt {
  // The independent raw pin binds every fixed piece/value before JSON parsing.
  const bytes = read(receiptPath, reader);
  pin(bytes, receiptPin, receiptPath);
  const receipt = JSON.parse(bytes.toString("utf8")) as Receipt;
  keys(receipt, ["schema", "sourceBase", "sourceFreezeSha256", "sourceInputs", "pairs"]);
  requireProof(receipt.schema === "ir-lowering-analysis-relocation-v1", "fixed receipt schema required");
  requireProof(receipt.sourceBase === "549b476e6a3ce6bfdb1a27a55bac6511a902a783", "fixed source base required");
  requireProof(
    receipt.sourceFreezeSha256 === "144faf79398186b8392607a97d90ff351d6e5b3fe803396d2ad50682d30b5afe",
    "fixed source freeze required",
  );
  exact(receipt.sourceInputs, sources, "exact ordered four source pins required");
  requireProof(Array.isArray(receipt.pairs) && receipt.pairs.length === 2, "exact two source pairs required");
  for (const [index, pair] of receipt.pairs.entries()) {
    const fixed = pairs[index];
    requireProof(fixed, "fixed pair required");
    keys(pair, ["name", "donorPath", "beforePin", "currentPaths", "inverse", "forward"]);
    requireProof(
      pair.name === fixed.name && pair.donorPath === fixed.beforePin.path,
      "fixed ordered source pair required",
    );
    exact(pair.beforePin, fixed.beforePin, "authentic donor pin required");
    exact(pair.currentPaths, fixed.currentPaths, "exact pair source domain required");
    keys(pair.inverse, ["label", "beforePin", "beforeDerivedFromActualCurrent", "completeCoverage", "pieces"]);
    exact(
      pair.inverse.beforePin,
      { bytes: fixed.beforePin.bytes, sha256: fixed.beforePin.sha256 },
      "inverse donor pin required",
    );
    requireProof(
      pair.inverse.label === fixed.label &&
        pair.inverse.beforeDerivedFromActualCurrent === true &&
        pair.inverse.completeCoverage === true,
      "complete current-derived inverse required",
    );
    requireProof(
      Array.isArray(pair.inverse.pieces) && pair.inverse.pieces.length === fixed.inverseCount,
      "exact inverse piece population required",
    );
    let reverseModifiers = 0;
    for (const piece of pair.inverse.pieces) {
      integer(piece.beforeOffset);
      if (piece.kind === "literal-import" || piece.kind === "literal-trailer") {
        keys(piece, ["kind", "beforeOffset", "text"]);
        requireProof(typeof piece.text === "string", "literal header or separator required");
      } else {
        requireProof(piece.kind === "moved" || piece.kind === "retained", "fixed inverse piece kind required");
        keys(piece, [
          "kind",
          "name",
          "path",
          "offset",
          "length",
          "sourceSha256",
          "leading",
          "reverseModifier",
          "beforeOffset",
        ]);
        sourcePiece(piece);
        requireProof(
          piece.path === fixed.currentPaths[piece.kind === "retained" ? 0 : 1],
          "inverse retained/moved path required",
        );
        modifier(piece.reverseModifier, piece.name, reverseBase);
        if (piece.reverseModifier !== null) reverseModifiers++;
      }
    }
    requireProof(reverseModifiers === (index === 0 ? 1 : 0), "singular private base inverse modifier required");
    requireProof(Array.isArray(pair.forward) && pair.forward.length === 2, "two complete forward files required");
    let forwardModifiers = 0;
    for (const [fileIndex, forward] of pair.forward.entries()) {
      keys(forward, ["path", "currentPin", "completeCoverage", "forwardFromAuthenticOriginal", "pieces"]);
      requireProof(forward.path === fixed.currentPaths[fileIndex], "fixed forward path/order required");
      const current = sourcePin(forward.path);
      exact(forward.currentPin, { bytes: current.bytes, sha256: current.sha256 }, "forward current pin required");
      requireProof(
        forward.completeCoverage === true && forward.forwardFromAuthenticOriginal === true,
        "complete authentic forward required",
      );
      requireProof(
        Array.isArray(forward.pieces) && forward.pieces.length === fixed.forwardCounts[fileIndex],
        "exact forward piece population required",
      );
      for (const piece of forward.pieces) {
        integer(piece.afterOffset);
        if (piece.kind === "literal-header-or-forward" || piece.kind === "literal-trailer") {
          keys(
            piece,
            piece.kind === "literal-header-or-forward"
              ? ["kind", "afterOffset", "text"]
              : ["kind", "text", "afterOffset"],
          );
          requireProof(typeof piece.text === "string", "literal forward header or separator required");
        } else {
          requireProof(piece.kind === "original-declaration", "fixed forward piece kind required");
          keys(piece, [
            "kind",
            "name",
            "original",
            "offset",
            "length",
            "sourceSha256",
            "leading",
            "forwardModifier",
            "afterOffset",
          ]);
          sourcePiece(piece);
          requireProof(piece.original === fixed.label, "authentic original source domain required");
          modifier(piece.forwardModifier, piece.name, forwardBase);
          if (piece.forwardModifier !== null) {
            requireProof(forward.path === sources[1].path, "private base export owner required");
            forwardModifiers++;
          }
        }
      }
    }
    requireProof(forwardModifiers === (index === 0 ? 1 : 0), "singular private base forward modifier required");
  }
  return receipt;
}
function fragment(bytes: Buffer, piece: InverseSource | ForwardSource): Buffer {
  integer(bytes.length);
  requireProof(
    Number.isSafeInteger(piece.offset + piece.length) && piece.offset + piece.length <= bytes.length,
    "source fragment in range required",
  );
  const value = bytes.subarray(piece.offset, piece.offset + piece.length);
  requireProof(digest(value) === piece.sourceSha256, "exact source fragment pin required");
  requireProof(Buffer.from(value.toString("utf8"), "utf8").equals(value), "whole UTF8 source fragment required");
  return value;
}
function transform(bytes: Buffer, change: readonly [string, string] | null): Buffer {
  if (change === null) return bytes;
  const raw = bytes.toString("utf8");
  const index = raw.indexOf(change[0]);
  requireProof(
    index >= 0 && raw.indexOf(change[0], index + change[0].length) === -1,
    "singular base export text required",
  );
  return Buffer.from(raw.slice(0, index) + change[1] + raw.slice(index + change[0].length), "utf8");
}
function provePair(pair: Pair, current: ReadonlyMap<string, Buffer>): string {
  const output: Buffer[] = [];
  let offset = 0;
  for (const piece of pair.inverse.pieces) {
    requireProof(piece.beforeOffset === offset, "complete ordered inverse coverage required");
    let part: Buffer;
    if (piece.kind === "literal-import" || piece.kind === "literal-trailer") part = Buffer.from(piece.text, "utf8");
    else {
      const source = current.get(piece.path);
      requireProof(source, "actual current pair source required");
      part = Buffer.concat([
        Buffer.from(piece.leading, "utf8"),
        transform(fragment(source, piece), piece.reverseModifier),
      ]);
    }
    output.push(part);
    offset += part.length;
    integer(offset);
  }
  requireProof(offset === pair.beforePin.bytes, "complete original byte population required");
  const original = Buffer.concat(output);
  pin(original, pair.beforePin, pair.donorPath);
  for (const forward of pair.forward) {
    const pieces: Buffer[] = [];
    let afterOffset = 0;
    for (const piece of forward.pieces) {
      requireProof(piece.afterOffset === afterOffset, "complete ordered forward coverage required");
      const part =
        piece.kind === "original-declaration"
          ? Buffer.concat([
              Buffer.from(piece.leading, "utf8"),
              transform(fragment(original, piece), piece.forwardModifier),
            ])
          : Buffer.from(piece.text, "utf8");
      pieces.push(part);
      afterOffset += part.length;
      integer(afterOffset);
    }
    requireProof(afterOffset === forward.currentPin.bytes, "complete current byte population required");
    const replay = Buffer.concat(pieces);
    pin(replay, sourcePin(forward.path), forward.path);
    const actual = current.get(forward.path);
    requireProof(actual && replay.equals(actual), `exact reciprocal current equality required ${forward.path}`);
  }
  return original.toString("utf8");
}

/** Prove the retained adapter and canonical verifier, returning the authentic old donor. */
export function captureLoweringLegalityPredecessor(rawCurrent: string, readAuthority?: AuthorityReader): string {
  primitive(rawCurrent);
  const reader = readerFor(readAuthority);
  const receipt = authenticateReceipt(reader);
  const adapter = read(sources[2].path, reader);
  pin(adapter, sources[2], sources[2].path);
  const owner = read(sources[3].path, reader);
  pin(owner, sources[3], sources[3].path);
  requireProof(Buffer.from(rawCurrent, "utf8").equals(adapter), `supplied current source differs ${sources[2].path}`);
  return provePair(
    receipt.pairs[1]!,
    new Map([
      [sources[2].path, adapter],
      [sources[3].path, owner],
    ]),
  );
}

/** The supplied planner is the caller's actual current channel, never a historical resolver substitute. */
export function captureLinearLayoutPredecessor(rawCurrent: string, readAuthority?: AuthorityReader): string {
  primitive(rawCurrent);
  const reader = readerFor(readAuthority);
  const receipt = authenticateReceipt(reader);
  const planner = Buffer.from(rawCurrent, "utf8");
  pin(planner, sources[0], sources[0].path);
  const layout = read(sources[1].path, reader);
  pin(layout, sources[1], sources[1].path);
  return provePair(
    receipt.pairs[0]!,
    new Map([
      [sources[0].path, planner],
      [sources[1].path, layout],
    ]),
  );
}

/** Authenticate the finite early.return extension before the unchanged historical pair proof. */
export function captureCurrentLoweringLegalityPredecessor(rawCurrent: string, readAuthority?: AuthorityReader): string {
  primitive(rawCurrent);
  const reader = readerFor(readAuthority);
  return captureLoweringLegalityPredecessor(rawCurrent, (path) => {
    if (path !== sources[3].path) return reader(path);
    const current = read(path, reader);
    pin(
      current,
      {
        bytes: 21387,
        sha256: "cdd60287d9c98f700eca41f351f02ac609f3e9fdd43a25e28d7951f16f0c1a37",
        gitBlob: "157777ff1c14c6cf5f0e4241c4e361843d694f5b",
      },
      path,
    );
    const offset = 8250;
    const insertion = Buffer.from('    case "early.return":\n', "utf8");
    requireProof(
      current.subarray(offset, offset + insertion.length).equals(insertion),
      "exact early.return extension required",
    );
    const predecessor = Buffer.concat([current.subarray(0, offset), current.subarray(offset + insertion.length)]);
    pin(predecessor, sources[3], path);
    const replay = Buffer.concat([predecessor.subarray(0, offset), insertion, predecessor.subarray(offset)]);
    requireProof(replay.equals(current), "exact early.return replay required");
    return predecessor.toString("utf8");
  });
}
export interface LinearLayoutGeometryCapture {
  readonly currentPlanner: string;
  readonly currentLayout: string;
  readonly currentShared: string;
  readonly geometryBeforePlanner: string;
  readonly geometryBeforeLayout: string;
  readonly loweringBeforePlanner: string;
  readonly loweringBeforeLayout: string;
  readonly originalPlanner: string;
}

interface GeometryCopy {
  readonly kind: "copy";
  readonly name: string;
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly sourceSha256: string;
  readonly outputOffset: number;
}
interface GeometryLiteral {
  readonly kind: "literal";
  readonly name: string;
  readonly text: string;
  readonly outputOffset: number;
}
interface GeometryRecipe {
  readonly path: string;
  readonly pin: Pin;
  readonly pieces: readonly (GeometryCopy | GeometryLiteral)[];
}
interface GeometryCoverage {
  readonly path: string;
  readonly spans: readonly {
    readonly offset: number;
    readonly length: number;
    readonly sha256: string;
    readonly uses: number;
  }[];
}
interface GeometryReceipt {
  readonly schema: string;
  readonly sourceBase: string;
  readonly currentInputs: readonly (Pin & { readonly path: string })[];
  readonly geometryBeforeInputs: readonly (Pin & { readonly path: string })[];
  readonly sharedAbsentBefore: boolean;
  readonly oldAuthority: unknown;
  readonly geometry: {
    readonly inverse: readonly GeometryRecipe[];
    readonly inverseCoverage: readonly GeometryCoverage[];
    readonly forward: readonly GeometryRecipe[];
    readonly forwardCoverage: readonly GeometryCoverage[];
  };
  readonly forwarding: {
    readonly commit: string;
    readonly parent: string;
    readonly path: string;
    readonly offset: number;
    readonly length: number;
    readonly beforePin: Pin;
    readonly afterPin: Pin;
    readonly inverseText: string;
    readonly forwardText: string;
  };
}

const geometryReceiptPath = "tests/helpers/ir-linear-layout-geometry-successor.json";
// ROOT supplies the reviewed finite receipt pin in the explicit activation step.
// The authoring entry is fail-closed; candidate bytes cannot grant themselves trust.
const geometryReceiptPin: Pin | null = {
  bytes: 69621,
  sha256: "e4af32c53ea548b693fbcee78c55b3af47b7985e2dc1b340ddf9c28e0a8f573f",
};

const geometryCurrentInputs = [
  {
    path: "src/ir/analysis/linear-memory-plan.ts",
    bytes: 45359,
    sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",
    gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",
  },
  {
    path: "src/ir/analysis/contracts/linear-memory-layout.ts",
    bytes: 3161,
    sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",
    gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",
  },
  {
    path: "src/shared/contracts/linear-memory-layout.ts",
    bytes: 7580,
    sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",
    gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",
  },
] as const;

const geometryBeforeInputs = [
  {
    path: "src/ir/analysis/linear-memory-plan.ts",
    bytes: 49040,
    sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
    gitBlob: "a44148b86cf60d75a8ebcd9decd2f0fc3a5aad1c",
  },
  {
    path: "src/ir/analysis/contracts/linear-memory-layout.ts",
    bytes: 4763,
    sha256: "977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754",
    gitBlob: "280a72ab47f43584f93efb664e3e64b55dc896b5",
  },
] as const;

const geometryOldAuthority = {
  helperPrefix: {
    path: "tests/helpers/ir-lowering-analysis-relocation.ts",
    bytes: 18956,
    sha256: "253eda01462fad0ab84a940965a083eaf80b0ca8a3e10a4ca012fbafaaf30e99",
  },
  receipt: {
    path: "tests/helpers/ir-lowering-analysis-relocation.json",
    bytes: 111423,
    sha256: "dc8241d36da5b2fe29abe12ed6ee348fc456ef22939c61aabe05d09daad92134",
    gitBlob: "6fee96e10bb22a1f3071ddc41b4a2af39ee96763",
  },
} as const;

const geometryForwarding = {
  commit: "2a98b75de993bdc568e3668a2965c026876fe322",
  parent: "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",
  path: "src/ir/analysis/contracts/linear-memory-layout.ts",
  offset: 2820,
  length: 93,
  beforePin: {
    bytes: 4670,
    sha256: "dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72",
    gitBlob: "cac9d1e33659380a6ee8d8e03014af53e1123533",
  },
  afterPin: {
    bytes: 4763,
    sha256: "977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754",
    gitBlob: "280a72ab47f43584f93efb664e3e64b55dc896b5",
  },
  inverseText: '  | {\n      readonly family: "vector";\n      readonly operation: "resolve-forwarding";\n    }\n',
  forwardText: '  | {\n      readonly family: "vector";\n      readonly operation: "resolve-forwarding";\n    }\n',
} as const;

const geometryInverseCounts = [37, 6] as const;
const geometryForwardCounts = [15, 9, 47] as const;
const geometryInverseCoverageCounts = [17, 5, 45] as const;
const geometryForwardCoverageCounts = [52, 6] as const;
const geometryInverseLiteralBytes = [141, 0] as const;
const geometryForwardLiteralBytes = [1429, 169, 589] as const;

function geometryRead(path: string, reader: AuthorityReader): Buffer {
  requireProof(
    path === geometryReceiptPath || geometryCurrentInputs.some((source) => source.path === path),
    "fixed geometry reader path required",
  );
  const raw = reader(path);
  requireProof(typeof raw === "string", `primitive geometry authority text required ${path}`);
  return Buffer.from(raw, "utf8");
}

function authenticateGeometryReceipt(reader: AuthorityReader): GeometryReceipt {
  const authority: Pin | null = geometryReceiptPin;
  requireProof(authority !== null, "geometry receipt authority not activated");
  const bytes = geometryRead(geometryReceiptPath, reader);
  pin(bytes, authority, geometryReceiptPath);
  const receipt = JSON.parse(bytes.toString("utf8")) as GeometryReceipt;
  keys(receipt, [
    "schema",
    "sourceBase",
    "currentInputs",
    "geometryBeforeInputs",
    "sharedAbsentBefore",
    "oldAuthority",
    "geometry",
    "forwarding",
  ]);
  requireProof(receipt.schema === "ir-linear-layout-geometry-successor-v1", "fixed geometry receipt schema required");
  requireProof(
    receipt.sourceBase === "b932e3a05e353acc59e7b547ef4e417a5d8637e1",
    "fixed geometry source base required",
  );
  exact(receipt.currentInputs, geometryCurrentInputs, "exact ordered three geometry source pins required");
  exact(receipt.geometryBeforeInputs, geometryBeforeInputs, "exact ordered two geometry predecessor pins required");
  requireProof(receipt.sharedAbsentBefore === true, "shared owner must be absent at geometry predecessor");
  exact(receipt.oldAuthority, geometryOldAuthority, "immutable old helper and receipt authority required");
  keys(receipt.geometry, ["inverse", "inverseCoverage", "forward", "forwardCoverage"]);
  exact(receipt.forwarding, geometryForwarding, "separate authentic 93-byte forwarding epoch required");
  return receipt;
}

function geometryPieceName(name: string): void {
  requireProof(typeof name === "string" && name.length > 0, "named geometry span or local literal reason required");
}

function geometryFragment(bytes: Buffer, piece: GeometryCopy): Buffer {
  integer(piece.offset);
  integer(piece.length);
  requireProof(piece.length > 0, "nonempty geometry source span required");
  requireProof(
    Number.isSafeInteger(piece.offset + piece.length) && piece.offset + piece.length <= bytes.length,
    "geometry source span in range required",
  );
  const part = bytes.subarray(piece.offset, piece.offset + piece.length);
  requireProof(digest(part) === piece.sourceSha256, "exact geometry source span pin required");
  requireProof(Buffer.from(part.toString("utf8"), "utf8").equals(part), "whole UTF8 geometry source span required");
  return part;
}

function geometryReplay(
  recipes: readonly GeometryRecipe[],
  inputs: ReadonlyMap<string, Buffer>,
  outputs: readonly (Pin & { readonly path: string })[],
  counts: readonly number[],
  literalBytes: readonly number[],
): ReadonlyMap<string, Buffer> {
  requireProof(
    Array.isArray(recipes) && recipes.length === outputs.length,
    "exact geometry output population required",
  );
  const result = new Map<string, Buffer>();
  for (const [index, recipe] of recipes.entries()) {
    const expected = outputs[index];
    requireProof(expected, "fixed geometry output required");
    keys(recipe, ["path", "pin", "pieces"]);
    requireProof(recipe.path === expected.path, "fixed ordered geometry output path required");
    const { path: _path, ...expectedPin } = expected;
    exact(recipe.pin, expectedPin, "full geometry output pin required");
    requireProof(
      Array.isArray(recipe.pieces) && recipe.pieces.length === counts[index],
      "exact geometry piece population required",
    );
    let offset = 0;
    let literals = 0;
    const parts: Buffer[] = [];
    for (const piece of recipe.pieces) {
      integer(piece.outputOffset);
      requireProof(piece.outputOffset === offset, "complete ordered geometry output coverage required");
      geometryPieceName(piece.name);
      let part: Buffer;
      if (piece.kind === "copy") {
        keys(piece, ["kind", "name", "path", "offset", "length", "sourceSha256", "outputOffset"]);
        const source = inputs.get(piece.path);
        requireProof(source, "fixed captured geometry donor path required");
        part = geometryFragment(source, piece);
      } else {
        requireProof(piece.kind === "literal", "fixed geometry piece kind required");
        keys(piece, ["kind", "name", "text", "outputOffset"]);
        requireProof(typeof piece.text === "string", "primitive local geometry literal required");
        part = Buffer.from(piece.text, "utf8");
        requireProof(part.length > 0 && part.length <= 1141, "bounded nonempty local geometry literal required");
        literals += part.length;
        integer(literals);
      }
      parts.push(part);
      offset += part.length;
      integer(offset);
    }
    requireProof(literals === literalBytes[index], "exact local geometry literal byte population required");
    requireProof(offset === expected.bytes, "complete geometry output byte population required");
    const replay = Buffer.concat(parts);
    pin(replay, expected, expected.path);
    result.set(expected.path, replay);
  }
  return result;
}

function geometryCoverage(
  coverage: readonly GeometryCoverage[],
  recipes: readonly GeometryRecipe[],
  inputs: ReadonlyMap<string, Buffer>,
  counts: readonly number[],
): void {
  requireProof(
    Array.isArray(coverage) && coverage.length === inputs.size,
    "complete geometry donor population required",
  );
  const paths = [...inputs.keys()];
  for (const [index, record] of coverage.entries()) {
    keys(record, ["path", "spans"]);
    requireProof(record.path === paths[index], "fixed ordered geometry donor coverage required");
    const source = inputs.get(record.path);
    requireProof(source, "captured geometry coverage source required");
    requireProof(
      Array.isArray(record.spans) && record.spans.length === counts[index],
      "exact geometry coverage span population required",
    );
    const copies = recipes
      .flatMap((recipe) => recipe.pieces)
      .filter((piece): piece is GeometryCopy => piece.kind === "copy" && piece.path === record.path);
    let offset = 0;
    const boundaries = new Set<number>([0]);
    for (const span of record.spans) {
      keys(span, ["offset", "length", "sha256", "uses"]);
      integer(span.offset);
      integer(span.length);
      integer(span.uses);
      requireProof(span.offset === offset && span.length > 0, "no holes or overlaps in geometry donor spans required");
      offset += span.length;
      integer(offset);
      requireProof(offset <= source.length, "geometry donor coverage in range required");
      boundaries.add(offset);
      const uses = copies.filter(
        (piece) => piece.offset <= span.offset && offset <= piece.offset + piece.length,
      ).length;
      requireProof(uses === span.uses, "exact geometry source span multiplicity required");
      requireProof(
        digest(source.subarray(span.offset, offset)) === span.sha256,
        "full geometry coverage span pin required",
      );
    }
    requireProof(offset === source.length, "complete geometry donor byte consumption required");
    for (const piece of copies) {
      requireProof(
        boundaries.has(piece.offset) && boundaries.has(piece.offset + piece.length),
        "geometry copy endpoints must coincide with declared coverage boundaries",
      );
    }
  }
}

/** Capture the finite current geometry, separate forwarding predecessor and unchanged old donor proof. */
export function captureLinearLayoutGeometry(
  rawCurrentPlanner: string,
  readAuthority?: (path: string) => string,
): LinearLayoutGeometryCapture {
  primitive(rawCurrentPlanner);
  const reader = readerFor(readAuthority);
  const receipt = authenticateGeometryReceipt(reader);
  const current = new Map<string, Buffer>();
  for (const source of geometryCurrentInputs) {
    const bytes = geometryRead(source.path, reader);
    pin(bytes, source, source.path);
    if (source.path === sources[0].path) {
      requireProof(
        Buffer.from(rawCurrentPlanner, "utf8").equals(bytes),
        `supplied current geometry source differs ${source.path}`,
      );
    }
    current.set(source.path, bytes);
  }
  const before = geometryReplay(
    receipt.geometry.inverse,
    current,
    geometryBeforeInputs,
    geometryInverseCounts,
    geometryInverseLiteralBytes,
  );
  geometryCoverage(receipt.geometry.inverseCoverage, receipt.geometry.inverse, current, geometryInverseCoverageCounts);
  const geometryPlanner = before.get(sources[0].path)!;
  const geometryLayout = before.get(sources[1].path)!;
  const forwarding = receipt.forwarding;
  const inverseInsertion = Buffer.from(forwarding.inverseText, "utf8");
  requireProof(
    inverseInsertion.length === forwarding.length &&
      geometryLayout.subarray(forwarding.offset, forwarding.offset + forwarding.length).equals(inverseInsertion),
    "exact separate forwarding inverse insertion required",
  );
  const loweringLayout = Buffer.concat([
    geometryLayout.subarray(0, forwarding.offset),
    geometryLayout.subarray(forwarding.offset + forwarding.length),
  ]);
  pin(loweringLayout, forwarding.beforePin, forwarding.path);
  const forwardInsertion = Buffer.from(forwarding.forwardText, "utf8");
  requireProof(forwardInsertion.length === forwarding.length, "exact separate forwarding forward insertion required");
  const forwardingReplay = Buffer.concat([
    loweringLayout.subarray(0, forwarding.offset),
    forwardInsertion,
    loweringLayout.subarray(forwarding.offset),
  ]);
  pin(forwardingReplay, forwarding.afterPin, forwarding.path);
  requireProof(forwardingReplay.equals(geometryLayout), "independent forwarding full equality required");
  const forwardInputs = new Map([
    [sources[0].path, geometryPlanner],
    [sources[1].path, forwardingReplay],
  ]);
  const replay = geometryReplay(
    receipt.geometry.forward,
    forwardInputs,
    geometryCurrentInputs,
    geometryForwardCounts,
    geometryForwardLiteralBytes,
  );
  geometryCoverage(
    receipt.geometry.forwardCoverage,
    receipt.geometry.forward,
    forwardInputs,
    geometryForwardCoverageCounts,
  );
  for (const [path, actual] of current) {
    requireProof(replay.get(path)?.equals(actual), `independent geometry complete current equality required ${path}`);
  }
  const loweringPlannerText = geometryPlanner.toString("utf8");
  const loweringLayoutText = loweringLayout.toString("utf8");
  const originalPlanner = captureLinearLayoutPredecessor(loweringPlannerText, (path) => {
    if (path === receiptPath) return reader(path);
    if (path === sources[1].path) return loweringLayoutText;
    requireProof(false, "closed geometry predecessor reader path required");
  });
  return Object.freeze({
    currentPlanner: current.get(sources[0].path)!.toString("utf8"),
    currentLayout: current.get(sources[1].path)!.toString("utf8"),
    currentShared: current.get(geometryCurrentInputs[2].path)!.toString("utf8"),
    geometryBeforePlanner: loweringPlannerText,
    geometryBeforeLayout: geometryLayout.toString("utf8"),
    loweringBeforePlanner: loweringPlannerText,
    loweringBeforeLayout: loweringLayoutText,
    originalPlanner,
  });
}
