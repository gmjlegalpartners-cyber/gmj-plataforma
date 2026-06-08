// ============================================================
// GMJ — Edge Function: drive-sync
// Crea la carpeta individual del cliente en Google Drive (con subcarpetas)
// y sube archivos reales. La carpeta vive en el Drive de la cuenta del estudio
// (DRIVE_OWNER_EMAIL), que debe haber conectado su Google (scope drive.file).
//
// POST autenticado (staff)  -> { casoId, action:"folder" | "upload", ... }
// POST con formToken (cliente, sin login) -> { formToken, action, ... }
//
// action "folder": asegura carpeta + subcarpetas, guarda link en el caso.
// action "upload": { tipo, nombre, mime, base64 } -> sube a la subcarpeta que
//                  corresponde y agrega el adjunto (con link) al caso.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DRIVE_OWNER_EMAIL = Deno.env.get("DRIVE_OWNER_EMAIL") || "gmjlegalpartners@gmail.com";

const SUBCARPETAS = ["01 - Datos del cliente","02 - DNI","03 - Pruebas y capturas","04 - Mediación","05 - Documentación generada","06 - Contrato y poder","07 - Comprobantes de pago"];
function subForTipo(t: string): string {
  t = (t || "").toLowerCase();
  if (t.includes("dni")) return "02 - DNI";
  if (t.includes("comprobante de pago")) return "07 - Comprobantes de pago";
  if (t.includes("contrato") || t.includes("poder")) return "06 - Contrato y poder";
  if (t.includes("mediaci")) return "04 - Mediación";
  if (t.includes("captura") || t.includes("prueba") || t.includes("conversaci") || t.includes("otra")) return "03 - Pruebas y capturas";
  return "03 - Pruebas y capturas";
}
function folderName(c: any): string {
  const ap = (c.cliente?.apellido || "APELLIDO").toUpperCase();
  const no = c.cliente?.nombre || "Nombre";
  const plat = c.cuenta?.plataforma || "Instagram";
  return `${ap}, ${no} - Cuenta ${plat} - Reclamo Meta`;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  try {
    const body = await req.json();
    const { casoId, formToken, action } = body;

    // resolver el caso (por formToken anónimo, o por casoId con usuario autenticado)
    let row;
    if (formToken) {
      const r = await admin.from("casos").select("*").eq("form_token", formToken).maybeSingle();
      row = r.data;
    } else {
      const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      const { data: u } = await admin.auth.getUser(jwt);
      if (!u?.user) return json({ error: "no-auth" }, 401);
      const r = await admin.from("casos").select("*").eq("id", casoId).maybeSingle();
      row = r.data;
    }
    if (!row) return json({ error: "caso-no-encontrado" }, 404);

    // token de Drive del estudio
    const { data: tk } = await admin.from("google_tokens").select("*").eq("email", DRIVE_OWNER_EMAIL).maybeSingle();
    if (!tk?.refresh_token) return json({ error: "drive-no-conectado", detail: `Conectá el Google de ${DRIVE_OWNER_EMAIL} (Configuración -> Conectar mi Google Calendar).` }, 400);
    const access = await refreshToken(tk.refresh_token);

    const c = row.data || {};
    c.drive = c.drive || {};

    // asegurar carpeta + subcarpetas (dentro de la carpeta padre del estudio)
    if (!c.drive.folderId) {
      const parentId = await ensureParent(access);
      const fid = await createFolder(access, folderName(c), parentId);
      const subs: Record<string, string> = {};
      for (const s of SUBCARPETAS) subs[s] = await createFolder(access, s, fid);
      await makeReadableByLink(access, fid);
      c.drive = { creada: true, folderId: fid, subs, link: `https://drive.google.com/drive/folders/${fid}` };
      await admin.from("casos").update({ data: c, updated_at: new Date().toISOString() }).eq("id", row.id);
    }

    if (action === "upload") {
      const { tipo, nombre, mime, base64 } = body;
      if (!base64) return json({ error: "sin-archivo" }, 400);
      const sub = subForTipo(tipo);
      const parentId = (c.drive.subs && c.drive.subs[sub]) || c.drive.folderId;
      const up = await uploadFile(access, nombre || "archivo", mime || "application/octet-stream", base64, parentId);
      c.adjuntos = c.adjuntos || [];
      c.adjuntos = c.adjuntos.filter((a: any) => !(a.tipo === tipo && tipo !== "Otra documentación"));
      c.adjuntos.push({ tipo, nombre: nombre || tipo, fecha: new Date().toISOString().slice(0, 10), link: up.webViewLink });
      await admin.from("casos").update({ data: c, updated_at: new Date().toISOString() }).eq("id", row.id);
      return json({ ok: true, link: up.webViewLink, drive: c.drive });
    }

    return json({ ok: true, drive: c.drive });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

const PARENT_NAME = "GMJ LEGAL - CLIENTES FORM";
async function ensureParent(access: string): Promise<string> {
  const q = encodeURIComponent(`name='${PARENT_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${access}` },
  }).then((x) => x.json());
  if (r.files && r.files.length) return r.files[0].id;
  return await createFolder(access, PARENT_NAME, null);
}
async function createFolder(access: string, name: string, parent: string | null): Promise<string> {
  const meta: any = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parent) meta.parents = [parent];
  const r = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  }).then((x) => x.json());
  if (!r.id) throw new Error("no-folder:" + JSON.stringify(r));
  return r.id;
}
async function uploadFile(access: string, name: string, mime: string, base64: string, parentId: string) {
  // decodificar base64 -> bytes reales
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const boundary = "gmj" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [parentId] });
  const enc = new TextEncoder();
  const pre = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const post = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(pre.length + bytes.length + post.length);
  body.set(pre, 0); body.set(bytes, pre.length); body.set(post, pre.length + bytes.length);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  }).then((x) => x.json());
  if (!r.id) throw new Error("no-upload:" + JSON.stringify(r));
  return r;
}
async function makeReadableByLink(access: string, fileId: string) {
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
  } catch (_) { /* opcional */ }
}
async function refreshToken(refresh_token: string): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("no-access-token");
  return j.access_token;
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
