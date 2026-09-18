// OneAZ Governance Dashboard — a DA "app" (full-screen, launched from the
// da.live Apps list — see tools/sidekick/config.json), not a "library"
// plugin. The Governance plugin (tools/governance/governance.js) validates
// one page at a time while editing it; this app answers the site-wide
// question — crawl DA source for every page, resolve each against
// sitemap-registry.json, and validate the governed ones — using the exact
// same tools/governance/rules.mjs logic, so "governed" never means two
// different things depending on which surface you're looking at.
//
// This does NOT poll like the per-page plugin does — a full-site crawl is
// too expensive to repeat every second. It runs once on load and again on
// demand via the Rescan button.
//
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  normalizePath, sheetRows, resolveTemplate, rulesForTemplate, extractBlocks, validatePage,
} from '../governance/rules.mjs';

const DA_ADMIN = 'https://admin.da.live';
const MAX_PAGES = 1500; // safety cap on how many files the crawl will enumerate
const MAX_DEPTH = 12; // safety cap on folder recursion depth

const state = {
  sdk: null, // { context, token, actions }
  app: null,
  scanning: false,
};

function daUrl(path) {
  const { org, repo } = state.sdk.context;
  return `${DA_ADMIN}${path.replace('{org}', org).replace('{repo}', repo)}`;
}

async function daFetch(url) {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${state.sdk.token}` },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res;
}

async function fetchSource(daPath) {
  const res = await daFetch(daUrl(`/source/{org}/{repo}${daPath}`));
  return res.text();
}

async function listDir(path) {
  const res = await daFetch(daUrl(`/list/{org}/{repo}${path}`));
  return res.json();
}

// BFS over the DA content tree, collecting every .html page path
// (extensionless, matching the convention sitemap-registry.json's
// pathPattern expects). Folders that fail to list (permissions, transient
// errors) are skipped rather than aborting the whole crawl.
async function crawlPages(onProgress) {
  const { org, repo } = state.sdk.context;
  const prefix = `/${org}/${repo}`;
  const pages = [];
  const queue = [{ path: '', depth: 0 }];
  let scanned = 0;

  while (queue.length && pages.length < MAX_PAGES) {
    const { path, depth } = queue.shift();
    let entries;
    try {
      entries = await listDir(path);
    } catch {
      continue; // eslint-disable-line no-continue
    }
    scanned += 1;
    onProgress?.(scanned, pages.length);

    entries.forEach((entry) => {
      const rel = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
      if (entry.ext === 'html') {
        pages.push(rel.replace(/\.html$/, ''));
      } else if (!entry.ext && depth < MAX_DEPTH) {
        queue.push({ path: rel, depth: depth + 1 });
      }
    });
  }
  return pages;
}

function renderStats(results) {
  const governed = results.filter((r) => r.status !== 'UNGOVERNED');
  const passed = governed.filter((r) => r.status === 'PASS').length;
  const failed = governed.filter((r) => r.status === 'FAIL').length;
  const errored = governed.filter((r) => r.status === 'ERROR').length;
  return `
    <div class="dash-stats">
      <div class="dash-stat"><div class="n">${results.length}</div><div class="l">Pages scanned</div></div>
      <div class="dash-stat"><div class="n">${governed.length}</div><div class="l">Governed</div></div>
      <div class="dash-stat" style="color:#2d9d78"><div class="n">${passed}</div><div class="l">Passed</div></div>
      <div class="dash-stat" style="color:#ff0000"><div class="n">${failed}</div><div class="l">Failed</div></div>
      <div class="dash-stat" style="color:#8e8e8e"><div class="n">${errored}</div><div class="l">Errors</div></div>
    </div>`;
}

function issueText(v) {
  if (v.type === 'missing-mandatory') return `missing <strong>${v.block}</strong> (need ${v.expected}, found ${v.actual})`;
  if (v.type === 'wrong-position') return `<strong>${v.block}</strong> must be ${v.expected}, found <strong>${v.actual}</strong>`;
  if (v.type === 'too-few') return `<strong>${v.block}</strong> below min (need ${v.expected}, found ${v.actual})`;
  if (v.type === 'too-many') return `<strong>${v.block}</strong> exceeds max ${v.max} (found ${v.actual})`;
  if (v.type === 'disallowed-block') return `disallowed <strong>${v.block}</strong>`;
  return v.type;
}

function renderRow(r) {
  const { org, repo } = state.sdk.context;
  const editUrl = `https://da.live/edit#/${org}/${repo}${r.path}`;
  if (r.status === 'ERROR') {
    return `
      <tr class="row-fail">
        <td class="dash-path"><a href="${editUrl}" target="_blank">${r.path}</a></td>
        <td>${r.template || '—'}</td>
        <td><span class="dash-pill error">ERROR</span></td>
        <td class="dash-issues">${r.error}</td>
      </tr>`;
  }
  const pillClass = r.status === 'PASS' ? 'pass' : 'fail';
  const rowClass = r.status === 'PASS' ? 'row-pass' : 'row-fail';
  const issues = r.violations?.length
    ? `<ul>${r.violations.map((v) => `<li>${issueText(v)}</li>`).join('')}</ul>`
    : '—';
  return `
    <tr class="${rowClass}">
      <td class="dash-path"><a href="${editUrl}" target="_blank">${r.path}</a></td>
      <td>${r.template}</td>
      <td><span class="dash-pill ${pillClass}">${r.status}</span></td>
      <td class="dash-issues">${issues}</td>
    </tr>`;
}

