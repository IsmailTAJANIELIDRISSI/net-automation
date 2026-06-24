"use strict";

/**
 * Shared email-notification helper (nodemailer + config.email).
 * Sends to EMAIL_TO with EMAIL_CC in copy. No-op (returns false) when email is
 * disabled or not configured, so callers can `await` it without guarding.
 */

const fs = require("fs");
const nodemailer = require("nodemailer");
const config = require("../config/config");
const { createLogger } = require("./logger");

const log = createLogger("Mailer");

/**
 * @param {object}   opts
 * @param {string}   opts.subject      — email subject
 * @param {string}   opts.text         — plain-text body
 * @param {Array<{path:string,filename?:string}>} [opts.attachments] — files to attach
 *        (entries whose path does not exist are dropped)
 * @returns {Promise<boolean>} true if sent
 */
async function sendNotification({ subject, text, attachments = [] }) {
  const { email } = config;
  if (!email.enabled || !email.user || !email.to) {
    log.warn(
      `Email skipped (EMAIL_ENABLED/USER/TO not configured) — subject: "${subject}"`,
    );
    return false;
  }

  const validAttachments = (attachments || []).filter(
    (a) => a && a.path && fs.existsSync(a.path),
  );

  try {
    const transporter = nodemailer.createTransport({
      host: email.host,
      port: email.port,
      secure: email.port === 465,
      auth: { user: email.user, pass: email.pass },
    });

    await transporter.sendMail({
      from: email.from || email.user,
      to: email.to,
      cc: email.cc || undefined,
      subject,
      text,
      attachments: validAttachments,
    });

    log.info(
      `Email sent: "${subject}"${validAttachments.length ? ` (+${validAttachments.length} attachment${validAttachments.length > 1 ? "s" : ""})` : ""}`,
    );
    return true;
  } catch (err) {
    log.error(`Email send failed for "${subject}": ${err.message}`);
    return false;
  }
}

module.exports = { sendNotification };
