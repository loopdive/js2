// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const prototypeSeederExtractionPath = "tests/fixtures/issue-3518-prototype-seeder-extraction.json";
export const readSeederExtractionSource = (path: string) =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
interface Span {
  before: string;
  after: string;
  beforeOffset: number;
  afterOffset: number;
  beforeSHA256: string;
  afterSHA256: string;
}
interface Record {
  path: string;
  gitBlob: string;
  source: string;
  baseSha256: string;
  afterSha256: string;
  spans: Span[];
}
interface Receipt {
  schemaVersion: number;
  base: string;
  singletonCheckpoint: string;
  status: string;
  dependencies: { path: string; sha256: string }[];
  records: Record[];
}
export function prototypeSeederExtractionReceipt(reader = readSeederExtractionSource): Receipt {
  const text = reader(prototypeSeederExtractionPath);
  if (sha(text) !== "78f98e95a040df27f56d23bea16132c6d5034849b3f1b95b3266068017e87396")
    throw Error("prototype seeder extraction receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.base !== "637a810dc268bb7aa516aaffd08c0f72379d7c43" ||
    receipt.singletonCheckpoint !== "cfe1485169eae84b743240f49bd46aae2d4e4302" ||
    receipt.records.map((r) => r.path).join("|") !==
      "src/codegen/native-proto.ts|src/codegen/builtin-proto-constructor-seed.ts"
  )
    throw Error("prototype seeder extraction provenance mismatch");
  for (const dependency of receipt.dependencies)
    if (sha(reader(dependency.path)) !== dependency.sha256)
      throw Error("prototype seeder extraction dependency mismatch: " + dependency.path);
  for (const record of receipt.records) {
    const blob = createHash("sha1")
      .update("blob " + Buffer.byteLength(record.source) + "\0")
      .update(record.source)
      .digest("hex");
    if (blob !== record.gitBlob || sha(record.source) !== record.baseSha256)
      throw Error("prototype seeder extraction parent source mismatch");
    for (const span of record.spans)
      if (sha(span.before) !== span.beforeSHA256 || sha(span.after) !== span.afterSHA256)
        throw Error("prototype seeder extraction span authority mismatch");
  }
  return receipt;
}
function transform(record: Record, source: string, inverse: boolean): string {
  let cursor = 0,
    result = "";
  for (const span of record.spans) {
    const from = inverse ? span.after : span.before;
    const at = source.indexOf(from);
    if (!from || at < 0 || source.indexOf(from, at + 1) >= 0)
      throw Error("prototype seeder extraction span missing or duplicated");
    if (at < cursor || at !== (inverse ? span.afterOffset : span.beforeOffset))
      throw Error("prototype seeder extraction span order or offset mismatch");
    result += source.slice(cursor, at) + (inverse ? span.before : span.after);
    cursor = at + from.length;
  }
  if (sha(source) !== (inverse ? record.afterSha256 : record.baseSha256))
    throw Error("prototype seeder extraction retained source mismatch");
  result += source.slice(cursor);
  if (sha(result) !== (inverse ? record.baseSha256 : record.afterSha256))
    throw Error("prototype seeder extraction reconstructed source mismatch");
  return result;
}
/** Invert only authenticated seeder spans before older full-source validators. */
export function applyPrototypeSeederExtraction(
  path: string,
  source: string,
  inverse: boolean,
  reader = readSeederExtractionSource,
): string {
  const record = prototypeSeederExtractionReceipt(reader).records.find((r) => r.path === path);
  if (!record) throw Error("unrecorded prototype seeder extraction path");
  const result = transform(record, source, inverse);
  if (transform(record, result, !inverse) !== source) throw Error("prototype seeder extraction reciprocal mismatch");
  return result;
}
