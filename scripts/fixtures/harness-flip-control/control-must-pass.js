// Copyright (C) 2026 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: >
  Positive control for scripts/harness-flip-probe.ts — MUST report `pass`.
  Deliberately exercises only assert.js/sta.js, no compiler feature under
  investigation, so it stays a control rather than becoming a second variable.
esid: pending
flags: [noStrict]
---*/

assert.sameValue(1, 1, "identity");
assert(true, "truthy");
