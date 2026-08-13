---
name: reference_skipped_needs_if_pattern
description: "GitHub Actions — let a downstream job run when an event-gated needs: dependency is skipped"
metadata: 
  node_type: memory
  type: reference
  originSessionId: fab8c15e-42ba-4dae-b2f8-dc6dcc1155b9
---

When a job `B` has `needs: A` and `A` has an event-gated `if:` (e.g. `if: github.event_name == 'push'`), on the *other* event path `A` is **skipped**, and by default a `needs:` on a skipped job **also skips `B`**. To let `B` proceed when `A` is skipped but still block when `A` actually fails, give `B`:

```yaml
needs: A
if: |
  always() &&
  needs.A.result != 'failure' &&
  needs.A.result != 'cancelled'
```

Used in `.github/workflows/publish-npm.yml` (#2196 / loopdive/js2wasm#389): `verify-version` is `if: github.event_name == 'push'` (tag-publish only); `publish-npm needs: verify-version` uses the pattern above so the `workflow_dispatch` dry-run (where verify-version is skipped) still runs, while a real version-mismatch failure on a tag push blocks the publish.

To parse a workflow YAML locally in this repo (no `pyyaml`, `yaml` is only a pnpm-nested dep): `import('/workspace/node_modules/.pnpm/yaml@*/node_modules/yaml/dist/index.js')` — glob the `.pnpm` path. See [[reference_no_rebuild_helper_body_at_finalize]] for other CI/build gotchas.
