// OneAZ Governance Plugin — POC scaffold
//
// Runs as a da.live "library" plugin (registered in tools/sidekick/config.json
// with daLibrary: true — see the "da-plugin-demo" entry for the existing pattern
// this follows). Loaded inside da.live's library iframe via the DA App SDK
// (https://da.live/nx/utils/sdk.js), which hands us { context, token, actions }
// over a postMessage channel once the parent editor is ready.
//
// context = { view, org, repo, ref, path } — path is the CURRENT DOCUMENT's
// path (no extension), which is the one piece of "where am I" information the
// SDK actually exposes. There is no API to read the full document content or
// to intercept save — see the architecture doc (oneaz-governance-architecture.md
// §6.1) for why that means this plugin is guidance, not enforcement.
//
// Governance rules live in DA, not in this repo's code: sitemap-registry.json
// and template-rules.json are authored as DA sheets (content/sitemap-registry.json,
// content/template-rules.json — pushed via `aem content push`), so a Content
// Strategist can edit rows in da.live's spreadsheet UI with no code deploy.
// Once published they're served like any other EDS sheet, at the site root —
// same shape as this project's existing content/placeholders.json.
//
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';

const EXAMPLES = ['hero', 'cards', 'accordion']; // blocks with a bundled insert example

function normalizePath(path) {
  return (path || '/').replace(/\.html$/, '').replace(/\/$/, '') || '/';
}

// DA sheets are served as a multi-sheet envelope:
// { <sheetName>: { total, offset, limit, data: [ {col: val, ...}, ... ] }, :names: [...], :type: "multi-sheet" }
// Every cell value is a flat primitive (string) — nested objects aren't valid sheet cells.
async function loadSheet(origin, name) {
  const res = await fetch(`${origin}/${name}`);
  if (!res.ok) throw new Error(`${name} not found (${res.status})`);
  const json = await res.json();
  const sheetName = json[':names']?.[0] || 'data';
  return json[sheetName]?.data || [];
}

function resolveTemplate(path, registryRows) {
  return registryRows.find((entry) => new RegExp(entry.pathPattern).test(path));
}

function templateLabel(templateId) {
  return templateId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Reassemble the flat template-rules sheet rows back into
// { mandatory: [...], flexible: [...] } for one template id.
function rulesForTemplate(templateId, rulesRows) {
  const rows = rulesRows.filter((r) => r.template === templateId);
  if (!rows.length) return null;
  const toRule = (r) => ({
    block: r.block,
    position: r.position || undefined,
    min: Number(r.min),
    max: Number(r.max),
  });
  return {
    label: templateLabel(templateId),
    mandatory: rows.filter((r) => r.zone === 'mandatory').map(toRule),
    flexible: rows.filter((r) => r.zone === 'flexible').map(toRule),
  };
}

// Best-effort read of what's already on the page. There's no SDK call for
// "give me the current document" — the closest public signal is the last
// published/previewed render. This can lag unsaved edits; treat counts as
// advisory, not authoritative (the validation bot, not this panel, is the
// authoritative check — see architecture doc §6.1/§6.2).
async function fetchExistingBlockCounts(origin, path) {
  try {
    const res = await fetch(`${origin}${path}`);
    if (!res.ok) return { counts: {}, known: false };
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const counts = {};
    doc.querySelectorAll('main > div > div.block').forEach((block) => {
      const name = [...block.classList].find((c) => c !== 'block');
      if (name) counts[name] = (counts[name] || 0) + 1;
    });
    return { counts, known: true };
  } catch {
    return { counts: {}, known: false };
  }
}

function statusDot(current, min, known) {
  if (!known) return 'unknown';
  return current >= min ? 'ok' : 'missing';
}

function renderRule(rule, count, known) {
  const dot = statusDot(count, rule.min, known);
  const range = rule.max === rule.min ? `${rule.min}` : `${rule.min}–${rule.max}`;
  const seen = known ? `${count} on page` : 'unknown — open/save the page once';
  return `
    <li>
      <span class="gov-status ${dot}"></span>
      <span><strong>${rule.block}</strong> (needs ${range}) — ${seen}</span>
    </li>`;
}

function renderPickerButton(rule, count, known) {
  const hasExample = EXAMPLES.includes(rule.block);
  const atMax = known && count >= rule.max;
  const disabled = !hasExample || atMax;
  const reason = !hasExample ? 'example pending' : atMax ? 'max reached' : `${count}/${rule.max}`;
  return `
    <button type="button" data-block="${rule.block}" ${disabled ? 'disabled' : ''}>
      ${rule.block}
      <span class="count">${reason}</span>
    </button>`;
}

async function insertBlock(origin, actions, name) {
  const res = await fetch(`${origin}/tools/governance/examples/${name}.html`);
  if (!res.ok) return;
  const html = await res.text();
  actions.sendHTML(html);
}

function renderUngoverned(path) {
  return `
    <div class="gov-empty">
      <strong>${path}</strong> isn't in the OneAZ sitemap registry yet.<br>
      No template rules apply — use the standard Block Library, and flag this
      page to the Content Strategist so it gets a sitemap entry (see
      architecture doc §5, Phase 0).
    </div>`;
}

function renderError(message) {
  return `<div class="gov-error">Governance rules unavailable: ${message}</div>`;
}

(async function init() {
  const app = document.getElementById('app');
  const { context, actions } = await DA_SDK;

  const ref = context.ref || 'main';
  const origin = `https://${ref}--${context.repo}--${context.org}.aem.live`;
  const path = normalizePath(context.path);

  let registryRows;
  let rulesRows;
  try {
    [registryRows, rulesRows] = await Promise.all([
      loadSheet(origin, 'sitemap-registry.json'),
      loadSheet(origin, 'template-rules.json'),
    ]);
  } catch (err) {
    app.innerHTML = renderError(err.message);
    return;
  }

  const entry = resolveTemplate(path, registryRows);
  if (!entry) {
    app.innerHTML = renderUngoverned(path);
    return;
  }

  const template = rulesForTemplate(entry.template, rulesRows);
  if (!template) {
    app.innerHTML = renderError(`no template-rules entry for "${entry.template}"`);
    return;
  }

  const { counts, known } = await fetchExistingBlockCounts(origin, path);
  const allRules = [...template.mandatory, ...template.flexible];

  app.innerHTML = `
    <p class="gov-template-name">${template.label}</p>

    <div class="gov-section">
      <h4>Mandatory</h4>
      <ul class="gov-rule-list">
        ${template.mandatory.map((r) => renderRule(r, counts[r.block] || 0, known)).join('')}
      </ul>
    </div>

    <div class="gov-section">
      <h4>Flexible zones</h4>
      <ul class="gov-rule-list">
        ${template.flexible.map((r) => renderRule(r, counts[r.block] || 0, known)).join('')}
      </ul>
    </div>

    <div class="gov-section">
      <h4>Insert an approved block</h4>
      <div class="gov-picker">
        ${allRules.map((r) => renderPickerButton(r, counts[r.block] || 0, known)).join('')}
      </div>
    </div>`;

  app.querySelectorAll('.gov-picker button').forEach((btn) => {
    btn.addEventListener('click', () => insertBlock(origin, actions, btn.dataset.block));
  });
}());
