const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd)\s*[:=]\s*\S+|(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,})/iu;

export function containsLikelySecret(content: string): boolean {
  return SECRET_PATTERN.test(content);
}
