/** Parse ALLOWED_USERS (comma-separated emails) into a lowercase set. */
export function getAllowedUsers(): Set<string> {
  const raw = process.env.ALLOWED_USERS?.trim() ?? "";
  if (!raw) return new Set();

  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAllowedUsers().has(email.trim().toLowerCase());
}
