/**
 * Hiding credentials in values shown to people (CLI output, logs). Display
 * only: never pass a sanitized value to a connection.
 */

/** What replaces a credential. */
export const MASK = "***";

/** Shown instead of a connection string that cannot be parsed, so nothing leaks from it. */
export const HIDDEN_CONNECTION_STRING = "(connection string hidden)";

/**
 * Query parameters that carry credentials, compared case-insensitively after
 * percent-decoding (`pg` reads `password`, and passes others such as
 * `sslpassword` on; other drivers use `pwd`, `token`, …).
 */
const SECRET_PARAMETER =
  /^(pass(word)?|passwd|pwd|sslpassword|sslkey|secret|client[-_]?secret|token|access[-_]?token|auth[-_]?token|api[-_]?key|key)$/i;

/**
 * A URL-style connection string with its user-info password and every
 * credential query value (including repeated ones) replaced by `***`. Anything
 * that does not parse as a URL is replaced as a whole.
 */
export function sanitizeConnectionString(value: string): string {
  return sanitizeUrl(value) ?? HIDDEN_CONNECTION_STRING;
}

/**
 * `value` with credentials masked if it is a URL (`scheme://…`); undefined if
 * it is not one. Values without credentials come back unchanged.
 */
export function sanitizeUrl(value: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  let changed = false;
  if (url.password) {
    url.password = MASK;
    changed = true;
  }
  const parameters = [...url.searchParams];
  if (parameters.some(([name]) => SECRET_PARAMETER.test(name))) {
    url.search = new URLSearchParams(
      parameters.map(([name, item]) => [name, SECRET_PARAMETER.test(name) ? MASK : item]),
    ).toString();
    changed = true;
  }
  return changed ? url.toString() : value;
}

/** Masks credentials in every URL inside free text, e.g. an error message. */
export function sanitizeText(text: string): string {
  return text.replace(
    /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,
    (match) => sanitizeUrl(match) ?? HIDDEN_CONNECTION_STRING,
  );
}
