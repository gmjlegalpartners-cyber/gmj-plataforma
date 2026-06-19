// ============================================================
// GMJ — Edge Function: drive-sync (con RED DE RESPALDO)
// - action "upload": guarda SIEMPRE una copia del archivo en Supabase Storage
//   (bucket case-files) y, si el Google del estudio está conectado, lo sube
//   también a Google Drive. Así nunca se pierde un adjunto aunque Drive falle.
// - action "folder": asegura la carpeta + subcarpetas del caso en Drive.
// - action "repush": reintenta subir a Drive los respaldos que aún no están en Drive.
// La carpeta vive en la Unidad compartida (DRIVE_SHARED_ID) de la cuenta del estudio.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DRIVE_OWNER_EMAIL = Deno.env.get("DRIVE_OWNER_EMAIL") || "gmjlegalpartners@gmail.com";
const DRIVE_SHARED_ID = Deno.env.get("DRIVE_SHARED_ID") || "";
const ALLDRIVES = "supportsAllDrives=true&includeItemsFromAllDrives=true";
const BUCKET = "case-files"; // respaldo de adjuntos

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
function safeName(n: string): string { return (n || "archivo").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(0, 120); }
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob((b64 || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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
    let row: any;
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

    const c = row.data || {};
    c.drive = c.drive || {};
    c.adjuntos = c.adjuntos || [];

    // token de Drive del estudio (puede faltar: en ese caso igual guardamos respaldo)
    let access: string | null = null;
    try {
      const { data: tk } = await admin.from("google_tokens").select("*").eq("email", DRIVE_OWNER_EMAIL).maybeSingle();
      if (tk?.refresh_token) access = await refreshToken(tk.refresh_token);
    } catch (_) { access = null; }

    // ---------- UPLOAD (respaldo siempre + Drive si se puede) ----------
    if (action === "upload") {
      const { tipo, nombre, mime, base64 } = body;
      if (!base64) return json({ error: "sin-archivo" }, 400);
      const bytes = b64ToBytes(base64);
      const ct = mime || "application/octet-stream";
      const storagePath = `${row.id}/${Date.now()}_${safeName(nombre)}`;

      // 1) RESPALDO en Supabase Storage (no se pierde aunque Drive falle)
      let backupOk = false;
      try {
        const { error: se } = await admin.storage.from(BUCKET).upload(storagePath, bytes, { contentType: ct, upsert: true });
        backupOk = !se;
      } catch (_) { backupOk = false; }

      // 2) DRIVE (best-effort)
      let driveLink: string | null = null;
      if (access) {
        try {
          await ensureFolder(access, c, row.id, admin);
          const sub = subForTipo(tipo);
          const parentId = (c.drive.subs && c.drive.subs[sub]) || c.drive.folderId;
          const up = await uploadBytes(access, safeName(nombre), ct, bytes, parentId);
          driveLink = up.webViewLink || null;
        } catch (_) { driveLink = null; }
      }

      // 3) registrar adjunto
      c.adjuntos = c.adjuntos.filter((a: any) => !(a.tipo === tipo && tipo !== "Otra documentación"));
      const adj: any = { tipo, nombre: nombre || tipo, fecha: new Date().toISOString().slice(0, 10) };
      if (driveLink) adj.link = driveLink;
      if (backupOk) adj.respaldo = storagePath;
      c.adjuntos.push(adj);
      await admin.from("casos").update({ data: c, updated_at: new Date().toISOString() }).eq("id", row.id);
      return json({ ok: true, backup: backupOk, drive: !!driveLink, link: driveLink });
    }

    // ---------- FOLDER ----------
    if (action === "folder") {
      if (!access) return json({ error: "drive-no-conectado", detail: `Conectá el Google de ${DRIVE_OWNER_EMAIL} (Configuración -> Conectar mi Google).` }, 400);
      await ensureFolder(access, c, row.id, admin);
      return json({ ok: true, drive: c.drive });
    }

    // ---------- REPUSH (reintentar respaldos a Drive) ----------
    if (action === "repush") {
      if (!access) return json({ error: "drive-no-conectado", detail: `Conectá el Google de ${DRIVE_OWNER_EMAIL} (Configuración -> Conectar mi Google).` }, 400);
      await ensureFolder(access, c, row.id, admin);
      let pushed = 0, failed = 0, sinRespaldo = 0;
      for (const a of c.adjuntos) {
        if (a.link) continue;            // ya está en Drive
        if (!a.respaldo) { sinRespaldo++; continue; } // sin copia: no se puede recuperar
        try {
          const { data: blob, error: de } = await admin.storage.from(BUCKET).download(a.respaldo);
          if (de || !blob) { failed++; continue; }
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const sub = subForTipo(a.tipo);
          const parentId = (c.drive.subs && c.drive.subs[sub]) || c.drive.folderId;
          const up = await uploadBytes(access, safeName(a.nombre), "application/octet-stream", bytes, parentId);
          a.link = up.webViewLink; pushed++;
        } catch (_) { failed++; }
      }
      await admin.from("casos").update({ data: c, updated_at: new Date().toISOString() }).eq("id", row.id);
      return json({ ok: true, pushed, failed, sinRespaldo, drive: c.drive });
    }

    return json({ ok: true, drive: c.drive });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

const PARENT_NAME = "GMJ LEGAL - CLIENTES FORM";
async function ensureFolder(access: string, c: any, rowId: string, admin: any) {
  if (c.drive && c.drive.folderId) return;
  const parentId = await ensureParent(access);
  const fid = await createFolder(access, folderName(c), parentId);
  const subs: Record<string, string> = {};
  for (const s of SUBCARPETAS) subs[s] = await createFolder(access, s, fid);
  if (!DRIVE_SHARED_ID) await makeReadableByLink(access, fid);
  c.drive = { creada: true, folderId: fid, subs, link: `https://drive.google.com/drive/folders/${fid}` };
  await admin.from("casos").update({ data: c, updated_at: new Date().toISOString() }).eq("id", rowId);
}
async function ensureParent(access: string): Promise<string> {
  const cond = DRIVE_SHARED_ID ? ` and '${DRIVE_SHARED_ID}' in parents` : "";
  const q = encodeURIComponent(`name='${PARENT_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false${cond}`);
  const url = `https://www.googleapis.com/drive/v3/files?fields=files(id)&${ALLDRIVES}&q=${q}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${access}` } }).then((x) => x.json());
  if (r.files && r.files.length) return r.files[0].id;
  return await createFolder(access, PARENT_NAME, DRIVE_SHARED_ID || null);
}
async function createFolder(access: string, name: string, parent: string | null): Promise<string> {
  const meta: any = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parent) meta.parents = [parent];
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?fields=id&${ALLDRIVES}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  }).then((x) => x.json());
  if (!r.id) throw new Error("no-folder:" + JSON.stringify(r));
  return r.id;
}
async function uploadBytes(access: string, name: string, mime: string, bytes: Uint8Array, parentId: string) {
  const boundary = "gmj" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [parentId] });
  const enc = new TextEncoder();
  const pre = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const post = enc.encode(`\r\n--${boundary}--`);
  const out = new Uint8Array(pre.length + bytes.length + post.length);
  out.set(pre, 0); out.set(bytes, pre.length); out.set(post, pre.length + bytes.length);
  const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&${ALLDRIVES}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: out,
  }).then((x) => x.json());
  if (!r.id) throw new Error("no-upload:" + JSON.stringify(r));
  return r;
}
async function makeReadableByLink(access: string, fileId: string) {
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?${ALLDRIVES}`, {
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
