// =====================================================================
// MODULE : PIÈCES JOINTES (reçus/factures) via Google Drive
// =====================================================================
// Pourquoi Google Drive et pas Firebase Storage : depuis février 2026,
// Firebase Storage exige le plan payant Blaze (carte bancaire liée),
// même si l'usage réel reste gratuit. Google Drive offre 15 Go gratuits
// par compte Google, sans configuration payante, via l'API Drive
// standard (indépendante de Firebase). Firestore ne stocke que le lien
// vers le fichier, jamais le fichier lui-même — impact quasi nul sur
// le quota gratuit Firestore (1 Go).
//
// Fonctionnement : connexion Google (OAuth, via Google Identity
// Services) déclenchée uniquement au moment d'un envoi de reçu. Le
// jeton d'accès est valable ~1h ; au-delà, une reconnexion (silencieuse
// la plupart du temps) est redemandée automatiquement.
// =====================================================================
import { db } from "./firebase-config.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { GOOGLE_DRIVE_CLIENT_ID } from "./drive-config.js";
import { toast } from "./utils.js";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Olee Ducks - Reçus";

let tokenClient = null;
let cachedToken = null; // { access_token, expiresAt }
let cachedFolderId = localStorage.getItem("oleeducks_drive_folder_id") || null;

function ensureGisLoaded() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      resolve();
      return;
    }
    const check = setInterval(() => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        clearInterval(check);
        resolve();
      }
    }, 100);
    setTimeout(() => { clearInterval(check); reject(new Error("Google Identity Services non chargé (vérifiez votre connexion)")); }, 8000);
  });
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.access_token;
  }
  await ensureGisLoaded();
  if (GOOGLE_DRIVE_CLIENT_ID.startsWith("REMPLACER")) {
    throw new Error("Google Drive n'est pas configuré (js/drive-config.js contient encore une valeur REMPLACER_...)");
  }
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_DRIVE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: () => {} // remplacé à chaque appel ci-dessous
    });
  }
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error("Connexion Google refusée ou annulée : " + resp.error)); return; }
      cachedToken = { access_token: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3500) * 1000 };
      resolve(resp.access_token);
    };
    tokenClient.requestAccessToken({ prompt: cachedToken ? "" : "consent" });
  });
}

async function driveFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Erreur Google Drive (${res.status}) : ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function ensureFolder(token) {
  if (cachedFolderId) return cachedFolderId;
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const search = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, token);
  if (search.files && search.files.length) {
    cachedFolderId = search.files[0].id;
  } else {
    const created = await driveFetch("https://www.googleapis.com/drive/v3/files", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" })
    });
    cachedFolderId = created.id;
  }
  localStorage.setItem("oleeducks_drive_folder_id", cachedFolderId);
  return cachedFolderId;
}

async function uploadFileToDrive(token, folderId, file) {
  const metadata = { name: `${Date.now()}_${file.name}`, parents: [folderId] };
  const boundary = "oleeducks_boundary_" + Math.random().toString(36).slice(2);
  const fileBytes = await file.arrayBuffer();

  const encoder = new TextEncoder();
  const preamble = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`
  );
  const closing = encoder.encode(`\r\n--${boundary}--`);
  const body = new Blob([preamble, fileBytes, closing]);

  const created = await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    token,
    { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }
  );

  // Rend le fichier consultable par toute l'équipe via le lien (pas besoin
  // que chaque personne ait ses propres droits Drive).
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${created.id}/permissions`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" })
  }).catch(() => { /* si ça échoue, le fichier reste privé au compte connecté — non bloquant */ });

  return created;
}

// ---------------------------------------------------------------------
// API publique utilisée par finances.js
// ---------------------------------------------------------------------
export async function attacherRecu(transactionId, file) {
  if (file.size > 15 * 1024 * 1024) throw new Error("Fichier trop volumineux (limite 15 Mo)");
  toast("Connexion à Google Drive…");
  const token = await getAccessToken();
  const folderId = await ensureFolder(token);
  toast("Envoi du reçu…");
  const uploaded = await uploadFileToDrive(token, folderId, file);
  const url = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;
  await updateDoc(doc(db, "finance_transactions", transactionId), {
    piece_jointe_url: url, piece_jointe_nom: file.name, piece_jointe_id: uploaded.id
  });
  return url;
}

export async function retirerRecu(transactionId) {
  await updateDoc(doc(db, "finance_transactions", transactionId), {
    piece_jointe_url: null, piece_jointe_nom: null, piece_jointe_id: null
  });
}
