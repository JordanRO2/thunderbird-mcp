"use strict";

/**
 * application/compose_service.js — compose / template use-case orchestration.
 *
 * This is the body logic that used to sit inside the compose tool functions in
 * domain/compose.js, MINUS the XPCOM compose-window / identity / attachment /
 * template-file machinery (now in infrastructure/compose_adapter.js) and MINUS
 * the pure string/record shaping (now in domain/entities/compose.js).
 *
 * Responsibilities, preserved verbatim from the monolith:
 *   - the skipReview guard (isSkipReviewBlocked) on sendMail/reply/forward,
 *     including the exact "User preference blocks skipReview..." error string
 *     and the default-open-review-window behavior;
 *   - idempotency (findIdempotentEntry + the success-only audit replay);
 *   - the audit-before-action ordering (appendComposeAudit records intent
 *     pre-send; the post-send success entry feeds findIdempotentEntry);
 *   - identity strict validation (setComposeIdentity returns { error } when an
 *     explicit `from` is unknown or restricted — surfaced unchanged);
 *   - body-format resolution + the HTML envelope wrapping;
 *   - disposition marking (replied / forwarded) after a successful direct send.
 *
 * Note: there is no separate contact-write or filter-forward guard inside the
 * compose tools themselves — those guards live in the contacts and filters
 * domains. The compose write guard is skipReview. The ctx still exposes
 * isContactWritesBlocked / isFilterForwardReplyBlocked for the other domains;
 * compose does not consume them.
 *
 * The Cc/Ci compose-object construction (composeParams / compFields /
 * msgComposeService) stays inline in these orchestration bodies exactly as in
 * the monolith — splitting each `createInstance` into the adapter would change
 * call ordering and risk behavior drift. The heavy XPCOM work (send, window
 * customization, attachment building, identity resolution) is delegated to the
 * adapter.
 *
 * Consumes from ctx:
 *   Cc, Ci,
 *   appendComposeAudit, findIdempotentEntry, isSkipReviewBlocked,
 *   getAccessibleAccounts, extractPlainTextBody, findMessage,
 *   isSensitiveFilePath, sanitizeHeaderLine, countRecipients,
 *   composeEntity, composeAdapter
 *   (ChromeUtils is an ambient subscript global, used bare for
 *    importESModule in the skipReview reply/forward paths exactly as the
 *    monolith did — not destructured from ctx.)
 * Registers onto ctx:
 *   composeService = { composeMail, saveDraft, replyToMessage, forwardMessage,
 *                      dryRunCompose, listTemplates, renderTemplate }
 */
