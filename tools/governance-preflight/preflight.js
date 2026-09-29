// Page-level DA Prepare check for OneAZ governance. This reports the state of
// the saved DA Source page; it does not block editing, saving, or publishing.
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
// eslint-disable-next-line import/extensions
import { extractBlocks, normalizePath } from '../governance/rules.mjs';
// eslint-disable-next-line import/extensions
import { evaluatePreflight, parseGovernanceSources } from './preflight-checks.mjs';

const DA_ADMIN = 'https://admin.da.live';
const app = document.getElementById('app');
const runButton = document.createElement('button');
runButton.type = 'button';
runButton.className = 'run-check';
runButton.textContent = 'Run check again';

function showState(className, heading, message) {
  app.replaceChildren();
  const section = document.createElement('section');
  section.className = className;
  const title = document.createElement('h1');
  title.textContent = heading;
  const detail = document.createElement('p');
  detail.textContent = message;
  section.append(title, detail);
  app.append(section, runButton);
}

function sourceUrl(context, path) {
  const { org, repo } = context;
  if (!org || !repo) throw new Error('DA did not provide the active org and repository');
  return `${DA_ADMIN}/source/${encodeURIComponent(org)}/${encodeURIComponent(repo)}${path}`;
}

async function fetchSource(context, token, path) {
  if (!token) throw new Error('DA did not provide an access token');
  const response = await fetch(sourceUrl(context, path), {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${path} could not be read (${response.status})`);
  return response.text();
}

function describeViolation(violation) {
  switch (violation.type) {
    case 'missing-mandatory':
      return `${violation.block}: mandatory block is missing (expected at least ${violation.expected}, found ${violation.actual}).`;
    case 'wrong-position':
      return `${violation.block}: must be ${violation.expected} (found ${violation.actual || 'no block'} in that position).`;
    case 'too-few':
      return `${violation.block}: expected at least ${violation.expected}, found ${violation.actual}.`;
    case 'too-many':
      return `${violation.block}: maximum is ${violation.max}, found ${violation.actual}.`;
    case 'disallowed-block':
      return `${violation.block}: this block is not approved for the template.`;
    default:
      return 'An unrecognized governance rule failed.';
  }
}

function renderRuleSection(title, rules, counts, violations) {
  const section = document.createElement('section');
  section.className = 'rule-section';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const list = document.createElement('ul');
  list.className = 'rule-list';

  rules.forEach((rule) => {
    const count = counts[rule.block] || 0;
    const passed = count >= rule.min && count <= rule.max
      && !violations.some((violation) => violation.block === rule.block);
    const item = document.createElement('li');
    item.className = passed ? 'rule-pass' : 'rule-fail';
    const indicator = document.createElement('span');
    indicator.className = 'rule-indicator';
    indicator.setAttribute('aria-label', passed ? 'Pass' : 'Needs attention');
    const detail = document.createElement('span');
    const range = rule.min === rule.max ? `${rule.min}` : `${rule.min}–${rule.max}`;
    const position = rule.position ? `, ${rule.position}` : '';
    detail.textContent = `${rule.block} (needs ${range}${position}) — ${count} on page`;
    item.append(indicator, detail);
    list.append(item);
  });

  section.append(heading, list);
  return section;
}

function showReport(result) {
  app.replaceChildren();
  const section = document.createElement('section');
  const heading = document.createElement('h1');
  const detail = document.createElement('p');
  const path = document.createElement('p');
  path.className = 'page-path';
  path.textContent = result.path;
  section.append(heading, detail, path);

  if (result.status === 'passed') {
    section.className = 'result pass';
    heading.textContent = 'Governance check passed';
    detail.textContent = `${result.template} has no structural rule violations.`;
  } else if (result.status === 'out-of-scope') {
    section.className = 'result warning';
    heading.textContent = 'Page is outside OneAZ governance';
    detail.textContent = 'This path is not in the OneAZ sitemap registry. No template rules were applied.';
  } else {
    section.className = 'result fail';
    heading.textContent = 'Governance check failed';
    detail.textContent = `${result.template} has ${result.violations.length} structural violation${result.violations.length === 1 ? '' : 's'}. These are errors for this check only; they do not block saving or publishing.`;
    section.append(
      renderRuleSection('Mandatory', result.mandatory, result.counts, result.violations),
      renderRuleSection('Flexible zones', result.flexible, result.counts, result.violations),
    );
    const list = document.createElement('ul');
    list.className = 'violation-list';
    result.violations.forEach((violation) => {
      const item = document.createElement('li');
      item.textContent = describeViolation(violation);
      list.append(item);
    });
    const issuesHeading = document.createElement('h2');
    issuesHeading.textContent = 'Issues to resolve';
    section.append(issuesHeading);
    if (result.disallowed.length) {
      const disallowed = document.createElement('p');
      disallowed.className = 'disallowed';
      disallowed.textContent = `Not approved for this template: ${result.disallowed.join(', ')}.`;
      section.append(disallowed);
    }
    section.append(list);
  }

  if (result.status === 'passed') {
    section.append(
      renderRuleSection('Mandatory', result.mandatory, result.counts, result.violations),
      renderRuleSection('Flexible zones', result.flexible, result.counts, result.violations),
    );
  }

  app.replaceChildren(section, runButton);
}

async function runCheck() {
  showState('result pending', 'Running governance check', 'Reading the current page and governance sheets from DA Source…');
  runButton.disabled = true;
  try {
    const { context, token } = await DA_SDK;
    const path = context?.path;
    if (typeof path !== 'string' || !path) throw new Error('DA did not provide the active page path');
    const normalizedPath = normalizePath(path);
    if (!normalizedPath.startsWith('/')) throw new Error('DA provided an invalid active page path');
    const pagePath = normalizedPath === '/' ? '/index.html' : `${normalizedPath}.html`;
    const [registrySource, rulesSource, pageSource] = await Promise.all([
      fetchSource(context, token, '/sitemap-registry.json'),
      fetchSource(context, token, '/template-rules.json'),
      fetchSource(context, token, pagePath),
    ]);
    const { registryRows, rulesRows } = parseGovernanceSources(registrySource, rulesSource);
    showReport(evaluatePreflight(path, registryRows, rulesRows, extractBlocks(pageSource)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showState('result error', 'Governance check could not run', message);
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener('click', runCheck);
app.append(runButton);
runCheck();
