// =====================================================================
// MODULE : TÂCHES À EFFECTUER
// Pense-bête pour la ferme : notes de commandes clients, tâches
// générales (réparation, nettoyage…), ravitaillement (récupération
// d'aliments au moulin, achats divers…), et tout autre rappel.
//
// NOUVEAU (rôles) :
// - Un admin peut ASSIGNER une tâche à un utilisateur précis.
// - Un user simple ne voit QUE les tâches qui lui sont assignées, et
//   ne peut que les marquer comme effectuées.
// - Un admin peut créer/modifier/supprimer librement.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, getDoc, getDocs,
  serverTimestamp, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue,
  getUserName, confirmerSuppression, estEnAttenteSuppression
} from "./utils.js";
import { addDocGuarded, formatDoublonMessage } from "./doublons.js";
import { estAdmin, estUser, getProfil, getUid } from "./auth.js";

const tachesCol = collection(db, "taches");
const usersCol = collection(db, "users");

let allTaches = [];
let allUsers = []; // uniquement rempli côté admin (permission Firestore)
let filterView = "a_faire";

export const CATEGORIES_TACHES = {
  commande: { label: "Commande client", icon: "ic-task-commande" },
  ferme: { label: "Tâche à la ferme", icon: "ic-task-ferme" },
  ravitaillement: { label: "Ravitaillement (aliments, moulin…)", icon: "ic-task-ravitaillement" },
  sauvegarde: { label: "Sauvegarde des données", icon: "ic-task-sauvegarde" },
  autre: { label: "Autre", icon: "ic-cat-autre" }
};

const CATEGORIES_TACHES_SELECTIONNABLES = Object.fromEntries(
  Object.entries(CATEGORIES_TACHES).filter(([k]) => k !== "sauvegarde")
);

