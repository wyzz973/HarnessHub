/**
 * Secret values masked out of text shown to the user, such as the diff of a configuration file (ADR-045 §3: changes are
 * shown with secrets masked). Masked: the value of any key whose name looks like a credential, the shapes of common
 * tokens, the argument after a credential-looking flag, and a URL's user information and query. Only display text is
 * masked; what is written is checked byte for byte elsewhere. A secret of no recognizable name or shape can still show.
 */
const MASK = "•••";
const SECRET_KEY = "[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credential|auth|cookie|session|bearer|private|signature)[A-Za-z0-9_.-]*";
const KEYED = [
  // "apiKey": "x" · 'token': 'x' · API_KEY = "x" · secret: "x"
  new RegExp("([\"']?" + SECRET_KEY + "[\"']?\\s*[:=]\\s*)(\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*')", "giu"),
  // token: x · API_KEY=x (unquoted YAML or environment values up to the end of the value); references, numbers and booleans stay
  new RegExp("(^|[\\s{,])(" + SECRET_KEY + "\\s*[:=]\\s*)(?![\\s\"'\\[{$~]|\\d+(?:\\.\\d+)?(?![^\\s,}#])|(?:true|false|null)(?![^\\s,}#]))((?:Bearer|Basic|Token)\\s+)?([^\\s,}#]+)", "gimu"),
];
const SHAPES = [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/gu, /\bgh[pousr]_[A-Za-z0-9]{16,}/gu, /\bgithub_pat_[A-Za-z0-9_]{16,}/gu, /\bxox[abprs]-[A-Za-z0-9-]{8,}/gu, /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{20,}/gu, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/gu];
const FLAG = /((?:^|[\s"',[])--?(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|auth(?:orization)?|bearer|cookie)(?:\s*=\s*|\s+|["']\s*,\s*["']))([^\s"',\]]+)/giu;

export function maskSecrets(text: string): string {
  let out = text;
  out = out.replace(/(https?:\/\/)[^\s/@"']+@/giu, "$1" + MASK + "@");
  out = out.replace(/(https?:\/\/[^\s"'?#]+)\?[^\s"'#]*/giu, "$1?" + MASK);
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gu, "$1" + MASK);
  out = out.replace(KEYED[0]!, (whole: string, key: string, value: string) => /^["'](?:\$\{|\$[A-Za-z_]|\{env:|\{file:|\d+["']$)/u.test(value) ? whole : key + value[0] + MASK + value[0]);
  out = out.replace(KEYED[1]!, (_, lead: string, key: string) => lead + key + MASK);
  out = out.replace(FLAG, (_, flag: string) => flag + MASK);
  for (const shape of SHAPES) out = out.replace(shape, MASK);
  return out;
}
