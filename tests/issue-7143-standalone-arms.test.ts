// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7143 slice A1 — the standalone-arm ratchet counts matching LINES per token,
// whole words only: a line with two reads of the same flag counts once,
// `!ctx.standalone` also counts as `ctx.standalone`, and a prefix-sharing field
// (`ctx.wasiFdWriteIdx`) is provider state, not an arm.
import { describe, expect, it } from "vitest";
import { countLines, TOKENS } from "../scripts/check-standalone-arms.mjs";

describe("#7143 A1 standalone-arm ratchet: countLines", () => {
  it("names exactly the four Track A tokens", () => {
    expect(TOKENS.map(([name]) => name)).toEqual(["ctx.standalone", "!ctx.standalone", "noJsHost(", "ctx.wasi"]);
  });

  it("counts matching lines, not occurrences", () => {
    const text = [
      "if (ctx.standalone && ctx.standalone) emitNative();",
      "if (!ctx.standalone) emitHost();",
      "if (noJsHost(ctx) || ctx.wasi) emitWasi();",
      "const unrelated = ctx.standaloneish;",
      "if (ctx.wasiFdWriteIdx >= 0) emitFdWrite();",
    ].join("\n");
    expect(countLines(text)).toEqual({
      "ctx.standalone": 2,
      "!ctx.standalone": 1,
      "noJsHost(": 1,
      "ctx.wasi": 1,
    });
  });

  it("reports zeros for text without arms", () => {
    expect(countLines("const x = 1;\n")).toEqual({
      "ctx.standalone": 0,
      "!ctx.standalone": 0,
      "noJsHost(": 0,
      "ctx.wasi": 0,
    });
  });
});
