"use strict";

/**
 * interface/filters_tools.js — the 6 message-filter MCP tool handlers.
 *
 * Thin edge: each handler maps the raw tool-call args to a filtersService
 * method (the central validateToolArgs/coerceToolArgs in dispatch.js already
 * ran). Handlers are registered into the dispatch registry via
 * ctx.registerToolHandler(name, fn) so callTool routes filters here instead of
 * the legacy switch in api.js.
 *
 * Tool names/args/behavior are preserved exactly (matching the old legacy
 * switch arg order):
 *   listFilters(accountId)
 *   createFilter(accountId, name, enabled, type, conditions, actions, insertAtIndex)
 *   updateFilter(accountId, filterIndex, name, enabled, type, conditions, actions)
 *   deleteFilter(accountId, filterIndex)
 *   reorderFilters(accountId, fromIndex, toIndex)
 *   applyFilters(accountId, folderPath)
 *
 * The FILTERS_TOOL_DEFS below mirror the metadata for these tools. The LIVE
 * `tools` array in api.js remains the single source of truth (a structural
 * test parses api.js for the `{ name: "…" }` declarations); these defs exist so
 * a reader can see the filters surface in one place and so a future api.js can
 * assemble its array from per-domain contributions without changing the test.
 *
 * Consumes from ctx: filtersService, registerToolHandler
 * Registers onto ctx:
 *   listFilters, createFilter, updateFilter, deleteFilter, reorderFilters,
 *     applyFilters  (back-compat, so the legacy api.js destructure still finds
 *     them if referenced),
 *   FILTERS_TOOL_DEFS
 */
// Shared condition/action item schemas (identical between createFilter and
// updateFilter in api.js's `tools` array, the live source of truth).
const __FILTER_CONDITION_ITEM = {
  type: "object",
  properties: {
    attrib: { type: "string", description: "Attribute: subject, from, to, cc, toOrCc, body, date, priority, status, size, ageInDays, hasAttachment, junkStatus, tag, otherHeader" },
    op: { type: "string", description: "Operator: contains, doesntContain, is, isnt, isEmpty, beginsWith, endsWith, isGreaterThan, isLessThan, isBefore, isAfter, matches, doesntMatch" },
    value: { type: "string", description: "Value to match against" },
    booleanAnd: { type: "boolean", description: "true=AND with previous, false=OR (default: true)" },
    header: { type: "string", description: "Custom header name (only when attrib is otherHeader)" },
  },
};
const __FILTER_ACTION_ITEM = {
  type: "object",
  properties: {
    type: { type: "string", description: "Action: moveToFolder, copyToFolder, markRead, markUnread, markFlagged, addTag, changePriority, delete, stopExecution, forward, reply" },
    value: { type: "string", description: "Action parameter (folder URI for move/copy, tag name for addTag, priority for changePriority, email for forward)" },
  },
};

