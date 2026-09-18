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
// DA "apps" (launched via da.live/app/{org}/{repo}/{path}) run entirely
// from a preview.da.live sandbox origin, not from aem.live like library
// plugins do. Two things were tried and both failed for a real, confirmed
// reason, not a guess:
//   1. A relative cross-folder import (../governance/rules.mjs) 404'd —
//      the preview.da.live proxy doesn't mirror arbitrary sibling paths
//      from the project's code bus.
//   2. An absolute https://…aem.live/tools/governance/rules.mjs import
//      hit a browser CORS block — plain EDS code-bus JS files aren't
//      served with Access-Control-Allow-Origin (unlike da.live's own
//      sdk.js, which is deliberately CORS-open for exactly this reason).
// There is no reliable way for an app to import from the project's own
// code bus. The validation logic below is therefore an inlined copy of
// tools/governance/rules.mjs's normalizePath/sheetRows/resolveTemplate/
// rulesForTemplate/extractBlocks/validatePage — keep the two in sync by
// hand if the rules logic changes; blockToTableHtml isn't needed here
// since this app only reads, it never inserts.
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';

function normalizePath(path) {
  return (path || '/').replace(/\.html$/, '').replace(/\/$/, '') || '/';
}

function sheetRows(json) {
  if (Array.isArray(json.data)) return json.data;
  const sheetName = json[':names']?.[0];
  return json[sheetName]?.data || [];
}

function resolveTemplate(path, registryRows) {
  return registryRows.find((entry) => new RegExp(entry.pathPattern).test(path));
}

function templateLabel(templateId) {
  return templateId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

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

function sectionEls(doc) {
  const main = doc.querySelector('main');
  if (!main) return [];
  return Array.from(main.children).filter((el) => el.tagName === 'DIV');
}

function tableBlockName(tableEl) {
  const firstCell = tableEl.querySelector('tr td, tr th');
  if (!firstCell) return null;
  return firstCell.textContent.trim().split(/\s+/)[0]?.toLowerCase() || null;
}

function extractBlocks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = [];
  sectionEls(doc).forEach((section) => {
    Array.from(section.children).forEach((child) => {
      if (child.tagName === 'DIV' && child.classList.length > 0
        && !child.classList.contains('section-metadata') && !child.classList.contains('metadata')) {
        blocks.push(child.classList[0]);
      } else if (child.tagName === 'TABLE') {
        const name = tableBlockName(child);
        if (name) blocks.push(name);
      }
    });
  });
  return blocks;
}

function validatePage(blocks, template) {
  const counts = {};
  blocks.forEach((b) => { counts[b] = (counts[b] || 0) + 1; });

  const violations = [];

  template.mandatory.forEach((rule) => {
    const count = counts[rule.block] || 0;
    if (count < rule.min) {
      violations.push({ type: 'missing-mandatory', block: rule.block, expected: rule.min, actual: count });
    } else if (count > rule.max) {
      violations.push({ type: 'too-many', block: rule.block, max: rule.max, actual: count });
    }
    if (rule.position === 'first' && blocks[0] !== rule.block) {
      violations.push({ type: 'wrong-position', block: rule.block, expected: 'first', actual: blocks[0] || null });
    }
    if (rule.position === 'last' && blocks[blocks.length - 1] !== rule.block) {
      violations.push({ type: 'wrong-position', block: rule.block, expected: 'last', actual: blocks[blocks.length - 1] || null });
    }
  });

  template.flexible.forEach((rule) => {
    const count = counts[rule.block] || 0;
    if (count < rule.min) {
      violations.push({ type: 'too-few', block: rule.block, expected: rule.min, actual: count });
    }
    if (count > rule.max) {
      violations.push({ type: 'too-many', block: rule.block, max: rule.max, actual: count });
    }
  });

  const allowed = new Set([...template.mandatory, ...template.flexible].map((r) => r.block));
  const disallowed = [...new Set(blocks.filter((b) => !allowed.has(b)))];
  disallowed.forEach((block) => violations.push({ type: 'disallowed-block', block }));

  return { violations, counts, disallowed };
}

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