module.exports = function register(ctx) {
  const {
    Cc, Ci,
    appendComposeAudit, findIdempotentEntry, isSkipReviewBlocked,
    getAccessibleAccounts, extractPlainTextBody, findMessage,
    isSensitiveFilePath, sanitizeHeaderLine, countRecipients,
    composeEntity, composeAdapter,
  } = ctx;

  const { escapeHtml, formatBodyHtml } = composeEntity;
  const {
    loadTemplate, listTemplateFiles, findIdentity, createLocalFile,
    filePathsToAttachDescs, injectAttachmentsAsync, getReplyAllCcRecipients,
    openComposeWindowWithCustomizations, markMessageDispositionState,
    sendMessageDirectly, resolveComposeFormat, setComposeIdentity,
    MAX_BASE64_SIZE, MAX_FILE_PATH_ATTACHMENT_BYTES,
  } = composeAdapter;

            function listTemplates() {
              return listTemplateFiles();
            }

            function renderTemplate(name, vars) {
              const tpl = loadTemplate(name);
              if (tpl.error) return tpl;
              const declaredVars = Array.isArray(tpl.meta.vars) ? tpl.meta.vars : [];
              const bindings = (vars && typeof vars === "object" && !Array.isArray(vars)) ? vars : {};
              // Required-var enforcement: every declared var must be supplied.
              const missing = declaredVars.filter(v => !(v in bindings));
              if (missing.length > 0) {
                return { error: `Missing required variables: ${missing.join(", ")}` };
              }
              function substitute(text) {
                return String(text).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, key) => {
                  if (key in bindings) return String(bindings[key]);
                  // Unknown placeholder -> leave as literal so the caller
                  // notices instead of silently producing an empty value.
                  return `{{${key}}}`;
                });
              }
              return {
                name: tpl.meta.name || name,
                subject: substitute(tpl.meta.subject || ""),
                body: substitute(tpl.body),
                isHtml: !!tpl.meta.isHtml,
                file: tpl.file,
              };
            }

            function dryRunCompose(to, subject, body, cc, bcc, isHtml, from, attachments) {
              const result = {
                wouldSucceed: true,
                blockers: [],
                resolvedIdentity: null,
                isHtml: !!isHtml,
                subjectAfterSanitization: sanitizeHeaderLine(subject || ""),
                bodyLength: typeof body === "string" ? body.length : 0,
                recipients: {
                  to: countRecipients(to),
                  cc: countRecipients(cc),
                  bcc: countRecipients(bcc),
                },
                attachments: [],
                skipReviewBlocked: isSkipReviewBlocked(),
              };

              // Resolve identity through the same accessible-account path used
              // by composeMail, but never fall back silently to the default --
              // if `from` is set and doesn't match, surface the same error
              // sendMail would return.
              try {
                if (from) {
                  const identity = findIdentity(from);
                  if (!identity) {
                    result.blockers.push(`from identity not found or not accessible: ${from}`);
                    result.wouldSucceed = false;
                  } else {
                    result.resolvedIdentity = {
                      key: identity.key,
                      email: identity.email,
                      fullName: identity.fullName || null,
                    };
                  }
                } else {
                  // Default identity preview: first accessible identity.
                  const accounts = getAccessibleAccounts();
                  const firstIdentity = accounts[0] && accounts[0].defaultIdentity;
                  if (firstIdentity) {
                    result.resolvedIdentity = {
                      key: firstIdentity.key,
                      email: firstIdentity.email,
                      fullName: firstIdentity.fullName || null,
                      isDefault: true,
                    };
                  }
                }
              } catch (e) {
                result.blockers.push(`identity resolution failed: ${e.message || e}`);
                result.wouldSucceed = false;
              }

              // Per-attachment evaluation. Mirrors filePathsToAttachDescs but
              // never copies / decodes / writes anything; only reports verdict.
              if (Array.isArray(attachments)) {
                for (const entry of attachments) {
                  const att = { kind: null, name: null, status: "ok", reason: null, size: null };
                  if (typeof entry === "string") {
                    att.kind = "path";
                    att.name = entry;
                    if (isSensitiveFilePath(entry)) {
                      att.status = "blocked";
                      att.reason = "sensitive path";
                    } else {
                      try {
                        const file = createLocalFile(entry);
                        if (!file.exists()) {
                          att.status = "missing";
                          att.reason = "file does not exist";
                        } else {
                          try { att.size = file.fileSize; } catch { att.size = null; }
                          if (att.size !== null && att.size > MAX_FILE_PATH_ATTACHMENT_BYTES) {
                            att.status = "blocked";
                            att.reason = `exceeds ${MAX_FILE_PATH_ATTACHMENT_BYTES / 1024 / 1024}MB cap`;
                          }
                        }
                      } catch (e) {
                        att.status = "error";
                        att.reason = e.message || String(e);
                      }
                    }
                  } else if (entry && typeof entry === "object" && (entry.base64 || entry.content) && entry.name) {
                    att.kind = "inline";
                    att.name = entry.name;
                    const b64 = entry.base64 || entry.content;
                    att.size = typeof b64 === "string" ? Math.floor((b64.length * 3) / 4) : null;
                    if (typeof b64 === "string" && b64.length > MAX_BASE64_SIZE) {
                      att.status = "blocked";
                      att.reason = `inline base64 exceeds ${MAX_BASE64_SIZE / 1024 / 1024}MB`;
                    }
                  } else {
                    att.kind = "invalid";
                    att.name = typeof entry === "object" ? JSON.stringify(entry).slice(0, 80) : String(entry);
                    att.status = "blocked";
                    att.reason = "neither a file path nor an inline {name, base64} object";
                  }
                  if (att.status !== "ok") {
                    result.wouldSucceed = false;
                  }
                  result.attachments.push(att);
                }
              }

              return result;
            }

            /**
             * Composes a new email. Opens a compose window for review, or sends
             * directly when skipReview is true.
             *
             * HTML body handling quirks:
             * 1. Strip newlines from HTML - Thunderbird adds <br> for each \n
             * 2. Encode non-ASCII as HTML entities - compose window has charset issues
             *    with emojis/unicode even with <meta charset="UTF-8">
             */
            function composeMail(to, subject, body, cc, bcc, isHtml, from, attachments, skipReview, idempotencyKey) {
              try {
                if (skipReview && isSkipReviewBlocked()) {
                  return { error: "User preference blocks skipReview. Retry with skipReview: false (or omitted) to open the review window instead." };
                }
                // Idempotency: if a prior successful sendMail with this key
                // ran in the last 24h, return its result instead of sending
                // again. The audit-log entry is the source of truth.
                if (typeof idempotencyKey === "string" && idempotencyKey) {
                  const prior = findIdempotentEntry("sendMail", idempotencyKey);
                  if (prior) {
                    return { ...prior, idempotent: true, idempotencyKey };
                  }
                }
                appendComposeAudit({
                  tool: "sendMail",
                  skipReview: !!skipReview,
                  isHtml: !!isHtml,
                  from: typeof from === "string" ? from : null,
                  to: countRecipients(to),
                  cc: countRecipients(cc),
                  bcc: countRecipients(bcc),
                  subject: typeof subject === "string" ? subject.slice(0, 200) : null,
                  attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
                  idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey.slice(0, 256) : null,
                });
                const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
                  .createInstance(Ci.nsIMsgComposeParams);

                const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
                  .createInstance(Ci.nsIMsgCompFields);

                composeFields.to = to || "";
                composeFields.cc = cc || "";
                composeFields.bcc = bcc || "";
                composeFields.subject = sanitizeHeaderLine(subject || "");

                msgComposeParams.type = Ci.nsIMsgCompType.New;
                msgComposeParams.composeFields = composeFields;

                const identityResult = setComposeIdentity(msgComposeParams, from, null);
                if (identityResult && identityResult.error) return identityResult;

                // Match body shape and format to caller intent / identity pref.
                // When the resolved mode is plain, ship a plain body -- the HTML
                // envelope would otherwise render as literal text in plain-mode
                // editors and recipients.
                const { useHtml, format } = resolveComposeFormat(msgComposeParams.identity, isHtml, Ci.nsIMsgCompType.New);
                msgComposeParams.format = format;
                if (useHtml) {
                  const formatted = formatBodyHtml(body, isHtml);
                  composeFields.body = isHtml && formatted.includes('<html')
                    ? formatted
                    : `<html><head><meta charset="UTF-8"></head><body>${formatted}</body></html>`;
                } else {
                  composeFields.body = body || "";
                }

                const { descs: fileDescs, failed: failedPaths } = filePathsToAttachDescs(attachments);

                if (skipReview) {
                  return sendMessageDirectly(composeFields, msgComposeParams.identity, fileDescs, null, Ci.nsIMsgCompType.New, Ci.nsIMsgCompDeliverMode.Now, useHtml ? "text/html" : "text/plain").then(result => {
                    if (result.success) {
                      let msg = "Message sent";
                      if (failedPaths.length > 0) msg += ` (failed to attach: ${failedPaths.join(", ")})`;
                      result.message = msg;
                      // Idempotency: record the successful outcome so a retry
                      // with the same key returns this result instead of
                      // sending again. The pre-send audit entry only records
                      // intent; findIdempotentEntry filters to success:true.
                      if (typeof idempotencyKey === "string" && idempotencyKey) {
                        appendComposeAudit({
                          tool: "sendMail",
                          success: true,
                          idempotencyKey: idempotencyKey.slice(0, 256),
                          result,
                        });
                      }
                    }
                    return result;
                  });
                }

                const msgComposeService = Cc["@mozilla.org/messengercompose;1"]
                  .getService(Ci.nsIMsgComposeService);
                msgComposeService.OpenComposeWindowWithParams(null, msgComposeParams);

                injectAttachmentsAsync(fileDescs);

                let msg = "Compose window opened";
                if (failedPaths.length > 0) msg += ` (failed to attach: ${failedPaths.join(", ")})`;
                return { success: true, message: msg };
              } catch (e) {
                return { error: e.toString() };
              }
            }

            /**
             * Saves a composed message to the identity's Drafts folder without
             * sending or opening a compose window. The destination folder is
             * resolved by Thunderbird from the identity's draft-folder pref.
             */
            function saveDraft(to, subject, body, cc, bcc, isHtml, from, attachments) {
              try {
                appendComposeAudit({
                  tool: "saveDraft",
                  isHtml: !!isHtml,
                  from: typeof from === "string" ? from : null,
                  to: countRecipients(to),
                  cc: countRecipients(cc),
                  bcc: countRecipients(bcc),
                  subject: typeof subject === "string" ? subject.slice(0, 200) : null,
                  attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
                });
                const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
                  .createInstance(Ci.nsIMsgComposeParams);

                const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
                  .createInstance(Ci.nsIMsgCompFields);

                composeFields.to = to || "";
                composeFields.cc = cc || "";
                composeFields.bcc = bcc || "";
                composeFields.subject = sanitizeHeaderLine(subject || "");

                msgComposeParams.type = Ci.nsIMsgCompType.New;
                msgComposeParams.composeFields = composeFields;

                const identityResult = setComposeIdentity(msgComposeParams, from, null);
                if (identityResult && identityResult.error) return identityResult;

                const { useHtml, format } = resolveComposeFormat(msgComposeParams.identity, isHtml, Ci.nsIMsgCompType.New);
                msgComposeParams.format = format;
                if (useHtml) {
                  const formatted = formatBodyHtml(body, isHtml);
                  composeFields.body = isHtml && formatted.includes('<html')
                    ? formatted
                    : `<html><head><meta charset="UTF-8"></head><body>${formatted}</body></html>`;
                } else {
                  composeFields.body = body || "";
                }

                const { descs: fileDescs, failed: failedPaths } = filePathsToAttachDescs(attachments);

                return sendMessageDirectly(
                  composeFields,
                  msgComposeParams.identity,
                  fileDescs,
                  null,
                  Ci.nsIMsgCompType.New,
                  Ci.nsIMsgCompDeliverMode.SaveAsDraft,
                  useHtml ? "text/html" : "text/plain"
                ).then(result => {
                  if (result.success) {
                    let msg = "Draft saved";
                    if (failedPaths.length > 0) msg += ` (failed to attach: ${failedPaths.join(", ")})`;
                    result.message = msg;
                  }
                  return result;
                });
              } catch (e) {
                return { error: e.toString() };
              }
            }

            /**
             * Replies to a message with quoted original. Opens a compose window
             * for review, or sends directly when skipReview is true.
             *
             * Review path uses Thunderbird's native reply compose flow so it can
             * build the quoted original, place the identity signature according
             * to user preferences, and set threading headers/disposition flags.
             * skipReview still uses direct send, so it keeps a manual quoted body
             * and manually marks the original as replied after a successful send.
             */
            function replyToMessage(messageId, folderPath, body, replyAll, isHtml, to, cc, bcc, from, attachments, skipReview, idempotencyKey) {
              return new Promise((resolve) => {
                try {
                  if (skipReview && isSkipReviewBlocked()) {
                    resolve({ error: "User preference blocks skipReview. Retry with skipReview: false (or omitted) to open the review window instead." });
                    return;
                  }
                  if (typeof idempotencyKey === "string" && idempotencyKey) {
                    const prior = findIdempotentEntry("replyToMessage", idempotencyKey);
                    if (prior) {
                      resolve({ ...prior, idempotent: true, idempotencyKey });
                      return;
                    }
                  }
                  appendComposeAudit({
                    tool: "replyToMessage",
                    skipReview: !!skipReview,
                    replyAll: !!replyAll,
                    isHtml: !!isHtml,
                    from: typeof from === "string" ? from : null,
                    originalMessageId: typeof messageId === "string" ? messageId.slice(0, 256) : null,
                    to: countRecipients(to),
                    cc: countRecipients(cc),
                    bcc: countRecipients(bcc),
                    attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
                    idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey.slice(0, 256) : null,
                  });
                  const found = findMessage(messageId, folderPath);
                  if (found.error) {
                    resolve({ error: found.error });
                    return;
                  }
                  const { msgHdr, folder } = found;
                  const { descs: fileDescs, failed: failedPaths } = filePathsToAttachDescs(attachments);
                  const msgURI = folder.getUriForMsg(msgHdr);
                  const compType = replyAll ? Ci.nsIMsgCompType.ReplyAll : Ci.nsIMsgCompType.Reply;

                  const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
                    .createInstance(Ci.nsIMsgComposeParams);

                  const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
                    .createInstance(Ci.nsIMsgCompFields);

                  msgComposeParams.type = compType;
                  msgComposeParams.originalMsgURI = msgURI;
                  msgComposeParams.composeFields = composeFields;

                  try {
                    msgComposeParams.origMsgHdr = msgHdr;
                  } catch {}

                  const identityResult = setComposeIdentity(msgComposeParams, from, folder.server);
                  if (identityResult && identityResult.error) {
                    resolve(identityResult);
                    return;
                  }

                  // Resolve compose mode against caller intent + identity pref.
                  // The skipReview branch reads useHtml below to shape the body.
                  const { useHtml: replyUseHtml, format: replyFormat } =
                    resolveComposeFormat(msgComposeParams.identity, isHtml, compType);
                  msgComposeParams.format = replyFormat;

                  // Pass through only the fields the caller explicitly provided.
                  // Any field left undefined is filled in by Thunderbird's native
                  // reply/reply-all machinery (including proper Reply-To,
                  // Mail-Followup-To, mailing-list handling, and self-filtering
                  // against the selected identity). Our old custom
                  // getReplyAllCcRecipients path bypassed all of that.
                  const reviewTo = to;
                  const reviewCc = cc;

                  if (skipReview) {
                    const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
                      "resource:///modules/gloda/MimeMessage.sys.mjs"
                    );

                    MsgHdrToMimeMessage(msgHdr, null, (aMsgHdr, aMimeMsg) => {
                      try {
                        const originalBody = extractPlainTextBody(aMimeMsg);

                        if (replyAll) {
                          composeFields.to = to || msgHdr.author;
                          if (cc) {
                            composeFields.cc = cc;
                          } else {
                            const replyAllCc = getReplyAllCcRecipients(msgHdr, folder);
                            if (replyAllCc) composeFields.cc = replyAllCc;
                          }
                        } else {
                          composeFields.to = to || msgHdr.author;
                          if (cc) composeFields.cc = cc;
                        }

                        composeFields.bcc = bcc || "";

                        const origSubject = sanitizeHeaderLine(msgHdr.mime2DecodedSubject || msgHdr.subject || "");
                        composeFields.subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
                        composeFields.references = `<${messageId}>`;
                        composeFields.setHeader("In-Reply-To", `<${messageId}>`);

                        const dateStr = msgHdr.date ? new Date(msgHdr.date / 1000).toLocaleString() : "";
                        const author = msgHdr.mime2DecodedAuthor || msgHdr.author || "";

                        // Direct send goes through nsIMsgSend, not nsIMsgCompose, so
                        // it still uses a hand-built quoted body and cannot place the
                        // identity signature according to reply preferences. The shape
                        // matches the resolved compose mode -- shipping an HTML envelope
                        // for a plain-format send would otherwise render as literal
                        // markup in the recipient's mail client.
                        if (replyUseHtml) {
                          const quotedLines = originalBody.split('\n').map(line =>
                            `&gt; ${escapeHtml(line)}`
                          ).join('<br>');
                          const quotedHtml = escapeHtml(originalBody).replace(/\n/g, '<br>');
                          const quoteBlock = isHtml
                            ? `<br><br>On ${dateStr}, ${escapeHtml(author)} wrote:<blockquote type="cite">${quotedHtml}</blockquote>`
                            : `<br><br>On ${dateStr}, ${escapeHtml(author)} wrote:<br>${quotedLines}`;
                          composeFields.body = `<html><head><meta charset="UTF-8"></head><body>${formatBodyHtml(body, isHtml)}${quoteBlock}</body></html>`;
                        } else {
                          const quotedLines = originalBody.split('\n').map(line => `> ${line}`).join('\n');
                          composeFields.body = `${body || ""}\n\nOn ${dateStr}, ${author} wrote:\n${quotedLines}`;
                        }

                        sendMessageDirectly(composeFields, msgComposeParams.identity, fileDescs, msgURI, compType, Ci.nsIMsgCompDeliverMode.Now, replyUseHtml ? "text/html" : "text/plain").then(result => {
                          if (result.success) {
                            let repliedDisposition = null;
                            try {
                              repliedDisposition = Ci.nsIMsgFolder.nsMsgDispositionState_Replied;
                            } catch {}
                            markMessageDispositionState(msgHdr, repliedDisposition);

                            let msg = "Reply sent";
                            if (failedPaths.length > 0) msg += ` (failed to attach: ${failedPaths.join(", ")})`;
                            result.message = msg;
                            if (typeof idempotencyKey === "string" && idempotencyKey) {
                              appendComposeAudit({
                                tool: "replyToMessage",
                                success: true,
                                idempotencyKey: idempotencyKey.slice(0, 256),
                                result,
                              });
                            }
                          }
                          resolve(result);
                        });
                      } catch (e) {
                        resolve({ error: e.toString() });
                      }
                    }, true, { examineEncryptedParts: true });
                    return;
                  }

                  openComposeWindowWithCustomizations(
                    msgComposeParams,
                    msgURI,
                    compType,
                    msgComposeParams.identity,
                    body,
                    isHtml,
                    reviewTo,
                    reviewCc,
                    bcc,
                    fileDescs
                  ).then(result => {
                    if (result.success) {
                      let msg = "Reply window opened";
                      if (failedPaths.length > 0) msg += ` (failed to attach: ${failedPaths.join(", ")})`;
                      result.message = msg;
                    }
                    resolve(result);
                  });

                } catch (e) {
                  resolve({ error: e.toString() });
                }
              });
            }

            /**
             * Forwards a message with original content and attachments.
             *
             * Review path uses Thunderbird's native ForwardInline compose flow so
             * TB builds the forward body with a proper <blockquote type="cite">
             * quote, auto-attaches the original message's attachments, places the
             * identity signature per user preferences, and sets the $Forwarded
             * disposition on the original after a successful send. The caller's
             * intro body is injected via NotifyComposeBodyReady, mirroring how
             * replyToMessage handles intro injection.
             *
             * skipReview still uses direct send, so it keeps a manual forward
             * block + auto-attaches originals from MsgHdrToMimeMessage + manually
             * marks the original as forwarded after a successful send.
             */
            function forwardMessage(messageId, folderPath, to, body, isHtml, cc, bcc, from, attachments, skipReview, idempotencyKey) {
              return new Promise((resolve) => {
                try {
                  if (skipReview && isSkipReviewBlocked()) {
                    resolve({ error: "User preference blocks skipReview. Retry with skipReview: false (or omitted) to open the review window instead." });
                    return;
                  }
                  if (typeof idempotencyKey === "string" && idempotencyKey) {
                    const prior = findIdempotentEntry("forwardMessage", idempotencyKey);
                    if (prior) {
                      resolve({ ...prior, idempotent: true, idempotencyKey });
                      return;
                    }
                  }
                  appendComposeAudit({
                    tool: "forwardMessage",
                    skipReview: !!skipReview,
                    isHtml: !!isHtml,
                    from: typeof from === "string" ? from : null,
                    originalMessageId: typeof messageId === "string" ? messageId.slice(0, 256) : null,
                    to: countRecipients(to),
                    cc: countRecipients(cc),
                    bcc: countRecipients(bcc),
                    attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
                    idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey.slice(0, 256) : null,
                  });
                  const found = findMessage(messageId, folderPath);
                  if (found.error) {
                    resolve({ error: found.error });
                    return;
                  }
                  const { msgHdr, folder } = found;
                  const { descs: fileDescs, failed: failedPaths } = filePathsToAttachDescs(attachments);
                  const msgURI = folder.getUriForMsg(msgHdr);
                  const compType = Ci.nsIMsgCompType.ForwardInline;

                  const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
                    .createInstance(Ci.nsIMsgComposeParams);

                  const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
                    .createInstance(Ci.nsIMsgCompFields);

                  msgComposeParams.type = compType;
                  msgComposeParams.originalMsgURI = msgURI;
                  msgComposeParams.composeFields = composeFields;

                  try {
                    msgComposeParams.origMsgHdr = msgHdr;
                  } catch {}

                  const identityResult = setComposeIdentity(msgComposeParams, from, folder.server);
                  if (identityResult && identityResult.error) {
                    resolve(identityResult);
                    return;
                  }

                  // ForwardInline only passes the format flag through when it is
                  // Default or OppositeOfDefault -- HTML/PlainText are ignored and
                  // the identity's compose pref always wins. resolveComposeFormat
                  // returns OppositeOfDefault when the caller's explicit isHtml
                  // conflicts with the identity pref so we can still force the
                  // intended editor mode.
                  const { useHtml: fwdUseHtml, format: fwdFormat } =
                    resolveComposeFormat(msgComposeParams.identity, isHtml, compType);
                  msgComposeParams.format = fwdFormat;

                  if (skipReview) {
                    const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
                      "resource:///modules/gloda/MimeMessage.sys.mjs"
                    );

                    MsgHdrToMimeMessage(msgHdr, null, (aMsgHdr, aMimeMsg) => {
                      try {
                        const originalBody = extractPlainTextBody(aMimeMsg);

                        composeFields.to = to;
                        composeFields.cc = cc || "";
                        composeFields.bcc = bcc || "";

                        const origSubject = sanitizeHeaderLine(msgHdr.mime2DecodedSubject || msgHdr.subject || "");
                        composeFields.subject = /^fwd:/i.test(origSubject) ? origSubject : `Fwd: ${origSubject}`;

                        const dateStr = msgHdr.date ? new Date(msgHdr.date / 1000).toLocaleString() : "";
                        const fwdAuthor = msgHdr.mime2DecodedAuthor || msgHdr.author || "";
                        const fwdRecipients = msgHdr.mime2DecodedRecipients || msgHdr.recipients || "";

                        // Direct send goes through nsIMsgSend, not nsIMsgCompose,
                        // so we hand-build the forward block. The shape matches the
                        // resolved compose mode -- shipping an HTML envelope for a
                        // plain-format send would render as literal markup in the
                        // recipient's mail client.
                        if (fwdUseHtml) {
                          const fwdHeaderHtml =
                            `-------- Forwarded Message --------<br>` +
                            `Subject: ${escapeHtml(origSubject)}<br>` +
                            `Date: ${dateStr}<br>` +
                            `From: ${escapeHtml(fwdAuthor)}<br>` +
                            `To: ${escapeHtml(fwdRecipients)}<br><br>`;
                          const quotedHtml = escapeHtml(originalBody).replace(/\n/g, '<br>');
                          const quotedLinesHtml = originalBody.split('\n').map(line =>
                            `&gt; ${escapeHtml(line)}`
                          ).join('<br>');
                          const forwardBlock = isHtml
                            ? `<blockquote type="cite">${fwdHeaderHtml}${quotedHtml}</blockquote>`
                            : `${fwdHeaderHtml}${quotedLinesHtml}`;
                          const introHtml = body ? formatBodyHtml(body, isHtml) + '<br><br>' : "";
                          composeFields.body = `<html><head><meta charset="UTF-8"></head><body>${introHtml}${forwardBlock}</body></html>`;
                        } else {
                          const fwdHeader =
                            `-------- Forwarded Message --------\n` +
                            `Subject: ${origSubject}\n` +
                            `Date: ${dateStr}\n` +
                            `From: ${fwdAuthor}\n` +
                            `To: ${fwdRecipients}\n\n`;
                          composeFields.body = `${body ? body + '\n\n' : ''}${fwdHeader}${originalBody}`;
                        }

                        const origDescs = [];
                        if (aMimeMsg && aMimeMsg.allUserAttachments) {
                          for (const att of aMimeMsg.allUserAttachments) {
                            try {
                              origDescs.push({ url: att.url, name: att.name, contentType: att.contentType });
                            } catch {
                              // Skip unreadable original attachments
                            }
                          }
                        }
                        const allDescs = [...origDescs, ...fileDescs];

                        sendMessageDirectly(composeFields, msgComposeParams.identity, allDescs, msgURI, compType, Ci.nsIMsgCompDeliverMode.Now, fwdUseHtml ? "text/html" : "text/plain").then(result => {
                          if (result.success) {
                            let forwardedDisposition = null;
                            try {
                              forwardedDisposition = Ci.nsIMsgFolder.nsMsgDispositionState_Forwarded;
                            } catch {}
                            markMessageDispositionState(msgHdr, forwardedDisposition);

                            let msg = `Forward sent with ${allDescs.length} attachment(s)`;
                            if (failedPaths.length > 0) msg += ` (failed to attach: ${failedPaths.join(", ")})`;
                            result.message = msg;
                            if (typeof idempotencyKey === "string" && idempotencyKey) {
                              appendComposeAudit({
                                tool: "forwardMessage",
                                success: true,
                                idempotencyKey: idempotencyKey.slice(0, 256),
                                result,
                              });
                            }
                          }
                          resolve(result);
                        });
                      } catch (e) {
                        resolve({ error: e.toString() });
                      }
                    }, true, { examineEncryptedParts: true });
                    return;
                  }

                  // Review path: TB builds the forward body and auto-attaches the
                  // original's attachments via ForwardInline. The intro body and
                  // user-specified extra attachments are injected once the compose
                  // window's editor signals NotifyComposeBodyReady. Subject is set
                  // by TB from origMsgHdr.
                  openComposeWindowWithCustomizations(
                    msgComposeParams,
                    msgURI,
                    compType,
                    msgComposeParams.identity,
                    body,
                    isHtml,
                    to,
                    cc,
                    bcc,
                    fileDescs
                  ).then(result => {
                    if (result.success) {
                      let msg = "Forward window opened";
                      if (failedPaths.length > 0) msg += ` (failed to attach: ${failedPaths.join(", ")})`;
                      result.message = msg;
                    }
                    resolve(result);
                  });
                } catch (e) {
                  resolve({ error: e.toString() });
                }
              });
            }

  Object.assign(ctx, {
    composeService: {
      composeMail, saveDraft, replyToMessage, forwardMessage,
      dryRunCompose, listTemplates, renderTemplate,
    },
  });
};
