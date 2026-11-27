// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, it, vi } from "vitest";
import { agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

it("preserves the selected JS value and runs only a selected right operand", async () => {
  await agreesWithNode(
    `var n = 0;
     var stored = "" || (n = n + 1);
     var decimal = 1.5;
     var other = decimal || 8;
     var nil = null;
     var empty = "";
     var out = "";
     if (stored === 1 && n === 1 && other === 1.5) out += "a";
     if ((nil && (n = n + 1)) === null && n === 1) out += "b";
     if ((empty || (n = n + 1)) === 2 && n === 2) out += "c";
     if (1 / (-0 && 9) === -Infinity && (false && 4) === false) out += "d";`,
    true,
    runnerOptions(),
  );
});
