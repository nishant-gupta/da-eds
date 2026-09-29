import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePreflight, parseGovernanceSources,
} from '../tools/governance-preflight/preflight-checks.mjs'; // eslint-disable-line import/extensions
import { rulesForTemplate, validatePage } from '../tools/governance/rules.mjs'; // eslint-disable-line import/extensions

const registryRows = [{
  id: 'product',
  pathPattern: '^/en/products/example$',
  template: 'product-landing',
}];

const rulesRows = [
  {
    template: 'product-landing', zone: 'mandatory', block: 'hero', position: 'first', min: '1', max: '1',
  },
  {
    template: 'product-landing', zone: 'mandatory', block: 'form', position: 'last', min: '1', max: '1',
  },
  {
    template: 'product-landing', zone: 'flexible', block: 'cards', position: '', min: '0', max: '1',
  },
  {
    template: 'product-landing', zone: 'flexible', block: 'accordion', position: '', min: '1', max: '2',
  },
];

function sheet(rows) {
  return JSON.stringify({
    data: {
      total: rows.length, offset: 0, limit: rows.length, data: rows,
    },
    ':version': 1,
    ':names': ['data'],
    ':type': 'multi-sheet',
  });
}

test('passes a compliant page using the shared template rules', () => {
  const result = evaluatePreflight(
    '/en/products/example.html',
    registryRows,
    rulesRows,
    ['hero', 'accordion', 'form'],
  );
  assert.equal(result.status, 'passed');
  assert.equal(result.template, 'Product Landing');
});

test('reports every existing structural violation as a failure', () => {
  const blocks = ['cards', 'hero', 'cards', 'video'];
  const template = rulesForTemplate('product-landing', rulesRows);
  const expected = validatePage(blocks, template).violations;
  const result = evaluatePreflight('/en/products/example', registryRows, rulesRows, blocks);

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.violations, expected);
  assert.deepEqual(result.violations.map((violation) => violation.type), [
    'wrong-position',
    'missing-mandatory',
    'wrong-position',
    'too-many',
    'too-few',
    'disallowed-block',
  ]);
});

test('warns when the current path is not registered', () => {
  const result = evaluatePreflight('/en/unregistered', registryRows, rulesRows, []);
  assert.equal(result.status, 'out-of-scope');
  assert.deepEqual(result.violations, []);
});

test('fails explicitly when the matched template has no rules', () => {
  assert.throws(
    () => evaluatePreflight('/en/products/example', registryRows, [], []),
    /Template rules do not contain any data rows|No template rules/,
  );
});

test('rejects malformed source JSON and malformed governance rows', () => {
  assert.throws(() => parseGovernanceSources('{', sheet(rulesRows)), /not valid JSON/);
  assert.throws(
    () => parseGovernanceSources(sheet([{ template: 'x', pathPattern: '[' }]), sheet(rulesRows)),
    /invalid pathPattern/,
  );
  assert.throws(
    () => parseGovernanceSources(sheet(registryRows), sheet([
      {
        template: 'x', zone: 'mandatory', block: 'hero', min: '2', max: '1',
      },
    ])),
    /min greater than max/,
  );
});
