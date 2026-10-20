// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Check: node --import tsx scripts/generate-native-radix-canonical-bodies.mts
// Inspect an explicitly reviewed successor with --print; never auto-rebaseline failures.
import { createHash } from "node:crypto";
import { canonicalNativeRadixBody } from "../src/ir/program/formatter-canonical-bodies.generated.js";
import { preparedIrDataMismatch } from "../src/ir/program/data.js";
import { NATIVE_RADIX_SOURCES } from "../src/runtime/contracts/number-format-sources.js";
import { buildSelfHostedIrBody } from "../src/frontend/builtins/build-ir.js";
import { numToStringRadixDefForVersion } from "../src/stdlib/number-format.js";
import { numberFormatRadixSupportDeclarations } from "../src/ir/program/formatter-support.js";
import { describeNativeRadixBody } from "../src/ir/program/formatter-body-identity.js";
import { createIrSourceId } from "../src/ir/identity.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
const sourceId = createIrSourceId({ sourceKey: "<native:radix>", kind: "entry", order: 0 });
const d = numberFormatRadixSupportDeclarations(sourceId);
const templates: Record<number, unknown> = {};
const provenance = [];
for (const version of [1, 2] as const) {
  const definition = numToStringRadixDefForVersion(d.scratch.type, version);
  const body = buildSelfHostedIrBody({
    definition,
    ownerUnitId: d.ownerUnitId,
    callees: new Map(
      d.kernels.map((row) => [
        row.ref.name,
        { target: row.ref, signature: { params: row.params, returnType: row.results[0] ?? null } },
      ]),
    ),
    allocRegistry: new AllocSiteRegistry(),
  });
  templates[version] = describeNativeRadixBody(body, sourceId);
  provenance.push({
    version,
    utf8Bytes: Buffer.byteLength(definition.source),
    sha256: createHash("sha256").update(definition.source).digest("hex"),
  });
}
// Lossless data table, not a second semantic implementation or a size allowance.
// Preserve own undefined fields, numeric identity and every object/array edge.
const cells: unknown[][] = [],
  interned = new Map<string, number>();
function encode(value: unknown): number {
  let cell: unknown[];
  if (value === undefined) cell = ["undefined"];
  else if (value === null) cell = ["null"];
  else if (Object.is(value, -0)) cell = ["negative-zero"];
  else if (typeof value === "number" && !Number.isFinite(value)) cell = ["special-number", String(value)];
  else if (typeof value === "bigint") cell = ["bigint", String(value)];
  else if (Array.isArray(value)) cell = ["array", ...value.map(encode)];
  else if (typeof value === "object")
    cell = ["object", ...Object.entries(value).flatMap(([key, field]) => [encode(key), encode(field)])];
  else cell = ["value", value];
  const key = JSON.stringify(cell),
    prior = interned.get(key);
  if (prior !== undefined) return prior;
  const id = cells.length;
  cells.push(cell);
  interned.set(key, id);
  return id;
}
const roots = { 1: encode(templates[1]), 2: encode(templates[2]) };
const code = `// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Lossless table of the independently retained exact post-hygiene IR for V1/V2.
// Generated from both pinned sources through the genuine frontend; never regenerate to bless a failure.
// This is comparison data, never instructions supplied to an emitter or a caller-selected body.
const cells: readonly (readonly (string | number | boolean | null)[])[] = [
${cells.map((cell) => "  " + JSON.stringify(cell) + ",").join("\n")}
];
const roots = ${JSON.stringify(roots)} as const;
function read(index: number): unknown {
  const [tag, ...values] = cells[index]!;
  switch (tag) {
    case "undefined": return undefined;
    case "null": return null;
    case "negative-zero": return -0;
    case "special-number": return Number(values[0]);
    case "bigint": return BigInt(values[0] as string);
    case "value": return values[0];
    case "array": return values.map(value => read(value as number));
    case "object": {
      const entries: [string, unknown][] = [];
      for (let i = 0; i < values.length; i += 2) entries.push([read(values[i] as number) as string, read(values[i + 1] as number)]);
      return Object.fromEntries(entries);
    }
    default: throw Error("invalid retained radix data cell");
  }
}
export function canonicalNativeRadixBody(version: 1 | 2): unknown {
  const root = roots[version];
  if (root === undefined) throw Error("unsupported retained radix version");
  return read(root);
}
`;
if (process.argv.includes("--print"))
  console.log(JSON.stringify({ provenance, code, lines: code.split("\n").length, cells: cells.length, roots }));
else {
  for (const version of [1, 2] as const) {
    if (
      provenance[version - 1]!.utf8Bytes !== NATIVE_RADIX_SOURCES[version].provenance.utf8Bytes ||
      provenance[version - 1]!.sha256 !== NATIVE_RADIX_SOURCES[version].provenance.sha256
    )
      throw Error("radix source bytes differ from the retained version");
    const mismatch = preparedIrDataMismatch(templates[version], canonicalNativeRadixBody(version));
    if (mismatch !== undefined) throw Error("radix version" + version + " body drift: " + mismatch);
  }
  console.log(
    JSON.stringify({ sourceVersions: provenance, canonicalBodiesVerified: 2, cells: cells.length, rewritten: false }),
  );
}
