// OneAZ Governance Plugin
//
// Runs as a da.live "library" plugin (registered in tools/sidekick/config.json
// with daLibrary: true — see the "da-plugin-demo" entry for the existing
// pattern this follows). Loaded inside da.live's library iframe via the DA
// App SDK (https://da.live/nx/utils/sdk.js), which hands us
// { context, token, actions } over a postMessage channel once the parent
// editor is ready.
//
// Reads everything — the current page, sitemap-registry.json, and
// template-rules.json — from the DA Admin Source API (admin.da.live), the
// same store the da.live editor itself reads/writes, NOT the published
// aem.page/aem.live render. That means:
//   - no Preview/Publish step needed before this panel reflects reality
//   - a Content Strategist editing the rules sheet is reflected immediately,
//     not after a code deploy or a publish click
// The panel polls DA source every POLL_MS and re-renders on change (see
// refresh() below), plus an immediate refresh on tab focus/visibility change
// for lower latency when attention returns to this panel. Polling is
// necessary, not just belt-and-suspenders: this plugin's iframe is a
// different window than da.live's main editing canvas, so focus/visibility
// events on THIS iframe never fire just because the author is typing
// elsewhere on the page — confirmed by observation (the panel kept showing a
// stale block count while a second Hero block was being added in the
// canvas, with this iframe never gaining focus). The tools/plugins/
// personalization plugin (a sibling DA plugin in this org's other projects)
// gets away with focus/visibility alone because its trigger is a deliberate
// click *into* its own panel — this plugin's trigger is edits happening
// somewhere the plugin has no visibility into except by asking again.
//
// This is still guidance, not enforcement: there is no SDK hook to intercept
// or block a save in the main editor canvas (see architecture doc §6.1). An
// author can still save something invalid; this panel just makes it visible
// the moment they look at it, with no publish cycle in the way.
//
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  normalizePath, sheetRows, resolveTemplate, rulesForTemplate, extractBlocks, validatePage,
} from './rules.mjs';

const DA_ADMIN = 'https://admin.da.live';
const POLL_MS = 1000;
const EXAMPLES = ['hero', 'cards', 'accordion', 'quote', 'video']; // blocks with a bundled insert example

const state = {
  sdk: null, // { context, token, actions }
  app: null,
  lastPageSource: null,
  lastRegistrySource: null,
  lastRulesSource: null,
  hasRenderedOnce: false,
};

function daSourceUrl(daPath) {
  const { org, repo } = state.sdk.context;
  return `${DA_ADMIN}/source/${org}/${repo}${daPath}`;
}

