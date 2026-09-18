// Shared, environment-agnostic OneAZ governance logic — pure functions only,
// no DOM APIs, no Node built-ins. Used by BOTH:
//   - governance.js (browser, da.live plugin — soft, in-editor guidance)
//   - validate-bot.mjs (Node, CI — hard gate, the authoritative check)
//
// This exists specifically to close the risk called out in the architecture
// doc §6.3: the plugin and the bot must resolve the same page path to the
// same template using the same rules, or they'll silently drift apart.
// One shared module, imported by both runtimes, is how that's enforced.

export function normalizePath(path) {
  return (path || '/').replace(/\.html$/, '').replace(/\/$/, '') || '/';
}

// DA sheets: the EDS render pipeline collapses a single-sheet doc to
// { total, offset, limit, data: [...] } — no ":names" wrapper survives to
// the rendered JSON, even though the DA source is authored as a multi-sheet
// envelope. Handle both shapes.
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

// Extract the ordered list of block names from rendered (pre-decoration)
// EDS HTML — works identically in the browser and in Node, since it's pure
// string scanning, not a DOM API. A block div is a direct child of a
// section div, which is itself a direct child of <main>: depth 1 (from the
// top of <main>'s content) is section divs, depth 2 is block divs — a
// block's own class list (before client-side decoration adds ".block") is
// exactly its block name as the first class token, optionally followed by
// variant classes.
export function extractBlocks(html) {
  const mainMatch = html.match(/<main[^>]*>([\s\S]*)<\/main>/i);
  if (!mainMatch) return [];
  const inner = mainMatch[1];
  const tagRe = /<(\/?)div\b([^>]*)>/gi;
  let depth = 0;
  const blocks = [];
  let m;
  while ((m = tagRe.exec(inner)) !== null) {
    const isClosing = m[1] === '/';
    if (isClosing) {
      depth -= 1;
    } else {
      depth += 1;
      if (depth === 2) {
        const classAttr = m[2].match(/class="([^"]*)"/);
        const classes = classAttr ? classAttr[1].trim().split(/\s+/) : [];
        if (classes[0]) blocks.push(classes[0]);
      }
    }
  }
  return blocks;
}

// The core check, shared by the plugin (advisory display) and the bot
// (authoritative gate): given the ordered block list actually on a page and
// a template's rules, what's wrong?
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
