/**
 * Minimal `.env` parser — the core of a paste/upload flow, without any UI.
 * Skips blanks + comments, splits on the first `=`, unwraps single/double
 * quotes, and strips trailing inline comments from unquoted values. Only
 * accepts valid shell identifiers as keys.
 */
export function parseDotenv(content: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      const close = value.indexOf('"', 1);
      value = close !== -1 ? value.slice(1, close) : value.slice(1);
    } else if (value.startsWith("'")) {
      const close = value.indexOf("'", 1);
      value = close !== -1 ? value.slice(1, close) : value.slice(1);
    } else {
      const comment = value.match(/\s+#/);
      if (comment && comment.index !== undefined) value = value.slice(0, comment.index).trim();
    }

    out.push({ key, value });
  }
  return out;
}
