# OneAZ Standardisation & Scalability — Governance Extension Architecture & POC Plan

**Maps to:** Pilot doc §7 "OneAZ Standardisation & Scalability" (O5)
**Status:** Draft for review — Phases 1–3 scaffolded and verified end-to-end against live pages (see "Implementation status" below); Phase 4 (scale to all templates, design-token tie-in, Author Kit packaging) not started
**Author:** da-eds engineering (drafted with Claude Code)

---

## 0. Implementation status

A working scaffold for Phase 1 (data model) + Phase 2 (plugin MVP) + Phase 3 (validation bot) is checked into this repo:

| File | Purpose |
|---|---|
| `content/sitemap-registry.json` | **DA sheet** — path → template resolver (regex `pathPattern`, one row per governed page type), pushed via `aem content push` |
| `content/template-rules.json` | **DA sheet** — per-template mandatory/flexible block rules (min/max), one row per (template, zone, block) |
| `tools/governance/rules.mjs` | **Shared logic** — path resolution, rule reassembly, block extraction, and violation checking. Pure functions, no DOM/Node dependency. Imported by both files below, closing the §6.3 drift risk. |
| `tools/governance/governance.html` / `.js` / `.css` | The DA Governance Plugin — a da.live library plugin (code, not content). Soft enforcement. |
| `tools/governance/validate-bot.mjs` | **Phase 3 — the hard gate.** Node CLI that re-fetches published pages and validates them against the same rules via `rules.mjs`. Run manually or via CI. |
| `.github/workflows/oneaz-governance.yaml` | Wires the bot into CI — push to `main`, daily schedule, and manual dispatch. **Report-only** (`--fail-on-violation` not passed) until false-positive rate is proven low, per §5 Phase 3. |
| `tools/governance/examples/*.html` | Bundled insertable block markup (hero, cards, accordion, quote, video — see below) |
| `tools/sidekick/config.json` | Registration — added an `oneaz-governance` entry (`daLibrary: true`), following the exact pattern of the existing `da-plugin-demo` entry |

**Verified against real da.live source** (`adobe/da-live` `blocks/edit/da-library/da-library.js` and `adobe/da-nx` `nx/utils/sdk.js`, `nx/sdk/demo.js` — pulled via `gh api`, not guessed): the plugin loads via `import DA_SDK from 'https://da.live/nx/utils/sdk.js'`, receives `{ context, actions }` where `context = { view, org, repo, ref, path }`, and inserts content via `actions.sendHTML(html)`. `context.path` is confirmed to be the live document path — that's what makes the whole per-template resolution possible.

**The two config files are pushed to DA, not committed as repo code** — using the `@adobe/aem-cli` `aem content clone` / `add` / `commit` / `push` workflow (equally possible via the DA MCP). This matters beyond just "where the file lives": DA sheets have a real format constraint that a plain JSON file doesn't — see §4 for the flat-cell rule this scaffold got wrong on the first attempt and had to correct.

**Verified end-to-end against 4 real published test pages** (2 valid, 2 deliberately invalid, one per template plus a repeat) covering every violation type the bot checks:

| Test page | Case | Bot correctly caught |
|---|---|---|
| `/de/startseite` | valid homepage | — (PASS) |
| `/de/startseite/therapiegebiete/cvrm/diabetes` | valid therapy-area | — (PASS) |
| `/fr/startseite/produkte/trixeo/uberblick` | missing mandatory block | `missing-mandatory: form` **and** `wrong-position: form must be last, found cards` |
| `/it/startseite/therapiegebiete/onkologie/lungenkrebs` | exceeds max + illegal block | `too-many: accordion exceeds max 3 (found 4)` **and** `disallowed-block: video` |

