// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const descriptorAdapterFixture = "tests/fixtures/issue-3518-descriptor-adapter-relocation.json";
const fixtureHash = "69e5eb643443971ff96a4b827f282c3fadf32f290cea772d50f65b09443786cf";
export const descriptorAdapterPaths = [
  "src/codegen/object-runtime-enumeration.ts",
  "src/codegen/object-runtime-descriptors.ts",
] as const;
export const readDescriptorAdapterSource = (path: string): string =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
export const descriptorAdapterHash = (source: string) => createHash("sha256").update(source).digest("hex");
interface Span {
  before: string;
  after: string;
  beforeOffset: number;
  afterOffset: number;
}
interface SourceRecord {
  path: string;
  beforeSHA256: string;
  afterSHA256: string;
  priorReceipt: string;
  spans: Span[];
}
interface Receipt {
  base: string;
  priorReceipts: { path: string; sha256: string }[];
  records: SourceRecord[];
  modules: { path: string; sha256: string }[];
}
export function authenticateDescriptorAdapterRelocation(
  text = readDescriptorAdapterSource(descriptorAdapterFixture),
  reader = readDescriptorAdapterSource,
): Receipt {
  if (descriptorAdapterHash(text) !== fixtureHash) throw Error("descriptor adapter receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.base !== "f52f6ae020d6d5ddb07e69a3b18811a5b4f86c24" ||
    JSON.stringify(receipt.records.map((row) => row.path)) !== JSON.stringify(descriptorAdapterPaths) ||
    JSON.stringify(receipt.modules.map((row) => row.path)) !==
      JSON.stringify(["src/codegen/object-same-value.ts", "src/codegen/object-descriptor-data.ts"])
  )
    throw Error("descriptor adapter provenance mismatch");
  for (const prior of receipt.priorReceipts) {
    const source = reader(prior.path);
    if (descriptorAdapterHash(source) !== prior.sha256) throw Error("descriptor adapter prior receipt mismatch");
    const previous = JSON.parse(source) as { records: { path: string; afterSHA256: string }[] };
    for (const row of receipt.records.filter((row) => row.priorReceipt === prior.path))
      if (previous.records.find((old) => old.path === row.path)?.afterSHA256 !== row.beforeSHA256)
        throw Error("descriptor adapter prior source mismatch");
  }
  for (const module of receipt.modules)
    if (descriptorAdapterHash(reader(module.path)) !== module.sha256)
      throw Error("descriptor adapter actual helper mismatch");
  return receipt;
}
function transform(row: SourceRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = source.indexOf(span[from]);
    if (!span[from] || at < 0 || source.indexOf(span[from], at + 1) >= 0)
      throw Error("descriptor adapter span missing or duplicated");
    if (at < cursor || at !== span[inverse ? "afterOffset" : "beforeOffset"])
      throw Error("descriptor adapter span order or offset mismatch");
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  if (descriptorAdapterHash(source) !== row[inverse ? "afterSHA256" : "beforeSHA256"])
    throw Error("descriptor adapter retained source mismatch");
  result += source.slice(cursor);
  if (descriptorAdapterHash(result) !== row[inverse ? "beforeSHA256" : "afterSHA256"])
    throw Error("descriptor adapter reconstruction mismatch");
  return result;
}
export function applyDescriptorAdapterRelocation(
  path: string,
  source: string,
  inverse: boolean,
  text = readDescriptorAdapterSource(descriptorAdapterFixture),
  reader = readDescriptorAdapterSource,
): string {
  const row = authenticateDescriptorAdapterRelocation(text, reader).records.find((row) => row.path === path);
  if (!row) throw Error("unrecorded descriptor adapter source");
  const result = transform(row, source, inverse);
  if (transform(row, result, !inverse) !== source) throw Error("descriptor adapter reciprocal replay mismatch");
  return result;
}
/** Only preservation readers use this authenticated view; production executes the actual adapters. */
export function beforeDescriptorAdapterRelocation(path: string, source: string): string {
  return (descriptorAdapterPaths as readonly string[]).includes(path)
    ? applyDescriptorAdapterRelocation(path, source, true)
    : source;
}
