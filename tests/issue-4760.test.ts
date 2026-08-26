// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4760 — Promise.prototype.then must assimilate a WasmGC object-literal
// thenable returned by a reaction callback. The host Promise import receives
// opaque structs, so it needs the same live mirror used by Promise.resolve;
// otherwise V8 never observes a throwing `then` accessor and fulfills the
// chained promise with the raw object.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

const POISONED_THENABLE_CASES = [
  "built-ins/Promise/prototype/then/resolve-pending-fulfilled-poisoned-then.js",
  "built-ins/Promise/prototype/then/resolve-pending-rejected-poisoned-then.js",
  "built-ins/Promise/prototype/then/resolve-settled-fulfilled-poisoned-then.js",
  "built-ins/Promise/prototype/then/resolve-settled-rejected-poisoned-then.js",
] as const;

const NON_THENABLE_CONTROLS = [
  "built-ins/Promise/prototype/then/resolve-pending-fulfilled-non-thenable.js",
  "built-ins/Promise/prototype/then/resolve-pending-rejected-non-thenable.js",
  "built-ins/Promise/prototype/then/resolve-settled-fulfilled-non-thenable.js",
  "built-ins/Promise/prototype/then/resolve-settled-rejected-non-thenable.js",
] as const;

const CASES = [...POISONED_THENABLE_CASES, ...NON_THENABLE_CONTROLS] as const;

describe("#4760 Promise.prototype.then reaction-value assimilation", () => {
  for (const file of CASES) {
    it(`${file} passes in the host lane`, async () => {
      const result = await runTest262File(resolve("test262/test", file), "built-ins/Promise", 60_000);
      expect(result.status, result.error).toBe("pass");
    }, 90_000);

    it(`${file} passes in the standalone lane`, async () => {
      const result = await runTest262File(resolve("test262/test", file), "built-ins/Promise", 60_000, "standalone");
      expect(result.status, result.error).toBe("pass");
    }, 90_000);
  }
});
