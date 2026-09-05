// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const row = "language/expressions/function/dstr/ary-ptrn-rest-id-exhausted.js";
const file = resolve("test262/test", row);

it.skipIf(!existsSync(file))("materializes an exhausted parameter rest binding as an empty Array", async () => {
  const result = await runTest262File(file, "exhausted-parameter-rest", 30_000);
  expect(result.status, result.reason ?? result.error ?? row).toBe("pass");
});
