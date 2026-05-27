"use strict";

/**
 * interface/contacts_tools.js — the 4 contacts MCP tool handlers.
 *
 * Thin edge: each handler maps the raw tool-call args to a contactsService
 * method (the central validateToolArgs/coerceToolArgs in dispatch.js already
 * ran). Handlers are registered into the dispatch registry via
 * ctx.registerToolHandler(name, fn) so callTool routes contacts here instead of
 * the legacy switch in api.js.
 *
 * Tool names/args/behavior are preserved exactly:
 *   searchContacts(query, maxResults)
 *   createContact(email, displayName, firstName, lastName, addressBookId)
 *   updateContact(contactId, email, displayName, firstName, lastName)
 *   deleteContact(contactId)
 *
 * The CONTACTS_TOOL_DEFS below mirror the metadata for these tools. The LIVE
 * `tools` array in api.js remains the single source of truth (a structural
 * test parses api.js for the `{ name: "…" }` declarations); these defs exist so
 * a reader can see the contacts surface in one place and so a future api.js can
 * assemble its array from per-domain contributions without changing the test.
 *
 * Consumes from ctx: contactsService, registerToolHandler
 * Registers onto ctx:
 *   searchContacts, createContact, updateContact, deleteContact  (back-compat,
 *     so the legacy api.js destructure still finds them if referenced),
 *   CONTACTS_TOOL_DEFS
 */
// Exact mirror of the contacts entries in api.js's `tools` array (the live
// source of truth). Kept in sync for documentation; api.js is authoritative.
const CONTACTS_TOOL_DEFS = [
  {
    name: "searchContacts",
    group: "contacts", crud: "read",
    title: "Search Contacts",
    description: "Search contacts across all address books by email address or name",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Email address or name to search for" },
        maxResults: { type: "number", description: "Maximum number of results to return (default 50, max 200). If truncated, response includes hasMore: true." },
      },
      required: ["query"],
    },
  },
  {
    name: "createContact",
    group: "contacts", crud: "create",
    title: "Create Contact",
    description: "Create a new contact in an address book",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Primary email address" },
        displayName: { type: "string", description: "Display name" },
        firstName: { type: "string", description: "First name" },
        lastName: { type: "string", description: "Last name" },
        addressBookId: { type: "string", description: "Address book directory ID (from searchContacts results). Defaults to the first writable address book." },
      },
      required: ["email"],
    },
  },
  {
    name: "updateContact",
    group: "contacts", crud: "update",
    title: "Update Contact",
    description: "Update an existing contact's properties",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "Contact UID (from searchContacts results)" },
        email: { type: "string", description: "New primary email address" },
        displayName: { type: "string", description: "New display name" },
        firstName: { type: "string", description: "New first name" },
        lastName: { type: "string", description: "New last name" },
      },
      required: ["contactId"],
    },
  },
  {
    name: "deleteContact",
    group: "contacts", crud: "delete",
    title: "Delete Contact",
    description: "Delete a contact from its address book",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "Contact UID (from searchContacts results)" },
      },
      required: ["contactId"],
    },
  },
];

module.exports = function register(ctx) {
  const { contactsService, registerToolHandler } = ctx;

  function searchContacts(query, maxResults) {
    return contactsService.search(query, maxResults);
  }
  function createContact(email, displayName, firstName, lastName, addressBookId) {
    return contactsService.create(email, displayName, firstName, lastName, addressBookId);
  }
  function updateContact(contactId, email, displayName, firstName, lastName) {
    return contactsService.update(contactId, email, displayName, firstName, lastName);
  }
  function deleteContact(contactId) {
    return contactsService.delete(contactId);
  }

  // Wire into the dispatch registry. The handler receives the raw args object;
  // we unpack it into the original positional signature so behavior matches the
  // old switch case exactly.
  registerToolHandler("searchContacts", (args) => searchContacts(args.query || "", args.maxResults));
  registerToolHandler("createContact", (args) => createContact(args.email, args.displayName, args.firstName, args.lastName, args.addressBookId));
  registerToolHandler("updateContact", (args) => updateContact(args.contactId, args.email, args.displayName, args.firstName, args.lastName));
  registerToolHandler("deleteContact", (args) => deleteContact(args.contactId));

  // Back-compat: also expose the bare functions on ctx (the old api.js
  // destructured these from the domain ctx). Harmless if unused.
  Object.assign(ctx, {
    searchContacts, createContact, updateContact, deleteContact,
    CONTACTS_TOOL_DEFS,
  });
};
module.exports.CONTACTS_TOOL_DEFS = CONTACTS_TOOL_DEFS;
