// =====================================================================
// MODULE : RESTAURATION
// Relit un fichier de sauvegarde produit par js/sauvegarde.js et le
// réécrit dans Firestore. Jusqu'ici l'application savait exporter mais
// pas réimporter : le JSON obtenu n'était donc pas une sauvegarde
// utilisable, seulement une archive à ressaisir à la main.
//
// Trois garde-fous, dans cet ordre :
//   1. Le fichier est analysé et RÉSUMÉ avant toute écriture (nombre
//      d'enregistrements par collection, date et auteur de l'export).
//   2. La restauration ne SUPPRIME jamais rien. Chaque document est
//      réécrit à son identifiant d'origine avec merge, ce qui restaure
//      les enregistrements perdus et complète les champs manquants sans
//      détruire ce qui existe aujourd'hui.
//   3. L'utilisateur doit saisir RESTAURER en clair pour lancer
//      l'opération, et un compte-rendu s'affiche à la fin.
//
// Chargé à la demande (import dynamique depuis js/sauvegarde.js) : ce
// code ne pèse rien au démarrage de l'application.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, doc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { openModal, closeModal, toast, escapeHtml, formatDateTime } from "./utils.js";
import { COLLECTIONS } from "./sauvegarde.js";

const TAILLE_LOT = 400; // un lot d'écriture Firestore accepte 500 opérations
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Conversion inverse de serialiser() : les horodatages avaient été
// écrits en texte ISO strict, on les rend à Firestore sous forme de
// Date. Le motif est volontairement strict pour ne jamais transformer
// une description saisie par l'utilisateur en date.
function desserialiser(valeur) {
  if (typeof valeur === "string" && ISO.test(valeur)) return new Date(valeur);
  if (Array.isArray(valeur)) return valeur.map(desserialiser);
  if (valeur && typeof valeur === "object") {
    const out = {};
    for (const [k, v] of Object.entries(valeur)) out[k] = desserialiser(v);
    return out;
  }
  return valeur;
}

function lireFichier(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Lecture du fichier impossible"));
    reader.readAsText(file);
  });
}

function analyser(data) {
  if (!data || typeof data !== "object") throw new Error("Fichier illisible");
  const meta = data._meta;
  if (!meta || meta.application !== "Olee Ducks") {
    throw new Error("Ce fichier n'est pas une sauvegarde Olee Ducks");
  }
  const lignes = [];
  let total = 0;
  for (const nom of COLLECTIONS) {
    const docs = Array.isArray(data[nom]) ? data[nom] : [];
    if (!docs.length) continue;
    lignes.push({ chemin: nom, nombre: docs.length, docs });
    total += docs.length;
  }
  for (const [chemin, docs] of Object.entries(data._sous_collections || {})) {
    if (!Array.isArray(docs) || !docs.length) continue;
    lignes.push({ chemin, nombre: docs.length, docs });
    total += docs.length;
  }
  // Une sauvegarde au format 1 (avant l'audit) ne contient ni les
  // pesées, ni les éclosions, ni les relevés de ponte : on le dit
  // plutôt que de laisser croire à une restauration complète.
  const formatAncien = (meta.version_format || 1) < 2;
  return { meta, lignes, total, formatAncien };
}

async function ecrire(lignes, surAvancement) {
  let ecrits = 0;
  for (const ligne of lignes) {
    const segments = ligne.chemin.split("/");
    for (let i = 0; i < ligne.docs.length; i += TAILLE_LOT) {
      const lot = writeBatch(db);
      for (const enregistrement of ligne.docs.slice(i, i + TAILLE_LOT)) {
        const { id, ...champs } = enregistrement;
        if (!id) continue;
        lot.set(doc(collection(db, ...segments), id), desserialiser(champs), { merge: true });
      }
      await lot.commit();
      ecrits += Math.min(TAILLE_LOT, ligne.docs.length - i);
      surAvancement(ecrits);
    }
  }
  return ecrits;
}

