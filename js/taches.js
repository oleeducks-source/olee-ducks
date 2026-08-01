// =====================================================================
// MODULE : TÂCHES À EFFECTUER
// Pense-bête pour la ferme : notes de commandes clients, tâches
// générales (réparation, nettoyage…), ravitaillement (récupération
// d'aliments au moulin, achats divers…), et tout autre rappel.
//
// Une tâche a un statut "à faire" ou "effectuée" (jamais supprimée par
// défaut — l'historique des tâches effectuées reste consultable). Un
// voyant clignote (tableau de bord + barre de navigation) de plus en
// plus vite à mesure que l'échéance de la tâche la plus urgente
// approche ou est dépassée.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, getDoc, getDocs,
  serverTimestamp, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName, confirmerSuppression, estEnAttenteSuppression } from "./utils.js";

const tachesCol = collection(db, "taches");
let allTaches = [];
let filterView = "a_faire";

export const CATEGORIES_TACHES = {
  commande: { label: "Commande client", icon: "ic-task-commande" },
  ferme: { label: "Tâche à la ferme", icon: "ic-task-ferme" },
  ravitaillement: { label: "Ravitaillement (aliments, moulin…)", icon: "ic-task-ravitaillement" },
  sauvegarde: { label: "Sauvegarde des données", icon: "ic-task-sauvegarde" },
  autre: { label: "Autre", icon: "ic-cat-autre" }
};

// Catégories que l'utilisateur peut choisir à la main dans le formulaire
// d'ajout — "sauvegarde" est réservée au rappel automatique généré par
// l'app elle-même (voir verifierRappelSauvegardeMensuelle), pour éviter
// toute confusion avec une tâche "Autre" ordinaire.
const CATEGORIES_TACHES_SELECTIONNABLES = Object.fromEntries(
  Object.entries(CATEGORIES_TACHES).filter(([k]) => k !== "sauvegarde")
);

