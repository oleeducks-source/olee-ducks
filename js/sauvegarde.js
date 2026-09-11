// =====================================================================
// MODULE : SAUVEGARDE
// Exporte l'intégralité des données de la ferme (toutes les collections
// Firestore, sous-collections comprises) dans un seul fichier JSON
// téléchargeable. Filet de sécurité en cas de problème avec le projet
// Firebase — à faire une fois par semaine, et à conserver quelque part
// (email à soi-même, Drive…).
//
// Le bouton 💾 de la barre du haut ouvre une feuille qui rappelle la
// date de la dernière sauvegarde (partagée entre les téléphones via
// app_meta/sauvegarde) et propose les deux sens : télécharger, ou
// restaurer depuis un fichier (voir js/restauration.js).
//
// Après un export réussi, la date est enregistrée dans
// "app_meta/sauvegarde" et tout rappel de sauvegarde en attente dans le
// module Tâches est automatiquement clôturé — voir js/taches.js pour le
// rappel mensuel automatique associé.
//
// Écriture Firestore limitée à ces deux effets de bord ci-dessus ;
// aucune donnée métier de la ferme n'est modifiée.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, getDocs, doc, getDoc, setDoc, updateDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { toast, getUserName, openModal, closeModal, formatDateTime, escapeHtml } from "./utils.js";

// Liste complète des collections écrites par l'application. Trois
// d'entre elles manquaient et n'étaient donc PAS sauvegardées :
// eclosions_journalieres (js/nids.js), pesees_journalieres (js/pesees.js)
// et app_meta. Toute nouvelle collection doit être ajoutée ici — sans
// quoi le fichier présenté comme « l'intégralité des données » est
// incomplet sans que rien ne le signale.
export const COLLECTIONS = [
  "ducks", "nests", "nest_cycles",
  "pontes_journalieres", "eclosions_journalieres", "pesees_journalieres",
  "finance_transactions", "stock_items", "stock_mouvements", "formulations",
  "accounts", "exercises", "journal_ecritures",
  "taches", "canetons_production", "app_meta"
];

// Sous-collections rattachées à un document parent : un getDocs sur une
// collection ne les rapporte jamais. Les relevés quotidiens de ponte
// vivent ici (voir README §9 : nest_cycles/{id}/suivi).
const SOUS_COLLECTIONS = [
  { parent: "nest_cycles", nom: "suivi" }
];

export function initSauvegarde() {
  // Rien à initialiser ici : le déclenchement se fait depuis le menu
  // compte (voir app.js, "Sauvegarder les données") et depuis l'écran
  // Rapports & exports (voir rapport.js), qui appellent tous deux
  // directement ouvrirSauvegardeModal() — plus de bouton dédié dans
  // l'en-tête, conformément à l'architecture UX (section D).
}

// Convertit récursivement les Timestamp Firestore en texte ISO lisible
// (un JSON classique ne sait pas représenter un Timestamp Firestore).
// js/restauration.js effectue la conversion inverse.
function serialiser(valeur) {
  if (valeur && typeof valeur.toDate === "function") return valeur.toDate().toISOString();
  if (Array.isArray(valeur)) return valeur.map(serialiser);
  if (valeur && typeof valeur === "object") {
    const out = {};
    for (const [k, v] of Object.entries(valeur)) out[k] = serialiser(v);
    return out;
  }
  return valeur;
}