function render(results) {
  const governed = results.filter((r) => r.status !== 'UNGOVERNED');
  const rows = governed.length
    ? `<table class="dash-table">
        <thead><tr><th>Path</th><th>Template</th><th>Status</th><th>Issues</th></tr></thead>
        <tbody>${governed.map(renderRow).join('')}</tbody>
      </table>`
    : '<div class="dash-empty">No governed pages found in this crawl.</div>';

  state.app.innerHTML = `
    <div class="dash-header">
      <div>
        <h1>OneAZ Governance Dashboard</h1>
        <div class="meta">${state.sdk.context.org}/${state.sdk.context.repo} · scanned ${new Date().toLocaleString()}</div>
      </div>
      <button class="dash-rescan" id="rescan-btn">Rescan</button>
    </div>
    <div class="dash-content">
      ${renderStats(results)}
      ${rows}
    </div>`;

  document.getElementById('rescan-btn').addEventListener('click', runScan);
}

function renderProgress(message) {
  state.app.innerHTML = `
    <div class="dash-header">
      <div>
        <h1>OneAZ Governance Dashboard</h1>
        <div class="meta">${state.sdk.context.org}/${state.sdk.context.repo}</div>
      </div>
      <button class="dash-rescan" disabled>Scanning…</button>
    </div>
    <div class="dash-content">
      <div class="dash-progress">${message}</div>
    </div>`;
}

async function runScan() {
  if (state.scanning) return;
  state.scanning = true;
  try {
    renderProgress('Crawling DA content…');
    const pages = await crawlPages((scanned, found) => {
      renderProgress(`Crawling DA content… ${scanned} folders scanned, ${found} pages found so far`);
    });

    renderProgress(`Loading governance rules… (${pages.length} pages found)`);
    const [registryRows, rulesRows] = await Promise.all([
      fetchSource('/sitemap-registry.json').then((s) => sheetRows(JSON.parse(s))),
      fetchSource('/template-rules.json').then((s) => sheetRows(JSON.parse(s))),
    ]);

    const results = [];
    for (let i = 0; i < pages.length; i += 1) {
      const path = normalizePath(pages[i]);
      const entry = resolveTemplate(path, registryRows);
      if (!entry) {
        results.push({ path, status: 'UNGOVERNED' });
        continue; // eslint-disable-line no-continue
      }

      renderProgress(`Validating governed pages… ${results.filter((r) => r.status !== 'UNGOVERNED').length + 1} checked (${i + 1}/${pages.length} scanned)`);

      const template = rulesForTemplate(entry.template, rulesRows);
      if (!template) {
        results.push({ path, template: entry.template, status: 'ERROR', error: `no template-rules entry for "${entry.template}"` });
        continue; // eslint-disable-line no-continue
      }

      try {
        const html = await fetchSource(`${path}.html`);
        const blocks = extractBlocks(html);
        const { violations } = validatePage(blocks, template);
        results.push({
          path, template: entry.template, status: violations.length ? 'FAIL' : 'PASS', violations,
        });
      } catch (err) {
        results.push({ path, template: entry.template, status: 'ERROR', error: err.message });
      }
    }

    render(results);
  } catch (err) {
    state.app.innerHTML = `<div class="dash-empty">Scan failed: ${err.message}</div>`;
  } finally {
    state.scanning = false;
  }
}

(async function init() {
  state.app = document.getElementById('app');
  const { context, token, actions } = await DA_SDK;
  state.sdk = { context, token, actions };
  await runScan();
}());