// ---------------------------------------------------------------------
// Urgence — identique à avant
// ---------------------------------------------------------------------
function joursRestants(t) {
  if (!t.date_echeance) return null;
  const d = t.date_echeance?.toDate ? t.date_echeance.toDate() : new Date(t.date_echeance);
  if (isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

function vitesseClignotement(j) {
  if (j === null) return null;
  if (j < 0) return 0.5;
  if (j === 0) return 0.8;
  if (j <= 2) return 1.3;
  if (j <= 7) return 2.2;
  return null;
}

function urgenceTag(j) {
  if (j === null) return { cls: "", label: "Sans échéance" };
  if (j < 0) return { cls: "danger", label: `En retard de ${Math.abs(j)} j` };
  if (j === 0) return { cls: "warn", label: "Aujourd'hui" };
  if (j === 1) return { cls: "warn", label: "Demain" };
  return { cls: "ok", label: `Dans ${j} j` };
}

function heureEcheance(dateEcheance) {
  const d = dateEcheance?.toDate ? dateEcheance.toDate() : new Date(dateEcheance);
  if (isNaN(d.getTime()) || (d.getHours() === 0 && d.getMinutes() === 0)) return "";
  return ` à ${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------
// INITIALISATION
// ---------------------------------------------------------------------
export function initTaches() {
  // L'abonnement aux tâches dépend du rôle :
  //   - admin  → toutes les tâches
  //   - user   → uniquement celles qui lui sont assignées
  // Les règles Firestore appliquent la même restriction de leur côté :
  // même si le code client était modifié, le serveur refuserait.

  if (estAdmin()) {
    onSnapshot(query(tachesCol, orderBy("createdAt", "desc")), (snap) => {
      allTaches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAFaireList();
      renderHistoriqueList();
      updateVoyantEtBadge();
    }, err => console.error("Erreur lecture tâches (admin) :", err));

    // Charger la liste des utilisateurs pour l'assignation
    onSnapshot(query(usersCol, orderBy("nom")), (snap) => {
      allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.statut === "actif");
    }, err => {
      if (err.code !== "permission-denied") console.error("Erreur lecture utilisateurs (taches) :", err);
    });

    verifierRappelSauvegardeMensuelle();
  } else if (estUser()) {
    const uid = getUid();
    onSnapshot(query(tachesCol, where("assigne_a", "==", uid)), (snap) => {
      allTaches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAFaireList();
      renderHistoriqueList();
      updateVoyantEtBadge();
    }, err => console.error("Erreur lecture tâches (user) :", err));
  }

  // Bascule À faire / Historique
  document.querySelectorAll("#tachesView button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#tachesView button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filterView = btn.dataset.v;
      document.getElementById("tachesAFaireWrap")?.classList.toggle("hidden", filterView !== "a_faire");
      document.getElementById("tachesHistoriqueWrap")?.classList.toggle("hidden", filterView !== "historique");
    });
  });

  document.getElementById("openTachesBtn")?.addEventListener("click", () => {
    document.querySelector('.nav-item[data-page="taches"]')?.click();
  });
}

// ---------------------------------------------------------------------
// Rappel calendrier .ics (inchangé)
// ---------------------------------------------------------------------
function pad(n) { return String(n).padStart(2, "0"); }

function genererRappelCalendrier(t) {
  if (!t.date_echeance) { toast("Ajoutez d'abord une date d'échéance à cette tâche"); return; }
  const d = t.date_echeance?.toDate ? t.date_echeance.toDate() : new Date(t.date_echeance);
  if (isNaN(d.getTime())) { toast("Date d'échéance invalide"); return; }
  const heure = (d.getHours() || d.getMinutes()) ? d.getHours() : 8;
  const minute = (d.getHours() || d.getMinutes()) ? d.getMinutes() : 0;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), heure, minute, 0);
  const end = new Date(start.getTime() + 30 * 60000);
  const toIcsUtc = (date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00Z`;
  const cat = CATEGORIES_TACHES[t.categorie] || CATEGORIES_TACHES.autre;
  const description = [cat.label, t.notes].filter(Boolean).join(" — ").replace(/\n/g, "\\n");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//Olee Ducks//Taches//FR", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:tache-${t.id}@oleeducks`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:🦆 ${t.titre}`,
    description ? `DESCRIPTION:${description}` : "",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Rappel Olee Ducks", "TRIGGER:PT0M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"
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
// Rappel automatique de sauvegarde hebdomadaire (admin uniquement)
// ---------------------------------------------------------------------
function prochainSamedi12h(date) {
  const d = new Date(date);
  const jour = d.getDay();
  const joursAvant = (6 - jour + 7) % 7;
  d.setDate(d.getDate() + joursAvant);
  d.setHours(12, 0, 0, 0);
  if (d.getTime() < date.getTime()) d.setDate(d.getDate() + 7);
  return d;
}

async function verifierRappelSauvegardeMensuelle() {
  if (!estAdmin()) return;
  try {
    const now = new Date();
    const prochainSamedi = prochainSamedi12h(now);
    const debutCycle = new Date(prochainSamedi);
    debutCycle.setDate(debutCycle.getDate() - 7);
    const metaSnap = await getDoc(doc(db, "app_meta", "sauvegarde"));
    if (metaSnap.exists()) {
      const derniere = metaSnap.data().date;
      const derniereDate = derniere?.toDate ? derniere.toDate() : new Date(derniere);
      if (derniereDate >= debutCycle) return;
    }
    const existanteSnap = await getDocs(query(tachesCol, where("categorie", "==", "sauvegarde"), where("statut", "==", "a_faire")));
    if (!existanteSnap.empty) return;
    await addDocGuarded("taches",
      { titre: "Sauvegarder les données de la ferme", categorie: "sauvegarde", cycle_samedi: debutCycle },
      {
        titre: "Sauvegarder les données de la ferme",
        categorie: "sauvegarde",
        date_echeance: prochainSamedi,
        notes: "Rappel automatique hebdomadaire (samedi 12h) — utilisez le bouton 💾 Sauvegarde sur le tableau de bord.",
        statut: "a_faire",
        cree_par: "Système (auto)",
        createdAt: serverTimestamp()
      },
      "ce rappel automatique de sauvegarde",
      { force: false }
    );
  } catch (e) {
    console.error("Erreur vérification rappel sauvegarde :", e);
  }
}

// ---------------------------------------------------------------------
// Ajout (admin : assignation possible / user : interdit)
// ---------------------------------------------------------------------
export function openAddTacheModal() {
  // Un user simple ne peut pas créer de tâche
  if (!estAdmin()) {
    toast("Seul un administrateur peut créer des tâches");
    return;
  }

  const usersOptions = allUsers.length
    ? allUsers.map(u => `<option value="${u.id}">${escapeHtml(u.nom || u.email)}${u.role === "admin" ? " (admin)" : ""}</option>`).join("")
    : `<option value="">(Aucun utilisateur disponible)</option>`;

  const body = `
    <div class="field"><label>Titre</label><input type="text" id="fTacheTitre" placeholder="ex : Récupérer les aliments au moulin"></div>
    <div class="field"><label>Catégorie</label>
      <select id="fTacheCategorie">
        ${Object.entries(CATEGORIES_TACHES_SELECTIONNABLES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Date d'échéance (optionnel)</label><input type="date" id="fTacheEcheance"></div>
    <div class="field"><label>Assigner à (optionnel)</label>
      <select id="fTacheAssigne">
        <option value="">— Personne (visible par les admins) —</option>
        ${usersOptions}
      </select>
      <p class="subtle" style="margin:6px 0 0;">Si vous assignez cette tâche à un utilisateur simple, il la verra dans son espace et pourra la marquer comme effectuée.</p>
    </div>
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
        const assigne_a = document.getElementById("fTacheAssigne").value || null;

        try {
          const dateEcheance = echeanceVal ? new Date(echeanceVal) : null;
          const ref = await addDocGuarded("taches",
            { titre, categorie, date_echeance: dateEcheance, notes, statut: "a_faire", assigne_a },
            {
              titre, categorie, date_echeance: dateEcheance, notes,
              statut: "a_faire", assigne_a,
              cree_par: getUserName() || getProfil()?.nom || "Inconnu",
              createdAt: serverTimestamp()
            },
            "cette tâche"
          );
          toast("Tâche ajoutée ✓");
          if (echeanceVal) {
            openTacheDetail({
              id: ref.id, titre, categorie, date_echeance: new Date(echeanceVal),
              notes, statut: "a_faire", assigne_a,
              cree_par: getUserName() || getProfil()?.nom || "Inconnu"
            });
          } else {
            closeModal();
          }
        } catch (e) {
          const msg = formatDoublonMessage(e);
          toast(msg || "Erreur : " + e.message);
        }
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
  const isAdmin = estAdmin();
  const utilisateurAssigne = t.assigne_a ? allUsers.find(u => u.id === t.assigne_a) : null;

  const body = `
    <div class="row"><div class="row-main"><span class="row-title">Catégorie</span></div><span class="row-value">${escapeHtml(cat.label)}</span></div>
    ${t.date_echeance ? `<div class="row"><div class="row-main"><span class="row-title">Échéance</span></div><span class="tag ${tag.cls}">${formatDate(t.date_echeance)}${heureEcheance(t.date_echeance)} · ${tag.label}</span></div>` : ""}
    ${utilisateurAssigne ? `<div class="row"><div class="row-main"><span class="row-title">Assignée à</span></div><span class="row-value">${escapeHtml(utilisateurAssigne.nom || utilisateurAssigne.email)}</span></div>` : ""}
    <div class="row"><div class="row-main"><span class="row-title">Créée par</span></div><span class="row-value">${escapeHtml(t.cree_par || "Inconnu")}</span></div>
    ${estEffectuee ? `<div class="row"><div class="row-main"><span class="row-title">Effectuée par</span></div><span class="row-value">${escapeHtml(t.effectue_par || "")} · ${formatDate(t.effectue_le)}</span></div>` : ""}
    ${t.notes ? `<div class="spacer-s"></div><p class="subtle" style="white-space:pre-wrap;">${escapeHtml(t.notes)}</p>` : ""}
    <div class="spacer-m"></div>
    ${(!estEffectuee && t.date_echeance) ? `<button class="btn secondary" id="fTacheRappel">📅 Ajouter un rappel au calendrier du téléphone</button><div class="spacer-s"></div>` : ""}
    ${!estEffectuee ? `<button class="btn yolk" id="fTacheDone">✓ Marquer comme effectuée</button><div class="spacer-s"></div>` : ""}
    ${isAdmin && !estEffectuee ? `<button class="btn secondary" id="fTacheReassign">🔁 Réassigner</button><div class="spacer-s"></div>` : ""}
    ${isAdmin ? `<button class="btn danger" id="fTacheDelete">Supprimer cette tâche</button>` : ""}
  `;

  openModal(t.titre, body, {
    onMount: () => {
      document.getElementById("fTacheRappel")?.addEventListener("click", () => genererRappelCalendrier(t));

      document.getElementById("fTacheDone")?.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "taches", t.id), {
            statut: "effectuee",
            effectue_par: getProfil()?.nom || getUserName() || "Inconnu",
            effectue_le: serverTimestamp()
          });
          toast("Tâche marquée comme effectuée ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      document.getElementById("fTacheReassign")?.addEventListener("click", () => {
        if (!allUsers.length) { toast("Aucun utilisateur disponible"); return; }
        openModal("Réassigner la tâche", `
          <div class="field"><label>Nouvel assigné</label>
            <select id="fReassign">
              <option value="">— Personne —</option>
              ${allUsers.map(u => `<option value="${u.id}" ${u.id === t.assigne_a ? "selected" : ""}>${escapeHtml(u.nom || u.email)}</option>`).join("")}
            </select>
          </div>
          <button class="btn yolk" id="fReassignSave">Enregistrer</button>
        `, {
          onMount: () => {
            document.getElementById("fReassignSave").addEventListener("click", async () => {
              const val = document.getElementById("fReassign").value || null;
              try {
                await updateDoc(doc(db, "taches", t.id), { assigne_a: val, reassigne_par: getProfil()?.nom || "Admin", reassigne_le: serverTimestamp() });
                toast("Réassignation enregistrée ✓");
                closeModal();
              } catch (e) { toast("Erreur : " + e.message); }
            });
          }
        });
      });

      document.getElementById("fTacheDelete")?.addEventListener("click", () => {
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
    el.innerHTML = `<div class="empty-state"><div class="glyph">📋</div><p>${estAdmin() ? "Aucune tâche en attente. Utilisez le bouton + pour en ajouter une." : "Aucune tâche ne vous est assignée pour le moment. ✓"}</p></div>`;
    return;
  }
  el.innerHTML = ouvertes.map(t => {
    const cat = CATEGORIES_TACHES[t.categorie] || CATEGORIES_TACHES.autre;
    const tag = urgenceTag(joursRestants(t));
    const assigne = t.assigne_a ? allUsers.find(u => u.id === t.assigne_a) : null;
    const assigneLabel = assigne ? `<span class="lot-chip">👤 ${escapeHtml(assigne.nom || assigne.email)}</span>` : "";
    return `
    <div class="row with-icon tache-row" data-id="${t.id}" style="cursor:pointer;">
      <div class="row-icon ${tag.cls === 'danger' ? 'neg' : tag.cls === 'warn' ? 'warn' : ''}"><svg><use href="#${cat.icon}"/></svg></div>
      <div class="row-main">
        <span class="row-title">${escapeHtml(t.titre)} ${assigneLabel}</span>
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
// Voyant clignotant (dashboard + bottom nav)
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
