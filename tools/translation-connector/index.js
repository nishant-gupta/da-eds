/**
 * Local lorem-ipsum connector for testing the DA Translate flow.
 *
 * Copy this file to adobe/da-nx as:
 *   nx/blocks/loc/connectors/lorem/index.js
 *
 * Then set `translation.service.name` to `Lorem` in `/.da/translate`.
 *
 * No TMS is called. Original HTML/JSON is kept structurally; translatable
 * text is replaced with lorem ipsum prefixed by the locale code (`[de]`).
 * Swap this module for a real connector when the vendor is ready.
 */

import { addDnt, removeDnt } from '../../dnt/dnt.js';
import { convertPath } from '../../utils/utils.js';

export const dnt = { addDnt };

const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod '
  + 'tempor incididunt ut labore et dolore magna aliqua ut enim ad minim '
  + 'veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea '
  + 'commodo consequat duis aute irure dolor in reprehenderit in voluptate '
  + 'velit esse cillum dolore eu fugiat nulla pariatur excepteur sint '
  + 'occaecat cupidatat non proident sunt in culpa qui officia deserunt '
  + 'mollit anim id est laborum'
).split(' ');

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE']);
const results = [];

export async function isConnected() {
  return true;
}

export async function connect() {
  return true;
}

export async function getStatusAll() {
  // Translation is finished in sendAllLanguages.
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length || 1;
}

function toLorem(text, langCode) {
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  const inner = text.trim();
  const start = [...langCode].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const count = wordCount(inner);
  const words = Array.from({ length: count }, (_, i) => LOREM[(start + i) % LOREM.length]);
  return `${lead}[${langCode}] ${words.join(' ')}${trail}`;
}

function shouldSkipText(value) {
  if (!value || !value.trim()) return true;
  const text = value.trim();
  if (/^https?:\/\//i.test(text)) return true;
  if (/^\/[\w\-./]*$/.test(text)) return true;
  if (/^[\d.,%$#€£¥+\-]+$/.test(text)) return true;
  if (/^:[a-z0-9-]+:$/i.test(text)) return true;
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) return true;
  return false;
}

function isProtectedNode(node) {
  const el = node.parentElement;
  if (!el) return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  return Boolean(el.closest('[translate="no"], .dnt-text, .da-metadata'));
}

function translateHtml(html, langCode) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach((node) => {
    if (isProtectedNode(node) || shouldSkipText(node.nodeValue)) return;
    node.nodeValue = toLorem(node.nodeValue, langCode);
  });

  return doc.documentElement.outerHTML;
}

async function fakeTranslate(org, site, url) {
  const html = translateHtml(url.content, url.code);
  url.sourceContent = await removeDnt({ html, org, site, ext: url.ext });
  url.destination = `/${org}/${site}${url.daDestPath}`;
}

/**
 * Immediately "translates" every language from the original source
 * content and marks them complete so DA can save into lang folders.
 */
export async function sendAllLanguages({
  org,
  site,
  langs,
  langsWithUrls,
  options,
  actions,
}) {
  const { sendMessage, saveState } = actions;
  const sourceLanguage = options['source.language']?.location || '/';

  results.length = 0;

  for (const [idx, lang] of langs.entries()) {
    sendMessage({ text: `Generating lorem ipsum for ${lang.name}.` });

    const sourceUrls = langsWithUrls?.[idx]?.urls || [];
    const langUrls = sourceUrls.map((url) => {
      const converted = convertPath({
        path: url.suppliedPath,
        sourcePrefix: sourceLanguage,
        destPrefix: lang.location,
      });
      return { ...url, ...converted, code: lang.code };
    });

    await Promise.all(langUrls.map((url) => fakeTranslate(org, site, url)));

    const translated = langUrls.filter((url) => url.sourceContent).length;
    lang.translation = {
      sent: langUrls.length,
      translated,
      status: translated === langUrls.length ? 'translated' : 'error',
    };
    results.push(langUrls);
    sendMessage();
    await saveState();
  }
}

export async function saveItems({ langIndex, saveFn }) {
  const langUrls = results[langIndex] || [];
  await Promise.all(langUrls.map((url) => saveFn(url)));
  return langUrls;
}
