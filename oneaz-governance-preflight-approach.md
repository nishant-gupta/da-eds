# OneAZ Governance Preflight — Approach

**Status:** Implemented; concept review completed.
**Related design:** [`oneaz-governance-architecture.md`](./oneaz-governance-architecture.md)
**Reference:** [Custom Preflight (DA Prepare menu)](https://github.com/cpilsworth/one-azn-demo/blob/main/tools/preflight/README.md)

## Goal

Add an explicit DA **Prepare** check for OneAZ page governance, alongside the existing **OneAZ Governance** editor extension. Authors should be able to run a page-level compliance check on demand using the same sitemap registry, template rules, and block validation as the extension.

This is an additional validation surface, not a replacement for Adobe's built-in Preflight and not a replacement for the governance extension's block picker and in-context guidance.

## Proposed shape

- Add a small DA Prepare-menu micro-frontend, following the reference's SDK handshake and current-document validation pattern. Give the menu entry a distinct title such as **OneAZ Governance** or **Governance checks**, not **Preflight**; this keeps Adobe's built-in Preflight available.
- On invocation, obtain the active document's DA context, read the active page and the two governance sheets (`sitemap-registry.json` and `template-rules.json`) from DA Source, and run the checks against the same saved source that the editor stores. Do not use published HTML or require preview/publish.
- Reuse `tools/governance/rules.mjs` for path normalization, template resolution, sheet parsing, block extraction, and rule evaluation. Do not fork a second interpretation of the governance rules. The existing extension remains the interactive authoring aid; this check reports results.
- Resolve the active page path through the registry and apply the matching template's mandatory/flexible block rules. Present each failed rule with the relevant block, expected condition, and observed condition, plus a clear overall result.
- Keep the initial scope page-level and browser-based. Do not add the reference project's optional hosted API, CLI, scheduled sweep, or CI gate: the architecture explicitly retires CI enforcement, and this request is for a DA preflight surface.

## Result and severity policy

The current governance model emits structural violations but does not assign severity. For the initial preflight, use a simple deterministic policy:

| Result | Proposed treatment |
|---|---|
| Missing mandatory block, wrong required position, count outside min/max, or disallowed block | **Error / blocking** |
| Page path not found in the OneAZ sitemap registry | **Warning / non-blocking**, clearly stating that no OneAZ template rules were applied |
| Registry/rules unavailable, malformed, or unable to read the active page | **Check could not run**; show an explicit failure rather than a pass or empty report |
| Page matches a registry entry but has no corresponding template rules | **Check could not run**; identify the template/configuration gap |

This blocking status is only the result of the custom check; it does not claim to prevent saving or publishing. The page editor has no confirmed save-veto hook, and the Prepare check is an on-demand report.

## Registration and deployment

Register the entry in the DA site's **Prepare** configuration using the deployed check URL, following the reference's `title` / `path` / optional `experience` pattern. Keep this distinct from `tools/sidekick/config.json`, which registers the current editor extension and DA apps; the preflight belongs in DA Prepare configuration and should not remove or alter the extension registration.

Follow the reference's standalone `fullsize-dialog` experience if the full report needs more room. Configuration should be added only after the deployed page URL and target DA site's config location are confirmed.

## Implementation

The DA check is implemented in `tools/governance-preflight.html` and `tools/governance-preflight/`. It reads the active page and governance sheets from DA Source, validates the configuration, delegates block extraction and rule evaluation to the existing governance implementation, and renders pass, fail, out-of-scope, and unable-to-run states. Unit tests are in `test/governance-preflight.test.mjs`; local execution is `npm run test:governance-preflight`.

DA Prepare registration remains an external deployment step because it is configured in the DA site's Prepare tab, not in this repository. The exact entry is documented in [`tools/governance-preflight/README.md`](./tools/governance-preflight/README.md). After deployment, register it with the distinct title **OneAZ Governance Check** and verify it appears beside Adobe's native Preflight and the existing editor extension.

## Acceptance criteria

- A governed page passes/fails according to `sitemap-registry.json` and `template-rules.json`, with results consistent with `tools/governance/rules.mjs`.
- An unregistered page is reported as outside the governed scope, not as a false pass.
- Missing or invalid source/configuration produces an explicit unable-to-run result.
- The check reads the active page's DA source without preview or publish.
- Adobe's native Preflight and the existing OneAZ Governance extension remain available.
- The report does not imply that it blocks edits, saves, or publication.

## Boundaries and risks

- DA Prepare configuration is separate from this repository's Sidekick plugin manifest and must be updated in the correct DA site's config.
- Existing `rules.mjs` is DOMParser-dependent and browser-oriented; keep its parser and behavior shared. If the preflight requires any adaptation, make it a small shared helper rather than duplicating rule logic.
- The governance sheets are DA-managed data. The check must distinguish a page outside the registry from a broken/missing rules configuration.
- The check validates the saved DA source available when it runs. It does not establish that unsaved editor changes have been persisted, enforce on every keystroke, or provide a site-wide audit.
- A possible future headless/API check is deliberately out of scope and would require a separate decision consistent with the governance architecture's enforcement boundaries.

## Review record

- Concept review: completed; no material blockers found.
- Review confirmed that DA Prepare registration is separate from `tools/sidekick/config.json`, source reads should use saved DA Source, and the existing governance exports are sufficient for shared validation.
- Keep severity mapping in the report, and describe blocking only as a result of this custom check—not as save/publish enforcement. Do not expand into headless or CI enforcement.
- Implementation: complete in the repository; Prepare-menu registration/deployment remains pending.
