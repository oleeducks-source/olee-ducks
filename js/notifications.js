// =====================================================================
// MODULE : NOTIFICATIONS
// Alerte l'utilisateur (via l'API Notification du navigateur) pour les
// événements clés de la ferme : ponte, éclosion, recette, dépense, et
// requalification de cheptel imminente (J-2/J-1).
//
// ⚠️ LIMITE TECHNIQUE IMPORTANTE À CONNAÎTRE :
// Ces notifications fonctionnent tant que l'application est OUVERTE sur
// le téléphone (au premier plan ou en arrière-plan, onglet non fermé).
// Une vraie notification "push" reçue même app fermée/tuée nécessite un
// service serveur (Firebase Cloud Messaging + Cloud Functions), qui
// exige le plan payant "Blaze" de Firebase — hors du cadre gratuit
// choisi pour cette app depuis le début. Ce module offre donc la
// meilleure alternative gratuite : une détection quasi immédiate
// (1 à quelques secondes) tant que l'app tourne quelque part.
//
// Module 100% LECTURE SEULE : aucune écriture Firestore.
// =====================================================================
import { db } from "./firebase-config.js";
import { collection, query, where, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatFCFA, formatDate } from "./utils.js";

const NOTIF_KEY = "oleeducks_notifs_enabled";
const SEMAINE_MS = 7 * 24 * 60 * 60 * 1000;

export function initNotifications() {
  const bell = document.getElementById("notifBell");
  if (!bell) return;

  const actives = () => "Notification" in window && Notification.permission === "granted" && localStorage.getItem(NOTIF_KEY) === "1";
  const refreshBell = () => bell.classList.toggle("on", actives());
  refreshBell();

  bell.addEventListener("click", async () => {
    if (!("Notification" in window)) {
      alert("Les notifications ne sont pas prises en charge par ce navigateur.");
      return;
    }
    if (actives()) {
      localStorage.setItem(NOTIF_KEY, "0");
      refreshBell();
      return;
    }
    if (Notification.permission === "denied") {
      alert("Les notifications sont bloquées pour Olee Ducks dans les réglages de votre téléphone. Autorisez-les puis réessayez.");
      return;
    }
    if (Notification.permission !== "granted") {
      const res = await Notification.requestPermission();
      if (res !== "granted") return;
    }
    localStorage.setItem(NOTIF_KEY, "1");
    refreshBell();
    envoyerNotif("🔔 Notifications activées", "Vous serez alerté pour les pontes, éclosions, ventes, dépenses et requalifications à venir — tant que l'app reste ouverte sur ce téléphone.");
  });

  if (actives()) demarrerEcoute();
  // Si l'utilisateur a déjà activé les notifications sur ce téléphone lors
  // d'une session précédente mais que le navigateur a depuis révoqué la
  // permission, on ne relance pas l'écoute inutilement.
}

function peutNotifier() {
  return "Notification" in window && Notification.permission === "granted" && localStorage.getItem(NOTIF_KEY) === "1";
}

function envoyerNotif(titre, corps) {
  if (!peutNotifier()) return;
  try {
    new Notification(titre, { body: corps, icon: "icons/icon-192.png", tag: titre + "_" + Date.now() });
  } catch (e) {
    console.error("Notification impossible :", e);
  }
}

function demarrerEcoute() {
  ecouterPontes();
  ecouterEclosions();
  ecouterFinances();
  ecouterRequalifications();
}

// ---- Pontes en cours : nouvelle ponte démarrée + œufs ajoutés ----
function ecouterPontes() {
  let connus = {};
  let premier = true;
  onSnapshot(query(collection(db, "nest_cycles"), where("statut", "in", ["ponte", "couvaison"])), (snap) => {
    const nouveaux = {};
    snap.docs.forEach(d => { nouveaux[d.id] = { id: d.id, ...d.data() }; });
    if (!premier) {
      Object.values(nouveaux).forEach(c => {
        const avant = connus[c.id];
        if (!avant) {
          envoyerNotif("🥚 Ponte démarrée", `Nid n° ${c.nid_numero} — ${c.nombre_oeufs || 0} œuf(s)`);
          return;
        }
        const delta = (Number(c.nombre_oeufs) || 0) - (Number(avant.nombre_oeufs) || 0);
        if (delta > 0) envoyerNotif("🥚 Œufs enregistrés", `Nid n° ${c.nid_numero} : +${delta} œuf(s) (total ${c.nombre_oeufs || 0})`);
      });
    }
    connus = nouveaux;
    premier = false;
  }, err => console.error("Erreur notifications pontes :", err));
}

