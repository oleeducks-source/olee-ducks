// =====================================================================
// MODULE : SAUVEGARDE
// Exporte l'intégralité des données de la ferme (toutes les collections
// Firestore) dans un seul fichier JSON téléchargeable. Filet de sécurité
// en cas de problème avec le projet Firebase — à faire une fois par mois
// par exemple, et à conserver quelque part (email à soi-même, Drive…).
//
// Après un export réussi, la date est enregistrée dans "app_meta/sauvegarde"
// (partagée entre les 3 téléphones) et tout rappel de sauvegarde en
// attente dans le module Tâches est automatiquement clôturé — voir
// js/taches.js pour le rappel mensuel automatique associé.
//
// Écriture Firestore limitée à ces deux effets de bord ci-dessus ;
// aucune donnée métier de la ferme n'est modifiée.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, getDocs, doc, setDoc, updateDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { toast, getUserName } from "./utils.js";

const COLLECTIONS = [
  "ducks", "nests", "nest_cycles", "pontes_journalieres",
  "finance_transactions", "stock_items", "stock_mouvements", "formulations",
  "accounts", "exercises", "journal_ecritures", "taches", "canetons_production"
];

export function initSauvegarde() {
  document.getElementById("exportDonneesBtn")?.addEventListener("click", exporterToutesLesDonnees);
}

// Convertit récursivement les Timestamp Firestore en texte ISO lisible
// (un JSON classique ne sait pas représenter un Timestamp Firestore).
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

async function exporterToutesLesDonnees() {
  toast("Préparation de la sauvegarde…");
  try {
    const data = {};
    let totalDocs = 0;
    for (const nomCollection of COLLECTIONS) {
      const snap = await getDocs(collection(db, nomCollection));
      data[nomCollection] = snap.docs.map(d => ({ id: d.id, ...serialiser(d.data()) }));
      totalDocs += snap.docs.length;
    }
    data._meta = {
      application: "Olee Ducks",
      exporte_le: new Date().toISOString(),
      nombre_total_enregistrements: totalDocs,
      version_format: 1
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

    // Trace partagée (visible par les 3 téléphones) pour que le rappel
    // mensuel automatique de js/taches.js sache qu'une sauvegarde vient
    // d'être faite ce mois-ci, et clôture toute tâche de rappel en attente.
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
