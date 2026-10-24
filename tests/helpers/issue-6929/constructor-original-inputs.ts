// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const EXPECTED_SOURCE_PIN = Object.freeze({
  repository: "https://github.com/tc39/test262.git",
  gitlinkPath: "test262",
  revision: "b363f29d3c43c626dc852744ad64a0b48a003693",
});
const EXPECTED_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  "proxy-non-callable-throws.js": 416,
  "proxy-bound-function.js": 799,
  "proxy-function-expression.js": 775,
  "proxy-generator-function.js": 803,
  "proxy-arrow-function.js": 776,
  "proxy-method-definition.js": 791,
  "GeneratorFunction.js": 668,
  "proxy-class.js": 769,
  "not-a-constructor.js": 1013,
});
const EXPECTED_LICENSE = Object.freeze({
  canonicalPath: "LICENSE",
  archivePath: "LICENSE",
  bytes: 2213,
  sha256: "4dd9244dfe8197c75348c4b24ab53d29d3b1cfad143ac76b5a3d8942aa354ce0",
});
const PREFIX = "test/built-ins/Function/prototype/toString/";
const CANONICAL_EXECUTION = "ROOT REQUIRED; no verdicts from this manifest";
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const names = Object.keys(EXPECTED_LENGTHS);
const archiveName = (name: string): string => `${name}.archive.txt`;

type InputRoots = {
  archiveRoot: string;
  corpusRoot: string;
  expectedOriginals: Readonly<Record<string, string>>;
};
type SourceRow = {
  name: string;
  canonicalPath: string;
  archivePath: string;
  bytes: number;
  sha256: string;
};
type Provenance = {
  schemaVersion: number;
  repository: string;
  gitlinkPath: string;
  revision: string;
  license: typeof EXPECTED_LICENSE;
  rows: SourceRow[];
};
type CorpusReceipt =
  | { status: "UNAVAILABLE"; reason: "root-absent" | "root-empty"; verified: 0 }
  | { status: "VERIFIED"; verified: 9; rows: (SourceRow & { physicalPath: string })[] };

export class OriginalInputError extends Error {
  readonly causeCode: string | undefined;

  constructor(
    readonly code: string,
    readonly stage: "archive" | "metadata" | "corpus",
    readonly path: string,
    readonly detail: unknown,
    readonly cause?: unknown,
  ) {
    super(`${stage}:${code} at ${path}: ${JSON.stringify(detail)}`);
    this.name = "OriginalInputError";
    this.causeCode =
      cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  }
}

function refuse(code: string, stage: OriginalInputError["stage"], path: string, detail: unknown): never {
  throw new OriginalInputError(code, stage, path, detail);
}

function io<T>(code: string, stage: OriginalInputError["stage"], path: string, read: () => T): T {
  try {
    return read();
  } catch (cause) {
    throw new OriginalInputError(code, stage, path, "filesystem operation failed", cause);
  }
}

function exactKeys(value: unknown, expected: string[], path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("METADATA_KEYS", "metadata", path, "expected object");
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    refuse("METADATA_KEYS", "metadata", path, { expected, actual });
  }
}

function validateAuthority(expectedOriginals: InputRoots["expectedOriginals"], path: string): void {
  if (JSON.stringify(Object.keys(expectedOriginals)) !== JSON.stringify(names)) {
    refuse("EXPECTED_IDENTITIES", "metadata", path, Object.keys(expectedOriginals));
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(expectedOriginals[name]!)) {
      refuse("EXPECTED_DIGEST", "metadata", path, name);
    }
  }
}

function readOrdinaryArchiveFile(path: string): Buffer {
  const entry = io("ARCHIVE_FILE", "archive", path, () => lstatSync(path));
  if (!entry.isFile() || entry.isSymbolicLink()) {
    refuse("ARCHIVE_FILE_KIND", "archive", path, "ordinary file required");
  }
  return io("ARCHIVE_FILE", "archive", path, () => readFileSync(path));
}

function verifyBytes(
  bytes: Buffer,
  expectedBytes: number,
  expectedSha: string,
  path: string,
  stage: "archive" | "corpus",
  prefix: string,
): void {
  if (bytes.length !== expectedBytes) {
    refuse(`${prefix}_LENGTH`, stage, path, { expected: expectedBytes, actual: bytes.length });
  }
  const actual = sha256(bytes);
  if (actual !== expectedSha) refuse(`${prefix}_HASH`, stage, path, { expected: expectedSha, actual });
}

