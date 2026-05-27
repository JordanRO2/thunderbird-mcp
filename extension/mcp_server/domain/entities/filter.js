"use strict";

/**
 * domain/entities/filter.js — pure filter value-objects + constant maps.
 *
 * NO XPCOM, NO MailServices. Holds the Thunderbird filter constant maps
 * (ATTRIB_MAP, OP_MAP, ACTION_MAP and their reverse lookups) and the pure
 * record-shaping helper serializeFilter, which reads property values off an
 * already-fetched nsIMsgFilter and returns a plain object.
 *
 * serializeFilter touches `filter.searchTerms` / `filter.getActionAt(...)` —
 * these are property reads on an already-fetched filter object (no
 * MailServices, no account/folder lookup, no createTerm/createAction), so it is
 * the pure record-shaping layer and lives here, exactly mirroring how
 * formatEvent/formatTask live in the calendar entity. The MUTATING builders
 * (buildTerms/buildActions) and the account/folder lookups live in
 * infrastructure/filters_adapter.js because they call services.
 *
 * Registered as a register(ctx) factory so the adapter can load it via
 * loadSubScript, but every function is pure.
 *
 * Registers onto ctx (namespaced to avoid collisions):
 *   filterEntity = { ATTRIB_MAP, ATTRIB_NAMES, OP_MAP, OP_NAMES,
 *                    ACTION_MAP, ACTION_NAMES, serializeFilter }
 */
const ATTRIB_MAP = {
  subject: 0, from: 1, body: 2, date: 3, priority: 4,
  status: 5, to: 6, cc: 7, toOrCc: 8, allAddresses: 9,
  ageInDays: 10, size: 11, tag: 12, hasAttachment: 13,
  junkStatus: 14, junkPercent: 15, otherHeader: 16,
};
const ATTRIB_NAMES = Object.fromEntries(Object.entries(ATTRIB_MAP).map(([k, v]) => [v, k]));

const OP_MAP = {
  contains: 0, doesntContain: 1, is: 2, isnt: 3, isEmpty: 4,
  isBefore: 5, isAfter: 6, isHigherThan: 7, isLowerThan: 8,
  beginsWith: 9, endsWith: 10, isInAB: 11, isntInAB: 12,
  isGreaterThan: 13, isLessThan: 14, matches: 15, doesntMatch: 16,
};
const OP_NAMES = Object.fromEntries(Object.entries(OP_MAP).map(([k, v]) => [v, k]));

const ACTION_MAP = {
  moveToFolder: 0x01, copyToFolder: 0x02, changePriority: 0x03,
  delete: 0x04, markRead: 0x05, killThread: 0x06,
  watchThread: 0x07, markFlagged: 0x08, label: 0x09,
  reply: 0x0A, forward: 0x0B, stopExecution: 0x0C,
  deleteFromServer: 0x0D, leaveOnServer: 0x0E, junkScore: 0x0F,
  fetchBody: 0x10, addTag: 0x11, deleteBody: 0x12,
  markUnread: 0x14, custom: 0x15,
};
const ACTION_NAMES = Object.fromEntries(Object.entries(ACTION_MAP).map(([k, v]) => [v, k]));

function serializeFilter(filter, index) {
  const terms = [];
  try {
    for (const term of filter.searchTerms) {
      const t = {
        attrib: ATTRIB_NAMES[term.attrib] || String(term.attrib),
        op: OP_NAMES[term.op] || String(term.op),
        booleanAnd: term.booleanAnd,
      };
      try {
        if (term.attrib === 3 || term.attrib === 10) {
          // Date or AgeInDays: try date first, then str
          try {
            const d = term.value.date;
            t.value = d ? new Date(d / 1000).toISOString() : (term.value.str || "");
          } catch { t.value = term.value.str || ""; }
        } else {
          t.value = term.value.str || "";
        }
      } catch { t.value = ""; }
      if (term.arbitraryHeader) t.header = term.arbitraryHeader;
      terms.push(t);
    }
  } catch {
    // searchTerms iteration may fail on some TB versions
    // Try indexed access via termAsString as fallback
  }

  const actions = [];
  for (let a = 0; a < filter.actionCount; a++) {
    try {
      const action = filter.getActionAt(a);
      const act = { type: ACTION_NAMES[action.type] || String(action.type) };
      if (action.type === 0x01 || action.type === 0x02) {
        act.value = action.targetFolderUri || "";
      } else if (action.type === 0x03) {
        act.value = String(action.priority);
      } else if (action.type === 0x0F) {
        act.value = String(action.junkScore);
      } else {
        try { if (action.strValue) act.value = action.strValue; } catch {}
      }
      actions.push(act);
    } catch {
      // Skip unreadable actions
    }
  }

  return {
    index,
    name: filter.filterName,
    enabled: filter.enabled,
    type: filter.filterType,
    temporary: filter.temporary,
    terms,
    actions,
  };
}

const filterEntity = {
  ATTRIB_MAP, ATTRIB_NAMES, OP_MAP, OP_NAMES, ACTION_MAP, ACTION_NAMES,
  serializeFilter,
};

// Dual export: usable both as a register(ctx) sub-script (production) and a
// plain CommonJS require() (so a future Node unit test can exercise the pure
// helpers/maps directly, matching the security_helpers.js / contact.js pattern).
module.exports = function register(ctx) {
  Object.assign(ctx, { filterEntity });
};
module.exports.filterEntity = filterEntity;
