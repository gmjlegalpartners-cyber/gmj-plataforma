// ============================================================
// GMJ — Edge Function: google-oauth
// Conecta el Google Calendar de cada usuario (autorización única).
// Flujo: el usuario hace clic en "Conectar Google" -> ?start=1 (con su JWT)
//        -> redirige al consentimiento de Google -> Google vuelve con ?code
//        -> guardamos el refresh_token para ese usuario.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const REDIRECT_URI = Deno.env.get("GOOGLE_REDIRECT_URI")!; // = URL pública de esta función
const APP_URL = Deno.env.get("APP_URL") || "/";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // PASO 1: el frontend pide la URL de consentimiento (manda el JWT del usuario)
  if (url.searchParams.get("start")) {
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: "no-auth" }, 401);
    const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    consent.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    consent.searchParams.set("redirect_uri", REDIRECT_URI);
    consent.searchParams.set("response_type", "code");
    consent.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email");
    consent.searchParams.set("access_type", "offline");
    consent.searchParams.set("prompt", "consent");
    consent.searchParams.set("state", u.user.id);
    return json({ url: consent.toString() });
  }

  // PASO 2: Google vuelve con el code
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state"); // = user id
  if (code && state) {
    const tok = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: "authorization_code",
      }),
    }).then((r) => r.json());

    if (!tok.refresh_token) {
      return redirect(`${APP_URL}#google=error`);
    }
    // email del usuario de Google
    let email = "";
    try {
      const info = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      }).then((r) => r.json());
      email = info.email || "";
    } catch (_) { /* opcional */ }

    await admin.from("google_tokens").upsert({
      user_id: state, email, refresh_token: tok.refresh_token, updated_at: new Date().toISOString(),
    });
    return redirect(`${APP_URL}#google=ok`);
  }

  return json({ error: "bad-request" }, 400);
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function redirect(to: string) {
  return new Response(null, { status: 302, headers: { ...cors, Location: to } });
}
