// tools/governance/governance.js
import DA_SDK from "https://da.live/nx/utils/sdk.js";

// tools/governance/rules.mjs
function normalizePath(path) {
  return (path || "/").replace(/\.html$/, "").replace(/\/$/, "") || "/";
}
function sheetRows(json) {
  if (Array.isArray(json.data)) return json.data;
  const sheetName = json[":names"]?.[0];
  return json[sheetName]?.data || [];
}
function resolveTemplate(path, registryRows) {
  return registryRows.find((entry) => new RegExp(entry.pathPattern).test(path));
}
function templateLabel(templateId) {
  return templateId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function rulesForTemplate(templateId, rulesRows) {
  const rows = rulesRows.filter((r) => r.template === templateId);
  if (!rows.length) return null;
  const toRule = (r) => ({
    block: r.block,
    position: r.position || void 0,
    min: Number(r.min),
    max: Number(r.max)
  });
  return {
    label: templateLabel(templateId),
    mandatory: rows.filter((r) => r.zone === "mandatory").map(toRule),
    flexible: rows.filter((r) => r.zone === "flexible").map(toRule)
  };
}
function sectionEls(doc) {
  const main = doc.querySelector("main");
  if (!main) return [];
  return Array.from(main.children).filter((el) => el.tagName === "DIV");
}
function blockToTableHtml(block) {
  const classes = block.className.split(" ").filter(Boolean);
  const name = classes.shift();
  const variants = classes.length ? classes.join(", ") : null;
  const rows = [...block.children];
  const maxCols = rows.reduce((cols, row) => row.children.length > cols ? row.children.length : cols, 0) || 1;
  const table = document.createElement("table");
  table.setAttribute("border", 1);
  const headerRow = document.createElement("tr");
  const th = document.createElement("td");
  th.setAttribute("colspan", maxCols);
  th.textContent = variants ? `${name} (${variants})` : name;
  headerRow.append(th);
  table.append(headerRow);
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const cells = [...row.children];
    cells.forEach((col, i) => {
      const td = document.createElement("td");
      if (cells.length < maxCols && i === cells.length - 1) {
        td.setAttribute("colspan", maxCols - i);
      }
      td.innerHTML = col.innerHTML;
      tr.append(td);
    });
    table.append(tr);
  });
  return table;
}
function tableBlockName(tableEl) {
  const firstCell = tableEl.querySelector("tr td, tr th");
  if (!firstCell) return null;
  return firstCell.textContent.trim().split(/\s+/)[0]?.toLowerCase() || null;
}
function extractBlocks(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = [];
  sectionEls(doc).forEach((section) => {
    Array.from(section.children).forEach((child) => {
      if (child.tagName === "DIV" && child.classList.length > 0 && !child.classList.contains("section-metadata") && !child.classList.contains("metadata")) {
        blocks.push(child.classList[0]);
      } else if (child.tagName === "TABLE") {
        const name = tableBlockName(child);
        if (name) blocks.push(name);
      }
    });
  });
  return blocks;
}
function validatePage(blocks, template) {
  const counts = {};
  blocks.forEach((b) => {
    counts[b] = (counts[b] || 0) + 1;
  });
  const violations = [];
  template.mandatory.forEach((rule) => {
    const count = counts[rule.block] || 0;
    if (count < rule.min) {
      violations.push({ type: "missing-mandatory", block: rule.block, expected: rule.min, actual: count });
    } else if (count > rule.max) {
      violations.push({ type: "too-many", block: rule.block, max: rule.max, actual: count });
    }
    if (rule.position === "first" && blocks[0] !== rule.block) {
      violations.push({ type: "wrong-position", block: rule.block, expected: "first", actual: blocks[0] || null });
    }
    if (rule.position === "last" && blocks[blocks.length - 1] !== rule.block) {
      violations.push({ type: "wrong-position", block: rule.block, expected: "last", actual: blocks[blocks.length - 1] || null });
    }
  });
  template.flexible.forEach((rule) => {
    const count = counts[rule.block] || 0;
    if (count < rule.min) {
      violations.push({ type: "too-few", block: rule.block, expected: rule.min, actual: count });
    }
    if (count > rule.max) {
      violations.push({ type: "too-many", block: rule.block, max: rule.max, actual: count });
    }
  });
  const allowed = new Set([...template.mandatory, ...template.flexible].map((r) => r.block));
  const disallowed = [...new Set(blocks.filter((b) => !allowed.has(b)))];
  disallowed.forEach((block) => violations.push({ type: "disallowed-block", block }));
  return { violations, counts, disallowed };
}

