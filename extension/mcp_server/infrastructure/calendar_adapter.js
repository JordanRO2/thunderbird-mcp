"use strict";

/**
 * infrastructure/calendar_adapter.js — the ONLY place the calendar domain
 * touches XPCOM (`cal`, CalEvent, CalTodo, the calICalendarManager, calIDateTime,
 * recurrenceInfo, and Services.wm for the review dialogs).
 *
 * Pure record-shaping / date-string transforms are delegated to
 * domain/entities/calendar.js (ctx.calendarEntity). The application service
 * (application/calendar_service.js) calls these adapter methods and never
 * touches `cal`, a CalEvent/CalTodo constructor, or a raw calIDateTime.
 *
 * Behavior is preserved verbatim from the original domain/calendar.js: the
 * date-construction sequences (all-day vs timed, DTEND-exclusive bumping), the
 * item-lookup fallbacks (getItem → scan), the two-phase recurring-event query,
 * and the dialog argument shapes are byte-for-byte the same.
 *
 * Consumes from ctx:
 *   cal, CalEvent, CalTodo, Services
 * Registers onto ctx:
 *   calendarAdapter = {
 *     available, eventsAvailable, tasksAvailable,
 *     getCalendars, findCalendar, findWritableCalendar,
 *     findWritableTaskCalendar, listCategories,
 *     newEvent, newTodo, setProp, deleteProp, cloneItem,
 *     makeAllDayDateTime, makeTimedDateTime, dateTimeFromInput,
 *     compareDateTimes, isAllDayItem,
 *     getCalendarItems, getAllEvents, getOccurrences,
 *     getTaskItems, findItemById,
 *     addItem, modifyItem, deleteItem,
 *     getMostRecentMailWindow, openEventDialog, openTodoDialog,
 *     setTaskCompletionState,
 *   }
 */
