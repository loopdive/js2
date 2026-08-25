// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4705 — synchronous for-of applies ToObject to a nullish RHS before asking
 * for an iterator. The throw must be a real TypeError instance.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const FOR_OF_ROOT = "language/statements/for-of";
const FOR_AWAIT_OF_ROOT = "language/statements/for-await-of";
const EXACT = "head-expr-to-obj.js";
const CONTROLS = [
  "head-expr-obj-iterator-method.js",
  "head-expr-primitive-iterator-method.js",
  "cptn-expr-itr.js",
  "cptn-expr-no-itr.js",
  "generic-iterable.js",
  "array.js",
] as const;

describe("#4705 — synchronous for-of RHS ToObject", () => {
  it("passes the exact ES2015 nullish-RHS test", async () => {
    const file = join("test262/test", FOR_OF_ROOT, EXACT);
    const result = await runTest262File(file, FOR_OF_ROOT, 30_000);
    expect(result.status, `${EXACT}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(CONTROLS)("keeps synchronous for-of control %s passing", async (name) => {
    const file = join("test262/test", FOR_OF_ROOT, name);
    const result = await runTest262File(file, FOR_OF_ROOT, 30_000);
    expect(result.status, `${name}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it("keeps detached guarded bodies synchronized after the throw adds a string global", async () => {
    const name = "async-func-decl-dstr-array-elem-init-evaluation.js";
    const file = join("test262/test", FOR_AWAIT_OF_ROOT, name);
    const result = await runTest262File(file, FOR_AWAIT_OF_ROOT, 30_000);
    expect(result.status, `${name}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
