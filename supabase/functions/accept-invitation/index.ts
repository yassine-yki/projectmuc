import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { deriveAuthPassword } from "../_shared/password-credential.ts";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
const respond = (body: object, status = 200) => Response.json(body, { status, headers });
Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return respond({error:"Méthode non autorisée."},405);
  try {
    const text = await request.text();
    if(text.length>4096)return respond({error:"Requête trop longue."},400);
    const {token,username:input,password}=JSON.parse(text);
    const username=typeof input==="string"?input.trim().toLowerCase():"";
    if(typeof token!=="string" || !/^[a-f0-9]{64}$/.test(token))return respond({error:"Invitation invalide."},400);
    if(!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username))return respond({error:"Nom d’utilisateur : 3 à 32 lettres, chiffres, points, tirets ou underscores."},400);
    if(typeof password!=="string"||password.length<3)return respond({error:"Le mot de passe doit contenir au moins 3 caractères. Le lien d’invitation reste valide."},400);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,"0")).join("");
    const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:inv,error:lookup}=await admin.from("account_invitations").select("id,expires_at,used_at,revoked_at").eq("token_hash",hash).maybeSingle();
    if(lookup||!inv||inv.used_at||inv.revoked_at||Date.parse(inv.expires_at)<=Date.now())return respond({error:"Lien expiré, révoqué ou déjà utilisé. Demandez une nouvelle invitation à l’admin."},400);
    // No real email is collected or sent. This internal identifier lets Supabase manage passwords.
    const email=username+"@users.pistache.invalid";
    const authPassword=await deriveAuthPassword(email,password);
    const {data:created,error}=await admin.auth.admin.createUser({email,password:authPassword,email_confirm:true,
      user_metadata:{display_name:username},app_metadata:{invitation_hash:hash,username}});
    if(error) {
      const code=String(error.code||"").toLowerCase();
      const detail=String(error.message||"").toLowerCase();
      if(code.includes("email_exists")||code.includes("user_already_exists")||detail.includes("already been registered")||detail.includes("already registered"))
        return respond({error:"Ce nom d’utilisateur est déjà utilisé. Choisissez-en un autre ; votre lien d’invitation reste valide."},409);
      if(code.includes("weak_password")||detail.includes("password"))
        return respond({error:"Supabase a refusé ce mot de passe. Le lien d’invitation reste valide ; contactez l’admin si le problème continue."},400);
      if(detail.includes("invitation_invalid"))
        return respond({error:"Lien expiré, révoqué ou déjà utilisé. Demandez une nouvelle invitation à l’admin."},400);
      console.error("accept-invitation createUser failed",{code:error.code,status:error.status,message:error.message});
      return respond({error:"La création du compte a échoué, mais le lien n’a pas été consommé. Réessayez ; si le problème continue, contactez l’admin."},400);
    }
    const userId=created.user?.id;
    if(!userId)return respond({error:"Supabase n’a pas renvoyé le compte créé. Le lien reste disponible ; contactez l’admin."},500);
    const {error:completionError}=await admin.rpc("complete_account_invitation",{p_token_hash:hash,p_user_id:userId,p_username:username});
    if(completionError) {
      const {error:cleanupError}=await admin.auth.admin.deleteUser(userId);
      console.error("complete_account_invitation failed",{code:completionError.code,message:completionError.message,cleanup:cleanupError?.message});
      const detail=String(completionError.message||"").toLowerCase();
      if(detail.includes("duplicate")||completionError.code==="23505")
        return respond({error:"Ce nom d’utilisateur est déjà utilisé. Choisissez-en un autre ; votre lien d’invitation reste valide."},409);
      if(detail.includes("invitation_invalid"))
        return respond({error:"Lien expiré, révoqué ou déjà utilisé. Demandez une nouvelle invitation à l’admin."},400);
      return respond({error:"Le profil n’a pas pu être finalisé. Le compte incomplet a été annulé et le lien reste disponible. Contactez l’admin."},500);
    }
    return respond({created:true});
  } catch { return respond({error:"Impossible de créer le compte. Réessayez ou contactez l’admin."},400); }
});
