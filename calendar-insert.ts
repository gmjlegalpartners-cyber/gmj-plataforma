// ============================================================
// GMJ — Edge Function: calendar-insert
// Crea el evento de audiencia de mediación AUTOMÁTICAMENTE en el
// calendario de cada usuario seleccionado (que haya conectado su Google).
// Recibe POST { invitados:[emails], title, startISO, endISO, details, location }
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // verificar que quien llama esté autenticado
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "no-auth" }, 401);

  const body = await req.json();
  // invitados = lista de user_id (uuid). eventos = { user_id: eventId } de eventos ya creados (para ACTUALIZAR).
  const { invitados = [], title, startISO, endISO, details = "", location = "", eventos = {} } = body;
  if (!title || !startISO || !endISO) return json({ error: "faltan-datos" }, 400);

  const results: { email: string; ok: boolean; link?: string; reason?: string }[] = [];
  const nuevosEventos: Record<string, string> = {};

  const eventBody = {
    summary: title,
    description: details,
    location,
    start: { dateTime: startISO, timeZone: "America/Argentina/Buenos_Aires" },
    end: { dateTime: endISO, timeZone: "America/Argentina/Buenos_Aires" },
    reminders: { useDefault: true },
  };

  for (const userId of invitados) {
    if (!userId) continue;
    // token de Google de ese usuario (guardado al conectar su cuenta)
    const { data: tk } = await admin.from("google_tokens").select("*").eq("user_id", userId).maybeSingle();
    const email = tk?.email || userId;
    if (!tk?.refresh_token) {
      results.push({ email, ok: false, reason: "sin-google-conectado" });
      continue;
    }
    try {
      const access = await refreshToken(tk.refresh_token);
      const existingId = eventos[userId];
      let ev;
      if (existingId) {
        // ACTUALIZAR el evento existente (no crear duplicado)
        ev = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${existingId}?sendUpdates=all`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
          body: JSON.stringify(eventBody),
        }).then((r) => r.json());
      }
      if (!ev || !ev.id) {
        // crear nuevo (si no había, o si el PATCH falló porque se borró)
        ev = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
          method: "POST",
          headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
          body: JSON.stringify(eventBody),
        }).then((r) => r.json());
      }
      if (ev.id) { results.push({ email, ok: true, link: ev.htmlLink }); nuevosEventos[userId] = ev.id; }
      else results.push({ email, ok: false, reason: ev.error?.message || "error-calendar" });
    } catch (e) {
      results.push({ email, ok: false, reason: String(e) });
    }
  }
  return json({ ok: true, results, eventos: nuevosEventos });
});

async function refreshToken(refresh_token: string): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token, grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("no-access-token");
  return j.access_token;
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
