"use strict";

/**
 * application/filters_service.js — message-filter use-case orchestration.
 *
 * This is the body logic that used to sit inside the tool handlers in
 * domain/filters.js, MINUS the XPCOM (now in
 * infrastructure/filters_adapter.js) and MINUS the constant maps + pure
 * serializeFilter (now in domain/entities/filter.js).
 *
 * Responsibilities: MCP-client coercion of array/boolean/number args, input
 * validation, index-bounds checks, the rebuild-via-remove+insert update flow,
 * the reorder index adjustment, the enabled-filter count, error envelopes, and
 * orchestrating the adapter. Behavior — including exact error strings, the
 * default filterType of 17, the abort-on-failure copy-existing-conditions
 * guard, and the moveFilterAt-avoidance reorder math — is preserved verbatim
 * from the original domain/filters.js.
 *
 * Consumes from ctx:
 *   filtersAdapter, filterEntity, isAccountAllowed, getAccessibleFolder
 * Registers onto ctx:
 *   filtersService = { listFilters, createFilter, updateFilter, deleteFilter,
 *                      reorderFilters, applyFilters }
 */
module.exports = function register(ctx) {
  const { filtersAdapter, filterEntity, isAccountAllowed, getAccessibleFolder } = ctx;
  const { serializeFilter } = filterEntity;

  function listFilters(accountId) {
    try {
      const results = [];
      let accounts;
      if (accountId) {
        if (!isAccountAllowed(accountId)) {
          return { error: `Account not accessible: ${accountId}` };
        }
        const account = filtersAdapter.getAccount(accountId);
        if (!account) return { error: `Account not found: ${accountId}` };
        accounts = [account];
      } else {
        accounts = filtersAdapter.getAccessibleAccounts();
      }

      for (const account of accounts) {
        if (!account) continue;
        try {
          const server = filtersAdapter.accountServer(account);
          if (!server || server.canHaveFilters === false) continue;

          const filterList = filtersAdapter.getServerFilterList(server);
          if (!filterList) continue;

          const filters = [];
          for (let i = 0; i < filterList.filterCount; i++) {
            try {
              filters.push(serializeFilter(filtersAdapter.getFilterAt(filterList, i), i));
            } catch {
              // Skip unreadable filters
            }
          }

          results.push({
            accountId: account.key,
            accountName: server.prettyName,
            filterCount: filterList.filterCount,
            loggingEnabled: filterList.loggingEnabled,
            filters,
          });
        } catch {
          // Skip inaccessible accounts
        }
      }

      return results;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function createFilter(accountId, name, enabled, type, conditions, actions, insertAtIndex) {
    try {
      // Coerce arrays from MCP client string serialization
      if (typeof conditions === "string") {
        try { conditions = JSON.parse(conditions); } catch { /* leave as-is */ }
      }
      if (typeof actions === "string") {
        try { actions = JSON.parse(actions); } catch { /* leave as-is */ }
      }
      if (typeof enabled === "string") enabled = enabled === "true";
      if (typeof type === "string") type = parseInt(type);
      if (typeof insertAtIndex === "string") insertAtIndex = parseInt(insertAtIndex);

      if (!Array.isArray(conditions) || conditions.length === 0) {
        return { error: "conditions must be a non-empty array" };
      }
      if (!Array.isArray(actions) || actions.length === 0) {
        return { error: "actions must be a non-empty array" };
      }

      const fl = filtersAdapter.getFilterListForAccount(accountId);
      if (fl.error) return fl;
      const { filterList } = fl;

      const filter = filtersAdapter.createFilter(filterList, name);
      filter.enabled = enabled !== false;
      filter.filterType = (Number.isFinite(type) && type > 0) ? type : 17; // inbox + manual

      filtersAdapter.buildTerms(filter, conditions);
      filtersAdapter.buildActions(filter, actions);

      const idx = (insertAtIndex != null && insertAtIndex >= 0)
        ? Math.min(insertAtIndex, filterList.filterCount)
        : filterList.filterCount;
      filtersAdapter.insertFilterAt(filterList, idx, filter);
      filtersAdapter.saveToDefaultFile(filterList);

      return {
        success: true,
        name: filter.filterName,
        index: idx,
        filterCount: filterList.filterCount,
      };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function updateFilter(accountId, filterIndex, name, enabled, type, conditions, actions) {
    try {
      // Coerce from MCP client
      if (typeof filterIndex === "string") filterIndex = parseInt(filterIndex);
      if (!Number.isInteger(filterIndex)) return { error: "filterIndex must be an integer" };
      if (typeof enabled === "string") enabled = enabled === "true";
      if (typeof type === "string") type = parseInt(type);
      if (typeof conditions === "string") {
        try { conditions = JSON.parse(conditions); } catch {
          return { error: "conditions must be a valid JSON array" };
        }
      }
      if (typeof actions === "string") {
        try { actions = JSON.parse(actions); } catch {
          return { error: "actions must be a valid JSON array" };
        }
      }

      const fl = filtersAdapter.getFilterListForAccount(accountId);
      if (fl.error) return fl;
      const { filterList } = fl;

      if (filterIndex < 0 || filterIndex >= filterList.filterCount) {
        return { error: `Invalid filter index: ${filterIndex}` };
      }

      const filter = filtersAdapter.getFilterAt(filterList, filterIndex);
      const changes = [];

      if (name !== undefined) {
        filter.filterName = name;
        changes.push("name");
      }
      if (enabled !== undefined) {
        filter.enabled = enabled;
        changes.push("enabled");
      }
      if (type !== undefined) {
        filter.filterType = type;
        changes.push("type");
      }

      const replaceConditions = Array.isArray(conditions) && conditions.length > 0;
      const replaceActions = Array.isArray(actions) && actions.length > 0;

      if (replaceConditions || replaceActions) {
        // No clearTerms/clearActions API -- rebuild filter via remove+insert
        const newFilter = filtersAdapter.createFilter(filterList, filter.filterName);
        newFilter.enabled = filter.enabled;
        newFilter.filterType = filter.filterType;

        // Build or copy conditions
        if (replaceConditions) {
          filtersAdapter.buildTerms(newFilter, conditions);
          changes.push("conditions");
        } else {
          // Copy existing terms -- abort on failure to prevent data loss
          let termsCopied = 0;
          try {
            termsCopied = filtersAdapter.copyTerms(filter, newFilter);
          } catch (e) {
            return { error: `Failed to copy existing conditions: ${e.toString()}` };
          }
          if (termsCopied === 0) {
            return { error: "Cannot update: failed to read existing filter conditions" };
          }
        }

        // Build or copy actions
        if (replaceActions) {
          filtersAdapter.buildActions(newFilter, actions);
          changes.push("actions");
        } else {
          filtersAdapter.copyActions(filter, newFilter);
        }

        filtersAdapter.removeFilterAt(filterList, filterIndex);
        filtersAdapter.insertFilterAt(filterList, filterIndex, newFilter);
      }

      filtersAdapter.saveToDefaultFile(filterList);

      return {
        success: true,
        changes,
        filter: serializeFilter(filtersAdapter.getFilterAt(filterList, filterIndex), filterIndex),
      };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function deleteFilter(accountId, filterIndex) {
    try {
      if (typeof filterIndex === "string") filterIndex = parseInt(filterIndex);
      if (!Number.isInteger(filterIndex)) return { error: "filterIndex must be an integer" };

      const fl = filtersAdapter.getFilterListForAccount(accountId);
      if (fl.error) return fl;
      const { filterList } = fl;

      if (filterIndex < 0 || filterIndex >= filterList.filterCount) {
        return { error: `Invalid filter index: ${filterIndex}` };
      }

      const filter = filtersAdapter.getFilterAt(filterList, filterIndex);
      const filterName = filter.filterName;
      filtersAdapter.removeFilterAt(filterList, filterIndex);
      filtersAdapter.saveToDefaultFile(filterList);

      return { success: true, deleted: filterName, remainingCount: filterList.filterCount };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function reorderFilters(accountId, fromIndex, toIndex) {
    try {
      if (typeof fromIndex === "string") fromIndex = parseInt(fromIndex);
      if (typeof toIndex === "string") toIndex = parseInt(toIndex);
      if (!Number.isInteger(fromIndex)) return { error: "fromIndex must be an integer" };
      if (!Number.isInteger(toIndex)) return { error: "toIndex must be an integer" };

      const fl = filtersAdapter.getFilterListForAccount(accountId);
      if (fl.error) return fl;
      const { filterList } = fl;

      if (fromIndex < 0 || fromIndex >= filterList.filterCount) {
        return { error: `Invalid source index: ${fromIndex}` };
      }
      if (toIndex < 0 || toIndex >= filterList.filterCount) {
        return { error: `Invalid target index: ${toIndex}` };
      }

      // moveFilterAt is unreliable — use remove + insert instead
      // Adjust toIndex after removal: if moving down, indices shift
      const filter = filtersAdapter.getFilterAt(filterList, fromIndex);
      filtersAdapter.removeFilterAt(filterList, fromIndex);
      const adjustedTo = (fromIndex < toIndex) ? toIndex - 1 : toIndex;
      filtersAdapter.insertFilterAt(filterList, adjustedTo, filter);
      filtersAdapter.saveToDefaultFile(filterList);

      return { success: true, name: filter.filterName, fromIndex, toIndex };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function applyFilters(accountId, folderPath) {
    try {
      const fl = filtersAdapter.getFilterListForAccount(accountId);
      if (fl.error) return fl;
      const { filterList } = fl;

      const afResult = getAccessibleFolder(folderPath);
      if (afResult.error) return afResult;
      const folder = afResult.folder;

      // Try MailServices.filters first, fall back to XPCOM contract ID
      const filterService = filtersAdapter.resolveFilterService();
      if (!filterService) {
        return { error: "Filter service not available in this Thunderbird version" };
      }
      filterService.applyFiltersToFolders(filterList, [folder], null);

      // applyFiltersToFolders is async — returns immediately
      return {
        success: true,
        message: "Filters applied (processing may take a moment)",
        folder: folderPath,
        enabledFilters: (() => {
          let count = 0;
          for (let i = 0; i < filterList.filterCount; i++) {
            if (filtersAdapter.getFilterAt(filterList, i).enabled) count++;
          }
          return count;
        })(),
      };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  Object.assign(ctx, {
    filtersService: {
      listFilters, createFilter, updateFilter, deleteFilter,
      reorderFilters, applyFilters,
    },
  });
};