export function ouvrirRestaurationModal() {
  openModal("Restaurer une sauvegarde", `
    <div class="state-banner warn">
      <span class="glyph">⚠️</span>
      <span>La restauration réécrit les enregistrements du fichier dans la base partagée par tous les téléphones. Elle ne supprime rien, mais les valeurs du fichier remplacent celles d'aujourd'hui pour les enregistrements concernés.</span>
    </div>
    <div class="spacer-m"></div>
    <label class="btn secondary" style="display:block; text-align:center; cursor:pointer;">
      Choisir un fichier de sauvegarde
      <input type="file" id="restFichier" accept="application/json,.json" style="display:none;">
    </label>
    <div id="restApercu"></div>
  `, {
    onMount: () => {
      document.getElementById("restFichier").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const apercu = document.getElementById("restApercu");
        apercu.innerHTML = `<div class="spacer-m"></div><p class="subtle">Analyse du fichier…</p>`;
        try {
          const data = JSON.parse(await lireFichier(file));
          const { meta, lignes, total, formatAncien } = analyser(data);
          afficherApercu(apercu, file, meta, lignes, total, formatAncien);
        } catch (err) {
          apercu.innerHTML = `<div class="spacer-m"></div><div class="state-banner error"><span class="glyph">⚠️</span><span>${escapeHtml(err.message)}</span></div>`;
        }
      });
    }
  });
}

function afficherApercu(apercu, file, meta, lignes, total, formatAncien) {
  apercu.innerHTML = `
    <div class="spacer-m"></div>
    <div class="row"><div class="row-main"><span class="row-title">Fichier</span><span class="row-sub">${escapeHtml(file.name)}</span></div></div>
    <div class="row"><div class="row-main"><span class="row-title">Exporté le</span><span class="row-sub">${meta.exporte_le ? formatDateTime(meta.exporte_le) : "date inconnue"}${meta.exporte_par ? " par " + escapeHtml(meta.exporte_par) : ""}</span></div><span class="tag">format ${meta.version_format || 1}</span></div>
    ${formatAncien ? `<div class="spacer-s"></div><div class="state-banner warn"><span class="glyph">⚠️</span><span>Sauvegarde d'un ancien format : elle ne contient ni le suivi pondéral, ni les éclosions journalières, ni les relevés de ponte rattachés aux cycles.</span></div>` : ""}
    <div class="spacer-m"></div>
    <h3 style="font-size:14px; margin-bottom:6px;">${total} enregistrement(s) à restaurer</h3>
    ${lignes.map(l => `
      <div class="row"><div class="row-main"><span class="row-title" style="font-size:13.5px;">${escapeHtml(l.chemin)}</span></div><span class="row-value">${l.nombre}</span></div>
    `).join("")}
    <div class="spacer-m"></div>
    <div class="field"><label>Saisissez RESTAURER pour confirmer</label><input type="text" id="restConfirme" placeholder="RESTAURER" autocapitalize="characters"></div>
    <button class="btn danger" id="restLancer">Restaurer ${total} enregistrement(s)</button>
    <div id="restAvancement"></div>
  `;

  const champ = document.getElementById("restConfirme");
  document.getElementById("restLancer").addEventListener("click", async () => {
    if (champ.value.trim().toUpperCase() !== "RESTAURER") {
      toast("Saisissez RESTAURER pour confirmer");
      champ.focus();
      return;
    }
    const avancement = document.getElementById("restAvancement");
    document.getElementById("restLancer").disabled = true;
    avancement.innerHTML = `<div class="spacer-m"></div><div class="stat-bar-track"><div class="stat-bar-fill" id="restBarre" style="width:0%"></div></div><p class="subtle" id="restTexte" style="margin-top:8px;">Écriture en cours…</p>`;
    try {
      const ecrits = await ecrire(lignes, (n) => {
        const pct = Math.round((n / total) * 100);
        const barre = document.getElementById("restBarre");
        const texte = document.getElementById("restTexte");
        if (barre) barre.style.width = pct + "%";
        if (texte) texte.textContent = `${n} / ${total} enregistrements restaurés…`;
      });
      closeModal();
      toast(`Restauration terminée ✓ (${ecrits} enregistrements)`);
    } catch (e) {
      console.error("Erreur restauration :", e);
      avancement.innerHTML = `<div class="spacer-m"></div><div class="state-banner error"><span class="glyph">⚠️</span><span>Restauration interrompue : ${escapeHtml(e.message)}. Les enregistrements déjà écrits sont conservés ; relancer l'opération reprend sans dommage.</span></div>`;
      document.getElementById("restLancer").disabled = false;
    }
  });
}
