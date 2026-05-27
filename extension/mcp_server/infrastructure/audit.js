"use strict";

/**
 * infrastructure/audit.js — audit log, idempotency, pref cache, rate-limit state.
 *
 * Extracted verbatim from api.js's start() scope. Bundles the cross-cutting
 * write-side observability:
 *   - appendComposeAudit / readAuditLog / clearAuditLog  (JSON-lines audit log)
 *   - findIdempotentEntry                                 (dedupe sends on retry)
 *   - the per-pref read cache (__cachedRead + observers)  (used by access.js)
 *   - the per-server rate-limiter STATE                   (used by dispatch.js)
 *
 * The audit-log filename/rotation CONSTANTS are also registered onto ctx
 * because getServerCapabilities (in api.js) references AUDIT_LOG_SUBDIR /
 * AUDIT_LOG_FILENAME, and the legacy domain modules read AUDIT_LOG_SUBDIR.
 *
 * The rate-limit ALGORITHM (createRateLimiterState/consumeRateLimit/
 * inspectRateLimits) lives in security_helpers.js so the Node test suite can
 * exercise the shipped code; this module only owns the per-run STATE object.
 *
 * Consumes from ctx:
 *   Cc, Ci, Services,
 *   createRateLimiterState, consumeRateLimit, inspectRateLimits
 * Registers onto ctx:
 *   AUDIT_LOG_ROTATE_BYTES, AUDIT_LOG_SUBDIR, AUDIT_LOG_FILENAME,
 *   AUDIT_LOG_ROTATED_FILENAME, IDEMPOTENCY_WINDOW_HOURS,
 *   appendComposeAudit, readAuditLog, findIdempotentEntry, clearAuditLog,
 *   __cachedRead, __invalidatePrefCache, __ensurePrefObserver,
 *   rateLimiterState, consumeRateLimitFor, inspectRateLimitsState
 */
