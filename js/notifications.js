// =====================================================================
// MODULE : NOTIFICATIONS
// Alerte l'utilisateur (via l'API Notification du navigateur) pour les
// événements de la ferme survenus DEPUIS SA DERNIÈRE VISITE : pontes,
// couvaisons, éclosions, ventes, dépenses, mouvements de stock — et les
// requalifications de cheptel imminentes (J-2/J-1).
//
// Fonctionnement : à chaque connexion à l'app, un seul résumé est
// calculé et notifié (pas de flux continu en arrière-plan). C'est un
// choix délibéré pour rester 100% gratuit et léger en batterie/données :
// une vraie notification "push" reçue même app fermée nécessiterait un
// service serveur (Firebase Cloud Messaging + Cloud Functions), qui
// exige le plan payant "Blaze" — hors du cadre gratuit choisi pour cette
// app.
//
// Module 100% LECTURE SEULE : aucune écriture Firestore.
// =====================================================================
import { db } from "./firebase-config.js";
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatFCFA, formatDate, escapeHtml } from "./utils.js";

const NOTIF_KEY = "oleeducks_notifs_enabled";
const LAST_VISIT_KEY = "oleeducks_derniere_visite";
const SEMAINE_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Réglage d'activation (résumé du navigateur à chaque connexion) — vit
// dans l'écran Notifications (bouton dédié), pas au clic sur la cloche
// de l'en-tête : la cloche ouvre désormais simplement l'écran de
// consultation (voir app.js, openNotificationsPage).
// ---------------------------------------------------------------------
export function notificationsActives() {
  return "Notification" in window && Notification.permission === "granted" && localStorage.getItem(NOTIF_KEY) === "1";
}

