// tools/governance-preflight/preflight.js
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

// tools/governance-preflight/preflight-checks.mjs
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (typeof value === "string" && !value.trim()) {
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
    throw new Error("Sitemap registry does not contain any data rows");
  }
  if (!Array.isArray(rulesRows) || rulesRows.length === 0) {
    throw new Error("Template rules do not contain any data rows");
  }
  registryRows.forEach((row, index) => {
    if (!isRecord(row) || typeof row.template !== "string" || !row.template || typeof row.pathPattern !== "string" || !row.pathPattern) {
      throw new Error(`Sitemap registry row ${index + 1} needs a template and pathPattern`);
    }
    try {
      new RegExp(row.pathPattern);
    } catch (error) {
      throw new Error(`Sitemap registry row ${index + 1} has an invalid pathPattern: ${error.message}`);
    }
  });
  rulesRows.forEach((row, index) => {
    if (!isRecord(row) || typeof row.template !== "string" || !row.template || typeof row.block !== "string" || !row.block || !["mandatory", "flexible"].includes(row.zone)) {
      throw new Error(`Template rules row ${index + 1} needs a template, zone, and block`);
    }
    const min = parseCount(row.min, "min", index);
    const max = parseCount(row.max, "max", index);
    if (min > max) throw new Error(`Template rules row ${index + 1} has min greater than max`);
    if (row.position && !["first", "last"].includes(row.position)) {
      throw new Error(`Template rules row ${index + 1} has an invalid position`);
    }
  });
}
function parseGovernanceSources(registrySource, rulesSource) {
  const registryRows = parseSheet(registrySource, "Sitemap registry");
  const rulesRows = parseSheet(rulesSource, "Template rules");
  validateConfiguration(registryRows, rulesRows);
  return { registryRows, rulesRows };
}
function evaluatePreflight(path, registryRows, rulesRows, blocks) {
  validateConfiguration(registryRows, rulesRows);
  if (!Array.isArray(blocks) || blocks.some((block) => typeof block !== "string")) {
    throw new Error("Page block data could not be read");
  }
  const normalizedPath = normalizePath(path);
  const entry = resolveTemplate(normalizedPath, registryRows);
  if (!entry) {
    return { status: "out-of-scope", path: normalizedPath, violations: [] };
  }
  const template = rulesForTemplate(entry.template, rulesRows);
  if (!template) {
    throw new Error(`No template rules are configured for "${entry.template}"`);
  }
  const {
    violations,
    counts,
    disallowed
  } = validatePage(blocks, template);
  return {
    status: violations.length ? "failed" : "passed",
    path: normalizedPath,
    template: template.label,
    mandatory: template.mandatory,
    flexible: template.flexible,
    counts,
    disallowed,
    violations
  };
}

