// =====================================================================
// MODULE : PIÈCES JOINTES (reçus/factures)
// =====================================================================
// Stockage 100% gratuit et sans dépendance externe : la photo du reçu
// est compressée dans le navigateur (redimensionnée + réencodée en
// JPEG), convertie en base64, puis enregistrée directement dans le
// document de la transaction concernée (collection Firestore
// "finance_transactions"). Il n'y a plus de fichier séparé, plus de
// compte Google à connecter, plus de fenêtre popup qui peut être
// bloquée par le navigateur.
//
// Pourquoi pas Firebase Storage : depuis février 2026, Storage exige le
// plan payant Blaze (carte bancaire liée). Pourquoi pas Google Drive
// (ancienne version) : nécessitait une connexion OAuth par popup,
// souvent bloquée sur mobile ("La connexion Google n'a pas abouti").
//
// Limite technique : un document Firestore ne peut pas dépasser 1 Mo.
// On vise donc une image compressée de 700 Ko maximum une fois encodée
// en base64 (largement suffisant pour une photo de reçu lisible), ce
// qui laisse une confortable marge. Une ferme avec quelques dizaines de
// reçus par mois reste très loin du 1 Go gratuit du plan Spark.
// =====================================================================
import { db } from "./firebase-config.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const MAX_DATA_URL_BYTES = 700 * 1024; // marge de sécurité sous la limite de 1 Mo/document Firestore
const START_DIMENSION = 1280; // plus grand côté, en pixels

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Lecture du fichier impossible"));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image illisible ou corrompue"));
    img.src = dataUrl;
  });
}

// Redimensionne et compresse une photo en JPEG jusqu'à tenir sous la
// limite de taille : réduit d'abord la qualité, puis les dimensions si
// nécessaire, en plusieurs passes.
async function compressImage(file) {
  const original = await readFileAsDataUrl(file);
  const img = await loadImage(original);

  let dimension = START_DIMENSION;
  for (let pass = 0; pass < 6; pass++) {
    const scale = Math.min(1, dimension / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    for (let quality = 0.75; quality >= 0.3; quality -= 0.15) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= MAX_DATA_URL_BYTES) return dataUrl;
    }
    dimension = Math.round(dimension * 0.7); // image encore trop lourde : on réessaie plus petit
  }
  throw new Error("Impossible de compresser cette photo sous la taille limite (1 Mo). Essayez une photo moins détaillée.");
}

// ---------------------------------------------------------------------
// API publique utilisée par finances.js
// ---------------------------------------------------------------------
export async function attacherRecu(transactionId, file) {
  if (file.size > 25 * 1024 * 1024) throw new Error("Fichier trop volumineux (limite 25 Mo en entrée)");

  const type = file.type || "application/octet-stream";
  let dataUrl;

  if (type.startsWith("image/")) {
    dataUrl = await compressImage(file);
  } else if (type === "application/pdf") {
    if (file.size > MAX_DATA_URL_BYTES) {
      throw new Error("Ce PDF est trop volumineux pour être enregistré (limite ~700 Ko). Préférez une photo du reçu plutôt qu'un PDF scanné.");
    }
    dataUrl = await readFileAsDataUrl(file);
  } else {
    throw new Error("Format non pris en charge — utilisez une photo (JPEG/PNG) ou un PDF");
  }

  await updateDoc(doc(db, "finance_transactions", transactionId), {
    piece_jointe_data: dataUrl,
    piece_jointe_nom: file.name,
    piece_jointe_type: type,
    // Champs de l'ancien système (Google Drive), effacés lors d'un nouvel envoi.
    piece_jointe_url: null,
    piece_jointe_id: null
  });
  return dataUrl;
}

export async function retirerRecu(transactionId) {
  await updateDoc(doc(db, "finance_transactions", transactionId), {
    piece_jointe_data: null,
    piece_jointe_nom: null,
    piece_jointe_type: null,
    piece_jointe_url: null,
    piece_jointe_id: null
  });
}