// ---- Éclosions et échecs de couvaison (nouvelles archives) ----
function ecouterEclosions() {
  let idsConnus = new Set();
  let premier = true;
  onSnapshot(query(collection(db, "nest_cycles"), where("statut", "in", ["eclos", "echec"])), (snap) => {
    const nouveauxIds = new Set();
    snap.docs.forEach(d => {
      nouveauxIds.add(d.id);
      if (!premier && !idsConnus.has(d.id)) {
        const c = { id: d.id, ...d.data() };
        if (c.statut === "eclos") {
          envoyerNotif("🐣 Éclosion enregistrée", `Nid n° ${c.nid_numero} : ${c.nombre_eclos || 0}/${c.nombre_oeufs || 0} œufs éclos`);
        } else {
          envoyerNotif("⚠️ Échec de couvaison", `Nid n° ${c.nid_numero}`);
        }
      }
    });
    idsConnus = nouveauxIds;
    premier = false;
  }, err => console.error("Erreur notifications éclosions :", err));
}

// ---- Recettes et dépenses ----
function ecouterFinances() {
  let idsConnus = new Set();
  let premier = true;
  onSnapshot(query(collection(db, "finance_transactions"), orderBy("createdAt", "desc"), limit(20)), (snap) => {
    const nouveauxIds = new Set();
    snap.docs.forEach(d => {
      nouveauxIds.add(d.id);
      if (!premier && !idsConnus.has(d.id)) {
        const t = { id: d.id, ...d.data() };
        if (t.type === "recette") {
          envoyerNotif("💰 Recette enregistrée", `${formatFCFA(t.montant)} — ${t.description || t.categorie || ""}`.trim());
        } else {
          envoyerNotif("💸 Dépense enregistrée", `${formatFCFA(t.montant)} — ${t.description || t.categorie || ""}`.trim());
        }
      }
    });
    idsConnus = nouveauxIds;
    premier = false;
  }, err => console.error("Erreur notifications finances :", err));
}

// ---- Alerte J-2 / J-1 avant requalification automatique d'un lot ----
function ageEnSemaines(d) {
  const ref = d.date_naissance || d.date_entree;
  if (!ref) return null;
  const date = ref?.toDate ? ref.toDate() : new Date(ref);
  if (isNaN(date.getTime())) return null;
  return (Date.now() - date.getTime()) / SEMAINE_MS;
}

function verifierRequalificationsAVenir(ducks) {
  const aujourdhui = new Date().toDateString();
  ducks
    .filter(d => d.statut === "actif" && (d.type === "caneton" || d.type === "canardeau") && !d.verrouille_type)
    .forEach(d => {
      const age = ageEnSemaines(d);
      if (age === null) return;
      const seuilSem = d.type === "caneton" ? 4 : 8;
      const joursRestants = Math.round((seuilSem - age) * 7);
      if (joursRestants !== 1 && joursRestants !== 2) return;
      const cle = `oleeducks_notif_requal_${d.id}_${joursRestants}j_${aujourdhui}`;
      if (localStorage.getItem(cle)) return; // déjà notifié aujourd'hui pour ce lot
      localStorage.setItem(cle, "1");
      const prochain = d.type === "caneton" ? "canardeau" : "canard";
      envoyerNotif(
        "⏳ Requalification à venir",
        `${d.quantite || 1} sujet(s) (lot du ${formatDate(d.date_entree)}) passeront en ${prochain} dans ${joursRestants} jour(s).`
      );
    });
}

function ecouterRequalifications() {
  let dernierDucks = [];
  onSnapshot(collection(db, "ducks"), (snap) => {
    dernierDucks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    verifierRequalificationsAVenir(dernierDucks);
  }, err => console.error("Erreur notifications requalification :", err));
  // Filet de sécurité : si l'app reste ouverte en arrière-plan pendant
  // plusieurs heures sans qu'aucune donnée "ducks" ne change (donc sans
  // nouveau snapshot), on revérifie quand même périodiquement pour ne
  // pas manquer un changement de jour (passage à J-1 par exemple).
  setInterval(() => {
    if (dernierDucks.length) verifierRequalificationsAVenir(dernierDucks);
  }, 6 * 60 * 60 * 1000);
}
