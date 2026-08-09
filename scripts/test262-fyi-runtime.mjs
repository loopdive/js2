#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UINT8_ARRAY_BASE64_HEX_APIS = [
  "Uint8Array.fromBase64",
  "Uint8Array.fromHex",
  "Uint8Array.prototype.setFromBase64",
  "Uint8Array.prototype.setFromHex",
  "Uint8Array.prototype.toBase64",
  "Uint8Array.prototype.toHex",
];

export const TEST262_FYI_RUNTIME_CONTRACT = Object.freeze({
  id: "test262-fyi-node25-unicode17-v1",
  nodeMajor: 25,
  unicodeMajor: 17,
  capabilities: Object.freeze({
    unicode17RegExpData: "Script=Beria_Erfe must match U+16EA0",
    uint8ArrayBase64Hex: Object.freeze([...UINT8_ARRAY_BASE64_HEX_APIS]),
  }),
});

function versionMajor(version) {
  const match = String(version ?? "").match(/^v?(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function detectUnicode17RegExpData() {
  try {
    const beriaErfe = new RegExp("^\\p{Script=Beria_Erfe}+$", "u");
    return beriaErfe.test(String.fromCodePoint(0x16ea0)) && !beriaErfe.test("A");
  } catch {
    return false;
  }
}

function sameBytes(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function detectUint8ArrayBase64Hex() {
  const apiSupport = {
    "Uint8Array.fromBase64": typeof Uint8Array.fromBase64 === "function",
    "Uint8Array.fromHex": typeof Uint8Array.fromHex === "function",
    "Uint8Array.prototype.setFromBase64": typeof Uint8Array.prototype.setFromBase64 === "function",
    "Uint8Array.prototype.setFromHex": typeof Uint8Array.prototype.setFromHex === "function",
    "Uint8Array.prototype.toBase64": typeof Uint8Array.prototype.toBase64 === "function",
    "Uint8Array.prototype.toHex": typeof Uint8Array.prototype.toHex === "function",
  };
  if (!Object.values(apiSupport).every(Boolean)) return { supported: false, apiSupport };

  try {
    const expected = [102, 111, 111];
    const fromBase64 = Uint8Array.fromBase64("Zm9v");
    const fromHex = Uint8Array.fromHex("666f6f");
    const source = new Uint8Array(expected);
    const base64Target = new Uint8Array(3);
    const hexTarget = new Uint8Array(3);
    const base64Result = base64Target.setFromBase64("Zm9v");
    const hexResult = hexTarget.setFromHex("666f6f");
    const supported =
      sameBytes(fromBase64, expected) &&
      sameBytes(fromHex, expected) &&
      source.toBase64() === "Zm9v" &&
      source.toHex() === "666f6f" &&
      sameBytes(base64Target, expected) &&
      sameBytes(hexTarget, expected) &&
      base64Result.read === 4 &&
      base64Result.written === 3 &&
      hexResult.read === 6 &&
      hexResult.written === 3;
    return { supported, apiSupport };
  } catch {
    return { supported: false, apiSupport };
  }
}

export function detectTest262FyiRuntime() {
  const uint8ArrayBase64Hex = detectUint8ArrayBase64Hex();
  return {
    runtime: "node",
    version: process.version,
    node: process.versions.node,
    v8: process.versions.v8,
    icu: process.versions.icu,
    unicode: process.versions.unicode,
    capabilities: {
      unicode17RegExpData: detectUnicode17RegExpData(),
      uint8ArrayBase64Hex: uint8ArrayBase64Hex.supported,
    },
    apiSupport: uint8ArrayBase64Hex.apiSupport,
  };
}

export function assessTest262FyiRuntime(actual) {
  const mismatches = [];
  const nodeMajor = versionMajor(actual.node ?? actual.version);
  const unicodeMajor = versionMajor(actual.unicode);
  if (nodeMajor !== TEST262_FYI_RUNTIME_CONTRACT.nodeMajor) {
    mismatches.push(
      `Node major ${nodeMajor ?? "unknown"} does not match required major ${TEST262_FYI_RUNTIME_CONTRACT.nodeMajor}`,
    );
  }
  if (unicodeMajor !== TEST262_FYI_RUNTIME_CONTRACT.unicodeMajor) {
    mismatches.push(
      `Unicode data ${actual.unicode ?? "unknown"} does not match required major ${TEST262_FYI_RUNTIME_CONTRACT.unicodeMajor}`,
    );
  }
  if (actual.capabilities?.unicode17RegExpData !== true) {
    mismatches.push("Unicode 17 RegExp data probe failed (Script=Beria_Erfe / U+16EA0)");
  }
  if (actual.capabilities?.uint8ArrayBase64Hex !== true) {
    const missingApis = UINT8_ARRAY_BASE64_HEX_APIS.filter((name) => actual.apiSupport?.[name] !== true);
    mismatches.push(
      missingApis.length > 0
        ? `Uint8Array base64/hex capability probe failed; missing ${missingApis.join(", ")}`
        : "Uint8Array base64/hex behavior probe failed",
    );
  }
  return { compatible: mismatches.length === 0, mismatches };
}

export function formatTest262FyiRuntimeError(runtimeContract) {
  const actual = runtimeContract.actual;
  const detected = [
    `Node ${actual.version ?? actual.node ?? "unknown"}`,
    `V8 ${actual.v8 ?? "unknown"}`,
    `ICU ${actual.icu ?? "unknown"}`,
    `Unicode ${actual.unicode ?? "unknown"}`,
  ].join(", ");
  return [
    `Authoritative Test262 FYI comparisons require ${TEST262_FYI_RUNTIME_CONTRACT.id}.`,
    `Detected ${detected}.`,
    "Runtime mismatches:",
    ...runtimeContract.mismatches.map((mismatch) => `  - ${mismatch}`),
    "Activate Node 25, then rerun:",
    "  pnpm run test:262:fyi -- <options>",
    "For an explicitly non-authoritative smoke sample:",
    "  pnpm run test:262:fyi:smoke -- <options>",
  ].join("\n");
}

export function enforceTest262FyiRuntime({ actual = detectTest262FyiRuntime(), authoritative = true } = {}) {
  const assessment = assessTest262FyiRuntime(actual);
  const runtimeContract = {
    id: TEST262_FYI_RUNTIME_CONTRACT.id,
    mode: authoritative ? "authoritative-comparison" : "non-authoritative-smoke",
    authoritative,
    comparable: authoritative && assessment.compatible,
    compatible: assessment.compatible,
    required: TEST262_FYI_RUNTIME_CONTRACT,
    actual,
    mismatches: assessment.mismatches,
  };
  if (authoritative && !assessment.compatible) {
    const error = new Error(formatTest262FyiRuntimeError(runtimeContract));
    error.runtimeContract = runtimeContract;
    throw error;
  }
  return runtimeContract;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath.endsWith("test262-fyi-runtime.mjs") && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const runtimeContract = enforceTest262FyiRuntime();
    console.log(
      `Test262 FYI runtime ready: ${runtimeContract.actual.version} / Unicode ${runtimeContract.actual.unicode} (${runtimeContract.id})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
