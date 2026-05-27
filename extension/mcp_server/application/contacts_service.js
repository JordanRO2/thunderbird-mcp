"use strict";

/**
 * application/contacts_service.js — contacts use-case orchestration.
 *
 * This is the body logic that used to sit inside the tool handlers in
 * domain/contacts.js, MINUS the XPCOM (now in infrastructure/contacts_adapter.js)
 * and MINUS the pure record-shaping (now in domain/entities/contact.js).
 *
 * Responsibilities: the write-guard (isContactWritesBlocked), input validation,
 * the audit-before-mutate ordering (critical for update/delete — we log the
 * OLD email before repointing it), error envelope, and calling the adapter.
 *
 * Behavior — including exact error strings and the audit ordering — is
 * preserved verbatim from the original domain/contacts.js.
 *
 * Consumes from ctx:
 *   appendComposeAudit, isContactWritesBlocked, contactsAdapter, contactEntity
 * Registers onto ctx:
 *   contactsService = { search, create, update, delete:remove }
 */
module.exports = function register(ctx) {
  const {
    appendComposeAudit, isContactWritesBlocked, contactsAdapter, contactEntity,
  } = ctx;

  const WRITES_BLOCKED_MSG = "User preference blocks contact writes via MCP. Enable 'Allow contact writes' in the extension options page if you trust this MCP client to manage your address book.";

  function search(query, maxResults) {
    const { results, truncated, limit } = contactsAdapter.search(query, maxResults);
    if (truncated) {
      return { contacts: results, hasMore: true, message: `Results limited to ${limit}. Refine your query to see more.` };
    }
    return results;
  }

  function create(email, displayName, firstName, lastName, addressBookId) {
    try {
      if (isContactWritesBlocked()) {
        return { error: WRITES_BLOCKED_MSG };
      }
      if (typeof email !== "string" || !email) {
        return { error: "email must be a non-empty string" };
      }
      appendComposeAudit({
        tool: "createContact",
        email: typeof email === "string" ? email.slice(0, 200) : null,
        addressBookId: typeof addressBookId === "string" ? addressBookId : null,
      });

      const resolved = contactsAdapter.resolveTargetBook(addressBookId);
      if (resolved.error) return resolved;

      const created = contactsAdapter.addCard(resolved.book, { email, displayName, firstName, lastName });
      return contactEntity.toCreateResult(created);
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function update(contactId, email, displayName, firstName, lastName) {
    try {
      if (isContactWritesBlocked()) {
        return { error: WRITES_BLOCKED_MSG };
      }
      if (typeof contactId !== "string" || !contactId) {
        return { error: "contactId must be a non-empty string" };
      }

      const found = contactsAdapter.findByUID(contactId);
      if (found.error) return found;
      const { card, book } = found;

      // Log the change BEFORE mutating so the audit captures the old
      // email -- crucial when an attacker repoints "Boss" at their
      // own address. Persist as much identifying detail as we can
      // without storing the full contact card.
      appendComposeAudit({
        tool: "updateContact",
        contactId,
        bookName: book.dirName,
        bookURI: book.URI,
        oldEmail: card.primaryEmail || null,
        newEmail: typeof email === "string" ? email.slice(0, 200) : null,
      });

      const updated = contactsAdapter.modifyCard(card, book, { email, displayName, firstName, lastName });
      return contactEntity.toUpdateResult(updated);
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function remove(contactId) {
    try {
      if (isContactWritesBlocked()) {
        return { error: WRITES_BLOCKED_MSG };
      }
      if (typeof contactId !== "string" || !contactId) {
        return { error: "contactId must be a non-empty string" };
      }

      const found = contactsAdapter.findByUID(contactId);
      if (found.error) return found;
      const { card, book } = found;

      appendComposeAudit({
        tool: "deleteContact",
        contactId,
        bookName: book.dirName,
        bookURI: book.URI,
        email: card.primaryEmail || null,
        displayName: card.displayName || null,
      });

      const fields = {
        displayName: card.displayName || null,
        email: card.primaryEmail || null,
      };
      contactsAdapter.deleteCard(card, book);
      return contactEntity.toDeleteResult(fields);
    } catch (e) {
      return { error: e.toString() };
    }
  }

  Object.assign(ctx, {
    contactsService: { search, create, update, delete: remove },
  });
};
