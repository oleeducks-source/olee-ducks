// =====================================================================
// PROTECTION ANTI-DOUBLON — Olee Ducks
// Protection multi-appareils, atomique côté Firestore.
// Une même saisie métier ne peut être créée deux fois dans une fenêtre
// courte, même si deux téléphones valident presque simultanément.
// =====================================================================
import { db } from "./firebase-config.js";
import { collection, doc, runTransaction, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getUserName } from "./utils.js";

export const DELAI_DOUBLON_MS = 5 * 60 * 1000;
const GUARD_COL = collection(db, "write_dedup_guards");

function normalise(v) {
  if (v === undefined || v === null) return "";
  if (v?.toDate) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v === "object") {
    return Object.keys(v).sort().reduce((o, k) => { o[k] = normalise(v[k]); return o; }, {});
  }
  return typeof v === "string" ? v.trim().toLowerCase() : v;
}

function hash32(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

export function makeDedupSignature(collectionName, fields) {
  return `${collectionName}|${JSON.stringify(normalise(fields))}`;
}

function guardId(signature) {
  return `v1_${hash32(signature)}_${hash32(signature, 2246822519)}`;
}

export class DoublonBloqueError extends Error {
  constructor({ par = "un autre utilisateur", minutes = 1, label = "cet enregistrement" } = {}) {
    super(`DOUBLON|${par}|${minutes}|${label}`);
    this.code = "DOUBLON_BLOQUE";
    this.par = par;
    this.minutes = minutes;
    this.label = label;
  }
}

/**
 * Crée un document et son verrou anti-doublon dans UNE transaction.
 * `fields` contient uniquement les champs métier qui définissent une
 * saisie identique ; `payload` peut contenir serverTimestamp().
 */
export async function addDocGuarded(collectionName, fields, payload, label = "cet enregistrement") {
  const signature = makeDedupSignature(collectionName, fields);
  const now = Timestamp.now();
  const guardRef = doc(GUARD_COL, guardId(signature));
  const targetRef = doc(collection(db, collectionName));
  const auteur = getUserName() || "Inconnu";

  await runTransaction(db, async (tx) => {
    const guardSnap = await tx.get(guardRef);
    if (guardSnap.exists()) {
      const g = guardSnap.data() || {};
      const age = Math.max(0, now.toMillis() - (g.createdAt?.toMillis?.() || now.toMillis()));
      if (age < DELAI_DOUBLON_MS) {
        throw new DoublonBloqueError({ par: g.par || "un autre utilisateur", minutes: Math.max(1, Math.round(age / 60000)), label: g.label || label });
      }
    }
    tx.set(guardRef, {
      signature,
      label,
      par: auteur,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + DELAI_DOUBLON_MS)
    });
    tx.set(targetRef, payload);
  });
  return targetRef;
}

export async function runGuardedTransaction(collectionName, fields, label, work) {
  const signature = makeDedupSignature(collectionName, fields);
  const now = Timestamp.now();
  const guardRef = doc(GUARD_COL, guardId(signature));
  const auteur = getUserName() || "Inconnu";
  return runTransaction(db, async (tx) => {
    const guardSnap = await tx.get(guardRef);
    if (guardSnap.exists()) {
      const g = guardSnap.data() || {};
      const age = Math.max(0, now.toMillis() - (g.createdAt?.toMillis?.() || now.toMillis()));
      if (age < DELAI_DOUBLON_MS) {
        throw new DoublonBloqueError({ par: g.par || "un autre utilisateur", minutes: Math.max(1, Math.round(age / 60000)), label: g.label || label });
      }
    }
    const result = await work(tx, { now, auteur });
    tx.set(guardRef, { signature, label, par: auteur, createdAt: now, expiresAt: Timestamp.fromMillis(now.toMillis() + DELAI_DOUBLON_MS) });
    return result;
  });
}

export function formatDoublonMessage(e) {
  if (!e || e.code !== "DOUBLON_BLOQUE") return null;
  return `⚠️ Doublon bloqué : ${e.par} a déjà enregistré ${e.label.toLowerCase()} il y a ${e.minutes} min. Aucun nouvel enregistrement n'a été créé.`;
}
