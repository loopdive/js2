// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6978 (#6708 S6-B) — named host accelerators for the native semantic regime.
// Each family keeps its native provider unless the accelerator is selected;
// selecting one where it cannot apply is a compile error, never a no-op.

import { describe, expect, it } from "vitest";
import { classifyHostImport } from "../src/host-import-policy.js";
import type { ImportDescriptor, ImportIntent } from "../src/index.js";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";
import { resolveCompileTargetProfile } from "../src/target-profile.js";

type Accelerator = "js-string" | "regexp" | "date" | "intl";

async function compileRegime(source: string, hostAccelerators?: readonly Accelerator[]) {
  const result = await compile(source, {
    fileName: "issue-6978.ts",
    semanticProviders: "native-first",
    ...(hostAccelerators ? { hostAccelerators } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  return result;
}

async function runRegime(source: string, hostAccelerators?: readonly Accelerator[]) {
  const result = await compileRegime(source, hostAccelerators);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const imported = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(
    (entry) => `${entry.module}::${entry.name}`,
  );
  return { result, imported, exports: wrapCompiledExports(result, instance) as Record<string, any> };
}

function descriptor(name: string, intent: ImportIntent): ImportDescriptor {
  return { module: "env", name, kind: "func", intent };
}

describe("#6978 host accelerator selection", () => {
  it("resolves a sorted, de-duplicated list and leaves the default profile unchanged", () => {
    const profile = resolveCompileTargetProfile({
      semanticProviders: "native-first",
      hostAccelerators: ["regexp", "date", "regexp"],
    });
    expect(profile.accelerators).toEqual(["date", "regexp"]);
    expect(Object.isFrozen(profile.accelerators)).toBe(true);
    expect("accelerators" in resolveCompileTargetProfile({ semanticProviders: "native-first" })).toBe(false);
    expect(
      "accelerators" in resolveCompileTargetProfile({ semanticProviders: "native-first", hostAccelerators: [] }),
    ).toBe(false);
  });

  it("rejects unknown names and every profile where an accelerator cannot apply", () => {
    expect(() =>
      resolveCompileTargetProfile({ semanticProviders: "native-first", hostAccelerators: ["temporal"] }),
    ).toThrow("Unknown host accelerator 'temporal'");
    expect(() => resolveCompileTargetProfile({ target: "standalone", hostAccelerators: ["regexp"] })).toThrow(
      "require a JavaScript environment; target 'standalone' has none",
    );
    expect(() => resolveCompileTargetProfile({ target: "wasi", hostAccelerators: ["date"] })).toThrow(
      "require a JavaScript environment; target 'wasi' has none",
    );
    expect(() => resolveCompileTargetProfile({ target: "linear", hostAccelerators: ["date"] })).toThrow(
      "target 'linear' has none",
    );
    expect(() =>
      resolveCompileTargetProfile({
        semanticProviders: "native-first",
        strictNoHostImports: true,
        hostAccelerators: ["date"],
      }),
    ).toThrow("strictNoHostImports forbids");
    // The host-assisted profile already uses every host provider. (`host-assisted`
    // is the explicit spelling once #6708 slice A lands; before it, any
    // non-native-first selection resolves to host-assisted on gc.)
    expect(() =>
      resolveCompileTargetProfile({
        semanticProviders: "host-assisted" as unknown as "native-first",
        hostAccelerators: ["regexp"],
      }),
    ).toThrow("only apply to the native-first semantic regime");
  });

  it("fails the compile instead of silently ignoring a misplaced accelerator", async () => {
    await expect(
      compile(`export function run(): number { return 1; }`, {
        fileName: "issue-6978-standalone.ts",
        target: "standalone",
        hostAccelerators: ["date"],
      }),
    ).rejects.toThrow("require a JavaScript environment");
    await expect(
      compile(`export function run(): number { return 1; }`, {
        fileName: "issue-6978-wasi.ts",
        target: "wasi",
        hostAccelerators: ["regexp"],
      }),
    ).rejects.toThrow("require a JavaScript environment");
  });
});

describe("#6978 profile-aware host-import classification", () => {
  it("classifies a selected family as host-accelerator and leaves unselected families alone", () => {
    const regexp = descriptor("RegExp_new", { type: "extern_class", className: "RegExp", action: "new" });
    expect(classifyHostImport(regexp, "javascript")).toMatchObject({ classification: "legacy-semantic" });
    expect(classifyHostImport(regexp, "javascript", ["date"])).toMatchObject({ classification: "legacy-semantic" });
    expect(classifyHostImport(regexp, "javascript", ["regexp"])).toMatchObject({
      classification: "host-accelerator",
      family: "regexp",
      reason: expect.stringContaining("'regexp' host accelerator"),
    });

    const parse = descriptor("__date_parse_host", { type: "builtin", name: "__date_parse_host" });
    expect(classifyHostImport(parse, "javascript", ["date"])).toMatchObject({
      classification: "host-accelerator",
      family: "date",
    });

    const intl = descriptor("Intl_NumberFormat_new", {
      type: "extern_class",
      className: "NumberFormat",
      action: "new",
      namespacePath: ["Intl"],
    });
    expect(classifyHostImport(intl, "javascript")).toMatchObject({ classification: "platform-capability" });
    expect(classifyHostImport(intl, "javascript", ["intl"])).toMatchObject({
      classification: "host-accelerator",
      family: "intl",
    });

    const trim = descriptor("string_trim", { type: "string_method", method: "trim" });
    expect(classifyHostImport(trim, "javascript", ["js-string"])).toMatchObject({
      classification: "host-accelerator",
      family: "js-string",
    });
    // Families outside the four accelerators never re-classify.
    const map = descriptor("Map_new", { type: "extern_class", className: "Map", action: "new" });
    expect(classifyHostImport(map, "javascript", ["regexp", "date", "intl", "js-string"])).toMatchObject({
      classification: "legacy-semantic",
    });
  });
});

describe("#6978 date accelerator", () => {
  const isoProgram = `
    export function run(): string {
      const iso: string = "2020-02-29T12:34:56.789Z";
      return Date.parse(iso) + "|" + new Date(iso).getUTCDate() + "|" + Date.parse("1970-01-02") + "|" +
        new Date("2001-09-09T01:46:40Z").getTime() + "|" + Date.parse("not a date");
    }
  `;

  it("uses the native parser unless the date accelerator is selected", async () => {
    const native = await runRegime(isoProgram);
    expect(native.imported).not.toContain("env::__date_parse_host");

    const accelerated = await runRegime(isoProgram, ["date"]);
    expect(accelerated.imported).toContain("env::__date_parse_host");
    expect(accelerated.result.hostImportInventory?.find((entry) => entry.name === "__date_parse_host")).toMatchObject({
      classification: "host-accelerator",
      family: "date",
    });
    // Same observable answers under both spellings for formats both parsers accept.
    expect(accelerated.exports.run()).toBe(native.exports.run());
    expect(native.exports.run()).toBe(
      [Date.parse("2020-02-29T12:34:56.789Z"), 29, 86400000, 1000000000000, NaN].join("|"),
    );
  });

  it("hands formats only the host parser accepts to the host", async () => {
    const source = `
      export function run(): string {
        const text: string = "Thu, 01 Jan 1970 00:00:00 GMT-0500";
        return Date.parse(text) + "|" + new Date(text).getTime();
      }
    `;
    const accelerated = await runRegime(source, ["date"]);
    const expected = Date.parse("Thu, 01 Jan 1970 00:00:00 GMT-0500");
    expect(accelerated.exports.run()).toBe(`${expected}|${expected}`);
  });
});
