// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Pure fixture authority relocated from the independently reviewed C1 repair.
// No filesystem, production helper, receipt-selected expectation or successful-source cache.
import { createHash } from "node:crypto";

export type IndependentPolicyPin = { readonly bytes: number; readonly sha256: string; readonly gitBlob: string };
export type IndependentPolicySpan = {
  readonly inputOffset: number;
  readonly outputOffset: number;
  readonly from: string;
  readonly to: string;
};
export type IndependentPolicyEpoch = {
  readonly path: string;
  readonly beforePin: IndependentPolicyPin;
  readonly currentPin: IndependentPolicyPin;
  readonly inverse: readonly IndependentPolicySpan[];
  readonly forward: readonly IndependentPolicySpan[];
};
function requireProof(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error("independent H3 fixture proof: " + label);
}
function primitiveBytes(source: string): Buffer {
  requireProof(typeof source === "string", "source must be a primitive string");
  const bytes = Buffer.from(source, "utf8");
  requireProof(bytes.toString("utf8") === source, "source must round-trip UTF-8");
  return bytes;
}
function requirePin(source: string, expected: IndependentPolicyPin): void {
  const bytes = primitiveBytes(source);
  requireProof(bytes.length === expected.bytes, "complete byte length changed");
  requireProof(createHash("sha256").update(bytes).digest("hex") === expected.sha256, "complete SHA256 changed");
  requireProof(
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === expected.gitBlob,
    "complete Git blob changed",
  );
}
// Only locally authored literal epochs are frozen here; detached fault recipes remain test inputs.
function freezeEpoch<T extends IndependentPolicyEpoch>(epoch: T): T {
  Object.freeze(epoch.beforePin);
  Object.freeze(epoch.currentPin);
  for (const span of epoch.inverse) Object.freeze(span);
  for (const span of epoch.forward) Object.freeze(span);
  Object.freeze(epoch.inverse);
  Object.freeze(epoch.forward);
  return Object.freeze(epoch);
}
function ownDataRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  requireProof(typeof value === "object" && value !== null && !Array.isArray(value), label + " record");
  const actualKeys = Reflect.ownKeys(value);
  requireProof(
    actualKeys.length === keys.length && actualKeys.every((key, index) => key === keys[index]),
    label + " keys",
  );
  const values: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireProof(descriptor !== undefined && Object.hasOwn(descriptor, "value"), label + " own data " + key);
    values[key] = descriptor.value;
  }
  return values;
}
function fixedRecipes(
  proof: unknown,
  authority: IndependentPolicyEpoch,
  label: string,
): {
  inverse: readonly IndependentPolicySpan[];
  forward: readonly IndependentPolicySpan[];
} {
  const values = ownDataRecord(proof, ["path", "beforePin", "currentPin", "inverse", "forward"], label + " authority");
  requireProof(typeof values.path === "string" && values.path === authority.path, label + " authority path changed");
  for (const key of ["beforePin", "currentPin"] as const) {
    const supplied = ownDataRecord(values[key], ["bytes", "sha256", "gitBlob"], label + " " + key);
    for (const field of ["bytes", "sha256", "gitBlob"] as const)
      requireProof(supplied[field] === authority[key][field], label + " " + key + " " + field + " changed");
  }
  requireProof(Array.isArray(values.inverse) && Array.isArray(values.forward), label + " recipe arrays");
  return { inverse: values.inverse as IndependentPolicySpan[], forward: values.forward as IndependentPolicySpan[] };
}
function replay(source: string, spans: readonly IndependentPolicySpan[], targetBytes: number, label: string): string {
  const input = primitiveBytes(source),
    output: Buffer[] = [];
  requireProof(Number.isSafeInteger(targetBytes) && targetBytes >= 0, label + " fixed target size");
  requireProof(Array.isArray(spans) && spans.length > 0, label + " empty recipe");
  let inputCursor = 0,
    outputCursor = 0,
    previousInputStart = -1,
    previousOutputStart = -1;
  for (let index = 0; index < spans.length; index += 1) {
    const element = Object.getOwnPropertyDescriptor(spans, String(index));
    requireProof(element !== undefined && Object.hasOwn(element, "value"), label + " own data span");
    const span = ownDataRecord(element.value, ["inputOffset", "outputOffset", "from", "to"], label + " span");
    const inputStart = span.inputOffset,
      outputStart = span.outputOffset;
    requireProof(typeof inputStart === "number" && Number.isSafeInteger(inputStart), label + " input integer");
    requireProof(typeof outputStart === "number" && Number.isSafeInteger(outputStart), label + " output integer");
    requireProof(
      inputStart > previousInputStart && inputStart >= inputCursor,
      label + " strictly increasing input starts",
    );
    requireProof(
      outputStart > previousOutputStart && outputStart >= outputCursor,
      label + " strictly increasing output starts",
    );
    requireProof(inputStart <= input.length, label + " input bound");
    requireProof(outputStart <= targetBytes, label + " fixed output start bound");
    const unchanged = input.subarray(inputCursor, inputStart);
    const unchangedEnd = outputCursor + unchanged.length;
    requireProof(
      Number.isSafeInteger(unchangedEnd) && unchangedEnd <= targetBytes,
      label + " fixed unchanged output bound",
    );
    requireProof(outputStart === unchangedEnd, label + " output coordinate");
    const from = primitiveBytes(span.from as string),
      to = primitiveBytes(span.to as string);
    const inputEnd = inputStart + from.length,
      outputEnd = outputStart + to.length;
    requireProof(Number.isSafeInteger(inputEnd) && inputEnd <= input.length, label + " fragment input bound");
    requireProof(
      Number.isSafeInteger(outputEnd) && outputEnd <= targetBytes,
      label + " fixed replacement output bound",
    );
    requireProof(input.subarray(inputStart, inputEnd).equals(from), label + " exact fragment");
    requireProof(!from.equals(to), label + " unchanged edit");
    output.push(unchanged, to);
    inputCursor = inputEnd;
    outputCursor = outputEnd;
    previousInputStart = inputStart;
    previousOutputStart = outputStart;
  }
  const tail = input.subarray(inputCursor),
    finalEnd = outputCursor + tail.length;
  requireProof(Number.isSafeInteger(finalEnd) && finalEnd === targetBytes, label + " fixed final tail bound");
  output.push(tail);
  const bytes = Buffer.concat(output),
    result = bytes.toString("utf8");
  requireProof(primitiveBytes(result).equals(bytes), label + " output UTF-8 round-trip");
  return result;
}