// tools/governance/governance.js
var DA_ADMIN = "https://admin.da.live";
var POLL_MS = 1e3;
var state = {
  sdk: null,
  // { context, token, actions }
  app: null,
  lastPageSource: null,
  lastRegistrySource: null,
  lastRulesSource: null,
  lastLibrarySource: null,
  hasRenderedOnce: false
};
function daSourceUrl(daPath) {
  const { org, repo } = state.sdk.context;
  return `${DA_ADMIN}/source/${org}/${repo}${daPath}`;
}
async function fetchSource(daPath) {
  const res = await fetch(daSourceUrl(daPath), {
    cache: "no-store",
    headers: { Authorization: `Bearer ${state.sdk.token}` }
  });
  if (!res.ok) throw new Error(`${daPath} not found (${res.status})`);
  return res.text();
}
function libraryBlockName(row) {
  return (row.path || "").split("/").pop();
}
async function insertBlock(name) {
  try {
    const html = await fetchSource(`/library/blocks/${name}.html`);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const blockEl = doc.querySelector(`main .${name}`);
    if (!blockEl) throw new Error(`no .${name} element found in its library example`);
    state.sdk.actions.sendHTML(blockToTableHtml(blockEl).outerHTML);
  } catch (err) {
    console.error(`OneAZ governance: could not insert "${name}" from the library`, err);
  }
}
function statusDot(current, min, max) {
  if (current < min) return "missing";
  if (current > max) return "too-many";
  return "ok";
}
function renderRule(rule, count) {
  const dot = statusDot(count, rule.min, rule.max);
  const range = rule.max === rule.min ? `${rule.min}` : `${rule.min}\u2013${rule.max}`;
  return `
    <li>
      <span class="gov-status ${dot}"></span>
      <span><strong>${rule.block}</strong> (needs ${range}) \u2014 ${count} on page</span>
    </li>`;
}
function renderPickerButton(rule, count, availableBlocks) {
  const hasExample = availableBlocks.has(rule.block);
  const atMax = count >= rule.max;
  const disabled = !hasExample || atMax;
  const reason = !hasExample ? "example pending" : count > rule.max ? "over max" : atMax ? "max reached" : `${count}/${rule.max}`;
  return `
    <button type="button" data-block="${rule.block}" ${disabled ? "disabled" : ""}>
      ${rule.block}
      <span class="count">${reason}</span>
    </button>`;
}
function renderDisallowed(disallowed) {
  if (!disallowed.length) return "";
  return `
    <div class="gov-section">
      <h4>\u26A0 Not approved for this template</h4>
      <div class="gov-error">
        Found on this page but not in any rule for this template: <strong>${disallowed.join(", ")}</strong>.
      </div>
    </div>`;
}
function renderUngoverned(path) {
  return `
    <div class="gov-summary warning">
      <h2>Page is outside OneAZ governance</h2>
      <p>No OneAZ template rules were applied.</p>
      <p class="gov-summary-path">${path}</p>
    </div>
    <div class="gov-empty">
      <strong>${path}</strong> isn't in the OneAZ sitemap registry yet.<br>
      No template rules apply \u2014 use the standard Block Library, and flag this
      page to the Content Strategist so it gets a sitemap entry (see
      architecture doc \xA75, Phase 0).
    </div>`;
}
function renderError(message) {
  return `<div class="gov-error">Governance rules unavailable: ${message}</div>`;
}
function renderSummary(path, template, violations) {
  const passed = violations.length === 0;
  const title = passed ? "Governance check passed" : "Governance check failed";
  const detail = passed ? `${template.label} has no structural rule violations.` : `${template.label} has ${violations.length} structural rule violation${violations.length === 1 ? "" : "s"}.`;
  return `
    <div class="gov-summary ${passed ? "pass" : "fail"}">
      <h2>${title}</h2>
      <p>${detail}</p>
      <p class="gov-summary-path">${path}</p>
    </div>`;
}
function render(registryRows, rulesRows, pageHtml, path, availableBlocks) {
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
  const { counts, disallowed, violations } = validatePage(blocks, template);
  const allRules = [...template.mandatory, ...template.flexible];
  state.app.innerHTML = `
    ${renderSummary(path, template, violations)}
    <p class="gov-template-name">${template.label}</p>

    <div class="gov-section">
      <h4>Mandatory</h4>
      <ul class="gov-rule-list">
        ${template.mandatory.map((r) => renderRule(r, counts[r.block] || 0)).join("")}
      </ul>
    </div>

    <div class="gov-section">
      <h4>Flexible zones</h4>
      <ul class="gov-rule-list">
        ${template.flexible.map((r) => renderRule(r, counts[r.block] || 0)).join("")}
      </ul>
    </div>

    ${renderDisallowed(disallowed)}

    <div class="gov-section">
      <h4>Insert an approved block</h4>
      <div class="gov-picker">
        ${allRules.map((r) => renderPickerButton(r, counts[r.block] || 0, availableBlocks)).join("")}
      </div>
    </div>`;
  state.app.querySelectorAll(".gov-picker button").forEach((btn) => {
    btn.addEventListener("click", () => insertBlock(btn.dataset.block));
  });
}
var refreshing = false;
async function refresh() {
  if (refreshing || !state.sdk) return;
  refreshing = true;
  try {
    const path = normalizePath(state.sdk.context.path);
    const [registrySource, rulesSource, pageSource, librarySource] = await Promise.all([
      fetchSource("/sitemap-registry.json"),
      fetchSource("/template-rules.json"),
      fetchSource(`${path}.html`),
      fetchSource("/library/blocks.json")
    ]);
    if (registrySource === state.lastRegistrySource && rulesSource === state.lastRulesSource && pageSource === state.lastPageSource && librarySource === state.lastLibrarySource) {
      return;
    }
    state.lastRegistrySource = registrySource;
    state.lastRulesSource = rulesSource;
    state.lastPageSource = pageSource;
    state.lastLibrarySource = librarySource;
    const availableBlocks = new Set(sheetRows(JSON.parse(librarySource)).map(libraryBlockName));
    render(
      sheetRows(JSON.parse(registrySource)),
      sheetRows(JSON.parse(rulesSource)),
      pageSource,
      path,
      availableBlocks
    );
    state.hasRenderedOnce = true;
  } catch (err) {
    if (!state.hasRenderedOnce) state.app.innerHTML = renderError(err.message);
    else console.error("OneAZ governance refresh failed (keeping current view):", err);
  } finally {
    refreshing = false;
  }
}
(async function init() {
  state.app = document.getElementById("app");
  const { context, token, actions } = await DA_SDK;
  state.sdk = { context, token, actions };
  await refresh();
  setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  window.addEventListener("focus", refresh);
})();