// Ouvre la feuille de sauvegarde : rappelle la date/l'auteur de la
// dernière sauvegarde (app_meta/sauvegarde) et propose les deux sens —
// télécharger ou restaurer depuis un fichier (js/restauration.js).
// Exportée : appelée depuis le menu compte (app.js) et depuis l'écran
// Rapports & exports (rapport.js).
export async function ouvrirSauvegardeModal() {
  openModal("Sauvegarde des données", `
    <div id="sauvDerniere"><p class="subtle">Lecture de la dernière sauvegarde…</p></div>
    <div class="spacer-m"></div>
    <button class="btn yolk" id="sauvExportBtn">Télécharger la sauvegarde</button>
    <div class="spacer-s"></div>
    <button class="btn secondary" id="sauvRestoreBtn">Restaurer depuis un fichier…</button>
    <div class="spacer-m"></div>
    <p class="subtle" style="margin:0;">Le fichier obtenu contient toutes les données de la ferme au format texte. Conservez-le hors du téléphone : envoyé par email à vous-même, il est déjà à l'abri.</p>
  `, {
    onMount: async () => {
      document.getElementById("sauvExportBtn").addEventListener("click", exporterToutesLesDonnees);
      document.getElementById("sauvRestoreBtn").addEventListener("click", async () => {
        const { ouvrirRestaurationModal } = await import("./restauration.js");
        ouvrirRestaurationModal();
      });

      const zone = document.getElementById("sauvDerniere");
      try {
        const snap = await getDoc(doc(db, "app_meta", "sauvegarde"));
        if (!zone) return;
        if (snap.exists() && snap.data().date) {
          const d = snap.data();
          const jours = Math.floor((Date.now() - d.date.toDate().getTime()) / 86400000);
          const enRetard = jours >= 7;
          zone.innerHTML = `
            <div class="state-banner ${enRetard ? "warn" : "success"}">
              <span class="glyph">${enRetard ? "⚠️" : "✓"}</span>
              <span>Dernière sauvegarde ${formatDateTime(d.date)}${d.par ? " par " + escapeHtml(d.par) : ""}${jours > 0 ? ` — il y a ${jours} jour(s)` : " — aujourd'hui"}.${enRetard ? " Une sauvegarde hebdomadaire est recommandée." : ""}</span>
            </div>`;
        } else {
          zone.innerHTML = `
            <div class="state-banner warn">
              <span class="glyph">⚠️</span>
              <span>Aucune sauvegarde enregistrée pour l'instant.</span>
            </div>`;
        }
      } catch (e) {
        if (zone) zone.innerHTML = `<p class="subtle">Date de la dernière sauvegarde indisponible (${escapeHtml(e.message)}).</p>`;
      }
    }
  });
}

async function exporterToutesLesDonnees() {
  closeModal();
  toast("Préparation de la sauvegarde…");
  try {
    const data = {};
    let totalDocs = 0;

    for (const nomCollection of COLLECTIONS) {
      const snap = await getDocs(collection(db, nomCollection));
      data[nomCollection] = snap.docs.map(d => ({ id: d.id, ...serialiser(d.data()) }));
      totalDocs += snap.docs.length;
    }

    // Sous-collections : parcourues à partir des documents parents déjà
    // récupérés ci-dessus, et rangées à part pour que la restauration
    // sache où les réécrire.
    const sousCollections = {};
    for (const { parent, nom } of SOUS_COLLECTIONS) {
      for (const parentDoc of data[parent] || []) {
        const snap = await getDocs(collection(db, parent, parentDoc.id, nom));
        if (!snap.docs.length) continue;
        sousCollections[`${parent}/${parentDoc.id}/${nom}`] =
          snap.docs.map(d => ({ id: d.id, ...serialiser(d.data()) }));
        totalDocs += snap.docs.length;
      }
    }
    data._sous_collections = sousCollections;

    data._meta = {
      application: "Olee Ducks",
      exporte_le: new Date().toISOString(),
      exporte_par: getUserName() || "Inconnu",
      nombre_total_enregistrements: totalDocs,
      collections: COLLECTIONS,
      version_format: 2
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `OleeDucks_Sauvegarde_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`Sauvegarde générée ✓ (${totalDocs} enregistrements) — conservez ce fichier en lieu sûr`);

    // Trace partagée (visible par les autres téléphones) pour que le
    // rappel automatique de js/taches.js sache qu'une sauvegarde vient
    // d'être faite, et clôture toute tâche de rappel en attente.
    await setDoc(doc(db, "app_meta", "sauvegarde"), {
      date: serverTimestamp(),
      par: getUserName() || "Inconnu"
    }, { merge: true });

    const rappelSnap = await getDocs(query(collection(db, "taches"), where("categorie", "==", "sauvegarde"), where("statut", "==", "a_faire")));
    for (const d of rappelSnap.docs) {
      await updateDoc(doc(db, "taches", d.id), {
        statut: "effectuee",
        effectue_par: "Système (auto — sauvegarde effectuée)",
        effectue_le: serverTimestamp()
      });
    }
  } catch (e) {
    console.error("Erreur sauvegarde :", e);
    toast("Erreur lors de la sauvegarde : " + e.message);
  }
}
