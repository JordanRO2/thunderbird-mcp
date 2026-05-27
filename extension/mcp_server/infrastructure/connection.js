"use strict";

/**
 * infrastructure/connection.js — connection-file lifecycle + timing-safe compare.
 *
 * Extracted verbatim from api.js's start() scope. Writes/removes the
 * <TmpD>/thunderbird-mcp/connection.json file the bridge uses to discover the
 * port + auth token, and provides the constant-time token comparison used by
 * the HTTP auth check.
 *
 * NOTE: readConnectionInfo() and the onShutdown connection cleanup are NOT here
 * — they live in api.js's OUTER getAPI() scope / onShutdown() because the
 * settings-page API methods (getServerInfo, getCurrentAuthToken) call them
 * outside start(), where this ctx does not exist.
 *
 * Consumes from ctx: Cc, Ci, Services
 * Registers onto ctx: writeConnectionInfo, removeConnectionInfo, timingSafeEqual
 */
module.exports = function register(ctx) {
  const { Cc, Ci, Services } = ctx;

  /**
   * Write connection info (port + auth token) to a well-known file
   * so the bridge can discover how to connect.
   * File: <TmpD>/thunderbird-mcp/connection.json
   */
  function writeConnectionInfo(port, token) {
    const tmpDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
    tmpDir.append("thunderbird-mcp");
    if (!tmpDir.exists()) {
      tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    } else if (tmpDir.isSymlink()) {
      throw new Error("thunderbird-mcp tmp directory is a symlink — refusing to write connection info");
    } else {
      // POSIX hardening: on a shared /tmp another local user could
      // pre-create the directory with group/world bits set, then race
      // the connection file. The O_EXCL on the file itself blocks a
      // straight overwrite, but a permissive directory still lets the
      // attacker read or rename our file. Force perms back to 0o700.
      //
      // Windows uses ACLs, not POSIX modes. The bits reported by
      // nsIFile.permissions on Windows do not correspond to the
      // group/world semantics this check assumes -- a normal Temp
      // subfolder reads as 0o666 or similar and trips a false
      // positive. Skip the chmod entirely on Windows; the POSIX
      // attack model (shared /tmp other-user race) does not apply
      // there anyway since %LOCALAPPDATA%\Temp is per-user.
      const isWindows = (() => {
        try { return Services.appinfo.OS === "WINNT"; } catch { return false; }
      })();
      if (!isWindows) {
        try {
          const mode = tmpDir.permissions;
          if (mode && (mode & 0o077) !== 0) {
            try { tmpDir.permissions = 0o700; } catch { /* best-effort */ }
            if ((tmpDir.permissions & 0o077) !== 0) {
              throw new Error("thunderbird-mcp tmp directory has group/world permissions — refusing to write connection info");
            }
          }
        } catch (e) {
          if (e && e.message && e.message.startsWith("thunderbird-mcp tmp directory")) throw e;
          // ignore: permissions accessor unsupported on this platform
        }
      }
    }
    const connFile = tmpDir.clone();
    connFile.append("connection.json");
    // Symlink defense: remove any existing file first, then create
    // with O_CREAT|O_EXCL (0x08|0x80) to fail if a symlink appeared
    // between remove and create.
    if (connFile.exists()) {
      connFile.remove(false);
    }
    const data = JSON.stringify({ port, token, pid: Services.appinfo.processID });
    const ostream = Cc["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Ci.nsIFileOutputStream);
    // 0x02 = O_WRONLY, 0x08 = O_CREAT, 0x80 = O_EXCL
    ostream.init(connFile, 0x02 | 0x08 | 0x80, 0o600, 0);
    const converter = Cc["@mozilla.org/intl/converter-output-stream;1"]
      .createInstance(Ci.nsIConverterOutputStream);
    converter.init(ostream, "UTF-8");
    converter.writeString(data);
    converter.close();
    return connFile.path;
  }

  /**
   * Remove the connection info file on shutdown.
   */
  function removeConnectionInfo() {
    try {
      const tmpDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
      tmpDir.append("thunderbird-mcp");
      const connFile = tmpDir.clone();
      connFile.append("connection.json");
      if (connFile.exists()) {
        connFile.remove(false);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Constant-time string comparison to prevent timing side-channel attacks.
   */
  function timingSafeEqual(a, b) {
    const aStr = String(a);
    const bStr = String(b);
    const len = Math.max(aStr.length, bStr.length);
    let result = aStr.length ^ bStr.length;
    for (let i = 0; i < len; i++) {
      result |= (aStr.charCodeAt(i) || 0) ^ (bStr.charCodeAt(i) || 0);
    }
    return result === 0;
  }

  Object.assign(ctx, { writeConnectionInfo, removeConnectionInfo, timingSafeEqual });
};