export const independentPolicyGeometryEpoch = freezeEpoch({
  path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
  beforePin: {
    bytes: 409599,
    sha256: "e3bd76cbcee13e469f8c5c6ec6bafb08e6fc786efa410bd8572b56f9d5193170",
    gitBlob: "2dbe6d7fa227cb7463d73d20d847c433a933dfbc",
  },
  currentPin: {
    bytes: 411837,
    sha256: "8575d0f4f66632cb606caf2f94538bd5cb8ef74e89f655e3c1f8f0930de8038c",
    gitBlob: "15ae96d3887a5eb61fc6404df098d58f0d96b2f4",
  },
  inverse: [
    {
      inputOffset: 318,
      outputOffset: 318,
      from: "  c1GeometryInstrumentPredecessor,\n",
      to: "",
    },
    {
      inputOffset: 332791,
      outputOffset: 332756,
      from: "  captureLinearLayoutGeometry as loweringAnalysisGeometryProof,\n",
      to: "",
    },
    {
      inputOffset: 347698,
      outputOffset: 347599,
      from: 'const loweringAnalysisGeometryComponentPin = {\n  bytes: 35439,\n  sha256: "87bf7de1961b821cf303b5d7e686a5e44614b08b7b371ee6afe4a16172a7851e",\n  gitBlob: "4260f7bdb92344a9b20427b75113020b6d9e31a9",\n};\nfunction loweringAnalysisGeometryRead(path: string): string {\n  if (\n    ![\n      "tests/helpers/ir-linear-layout-geometry-successor.json",\n      "src/ir/analysis/linear-memory-plan.ts",\n      "src/ir/analysis/contracts/linear-memory-layout.ts",\n      "src/shared/contracts/linear-memory-layout.ts",\n      loweringAnalysisExpected.sourceReceipt.path,\n    ].includes(path)\n  )\n    loweringAnalysisFail("geometry source proof path outside fixed domain: " + path);\n  const url = new URL(`../../${path}`, import.meta.url);\n  const info = wasmGcHelperLstat(url);\n  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o644)\n    loweringAnalysisFail("geometry source mode/identity changed: " + path);\n  return readFileSync(url, "utf8");\n}\n',
      to: "",
    },
    {
      inputOffset: 350593,
      outputOffset: 349542,
      from: '  loweringAnalysisPin(\n    implementation,\n    implementation.length === earlyReturnComponentPin.bytes\n      ? earlyReturnComponentPin\n      : loweringAnalysisGeometryComponentPin,\n    receipt.componentImplementation.path,\n  );\n  loweringAnalysisPin(\n    implementation.subarray(0, earlyReturnComponentPin.bytes),\n    earlyReturnComponentPin,\n    receipt.componentImplementation.path + " immutable geometry predecessor",\n  );\n',
      to: "  loweringAnalysisPin(implementation, earlyReturnComponentPin, receipt.componentImplementation.path);\n",
    },
    {
      inputOffset: 351732,
      outputOffset: 350357,
      from: '  // This physical channel is current-only; the proof closes its own historical layout reader.\n  const currentPlanner = loweringAnalysisGeometryRead("src/ir/analysis/linear-memory-plan.ts");\n  const historicalPlannerPin = receipt.sourceInputs.find(\n    (entry) => entry.path === "src/ir/analysis/linear-memory-plan.ts",\n  )!;\n  const planner =\n    sha(currentPlanner) === historicalPlannerPin.sha256\n      ? loweringAnalysisLayoutProof(loweringAnalysisRead(historicalPlannerPin.path), loweringAnalysisRead)\n      : (() => {\n          loweringAnalysisPin(\n            implementation,\n            loweringAnalysisGeometryComponentPin,\n            receipt.componentImplementation.path,\n          );\n          return loweringAnalysisGeometryProof(currentPlanner, loweringAnalysisGeometryRead).originalPlanner;\n        })();\n',
      to: '  const planner = loweringAnalysisLayoutProof(\n    loweringAnalysisRead("src/ir/analysis/linear-memory-plan.ts"),\n    loweringAnalysisRead,\n  );\n',
    },
    {
      inputOffset: 411531,
      outputOffset: 409481,
      from: '  const predecessor = c1GeometryInstrumentPredecessor(\n    "tests/helpers/ir-runtime-program-policy-evolution.ts",\n    source.toString("utf8"),\n  );\n  return earlyReturnHistoricalPrefix(\n    Buffer.from(predecessor),\n    remainderPolicyPrefixProof,\n    currentMainInventoryPin,\n    preparationFail,\n  );\n',
      to: "  return earlyReturnHistoricalPrefix(source, remainderPolicyPrefixProof, currentMainInventoryPin, preparationFail);\n",
    },
  ],
  forward: [
    {
      inputOffset: 318,
      outputOffset: 318,
      from: "",
      to: "  c1GeometryInstrumentPredecessor,\n",
    },
    {
      inputOffset: 332756,
      outputOffset: 332791,
      from: "",
      to: "  captureLinearLayoutGeometry as loweringAnalysisGeometryProof,\n",
    },
    {
      inputOffset: 347599,
      outputOffset: 347698,
      from: "",
      to: 'const loweringAnalysisGeometryComponentPin = {\n  bytes: 35439,\n  sha256: "87bf7de1961b821cf303b5d7e686a5e44614b08b7b371ee6afe4a16172a7851e",\n  gitBlob: "4260f7bdb92344a9b20427b75113020b6d9e31a9",\n};\nfunction loweringAnalysisGeometryRead(path: string): string {\n  if (\n    ![\n      "tests/helpers/ir-linear-layout-geometry-successor.json",\n      "src/ir/analysis/linear-memory-plan.ts",\n      "src/ir/analysis/contracts/linear-memory-layout.ts",\n      "src/shared/contracts/linear-memory-layout.ts",\n      loweringAnalysisExpected.sourceReceipt.path,\n    ].includes(path)\n  )\n    loweringAnalysisFail("geometry source proof path outside fixed domain: " + path);\n  const url = new URL(`../../${path}`, import.meta.url);\n  const info = wasmGcHelperLstat(url);\n  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o644)\n    loweringAnalysisFail("geometry source mode/identity changed: " + path);\n  return readFileSync(url, "utf8");\n}\n',
    },
    {
      inputOffset: 349542,
      outputOffset: 350593,
      from: "  loweringAnalysisPin(implementation, earlyReturnComponentPin, receipt.componentImplementation.path);\n",
      to: '  loweringAnalysisPin(\n    implementation,\n    implementation.length === earlyReturnComponentPin.bytes\n      ? earlyReturnComponentPin\n      : loweringAnalysisGeometryComponentPin,\n    receipt.componentImplementation.path,\n  );\n  loweringAnalysisPin(\n    implementation.subarray(0, earlyReturnComponentPin.bytes),\n    earlyReturnComponentPin,\n    receipt.componentImplementation.path + " immutable geometry predecessor",\n  );\n',
    },
    {
      inputOffset: 350357,
      outputOffset: 351732,
      from: '  const planner = loweringAnalysisLayoutProof(\n    loweringAnalysisRead("src/ir/analysis/linear-memory-plan.ts"),\n    loweringAnalysisRead,\n  );\n',
      to: '  // This physical channel is current-only; the proof closes its own historical layout reader.\n  const currentPlanner = loweringAnalysisGeometryRead("src/ir/analysis/linear-memory-plan.ts");\n  const historicalPlannerPin = receipt.sourceInputs.find(\n    (entry) => entry.path === "src/ir/analysis/linear-memory-plan.ts",\n  )!;\n  const planner =\n    sha(currentPlanner) === historicalPlannerPin.sha256\n      ? loweringAnalysisLayoutProof(loweringAnalysisRead(historicalPlannerPin.path), loweringAnalysisRead)\n      : (() => {\n          loweringAnalysisPin(\n            implementation,\n            loweringAnalysisGeometryComponentPin,\n            receipt.componentImplementation.path,\n          );\n          return loweringAnalysisGeometryProof(currentPlanner, loweringAnalysisGeometryRead).originalPlanner;\n        })();\n',
    },
    {
      inputOffset: 409481,
      outputOffset: 411531,
      from: "  return earlyReturnHistoricalPrefix(source, remainderPolicyPrefixProof, currentMainInventoryPin, preparationFail);\n",
      to: '  const predecessor = c1GeometryInstrumentPredecessor(\n    "tests/helpers/ir-runtime-program-policy-evolution.ts",\n    source.toString("utf8"),\n  );\n  return earlyReturnHistoricalPrefix(\n    Buffer.from(predecessor),\n    remainderPolicyPrefixProof,\n    currentMainInventoryPin,\n    preparationFail,\n  );\n',
    },
  ],
} as const);