// tools/governance-preflight/preflight.js
var DA_ADMIN = "https://admin.da.live";
var app = document.getElementById("app");
var runButton = document.createElement("button");
runButton.type = "button";
runButton.className = "run-check";
runButton.textContent = "Run check again";
function showState(className, heading, message) {
  app.replaceChildren();
  const section = document.createElement("section");
  section.className = className;
  const title = document.createElement("h1");
  title.textContent = heading;
  const detail = document.createElement("p");
  detail.textContent = message;
  section.append(title, detail);
  app.append(section, runButton);
}
function sourceUrl(context, path) {
  const { org, repo } = context;
  if (!org || !repo) throw new Error("DA did not provide the active org and repository");
  return `${DA_ADMIN}/source/${encodeURIComponent(org)}/${encodeURIComponent(repo)}${path}`;
}
async function fetchSource(context, token, path) {
  if (!token) throw new Error("DA did not provide an access token");
  const response = await fetch(sourceUrl(context, path), {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`${path} could not be read (${response.status})`);
  return response.text();
}
function describeViolation(violation) {
  switch (violation.type) {
    case "missing-mandatory":
      return `${violation.block}: mandatory block is missing (expected at least ${violation.expected}, found ${violation.actual}).`;
    case "wrong-position":
      return `${violation.block}: must be ${violation.expected} (found ${violation.actual || "no block"} in that position).`;
    case "too-few":
      return `${violation.block}: expected at least ${violation.expected}, found ${violation.actual}.`;
    case "too-many":
      return `${violation.block}: maximum is ${violation.max}, found ${violation.actual}.`;
    case "disallowed-block":
      return `${violation.block}: this block is not approved for the template.`;
    default:
      return "An unrecognized governance rule failed.";
  }
}
function renderRuleSection(title, rules, counts, violations) {
  const section = document.createElement("section");
  section.className = "rule-section";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const list = document.createElement("ul");
  list.className = "rule-list";
  rules.forEach((rule) => {
    const count = counts[rule.block] || 0;
    const passed = count >= rule.min && count <= rule.max && !violations.some((violation) => violation.block === rule.block);
    const item = document.createElement("li");
    item.className = passed ? "rule-pass" : "rule-fail";
    const indicator = document.createElement("span");
    indicator.className = "rule-indicator";
    indicator.setAttribute("aria-label", passed ? "Pass" : "Needs attention");
    const detail = document.createElement("span");
    const range = rule.min === rule.max ? `${rule.min}` : `${rule.min}\u2013${rule.max}`;
    const position = rule.position ? `, ${rule.position}` : "";
    detail.textContent = `${rule.block} (needs ${range}${position}) \u2014 ${count} on page`;
    item.append(indicator, detail);
    list.append(item);
  });
  section.append(heading, list);
  return section;
}
function showReport(result) {
  app.replaceChildren();
  const section = document.createElement("section");
  const heading = document.createElement("h1");
  const detail = document.createElement("p");
  const path = document.createElement("p");
  path.className = "page-path";
  path.textContent = result.path;
  section.append(heading, detail, path);
  if (result.status === "passed") {
    section.className = "result pass";
    heading.textContent = "Governance check passed";
    detail.textContent = `${result.template} has no structural rule violations.`;
  } else if (result.status === "out-of-scope") {
    section.className = "result warning";
    heading.textContent = "Page is outside OneAZ governance";
    detail.textContent = "This path is not in the OneAZ sitemap registry. No template rules were applied.";
  } else {
    section.className = "result fail";
    heading.textContent = "Governance check failed";
    detail.textContent = `${result.template} has ${result.violations.length} structural violation${result.violations.length === 1 ? "" : "s"}. These are errors for this check only; they do not block saving or publishing.`;
    section.append(
      renderRuleSection("Mandatory", result.mandatory, result.counts, result.violations),
      renderRuleSection("Flexible zones", result.flexible, result.counts, result.violations)
    );
    const list = document.createElement("ul");
    list.className = "violation-list";
    result.violations.forEach((violation) => {
      const item = document.createElement("li");
      item.textContent = describeViolation(violation);
      list.append(item);
    });
    const issuesHeading = document.createElement("h2");
    issuesHeading.textContent = "Issues to resolve";
    section.append(issuesHeading);
    if (result.disallowed.length) {
      const disallowed = document.createElement("p");
      disallowed.className = "disallowed";
      disallowed.textContent = `Not approved for this template: ${result.disallowed.join(", ")}.`;
      section.append(disallowed);
    }
    section.append(list);
  }
  if (result.status === "passed") {
    section.append(
      renderRuleSection("Mandatory", result.mandatory, result.counts, result.violations),
      renderRuleSection("Flexible zones", result.flexible, result.counts, result.violations)
    );
  }
  app.replaceChildren(section, runButton);
}
async function runCheck() {
  showState("result pending", "Running governance check", "Reading the current page and governance sheets from DA Source\u2026");
  runButton.disabled = true;
  try {
    const { context, token } = await DA_SDK;
    const path = context?.path;
    if (typeof path !== "string" || !path) throw new Error("DA did not provide the active page path");
    const normalizedPath = normalizePath(path);
    if (!normalizedPath.startsWith("/")) throw new Error("DA provided an invalid active page path");
    const pagePath = normalizedPath === "/" ? "/index.html" : `${normalizedPath}.html`;
    const [registrySource, rulesSource, pageSource] = await Promise.all([
      fetchSource(context, token, "/sitemap-registry.json"),
      fetchSource(context, token, "/template-rules.json"),
      fetchSource(context, token, pagePath)
    ]);
    const { registryRows, rulesRows } = parseGovernanceSources(registrySource, rulesSource);
    showReport(evaluatePreflight(path, registryRows, rulesRows, extractBlocks(pageSource)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showState("result error", "Governance check could not run", message);
  } finally {
    runButton.disabled = false;
  }
}
runButton.addEventListener("click", runCheck);
app.append(runButton);
runCheck();