module.exports = function register(ctx) {
  const { cal, CalEvent, CalTodo, Services } = ctx;

  // ── Availability probes (mirror the original `if (!cal ...)` guards) ──
  function available() { return !!cal; }
  function eventsAvailable() { return !!(cal && CalEvent); }
  function tasksAvailable() { return !!(cal && CalTodo); }

  // ── Calendar discovery ──
  function getCalendars() { return cal.manager.getCalendars(); }
  function findCalendar(calendarId) {
    return cal.manager.getCalendars().find(c => c.id === calendarId);
  }
  function findWritableCalendar() {
    return cal.manager.getCalendars().find(c => !c.readOnly);
  }
  function findWritableTaskCalendar() {
    return cal.manager.getCalendars().find(
      c => !c.readOnly && c.getProperty("capabilities.tasks.supported") !== false
    );
  }
  function listCategories() {
    return cal.category.fromPrefs().sort((a, b) => a.localeCompare(b));
  }

  // ── Item construction / property mutation ──
  function newEvent() { return new CalEvent(); }
  function newTodo() { return new CalTodo(); }
  function setProp(item, name, value) { item.setProperty(name, value); }
  function deleteProp(item, name) { item.deleteProperty(name); }
  function cloneItem(item) { return item.clone(); }
  function isAllDayItem(dt) { return !!(dt && dt.isDate); }
  function compareDateTimes(a, b) { return a.compare(b); }

  /**
   * Build an all-day calIDateTime (isDate=true, floating tz) from raw
   * Y/M/D components.
   */
  function makeAllDayDateTime(year, month, day) {
    const dt = cal.createDateTime();
    dt.resetTo(year, month, day, 0, 0, 0, cal.dtz.floating);
    dt.isDate = true;
    return dt;
  }

  /** Build a timed calIDateTime from a JS Date in the default timezone. */
  function makeTimedDateTime(jsDate) {
    return cal.dtz.jsDateToDateTime(jsDate, cal.dtz.defaultTimezone);
  }

  /**
   * Convert a JS Date to a calIDateTime, choosing all-day vs timed based on
   * the `dateOnly` hint (the original used a YYYY-MM-DD regex on the input).
   */
  function dateTimeFromInput(jsDate, dateOnly) {
    if (dateOnly) {
      return makeAllDayDateTime(jsDate.getFullYear(), jsDate.getMonth(), jsDate.getDate());
    }
    return makeTimedDateTime(jsDate);
  }

  // ── Item queries ──
  async function getCalendarItems(calendar, rangeStart, rangeEnd) {
    const FILTER_EVENT = 1 << 3;
    if (typeof calendar.getItemsAsArray === "function") {
      return await calendar.getItemsAsArray(FILTER_EVENT, 0, rangeStart, rangeEnd);
    }
    // Fallback for older Thunderbird versions using ReadableStream
    const items = [];
    const stream = cal.iterate.streamValues(calendar.getItems(FILTER_EVENT, 0, rangeStart, rangeEnd));
    for await (const chunk of stream) {
      for (const i of chunk) items.push(i);
    }
    return items;
  }

  /** Fetch ALL events from a calendar (no date filter). Returns [] on failure. */
  async function getAllEvents(calendar) {
    const FILTER_EVENT = 1 << 3;
    let allItems = [];
    if (typeof calendar.getItemsAsArray === "function") {
      allItems = await calendar.getItemsAsArray(FILTER_EVENT, 0, null, null);
    } else {
      const stream = cal.iterate.streamValues(calendar.getItems(FILTER_EVENT, 0, null, null));
      for await (const chunk of stream) {
        for (const i of chunk) allItems.push(i);
      }
    }
    return allItems;
  }

  function getOccurrences(item, rangeStart, rangeEnd) {
    return item.recurrenceInfo.getOccurrences(rangeStart, rangeEnd, 0);
  }

  /** Fetch task items honoring a precomputed nsMsgViewFilter bitmask. */
  async function getTaskItems(calendar, itemFilter) {
    if (typeof calendar.getItemsAsArray === "function") {
      return await calendar.getItemsAsArray(itemFilter, 0, null, null);
    }
    const items = [];
    const stream = cal.iterate.streamValues(calendar.getItems(itemFilter, 0, null, null));
    for await (const chunk of stream) {
      for (const i of chunk) items.push(i);
    }
    return items;
  }

  /**
   * Find an item by id: try the direct getItem API, else scan.
   * `scanFilter`: null → scan events via getCalendarItems(null,null);
   *               number → scan tasks via getTaskItems(filter).
   */
  async function findItemById(calendar, itemId, scanFilter) {
    let item = null;
    if (typeof calendar.getItem === "function") {
      try { item = await calendar.getItem(itemId); } catch {}
    }
    if (!item) {
      let items;
      if (scanFilter === null || scanFilter === undefined) {
        items = await getCalendarItems(calendar, null, null);
      } else {
        items = await getTaskItems(calendar, scanFilter);
      }
      item = items.find(i => i.id === itemId) || null;
    }
    return item;
  }

  // ── Item persistence ──
  async function addItem(calendar, item) { return await calendar.addItem(item); }
  async function modifyItem(calendar, newItem, oldItem) { return await calendar.modifyItem(newItem, oldItem); }
  async function deleteItem(calendar, item) { return await calendar.deleteItem(item); }

  /**
   * Apply task completion state keeping STATUS, PERCENT-COMPLETE, and
   * COMPLETED consistent per iCal RFC 5545 VTODO rules.
   */
  function setTaskCompletionState(newItem, pct) {
    const clamped = Math.min(100, Math.max(0, pct));
    newItem.percentComplete = clamped;
    if (clamped === 100) {
      newItem.setProperty("STATUS", "COMPLETED");
      newItem.completedDate = cal.dtz.jsDateToDateTime(new Date(), cal.dtz.defaultTimezone);
    } else if (clamped === 0) {
      newItem.setProperty("STATUS", "NEEDS-ACTION");
      newItem.completedDate = null;
    } else {
      newItem.setProperty("STATUS", "IN-PROCESS");
      newItem.completedDate = null;
    }
  }

  // ── Review dialogs ──
  function getMostRecentMailWindow() {
    return Services.wm.getMostRecentWindow("mail:3pane");
  }

  function openEventDialog(win, event, targetCalendar) {
    const args = {
      calendarEvent: event,
      calendar: targetCalendar,
      mode: "new",
      inTab: false,
      onOk(item, calendar) {
        calendar.addItem(item);
      },
    };
    win.openDialog(
      "chrome://calendar/content/calendar-event-dialog.xhtml",
      "_blank",
      "centerscreen,chrome,titlebar,toolbar,resizable",
      args
    );
  }

  function openTodoDialog(win, targetCalendar, dueDt, todo) {
    // createTodoWithDialog clones the todo (clearing the id) before opening,
    // so all fields are pre-filled and the user can review or cancel without
    // side effects.
    win.createTodoWithDialog(targetCalendar, dueDt, null, todo);
  }

  Object.assign(ctx, {
    calendarAdapter: {
      available, eventsAvailable, tasksAvailable,
      getCalendars, findCalendar, findWritableCalendar,
      findWritableTaskCalendar, listCategories,
      newEvent, newTodo, setProp, deleteProp, cloneItem,
      makeAllDayDateTime, makeTimedDateTime, dateTimeFromInput,
      compareDateTimes, isAllDayItem,
      getCalendarItems, getAllEvents, getOccurrences,
      getTaskItems, findItemById,
      addItem, modifyItem, deleteItem,
      getMostRecentMailWindow, openEventDialog, openTodoDialog,
      setTaskCompletionState,
    },
  });
};
