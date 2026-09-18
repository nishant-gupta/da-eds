// Shared OneAZ governance logic for the da.live plugin (governance.js).
//
// This validates against the DA SOURCE document — fetched live via the DA
// Admin Source API (admin.da.live), the same way the DA editor itself reads
// and writes — NOT the published/previewed aem.page/aem.live render. That
// means no Preview, no Publish, and no manual page/plugin refresh: the panel
// re-fetches source on focus/visibility change and reflects whatever the
// author has actually saved, immediately (see governance.js's refresh()).
//
// Browser-only (uses DOMParser) by design — there is no longer a Node-side
// consumer of this module (see oneaz-governance-architecture.md §0 for why
// the earlier CI-bot approach was dropped in favor of this live model).

export function normalizePath(path) {
  return (path || '/').replace(/\.html$/, '').replace(/\/$/, '') || '/';
}

// DA source sheets are a multi-sheet envelope:
// { <sheetName>: { total, offset, limit, data: [...] }, ":names": [...], ":type": "multi-sheet" }
// Handled defensively against a flat { data: [...] } shape too, in case a
// sheet is ever read from a rendered (published) endpoint instead of source.
export function sheetRows(json) {
  if (Array.isArray(json.data)) return json.data;
  const sheetName = json[':names']?.[0];
  return json[sheetName]?.data || [];
}

export function resolveTemplate(path, registryRows) {
  return registryRows.find((entry) => new RegExp(entry.pathPattern).test(path));
}

export function templateLabel(templateId) {
  return templateId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Reassemble the flat template-rules sheet rows back into
// { mandatory: [...], flexible: [...] } for one template id.
export function rulesForTemplate(templateId, rulesRows) {
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

// Sections are the direct <div> children of <main>.
function sectionEls(doc) {
  const main = doc.querySelector('main');
  if (!main) return [];
  return Array.from(main.children).filter((el) => el.tagName === 'DIV');
}

// Converts a canonical div-form block element (the shape stored in DA source
// and in content/library/blocks/*.html) into the table-form markup da.live's
// own ProseMirror editor actually recognizes as a "block" node.
//
// This exists because of a real bug: the governance plugin's insertBlock()
// used to send div-form library HTML straight through actions.sendHTML(),
// and it silently lost all structure — only inline text/formatting survived,
// exactly matching what happens when ProseMirror's generic schema parser
// (proseDOMParser.fromSchema(...).parse(dom), the code sendHTML triggers —
// confirmed against adobe/da-live's da-library.js) meets a div tree it has
// no parseDOM rule for. da.live's OWN native block library hits the same
// wall and works around it exactly this way — confirmed against
// adobe/da-live's helpers/index.js: getBlockTableHtml() runs on every
// library block before it's hits parseDom(), never the raw div. This is a
// faithful port of that function, not a new invention.
export function blockToTableHtml(block) {
  const classes = block.className.split(' ').filter(Boolean);
  const name = classes.shift();
  const variants = classes.length ? classes.join(', ') : null;

  const rows = [...block.children];
  const maxCols = rows.reduce((cols, row) => (
    row.children.length > cols ? row.children.length : cols), 0) || 1;

  const table = document.createElement('table');
  table.setAttribute('border', 1);

  const headerRow = document.createElement('tr');
  const th = document.createElement('td');
  th.setAttribute('colspan', maxCols);
  th.textContent = variants ? `${name} (${variants})` : name;
  headerRow.append(th);
  table.append(headerRow);

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const cells = [...row.children];
    cells.forEach((col, i) => {
      const td = document.createElement('td');
      // Pad only the last cell so the row's total width equals maxCols —
      // spanning every cell would make short rows wider than maxCols and
      // force ProseMirror to insert empty cells elsewhere to stay rectangular.
      if (cells.length < maxCols && i === cells.length - 1) {
        td.setAttribute('colspan', maxCols - i);
      }
      td.innerHTML = col.innerHTML;
      tr.append(td);
    });
    table.append(tr);
  });

  return table;
}

// A section's direct-child blocks come in two possible forms:
//   - div form: <div class="name">...</div> — what da.live's ProseMirror
//     layer saves once a real author edits/inserts through the editor.
//     Mirrors tools/plugins/personalization/experience.js's blockEls() —
//     same DA source document shape, same extraction rule.
//   - table form: <table><tr><td>Name</td></tr>...</table> — the
//     pre-normalization authoring form from da-content's rules, seen when
//     content reaches DA source via bulk import or a direct Source API push
//     rather than through the editor. The block name is the first row's
//     first cell, lowercased.
function tableBlockName(tableEl) {
  const firstCell = tableEl.querySelector('tr td, tr th');
  if (!firstCell) return null;
  return firstCell.textContent.trim().split(/\s+/)[0]?.toLowerCase() || null;
}

// Ordered list of block names (first class token = block name; later tokens
// are variants, ignored here) across every section on the page, in document
// order — needed for min/max counts and first/last position checks.
export function extractBlocks(html) {
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

// The core check: given the ordered block list actually on the page and a
// template's rules, what's wrong?
//
// Violation shapes:
//   { type: 'missing-mandatory',  block, expected, actual }
//   { type: 'wrong-position',     block, expected: 'first'|'last', actual }
//   { type: 'too-few',            block, expected, actual }   (flexible min not met)
//   { type: 'too-many',           block, max, actual }
//   { type: 'disallowed-block',   block }                     (not in this template's rules at all)
export function validatePage(blocks, template) {
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
