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
    // (#6979) The host-assisted profile itself is a compile error now.
    expect(() =>
      resolveCompileTargetProfile({
        semanticProviders: "host-assisted" as unknown as "native-first",
        hostAccelerators: ["regexp"],
      }),
    ).toThrow("#6979 removed");
  });

  it("rejects the families whose host path does not work under the regime yet", () => {
    expect(() =>
      resolveCompileTargetProfile({ semanticProviders: "native-first", hostAccelerators: ["js-string"] }),
    ).toThrow("Host accelerator(s) js-string not available yet");
    // (#6986) `intl` is available: host Intl calls marshal through the value boundary.
    expect(
      resolveCompileTargetProfile({ semanticProviders: "native-first", hostAccelerators: ["intl"] }).accelerators,
    ).toEqual(["intl"]);
    expect(() => resolveCompileTargetProfile({ semanticProviders: "native-first", nativeStrings: false })).toThrow(
      'the planned "js-string" host accelerator',
    );
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
    expect(classifyHostImport(regexp, "javascript")).toMatchObject({ classification: "unknown", ownerIssue: 6979 });
    expect(classifyHostImport(regexp, "javascript", ["date"])).toMatchObject({
      classification: "unknown",
      ownerIssue: 6979,
    });
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
      classification: "unknown",
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

describe("#6978 regexp accelerator", () => {
  const program = `
    function scan(): string {
      const out: string[] = [];
      const re = /(?<year>\\d{4})-(?<month>\\d{2})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec("2020-01 and 2021-12")) !== null) out.push(m[0] + "@" + m.index + ";" + re.lastIndex);
      return out.join(",");
    }
    function rewrite(): string {
      return "x1y22z333".replace(/(\\d+)/g, "<$1>") + "|" + "Hello World".replace(/o/g, (s: string) => s.toUpperCase());
    }
    function flags(): string {
      const sticky = /foo/y;
      sticky.lastIndex = 3;
      return String(/^abc$/m.test("x\\nabc\\ny")) + String(/a.c/s.test("a\\nc")) + String(sticky.test("barfoo")) +
        sticky.lastIndex;
    }
    function pieces(): string {
      const all: string[] = [];
      for (const mm of "a1b2c3".matchAll(/[a-z](\\d)/g)) all.push(mm[1] + "@" + mm.index);
      return "a, b,c ,d".split(/\\s*,\\s*/).join("|") + "|" + String("XBC".search(/b/i)) + "|" + all.join(",");
    }
    function dynamic(): string {
      let p = "a";
      if (Date.now() < 0) p = "b";
      const re = new RegExp(p + "+(b)", "g");
      const m = re.exec("xaab");
      return (m ? m[1] + m.index : "-") + String(re.test("xaab")) + re.source;
    }
    export function run(): string {
      return [scan(), rewrite(), flags(), pieces(), dynamic()].join(" ; ");
    }
  `;
  const expected = [
    "2020-01@0;7,2021-12@12;19",
    "x<1>y<22>z<333>|HellO WOrld",
    "truetruetrue6",
    "a|b|c|d|1|1@0,2@2,3@4",
    "b1falsea+(b)",
  ].join(" ; ");

  it("runs every match on the host engine only when selected, with identical results", async () => {
    const native = await runRegime(program);
    expect(native.imported.filter((name) => name.startsWith("env::__regexp_host_"))).toEqual([]);
    expect(native.exports.run()).toBe(expected);

    const result = await compileRegime(program, ["regexp"]);
    const engine = (result.hostImportInventory ?? []).filter((entry) => entry.name.startsWith("__regexp_host_"));
    expect(engine.map((entry) => entry.name).sort()).toEqual([
      "__regexp_host_capture",
      "__regexp_host_exec",
      "__regexp_host_register",
      "__regexp_host_subject",
    ]);
    for (const entry of engine) expect(entry).toMatchObject({ classification: "host-accelerator", family: "regexp" });

    // Record the host engine's answers: -1 would mean a native-VM fallback.
    const imports = buildCompiledImports(result) as ReturnType<typeof buildCompiledImports> & {
      env: Record<string, (...args: unknown[]) => unknown>;
    };
    const answers: number[] = [];
    const hostExec = imports.env.__regexp_host_exec!;
    imports.env.__regexp_host_exec = (...args: unknown[]) => {
      const answer = hostExec(...args) as number;
      answers.push(answer);
      return answer;
    };
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    const exports = wrapCompiledExports(result, instance) as Record<string, any>;
    expect(exports.run()).toBe(expected);
    expect(answers.filter((answer) => answer === 1).length).toBeGreaterThan(10);
    expect(answers).not.toContain(-1);
  });

  it("falls back to the native VM for a program the host never registered", async () => {
    const { resolveRegExpHostImport, hostRegExpMatchFlags } = await import("../src/runtime/regexp-host-accelerator.js");
    const owner = {};
    const exec = resolveRegExpHostImport("__regexp_host_exec", owner)!;
    expect(exec({}, {}, 0, 3, 0, 0)).toBe(-1);
    // Flag bits mirror src/codegen/regex/bytecode.ts RE_FLAG_*; g/y/d never reach the host program.
    const bytecode = await import("../src/codegen/regex/bytecode.js");
    expect(hostRegExpMatchFlags(bytecode.RE_FLAG_I | bytecode.RE_FLAG_M | bytecode.RE_FLAG_G)).toBe("im");
    expect(
      hostRegExpMatchFlags(bytecode.RE_FLAG_S | bytecode.RE_FLAG_U | bytecode.RE_FLAG_Y | bytecode.RE_FLAG_D),
    ).toBe("su");
    expect(hostRegExpMatchFlags(bytecode.RE_FLAG_V)).toBe("v");
  });
});
