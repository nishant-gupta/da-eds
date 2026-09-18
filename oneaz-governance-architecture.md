# OneAZ Standardisation & Scalability — Governance Extension Architecture & POC Plan

**Maps to:** Pilot doc §7 "OneAZ Standardisation & Scalability" (O5)
**Status:** Draft for review — Phases 1–2 scaffolded and verified live against DA source (see "Implementation status" below). Phase 3 was originally an async CI bot checking published pages — **superseded** by making the plugin itself read live DA source instead, per explicit direction that validation must happen immediately on edit, with no preview/publish and no manual refresh, and no GitHub Action. Phase 4 not started.
**Author:** da-eds engineering (drafted with Claude Code)

---

## 0. Implementation status

### 0.1 The model changed: live DA source, not published pages, no CI

The first working version of this scaffold read the **published** site (`aem.page`/`aem.live`) and split enforcement across two surfaces: an in-editor plugin (soft, advisory) and an async GitHub Action bot that re-checked published pages (the intended hard gate). That required a Preview + Publish cycle before either surface reflected a change.

That model is now **replaced**, per explicit direction: validation must happen as soon as an edit is made, without preview/publish and without the author or engineer manually refreshing the page or the plugin, and with no GitHub Action involved at all. Concretely:

- The plugin now reads the **DA Source API** (`https://admin.da.live/source/{org}/{repo}{path}.html`) directly — the same store da.live's own editor reads from and writes to — instead of the rendered site. A Content Strategist's edit (or a rule change in the two governance sheets) is visible the moment it's saved to DA, with no publish step in between.
- The panel re-fetches source and re-renders on `visibilitychange` / `window focus`, not on a timer and not on a manual reload — mirroring a proven pattern already used elsewhere in this org (see `tools/plugins/personalization` in the intuit-erp project, a sibling DA plugin with the exact same `fetchSource()` / `refresh()` shape). No polling loop was added; focus/visibility events are enough to make "no manual refresh" true in practice.
- The async bot (`validate-bot.mjs`) and its CI workflow (`.github/workflows/oneaz-governance.yaml`) have been **deleted**, not just disabled. Keeping a Node-only copy of the validation logic around as dead weight, now that there's a single live consumer, would recreate exactly the drift risk §6.3 exists to avoid.

**This does not close the enforcement gap from §6.1** — there is still no SDK hook to intercept or block a save in the main editing canvas (confirmed against `adobe/da-nx`'s `sdk.js`: only `sendText`/`sendHTML`/`setHref`/`setHash`/`closeLibrary`/`getSelection`/`setPrompt`/`showPanel`/`daFetch` are exposed, nothing resembling a change subscription or a save veto). What changed is *latency and trigger*, not *authority*: the panel now shows the true current state immediately instead of the last-published state, but an author can still save something invalid. If a true hard gate is wanted later, it would have to live outside this plugin (see §6.1's discussion of a non-public save hook, still unconfirmed) — this scaffold does not claim to have solved that.

### 0.2 What's checked into this repo

| File | Purpose |
|---|---|
| `content/sitemap-registry.json` | **DA sheet** — path → template resolver (regex `pathPattern`, one row per governed page type) |
| `content/template-rules.json` | **DA sheet** — per-template mandatory/flexible block rules (min/max), one row per (template, zone, block) |
| `tools/governance/rules.mjs` | Path resolution, rule reassembly, block extraction (DOMParser-based), and violation checking. Browser-only by design now — see §0.1. |
| `tools/governance/governance.html` / `.js` / `.css` | The DA Governance Plugin — reads DA source live, re-renders on focus/visibility. |
| `tools/governance/examples/*.html` | Bundled insertable block markup (hero, cards, accordion, quote, video) |
| `tools/sidekick/config.json` | Registration — an `oneaz-governance` entry (`daLibrary: true`), following the existing `da-plugin-demo` entry's pattern |

**Verified against real source, not guessed**, from two places:
- `adobe/da-live` (`blocks/edit/da-library/da-library.js`) and `adobe/da-nx` (`nx/utils/sdk.js`, `nx/sdk/demo.js`), pulled via `gh api` — confirms `context = { view, org, repo, ref, path }`, `token`, and the `actions` shape.
- This org's own `tools/plugins/personalization` plugin (intuit-erp) — confirms the DA Source API read pattern (`admin.da.live/source/{org}/{repo}{path}.html`, `Authorization: Bearer {token}` from the raw SDK token, `cache: 'no-store'`) and the focus/visibility refresh pattern, both adopted here as-is rather than reinvented.