function validateProvenance(
  bytes: Buffer,
  path: string,
  expectedOriginals: InputRoots["expectedOriginals"],
): Provenance {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new OriginalInputError("METADATA_PARSE", "metadata", path, "invalid JSON", cause);
  }
  exactKeys(value, ["schemaVersion", "repository", "gitlinkPath", "revision", "license", "rows"], path);
  if (value.schemaVersion !== 1) refuse("METADATA_SCHEMA", "metadata", path, value.schemaVersion);
  for (const [key, expected] of Object.entries(EXPECTED_SOURCE_PIN)) {
    if (value[key] !== expected) {
      refuse("METADATA_PIN", "metadata", path, { field: key, expected, actual: value[key] });
    }
  }
  exactKeys(value.license, ["canonicalPath", "archivePath", "bytes", "sha256"], path);
  for (const [key, expected] of Object.entries(EXPECTED_LICENSE)) {
    if (value.license[key] !== expected) {
      refuse("METADATA_LICENSE", "metadata", path, { field: key, expected, actual: value.license[key] });
    }
  }
  if (!Array.isArray(value.rows) || value.rows.length !== 9) {
    refuse("METADATA_ROWS", "metadata", path, {
      expected: 9,
      actual: Array.isArray(value.rows) ? value.rows.length : null,
    });
  }
  for (const [index, name] of names.entries()) {
    const row: unknown = value.rows[index];
    exactKeys(row, ["name", "canonicalPath", "archivePath", "bytes", "sha256"], path);
    if (row.name !== name) {
      refuse("METADATA_IDENTITY", "metadata", path, { index, expected: name, actual: row.name });
    }
    const expectedPaths = { canonicalPath: `${PREFIX}${name}`, archivePath: archiveName(name) };
    for (const [key, expected] of Object.entries(expectedPaths)) {
      if (row[key] !== expected) {
        refuse("METADATA_PATH", "metadata", path, { index, field: key, expected, actual: row[key] });
      }
    }
    if (row.bytes !== EXPECTED_LENGTHS[name]) {
      refuse("METADATA_LENGTH", "metadata", path, { index, expected: EXPECTED_LENGTHS[name], actual: row.bytes });
    }
    if (row.sha256 !== expectedOriginals[name]) {
      refuse("METADATA_HASH", "metadata", path, { index, expected: expectedOriginals[name], actual: row.sha256 });
    }
  }
  return value as unknown as Provenance;
}

