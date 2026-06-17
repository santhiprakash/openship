/**
 * Send a welcome / verification test email from the freshly-provisioned
 * mail server to the operator's personal inbox.
 *
 * Path: nodemailer over SMTP submission against the mail VPS's public
 * endpoint (`mail.<installDomain>:465`, implicit TLS). The orchestrator
 * authenticates as `postmaster@<fromDomain>` with that domain's stored
 * plaintext password. The SMTP server signs DKIM, enforces SPF alignment,
 * queues the message, and dispatches it - same as any external SMTP
 * client would.
 *
 * Why nodemailer (vs. shelling sendmail on the mail VPS via SSH):
 *   1. The connection itself is the test. A failed AUTH means broken
 *      credentials, a TLS error means broken cert, a connect timeout
 *      means the SMTP daemon is down - all surface as real, distinct
 *      errors the operator can act on. The old sendmail-via-SSH path
 *      could "succeed" with the message stuck in the local queue forever.
 *   2. Reuses the same code path the platform will use for any future
 *      transactional mail (e.g. user-invite emails, alerts), so a working
 *      welcome test proves the whole pipeline, not just the local MTA.
 *   3. Real `Message-ID` comes back from the server's `250 OK` response,
 *      not a synthetic one we made up.
 *
 * The HTML body stays minimal: single column, plain colors, no images,
 * no tracking pixels. That's the shape Gmail/Outlook/Apple Mail's spam
 * classifiers reward on day one - and it doubles as the "do as we do"
 * example the message text points operators at. We don't tell operators
 * to "wait 24-48 hours for reputation to build"; we tell them to send
 * well-formed HTML through real SMTP submission (nodemailer / AUTH on
 * 465) so DKIM signs and SPF aligns from the first message.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { sshManager } from "../../../lib/ssh-manager";
import { readState } from "../mail-state";
import { safeErrorMessage } from "@repo/core";

const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

/**
 * Submission port. 465 (implicit TLS) over 587 (STARTTLS) because:
 *   - Both are universally supported by iRedMail's Postfix.
 *   - 465 keeps the entire conversation encrypted from the first byte -
 *     no plaintext EHLO leaks the server banner before the upgrade.
 *   - Skips the STARTTLS-stripping class of MITM attacks.
 *   - One fewer state machine to debug when something goes wrong.
 */
const SUBMISSION_PORT = 465;

export class TestEmailError extends Error {}

export interface SendTestEmailInput {
  to: string;
  /**
   * Send the welcome AS `postmaster@<fromDomain>`. Defaults to the primary
   * install domain. When the operator adds a new domain through the admin
   * panel we auto-create its postmaster with a known plaintext password
   * stored in `state.additionalDomains[fromDomain].postmasterPassword`;
   * this lets the welcome modal that follows the DNS-ack flow send a real
   * test FROM the new domain so DKIM signs, SPF aligns, and DMARC passes
   * against records the operator just published.
   */
  fromDomain?: string;
}

export interface SendTestEmailResult {
  to: string;
  from: string;
  messageId: string;
  /** Raw SMTP server response (`250 OK …`). Surfaced for debugging. */
  smtpResponse: string;
}

/**
 * Send the welcome message from `postmaster@<fromDomain>`.
 *
 * For the primary install: `fromDomain` defaults to `state.domain` and the
 * password lives in `state.secrets.DOMAIN_ADMIN_PASSWD_PLAIN` (the one
 * mailbox iRedMail's installer provisions automatically).
 *
 * For an additional domain added through the admin panel: we auto-create
 * postmaster on domain add (see [domains.service.createDomain](./domains.service.ts))
 * and stash the plaintext password in
 * `state.additionalDomains[fromDomain].postmasterPassword`. Sending AS the
 * additional domain is what makes the welcome flow that runs after the
 * operator acks the DNS banner an honest end-to-end test of the records
 * they just published.
 *
 * Submission always goes to `mail.<installDomain>:465` - every additional
 * domain shares the primary install's MX target (only hostname with an
 * SSL cert and SMTP-AUTH configured), per the SPF/MX records this module
 * publishes.
 *
 * Throws `TestEmailError` for user-facing failures; plain `Error` for
 * SMTP/network failures with `.cause` preserved so the controller can
 * surface diagnostics.
 */
