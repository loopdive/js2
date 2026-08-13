---
name: project_repo_api_canonical_name
description: GitHub API WRITES must target repos/loopdive/js2wasm (canonical) — js2wasm is a rename redirect that only GETs follow
metadata: 
  node_type: memory
  type: project
  originSessionId: c19a074a-4ada-4e4b-afb8-270d11bcef54
---

The repo's canonical GitHub name is `loopdive/js2wasm`; `loopdive/js2wasm` is a
rename redirect. `gh api` GET requests follow the redirect, but **PUT/PATCH/
POST return 404** on the old name (hit 2026-06-11 when PATCHing ruleset
16700772). Local remotes/clones use js2wasm and keep working.

**How to apply:** any mutating `gh api` call (rulesets, merge-queue GraphQL is
fine since it takes owner/name args you can set to js2, issues, etc.) → use
`repos/loopdive/js2wasm/...`. PR URLs printed by `gh pr create` already show
`loopdive/js2wasm`.
