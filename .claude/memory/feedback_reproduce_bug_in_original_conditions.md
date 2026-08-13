---
name: feedback-reproduce-bug-in-original-conditions
description: "Reproduce a bug report in the reporter's EXACT original conditions + trace to .wat before claiming a fix or that you tested."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fab8c15e-42ba-4dae-b2f8-dc6dcc1155b9
---

When a bug report comes in, reproduce it in the **original reported conditions** — the reporter's exact toolchain and flow (e.g. `bun build` → type-stripped `.js` → `--target wasi` → **real wasmtime**), not a proxy (esbuild instead of bun, an in-process fd shim instead of real wasmtime, or the `.ts` path instead of the transpiled `.js`). Trace the problem from source down to the **`.wat` level** to confirm the actual mechanism rather than a plausible hypothesis.

**Before claiming a fix — or that you "tested" — actually re-run the original repro on the fixed code in those same conditions and confirm it passes.**

**Why:** On loopdive/js2wasm#389 I told the reporter "fixed" three times by validating the `.ts` path / proxies instead of his exact `bun build` → `.js` → wasmtime flow — wrong each time; the real bug only reproduced in his conditions. Relaying a subagent's "verified" claim without re-running it myself is the same trap (the agent's CI test used esbuild + an in-process fd shim, not bun + real wasmtime).

**How to apply:** reproduce-first in the reporter's conditions → trace to WAT for the real mechanism → re-run that exact repro on the fix before saying it works. Never claim "tested"/"fixed" off a proxy or a subagent's word. [[feedback_verify_fix_in_git_not_narrative]]
