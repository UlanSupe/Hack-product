/**
 * Handling of text that came from a seller (or from any model). Pure.
 *
 * Two jobs, neither of which is a security boundary on its own:
 *  1. `sanitizeUntrusted` removes what is invisible or dangerous to display (control characters, ANSI
 *     escapes, bidi overrides, zero-width characters) and bounds the length.
 *  2. `scanInjection` flags text that LOOKS like an attempt to instruct, impersonate or redirect. The
 *     flags are advisory: they make the buyer escalate to a human and they are recorded, but nothing
 *     relies on them. The real defences are structural: untrusted text never carries an amount, payee
 *     or authority, and the policy engine decides.
 */

// Zero-width, bidi override/isolate, soft hyphen, BOM, Mongolian vowel separator.
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200f], // zero-width space/joiners, direction marks
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0x00ad, 0x00ad], // soft hyphen
  [0x180e, 0x180e], // Mongolian vowel separator
];
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join("")}]`,
  "g",
);
// CSI sequences and two-character escapes.
// eslint-disable-next-line no-control-regex -- matching ESC is the point
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B[@-Z\\-_]/g;
// C0 and C1 controls except tab and newline.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * NFKC-normalizes (so full-width and compatibility look-alikes fold to plain characters), strips
 * control and invisible characters, collapses whitespace and truncates to `maxChars` with an ellipsis.
 * Never throws; non-strings become "".
 */
export function sanitizeUntrusted(input: unknown, maxChars: number): string {
  if (typeof input !== "string" || maxChars <= 0) return "";
  // Bound the work first: a hostile megabyte string costs the same as a short one.
  let s = input.slice(0, maxChars * 4 + 16).normalize("NFKC");
  s = s
    .replace(ANSI, "")
    .replace(INVISIBLE, "")
    .replace(CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length > maxChars) {
    let cut = s.slice(0, Math.max(0, maxChars - 1));
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // do not leave half a surrogate pair
    s = `${cut}…`;
  }
  return s;
}

export const INJECTION_SIGNALS = [
  "INSTRUCTION_OVERRIDE",
  "ROLE_SPOOF",
  "AUTHORITY_CLAIM",
  "PAYMENT_REDIRECT",
  "ACTION_REQUEST",
  "SECRET_PROBE",
  "URGENCY",
  "ENCODED_PAYLOAD",
] as const;
export type InjectionSignal = (typeof INJECTION_SIGNALS)[number];

const RULES: readonly (readonly [InjectionSignal, RegExp])[] = [
  [
    "INSTRUCTION_OVERRIDE",
    /\b(ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}\b(instructions?|rules?|polic(?:y|ies)|limits?|guidelines?|constraints?|mandate|checks?)\b/,
  ],
  ["INSTRUCTION_OVERRIDE", /\b(new|updated|real) (instructions?|rules|system prompt)\b/],
  ["INSTRUCTION_OVERRIDE", /\byou (must|should|will) (now )?(obey|comply|follow)\b/],
  ["ROLE_SPOOF", /(^|\n)\s*(system|assistant|developer|admin(istrator)?|operator|root)\s*[:>\]]/],
  ["ROLE_SPOOF", /<\|?\s*(im_start|im_end|system|assistant|user)\s*\|?>/],
  ["ROLE_SPOOF", /\[\/?\s*(inst|system|sys)\s*\]/],
  ["ROLE_SPOOF", /(^|\n)#{1,4}\s*(system|instructions?|new task)\b/],
  [
    "AUTHORITY_CLAIM",
    /\b(mandate|limit|budget|cap|threshold|policy)\b[^.\n]{0,40}\b(raised|increased|updated|changed|lifted|removed|expanded|now allows?)\b/,
  ],
  [
    "AUTHORITY_CLAIM",
    /\b(operator|user|owner|admin|manager|paypal|compliance|security)\b[^.\n]{0,30}\b(has |have |already )?(approved|authori[sz]ed|confirmed|cleared|pre-?approved)\b/,
  ],
  ["AUTHORITY_CLAIM", /\bpre-?(approved|authori[sz]ed)\b/],
  ["PAYMENT_REDIRECT", /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/],
  [
    "PAYMENT_REDIRECT",
    /paypal\.me\/|https?:\/\/|\bwww\.|\biban\b|\bbank (account|transfer|details)\b/,
  ],
  [
    "PAYMENT_REDIRECT",
    /\b(send|wire|transfer|pay|remit)\b[^.\n]{0,40}\b(to|into)\b[^.\n]{0,30}\b(account|wallet|address|backup)\b/,
  ],
  [
    "ACTION_REQUEST",
    /\b(capture|release|authori[sz]e|approve|confirm|execute)\b[^.\n]{0,30}\b(the )?(funds?|payment|order|transaction|mandate|purchase)\b/,
  ],
  [
    "SECRET_PROBE",
    /\b(reveal|print|show|repeat|leak|disclose|output)\b[^.\n]{0,40}\b(system prompt|prompt|instructions|api[ -]?key|secret|token|password|credentials?)\b/,
  ],
  ["URGENCY", /\b(urgent(ly)?|immediately|right now|last chance|final notice|act now|asap)\b/],
  ["URGENCY", /\b(expires?|ends?|offer valid)\b[^.\n]{0,20}\b\d+\s*(min|minutes|hours?|hrs?)\b/],
  ["ENCODED_PAYLOAD", /[a-z0-9+/]{60,}={0,2}/i],
];

/** Advisory flags for text that looks like an injection attempt. Sorted, unique. */
export function scanInjection(text: unknown): InjectionSignal[] {
  if (typeof text !== "string" || text.length === 0) return [];
  // Same folding the display path uses, so full-width or invisible-character tricks do not hide a phrase.
  const folded = sanitizeUntrusted(text, 20_000).toLowerCase();
  const found = new Set<InjectionSignal>();
  for (const [signal, pattern] of RULES) if (pattern.test(folded)) found.add(signal);
  return [...found].sort();
}
