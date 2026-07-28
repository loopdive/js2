---
name: reference_false_done_audit_nnnn_vs_wasm_funcidx
description: "How to audit false-done issues via test262 citation counts — and the wasm-function-index false-positive trap that inflates a naive bare-#NNNN grep"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
  modified: 2026-07-20T14:01:36.325Z
---

**False-`done` audit** (2026-07-20, issue #3474): many issues are marked
`status: done` while test262 still fails their feature. To find them cheaply:
extract `#NNNN` from the **`error` field** of failing records in both
baselines-repo JSONL lanes, count per id, join against `plan/issues/*.md`
status, and flag `done` ids with live citations. Reopen (`status: done → ready`)
the genuine ones. Confirmed false-dones reopened: #2026, #1472, #680 (PR #3427);
#2717, #2620, #1907, #1888 (PR #3434).

**⚠️ The trap — bare `#NNNN` matches WASM FUNCTION INDICES, not just issue refs.**
test262 error strings contain things like `Compiling function #221:"__module_init"`
and `function #230:"__closure_10"` — a naive `grep -oE '#[0-9]{3,4}'` counts those
as "citations" and over-flags. On 2026-07-20 this falsely implicated #221/#222/
#223/#230/#258 (all correctly `done`). **The gate/audit MUST match the citation
format `(#NNNN)`** (parenthesised, how our codegen self-cites: `… not supported
(#1472)`), NOT bare `#NNNN`. Also distinguish:
- **Genuine false-done** — error says the feature `is not yet supported in
  --target standalone` / an explicit codegen refusal → reopen.
- **Legitimate done-but-cited** — a detector/umbrella (#2961 leak scanner) or an
  intentionally-deferred feature (#1387 with-statement, #1696 dynamic-import) →
  leave `done`, exempt in the gate.
- **Regression on a done issue** — e.g. #2043 "local index out of range" (a
  func-index-shift regression) → separate handling, not a plain reopen.

**#3474 Part B** is the durable fix: a CI gate blocking `status: done` while an
issue's `(#NNNN)` has >N live citations, with a detector/deferred exemption flag.
Related: [[reference_frontier_model_tier]], the #2093 probe-coverage gate is the
sibling pattern.