export async function toggleNotifications() {
  if (!("Notification" in window)) {
    alert("Les notifications ne sont pas prises en charge par ce navigateur.");
    return;
  }
  if (notificationsActives()) {
    localStorage.setItem(NOTIF_KEY, "0");
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
  envoyerNotif("Notifications activées", "Vous recevrez un résumé de l'activité de la ferme à chaque connexion à l'app.");
  genererResumeConnexion();
}

export function initNotifications() {
  if (notificationsActives()) genererResumeConnexion();
}

function peutNotifier() {
  return notificationsActives();
}

function envoyerNotif(titre, corps) {
  if (!peutNotifier()) return;
  try {
    new Notification(titre, { body: corps, icon: "icons/icon-192.png", tag: titre + "_" + Date.now() });
  } catch (e) {
    console.error("Notification impossible :", e);
  }
}

function toMs(v) {
  if (!v) return 0;
  const d = v?.toDate ? v.toDate() : new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// ---------------------------------------------------------------------
// Résumé calculé UNE FOIS par connexion à l'app : compare l'horodatage
// de la dernière visite (stocké localement sur ce téléphone) aux
// documents lus, puis notifie un condensé plutôt qu'un événement par
// événement — évite le flux continu tout en gardant l'utilisateur
// informé de ce qui s'est passé pendant son absence.
// ---------------------------------------------------------------------
async function genererResumeConnexion() {
  if (!peutNotifier()) return;

  const dernierVisiteBrut = localStorage.getItem(LAST_VISIT_KEY);
  const premiereFois = !dernierVisiteBrut;
  // Par défaut (toute première activation), on résume les dernières 24h
  // pour ne pas noyer l'utilisateur avec tout l'historique de la ferme.
  const depuis = premiereFois ? Date.now() - 24 * 60 * 60 * 1000 : Number(dernierVisiteBrut);
  localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));

  try {
    const depuisDate = new Date(depuis);
    // ---------------------------------------------------------------
    // Optimisation : au lieu de relire l'intégralité de chaque
    // collection à chaque connexion (coûteux et de plus en plus lent à
    // mesure que l'historique de la ferme grandit), on ne demande à
    // Firestore que les documents réellement récents grâce à des
    // requêtes filtrées par date. Seules "ducks" (petit volume, on a
    // besoin de TOUT le cheptel actif pour les âges) et "taches"
    // (volume naturellement faible) restent lues intégralement.
    // ---------------------------------------------------------------
    const [pontesSnap, archivesSnap, txSnap, movSnap, ducksSnap, tachesSnap] = await Promise.all([
      getDocs(query(collection(db, "nest_cycles"), where("date_debut", ">=", depuisDate))),
      getDocs(query(collection(db, "nest_cycles"), where("date_fin", ">=", depuisDate))),
      getDocs(query(collection(db, "finance_transactions"), where("createdAt", ">=", depuisDate))),
      getDocs(query(collection(db, "stock_mouvements"), where("date", ">=", depuisDate))),
      getDocs(collection(db, "ducks")),
      getDocs(collection(db, "taches"))
    ]);

    const nouveauxCycles = pontesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const cyclesArchivesRecents = archivesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const tx = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const mouvements = movSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const ducks = ducksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const taches = tachesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Pontes/couvaisons démarrées depuis la dernière visite (déjà filtré côté serveur)
    const nouvellesPontes = nouveauxCycles.length;
    // Éclosions et échecs archivés depuis la dernière visite (déjà filtré côté serveur)
    const eclosions = cyclesArchivesRecents.filter(c => c.statut === "eclos");
    const echecs = cyclesArchivesRecents.filter(c => c.statut === "echec");
    const totalEclos = eclosions.reduce((a, c) => a + (Number(c.nombre_eclos) || 0), 0);

    const recettes = tx.filter(t => t.type === "recette");
    const depenses = tx.filter(t => t.type === "depense");
    const totalRecettes = recettes.reduce((a, t) => a + (Number(t.montant) || 0), 0);
    const totalDepenses = depenses.reduce((a, t) => a + (Number(t.montant) || 0), 0);

    const entrees = mouvements.filter(m => m.type_mouvement === "entree").length;
    const sorties = mouvements.filter(m => m.type_mouvement === "sortie").length;

    const lignes = [];
    const nouvellesTaches = taches.filter(t => toMs(t.createdAt) >= depuis).length;

    if (nouvellesPontes) lignes.push(`🥚 ${nouvellesPontes} ponte(s) démarrée(s)`);
    if (eclosions.length) lignes.push(`🐣 ${eclosions.length} éclosion(s) (${totalEclos} caneton(s))`);
    if (echecs.length) lignes.push(`⚠️ ${echecs.length} échec(s) de couvaison`);
    if (recettes.length) lignes.push(`💰 ${recettes.length} recette(s) — ${formatFCFA(totalRecettes)}`);
    if (depenses.length) lignes.push(`💸 ${depenses.length} dépense(s) — ${formatFCFA(totalDepenses)}`);
    if (entrees) lignes.push(`📦 ${entrees} entrée(s) de stock (achat)`);
    if (sorties) lignes.push(`📤 ${sorties} sortie(s) de stock (usage)`);
    if (nouvellesTaches) lignes.push(`📋 ${nouvellesTaches} nouvelle(s) tâche(s) ajoutée(s)`);

    if (lignes.length) {
      envoyerNotif("📋 Depuis votre dernière visite", lignes.join("\n"));
    }

    verifierRequalificationsAVenir(ducks);
    verifierTachesUrgentes(taches);
  } catch (e) {
    console.error("Erreur génération du résumé de connexion :", e);
  }
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
  const alertes = [];
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
      alertes.push(`⏳ ${d.quantite || 1} sujet(s) (lot du ${formatDate(d.date_entree)}) → ${prochain} dans ${joursRestants} j`);
    });
  if (alertes.length) envoyerNotif("⏳ Requalifications à venir", alertes.join("\n"));
}

// ---- Alerte pour les tâches en retard ou proches de l'échéance ----
function verifierTachesUrgentes(taches) {
  const aujourdhui = new Date().toDateString();
  const alertes = [];
  taches
    .filter(t => t.statut === "a_faire" && t.date_echeance)
    .forEach(t => {
      const d = t.date_echeance?.toDate ? t.date_echeance.toDate() : new Date(t.date_echeance);
      if (isNaN(d.getTime())) return;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      d.setHours(0, 0, 0, 0);
      const j = Math.round((d - today) / 86400000);
      if (j > 1) return; // pas encore urgent (au-delà de demain)
      const cle = `oleeducks_notif_tache_${t.id}_${aujourdhui}`;
      if (localStorage.getItem(cle)) return;
      localStorage.setItem(cle, "1");
      if (j < 0) alertes.push(`🔴 "${t.titre}" — en retard de ${Math.abs(j)} j`);
      else if (j === 0) alertes.push(`🟠 "${t.titre}" — échéance aujourd'hui`);
      else alertes.push(`🟡 "${t.titre}" — échéance demain`);
    });
  if (alertes.length) envoyerNotif("📋 Tâches à ne pas oublier", alertes.join("\n"));
}

