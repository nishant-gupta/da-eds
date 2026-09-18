#!/usr/bin/env node
// OneAZ Governance Validation Bot — Phase 3 (the hard gate)
//
// The da.live plugin (governance.js) is guidance: it filters the picker and
// shows status, but nothing stops an author from typing/pasting a disallowed
// block by hand, or saving a page that's missing a mandatory block. This bot
// is the actual enforcement point — it re-fetches the PUBLISHED page HTML
// (source of truth, not what the editor last showed) and checks it against
// the same sitemap-registry.json / template-rules.json DA sheets the plugin
// reads, using the same shared rules.mjs so the two can't drift apart.
//
// Usage:
//   node tools/governance/validate-bot.mjs --base-url=<url> --paths=/a,/b,/c
//   node tools/governance/validate-bot.mjs --base-url=<url> --sitemap=/sitemap.xml
//   node tools/governance/validate-bot.mjs --base-url=<url> --paths-file=paths.txt
//
// Options:
//   --base-url         Site origin to check, e.g. https://main--da-eds--nishant-gupta.aem.live
//   --paths            Comma-separated list of page paths to check
//   --paths-file       File with one path per line
//   --sitemap          Sitemap.xml path/URL to discover pages from (relative to --base-url, or absolute)
//   --json=<file>       Write the full JSON report to this file
//   --summary=<file>    Write a markdown summary to this file (also written to
//                        $GITHUB_STEP_SUMMARY automatically if that env var is set)
//   --fail-on-violation Exit 1 if any governed page has violations (default:
//                        report-only, exit 0 — see architecture doc §5 Phase 3,
//                        "start as report-only until false-positive rate is proven low")
//
// Only pages that resolve to a sitemap-registry entry are checked — pages
// not yet in the registry are silently skipped, same as the plugin's
// "ungoverned" state. This bot does not discover pages on its own beyond
// --sitemap; it only checks what it's told to check.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  normalizePath, sheetRows, resolveTemplate, rulesForTemplate, extractBlocks, validatePage,
} from './rules.mjs';

const flags = process.argv.slice(2);
const flagValue = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);

const baseUrl = flagValue('base-url')?.replace(/\/$/, '');
const pathsArg = flagValue('paths');
const pathsFile = flagValue('paths-file');
const sitemapArg = flagValue('sitemap');
const jsonOut = flagValue('json');
const summaryOut = flagValue('summary');
const failOnViolation = flags.includes('--fail-on-violation');

