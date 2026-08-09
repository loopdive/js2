---
name: reference-grep-false-empties-diff-test262
description: "Plain grep returns NOTHING on scripts/diff-test262.ts (treated as binary despite UTF-8) — use grep -a or you get a confidently wrong \"feature absent\" verdict"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-24T22:34:08.504Z
---

`grep` silently matches nothing in `scripts/diff-test262.ts` — even for strings the
file definitely contains — because grep treats it as **binary**, while `file` reports
it as clean "JavaScript source, Unicode text, UTF-8 text". No "Binary file matches"
warning is printed; `grep -c` prints nothing at all. **Use `grep -a`** (or a TS/AST
scanner) on this file.

**Why it's dangerous, not just annoying:** the empty result reads as "this feature
does not exist here", which is a *confident wrong answer* about a CI gate. On
2026-07-24 this produced the false conclusions that (a) `diff-test262.ts` contained no
trap-ratchet logic, and (b) the `test262-sharded.yml:1720` comment pointing at it was
stale. Both were wrong and were relayed to a teammate before being caught. The file
in fact holds the whole #3189 uncatchable-trap ratchet plus the change-scoped
allowance (`TRAP_GROWTH_ALLOW_KEY = "trap-growth-allow"` ~line 295, read via
`readChangeScopedNumericAllowance` ~1851).

**Tell:** a `grep` that returns zero hits on a large file where the symbol is imported
elsewhere (`import { X } from "./that-file.js"`) is the signature — cross-check with
`grep -a` before concluding anything is missing.

Same class as the corollary in [[reference_ci_gate_change_scoped_not_wholetree_absolute]]
(grep -I false-empties NUL-byte files); this records the specific recurring file.
Related: [[reference_false_done_audit_nnnn_vs_wasm_funcidx]] — the other
"search result read too literally" hazard in this repo.
