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
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot,
  serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName } from "./utils.js";

const tachesCol = collection(db, "taches");
let allTaches = [];
let filterView = "a_faire";

export const CATEGORIES_TACHES = {
  commande: { label: "Commande client", icon: "ic-task-commande" },
  ferme: { label: "Tâche à la ferme", icon: "ic-task-ferme" },
  ravitaillement: { label: "Ravitaillement (aliments, moulin…)", icon: "ic-task-ravitaillement" },
  autre: { label: "Autre", icon: "ic-cat-autre" }
};

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

export function initTaches() {
  onSnapshot(query(tachesCol, orderBy("createdAt", "desc")), (snap) => {
    allTaches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAFaireList();
    renderHistoriqueList();
    updateVoyantEtBadge();
  }, err => console.error("Erreur lecture tâches :", err));

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
// Ajout
// ---------------------------------------------------------------------
export function openAddTacheModal() {
  const body = `
    <div class="field"><label>Titre</label><input type="text" id="fTacheTitre" placeholder="ex : Récupérer les aliments au moulin"></div>
    <div class="field"><label>Catégorie</label>
      <select id="fTacheCategorie">
        ${Object.entries(CATEGORIES_TACHES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}
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
        try {
          await addDoc(tachesCol, {
            titre,
            categorie: document.getElementById("fTacheCategorie").value,
            date_echeance: document.getElementById("fTacheEcheance").value ? new Date(document.getElementById("fTacheEcheance").value) : null,
            notes: document.getElementById("fTacheNotes").value.trim() || null,
            statut: "a_faire",
            cree_par: getUserName() || "Inconnu",
            createdAt: serverTimestamp()
          });
          toast("Tâche ajoutée ✓");
          closeModal();
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
    ${t.date_echeance ? `<div class="row"><div class="row-main"><span class="row-title">Échéance</span></div><span class="tag ${tag.cls}">${formatDate(t.date_echeance)} · ${tag.label}</span></div>` : ""}
    <div class="row"><div class="row-main"><span class="row-title">Créée par</span></div><span class="row-value">${escapeHtml(t.cree_par || "Inconnu")}</span></div>
    ${estEffectuee ? `<div class="row"><div class="row-main"><span class="row-title">Effectuée par</span></div><span class="row-value">${escapeHtml(t.effectue_par || "")} · ${formatDate(t.effectue_le)}</span></div>` : ""}
    ${t.notes ? `<div class="spacer-s"></div><p class="subtle" style="white-space:pre-wrap;">${escapeHtml(t.notes)}</p>` : ""}
    <div class="spacer-m"></div>
    ${!estEffectuee ? `<button class="btn yolk" id="fTacheDone">✓ Marquer comme effectuée</button><div class="spacer-s"></div>` : ""}
    <button class="btn danger" id="fTacheDelete">Supprimer cette tâche</button>
  `;
  openModal(t.titre, body, {
    onMount: () => {
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
      document.getElementById("fTacheDelete").addEventListener("click", async () => {
        if (!confirm("Supprimer définitivement cette tâche ?")) return;
        try {
          await deleteDoc(doc(db, "taches", t.id));
          toast("Tâche supprimée");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
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
  const ouvertes = allTaches.filter(t => t.statut === "a_faire").sort((a, b) => {
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
  const effectuees = allTaches.filter(t => t.statut === "effectuee")
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
