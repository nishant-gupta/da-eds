# OneAZ Governance Check

This DA Prepare-menu check reports whether the active page's **saved DA Source** conforms to the OneAZ sitemap registry and template rules. It reuses the validation implementation in `tools/governance/rules.mjs` and complements, rather than replaces, the OneAZ Governance editor extension.

## DA Prepare registration

Register this entry in the **Prepare** tab of the DA site's config:

| title | path | experience |
|---|---|---|
| OneAZ Governance Check | `https://main--da-eds--nishant-gupta.aem.live/tools/governance-preflight.html` | `fullsize-dialog` |

Use the actual deployed branch/host and configure this in the DA site being authored. This Prepare registration is external to `tools/sidekick/config.json`; do not rename it to `Preflight`, which would replace Adobe's built-in check. The existing OneAZ Governance extension remains independently registered in the Sidekick config.

## Behavior and limits

- Reads the current page, `content/sitemap-registry.json`, and `content/template-rules.json` through the DA Source API with the DA SDK token. No preview or publish is required.
- Reports rule violations as errors for this check, an unregistered page as a warning, and missing or malformed source/config as an unable-to-run error.
- Validates the source currently available from DA. This is an on-demand report only; it does not inspect unsaved edits and cannot prevent editing, saving, or publishing.

## Local checks

Run `npm run test:governance-preflight` to test result classification, shared-rule parity, and malformed configuration without calling a live DA service.
