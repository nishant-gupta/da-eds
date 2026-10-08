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
- Shows the page path, template result, mandatory and flexible rule counts, and any violations. Rule violations are errors for this check; an unregistered page is a warning; missing or malformed source/config is an unable-to-run error.
- Validates the source currently available from DA. This is an on-demand report only; it does not inspect unsaved edits and cannot prevent editing, saving, or publishing.

## Local checks

Run `npm run build:governance` after changing either browser entry point or the shared governance rules, and commit the generated bundles with the source changes. This bundles local modules into same-origin JavaScript files while leaving the DA SDK import external; those generated bundles are the files loaded by the browser.

Run `npm run test:governance-preflight` to test result classification, shared-rule parity, and malformed configuration without calling a live DA service.
