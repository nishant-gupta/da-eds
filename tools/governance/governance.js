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
// Path resolution, rule shape, block extraction, and violation checks all
// live in ./rules.mjs — shared with validate-bot.mjs (the Phase 3 CI check)
// so the two can't silently drift onto different definitions of "valid".
//
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  normalizePath, sheetRows, resolveTemplate, rulesForTemplate, extractBlocks, validatePage,
} from './rules.mjs';

const EXAMPLES = ['hero', 'cards', 'accordion', 'quote', 'video']; // blocks with a bundled insert example

async function loadSheet(origin, name) {
  const res = await fetch(`${origin}/${name}`);
  if (!res.ok) throw new Error(`${name} not found (${res.status})`);
  return sheetRows(await res.json());
}

// Best-effort read of what's already on the page. There's no SDK call for
// "give me the current document" — the closest public signal is the last
// published/previewed render. This can lag unsaved edits; treat counts as
// advisory, not authoritative (the validation bot, not this panel, is the
// authoritative check — see architecture doc §6.1/§6.2).
async function fetchExistingBlocks(origin, path) {
  try {
    const res = await fetch(`${origin}${path}`);
    if (!res.ok) return { blocks: [], known: false };
    return { blocks: extractBlocks(await res.text()), known: true };
  } catch {
    return { blocks: [], known: false };
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

function renderDisallowed(disallowed) {
  if (!disallowed.length) return '';
  return `
    <div class="gov-section">
      <h4>⚠ Not approved for this template</h4>
      <div class="gov-error">
        Found on this page but not in any rule for this template: <strong>${disallowed.join(', ')}</strong>.
        This won't block saving here — the validation bot will flag it as a hard violation on publish.
      </div>
    </div>`;
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

  const { blocks, known } = await fetchExistingBlocks(origin, path);
  const { counts, disallowed } = validatePage(blocks, template);
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

    ${known ? renderDisallowed(disallowed) : ''}

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
