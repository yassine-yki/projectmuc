// Supabase Auth enforces a six-character minimum even when a project requests less.
// Keep the user's chosen password unchanged in the UI and derive the Auth credential
// identically on account creation and sign-in. This does not add password entropy.
export async function deriveAuthPassword(identifier: string, password: string): Promise<string> {
  const email = identifier.trim().toLowerCase();
  const input = new TextEncoder().encode(`muc-password-v1\u0000${email}\u0000${password}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `MUC1!Aa0${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

type SignInResult = { error: { code?: string; message?: string } | null };

// Accounts created before this scheme still have their original Supabase password.
export async function signInWithCompatiblePassword<T extends SignInResult>(
  identifier: string,
  password: string,
  signIn: (credential: string) => Promise<T>,
): Promise<T> {
  const current = await signIn(await deriveAuthPassword(identifier, password));
  if (!current.error) return current;
  const code = current.error.code?.toLowerCase();
  if (code !== "invalid_credentials" && !/invalid login credentials/i.test(current.error.message || "")) return current;
  return signIn(password);
}
