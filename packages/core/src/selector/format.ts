const ROLE_NAME_NEEDS_QUOTE_RE = /(^\s|\s$|^"|[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]|\.{3}|\s+in\s+(?:#|@|[a-z][a-z0-9_-]*:))/i;
const EXTRA_JSON_ESCAPE_RE = /[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g;

export function formatRoleName(name: string): string {
  return ROLE_NAME_NEEDS_QUOTE_RE.test(name) ? quoteRoleName(name) : name;
}

export function formatRoleSelector(role: string, name: string): string {
  return `${role.toLowerCase()}:${formatRoleName(name)}`;
}

function quoteRoleName(name: string): string {
  return JSON.stringify(name).replace(EXTRA_JSON_ESCAPE_RE, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
