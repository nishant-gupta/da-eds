import {
  normalizePath, sheetRows, resolveTemplate, rulesForTemplate, validatePage,
} from '../governance/rules.mjs'; // eslint-disable-line import/extensions

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSheet(source, name) {
  let json;
  try {
    json = JSON.parse(source);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
  if (!isRecord(json)) throw new Error(`${name} must contain a JSON object`);
  const rows = sheetRows(json);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${name} does not contain any data rows`);
  }
  return rows;
}

function parseCount(value, field, rowIndex) {
  if (typeof value === 'string' && !value.trim()) {
    throw new Error(`Template rules row ${rowIndex + 1} has an invalid ${field}`);
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Template rules row ${rowIndex + 1} has an invalid ${field}`);
  }
  return count;
}

function validateConfiguration(registryRows, rulesRows) {
  if (!Array.isArray(registryRows) || registryRows.length === 0) {
    throw new Error('Sitemap registry does not contain any data rows');
  }
  if (!Array.isArray(rulesRows) || rulesRows.length === 0) {
    throw new Error('Template rules do not contain any data rows');
  }

  registryRows.forEach((row, index) => {
    if (!isRecord(row) || typeof row.template !== 'string' || !row.template
      || typeof row.pathPattern !== 'string' || !row.pathPattern) {
      throw new Error(`Sitemap registry row ${index + 1} needs a template and pathPattern`);
    }
    try {
      // Validate patterns before resolveTemplate() uses them.
      // eslint-disable-next-line no-new
      new RegExp(row.pathPattern);
    } catch (error) {
      throw new Error(`Sitemap registry row ${index + 1} has an invalid pathPattern: ${error.message}`);
    }
  });

  rulesRows.forEach((row, index) => {
    if (!isRecord(row) || typeof row.template !== 'string' || !row.template
      || typeof row.block !== 'string' || !row.block
      || !['mandatory', 'flexible'].includes(row.zone)) {
      throw new Error(`Template rules row ${index + 1} needs a template, zone, and block`);
    }
    const min = parseCount(row.min, 'min', index);
    const max = parseCount(row.max, 'max', index);
    if (min > max) throw new Error(`Template rules row ${index + 1} has min greater than max`);
    if (row.position && !['first', 'last'].includes(row.position)) {
      throw new Error(`Template rules row ${index + 1} has an invalid position`);
    }
  });
}

export function parseGovernanceSources(registrySource, rulesSource) {
  const registryRows = parseSheet(registrySource, 'Sitemap registry');
  const rulesRows = parseSheet(rulesSource, 'Template rules');
  validateConfiguration(registryRows, rulesRows);
  return { registryRows, rulesRows };
}

export function evaluatePreflight(path, registryRows, rulesRows, blocks) {
  validateConfiguration(registryRows, rulesRows);
  if (!Array.isArray(blocks) || blocks.some((block) => typeof block !== 'string')) {
    throw new Error('Page block data could not be read');
  }

  const normalizedPath = normalizePath(path);
  const entry = resolveTemplate(normalizedPath, registryRows);
  if (!entry) {
    return { status: 'out-of-scope', path: normalizedPath, violations: [] };
  }

  const template = rulesForTemplate(entry.template, rulesRows);
  if (!template) {
    throw new Error(`No template rules are configured for "${entry.template}"`);
  }

  const {
    violations, counts, disallowed,
  } = validatePage(blocks, template);
  return {
    status: violations.length ? 'failed' : 'passed',
    path: normalizedPath,
    template: template.label,
    mandatory: template.mandatory,
    flexible: template.flexible,
    counts,
    disallowed,
    violations,
  };
}
