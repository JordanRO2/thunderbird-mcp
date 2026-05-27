"use strict";

/**
 * infrastructure/filters_adapter.js — the ONLY place the filters domain touches
 * XPCOM (MailServices.accounts, nsIMsgFilterList, nsIMsgFilter, createTerm /
 * createAction / appendTerm / appendAction, and the nsIMsgFilterService).
 *
 * Pure record-shaping + the constant maps live in domain/entities/filter.js
 * (ctx.filterEntity). The application service
 * (application/filters_service.js) calls these adapter methods and never
 * touches MailServices or a raw filter object.
 *
 * The MUTATING term/action builders (buildTerms/buildActions) live here because
 * they call createTerm/createAction/appendTerm on the XPCOM filter AND consume
 * the access guard (getAccessibleFolder) + the forward/reply policy gate
 * (isFilterForwardReplyBlocked). Their security allow-list checks and exact
 * thrown-error strings are preserved verbatim from the original
 * domain/filters.js.
 *
 * Consumes from ctx:
 *   Cc, Ci, MailServices, isAccountAllowed, getAccessibleFolder,
 *   getAccessibleAccounts, isFilterForwardReplyBlocked, filterEntity
 * Registers onto ctx:
 *   filtersAdapter = {
 *     getFilterListForAccount, buildTerms, buildActions,
 *     getAccount, getAccessibleAccounts, accountServer, getServerFilterList,
 *     createFilter, getFilterAt, insertFilterAt, removeFilterAt,
 *     saveToDefaultFile, copyTerms, copyActions, resolveFilterService,
 *   }
 */
