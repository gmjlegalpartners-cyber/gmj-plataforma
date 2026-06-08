// ============================================================
// GMJ — Edge Function: public-form
// Permite al CLIENTE (sin login) cargar el formulario y que impacte
// directamente en el expediente compartido del estudio.
//   GET  ?token=XXXX           -> devuelve datos para precargar el formulario
//   POST { token, cliente, cuenta, relato, adjuntos } -> guarda en el caso
// Usa service_role, por lo que sólo accede al caso cuyo token coincide.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const url = new URL(req.url);

  // ---------- GET: precarga ----------
  if (req.method === "GET") {
    const token = url.searchParams.get("token");
    if (!token) return json({ error: "sin-token" }, 400);
    const { data: row } = await admin.from("casos").select("id,data").eq("form_token", token).maybeSingle();
    if (!row) return json({ error: "no-encontrado" }, 404);
    const c = row.data || {};
    return json({
      ok: true,
      cliente: c.cliente || {}, cuenta: c.cuenta || {}, relato: c.relato || {},
      adjuntos: (c.adjuntos || []).map((a: any) => ({ tipo: a.tipo })),
    });
  }

  // ---------- POST: el cliente envía el formulario ----------
  if (req.method === "POST") {
    const body = await req.json();
    const { token, cliente, cuenta, relato, adjuntos } = body;
    if (!token) return json({ error: "sin-token" }, 400);
    const { data: row } = await admin.from("casos").select("*").eq("form_token", token).maybeSingle();
    if (!row) return json({ error: "no-encontrado" }, 404);

    const c = row.data || {};
    c.cliente = { ...(c.cliente || {}), ...(cliente || {}) };
    c.cuenta = { ...(c.cuenta || {}), ...(cuenta || {}) };
    c.relato = { ...(c.relato || {}), ...(relato || {}) };
    c.adjuntos = c.adjuntos || [];
    for (const a of (adjuntos || [])) {
      c.adjuntos = c.adjuntos.filter((x: any) => x.tipo !== a.tipo || a.tipo === "Otra documentación");
      c.adjuntos.push({ tipo: a.tipo, nombre: a.nombre || a.tipo, fecha: new Date().toISOString().slice(0, 10) });
    }
    // gastos por defecto si faltan
    if (!c.gastos || !c.gastos.length) {
      c.gastos = ["Mediación", "Honorarios del mediador"].map((n) => ({
        id: "g" + Math.random().toString(36).slice(2, 8), nombre: n, estado: "pendiente",
        importe: "", moneda: "ARS", fecha: "", medio: "", obs: "", adjunto: "",
      }));
    }
    c.historial = c.historial || [];
    c.historial.unshift({ accion: "Formulario completado por el cliente", usuario: "cliente", fecha: now() });

    await admin.from("casos").update({
      data: c, cliente_nombre: ((c.cliente?.apellido || "") + " " + (c.cliente?.nombre || "")).trim(),
      estado: "Formulario completado", updated_at: new Date().toISOString(),
    }).eq("id", row.id);

    return json({ ok: true });
  }

  return json({ error: "metodo" }, 405);
});

function now() {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
