// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { transform } from "esbuild";

export async function minifiedJavaScriptByteLength(source) {
  const result = await transform(source, {
    format: "esm",
    legalComments: "none",
    loader: "js",
    minify: true,
    target: "es2022",
  });
  return Buffer.byteLength(result.code);
}

export function formatModuleByteSize(bytes) {
  assertPositiveInteger(bytes, "bytes");
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000).toFixed(1)} kB`;
}

export function buildLandingModuleSizeRows({ programId, jsBytes, aotBytes, interpreterBytes, engineBytes }) {
  if (typeof programId !== "string" || !programId) throw new Error("programId must be a non-empty string");
  for (const [name, value] of Object.entries({ jsBytes, aotBytes, interpreterBytes, engineBytes })) {
    assertPositiveInteger(value, name);
  }
  return [
    {
      name: "AOT compiled",
      path: programId,
      value: aotBytes,
      label: formatModuleByteSize(aotBytes),
      jsUs: jsBytes,
    },
    {
      name: "Interpreter",
      path: programId,
      value: interpreterBytes,
      label: formatModuleByteSize(interpreterBytes),
      jsUs: jsBytes,
    },
    {
      name: "Engine",
      path: programId,
      value: engineBytes,
      label: formatModuleByteSize(engineBytes),
      jsUs: jsBytes,
    },
  ];
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}