export const independentRemainderPolicyEpoch = freezeEpoch({
  path: "tests/helpers/ir-runtime-program-policy-evolution.ts remainder prefix",
  beforePin: {
    bytes: 402646,
    sha256: "0ddf7556360e8937b25ba58b23629533c8042e026a4b6e6fc05df3d1263c97b8",
    gitBlob: "201e131a7a67df8a34256f63ee0205b407794ad1",
  },
  currentPin: {
    bytes: 403311,
    sha256: "a38d46359693dd3b63dfd79642a241385e347273bb4cfb06dad177c063a1c375",
    gitBlob: "763d42a7d7ab7278149cbc7258f3e90d19371408",
  },
  inverse: [
    {
      inputOffset: 48240,
      outputOffset: 48240,
      from: '    const bytes =\n      pin.path === "src/ir/runtime/intrinsic-preparation.ts"\n        ? Buffer.from(\n            runtimePreparationRemainderHistoricalSource(\n              readFileSync(new URL(`../../${pin.path}`, import.meta.url), "utf8"),\n            ),\n            "utf8",\n          )\n        : readFileSync(new URL(`../../${pin.path}`, import.meta.url));\n',
      to: "    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));\n",
    },
    {
      inputOffset: 109029,
      outputOffset: 108748,
      from: '  const prefix = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
      to: '  const prefix = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
    },
    {
      inputOffset: 180949,
      outputOffset: 180626,
      from: '  const helper = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
      to: '  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
    },
    {
      inputOffset: 203330,
      outputOffset: 202965,
      from: '  const helper = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
      to: '  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
    },
    {
      inputOffset: 245110,
      outputOffset: 244703,
      from: '  const helper = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
      to: '  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
    },
    {
      inputOffset: 284638,
      outputOffset: 284189,
      from: '  const helper = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
      to: '  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
    },
    {
      inputOffset: 323587,
      outputOffset: 323096,
      from: "    remainderPolicyHistoricalPrefix(readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url))),\n",
      to: "    readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url)),\n",
    },
    {
      inputOffset: 348783,
      outputOffset: 348259,
      from: "    remainderPolicyHistoricalPrefix(readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url))),\n",
      to: "    readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url)),\n",
    },
    {
      inputOffset: 363868,
      outputOffset: 363311,
      from: '        remainderPolicyHistoricalPrefix(\n          readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n        ),\n',
      to: '        readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n',
    },
    {
      inputOffset: 377484,
      outputOffset: 376873,
      from: '        remainderPolicyHistoricalPrefix(\n          readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n        ),\n',
      to: '        readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n',
    },
  ],
  forward: [
    {
      inputOffset: 48240,
      outputOffset: 48240,
      from: "    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));\n",
      to: '    const bytes =\n      pin.path === "src/ir/runtime/intrinsic-preparation.ts"\n        ? Buffer.from(\n            runtimePreparationRemainderHistoricalSource(\n              readFileSync(new URL(`../../${pin.path}`, import.meta.url), "utf8"),\n            ),\n            "utf8",\n          )\n        : readFileSync(new URL(`../../${pin.path}`, import.meta.url));\n',
    },
    {
      inputOffset: 108748,
      outputOffset: 109029,
      from: '  const prefix = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
      to: '  const prefix = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
    },
    {
      inputOffset: 180626,
      outputOffset: 180949,
      from: '  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
      to: '  const helper = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
    },
    {
      inputOffset: 202965,
      outputOffset: 203330,
      from: '  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
      to: '  const helper = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
    },
    {
      inputOffset: 244703,
      outputOffset: 245110,
      from: '  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
      to: '  const helper = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
    },
    {
      inputOffset: 284189,
      outputOffset: 284638,
      from: '  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));\n',
      to: '  const helper = remainderPolicyHistoricalPrefix(\n    readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n  );\n',
    },
    {
      inputOffset: 323096,
      outputOffset: 323587,
      from: "    readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url)),\n",
      to: "    remainderPolicyHistoricalPrefix(readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url))),\n",
    },
    {
      inputOffset: 348259,
      outputOffset: 348783,
      from: "    readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url)),\n",
      to: "    remainderPolicyHistoricalPrefix(readFileSync(new URL(`../../${receipt.helperPrefix.path}`, import.meta.url))),\n",
    },
    {
      inputOffset: 363311,
      outputOffset: 363868,
      from: '        readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n',
      to: '        remainderPolicyHistoricalPrefix(\n          readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n        ),\n',
    },
    {
      inputOffset: 376873,
      outputOffset: 377484,
      from: '        readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n',
      to: '        remainderPolicyHistoricalPrefix(\n          readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url)),\n        ),\n',
    },
  ],
} as const);