module.exports = function register(ctx) {
  const {
    Cc, Ci, MailServices,
    isAccountAllowed, getAccessibleFolder, getAccessibleAccounts,
    isFilterForwardReplyBlocked, filterEntity,
  } = ctx;
  const { ATTRIB_MAP, OP_MAP, ACTION_MAP } = filterEntity;

  function getFilterListForAccount(accountId) {
    if (!isAccountAllowed(accountId)) {
      return { error: `Account not accessible: ${accountId}` };
    }
    const account = MailServices.accounts.getAccount(accountId);
    if (!account) return { error: `Account not found: ${accountId}` };
    const server = account.incomingServer;
    if (!server) return { error: "Account has no server" };
    if (server.canHaveFilters === false) return { error: "Account does not support filters" };
    const filterList = server.getFilterList(null);
    if (!filterList) return { error: "Could not access filter list" };
    return { account, server, filterList };
  }

  function buildTerms(filter, conditions) {
    for (const cond of conditions) {
      const term = filter.createTerm();
      // SECURITY: strict allow-list. The previous `?? parseInt(...)`
      // fallback let callers pass raw nsMsgSearchAttrib enum values that
      // aren't in ATTRIB_MAP, bypassing the intended named-action set.
      if (!Object.prototype.hasOwnProperty.call(ATTRIB_MAP, cond.attrib)) {
        throw new Error(`Unknown attribute: ${cond.attrib}`);
      }
      term.attrib = ATTRIB_MAP[cond.attrib];

      if (!Object.prototype.hasOwnProperty.call(OP_MAP, cond.op)) {
        throw new Error(`Unknown operator: ${cond.op}`);
      }
      term.op = OP_MAP[cond.op];

      const value = term.value;
      value.attrib = term.attrib;
      value.str = cond.value || "";
      term.value = value;

      term.booleanAnd = cond.booleanAnd !== false;
      if (cond.header) term.arbitraryHeader = cond.header;
      filter.appendTerm(term);
    }
  }

  function buildActions(filter, actions) {
    for (const act of actions) {
      const action = filter.createAction();
      // SECURITY: strict allow-list. The previous `?? parseInt(...)`
      // fallback accepted any numeric nsMsgFilterAction value, which
      // would auto-expose new (or legacy) action types we never
      // intended to surface -- including historic "run program" flavors.
      if (!Object.prototype.hasOwnProperty.call(ACTION_MAP, act.type)) {
        throw new Error(`Unknown action type: ${act.type}`);
      }
      const typeNum = ACTION_MAP[act.type];

      // SECURITY: forward (0x0B) and reply (0x0A) filter actions run on
      // every incoming message with no UI, so an MCP caller that can
      // create one effectively installs a permanent silent-exfiltration
      // rule. Block these action types unless the user has explicitly
      // opted in via the options page. Move/copy/tag/markRead etc.
      // remain available -- this only restricts the network-egress
      // action types.
      if ((typeNum === 0x0A || typeNum === 0x0B) && isFilterForwardReplyBlocked()) {
        throw new Error(
          `Filter action '${act.type}' is blocked by user preference. ` +
          `Forward/reply filter actions run silently on every message ` +
          `and are not permitted via the MCP API by default. ` +
          `Enable them in the extension options page if needed, ` +
          `or have the user create the filter directly in Thunderbird.`
        );
      }

      action.type = typeNum;

      if (act.value) {
        if (typeNum === 0x01 || typeNum === 0x02) {
          // Move/Copy to folder -- verify target is accessible
          const targetCheck = getAccessibleFolder(act.value);
          if (targetCheck.error) throw new Error(`Filter target folder not accessible: ${act.value}`);
          action.targetFolderUri = act.value;
        } else if (typeNum === 0x03) {
          action.priority = parseInt(act.value);
        } else if (typeNum === 0x0F) {
          action.junkScore = parseInt(act.value);
        } else {
          action.strValue = act.value;
        }
      }
      filter.appendAction(action);
    }
  }

  // ── Account / filter-list primitives ──
  function getAccount(accountId) { return MailServices.accounts.getAccount(accountId); }
  function accountServer(account) { return account.incomingServer; }
  function getServerFilterList(server) { return server.getFilterList(null); }
  function createFilter(filterList, name) { return filterList.createFilter(name); }
  function getFilterAt(filterList, index) { return filterList.getFilterAt(index); }
  function insertFilterAt(filterList, index, filter) { return filterList.insertFilterAt(index, filter); }
  function removeFilterAt(filterList, index) { return filterList.removeFilterAt(index); }
  function saveToDefaultFile(filterList) { return filterList.saveToDefaultFile(); }

  // Re-export the access helper so the service stays free of access.js bindings
  // while listFilters can still enumerate accessible accounts.
  function getAccessibleAccountsList() { return Array.from(getAccessibleAccounts()); }

  /**
   * Copy existing search terms from `srcFilter` onto `destFilter`. Returns the
   * number of terms copied. Throws on a copy failure (the service translates
   * that into a "Failed to copy existing conditions" error).
   */
  function copyTerms(srcFilter, destFilter) {
    let termsCopied = 0;
    for (const term of srcFilter.searchTerms) {
      const newTerm = destFilter.createTerm();
      newTerm.attrib = term.attrib;
      newTerm.op = term.op;
      const val = newTerm.value;
      val.attrib = term.attrib;
      try { val.str = term.value.str || ""; } catch {}
      try { if (term.attrib === 3) val.date = term.value.date; } catch {}
      newTerm.value = val;
      newTerm.booleanAnd = term.booleanAnd;
      try { newTerm.beginsGrouping = term.beginsGrouping; } catch {}
      try { newTerm.endsGrouping = term.endsGrouping; } catch {}
      try { if (term.arbitraryHeader) newTerm.arbitraryHeader = term.arbitraryHeader; } catch {}
      destFilter.appendTerm(newTerm);
      termsCopied++;
    }
    return termsCopied;
  }

  /** Copy existing actions from `srcFilter` onto `destFilter`. Best-effort per action. */
  function copyActions(srcFilter, destFilter) {
    for (let a = 0; a < srcFilter.actionCount; a++) {
      try {
        const origAction = srcFilter.getActionAt(a);
        const newAction = destFilter.createAction();
        newAction.type = origAction.type;
        try { newAction.targetFolderUri = origAction.targetFolderUri; } catch {}
        try { newAction.priority = origAction.priority; } catch {}
        try { newAction.strValue = origAction.strValue; } catch {}
        try { newAction.junkScore = origAction.junkScore; } catch {}
        destFilter.appendAction(newAction);
      } catch {}
    }
  }

  /**
   * Resolve the filter service: MailServices.filters first, then the XPCOM
   * contract ID fallback. Returns the service or null.
   */
  function resolveFilterService() {
    let filterService;
    try {
      filterService = MailServices.filters;
    } catch {}
    if (!filterService) {
      try {
        filterService = Cc["@mozilla.org/messenger/filter-service;1"]
          .getService(Ci.nsIMsgFilterService);
      } catch {}
    }
    return filterService || null;
  }

  Object.assign(ctx, {
    filtersAdapter: {
      getFilterListForAccount, buildTerms, buildActions,
      getAccount, getAccessibleAccounts: getAccessibleAccountsList,
      accountServer, getServerFilterList,
      createFilter, getFilterAt, insertFilterAt, removeFilterAt,
      saveToDefaultFile, copyTerms, copyActions, resolveFilterService,
    },
  });
};
