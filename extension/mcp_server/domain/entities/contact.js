"use strict";

/**
 * domain/entities/contact.js — pure contact value-objects + helpers.
 *
 * NO XPCOM, NO MailServices. These take already-read card/book field values
 * (plain data) and shape them, or answer pure predicates. The infrastructure
 * adapter reads the raw nsIAbCard/nsIAbDirectory properties and hands the
 * plain values here; the application service decides what to do with them.
 *
 * Registered as a register(ctx) factory so api.js / the adapter can load it via
 * loadSubScript, but every function is pure.
 *
 * Registers onto ctx (namespaced to avoid collisions):
 *   contactEntity = { matchesQuery, toSearchRecord, toCreateResult,
 *                     toUpdateResult, toDeleteResult }
 */
function matchesQuery(fields, lowerQuery) {
  const email = (fields.email || "").toLowerCase();
  const displayName = (fields.displayName || "").toLowerCase();
  const firstName = (fields.firstName || "").toLowerCase();
  const lastName = (fields.lastName || "").toLowerCase();
  const haystack = [email, displayName, firstName, lastName];

  // Empty query matches all (existing behavior).
  if (!lowerQuery) return true;
  // Tokenize on whitespace/commas so CardDAV "Lastname, Firstname" displayNames
  // match natural-order queries like "Firstname Lastname". A single-token query
  // (incl. emails with "." and "@") behaves identically to the old substring match.
  const tokens = lowerQuery.split(/[,\s]+/).filter(Boolean);
  if (tokens.length === 0) return false; // whitespace/comma-only query matches nothing
  return tokens.every(token => haystack.some(field => field.includes(token)));
}

/** Shape a single search hit. `fields` are plain values read off the card+book. */
function toSearchRecord(fields) {
  return {
    id: fields.uid,
    displayName: fields.displayName,
    email: fields.email,
    firstName: fields.firstName,
    lastName: fields.lastName,
    addressBook: fields.bookName,
    addressBookId: fields.bookURI,
  };
}

function toCreateResult(fields) {
  return {
    success: true,
    id: fields.uid,
    email: fields.email,
    displayName: fields.displayName,
    addressBook: fields.bookName,
  };
}

function toUpdateResult(fields) {
  return {
    success: true,
    id: fields.uid,
    email: fields.email,
    displayName: fields.displayName,
    firstName: fields.firstName,
    lastName: fields.lastName,
  };
}

function toDeleteResult(fields) {
  return {
    success: true,
    message: `Contact "${fields.displayName || fields.email}" deleted`,
  };
}

const contactEntity = {
  matchesQuery, toSearchRecord, toCreateResult, toUpdateResult, toDeleteResult,
};

// Dual export: usable both as a register(ctx) sub-script (production) and a
// plain CommonJS require() (so a future Node unit test can exercise the pure
// helpers directly, matching the security_helpers.js pattern).
module.exports = function register(ctx) {
  Object.assign(ctx, { contactEntity });
};
module.exports.contactEntity = contactEntity;
