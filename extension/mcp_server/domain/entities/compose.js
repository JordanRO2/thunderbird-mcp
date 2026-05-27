"use strict";

/**
 * domain/entities/compose.js — pure compose value-objects + helpers.
 *
 * NO XPCOM, NO MailServices, NO DOM. These take plain strings / booleans and
 * shape them: HTML escaping, body→HTML formatting, address-header splitting and
 * de-duplication, the identity auto-cc/bcc reader (operates on already-read
 * identity flag values handed in by the adapter), and the minimal-YAML
 * frontmatter parser used by the template loader.
 *
 * The infrastructure adapter (infrastructure/compose_adapter.js) reads the raw
 * compose-window / identity / file values and hands the plain values here; the
 * application service (application/compose_service.js) decides what to do.
 *
 * Function bodies are copied byte-for-byte from the monolithic domain/compose.js
 * so runtime behavior is identical.
 *
 * Registered as a register(ctx) factory (loaded via loadSubScript) but every
 * function is pure. Dual-export so a Node unit test can require() it directly.
 *
 * Registers onto ctx (namespaced to avoid collisions):
 *   composeEntity = { escapeHtml, formatBodyHtml, splitAddressHeader,
 *                     extractAddressEmail, mergeAddressHeaders,
 *                     getIdentityAutoRecipientHeader, parseFrontmatter }
 */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Converts body text to HTML for compose fields.
 * Handles both HTML input (entity-encodes non-ASCII) and plain text.
 */
function formatBodyHtml(body, isHtml) {
  if (isHtml) {
    let text = (body || "").replace(/\n/g, '');
    text = [...text].map(c => c.codePointAt(0) > 127 ? `&#${c.codePointAt(0)};` : c).join('');
    return text;
  }
  return escapeHtml(body || "").replace(/\n/g, '<br>');
}

function splitAddressHeader(header) {
  return (header || "").match(/(?:[^,"]|"[^"]*")+/g) || [];
}

function extractAddressEmail(address) {
  return (address.match(/<([^>]+)>/)?.[1] || address.trim()).toLowerCase();
}

function mergeAddressHeaders(...headers) {
  const seen = new Set();
  const merged = [];
  for (const header of headers) {
    for (const raw of splitAddressHeader(header)) {
      const address = raw.trim();
      if (!address) continue;
      const email = extractAddressEmail(address);
      if (seen.has(email)) continue;
      seen.add(email);
      merged.push(address);
    }
  }
  return merged.join(", ");
}

/**
 * Reads the identity's auto-cc / auto-bcc recipient header. Operates purely on
 * the identity's flag/list accessors — no XPCOM beyond reading those
 * already-present properties — so it stays a pure value transform.
 */
function getIdentityAutoRecipientHeader(identity, kind) {
  if (!identity) return "";
  try {
    if (kind === "cc") {
      return identity.doCc ? (identity.doCcList || "") : "";
    }
    if (kind === "bcc") {
      return identity.doBcc ? (identity.doBccList || "") : "";
    }
  } catch {}
  return "";
}

/**
 * Parse Jekyll-style frontmatter. Accepts a minimal YAML subset:
 * `key: value` per line for strings / numbers / booleans, and
 * `key: [a, b]` for one-line arrays. Anything more elaborate
 * (multi-line arrays, nested mappings) is intentionally not
 * supported -- the format stays predictable for the LLM.
 */
function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };
  const yamlBlock = raw.slice(3, end).trim();
  let body = raw.slice(end + 4);
  if (body.startsWith("\n")) body = body.slice(1);
  const meta = Object.create(null);
  for (const line of yamlBlock.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const m = stripped.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === "true") meta[key] = true;
    else if (val === "false") meta[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(val)) meta[key] = Number(val);
    else if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      // Strip surrounding quotes if present
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return { meta, body };
}

const composeEntity = {
  escapeHtml, formatBodyHtml, splitAddressHeader, extractAddressEmail,
  mergeAddressHeaders, getIdentityAutoRecipientHeader, parseFrontmatter,
};

// Dual export: usable both as a register(ctx) sub-script (production) and a
// plain CommonJS require() (so a Node unit test can exercise the pure helpers
// directly, matching the security_helpers.js / contact.js pattern).
module.exports = function register(ctx) {
  Object.assign(ctx, { composeEntity });
};
module.exports.composeEntity = composeEntity;