module.exports = function register(ctx) {
  const {
    Cc, Ci, Services,
    createRateLimiterState, consumeRateLimit, inspectRateLimits,
  } = ctx;

  // Audit-log cap before rotation. 5 MB of JSON lines is roughly
  // 10k-30k compose events depending on subject length; rotating to
  // a single `.log.1` keeps disk use bounded without losing history.
  const AUDIT_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
  const AUDIT_LOG_SUBDIR = "thunderbird-mcp";
  const AUDIT_LOG_FILENAME = "audit.log";
  const AUDIT_LOG_ROTATED_FILENAME = "audit.log.1";

  /**
   * Append a single JSON line describing an outbound-compose action
   * (sendMail / replyToMessage / forwardMessage / saveDraft) to
   * <ProfD>/thunderbird-mcp/audit.log. Best-effort: any failure is
   * swallowed so disk errors never block a legitimate send.
   *
   * Logged fields are metadata only -- no body, no attachment
   * content, no recipient lists beyond counts. The whole point is
   * incident response, not message archival.
   */
  function appendComposeAudit(entry) {
    try {
      const profDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
      const auditDir = profDir.clone();
      auditDir.append(AUDIT_LOG_SUBDIR);
      if (!auditDir.exists()) {
        auditDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
      }

      const logFile = auditDir.clone();
      logFile.append(AUDIT_LOG_FILENAME);

      // Rotate when the active log exceeds the cap.
      if (logFile.exists()) {
        let size = 0;
        try { size = logFile.fileSize; } catch { size = 0; }
        if (size > AUDIT_LOG_ROTATE_BYTES) {
          const rotated = auditDir.clone();
          rotated.append(AUDIT_LOG_ROTATED_FILENAME);
          if (rotated.exists()) {
            try { rotated.remove(false); } catch { /* best-effort */ }
          }
          try { logFile.moveTo(auditDir, AUDIT_LOG_ROTATED_FILENAME); } catch { /* best-effort */ }
        }
      }

      const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      }) + "\n";

      const ostream = Cc["@mozilla.org/network/file-output-stream;1"]
        .createInstance(Ci.nsIFileOutputStream);
      // 0x02 = O_WRONLY, 0x08 = O_CREAT, 0x10 = O_APPEND
      ostream.init(logFile, 0x02 | 0x08 | 0x10, 0o600, 0);
      const converter = Cc["@mozilla.org/intl/converter-output-stream;1"]
        .createInstance(Ci.nsIConverterOutputStream);
      converter.init(ostream, "UTF-8");
      converter.writeString(line);
      converter.close();
    } catch (e) {
      // Audit failure must never block a send. Surface it once on the
      // console and move on; do NOT propagate.
      try { console.warn("thunderbird-mcp: audit log write failed:", e); } catch { /* ignore */ }
    }
  }

  /**
   * Read the audit log file(s) and return parsed JSON entries newest-
   * first. Reads both audit.log and audit.log.1 if rotation happened
   * so the caller sees the full bounded history.
   *
   * Returns { entries, totalScanned, truncated, errors }:
   *   - entries: array of parsed log objects (most recent first)
   *   - totalScanned: number of bytes read
   *   - truncated: true if maxEntries cut the list
   *   - errors: per-line parse failures (object with line + reason)
   *
   * filter is optional: { tool, since, until } where since/until are
   * ISO timestamps and tool is an exact name match.
   */
  function readAuditLog(maxEntries, filter) {
    const limit = Number.isFinite(maxEntries) && maxEntries > 0
      ? Math.min(Math.floor(maxEntries), 10000)
      : 500;
    const wantTool = filter && typeof filter.tool === "string" ? filter.tool : null;
    const sinceTs = filter && filter.since ? Date.parse(filter.since) : null;
    const untilTs = filter && filter.until ? Date.parse(filter.until) : null;

    const out = { entries: [], totalScanned: 0, truncated: false, errors: [] };
    const profDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    const auditDir = profDir.clone();
    auditDir.append(AUDIT_LOG_SUBDIR);
    if (!auditDir.exists()) return out;

    // Read the active log first, then the rotated one. Newest-first
    // means we read each file end-to-end, parse, reverse the file's
    // entries, then append. The rotated file (.log.1) is older.
    const fileNames = [AUDIT_LOG_FILENAME, AUDIT_LOG_ROTATED_FILENAME];
    for (const fname of fileNames) {
      if (out.entries.length >= limit) {
        out.truncated = true;
        break;
      }
      const f = auditDir.clone();
      f.append(fname);
      if (!f.exists()) continue;
      let text = "";
      try {
        const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
        fis.init(f, 0x01, 0, 0);
        const cis = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
        cis.init(fis, "UTF-8", 0, 0);
        const buf = {};
        let read;
        while ((read = cis.readString(65536, buf)) > 0) {
          text += buf.value;
        }
        cis.close();
        out.totalScanned += text.length;
      } catch (e) {
        out.errors.push({ file: fname, reason: String(e) });
        continue;
      }
      const lines = text.split("\n");
      // Reverse so newest-first; skip empty trailing line.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); }
        catch { out.errors.push({ line: line.slice(0, 80), reason: "parse failure" }); continue; }
        if (wantTool && parsed.tool !== wantTool) continue;
        if (sinceTs && parsed.ts && Date.parse(parsed.ts) < sinceTs) continue;
        if (untilTs && parsed.ts && Date.parse(parsed.ts) > untilTs) continue;
        out.entries.push(parsed);
        if (out.entries.length >= limit) {
          out.truncated = true;
          break;
        }
      }
    }
    return out;
  }

  // Idempotency window: how far back to scan for a matching key
  // before considering the new call a fresh send.
  const IDEMPOTENCY_WINDOW_HOURS = 24;

  /**
   * Find a recent successful audit entry whose idempotencyKey
   * matches `key`. Returns the entry's stored `result` object, or
   * null if no match. Used by sendMail / replyToMessage /
   * forwardMessage to skip duplicate sends after a crash or retry.
   *
   * Only entries with .success === true are considered hits --
   * a previous error MUST allow the caller to retry.
   */
  function findIdempotentEntry(tool, key) {
    if (typeof key !== "string" || !key) return null;
    if (key.length > 256) return null; // schema caps caller input
    const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_HOURS * 3600 * 1000).toISOString();
    const log = readAuditLog(1000, { tool, since });
    for (const e of log.entries) {
      if (e && e.idempotencyKey === key && e.success === true && e.result) {
        return e.result;
      }
    }
    return null;
  }

  /**
   * Truncate both audit.log and audit.log.1. Returns the number of
   * bytes deleted. Best-effort; missing files are silent successes.
   */
  function clearAuditLog() {
    let bytesRemoved = 0;
    try {
      const profDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
      const auditDir = profDir.clone();
      auditDir.append(AUDIT_LOG_SUBDIR);
      if (!auditDir.exists()) return { success: true, bytesRemoved: 0 };
      for (const fname of [AUDIT_LOG_FILENAME, AUDIT_LOG_ROTATED_FILENAME]) {
        const f = auditDir.clone();
        f.append(fname);
        if (f.exists()) {
          try { bytesRemoved += f.fileSize; } catch { /* ignore */ }
          try { f.remove(false); } catch { /* ignore */ }
        }
      }
    } catch (e) {
      return { error: String(e), bytesRemoved };
    }
    return { success: true, bytesRemoved };
  }

  // Pref-read cache. Services.prefs is hit on every tool dispatch
  // (rate-limit, access-control, safeguards) and the cost adds up
  // under search bursts. We cache the parsed value behind each
  // pref name and register one observer per pref that flips the
  // cached entry to undefined on change, forcing a re-read next
  // call. Cheap: a few microseconds saved per call, but matters
  // for batch tools like batchGetMessageHeaders.
  const __prefCache = Object.create(null);
  const __prefObservers = Object.create(null);

  function __invalidatePrefCache(prefName) {
    return {
      observe(subject, topic, data) {
        if (topic === "nsPref:changed" && data === prefName) {
          delete __prefCache[prefName];
        }
      },
    };
  }
  function __ensurePrefObserver(prefName) {
    if (__prefObservers[prefName]) return;
    const obs = __invalidatePrefCache(prefName);
    try {
      Services.prefs.addObserver(prefName, obs, false);
      __prefObservers[prefName] = obs;
    } catch (e) {
      console.warn("thunderbird-mcp: pref observer registration failed for", prefName, e);
    }
  }
  function __cachedRead(prefName, reader) {
    __ensurePrefObserver(prefName);
    if (__prefCache[prefName] !== undefined) return __prefCache[prefName];
    const value = reader();
    __prefCache[prefName] = value;
    return value;
  }

  // One rate-limiter state per server instance. Resets on extension reload
  // -- intentional: that's typically a developer action and we don't want a
  // restart to feel "stuck" for the windowMs duration.
  const rateLimiterState = createRateLimiterState();
  function consumeRateLimitFor(name) {
    return consumeRateLimit(rateLimiterState, name);
  }
  function inspectRateLimitsState() {
    return inspectRateLimits(rateLimiterState);
  }

  Object.assign(ctx, {
    AUDIT_LOG_ROTATE_BYTES, AUDIT_LOG_SUBDIR, AUDIT_LOG_FILENAME,
    AUDIT_LOG_ROTATED_FILENAME, IDEMPOTENCY_WINDOW_HOURS,
    appendComposeAudit, readAuditLog, findIdempotentEntry, clearAuditLog,
    __cachedRead, __invalidatePrefCache, __ensurePrefObserver,
    rateLimiterState, consumeRateLimitFor, inspectRateLimitsState,
  });
};