export async function sendTestEmail(
  serverId: string,
  input: SendTestEmailInput,
): Promise<SendTestEmailResult> {
  const to = input.to.trim().toLowerCase();
  if (!EMAIL_RE.test(to) || to.length > 255) {
    throw new TestEmailError("Enter a valid email address");
  }

  const rawFromDomain = input.fromDomain?.trim().toLowerCase();
  if (rawFromDomain && !DOMAIN_RE.test(rawFromDomain)) {
    throw new TestEmailError(`Invalid sender domain: ${input.fromDomain}`);
  }

  const { installDomain, fromDomain, password } =
    await sshManager.withExecutor(serverId, async (exec) => {
      const state = await readState(exec);
      if (!state || !state.domain) {
        throw new TestEmailError(
          "Mail state not found - finish the install first.",
        );
      }
      const installDomain = state.domain;
      const fromDomain = rawFromDomain ?? installDomain;

      let password: string | undefined;
      if (fromDomain === installDomain) {
        password = state.secrets?.DOMAIN_ADMIN_PASSWD_PLAIN;
        if (!password) {
          throw new TestEmailError(
            "Postmaster credential is missing from state. Rotate the password from the admin panel and retry.",
          );
        }
      } else {
        const ad = state.additionalDomains?.[fromDomain];
        if (!ad) {
          throw new TestEmailError(
            `No saved DNS state for ${fromDomain} - add the domain through the Domains tab first.`,
          );
        }
        password = ad.postmasterPassword;
        if (!password) {
          throw new TestEmailError(
            `Postmaster credential for ${fromDomain} is missing - create a postmaster mailbox manually under that domain to enable test sends.`,
          );
        }
      }
      return { installDomain, fromDomain, password };
    });

  const from = `postmaster@${fromDomain}`;
  const smtpHost = `mail.${installDomain}`;

  // ── SMTP submission ─────────────────────────────────────────────────
  //
  // verify() runs CONNECT → EHLO → TLS check → AUTH dry-run, so a bad
  // cert, wrong password, or blocked port surfaces here before we burn
  // a queue slot. sendMail() then does MAIL FROM / RCPT TO / DATA / QUIT
  // and returns the server's actual 250 response.
  const transporter: Transporter = nodemailer.createTransport({
    host: smtpHost,
    port: SUBMISSION_PORT,
    secure: true,
    auth: { user: from, pass: password },
    // Timeouts kept short - the dashboard awaits this synchronously and
    // the operator is staring at a "Send test" spinner. If the mail VPS
    // takes longer than 15 s for AUTH, something is wrong and we want
    // the surface error, not the hang.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  try {
    await transporter.verify();
  } catch (err) {
    throw wrapSmtpError(
      err,
      `SMTP submission check failed against ${smtpHost}:${SUBMISSION_PORT}`,
    );
  }

  let info: { messageId: string; response: string };
  try {
    info = await transporter.sendMail({
      from: { name: "openship", address: from },
      to,
      subject: `Welcome - ${fromDomain} is live on your mail server`,
      text: plainTextBody({ from, domain: fromDomain }),
      html: htmlBody({ from, domain: fromDomain }),
      headers: { "X-Mailer": "openship-mail-admin" },
    });
  } catch (err) {
    throw wrapSmtpError(err, `Mail server accepted auth but rejected delivery`);
  } finally {
    transporter.close();
  }

  return {
    to,
    from,
    messageId: info.messageId,
    smtpResponse: info.response,
  };
}

// ─── Error helpers ──────────────────────────────────────────────────────────

function wrapSmtpError(err: unknown, prefix: string): Error {
  const message = safeErrorMessage(err);
  const wrapped = new Error(`${prefix}: ${message}`);
  if (err instanceof Error) {
    (wrapped as Error & { cause?: unknown }).cause = err;
  }
  return wrapped;
}

// ─── Message composition ─────────────────────────────────────────────────────

function plainTextBody(args: { from: string; domain: string }): string {
  const { from, domain } = args;
  return [
    `Hi there,`,
    ``,
    `Your self-hosted mail server at ${domain} is up and running. This message`,
    `was sent from ${from} directly through your own MTA - no third-party`,
    `relay involved. The fact that it reached your inbox means the basics`,
    `are wired correctly: DNS, TLS, DKIM, and SPF.`,
    ``,
    `To stay out of spam:`,
    ``,
    `  - Send well-formed HTML, not raw text dumps. Single column, real`,
    `    headings, plain colors, no inline images, no tracking pixels.`,
    `    That's the same shape this message uses - Gmail / Outlook / Apple`,
    `    Mail reward it on day one.`,
    ``,
    `  - Send through real SMTP submission, not by shelling sendmail on the`,
    `    host. nodemailer (or any library that does AUTH + DKIM + DATA over`,
    `    port 465) authenticates as a mailbox of ${domain} - that's what`,
    `    makes DKIM sign and SPF align against the records you just`,
    `    published. Use the SMTP credentials from the admin panel.`,
    ``,
    `  - Wire ${domain} into your application and start sending. Add more`,
    `    mailboxes from the Mailboxes tab when you need them.`,
    ``,
    `Welcome to running your own mail.`,
    ``,
    `- openship`,
  ].join("\r\n");
}

function htmlBody(args: { from: string; domain: string }): string {
  const { from, domain } = args;
  // Single-column, no images, no tracking pixels. Tables for max client
  // compat. Conservative color palette aligned with the dashboard.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your mail server is live</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f8;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;background:#ffffff;border:1px solid #e6e7eb;border-radius:14px;">
            <tr>
              <td style="padding:28px 32px 8px 32px;">
                <p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;font-weight:600;">openship mail</p>
                <h1 style="margin:0;font-size:22px;line-height:1.25;font-weight:700;color:#0a0a0a;letter-spacing:-0.3px;">Your mail server is live.</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 4px 32px;font-size:15px;line-height:1.6;color:#374151;">
                <p style="margin:0 0 14px;">This message was sent from <strong style="color:#0a0a0a;">${escapeHtml(from)}</strong> directly through your own MTA. No third-party relay involved.</p>
                <p style="margin:0 0 14px;">If it reached your inbox, the basics are wired up: DNS, TLS, DKIM and SPF are healthy.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
                  <tr>
                    <td style="padding:14px 16px 4px 16px;font-size:13.5px;line-height:1.55;color:#0f172a;">
                      <strong style="color:#0a0a0a;">To stay out of spam.</strong>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 16px 14px 16px;font-size:13px;line-height:1.6;color:#475569;">
                      Send well-formed HTML - single column, real headings, plain colors, no inline images, no tracking pixels. The same shape as this message. Then send through real SMTP submission (nodemailer or any library that does AUTH + DKIM + DATA over port 465) authenticated as a mailbox of <strong style="color:#0f172a;">${escapeHtml(domain)}</strong>. That's what makes DKIM sign and SPF align against the records you just published, and it's what keeps you out of spam from day one.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 4px 32px;font-size:14.5px;line-height:1.6;color:#374151;">
                <p style="margin:0 0 12px;">Wire <strong style="color:#0a0a0a;">${escapeHtml(domain)}</strong> into your application using the SMTP credentials from the admin panel, and add more mailboxes from the Mailboxes tab as you need them.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px;">
                <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">Welcome to running your own mail.<br/>- openship</p>
              </td>
            </tr>
          </table>
          <p style="margin:14px 0 0;font-size:11.5px;color:#9ca3af;">Sent from ${escapeHtml(domain)} • You received this because you provisioned this mail server.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