### 0.3 Verified end-to-end against 4 real DA-source pages

2 valid, 2 deliberately invalid, covering every violation type: missing-mandatory, wrong-position, too-many, and disallowed-block.

| Test page | Case | Correctly caught |
|---|---|---|
| `/de/startseite` | valid homepage | — (PASS) |
| `/de/startseite/therapiegebiete/cvrm/diabetes` | valid therapy-area | — (PASS) |
| `/fr/startseite/produkte/trixeo/uberblick` | missing mandatory block | `missing-mandatory: form` **and** `wrong-position: form must be last, found cards` |
| `/it/startseite/therapiegebiete/onkologie/lungenkrebs` | exceeds max + illegal block | `too-many: accordion exceeds max 3 (found 4)` **and** `disallowed-block: video` |

Verified with a `jsdom`-shimmed `DOMParser` in Node against the real `admin.da.live` source for these 4 pages — not just reasoned about.

### 0.4 Three real bugs found and fixed while proving this — all instructive

1. **Block detection was reading the wrong class.** `.block` is added by client-side JS at runtime (`scripts.js`'s decoration pass) — the pre-decoration source (what both the old published-HTML read and the new DA-source read actually see) has the block name as a div's *only* class. Fixed in `extractBlocks()`.
2. **`max` counts block instances, not content items.** An early test page put 4 FAQ entries inside *one* `accordion` block, expecting that to trip the max-3 rule — it didn't, because that's 1 block instance. Fixed by using 4 separate accordion blocks. Worth making explicit to the Content Strategist during Phase 0 — "max 3" reads ambiguously otherwise.
3. **Multi-column table blocks silently lose their name if the header row is missing `colspan`.** Per da-content's authoring rules, a table-form block's header row needs `colspan="N"` matching its widest content row when N > 1. Two of the four test pages were authored without it — they looked fine when read via the (lenient) publish pipeline, but the moment da.live's own editor opened and re-saved them, their `accordion`/`cards` blocks got saved as `<div class="">` — nameless, so the panel found zero blocks for a section that clearly had content. This is a real authoring pitfall the plugin can't protect against by itself (it validates block *identity*, not table *shape*) — worth a callout in whatever author-facing docs come out of Phase 0.

### 0.5 Deliberate scope cuts still open

- **Only 5 of ~9 referenced blocks have bundled insert examples** (`hero`, `cards`, `accordion`, `quote`, `video`, in `tools/governance/examples/`) — enough to prove the `sendHTML` insertion path end-to-end. The picker shows "example pending" and disables insertion for the rest (`table`, `form`, `search`). Phase 4 should source these from the org's real block library rather than hand-authoring more local fragments.
- **Path patterns and template names are illustrative**, mirroring myastrazeneca.ch's actual page types (homepage / therapy-area / product-landing) from the earlier sitemap audit — Phase 0's co-design output replaces these, it doesn't extend them.
- **Table-form fallback parsing is defensive, not primary.** `extractBlocks()` handles both div-form (what a real author's edits produce) and raw table-form (what a direct API push or bulk import produces) — but only div-form has been exercised through the *actual* da.live editor end-to-end.

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

**The fix is not a new tool bolted onto Universal Editor — it's (a) making the sitemap → template → component hierarchy an explicit, addressable data model, and (b) using that model to drive a custom-filtered block picker inside the WYSIWYG editor via a DA plugin that reads live DA source, so the guidance is never stale behind a publish cycle.** A plain document editor still cannot structurally prevent an author from typing something disallowed — see §0.1 and §6.1 for why that gap is accepted rather than solved here.

---

## 2. Target architecture — three layers, three artifacts

| Pilot doc concept | Concrete artifact | Where it lives |
|---|---|---|
| **Sitemap** — every permitted page + its template + adaptation scope (global/market/page) | `sitemap-registry.json` (new) | **DA sheet** (`content/sitemap-registry.json`, Content Strategist-editable in da.live), read live from DA source (`admin.da.live`) by the plugin — see §0.1 |
| **Template** — exactly one fixed template per sitemap entry, with mandatory items + constrained flexible zones | `template-rules.json` (new) — per-template mandatory/flexible block lists with min/max/order, one row per (template, zone, block) | **DA sheet** (`content/template-rules.json`), same editing/consumption model as above |
| **Components ("lego blocks")** — purpose-built blocks, not generic containers | `blocks/*` (existing pattern — `decorate()` + CSS per block; extend with more purpose-built blocks like Benefits, Statistics per §7.2) | Repo, already exists |

One runtime piece reads this data model — there is no second, async piece anymore (see §0.1 for why the originally-planned CI bot was dropped):

**DA Governance Plugin** — a custom panel (da.live plugin, PostMessage SDK) that replaces the native Block Library picker inside the WYSIWYG editor. It reads the current document's path, resolves it against `sitemap-registry.json`, and shows the Assembler exactly what's allowed — mandatory blocks, remaining flexible slots, and a picker filtered to only that template's approved blocks (inserted via `sendHTML`). It reads both the page and the two rule sheets from live DA source, and re-checks on focus/visibility change — so this reflects the true current state, not the last-published one, with no separate check needed after it.

**This is still soft enforcement, not a hard gate** — a real gap confirmed against DA's public plugin docs: the SDK exposes insertion actions (`sendText`, `sendHTML`, `closeLibrary`, `daFetch`, `getSelection`, `setPrompt`, `showPanel`, `setHref`, `setHash`) but no documented save/publish interception hook. An author can still type or paste a table by hand and bypass the picker entirely; nothing here can refuse that save. What changed from the original design is *when* that becomes visible (immediately, on live source, vs. after an async post-publish check) — not *whether* it can be prevented. **Do not scope future work as if this plugin can enforce anything; it can only make the truth visible faster.**

---

## 3. System diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Content Strategist + Design (O10 Phase 1)                          │
│  → jointly author sitemap-registry.json + template-rules.json       │
│    (which pages exist, which template each maps to, mandatory/      │
│     flexible zones per template, min/max/order per zone)            │
│  → edited directly as DA sheets in da.live's spreadsheet grid UI    │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │  saved to DA source — no publish needed
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  da.live WYSIWYG document editor session (no UE canvas)             │
│                                                                       │
│   Assembler opens/creates a page, edits it                          │
│        │                                                             │
│        ▼  (autosaves to DA source as they type — da.live's own      │
│            behavior, not something this plugin controls)            │
│                                                                       │
│   DA Governance Plugin panel (PostMessage SDK)                       │
│     1. reads current doc path from context.path                     │
│     2. fetches sitemap-registry.json, template-rules.json, AND      │
│        the current page — all three live from admin.da.live/source, │
│        with the SDK's own bearer token (no publish/preview needed)  │
│     3. resolves path → template id → renders: mandatory blocks /    │
│        remaining flexible slots / disallowed blocks found           │
│     4. picker filtered to only approved blocks → sendHTML()         │
│     5. re-fetches + re-renders on tab focus / visibilitychange —     │
│        no manual refresh, no polling loop                            │
│        │                                                             │
│        ▼                                                             │
│   (no structural gate below this — a plain WYSIWYG doc lets an       │
│    author type/paste any table by hand, bypassing the plugin;        │
│    this is a known, accepted gap — see §6.1. There is no separate    │
│    async check anymore; this panel IS the only validation surface.) │
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

- `pathPattern` — a regex string, matched against the DA doc path (extension and trailing slash stripped) to resolve a template, via `resolveTemplate()` in `tools/governance/rules.mjs`.
- `structureScope` / `contentScope` — the flattened form of §7.2's "global / market / page" adaptation levels, split into two plain columns instead of one nested object, per the constraint above.

### 4.2 `template-rules.json` (DA sheet — `content/template-rules.json`)

No Universal Editor filter mechanism is involved (it's not part of the live editing flow — see §1). This sheet is the **single source of truth**, read live by the plugin to build the filtered picker and the in-context "what's allowed" panel.

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

`min`/`max` are stored as strings (standard for spreadsheet cells) and cast with `Number()` in code. `tools/governance/rules.mjs`'s `rulesForTemplate()` reassembles the flat rows back into the mandatory/flexible shape at runtime.

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

**Phase 2 — DA Governance Plugin (MVP, 1 template) — done, scope widened during build**
- da.live plugin scaffold (PostMessage SDK) registered via `tools/sidekick/config.json`'s `daLibrary: true`, confirmed to actually surface in da.live's Library panel (verified live — see §0.3).
- Panel reads the current page, `sitemap-registry.json`, and `template-rules.json` **live from DA source** (`admin.da.live/source/...`), not the published site — resolves path → template → renders mandatory/flexible/disallowed status in-context, with no preview/publish step.
- Re-fetches and re-renders on tab focus / `visibilitychange` — no manual refresh, no CI, no polling loop (see §0.1).
- Filtered picker restricted to that template's approved blocks (`sendHTML` on selection) — this is the entire enforcement surface available inside the editor itself, and it now also surfaces disallowed-block warnings (a check the very first draft of this plugin didn't do).
- Ended up covering all 3 illustrative templates (homepage, therapy-area, product-landing), not just one — the per-template logic turned out not to need separate scoping to prove the UX.

**Phase 3 — originally "Validation Bot," superseded**
The original plan here was an async GitHub Action re-checking published pages as the hard gate. That's been dropped — see §0.1 for the reasoning. There is currently no hard gate; Phase 2's plugin, reading live source, is the only validation surface. If a true hard gate is wanted later (blocking an invalid save, not just displaying it), it would need a mechanism outside this plugin's SDK access — an open question, not solved by this scaffold. Do not read "Phase 3" as done in the original sense; read it as *retired*.

**Phase 4 — Scale & tie-in**
- Extend the plugin's rule set to every real template from Phase 0.
- Wire the same path→template resolution into the design-token layer (§5.3) so structural rules and visual tokens resolve from one lookup.
- Package as an Author Kit variant (Adobe's own pattern: AK Media, AK Docs, AK Gov, AK Commerce already exist as vertical flavors) — i.e. **AK OneAZ** — so the next market onboards by cloning a pre-governed starter, not by copying myastrazeneca.ch's pages.
- Revisit whether a hard gate is still wanted, and if so, scope it as its own effort rather than reviving the dropped CI bot by default.

---

## 6. Open questions / risks to resolve before committing scope

1. **No structural enforcement exists inside the editor at all, and no hard gate exists anywhere now.** An author can always type or paste a table by hand and bypass the plugin's picker entirely; there is no canvas, no drag/drop tree, nothing analogous to UE's filters to fall back on, and (per explicit direction — see §0.1) there is no longer an async post-publish bot to catch it after the fact either. **This is a real, currently-unresolved gap**, not a theoretical one: today, nothing in this system can *stop* an invalid page, only *show* it, and it only shows it to whoever happens to open that page's Governance panel. Confirm with Adobe's DA/da-live team whether any non-public save/publish interception hook exists before assuming this is acceptable long-term; if the answer is no, closing this gap needs a deliberate follow-up decision (bring back an async check in some form, accept manual review, or something else), not a default assumption that live-in-editor visibility is equivalent to enforcement.
2. **Detection accuracy — resolved for the tested cases, not exhaustively.** `extractBlocks()` in `rules.mjs` uses `DOMParser` against real DA source (not regex against published HTML, as an earlier draft did), verified against 4 real DA-source pages including a table-form fallback case. Not yet tested against markup with unusual whitespace, nested default-content divs outside of blocks, or fragments — worth a wider real-page sample before trusting this on the actual myastrazeneca.ch site. Also see §0.4 item 3 — a real authoring pitfall (missing `colspan`) surfaced during this testing that the plugin cannot itself detect.
3. **Path-pattern matching consistency — not a risk anymore, by construction.** There's only one consumer of `tools/governance/rules.mjs` now (the plugin) — the drift risk this used to describe (plugin vs. bot disagreeing) no longer applies because there's no second implementation.
4. **No CI, no scheduled sweep — coverage depends on someone opening the panel.** A page edited and never opened again in da.live (or opened by someone who never looks at the Library panel) gets no validation at all under the current design. This is the direct tradeoff of dropping the bot — worth being explicit about with whoever owns this rollout, since it changes "how do we know nothing's broken across the whole site" from "check a CI report" to "no answer, unless someone builds one."
5. **Market-level scope semantics** — `contentScope: "market"` in the sitemap registry needs a concrete definition of what a market is *allowed* to change (copy only? copy + one optional block? nothing?) — this is a Phase 0 content-strategy decision, not a technical one.

---

## 7. Success criteria (ties to O5 / §7.3 business case)

- **Time-to-publish a compliant page** drops relative to today's undocumented/tribal-knowledge baseline (needs a "before" timing measurement — not yet captured).
- **Zero net-new template variants** created outside the registry over a defined pilot window (this is the actual scalability test — a market silently forking a layout should become structurally impossible, not just discouraged). Given risk §6.1, this can currently only be measured by manual/periodic review, not by an automated gate — worth tracking as its own metric until that's resolved.
- **Time between an invalid page existing and someone noticing** — with no bot and no CI, this is now uncapped in principle (see risk §6.4). Worth measuring in practice once real authors are using this, to know whether live-in-editor visibility alone is actually sufficient or whether a periodic check needs to come back in some form.
- **New market onboarding time** (once AK OneAZ exists) measured against the current from-scratch build effort for myastrazeneca.ch.