export function independentlyAcquirePolicyGeometryEpoch(
  current: string,
  proof: IndependentPolicyEpoch = independentPolicyGeometryEpoch,
): string {
  primitiveBytes(current);
  const authority = independentPolicyGeometryEpoch;
  const recipes = fixedRecipes(proof, authority, "geometry");
  requirePin(current, authority.currentPin);
  const before = replay(current, recipes.inverse, authority.beforePin.bytes, "geometry inverse");
  requirePin(before, authority.beforePin);
  const forward = replay(before, recipes.forward, authority.currentPin.bytes, "geometry forward");
  requirePin(forward, authority.currentPin);
  requireProof(forward === current, "geometry reciprocal equality");
  return before;
}
export function independentlyAcquireRemainderPolicyPrefix(current: string): string {
  const predecessor = independentlyAcquirePolicyGeometryEpoch(current);
  const authority = independentRemainderPolicyEpoch;
  const prefix = primitiveBytes(predecessor).subarray(0, authority.currentPin.bytes).toString("utf8");
  requirePin(prefix, authority.currentPin);
  return prefix;
}
export function independentlyInvertRemainderPolicyBytes(
  current: string,
  proof: IndependentPolicyEpoch = independentRemainderPolicyEpoch,
): string {
  primitiveBytes(current);
  const authority = independentRemainderPolicyEpoch;
  const recipes = fixedRecipes(proof, authority, "remainder");
  requirePin(current, authority.currentPin);
  const before = replay(current, recipes.inverse, authority.beforePin.bytes, "remainder inverse");
  requirePin(before, authority.beforePin);
  const forward = replay(before, recipes.forward, authority.currentPin.bytes, "remainder forward");
  requirePin(forward, authority.currentPin);
  requireProof(forward === current, "remainder reciprocal equality");
  return before;
}
export function independentlyAcquireHistoricalPolicyHelper(current: string): string {
  return independentlyInvertRemainderPolicyBytes(independentlyAcquireRemainderPolicyPrefix(current));
}