function authenticateArchive(archiveRoot: string, expectedOriginals: InputRoots["expectedOriginals"]) {
  const root = resolve(archiveRoot);
  const metadataPath = join(root, "provenance.json");
  validateAuthority(expectedOriginals, metadataPath);
  const entry = io("ARCHIVE_ROOT", "archive", root, () => lstatSync(root));
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    refuse("ARCHIVE_ROOT_KIND", "archive", root, "ordinary directory required");
  }
  const actual = io("ARCHIVE_INVENTORY", "archive", root, () => readdirSync(root)).sort();
  const expected = [...names.map(archiveName), "LICENSE", "provenance.json"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    refuse("ARCHIVE_INVENTORY", "archive", root, {
      missing: expected.filter((name) => !actual.includes(name)),
      extra: actual.filter((name) => !expected.includes(name)),
    });
  }
  const metadataBytes = readOrdinaryArchiveFile(metadataPath);
  const provenance = validateProvenance(metadataBytes, metadataPath, expectedOriginals);
  const licensePath = join(root, "LICENSE");
  const licenseBytes = readOrdinaryArchiveFile(licensePath);
  verifyBytes(licenseBytes, EXPECTED_LICENSE.bytes, EXPECTED_LICENSE.sha256, licensePath, "archive", "LICENSE");
  const buffers = new Map<string, Buffer>();
  const rows = names.map((name): SourceRow => {
    const path = join(root, archiveName(name));
    const bytes = readOrdinaryArchiveFile(path);
    verifyBytes(bytes, EXPECTED_LENGTHS[name]!, expectedOriginals[name]!, path, "archive", "ARCHIVE");
    buffers.set(name, bytes);
    return {
      name,
      canonicalPath: `${PREFIX}${name}`,
      archivePath: archiveName(name),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  assert.equal(
    rows.reduce((total, row) => total + row.bytes, 0),
    6810,
  );
  return { root, provenance, metadataBytes, licenseBytes, buffers, rows };
}

function requireCorpusDirectory(path: string, code: string): void {
  const entry = io(code, "corpus", path, () => lstatSync(path));
  const target = entry.isSymbolicLink() ? io(code, "corpus", path, () => statSync(path)) : entry;
  if (!target.isDirectory()) refuse(`${code}_KIND`, "corpus", path, "directory required");
}

function inspectCorpus(
  corpusRoot: string,
  archive: ReturnType<typeof authenticateArchive>,
  expectedOriginals: InputRoots["expectedOriginals"],
): CorpusReceipt {
  const root = resolve(corpusRoot);
  const parent = dirname(root);
  const parentEntry = io("CORPUS_PARENT", "corpus", parent, () => statSync(parent));
  if (!parentEntry.isDirectory()) {
    refuse("CORPUS_PARENT_KIND", "corpus", parent, "known directory parent required");
  }
  let entry;
  try {
    entry = lstatSync(root);
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return { status: "UNAVAILABLE", reason: "root-absent", verified: 0 };
    }
    throw new OriginalInputError("CORPUS_ROOT", "corpus", root, "root inspection failed", cause);
  }
  const target = entry.isSymbolicLink() ? io("CORPUS_ROOT", "corpus", root, () => statSync(root)) : entry;
  if (!target.isDirectory()) refuse("CORPUS_ROOT_KIND", "corpus", root, "directory required");
  const inventory = io("CORPUS_ROOT", "corpus", root, () => readdirSync(root));
  if (entry.isDirectory() && inventory.length === 0) {
    return { status: "UNAVAILABLE", reason: "root-empty", verified: 0 };
  }
  requireCorpusDirectory(join(root, "test"), "CORPUS_TEST");
  const rows = archive.rows.map((row) => {
    const path = join(root, row.canonicalPath);
    const sourceEntry = io("CORPUS_FILE", "corpus", path, () => lstatSync(path));
    const sourceTarget = sourceEntry.isSymbolicLink()
      ? io("CORPUS_FILE", "corpus", path, () => statSync(path))
      : sourceEntry;
    if (!sourceTarget.isFile()) refuse("CORPUS_FILE_KIND", "corpus", path, "file required");
    const bytes = io("CORPUS_FILE", "corpus", path, () => readFileSync(path));
    verifyBytes(bytes, EXPECTED_LENGTHS[row.name]!, expectedOriginals[row.name]!, path, "corpus", "CORPUS");
    if (!bytes.equals(archive.buffers.get(row.name)!)) {
      refuse("CORPUS_BYTES", "corpus", path, "archive byte mismatch");
    }
    return { ...row, bytes: bytes.length, sha256: sha256(bytes), physicalPath: path };
  });
  return { status: "VERIFIED", verified: 9, rows };
}

export function loadConstructorOriginalInputs({ archiveRoot, corpusRoot, expectedOriginals }: InputRoots) {
  const archive = authenticateArchive(archiveRoot, expectedOriginals);
  const corpus = inspectCorpus(corpusRoot, archive, expectedOriginals);
  return {
    inputOrigin: "committed-original-archive" as const,
    sourcePin: EXPECTED_SOURCE_PIN,
    archive: {
      verified: 9 as const,
      bytes: 6810,
      licenseSha256: sha256(archive.licenseBytes),
      rows: archive.rows,
    },
    corpus,
    canonicalExecution: CANONICAL_EXECUTION,
  };
}

type PrivateTree = InputRoots & { root: string; metadataPath: string };
type NegativeCase = {
  id: string;
  prepare: (tree: PrivateTree) => void;
  code: string;
  stage: OriginalInputError["stage"];
  path: (tree: PrivateTree) => string;
  causeCode?: string;
  detail?: unknown;
};

function privateTree(
  scratchRoot: string,
  archive: ReturnType<typeof authenticateArchive>,
  expectedOriginals: InputRoots["expectedOriginals"],
  id: string,
): PrivateTree {
  const root = mkdtempSync(join(scratchRoot, `${id}-`));
  const archiveRoot = join(root, "archive");
  mkdirSync(archiveRoot);
  for (const [name, bytes] of archive.buffers) writeFileSync(join(archiveRoot, archiveName(name)), bytes);
  writeFileSync(join(archiveRoot, "LICENSE"), archive.licenseBytes);
  const metadataPath = join(archiveRoot, "provenance.json");
  writeFileSync(metadataPath, archive.metadataBytes);
  return { root, archiveRoot, corpusRoot: join(root, "test262"), expectedOriginals, metadataPath };
}

function populateCorpus(tree: PrivateTree, archive: ReturnType<typeof authenticateArchive>, omitted?: string): void {
  for (const [name, bytes] of archive.buffers) {
    if (name === omitted) continue;
    const path = join(tree.corpusRoot, PREFIX, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

function changeMetadata(tree: PrivateTree, change: (value: Provenance) => void): void {
  const value: Provenance = JSON.parse(readFileSync(tree.metadataPath, "utf8"));
  change(value);
  writeFileSync(tree.metadataPath, `${JSON.stringify(value, null, 2)}\n`);
}

function changeByte(path: string): void {
  const bytes = readFileSync(path);
  bytes[0] = bytes[0]! ^ 1;
  writeFileSync(path, bytes);
}

function archiveNegatives(): NegativeCase[] {
  const first = names[0]!;
  const firstPath = (tree: PrivateTree): string => join(tree.archiveRoot, archiveName(first));
  const inventory = (missing: string[]): unknown => ({ missing, extra: [] });
  const missingInput = (id: string, name: string): NegativeCase => ({
    id,
    prepare: (tree) => unlinkSync(join(tree.archiveRoot, name)),
    code: "ARCHIVE_INVENTORY",
    stage: "archive",
    path: (tree) => tree.archiveRoot,
    detail: inventory([name]),
  });
  return [
    {
      id: "archive-root-absent",
      prepare: (tree) => {
        tree.archiveRoot = join(tree.root, "absent-archive");
      },
      code: "ARCHIVE_ROOT",
      stage: "archive",
      path: (tree) => tree.archiveRoot,
      causeCode: "ENOENT",
    },
    missingInput("archive-original-absent", archiveName(first)),
    {
      id: "archive-original-byte",
      prepare: (tree) => changeByte(firstPath(tree)),
      code: "ARCHIVE_HASH",
      stage: "archive",
      path: firstPath,
    },
    {
      id: "archive-proxy-class-byte",
      prepare: (tree) => changeByte(join(tree.archiveRoot, archiveName("proxy-class.js"))),
      code: "ARCHIVE_HASH",
      stage: "archive",
      path: (tree) => join(tree.archiveRoot, archiveName("proxy-class.js")),
    },
    {
      id: "archive-final-newline",
      prepare: (tree) => {
        const path = firstPath(tree);
        writeFileSync(path, readFileSync(path).subarray(0, -1));
      },
      code: "ARCHIVE_LENGTH",
      stage: "archive",
      path: firstPath,
      detail: { expected: 416, actual: 415 },
    },
    missingInput("license-absent", "LICENSE"),
    {
      id: "license-byte",
      prepare: (tree) => changeByte(join(tree.archiveRoot, "LICENSE")),
      code: "LICENSE_HASH",
      stage: "archive",
      path: (tree) => join(tree.archiveRoot, "LICENSE"),
    },
    missingInput("provenance-absent", "provenance.json"),
    {
      id: "archive-original-symlink",
      prepare: (tree) => {
        const target = join(tree.root, "linked-original");
        writeFileSync(target, readFileSync(firstPath(tree)));
        unlinkSync(firstPath(tree));
        symlinkSync(target, firstPath(tree));
      },
      code: "ARCHIVE_FILE_KIND",
      stage: "archive",
      path: firstPath,
    },
  ];
}

function metadataNegatives(): NegativeCase[] {
  const rowCase = (id: string, change: (value: Provenance) => void, code: string, detail?: unknown): NegativeCase => ({
    id,
    prepare: (tree) => changeMetadata(tree, change),
    code,
    stage: "metadata",
    path: (tree) => tree.metadataPath,
    detail,
  });
  const cases = [
    rowCase(
      "provenance-row-omitted",
      (value) => {
        value.rows.pop();
      },
      "METADATA_ROWS",
      { expected: 9, actual: 8 },
    ),
    rowCase(
      "provenance-row-duplicate",
      (value) => {
        value.rows[8] = { ...value.rows[0]! };
      },
      "METADATA_IDENTITY",
      { index: 8, expected: names[8], actual: names[0] },
    ),
    rowCase(
      "provenance-row-extra",
      (value) => {
        value.rows.push({ ...value.rows[0]! });
      },
      "METADATA_ROWS",
      { expected: 9, actual: 10 },
    ),
    rowCase(
      "provenance-canonical-path",
      (value) => {
        value.rows[0]!.canonicalPath = "test/alias.js";
      },
      "METADATA_PATH",
      { index: 0, field: "canonicalPath", expected: `${PREFIX}${names[0]}`, actual: "test/alias.js" },
    ),
    rowCase(
      "provenance-archive-escape",
      (value) => {
        value.rows[0]!.archivePath = "../escape.txt";
      },
      "METADATA_PATH",
      { index: 0, field: "archivePath", expected: archiveName(names[0]!), actual: "../escape.txt" },
    ),
    rowCase(
      "provenance-length",
      (value) => {
        value.rows[0]!.bytes += 1;
      },
      "METADATA_LENGTH",
      { index: 0, expected: 416, actual: 417 },
    ),
  ];
  for (const field of ["repository", "gitlinkPath", "revision"] as const) {
    cases.push(
      rowCase(
        `provenance-pin-${field}`,
        (value) => {
          value[field] = "changed-pin";
        },
        "METADATA_PIN",
        { field, expected: EXPECTED_SOURCE_PIN[field], actual: "changed-pin" },
      ),
    );
  }
  cases.push({
    id: "provenance-reblessed-digest",
    prepare: (tree) => {
      const path = join(tree.archiveRoot, archiveName(names[0]!));
      changeByte(path);
      changeMetadata(tree, (value) => {
        value.rows[0]!.sha256 = sha256(readFileSync(path));
      });
    },
    code: "METADATA_HASH",
    stage: "metadata",
    path: (tree) => tree.metadataPath,
  });
  return cases;
}

function corpusNegatives(archive: ReturnType<typeof authenticateArchive>): NegativeCase[] {
  const first = names[0]!;
  const firstPath = (tree: PrivateTree): string => join(tree.corpusRoot, PREFIX, first);
  return [
    {
      id: "corpus-eight-originals",
      prepare: (tree) => populateCorpus(tree, archive, first),
      code: "CORPUS_FILE",
      stage: "corpus",
      path: firstPath,
      causeCode: "ENOENT",
    },
    {
      id: "corpus-empty-test",
      prepare: (tree) => mkdirSync(join(tree.corpusRoot, "test"), { recursive: true }),
      code: "CORPUS_FILE",
      stage: "corpus",
      path: firstPath,
      causeCode: "ENOENT",
    },
    {
      id: "corpus-nonempty-no-test",
      prepare: (tree) => {
        mkdirSync(tree.corpusRoot);
        writeFileSync(join(tree.corpusRoot, "incidental"), "present\n");
      },
      code: "CORPUS_TEST",
      stage: "corpus",
      path: (tree) => join(tree.corpusRoot, "test"),
      causeCode: "ENOENT",
    },
    {
      id: "corpus-original-byte",
      prepare: (tree) => {
        populateCorpus(tree, archive);
        changeByte(firstPath(tree));
      },
      code: "CORPUS_HASH",
      stage: "corpus",
      path: firstPath,
    },
    {
      id: "corpus-broken-test-link",
      prepare: (tree) => {
        mkdirSync(tree.corpusRoot);
        symlinkSync(join(tree.root, "missing-test"), join(tree.corpusRoot, "test"), "dir");
      },
      code: "CORPUS_TEST",
      stage: "corpus",
      path: (tree) => join(tree.corpusRoot, "test"),
      causeCode: "ENOENT",
    },
    {
      id: "corpus-broken-root-link",
      prepare: (tree) => symlinkSync(join(tree.root, "missing-corpus"), tree.corpusRoot, "dir"),
      code: "CORPUS_ROOT",
      stage: "corpus",
      path: (tree) => tree.corpusRoot,
      causeCode: "ENOENT",
    },
    {
      id: "corpus-broken-original-link",
      prepare: (tree) => {
        populateCorpus(tree, archive);
        unlinkSync(firstPath(tree));
        symlinkSync(join(tree.root, "missing-original"), firstPath(tree));
      },
      code: "CORPUS_FILE",
      stage: "corpus",
      path: firstPath,
      causeCode: "ENOENT",
    },
    {
      id: "corpus-test-nondirectory",
      prepare: (tree) => {
        mkdirSync(tree.corpusRoot);
        writeFileSync(join(tree.corpusRoot, "test"), "not a directory\n");
      },
      code: "CORPUS_TEST_KIND",
      stage: "corpus",
      path: (tree) => join(tree.corpusRoot, "test"),
    },
  ];
}

function runNegative(tree: PrivateTree, control: NegativeCase) {
  control.prepare(tree);
  let caught: unknown;
  try {
    loadConstructorOriginalInputs(tree);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof OriginalInputError, `${control.id}: expected attributed input refusal`);
  assert.equal(caught.code, control.code, control.id);
  assert.equal(caught.stage, control.stage, control.id);
  assert.equal(caught.path, resolve(control.path(tree)), control.id);
  assert.equal(caught.causeCode, control.causeCode, control.id);
  if (control.detail !== undefined) assert.deepEqual(caught.detail, control.detail, control.id);
  const receipt = {
    id: control.id,
    outcome: "REFUSED",
    root: tree.root,
    archiveRoot: tree.archiveRoot,
    corpusRoot: tree.corpusRoot,
    error: {
      code: caught.code,
      stage: caught.stage,
      path: caught.path,
      causeCode: caught.causeCode ?? null,
      detail: caught.detail,
    },
  };
  writeFileSync(join(tree.root, "control-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function runPositive(
  tree: PrivateTree,
  id: string,
  status: "UNAVAILABLE" | "VERIFIED",
  reason?: "root-absent" | "root-empty",
) {
  const receipt = loadConstructorOriginalInputs(tree);
  assert.equal(receipt.inputOrigin, "committed-original-archive");
  assert.deepEqual(receipt.sourcePin, EXPECTED_SOURCE_PIN);
  assert.equal(receipt.archive.verified, 9);
  assert.equal(receipt.archive.bytes, 6810);
  assert.equal(receipt.archive.licenseSha256, EXPECTED_LICENSE.sha256);
  assert.equal(receipt.corpus.status, status, id);
  assert.equal(receipt.corpus.verified, status === "VERIFIED" ? 9 : 0, id);
  if (receipt.corpus.status === "UNAVAILABLE") assert.equal(receipt.corpus.reason, reason, id);
  assert.equal(receipt.canonicalExecution, CANONICAL_EXECUTION);
  const result = {
    id,
    outcome: "VERIFIED_INPUTS_ONLY",
    root: tree.root,
    archiveRoot: tree.archiveRoot,
    corpusRoot: tree.corpusRoot,
    receipt,
  };
  writeFileSync(join(tree.root, "control-receipt.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function runConstructorOriginalInputControls({
  archiveRoot,
  scratchRoot,
  expectedOriginals,
}: {
  archiveRoot: string;
  scratchRoot: string;
  expectedOriginals: InputRoots["expectedOriginals"];
}) {
  // Authentication is repeated for the copying source, not an extra loader call.
  // Only this fixture's private trees are mutated; the physical corpus is read-only.
  const archive = authenticateArchive(archiveRoot, expectedOriginals);
  const scratch = resolve(scratchRoot);
  mkdirSync(scratch, { recursive: true });
  const absent = privateTree(scratch, archive, expectedOriginals, "positive-absent");
  const empty = privateTree(scratch, archive, expectedOriginals, "positive-empty");
  mkdirSync(empty.corpusRoot);
  const full = privateTree(scratch, archive, expectedOriginals, "positive-full");
  populateCorpus(full, archive);
  const linked = privateTree(scratch, archive, expectedOriginals, "positive-test-link");
  const linkTarget = { ...linked, corpusRoot: join(linked.root, "linked-corpus") };
  populateCorpus(linkTarget, archive);
  mkdirSync(linked.corpusRoot);
  symlinkSync(join(linkTarget.corpusRoot, "test"), join(linked.corpusRoot, "test"), "dir");
  const positive = [
    runPositive(absent, "archive-plus-absent-corpus", "UNAVAILABLE", "root-absent"),
    runPositive(empty, "archive-plus-empty-corpus", "UNAVAILABLE", "root-empty"),
    runPositive(full, "archive-plus-full-corpus", "VERIFIED"),
    runPositive(linked, "archive-plus-valid-test-link", "VERIFIED"),
  ];
  const cases = [...archiveNegatives(), ...metadataNegatives(), ...corpusNegatives(archive)];
  assert.equal(cases.length, 27);
  const negative = cases.map((control) =>
    runNegative(privateTree(scratch, archive, expectedOriginals, control.id), control),
  );
  const labels = [...positive, ...negative].map((row) => row.id);
  assert.equal(new Set(labels).size, 31);
  assert.equal(positive.length, 4);
  assert.equal(negative.length, 27);
  return {
    loaderExecutions: labels.length,
    positiveExecutions: positive.length,
    negativeExecutions: negative.length,
    canonicalExecutions: 0,
    positive,
    negative,
  };
}