// Exact mirror of the filters entries in api.js's `tools` array (the live
// source of truth). Kept in sync for documentation; api.js is authoritative.
const FILTERS_TOOL_DEFS = [
  {
    name: "listFilters",
    group: "filters", crud: "read",
    title: "List Filters",
    description: "List all mail filters/rules for an account with their conditions and actions",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID from listAccounts (omit for all accounts)" },
      },
      required: [],
    },
  },
  {
    name: "createFilter",
    group: "filters", crud: "create",
    title: "Create Filter",
    description: "Create a new mail filter rule on an account",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID" },
        name: { type: "string", description: "Filter name" },
        enabled: { type: "boolean", description: "Whether filter is active (default: true)" },
        type: { type: "number", description: "Filter type bitmask (default: 17 = inbox + manual). 1=inbox, 16=manual, 32=post-plugin, 64=post-outgoing" },
        conditions: {
          type: "array",
          items: __FILTER_CONDITION_ITEM,
          description: "Array of filter conditions",
        },
        actions: {
          type: "array",
          items: __FILTER_ACTION_ITEM,
          description: "Array of actions to perform",
        },
        insertAtIndex: { type: "number", description: "Position to insert (0 = top priority, default: end of list)" },
      },
      required: ["accountId", "name", "conditions", "actions"],
    },
  },
  {
    name: "updateFilter",
    group: "filters", crud: "update",
    title: "Update Filter",
    description: "Modify an existing filter's properties, conditions, or actions",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID" },
        filterIndex: { type: "number", description: "Filter index (from listFilters)" },
        name: { type: "string", description: "New filter name (optional)" },
        enabled: { type: "boolean", description: "Enable/disable (optional)" },
        type: { type: "number", description: "New filter type bitmask (optional)" },
        conditions: {
          type: "array",
          description: "Replace all conditions (optional, same format as createFilter)",
          items: __FILTER_CONDITION_ITEM,
        },
        actions: {
          type: "array",
          description: "Replace all actions (optional, same format as createFilter)",
          items: __FILTER_ACTION_ITEM,
        },
      },
      required: ["accountId", "filterIndex"],
    },
  },
  {
    name: "deleteFilter",
    group: "filters", crud: "delete",
    title: "Delete Filter",
    description: "Delete a mail filter by index",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID" },
        filterIndex: { type: "number", description: "Filter index to delete (from listFilters)" },
      },
      required: ["accountId", "filterIndex"],
    },
  },
  {
    name: "reorderFilters",
    group: "filters", crud: "update",
    title: "Reorder Filters",
    description: "Move a filter to a different position in the execution order",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID" },
        fromIndex: { type: "number", description: "Current filter index" },
        toIndex: { type: "number", description: "Target index (0 = highest priority)" },
      },
      required: ["accountId", "fromIndex", "toIndex"],
    },
  },
  {
    name: "applyFilters",
    group: "filters", crud: "update",
    title: "Apply Filters",
    description: "Manually run all enabled filters on a folder to organize existing messages",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID (uses its filters)" },
        folderPath: { type: "string", description: "Folder URI to apply filters to (from listFolders)" },
      },
      required: ["accountId", "folderPath"],
    },
  },
];

module.exports = function register(ctx) {
  const { filtersService, registerToolHandler } = ctx;

  function listFilters(accountId) {
    return filtersService.listFilters(accountId);
  }
  function createFilter(accountId, name, enabled, type, conditions, actions, insertAtIndex) {
    return filtersService.createFilter(accountId, name, enabled, type, conditions, actions, insertAtIndex);
  }
  function updateFilter(accountId, filterIndex, name, enabled, type, conditions, actions) {
    return filtersService.updateFilter(accountId, filterIndex, name, enabled, type, conditions, actions);
  }
  function deleteFilter(accountId, filterIndex) {
    return filtersService.deleteFilter(accountId, filterIndex);
  }
  function reorderFilters(accountId, fromIndex, toIndex) {
    return filtersService.reorderFilters(accountId, fromIndex, toIndex);
  }
  function applyFilters(accountId, folderPath) {
    return filtersService.applyFilters(accountId, folderPath);
  }

  // Wire into the dispatch registry. The handler receives the raw args object;
  // we unpack it into the original positional signature so behavior matches the
  // old switch case exactly.
  registerToolHandler("listFilters", (args) => listFilters(args.accountId));
  registerToolHandler("createFilter", (args) => createFilter(args.accountId, args.name, args.enabled, args.type, args.conditions, args.actions, args.insertAtIndex));
  registerToolHandler("updateFilter", (args) => updateFilter(args.accountId, args.filterIndex, args.name, args.enabled, args.type, args.conditions, args.actions));
  registerToolHandler("deleteFilter", (args) => deleteFilter(args.accountId, args.filterIndex));
  registerToolHandler("reorderFilters", (args) => reorderFilters(args.accountId, args.fromIndex, args.toIndex));
  registerToolHandler("applyFilters", (args) => applyFilters(args.accountId, args.folderPath));

  // Back-compat: also expose the bare functions on ctx (the old api.js
  // destructured these from the domain ctx). Harmless if unused.
  Object.assign(ctx, {
    listFilters, createFilter, updateFilter, deleteFilter, reorderFilters, applyFilters,
    FILTERS_TOOL_DEFS,
  });
};
module.exports.FILTERS_TOOL_DEFS = FILTERS_TOOL_DEFS;