// =====================================================================
// Écran Notifications (section F de la direction design) : une seule
// liste chronologique, groupée par jour, avec le même vocabulaire de
// gravité que « À traiter » (badges ok/warn/danger). Lecture seule,
// recalculée à chaque ouverture de l'écran plutôt qu'en temps réel —
// cohérent avec le reste du module (pas de flux continu).
// =====================================================================
function dayKeyFor(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabelFor(ms) {
  const d = new Date(ms);
  const today = dayKeyFor(Date.now());
  const key = dayKeyFor(ms);
  if (key === today) return "Aujourd'hui";
  if (key === today - 86400000) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

const FENETRE_FEED_JOURS = 30;

export async function renderNotificationsFeed() {
  const feedEl = document.getElementById("notifFeed");
  if (!feedEl) return;
  feedEl.innerHTML = `<p class="subtle">Chargement…</p>`;
  try {
    const depuis = Date.now() - FENETRE_FEED_JOURS * 86400000;
    const depuisDate = new Date(depuis);
    const [cyclesDebutSnap, cyclesFinSnap, txSnap, tachesSnap] = await Promise.all([
      getDocs(query(collection(db, "nest_cycles"), where("date_debut", ">=", depuisDate))),
      getDocs(query(collection(db, "nest_cycles"), where("date_fin", ">=", depuisDate))),
      getDocs(query(collection(db, "finance_transactions"), where("createdAt", ">=", depuisDate))),
      getDocs(collection(db, "taches"))
    ]);

    const items = [];
    cyclesDebutSnap.docs.forEach(d => {
      const c = d.data();
      items.push({ ms: toMs(c.date_debut), severity: "ok", title: `Ponte démarrée · nid ${c.nid_numero}`, sub: `${c.nombre_oeufs || 0} œuf(s)` });
    });
    cyclesFinSnap.docs.forEach(d => {
      const c = d.data();
      if (c.statut === "eclos") {
        items.push({ ms: toMs(c.date_fin), severity: "ok", title: `Éclosion · nid ${c.nid_numero}`, sub: `${c.nombre_eclos || 0} caneton(s)` });
      } else if (c.statut === "echec") {
        items.push({ ms: toMs(c.date_fin), severity: "danger", title: `Échec de couvaison · nid ${c.nid_numero}`, sub: "Cycle archivé" });
      }
    });
    txSnap.docs.forEach(d => {
      const t = d.data();
      items.push({
        ms: toMs(t.createdAt) || toMs(t.date),
        severity: t.type === "recette" ? "ok" : "warn",
        title: t.type === "recette" ? "Recette enregistrée" : "Dépense enregistrée",
        sub: `${formatFCFA(t.montant)}${t.description ? " · " + escapeHtml(t.description) : ""}`
      });
    });
    tachesSnap.docs.forEach(d => {
      const t = d.data();
      if (t.statut !== "a_faire" || !t.date_echeance) return;
      const dEch = t.date_echeance?.toDate ? t.date_echeance.toDate() : new Date(t.date_echeance);
      if (isNaN(dEch.getTime())) return;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      dEch.setHours(0, 0, 0, 0);
      const j = Math.round((dEch.getTime() - today.getTime()) / 86400000);
      if (j > 1) return;
      items.push({
        ms: Date.now(),
        severity: j < 0 ? "danger" : "warn",
        title: escapeHtml(t.titre),
        sub: j < 0 ? `En retard de ${Math.abs(Math.round(j))} j` : j === 0 ? "Échéance aujourd'hui" : "Échéance demain"
      });
    });

    if (!items.length) {
      feedEl.innerHTML = `<div class="empty-state"><div class="glyph">🔔</div><p>Rien à signaler sur les ${FENETRE_FEED_JOURS} derniers jours.</p></div>`;
      return;
    }

    items.sort((a, b) => b.ms - a.ms);
    const groups = [];
    items.forEach(it => {
      const key = dayKeyFor(it.ms);
      let g = groups.find(g => g.key === key);
      if (!g) { g = { key, ms: it.ms, list: [] }; groups.push(g); }
      g.list.push(it);
    });

    feedEl.innerHTML = groups.map(g => `
      <div class="notif-day-label">${dayLabelFor(g.ms)}</div>
      <div class="card">
        ${g.list.map(it => `
          <div class="row"><div class="row-main"><span class="row-title" style="font-size:14px;">${it.title}</span><span class="row-sub">${it.sub}</span></div><span class="tag ${it.severity}">${it.severity === "danger" ? "Urgent" : it.severity === "warn" ? "À suivre" : "Fait"}</span></div>
        `).join("")}
      </div>
    `).join("");
  } catch (e) {
    console.error("Erreur chargement des notifications :", e);
    feedEl.innerHTML = `<p class="subtle">Erreur de chargement : ${e.message}</p>`;
  }
}
