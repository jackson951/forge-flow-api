import { randomBytes } from 'node:crypto';

/**
 * Email building and reading for Gmail (Part 26). Pure.
 *
 * Building: header values never contain CR/LF (header injection), non-ASCII header text is
 * RFC 2047 encoded, addresses are validated, bodies are base64. From is always the connected
 * mailbox. Reading: a Gmail message resource → the minimised message of FR-26.8 (text only,
 * size-capped; HTML converted to text; attachments by name only, never their content).
 */

export class EmailValidationError extends Error {}

/** A single address, optionally with a display name: `a@b.co` or `Name <a@b.co>`. */
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MAX_RECIPIENTS = 50;

function noLineBreaks(value: string, what: string): string {
  if (/[\r\n\0]/.test(value))
    throw new EmailValidationError(`${what} must not contain line breaks`);
  return value;
}

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeaderText(value: string): string {
  noLineBreaks(value, 'Header text');
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Parses a comma-separated recipient list into validated `Name <addr>` / `addr` entries. */
export function parseAddresses(value: string | undefined, what: string): string[] {
  if (!value?.trim()) return [];
  noLineBreaks(value, what);
  const parts = splitAddresses(value);
  if (parts.length > MAX_RECIPIENTS)
    throw new EmailValidationError(`At most ${MAX_RECIPIENTS} ${what} addresses`);
  return parts.map((part) => {
    const angle = /^(.*)<([^<>]+)>$/.exec(part);
    const address = (angle ? angle[2] : part).trim();
    if (!ADDRESS.test(address)) throw new EmailValidationError(`Invalid ${what} address`);
    const name = angle?.[1].trim().replace(/^"(.*)"$/, '$1');
    return name ? `${encodeHeaderText(name.replace(/["\\]/g, ''))} <${address}>` : address;
  });
}

/** Splits on commas outside quotes and angle brackets. */
function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === '<') angle = true;
    if (ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The bare address of `Name <a@b>` (lower-cased), for comparisons. */
export function bareAddress(value: string): string {
  return (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
}

export interface OutgoingEmail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

const wrap = (base64: string) => base64.replace(/.{1,76}/g, (line) => `${line}\r\n`).trimEnd();

/** RFC 5322 message with a text (and optional HTML) part, base64url-encoded for Gmail `raw`. */
export function buildRawEmail(email: OutgoingEmail): string {
  if (!email.to.length && !email.cc?.length && !email.bcc?.length) {
    throw new EmailValidationError('At least one recipient is required');
  }
  const headers = [
    `From: ${email.from}`,
    ...(email.to.length ? [`To: ${email.to.join(', ')}`] : []),
    ...(email.cc?.length ? [`Cc: ${email.cc.join(', ')}`] : []),
    ...(email.bcc?.length ? [`Bcc: ${email.bcc.join(', ')}`] : []),
    ...(email.replyTo?.length ? [`Reply-To: ${email.replyTo.join(', ')}`] : []),
    `Subject: ${encodeHeaderText(email.subject)}`,
    ...(email.inReplyTo ? [`In-Reply-To: ${noLineBreaks(email.inReplyTo, 'In-Reply-To')}`] : []),
    ...(email.references ? [`References: ${noLineBreaks(email.references, 'References')}`] : []),
    'MIME-Version: 1.0',
  ];
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(email.text, 'utf8').toString('base64')),
  ].join('\r\n');
  let body: string;
  if (email.html) {
    const boundary = `ff-${randomBytes(12).toString('hex')}`;
    body = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      textPart,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(email.html, 'utf8').toString('base64')),
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    body = textPart;
  }
  return Buffer.from(`${headers.join('\r\n')}\r\n${body}\r\n`, 'utf8').toString('base64url');
}

/** "Re: " once. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessageResource {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface NormalizedEmail {
  messageId: string;
  threadId: string | null;
  labelIds: string[];
  from: string | null;
  to: string | null;
  cc: string | null;
  replyTo: string | null;
  subject: string | null;
  snippet: string | null;
  date: string | null;
  textBody: string | null;
  textTruncated?: true;
  hasAttachments: boolean;
  attachmentNames: string[];
  /** RFC 822 Message-ID, for threading replies. */
  rfcMessageId: string | null;
  references: string | null;
  mailbox: string;
}

const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** Minimal HTML → text: drops scripts/styles, keeps line structure, decodes common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeMessage(
  message: GmailMessageResource,
  mailbox: string,
  maxChars: number,
): NormalizedEmail {
  const headers = new Map<string, string>();
  for (const h of message.payload?.headers ?? []) {
    if (h.name && h.value !== undefined && !headers.has(h.name.toLowerCase())) {
      headers.set(h.name.toLowerCase(), h.value.slice(0, 2_000));
    }
  }
  let text = '';
  let html = '';
  const attachments: string[] = [];
  const walk = (part: GmailPart | undefined, depth = 0) => {
    if (!part || depth > 10) return;
    if (part.filename) {
      if (attachments.length < 20) attachments.push(part.filename.slice(0, 200));
      return; // attachment content is never read or stored
    }
    if (part.mimeType === 'text/plain' && !text) text = decode(part.body?.data);
    else if (part.mimeType === 'text/html' && !html) html = decode(part.body?.data);
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(message.payload);
  const full = text || (html ? htmlToText(html) : '');
  const truncated = full.length > maxChars;
  const internal = Number(message.internalDate);
  return {
    messageId: String(message.id ?? ''),
    threadId: message.threadId ?? null,
    labelIds: (message.labelIds ?? []).slice(0, 50),
    from: headers.get('from') ?? null,
    to: headers.get('to') ?? null,
    cc: headers.get('cc') ?? null,
    replyTo: headers.get('reply-to') ?? null,
    subject: headers.get('subject') ?? null,
    snippet: message.snippet?.slice(0, 500) ?? null,
    date: Number.isFinite(internal)
      ? new Date(internal).toISOString()
      : (headers.get('date') ?? null),
    textBody: full ? full.slice(0, maxChars) : null,
    ...(truncated && { textTruncated: true as const }),
    hasAttachments: attachments.length > 0,
    attachmentNames: attachments,
    rfcMessageId: headers.get('message-id') ?? null,
    references: headers.get('references') ?? null,
    mailbox,
  };
}

/** What triggers and actions store: the minimised message without threading-only headers. */
export function emailOutput(
  email: NormalizedEmail,
): Omit<NormalizedEmail, 'rfcMessageId' | 'references'> {
  const { rfcMessageId, references, ...output } = email;
  void rfcMessageId;
  void references;
  return output;
}
