const ROLE_NAME_NEEDS_QUOTE_RE = /(^\s|\s$|^"|[\u0000-\u001f]|\.{3}|\s+in\s+(?:#|@|[a-z][a-z0-9_-]*:))/i;

export function formatRoleName(name: string): string {
  return ROLE_NAME_NEEDS_QUOTE_RE.test(name) ? JSON.stringify(name) : name;
}

export function formatRoleSelector(role: string, name: string): string {
  return `${role.toLowerCase()}:${formatRoleName(name)}`;
}