// `no-store` so the panel never renders a cached copy that lags a just-saved
// edit — matches the personalization plugin's fetchSource().
async function fetchSource(daPath) {
  const res = await fetch(daSourceUrl(daPath), {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${state.sdk.token}` },
  });
  if (!res.ok) throw new Error(`${daPath} not found (${res.status})`);
  return res.text();
}

async function insertBlock(name) {
  const res = await fetch(`/tools/governance/examples/${name}.html`);
  if (!res.ok) return;
  const html = await res.text();
  state.sdk.actions.sendHTML(html);
}

function statusDot(current, min, max) {
  if (current < min) return 'missing';
  if (current > max) return 'too-many';
  return 'ok';
}

function renderRule(rule, count) {
  const dot = statusDot(count, rule.min, rule.max);
  const range = rule.max === rule.min ? `${rule.min}` : `${rule.min}–${rule.max}`;
  return `
    <li>
      <span class="gov-status ${dot}"></span>
      <span><strong>${rule.block}</strong> (needs ${range}) — ${count} on page</span>
    </li>`;
}

function renderPickerButton(rule, count) {
  const hasExample = EXAMPLES.includes(rule.block);
  const atMax = count >= rule.max;
  const disabled = !hasExample || atMax;
  const reason = !hasExample ? 'example pending'
    : count > rule.max ? 'over max' : atMax ? 'max reached' : `${count}/${rule.max}`;
  return `
    <button type="button" data-block="${rule.block}" ${disabled ? 'disabled' : ''}>
      ${rule.block}
      <span class="count">${reason}</span>
    </button>`;
}

function renderDisallowed(disallowed) {
  if (!disallowed.length) return '';
  return `
    <div class="gov-section">
      <h4>⚠ Not approved for this template</h4>
      <div class="gov-error">
        Found on this page but not in any rule for this template: <strong>${disallowed.join(', ')}</strong>.
      </div>
    </div>`;
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

// Rebuild the whole panel from currently-loaded source strings.
function render(registryRows, rulesRows, pageHtml, path) {
  const entry = resolveTemplate(path, registryRows);
  if (!entry) {
    state.app.innerHTML = renderUngoverned(path);
    return;
  }

  const template = rulesForTemplate(entry.template, rulesRows);
  if (!template) {
    state.app.innerHTML = renderError(`no template-rules entry for "${entry.template}"`);
    return;
  }

  const blocks = extractBlocks(pageHtml);
  const { counts, disallowed } = validatePage(blocks, template);
  const allRules = [...template.mandatory, ...template.flexible];

  state.app.innerHTML = `
    <p class="gov-template-name">${template.label}</p>

    <div class="gov-section">
      <h4>Mandatory</h4>
      <ul class="gov-rule-list">
        ${template.mandatory.map((r) => renderRule(r, counts[r.block] || 0)).join('')}
      </ul>
    </div>

    <div class="gov-section">
      <h4>Flexible zones</h4>
      <ul class="gov-rule-list">
        ${template.flexible.map((r) => renderRule(r, counts[r.block] || 0)).join('')}
      </ul>
    </div>

    ${renderDisallowed(disallowed)}

    <div class="gov-section">
      <h4>Insert an approved block</h4>
      <div class="gov-picker">
        ${allRules.map((r) => renderPickerButton(r, counts[r.block] || 0)).join('')}
      </div>
    </div>`;

  state.app.querySelectorAll('.gov-picker button').forEach((btn) => {
    btn.addEventListener('click', () => insertBlock(btn.dataset.block));
  });
}

let refreshing = false;
// Re-pull DA source (page + both rule sheets) and re-render only if something
// changed. Called on a poll interval (primary trigger — see the note above
// on why focus/visibility alone isn't enough) and immediately on tab
// focus/visibility change (for lower latency when attention returns here).
//
// A transient fetch error keeps the current view intact rather than blanking
// the panel — with a 1s poll, a single flaky request is normal, not a real
// failure, and shouldn't be disruptive. Only the very first load shows an
// error state, since there's no "current view" yet to fall back to.
async function refresh() {
  if (refreshing || !state.sdk) return;
  refreshing = true;
  try {
    const path = normalizePath(state.sdk.context.path);
    const [registrySource, rulesSource, pageSource] = await Promise.all([
      fetchSource('/sitemap-registry.json'),
      fetchSource('/template-rules.json'),
      fetchSource(`${path}.html`),
    ]);

    if (
      registrySource === state.lastRegistrySource
      && rulesSource === state.lastRulesSource
      && pageSource === state.lastPageSource
    ) {
      return; // nothing changed since the last render
    }

    state.lastRegistrySource = registrySource;
    state.lastRulesSource = rulesSource;
    state.lastPageSource = pageSource;

    render(
      sheetRows(JSON.parse(registrySource)),
      sheetRows(JSON.parse(rulesSource)),
      pageSource,
      path,
    );
    state.hasRenderedOnce = true;
  } catch (err) {
    if (!state.hasRenderedOnce) state.app.innerHTML = renderError(err.message);
    // eslint-disable-next-line no-console
    else console.error('OneAZ governance refresh failed (keeping current view):', err);
  } finally {
    refreshing = false;
  }
}

(async function init() {
  state.app = document.getElementById('app');
  const { context, token, actions } = await DA_SDK;
  state.sdk = { context, token, actions };

  await refresh();

  setInterval(refresh, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('focus', refresh);
}());