if (!baseUrl) {
  console.error('Missing required --base-url=<origin>');
  process.exit(2);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

async function discoverPathsFromSitemap(sitemapUrl) {
  const url = sitemapUrl.startsWith('http') ? sitemapUrl : `${baseUrl}${sitemapUrl.startsWith('/') ? '' : '/'}${sitemapUrl}`;
  const xml = await fetchText(url);
  if (!xml) throw new Error(`Could not fetch sitemap at ${url}`);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  return locs.map((loc) => {
    try {
      return new URL(loc).pathname;
    } catch {
      return loc;
    }
  });
}

function collectPaths() {
  const paths = new Set();
  if (pathsArg) pathsArg.split(',').map((p) => p.trim()).filter(Boolean).forEach((p) => paths.add(p));
  if (pathsFile) {
    readFileSync(pathsFile, 'utf8').split('\n').map((p) => p.trim()).filter(Boolean).forEach((p) => paths.add(p));
  }
  return paths;
}

async function main() {
  const [registryJson, rulesJson] = await Promise.all([
    fetchJson(`${baseUrl}/sitemap-registry.json`),
    fetchJson(`${baseUrl}/template-rules.json`),
  ]);
  const registryRows = sheetRows(registryJson);
  const rulesRows = sheetRows(rulesJson);

  const paths = collectPaths();
  if (sitemapArg) {
    (await discoverPathsFromSitemap(sitemapArg)).forEach((p) => paths.add(p));
  }
  if (!paths.size) {
    console.error('No pages to check — pass --paths, --paths-file, or --sitemap');
    process.exit(2);
  }

  const results = [];
  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    const entry = resolveTemplate(path, registryRows);
    if (!entry) {
      results.push({ path, status: 'UNGOVERNED' });
      continue;
    }

    const template = rulesForTemplate(entry.template, rulesRows);
    if (!template) {
      results.push({ path, status: 'ERROR', template: entry.template, error: `no template-rules entry for "${entry.template}"` });
      continue;
    }

    const html = await fetchText(`${baseUrl}${path}`);
    if (html === null) {
      results.push({ path, status: 'ERROR', template: entry.template, error: 'page not reachable (not published?)' });
      continue;
    }

    const blocks = extractBlocks(html);
    const { violations, counts } = validatePage(blocks, template);
    results.push({
      path,
      template: entry.template,
      status: violations.length ? 'FAIL' : 'PASS',
      blocks,
      counts,
      violations,
    });
  }

  const governed = results.filter((r) => r.status !== 'UNGOVERNED');
  const failed = governed.filter((r) => r.status === 'FAIL');
  const errored = governed.filter((r) => r.status === 'ERROR');
  const passed = governed.filter((r) => r.status === 'PASS');

  // ─── Console output ────────────────────────────────────────────────────
  console.log(`\nOneAZ Governance Validation — ${baseUrl}`);
  console.log(`${governed.length} governed pages checked (${results.length - governed.length} ungoverned, skipped)\n`);
  for (const r of results) {
    if (r.status === 'UNGOVERNED') {
      console.log(`  · ${r.path} — ungoverned, skipped`);
      continue;
    }
    if (r.status === 'ERROR') {
      console.log(`  ✗ ${r.path} [${r.template}] — ERROR: ${r.error}`);
      continue;
    }
    const mark = r.status === 'PASS' ? '✓' : '✗';
    console.log(`  ${mark} ${r.path} [${r.template}] — ${r.status}`);
    r.violations.forEach((v) => {
      if (v.type === 'missing-mandatory') console.log(`      - missing mandatory "${v.block}" (need ${v.expected}, found ${v.actual})`);
      else if (v.type === 'wrong-position') console.log(`      - "${v.block}" must be ${v.expected} block, found "${v.actual}" there instead`);
      else if (v.type === 'too-few') console.log(`      - "${v.block}" below minimum (need ${v.expected}, found ${v.actual})`);
      else if (v.type === 'too-many') console.log(`      - "${v.block}" exceeds max ${v.max} (found ${v.actual})`);
      else if (v.type === 'disallowed-block') console.log(`      - disallowed block "${v.block}" not approved for this template`);
    });
  }
  console.log(`\n${passed.length} passed, ${failed.length} failed, ${errored.length} errored, ${results.length - governed.length} ungoverned\n`);

  // ─── Markdown summary ──────────────────────────────────────────────────
  const summaryLines = [];
  summaryLines.push('## OneAZ Governance Validation');
  summaryLines.push('');
  summaryLines.push(`**${baseUrl}** — ${passed.length} passed / ${failed.length} failed / ${errored.length} errored / ${results.length - governed.length} ungoverned`);
  summaryLines.push('');
  if (governed.length) {
    summaryLines.push('| Status | Path | Template | Issues |');
    summaryLines.push('|---|---|---|---|');
    for (const r of governed) {
      const issues = r.status === 'ERROR'
        ? r.error
        : (r.violations || []).map((v) => {
          if (v.type === 'missing-mandatory') return `missing \`${v.block}\` (need ${v.expected}, found ${v.actual})`;
          if (v.type === 'wrong-position') return `\`${v.block}\` must be ${v.expected}, found \`${v.actual}\``;
          if (v.type === 'too-few') return `\`${v.block}\` below min (need ${v.expected}, found ${v.actual})`;
          if (v.type === 'too-many') return `\`${v.block}\` exceeds max ${v.max} (found ${v.actual})`;
          if (v.type === 'disallowed-block') return `disallowed \`${v.block}\``;
          return v.type;
        }).join('; ') || '—';
      summaryLines.push(`| ${r.status} | \`${r.path}\` | ${r.template} | ${issues} |`);
    }
  } else {
    summaryLines.push('_No governed pages were checked._');
  }
  const summaryMd = summaryLines.join('\n');

  if (summaryOut) writeFileSync(summaryOut, summaryMd);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryMd}\n`, { flag: 'a' });
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ baseUrl, results }, null, 2));

  if (failOnViolation && (failed.length || errored.length)) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Validation bot failed:', err.message);
  process.exit(2);
});