// ---------------------------------------------------------------------
// Urgence — basée sur le nombre de jours restants avant l'échéance.
// Une tâche sans échéance n'est jamais "urgente" au sens du clignotant
// (elle reste listée normalement, simplement sans compte à rebours).
// ---------------------------------------------------------------------
function joursRestants(t) {
  if (!t.date_echeance) return null;
  const d = t.date_echeance?.toDate ? t.date_echeance.toDate() : new Date(t.date_echeance);
  if (isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

// Vitesse de clignotement (secondes) : plus la valeur est petite, plus
// le clignotement est rapide. null = pas de clignotement (pas urgent).
function vitesseClignotement(j) {
  if (j === null) return null;
  if (j < 0) return 0.5;   // en retard — le plus rapide
  if (j === 0) return 0.8; // aujourd'hui
  if (j <= 2) return 1.3;  // demain / après-demain
  if (j <= 7) return 2.2;  // cette semaine
  return null;             // pas urgent pour l'instant
}

function urgenceTag(j) {
  if (j === null) return { cls: "", label: "Sans échéance" };
  if (j < 0) return { cls: "danger", label: `En retard de ${Math.abs(j)} j` };
  if (j === 0) return { cls: "warn", label: "Aujourd'hui" };
  if (j === 1) return { cls: "warn", label: "Demain" };
  return { cls: "ok", label: `Dans ${j} j` };
}

// Affiche " à HHhMM" quand l'échéance porte une heure précise (ex : le
// rappel de sauvegarde du samedi 10h) — rien pour une échéance "journée"
// classique saisie via un simple champ date (donc à minuit).
function heureEcheance(dateEcheance) {
  const d = dateEcheance?.toDate ? dateEcheance.toDate() : new Date(dateEcheance);
  if (isNaN(d.getTime()) || (d.getHours() === 0 && d.getMinutes() === 0)) return "";
  return ` à ${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
}

export function initTaches() {
  onSnapshot(query(tachesCol, orderBy("createdAt", "desc")), (snap) => {
    allTaches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAFaireList();
    renderHistoriqueList();
    updateVoyantEtBadge();
  }, err => console.error("Erreur lecture tâches :", err));

  verifierRappelSauvegardeMensuelle();

  document.querySelectorAll("#tachesView button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#tachesView button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filterView = btn.dataset.v;
      document.getElementById("tachesAFaireWrap")?.classList.toggle("hidden", filterView !== "a_faire");
      document.getElementById("tachesHistoriqueWrap")?.classList.toggle("hidden", filterView !== "historique");
    });
  });

  // Depuis le tableau de bord, "Voir tout →" ouvre la page Tâches en
  // réutilisant le bouton de navigation existant (pas de dépendance
  // croisée avec app.js).
  document.getElementById("openTachesBtn")?.addEventListener("click", () => {
    document.querySelector('.nav-item[data-page="taches"]')?.click();
  });
}

// ---------------------------------------------------------------------
// Rappel calendrier (.ics) — solution gratuite pour être averti même si
// l'app n'est jamais rouverte : le fichier généré, une fois ajouté au
// calendrier natif du téléphone (Google Calendar, Calendrier iOS…),
// déclenche une vraie notification système à l'heure prévue. Aucune
// donnée n'est envoyée nulle part — le fichier est créé et téléchargé
// localement dans le navigateur.
// ---------------------------------------------------------------------
function pad(n) { return String(n).padStart(2, "0"); }

function genererRappelCalendrier(t) {
  if (!t.date_echeance) { toast("Ajoutez d'abord une date d'échéance à cette tâche"); return; }
  const d = t.date_echeance?.toDate ? t.date_echeance.toDate() : new Date(t.date_echeance);
  if (isNaN(d.getTime())) { toast("Date d'échéance invalide"); return; }

  // Événement à 8h du matin le jour de l'échéance, avec une alarme au
  // moment même de l'événement — la plupart des calendriers mobiles
  // déclenchent alors une notification système à cette heure précise.
  // Événement à l'heure précise de l'échéance si une heure a été fixée
  // (ex : le rappel de sauvegarde du samedi à 10h) ; à défaut (tâche
  // saisie via un simple champ date, donc à minuit), on garde 8h du matin
  // comme heure par défaut raisonnable.
  const heure = (d.getHours() || d.getMinutes()) ? d.getHours() : 8;
  const minute = (d.getHours() || d.getMinutes()) ? d.getMinutes() : 0;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), heure, minute, 0);
  const end = new Date(start.getTime() + 30 * 60000);
  const toIcsUtc = (date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00Z`;
  const cat = CATEGORIES_TACHES[t.categorie] || CATEGORIES_TACHES.autre;
  const description = [cat.label, t.notes].filter(Boolean).join(" — ").replace(/\n/g, "\\n");

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Olee Ducks//Taches//FR",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:tache-${t.id}@oleeducks`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:🦆 ${t.titre}`,
    description ? `DESCRIPTION:${description}` : "",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Rappel Olee Ducks",
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter(Boolean).join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Rappel_${t.titre.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("Fichier de rappel généré — ouvrez-le pour l'ajouter à votre calendrier");
}

// ---------------------------------------------------------------------
// Rappel automatique de sauvegarde HEBDOMADAIRE, ancré sur le cycle
// samedi 12h → samedi 12h suivant (et non plus lundi → dimanche, pour
// coller exactement à la règle "sauvegarde chaque samedi à 12h"). Ne crée
// une tâche que si aucune sauvegarde n'a été faite depuis le début du
// cycle en cours (par n'importe lequel des 3 téléphones — voir
// "app_meta/sauvegarde", écrit par sauvegarde.js à chaque export réussi)
// ET qu'aucun rappel n'est déjà en attente. Ne relance jamais un doublon.
// ---------------------------------------------------------------------
function prochainSamedi12h(date) {
  const d = new Date(date);
  const jour = d.getDay(); // 0 = dimanche, ..., 6 = samedi
  const joursAvant = (6 - jour + 7) % 7;
  d.setDate(d.getDate() + joursAvant);
  d.setHours(12, 0, 0, 0);
  if (d.getTime() < date.getTime()) d.setDate(d.getDate() + 7); // samedi après 12h passé -> viser le samedi suivant
  return d;
}

async function verifierRappelSauvegardeMensuelle() {
  try {
    const now = new Date();
    const prochainSamedi = prochainSamedi12h(now);
    const debutCycle = new Date(prochainSamedi);
    debutCycle.setDate(debutCycle.getDate() - 7);

    const metaSnap = await getDoc(doc(db, "app_meta", "sauvegarde"));
    if (metaSnap.exists()) {
      const derniere = metaSnap.data().date;
      const derniereDate = derniere?.toDate ? derniere.toDate() : new Date(derniere);
      if (derniereDate >= debutCycle) return; // déjà sauvegardé dans le cycle en cours
    }

    const existanteSnap = await getDocs(query(tachesCol, where("categorie", "==", "sauvegarde"), where("statut", "==", "a_faire")));
    if (!existanteSnap.empty) return; // rappel déjà en attente, pas de doublon

    await addDoc(tachesCol, {
      titre: "Sauvegarder les données de la ferme",
      categorie: "sauvegarde",
      date_echeance: prochainSamedi,
      notes: "Rappel automatique hebdomadaire (samedi 12h) — utilisez le bouton 💾 Sauvegarde sur le tableau de bord.",
      statut: "a_faire",
      cree_par: "Système (auto)",
      createdAt: serverTimestamp()
    });
  } catch (e) {
    console.error("Erreur vérification rappel sauvegarde :", e);
  }
}

// ---------------------------------------------------------------------
// Ajout
// ---------------------------------------------------------------------
export function openAddTacheModal() {
  const body = `
    <div class="field"><label>Titre</label><input type="text" id="fTacheTitre" placeholder="ex : Récupérer les aliments au moulin"></div>
    <div class="field"><label>Catégorie</label>
      <select id="fTacheCategorie">
        ${Object.entries(CATEGORIES_TACHES_SELECTIONNABLES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Date d'échéance (optionnel)</label><input type="date" id="fTacheEcheance"></div>
    <div class="field"><label>Notes (optionnel)</label><textarea id="fTacheNotes" rows="3" placeholder="Détails, référence de commande, quantité à récupérer…"></textarea></div>
    <button class="btn yolk" id="fTacheSave">Ajouter la tâche</button>
  `;
  openModal("Nouvelle tâche", body, {
    onMount: () => {
      document.getElementById("fTacheSave").addEventListener("click", async () => {
        const titre = document.getElementById("fTacheTitre").value.trim();
        if (!titre) { toast("Le titre est requis"); return; }
        const categorie = document.getElementById("fTacheCategorie").value;
        const echeanceVal = document.getElementById("fTacheEcheance").value;
        const notes = document.getElementById("fTacheNotes").value.trim() || null;
        try {
          const ref = await addDoc(tachesCol, {
            titre, categorie,
            date_echeance: echeanceVal ? new Date(echeanceVal) : null,
            notes,
            statut: "a_faire",
            cree_par: getUserName() || "Inconnu",
            createdAt: serverTimestamp()
          });
          toast("Tâche ajoutée ✓");
          if (echeanceVal) {
            // Échéance renseignée : on rouvre directement la fiche pour
            // proposer le rappel calendrier, plutôt que de fermer le modal
            // et laisser l'utilisateur chercher où le trouver.
            openTacheDetail({ id: ref.id, titre, categorie, date_echeance: new Date(echeanceVal), notes, statut: "a_faire", cree_par: getUserName() || "Inconnu" });
          } else {
            closeModal();
          }
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

// ---------------------------------------------------------------------
// Détail / actions sur une tâche
// ---------------------------------------------------------------------
function openTacheDetail(t) {
  const cat = CATEGORIES_TACHES[t.categorie] || CATEGORIES_TACHES.autre;
  const j = joursRestants(t);
  const tag = urgenceTag(j);
  const estEffectuee = t.statut === "effectuee";
  const body = `
    <div class="row"><div class="row-main"><span class="row-title">Catégorie</span></div><span class="row-value">${escapeHtml(cat.label)}</span></div>
    ${t.date_echeance ? `<div class="row"><div class="row-main"><span class="row-title">Échéance</span></div><span class="tag ${tag.cls}">${formatDate(t.date_echeance)}${heureEcheance(t.date_echeance)} · ${tag.label}</span></div>` : ""}
    <div class="row"><div class="row-main"><span class="row-title">Créée par</span></div><span class="row-value">${escapeHtml(t.cree_par || "Inconnu")}</span></div>
    ${estEffectuee ? `<div class="row"><div class="row-main"><span class="row-title">Effectuée par</span></div><span class="row-value">${escapeHtml(t.effectue_par || "")} · ${formatDate(t.effectue_le)}</span></div>` : ""}
    ${t.notes ? `<div class="spacer-s"></div><p class="subtle" style="white-space:pre-wrap;">${escapeHtml(t.notes)}</p>` : ""}
    <div class="spacer-m"></div>
    ${(!estEffectuee && t.date_echeance) ? `<button class="btn secondary" id="fTacheRappel">📅 Ajouter un rappel au calendrier du téléphone</button><div class="spacer-s"></div>` : ""}
    ${!estEffectuee ? `<button class="btn yolk" id="fTacheDone">✓ Marquer comme effectuée</button><div class="spacer-s"></div>` : ""}
    <button class="btn danger" id="fTacheDelete">Supprimer cette tâche</button>
  `;
  openModal(t.titre, body, {
    onMount: () => {
      document.getElementById("fTacheRappel")?.addEventListener("click", () => genererRappelCalendrier(t));
      document.getElementById("fTacheDone")?.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "taches", t.id), {
            statut: "effectuee",
            effectue_par: getUserName() || "Inconnu",
            effectue_le: serverTimestamp()
          });
          toast("Tâche marquée comme effectuée ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
      document.getElementById("fTacheDelete").addEventListener("click", () => {
        closeModal();
        confirmerSuppression(t.id, `Tâche "${t.titre}"`, () => deleteDoc(doc(db, "taches", t.id)), () => { renderAFaireList(); renderHistoriqueList(); });
      });
    }
  });
}

// ---------------------------------------------------------------------
// Listes
// ---------------------------------------------------------------------
function renderAFaireList() {
  const el = document.getElementById("tachesAFaireList");
  if (!el) return;
  const ouvertes = allTaches.filter(t => t.statut === "a_faire" && !estEnAttenteSuppression(t.id)).sort((a, b) => {
    const ja = joursRestants(a), jb = joursRestants(b);
    if (ja === null && jb === null) return 0;
    if (ja === null) return 1;
    if (jb === null) return -1;
    return ja - jb;
  });
  if (!ouvertes.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">📋</div><p>Aucune tâche en attente. Utilisez le bouton + pour en ajouter une.</p></div>`;
    return;
  }
  el.innerHTML = ouvertes.map(t => {
    const cat = CATEGORIES_TACHES[t.categorie] || CATEGORIES_TACHES.autre;
    const tag = urgenceTag(joursRestants(t));
    return `
    <div class="row with-icon tache-row" data-id="${t.id}" style="cursor:pointer;">
      <div class="row-icon ${tag.cls === 'danger' ? 'neg' : tag.cls === 'warn' ? 'warn' : ''}"><svg><use href="#${cat.icon}"/></svg></div>
      <div class="row-main">
        <span class="row-title">${escapeHtml(t.titre)}</span>
        <span class="row-sub">${escapeHtml(cat.label)}${t.notes ? " · " + escapeHtml(t.notes.slice(0, 60)) : ""}</span>
      </div>
      <span class="tag ${tag.cls}">${tag.label}</span>
    </div>`;
  }).join("");
  el.querySelectorAll(".tache-row").forEach(rowEl => {
    rowEl.addEventListener("click", () => {
      const t = allTaches.find(x => x.id === rowEl.dataset.id);
      if (t) openTacheDetail(t);
    });
  });
}

function renderHistoriqueList() {
  const el = document.getElementById("tachesHistoriqueList");
  if (!el) return;
  const effectuees = allTaches.filter(t => t.statut === "effectuee" && !estEnAttenteSuppression(t.id))
    .sort((a, b) => (b.effectue_le?.toMillis?.() || 0) - (a.effectue_le?.toMillis?.() || 0));
  if (!effectuees.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">🗂️</div><p>Aucune tâche effectuée pour l'instant.</p></div>`;
    return;
  }
  el.innerHTML = effectuees.map(t => {
    const cat = CATEGORIES_TACHES[t.categorie] || CATEGORIES_TACHES.autre;
    return `
    <div class="row with-icon tache-row" data-id="${t.id}" style="cursor:pointer;">
      <div class="row-icon pos"><svg><use href="#${cat.icon}"/></svg></div>
      <div class="row-main">
        <span class="row-title">${escapeHtml(t.titre)}</span>
        <span class="row-sub">${escapeHtml(cat.label)} · effectuée le ${formatDate(t.effectue_le)} par ${escapeHtml(t.effectue_par || "")}</span>
      </div>
      <span class="tag ok">✓</span>
    </div>`;
  }).join("");
  el.querySelectorAll(".tache-row").forEach(rowEl => {
    rowEl.addEventListener("click", () => {
      const t = allTaches.find(x => x.id === rowEl.dataset.id);
      if (t) openTacheDetail(t);
    });
  });
}

// ---------------------------------------------------------------------
// Voyant clignotant (tableau de bord + barre de navigation) et résumé
// ---------------------------------------------------------------------
function updateVoyantEtBadge() {
  const ouvertes = allTaches.filter(t => t.statut === "a_faire");
  let pire = null;
  ouvertes.forEach(t => {
    const j = joursRestants(t);
    if (j === null) return;
    if (pire === null || j < pire) pire = j;
  });
  const vitesse = vitesseClignotement(pire);
  const vitesseCss = vitesse ? `${vitesse}s` : "0s";

  const badge = document.getElementById("tachesNavBadge");
  if (badge) {
    badge.classList.toggle("hidden", ouvertes.length === 0);
    badge.textContent = ouvertes.length > 9 ? "9+" : String(ouvertes.length);
    badge.style.setProperty("--blink-speed", vitesseCss);
    badge.classList.toggle("blink", vitesse !== null);
  }

  const voyant = document.getElementById("tachesVoyant");
  if (voyant) {
    voyant.style.setProperty("--blink-speed", vitesseCss);
    voyant.classList.toggle("blink", vitesse !== null);
    voyant.classList.toggle("idle", ouvertes.length === 0);
  }

  const resumeEl = document.getElementById("dashTachesResume");
  if (resumeEl) {
    if (!ouvertes.length) {
      resumeEl.innerHTML = `<p class="subtle">Aucune tâche en attente. ✓</p>`;
    } else {
      const triees = [...ouvertes].sort((a, b) => {
        const ja = joursRestants(a), jb = joursRestants(b);
        if (ja === null && jb === null) return 0;
        if (ja === null) return 1;
        if (jb === null) return -1;
        return ja - jb;
      });
      const plusUrgente = triees[0];
      const cat = CATEGORIES_TACHES[plusUrgente.categorie] || CATEGORIES_TACHES.autre;
      const tag = urgenceTag(joursRestants(plusUrgente));
      resumeEl.innerHTML = `
        <p class="subtle" style="margin-bottom:6px;">${ouvertes.length} tâche(s) en attente</p>
        <div class="row with-icon" style="padding:0; border:none;">
          <div class="row-icon ${tag.cls === 'danger' ? 'neg' : tag.cls === 'warn' ? 'warn' : ''}"><svg><use href="#${cat.icon}"/></svg></div>
          <div class="row-main"><span class="row-title">${escapeHtml(plusUrgente.titre)}</span><span class="row-sub">${escapeHtml(cat.label)}</span></div>
          <span class="tag ${tag.cls}">${tag.label}</span>
        </div>
      `;
    }
  }
}