Two real bugs were found and fixed while proving this, both instructive:
1. **Block detection was reading the wrong class.** `.block` is added by client-side JS at runtime (`scripts.js`'s decoration pass) — a plain `fetch()` (used by both the plugin and the bot) only ever sees the pre-decoration HTML, where a block div's *only* class is already its name. `extractBlocks()` in `rules.mjs` reads that instead.
2. **`max` counts block instances, not content items.** An early test page put 4 FAQ entries inside *one* `accordion` block, expecting that to trip the max-3 rule — it didn't, because that's 1 block instance, which is compliant. The rule is about how many separate block instances of a type appear in a zone, not how many rows are inside one of them. Fixed by using 4 separate accordion blocks in the test page. Worth making explicit to the Content Strategist during Phase 0 — "max 3" reads ambiguously otherwise.

**Deliberate scope cuts still open, called out so they're not mistaken for the final design:**
- **Existing-block detection (in the plugin) is best-effort, not exact.** There is no SDK call to read the current document's live content — the closest available signal is fetching the page's last published/previewed HTML, which can lag unsaved edits. The bot doesn't have this problem — it always reads the actually-published page.
- **Only 5 of ~9 referenced blocks have bundled insert examples** (`hero`, `cards`, `accordion`, `quote`, `video`, in `tools/governance/examples/`) — enough to prove the `sendHTML` insertion path end-to-end. The picker shows "example pending" and disables insertion for the rest (`table`, `form`, `search`). Phase 4 should source these from the org's real block library rather than hand-authoring more local fragments.
- **Path patterns and template names are illustrative**, mirroring myastrazeneca.ch's actual page types (homepage / therapy-area / product-landing) from the earlier sitemap audit — Phase 0's co-design output replaces these, it doesn't extend them.
- **The bot's page list is hand-maintained** (`--paths=...` in the CI workflow) — it supports `--sitemap=<url>` for auto-discovery, but this sandbox site doesn't have a real sitemap.xml to point it at yet. Switch to that once one exists.
- **Report-only, not blocking** — the CI workflow doesn't pass `--fail-on-violation`, so it currently can't break a build. That's intentional per §5 Phase 3; flipping it on is a deliberate later decision, not an oversight.

---

## 1. Problem, grounded in this repo

> **Correction from initial draft:** this project does not use AEM Universal Editor for authoring — UE "doesn't work well in DA" in practice. Authoring happens entirely in **da.live's own WYSIWYG document editor**: authors type in a Word/Google-Docs-like canvas, insert blocks via the slash-menu or the Block Library as HTML tables, and those tables render through each block's `blocks/<name>/<name>.js` `decorate()` function. There is no structured canvas, no drag/drop component tree, and no property rail.
>
> This repo *does* contain `component-filters.json`, `component-models.json`, `component-definition.json` and `ue-template.html`, generated by `npm run build:json` from `models/_component-*.json`. **These are inert AEM Boilerplate scaffolding for Universal Editor and play no role in the actual authoring flow.** They are called out below only as evidence of the underlying problem, not as a mechanism this plan builds on — the real target architecture (§2 onward) does not touch them, and Phase 1 of the POC recommends explicitly retiring them to avoid future engineers mistaking them for a live governance layer.

Section 7.1 describes the root cause as architectural: a generic, loosely-typed container model that permits near-unlimited layout variation. Even though UE isn't the live editor, its dormant config is still useful evidence of how unconstrained the model is:

```json
// component-filters.json (dormant UE scaffolding — not used at runtime)
[
  { "id": "main", "components": ["section"] },
  { "id": "section", "components": [
      "accordion","button","cards","carousel","columns","embed","fragment",
      "form","hero","image","quote","search","tabs","table","text","title","video"
  ]}
]
```

Even this dormant file has only **one** filter (`section`) applying globally — no notion of "template" at all. And the real, live equivalent is *more* permissive, not less: in the WYSIWYG doc editor, the DA **Block Library** (a `library-blocks` sheet / `blocks.json` manifest) is a single global picker shown identically on every page, and — because it's a plain document — an author can also just type or paste a block's table markup by hand anywhere, bypassing the picker entirely. There is no canvas-level constraint of any kind today. This is the literal mechanism behind §7.1's "usage drifts market by market, page by page" — the tooling has no opinion, so every page becomes a one-off.

**The fix is not a new tool bolted onto Universal Editor — it's (a) making the sitemap → template → component hierarchy an explicit, addressable data model, (b) using that model to drive a custom-filtered block picker inside the WYSIWYG editor via a DA plugin, and (c) treating a post-save validation bot as the actual enforcement point, since a plain document editor cannot structurally prevent an author from typing something disallowed.**

---

## 2. Target architecture — three layers, three artifacts

| Pilot doc concept | Concrete artifact | Where it lives |
|---|---|---|
| **Sitemap** — every permitted page + its template + adaptation scope (global/market/page) | `sitemap-registry.json` (new) | **DA sheet** (`content/sitemap-registry.json`, Content Strategist-editable in da.live), fetched at the published/live URL by both the plugin and the validation bot |
| **Template** — exactly one fixed template per sitemap entry, with mandatory items + constrained flexible zones | `template-rules.json` (new) — per-template mandatory/flexible block lists with min/max/order, one row per (template, zone, block) | **DA sheet** (`content/template-rules.json`), same editing/consumption model as above |
| **Components ("lego blocks")** — purpose-built blocks, not generic containers | `blocks/*` (existing pattern — `decorate()` + CSS per block; extend with more purpose-built blocks like Benefits, Statistics per §7.2) | Repo, already exists |

Two new runtime pieces sit around this data model — and because there's no UE canvas, **both are needed; neither alone is sufficient**:

1. **DA Governance Plugin** — a custom panel (da.live plugin, PostMessage SDK) that replaces the native Block Library picker inside the WYSIWYG editor. It reads the current document's path, resolves it against `sitemap-registry.json`, and shows the Assembler exactly what's allowed — mandatory blocks, remaining flexible slots, and a picker filtered to only that template's approved blocks (inserted via `sendHTML`). *Soft* enforcement: it constrains the picker, but an author can still type/paste a table by hand and bypass it.
2. **Validation Bot** — a post-save check (GitHub Action on DA→repo content sync, or a scheduled sweep) that re-parses the actual authored document structure and validates it against `sitemap-registry.json` + `template-rules.json`. This is **the real hard gate** — in a plain WYSIWYG doc editor with no canvas constraints, it is the *only* mechanism that can catch a hand-typed or pasted violation the plugin's picker never saw.

This split exists because of a real gap confirmed against DA's public plugin docs: the SDK exposes insertion actions (`sendText`, `sendHTML`, `closeLibrary`) but no documented save/publish interception hook, and — with no UE canvas — there is no structural layer anywhere in the editor itself that can refuse an invalid save. **Do not scope the POC as if the editor can enforce this; the bot carries that weight.**

---

## 3. System diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Content Strategist + Design (O10 Phase 1)                          │
│  → jointly author sitemap-registry.json + template-rules.json       │
│    (which pages exist, which template each maps to, mandatory/      │
│     flexible zones per template, min/max/order per zone)            │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │  (edited as DA sheets, pushed via aem content push)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  da.live WYSIWYG document editor session (no UE canvas)             │
│                                                                       │
│   Assembler opens/creates a page                                     │
│        │                                                             │
│        ▼                                                             │
│   DA Governance Plugin panel (PostMessage SDK)                       │
│     1. reads current doc path                                       │
│     2. resolves path → sitemap-registry.json → template id          │
│     3. renders: mandatory blocks / remaining flexible slots /        │
│        allowed component list for THIS template only                │
│     4. REPLACES the native Block Library picker with a filtered      │
│        one → sendHTML() only approved blocks                         │
│        │                                                             │
│        ▼                                                             │
│   (no structural gate below this — a plain WYSIWYG doc lets an       │
│    author type/paste any table by hand, bypassing the plugin;        │
│    this is a known, accepted gap — see §6.1)                         │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │  Assembler saves / publishes
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Validation Bot (GitHub Action on DA→repo sync, or scheduled sweep) │
│    - fetches published page HTML                                     │
│    - extracts actual block sequence                                  │
│    - checks against sitemap-registry.json + template-rules.json:    │
│        • mandatory blocks present (e.g. Hero at top)                 │
│        • only approved blocks for that template used                │
│        • min/max count per flexible zone respected                  │
│        • ordering constraints respected                              │
│    - HARD GATE: flags violation (PR comment / Slack / dashboard)    │
│      — this is the actual governance enforcement point               │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
        Design tokens (§5.3) — brand/market look-and-feel — are a
        SEPARATE, parallel config axis (not addressed by this doc);
        tie-in point is that both configs are centrally managed and
        both are resolved by the same page-path → template lookup.
```

---

## 4. Data model detail

Both files below are **DA sheets, not repo code** — they live at `content/sitemap-registry.json` and `content/template-rules.json`, authored/edited directly in da.live's spreadsheet grid UI, and pushed via `aem content push` (or the DA MCP). This is deliberate: the whole point of §7.2 is that a Content Strategist can change governance rules without a code deploy, so these cannot live as static repo JSON.

**Hard constraint, learned the hard way while building this scaffold:** a DA sheet's cells must be flat primitives — every row is `{ column: "string value", ... }`. An early draft nested a `scope: { structure, content }` object inside each sitemap-registry row; that JSON is syntactically valid but **da.live's editor won't render a grid for it** — it can't map a nested object onto a spreadsheet cell, so the doc opens as raw/read-only rather than an editable sheet. The fix is to flatten every field to its own column (`structureScope`, `contentScope` instead of `scope.structure`/`scope.content`), and to wrap the whole document in the multi-sheet envelope (`:version`, `:names`, `:type: "multi-sheet"`) that da.live expects — confirmed against a known-working DA sheet from this project (`translate-config.json`'s shape).

### 4.1 `sitemap-registry.json` (DA sheet — `content/sitemap-registry.json`)

```json
{
  "data": {
    "total": 3, "offset": 0, "limit": 3,
    "data": [
      { "id": "homepage", "pathPattern": "^/(de|fr|it|en)/startseite$", "template": "homepage", "structureScope": "global", "contentScope": "page", "market": "*" },
      { "id": "therapy-area", "pathPattern": "^/(de|fr|it|en)/startseite/therapiegebiete/[^/]+/[^/]+$", "template": "therapy-area", "structureScope": "global", "contentScope": "market", "market": "*" },
      { "id": "product-landing", "pathPattern": "^/(de|fr|it|en)/startseite/produkte/[^/]+/uberblick$", "template": "product-landing", "structureScope": "global", "contentScope": "market", "market": "*" }
    ]
  },
  ":version": 1,
  ":names": ["data"],
  ":type": "multi-sheet"
}
```

- `pathPattern` — a regex string, matched against the DA doc path (extension and trailing slash stripped) to resolve a template. Needs a small matcher shared by the plugin (browser) and the bot (Node) — same regex syntax on both sides.
- `structureScope` / `contentScope` — the flattened form of §7.2's "global / market / page" adaptation levels, split into two plain columns instead of one nested object, per the constraint above.

### 4.2 `template-rules.json` (DA sheet — `content/template-rules.json`)

No Universal Editor filter mechanism is involved (it's not part of the live editing flow — see §1). This sheet is the **single source of truth**, consumed independently by:
- the **plugin**, client-side, to build the filtered picker and the in-context "what's allowed" panel, and
- the **bot**, server-side, to validate what actually got saved.

Both must resolve the same page path to the same template and read the same rules — see risk §6.3 on keeping that resolution logic from drifting between the two runtimes.

The nested `{ mandatory: [...], flexible: [...] }` shape from the first draft has the same flat-cell problem as §4.1 — it's flattened here to **one row per (template, zone, block)**, which also happens to be the natural CSV/spreadsheet shape a Content Strategist would actually edit:

```json
{
  "data": {
    "total": 4, "offset": 0, "limit": 4,
    "data": [
      { "template": "therapy-area", "zone": "mandatory", "block": "hero", "position": "first", "min": "1", "max": "1" },
      { "template": "therapy-area", "zone": "flexible", "block": "accordion", "position": "", "min": "0", "max": "3" },
      { "template": "product-landing", "zone": "mandatory", "block": "hero", "position": "first", "min": "1", "max": "1" },
      { "template": "product-landing", "zone": "mandatory", "block": "form", "position": "last", "min": "1", "max": "1" }
    ]
  },
  ":version": 1,
  ":names": ["data"],
  ":type": "multi-sheet"
}
```

`min`/`max` are stored as strings (standard for spreadsheet cells) and cast with `Number()` in code. This is the schema both the plugin (for guidance) and the bot (for enforcement) read — `tools/governance/governance.js`'s `rulesForTemplate()` reassembles the flat rows back into the mandatory/flexible shape at runtime.

### 4.3 Component layer — existing block pattern, no new mechanism

There's no UE property-rail schema to maintain in the WYSIWYG flow — a block's "model" is just its authored table shape plus its `blocks/<name>/<name>.js` `decorate()` and CSS, the same pattern already used by every block in `blocks/` today (e.g. `hero`, `cards`, `accordion`). The work here is authoring *more* purpose-built blocks this way (Benefits, Statistics per §7.2) — not introducing a new schema mechanism. If a lightweight per-block field reference is still wanted for the plugin's in-context guidance (e.g. "Hero needs: image, alt, heading"), keep it as a small hand-authored README/JSON per block rather than reviving `component-models.json`, which is UE-specific and unused.

---

## 5. POC scope — phased

**Phase 0 — Co-design (non-technical prerequisite, per §7.2 / O10 Phase 1)**
Content Strategist + Design define, for myastrazeneca.ch specifically: the fixed set of sitemap entry types (Homepage, Therapy Area, Product Landing, Contact — the actual page types already inventoried in `myastrazeneca-sitemap-report.md`), one template per type, and each template's mandatory/flexible zones. **This must happen before any config is written** — the pilot doc is explicit that this is a content-strategy decision first.

**Phase 1 — Data model**
- Author `sitemap-registry.json` and `template-rules.json` as DA sheets for the 4–5 real OneAZ page types from Phase 0, and push via `aem content push` (or DA MCP).
- Build the 1–2 net-new purpose-built blocks Phase 0 calls for (e.g. Benefits, Statistics), following the existing `blocks/*` pattern.
- Housekeeping: remove or clearly quarantine `component-filters.json` / `component-models.json` / `component-definition.json` / `ue-template.html` and the `build:json` scripts, since they're dormant UE scaffolding that could otherwise mislead future contributors into thinking they do something.

**Phase 2 — DA Governance Plugin (MVP, 1 template)**
- da.live plugin scaffold (PostMessage SDK) registered via the site's `library`/`apps` sheet, replacing the native Block Library entry point.
- Panel resolves current doc path → `sitemap-registry.json` → template → renders mandatory/flexible/allowed-list in-context.
- Filtered picker restricted to that template's approved blocks (`sendHTML` on selection) — this is the entire enforcement surface available inside the editor itself.
- Scope to **one template only** (Therapy Area, since it's the most common page type) to validate the UX before generalizing.

**Phase 3 — Validation Bot (MVP, hard gate) — done**
- `tools/governance/validate-bot.mjs`, wired into `.github/workflows/oneaz-governance.yaml` — runs on push to `main`, daily schedule (catches DA-only edits with no code push), and manual dispatch.
- Parses actual block sequence per page via the shared `rules.mjs`, checks against `sitemap-registry.json` + `template-rules.json` — same rules, same logic, same code path the plugin uses, not a re-implementation.
- Checks mandatory presence, position (`first`/`last`), flexible min/max, **and disallowed blocks** — the last one is a check the plugin *doesn't* do (see §0), so the bot is strictly a superset, not a duplicate.
- Outputs a markdown table (written to `$GITHUB_STEP_SUMMARY` when running in Actions) and a JSON report artifact.
- **Report-only**: `--fail-on-violation` is not passed in CI, so it can't break a build yet — verified both exit codes (0 on pass, 1 only when that flag is explicitly set) work correctly before wiring this in.

**Phase 4 — Scale & tie-in**
- Extend plugin + bot to all templates from Phase 0.
- Wire the same path→template resolution into the design-token layer (§5.3) so structural rules and visual tokens resolve from one lookup.
- Package as an Author Kit variant (Adobe's own pattern: AK Media, AK Docs, AK Gov, AK Commerce already exist as vertical flavors) — i.e. **AK OneAZ** — so the next market onboards by cloning a pre-governed starter, not by copying myastrazeneca.ch's pages.

---

## 6. Open questions / risks to resolve before committing scope

1. **No structural enforcement exists inside the editor at all** — this is the biggest change from the initial (UE-based) draft. In a WYSIWYG doc, an author can always type or paste a table by hand and bypass the plugin's picker entirely; there is no canvas, no drag/drop tree, nothing analogous to UE's filters to fall back on. Confirm with Adobe's DA/da-live team whether any non-public save/publish interception hook exists; if not (likely), **the validation bot in Phase 3 is not a secondary safety net — it is the only real governance gate**, and should be sized/resourced as such from the start, not treated as a "nice to have" bolted on after the plugin ships.
2. **Bot detection accuracy — resolved for the tested cases, not exhaustively.** `extractBlocks()` in `rules.mjs` tracks div depth rather than matching on the `.block` class (which only exists post-client-JS-decoration — a real bug this scaffold hit and fixed), and it's been verified against 4 real published pages including one with a variant-bearing block. Not yet tested against markup with unusual whitespace, nested default-content divs outside of blocks, or fragments — worth a wider real-page sample before trusting this on the actual myastrazeneca.ch site.
3. **Path-pattern matching consistency — resolved.** Both the plugin and the bot import the same `tools/governance/rules.mjs` — one `resolveTemplate()`, one `rulesForTemplate()`, one `extractBlocks()`. There's no second implementation left to drift.
4. **Report-only vs. blocking bot** — decide the false-positive tolerance before Phase 3 goes from "report" to "block publish," since a bad rule can freeze content ops — the exact governance-overhead risk this pilot is trying to eliminate.
5. **Market-level scope semantics** — `contentScope: "market"` in the sitemap registry needs a concrete definition of what a market is *allowed* to change (copy only? copy + one optional block? nothing?) — this is a Phase 0 content-strategy decision, not a technical one.

---

## 7. Success criteria (ties to O5 / §7.3 business case)

- **Time-to-publish a compliant page** drops relative to today's undocumented/tribal-knowledge baseline (needs a "before" timing measurement — not yet captured).
- **Zero net-new template variants** created outside the registry over a defined pilot window (this is the actual scalability test — a market silently forking a layout should become structurally impossible, not just discouraged).
- **Validation bot false-positive rate** low enough to move from report-only to blocking without content-ops pushback.
- **New market onboarding time** (once AK OneAZ exists) measured against the current from-scratch build effort for myastrazeneca.ch.
