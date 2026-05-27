"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Exercise the REAL matcher used by searchContacts. In the DDD layout the
// matching logic lives in domain/entities/contact.js (contactEntity.matchesQuery),
// consumed by infrastructure/contacts_adapter.js which calls it with a fields
// object and the lower-cased query. This wrapper mirrors that call shape.
const { contactEntity } = require("../extension/mcp_server/domain/entities/contact.js");

function matchesContactQuery(card, query) {
  const fields = {
    email: card.email,
    displayName: card.displayName,
    firstName: card.firstName,
    lastName: card.lastName,
  };
  return contactEntity.matchesQuery(fields, (query || "").toLowerCase());
}

describe("searchContacts tokenization", () => {
  const klocok = {
    displayName: "Klocok, Viliam",
    firstName: "Viliam",
    lastName: "Klocok",
    email: "viliam.klocok@gmail.com",
  };

  it("matches reporter's CardDAV displayName cases", () => {
    assert.equal(matchesContactQuery(klocok, "Klocok Viliam"), true);
    assert.equal(matchesContactQuery(klocok, "Viliam Klocok"), true);
    assert.equal(matchesContactQuery({ displayName: "Guedes, Robson" }, "Robson Guedes"), true);
    assert.equal(matchesContactQuery({ displayName: "Guedes, Robson" }, "Guedes Robson"), true);
  });

  it("preserves single-token substring matching", () => {
    assert.equal(matchesContactQuery(klocok, "Viliam"), true);
    assert.equal(matchesContactQuery(klocok, "Klocok"), true);
    assert.equal(matchesContactQuery(klocok, "viliam.klocok@gmail.com"), true);
  });

  it("splits comma-included queries into AND tokens", () => {
    assert.equal(matchesContactQuery(klocok, "Klocok, Viliam"), true);
  });

  it("requires every token to appear somewhere", () => {
    const smith = { displayName: "Smith, John", firstName: "John", lastName: "Smith" };

    assert.equal(matchesContactQuery(smith, "John Doe"), false);
  });

  it("handles empty and failed queries", () => {
    assert.equal(matchesContactQuery({}, ""), true);
    assert.equal(matchesContactQuery(klocok, "   "), false);
    assert.equal(matchesContactQuery(klocok, ",,,"), false);
    assert.equal(matchesContactQuery(klocok, " , "), false);
  });

  it("remains case-insensitive", () => {
    assert.equal(matchesContactQuery(klocok, "KLOCOK"), true);
  });
});
