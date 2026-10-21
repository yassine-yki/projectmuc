import assert from "node:assert/strict";
import test from "node:test";
import { deriveAuthPassword, signInWithCompatiblePassword } from "../supabase/functions/_shared/password-credential.js";

test("three-character passwords produce stable Supabase credentials without changing the user's input", async () => {
  const first = await deriveAuthPassword(" Person@Users.Pistache.Invalid ", "abc");
  assert.match(first, /^MUC1!Aa0[a-f0-9]{64}$/);
  assert.equal(first, await deriveAuthPassword("person@users.pistache.invalid", "abc"));
  assert.notEqual(first, await deriveAuthPassword("person@users.pistache.invalid", "abd"));
  assert.notEqual(first, await deriveAuthPassword("other@users.pistache.invalid", "abc"));
});

test("new accounts sign in with derived credentials, while older accounts fall back to their original password", async () => {
  const email = "person@users.pistache.invalid";
  const derived = await deriveAuthPassword(email, "abc");
  const calls: string[] = [];
  const signIn = async (credential: string) => {
    calls.push(credential);
    return { error: credential === derived ? null : {code:"invalid_credentials",message:"Invalid login credentials"} };
  };
  assert.equal((await signInWithCompatiblePassword(email,"abc",signIn)).error,null);
  assert.deepEqual(calls,[derived]);

  calls.length=0;
  const legacy = async (credential: string) => {
    calls.push(credential);
    return { error: credential === "old-password" ? null : {code:"invalid_credentials",message:"Invalid login credentials"} };
  };
  assert.equal((await signInWithCompatiblePassword(email,"old-password",legacy)).error,null);
  assert.deepEqual(calls,[await deriveAuthPassword(email,"old-password"),"old-password"]);
});
