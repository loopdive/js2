---
name: project_standalone_only_js_host_sunset
description: "Project-lead decision 2026-10-10: standalone only for all sessions; JS-host lane is being sunset"
metadata:
  node_type: memory
  type: project
---

**Standalone only. The JS-host lane is being sunset.** This is the project lead's decision of 2026-10-10. It applies to every session and agent.

- **In scope:** both no-host targets.
  - `--target standalone` (pure WasmGC).
  - The Linear/WASI native backend.
- **Out of scope for new work:**
  - JS-host IR paths.
  - New host imports.
  - Host-only fast paths.
  - Treating host-lane (`gc`) test262 numbers as the priority.
- **Existing JS-host code stays until it is retired.** Removing it needs its own reviewed change, so do not delete it opportunistically. Until then, keep gc output byte-identical when touching shared code.
- **Supersedes:** the older "Dual-mode: JS host optional" principle in CLAUDE.md, wherever they conflict.
- **Where it was announced:** loopdive/js2 PR 6583, comment 6102591012.
