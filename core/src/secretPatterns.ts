/**
 * Text that looks like a credential. The diff scan blocks a change that adds such a line, and
 * anything core shows of an agent's own words is cleaned with `redactSecrets` first.
 */

/** Formats of real credentials, by issuer. Named, so a flag can say what it looks like without repeating it. */
export const SECRET_VALUES: Array<[string, RegExp]> = [
  ['a private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['a Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['a connection string with a password', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/'"]+:[^\s@/'"]{6,}@/],
];

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g;
const ASSIGNED = /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*)\s*[=:]\s*["']?[^\s"']{8,}/gi;

/** `text` with every secret-looking part replaced by a plain marker. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [, pattern] of SECRET_VALUES) out = out.replace(new RegExp(pattern.source, 'g'), '[hidden]');
  return out.replace(BEARER, '$1 [hidden]').replace(ASSIGNED, '$1=[hidden]');
}
