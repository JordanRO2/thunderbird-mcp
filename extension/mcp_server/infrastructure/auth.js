"use strict";

/**
 * infrastructure/auth.js — resolves the HTTP auth token for this server run.
 *
 * The token *generators* (generateAuthToken, getStableAuthTokenPref) stay in
 * api.js's OUTER getAPI() scope because the settings-page API methods
 * (generateAuthToken, getStableAuthToken/setStableAuthToken) call them outside
 * start(). They are passed in via ctx. This module just performs the one-line
 * resolution that used to sit inline in start():
 *
 *     const authToken = getStableAuthTokenPref() || generateAuthToken();
 *
 * and registers the resulting token onto ctx for the connection writer and the
 * HTTP request auth check.
 *
 * Consumes from ctx: getStableAuthTokenPref, generateAuthToken
 * Registers onto ctx: authToken
 */
module.exports = function register(ctx) {
  const { getStableAuthTokenPref, generateAuthToken } = ctx;
  const authToken = getStableAuthTokenPref() || generateAuthToken();
  Object.assign(ctx, { authToken });
};
