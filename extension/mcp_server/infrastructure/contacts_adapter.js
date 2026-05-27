"use strict";

/**
 * infrastructure/contacts_adapter.js — the ONLY place the contacts domain
 * touches XPCOM (MailServices.ab, nsIAbCard, nsIAbDirectory).
 *
 * Pure record-shaping is delegated to domain/entities/contact.js
 * (ctx.contactEntity). The application service (application/contacts_service.js)
 * calls these adapter methods and never sees a raw card.
 *
 * Behavior is preserved verbatim from the original domain/contacts.js: the
 * search loop honors the same limit/truncation contract and reads the same
 * card fields; create/update/delete mutate the same properties in the same
 * order.
 *
 * Consumes from ctx:
 *   Cc, Ci, MailServices, MAX_SEARCH_RESULTS_CAP, DEFAULT_MAX_RESULTS,
 *   contactEntity
 * Registers onto ctx:
 *   contactsAdapter = { search, findByUID, resolveTargetBook,
 *                       addCard, modifyCard, deleteCard }
 */
module.exports = function register(ctx) {
  const {
    Cc, Ci, MailServices,
    MAX_SEARCH_RESULTS_CAP, DEFAULT_MAX_RESULTS,
    contactEntity,
  } = ctx;

  /**
   * Scan every address book for cards matching `query`. Returns
   * { results, truncated, limit } — the service decides on the
   * envelope shape. Mirrors the original searchContacts loop exactly.
   */
  function search(query, maxResults) {
    const results = [];
    const lowerQuery = query.toLowerCase();
    const requestedLimit = Number(maxResults);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), MAX_SEARCH_RESULTS_CAP)
      : DEFAULT_MAX_RESULTS;
    let truncated = false;

    for (const book of MailServices.ab.directories) {
      for (const card of book.childCards) {
        if (card.isMailList) continue;

        const fields = {
          email: card.primaryEmail,
          displayName: card.displayName,
          firstName: card.firstName,
          lastName: card.lastName,
          uid: card.UID,
          bookName: book.dirName,
          bookURI: book.URI,
        };

        if (contactEntity.matchesQuery(fields, lowerQuery)) {
          results.push(contactEntity.toSearchRecord(fields));
        }

        if (results.length >= limit) { truncated = true; break; }
      }
      if (truncated) break;
    }

    return { results, truncated, limit };
  }

  /**
   * Find a contact card by UID across all address books.
   * Returns { card, book } or { error }.
   */
  function findByUID(contactId) {
    for (const book of MailServices.ab.directories) {
      for (const card of book.childCards) {
        if (card.UID === contactId) {
          return { card, book };
        }
      }
    }
    return { error: `Contact not found: ${contactId}` };
  }

  /**
   * Resolve the target address book for a create.
   * When addressBookId is given, match it by dirPrefId/UID/URI; otherwise
   * pick the first writable book. Returns { book } or { error }.
   */
  function resolveTargetBook(addressBookId) {
    if (addressBookId) {
      for (const book of MailServices.ab.directories) {
        if (book.dirPrefId === addressBookId || book.UID === addressBookId || book.URI === addressBookId) {
          return { book };
        }
      }
      return { error: `Address book not found: ${addressBookId}` };
    }
    for (const book of MailServices.ab.directories) {
      if (!book.readOnly) {
        return { book };
      }
    }
    return { error: "No writable address book found" };
  }

  /**
   * Create a card in `book`. Returns plain fields the entity can shape.
   */
  function addCard(book, { email, displayName, firstName, lastName }) {
    const card = Cc["@mozilla.org/addressbook/cardproperty;1"]
      .createInstance(Ci.nsIAbCard);
    card.primaryEmail = email;
    if (displayName) card.displayName = displayName;
    if (firstName) card.firstName = firstName;
    if (lastName) card.lastName = lastName;

    const newCard = book.addCard(card);
    return {
      uid: newCard.UID,
      email: newCard.primaryEmail,
      displayName: newCard.displayName,
      bookName: book.dirName,
    };
  }

  /**
   * Apply the provided field changes to an existing card and persist via the
   * owning book. Only fields that are not undefined are written (preserving the
   * original updateContact semantics). Returns plain fields for the entity.
   */
  function modifyCard(card, book, { email, displayName, firstName, lastName }) {
    if (email !== undefined) card.primaryEmail = email;
    if (displayName !== undefined) card.displayName = displayName;
    if (firstName !== undefined) card.firstName = firstName;
    if (lastName !== undefined) card.lastName = lastName;

    book.modifyCard(card);
    return {
      uid: card.UID,
      email: card.primaryEmail,
      displayName: card.displayName,
      firstName: card.firstName,
      lastName: card.lastName,
    };
  }

  /**
   * Delete a card from its owning book.
   */
  function deleteCard(card, book) {
    book.deleteCards([card]);
  }

  Object.assign(ctx, {
    contactsAdapter: {
      search, findByUID, resolveTargetBook, addCard, modifyCard, deleteCard,
    },
  });
};
