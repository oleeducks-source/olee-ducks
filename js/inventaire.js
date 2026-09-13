// =====================================================================
// MODULE : INVENTAIRE DES CANARDS
// Collection Firestore "ducks" — chaque doc peut représenter un lot
// (ex: 12 canetons nés le même jour) ou un individu bagué.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, getDocs,
  serverTimestamp, orderBy, query, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName, animateCountUp, confirmerSuppression, estEnAttenteSuppression } from "./utils.js";
import { openPeseeModal, chargerHistoriquePesees, rendreHistoriquePeseesHtml, refreshPeseesDashboard } from "./pesees.js";

const ducksCol = collection(db, "ducks");
let allDucks = [];
let filterType = "all";
let filterStatut = "actif";
let filterLot = "all";
let searchTerm = "";
let selectionMode = false;
let selectedIds = new Set();

const TYPE_FILTER_OPTIONS = [
  { v: "all", label: "Tous" },
  { v: "caneton", label: "Canetons" },
  { v: "canardeau", label: "Canardeaux" },
  { v: "canard", label: "Canards" },
  { v: "reproducteur_male", label: "Reprod. mâles" },
  { v: "reproducteur_femelle", label: "Reprod. femelles" }
];
const STATUT_FILTER_OPTIONS = [
  { v: "actif", label: "Actifs" },
  { v: "all", label: "Tous statuts" },
  { v: "vendu", label: "Vendus" },
  { v: "mort", label: "Décédés" },
  { v: "reforme", label: "Réformés" }
];

const TYPE_LABELS = {
  caneton: "Caneton",
  canardeau: "Canardeau",
  canard: "Canard",
  reproducteur_male: "Reproducteur mâle",
  reproducteur_femelle: "Reproductrice femelle"
};
const TYPE_ICONS = {
  caneton: "ic-duck-caneton",
  canardeau: "ic-duck-canardeau",
  canard: "ic-duck-canard",
  reproducteur_male: "ic-duck-repro-m",
  reproducteur_femelle: "ic-duck-repro-f"
};
const TYPE_ICONS_EMOJI = { canardeau: "🐤", canard: "🦆" };
const BAGUE_LABELS = { rouge: "Rouge", vert: "Verte", violet: "Violette", bleu: "Bleue" };
const STATUT_LABELS = { actif: "Actif", vendu: "Vendu", mort: "Décédé", reforme: "Réformé" };

// ---------------------------------------------------------------------
// Cycle de vie et requalification automatique par âge.
// Catégorie 1 — Caneton      : 0 à 3 semaines révolues (0-20 jours)
// Catégorie 2 — Canardeau    : 4 à 8 semaines révolues (21-55 jours)
// Catégorie 3 — Canard adulte: 8 semaines et plus (56 jours et +)
//
// L'âge est calculé en priorité à partir de "date_naissance" (date de
// naissance exacte, si renseignée) et sinon à partir de "date_entree"
// (date d'ajout dans l'app, utilisée par défaut). Seuls les lots
// actuellement "caneton" ou "canardeau" ET non verrouillés
// ("verrouille_type" absent ou false) sont concernés par ce décompte
// automatique — un canard ou un reproducteur ne redescend jamais dans
// une catégorie plus jeune, et un lot verrouillé reste au stade choisi
// manuellement tant qu'on ne le déverrouille pas.
//
// ⚠️ CORRECTIF (juillet 2026) : avant ce correctif, un lot dont la
// "date_entree" datait de plusieurs mois (car saisie au moment de la
// création du lot dans l'app, pas de la naissance réelle) se voyait
// recalculé à un âge très avancé. Résultat : une requalification
// manuelle caneton → canardeau était immédiatement "rattrapée" par
// l'automatisme au rafraîchissement suivant, qui faisait alors bondir
// le lot jusqu'à "canard" en une fraction de seconde, car son âge
// calculé dépassait déjà le seuil des 8 semaines. Deux corrections :
// (1) on peut désormais saisir une date de naissance exacte pour
// calibrer correctement l'âge, (2) on peut verrouiller un stade pour
// empêcher toute requalification automatique ultérieure.
// ---------------------------------------------------------------------
const SEMAINE_MS = 7 * 24 * 60 * 60 * 1000;
const SEUIL_CANARDEAU_SEM = 4; // dès la 4e semaine révolue
const SEUIL_CANARD_SEM = 8;    // dès la 8e semaine révolue

function dateReferenceAge(d) {
  return d.date_naissance || d.date_entree;
}

function ageEnSemaines(dateReference) {
  if (!dateReference) return null;
  const d = dateReference?.toDate ? dateReference.toDate() : new Date(dateReference);
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / SEMAINE_MS;
}

function stadeAttendu(ageSemaines) {
  if (ageSemaines === null) return null;
  if (ageSemaines >= SEUIL_CANARD_SEM) return "canard";
  if (ageSemaines >= SEUIL_CANARDEAU_SEM) return "canardeau";
  return "caneton";
}

// Évite de renvoyer plusieurs écritures simultanées sur le même lot
// pendant qu'une requalification est déjà en cours d'enregistrement.
const requalificationEnCours = new Set();

// Collection d'archive : un enregistrement permanent à chaque fois qu'un
// lot de canetons passe au stade canardeau (donc quitte définitivement
// la catégorie "caneton"). Ne compte jamais dans les totaux actifs
// (aucune fonction de KPI ne lit cette collection) — c'est un historique
// de production cumulé, y compris pour des lots depuis vendus/décédés.
const canetonsProductionCol = collection(db, "canetons_production");

async function archiverPassageCanardeau(lot, quantite, auteur) {
  try {
    await addDoc(canetonsProductionCol, {
      quantite,
      date_transition: new Date(),
      date_naissance: lot.date_naissance || null,
      date_entree: lot.date_entree || null,
      lot_origine_id: lot.id,
      bague_couleur: lot.bague_couleur || null,
      enregistre_par: auteur
    });
  } catch (e) {
    console.error("Erreur archivage production canetons :", e);
  }
}

// Parcourt les lots actifs "caneton"/"canardeau" non verrouillés et fait
// automatiquement avancer leur "type" quand l'âge calculé dépasse le
// seuil de la catégorie suivante. Purement additif : ne touche jamais
// aux lots déjà "canard" ou reproducteurs, ne supprime rien, trace
// l'auteur ("Système (auto)") et la date comme pour une requalification
// manuelle, et archive le passage caneton → canardeau.
async function autoRequalifierParAge() {
  const candidats = allDucks.filter(d =>
    d.statut === "actif" && (d.type === "caneton" || d.type === "canardeau") && !d.verrouille_type
  );
  for (const d of candidats) {
    if (requalificationEnCours.has(d.id)) continue;
    const age = ageEnSemaines(dateReferenceAge(d));
    const stade = stadeAttendu(age);
    if (!stade || stade === d.type) continue;
    // On ne saute jamais directement caneton -> canard automatiquement :
    // si le lot a été laissé sans passage par l'app pendant longtemps,
    // il transite d'abord par canardeau au prochain rafraîchissement,
    // puis vers canard ensuite — ceci reste cohérent avec l'historique.
    const prochainStade = d.type === "caneton" ? "canardeau" : "canard";
    requalificationEnCours.add(d.id);
    try {
      await updateDoc(doc(db, "ducks", d.id), {
        type: prochainStade,
        requalifie_par: "Système (auto)",
        requalifie_le: serverTimestamp()
      });
      if (prochainStade === "canardeau") {
        await archiverPassageCanardeau(d, Number(d.quantite) || 1, "Système (auto)");
      }
    } catch (e) {
      console.error("Erreur requalification automatique :", e);
    } finally {
      requalificationEnCours.delete(d.id);
    }
  }
}

export function initInventaire() {
  onSnapshot(query(ducksCol, orderBy("createdAt", "desc")), (snap) => {
    allDucks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderKpis();
    renderFilters();
    renderList();
    autoRequalifierParAge(); // déclenche les écritures nécessaires ; le prochain snapshot rafraîchira l'affichage
  }, (err) => console.error("Erreur lecture inventaire :", err));

  document.getElementById("invFilterType")?.addEventListener("change", (e) => {
    filterType = e.target.value;
    renderFilters(); // recalcule les compteurs croisés des autres menus
    renderList();
  });
  document.getElementById("invFilterStatut")?.addEventListener("change", (e) => {
    filterStatut = e.target.value;
    renderFilters();
    renderList();
  });
  document.getElementById("invFilterLot")?.addEventListener("change", (e) => {
    filterLot = e.target.value;
    renderFilters();
    renderList();
  });
  document.getElementById("invSearch")?.addEventListener("input", (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderList();
  });

  const archiveBtn = document.getElementById("openCanetonsArchiveBtn");
  if (archiveBtn) archiveBtn.addEventListener("click", openCanetonsArchiveModal);

  // ------ Sélection multiple + regroupement en lot ------
  document.getElementById("invLotModeBtn")?.addEventListener("click", toggleSelectionMode);
  document.getElementById("invCancelSelectionBtn")?.addEventListener("click", () => setSelectionMode(false));
  document.getElementById("invAssignLotBtn")?.addEventListener("click", openAssignLotModal);
}

// Compte les effectifs (somme des quantités, hors suppressions en
// attente) pour chaque valeur de type, de statut et de lot.
//
// ⚠️ CORRECTIF (août 2026) : les compteurs étaient calculés globalement,
// indépendamment du filtre déjà actif dans les AUTRES menus déroulants.
// Cela produisait des chiffres incohérents avec les KPI (ex. "Tous (377)"
// alors que les KPI n'affichent que les actifs = 334) et des compteurs
// qui ne correspondaient à rien pour le type sélectionné (ex.
// sélectionner "Canardeaux" affichait quand même "Vendus (38)", qui
// correspondait en réalité aux canards vendus, pas aux canardeaux).
// Les 3 menus sont maintenant croisés : chacun respecte les DEUX AUTRES
// filtres actifs, mais jamais lui-même (sinon son propre total resterait
// figé sur l'option choisie).
function computeFilterCounts() {
  const items = allDucks.filter(d => !estEnAttenteSuppression(d.id));
  const sumBy = (predicate) => items.filter(predicate).reduce((a, d) => a + (Number(d.quantite) || 1), 0);
  const matchesStatut = (d) => filterStatut === "all" || d.statut === filterStatut;
  const matchesType = (d) => filterType === "all" || d.type === filterType;
  const matchesLot = (d) => filterLot === "all" || (d.lot || "") === filterLot;

  const lotValues = Array.from(new Set(items.map(d => d.lot).filter(Boolean))).sort();
  const lots = { all: sumBy(d => matchesType(d) && matchesStatut(d)) };
  lotValues.forEach(l => { lots[l] = sumBy(d => (d.lot || "") === l && matchesType(d) && matchesStatut(d)); });

  return {
    type: {
      all: sumBy(d => matchesStatut(d) && matchesLot(d)),
      caneton: sumBy(d => d.type === "caneton" && matchesStatut(d) && matchesLot(d)),
      canardeau: sumBy(d => d.type === "canardeau" && matchesStatut(d) && matchesLot(d)),
      canard: sumBy(d => d.type === "canard" && matchesStatut(d) && matchesLot(d)),
      reproducteur_male: sumBy(d => d.type === "reproducteur_male" && matchesStatut(d) && matchesLot(d)),
      reproducteur_femelle: sumBy(d => d.type === "reproducteur_femelle" && matchesStatut(d) && matchesLot(d))
    },
    statut: {
      actif: sumBy(d => d.statut === "actif" && matchesType(d) && matchesLot(d)),
      all: sumBy(d => matchesType(d) && matchesLot(d)),
      vendu: sumBy(d => d.statut === "vendu" && matchesType(d) && matchesLot(d)),
      mort: sumBy(d => d.statut === "mort" && matchesType(d) && matchesLot(d)),
      reforme: sumBy(d => d.statut === "reforme" && matchesType(d) && matchesLot(d))
    },
    lots,
    lotValues
  };
}

// Reconstruit les options des menus déroulants avec leurs compteurs à
// jour, sans perdre la sélection en cours. Le menu "Lot" ne s'affiche
// que si au moins un lot a été créé (voir "Regrouper en lot") — pour ne
// pas encombrer l'écran tant que la fonctionnalité n'est pas utilisée.
function renderFilters() {
  const counts = computeFilterCounts();
  const typeEl = document.getElementById("invFilterType");
  const statutEl = document.getElementById("invFilterStatut");
  const lotWrap = document.getElementById("invFilterLotWrap");
  const lotEl = document.getElementById("invFilterLot");
  if (typeEl) {
    typeEl.innerHTML = TYPE_FILTER_OPTIONS.map(o =>
      `<option value="${o.v}" ${o.v === filterType ? "selected" : ""}>${o.label} (${counts.type[o.v]})</option>`
    ).join("");
  }
  if (statutEl) {
    statutEl.innerHTML = STATUT_FILTER_OPTIONS.map(o =>
      `<option value="${o.v}" ${o.v === filterStatut ? "selected" : ""}>${o.label} (${counts.statut[o.v]})</option>`
    ).join("");
  }
  if (lotWrap && lotEl) {
    if (counts.lotValues.length) {
      lotWrap.classList.remove("hidden");
      const opts = [`<option value="all" ${filterLot === "all" ? "selected" : ""}>Tous les lots (${counts.lots.all})</option>`]
        .concat(counts.lotValues.map(l => `<option value="${escapeHtml(l)}" ${l === filterLot ? "selected" : ""}>${escapeHtml(l)} (${counts.lots[l]})</option>`));
      lotEl.innerHTML = opts.join("");
      if (filterLot !== "all" && !counts.lotValues.includes(filterLot)) { filterLot = "all"; lotEl.value = "all"; }
    } else {
      lotWrap.classList.add("hidden");
      filterLot = "all";
    }
  }
}

function activeDucks() {
  return allDucks.filter(d => d.statut === "actif");
}

function formatInputDate(d) {
  const date = d?.toDate ? d.toDate() : new Date(d);
  const off = date.getTimezoneOffset();
  return new Date(date.getTime() - off * 60000).toISOString().slice(0, 10);
}

async function chargerEtAfficherPesees(lotId) {
  const zone = document.getElementById("fPeseesHistorique");
  if (!zone) return;
  try {
    const pesees = await chargerHistoriquePesees(lotId);
    zone.innerHTML = rendreHistoriquePeseesHtml(pesees);
  } catch (e) {
    zone.innerHTML = `<p class="subtle">Erreur de chargement des pesées : ${e.message}</p>`;
  }
}

// Affiche l'archive de production de canetons (collection
// "canetons_production"). Lecture seule, ne modifie rien ; le total
// affiché est purement informatif ("combien de canetons ai-je produits
// au total") et n'entre dans aucun calcul de cheptel actif.
//
// ⚠️ CORRECTIF (août 2026) : cette archive était jusqu'ici modifiable et
// supprimable (quantité corrigible, entrée supprimable comme "doublon").
// Un historique de production doit rester un compteur cumulé fiable et
// non altérable — les entrées sont maintenant strictement en lecture
// seule. Toute correction nécessaire (date de naissance erronée) se
// fait désormais depuis la fiche du lot d'origine dans "Canards", qui
// répercute automatiquement la correction sur l'archive liée.
async function openCanetonsArchiveModal() {
  openModal("Archive des canetons produits", `<p class="subtle">Chargement…</p>`, { onMount: () => {} });
  try {
    const snap = await getDocs(query(canetonsProductionCol, orderBy("date_transition", "desc")));
    const entries = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => !estEnAttenteSuppression(e.id));
    const total = entries.reduce((a, e) => a + (Number(e.quantite) || 0), 0);
    const body = `
      <div class="card" style="background:var(--sage-100); border:none;">
        <div class="row"><div class="row-main"><span class="row-title">Total de canetons produits (cumulé)</span><span class="row-sub">Ne compte pas dans le cheptel actif actuel</span></div><span class="row-value pos">${total}</span></div>
      </div>
      <p class="subtle" style="margin:10px 0 4px;">Historique en lecture seule. Pour corriger une date de naissance, modifiez le lot d'origine dans l'onglet Canards.</p>
      <div class="spacer-s"></div>
      ${entries.length ? entries.map(e => `
        <div class="row with-icon">
          <div class="row-icon"><svg><use href="#ic-duck-canardeau"/></svg></div>
          <div class="row-main">
            <span class="row-title">${e.quantite} caneton(s) passés en canardeau</span>
            <span class="row-sub">${formatDate(e.date_transition)}${e.date_naissance ? " · né(s) le " + formatDate(e.date_naissance) : ""} · ${escapeHtml(e.enregistre_par || "")}</span>
          </div>
        </div>
      `).join("") : `<div class="empty-state"><div class="glyph">🐥</div><p>Aucun passage caneton → canardeau archivé pour l'instant.</p></div>`}
    `;
    openModal("Archive des canetons produits", body, { onMount: () => {} });
  } catch (e) {
    console.error(e);
    openModal("Archive des canetons produits", `<p class="subtle">Erreur de chargement : ${e.message}</p>`, { onMount: () => {} });
  }
}

// Utilisé par stocks.js pour la prévision de consommation basée sur le
// cheptel réel (lecture seule — ne modifie rien ici).
export function getActiveDuckCounts() {
  const actifs = activeDucks();
  const sum = (t) => actifs.filter(d => d.type === t).reduce((a, d) => a + (Number(d.quantite) || 1), 0);
  return {
    caneton: sum("caneton"),
    canardeau: sum("canardeau"),
    canard: sum("canard"),
    reproducteur_male: sum("reproducteur_male"),
    reproducteur_femelle: sum("reproducteur_femelle")
  };
}

function renderKpis() {
  const actifs = activeDucks();
  const sum = (t) => actifs.filter(d => d.type === t).reduce((a, d) => a + (Number(d.quantite) || 1), 0);
  const bagues = { rouge: 0, vert: 0, violet: 0, bleu: 0 };
  actifs.forEach(d => { if (d.bague_couleur && bagues[d.bague_couleur] !== undefined) bagues[d.bague_couleur] += (Number(d.quantite) || 1); });

  const vals = {
    caneton: sum("caneton"),
    canardeau: sum("canardeau"),
    canard: sum("canard"),
    reproducteur_male: sum("reproducteur_male"),
    reproducteur_femelle: sum("reproducteur_femelle")
  };
  const totalActifCount = actifs.reduce((a, d) => a + (Number(d.quantite) || 1), 0);

  // Une catégorie à 0 est grisée (moins de bruit visuel qu'une carte
  // colorée qui affiche juste "0").
  const kpiCell = (label, value, variant) => {
    const cls = value === 0 ? "kpi zero" : `kpi${variant ? " " + variant : ""}`;
    return `<div class="${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></div>`;
  };

  const el = document.getElementById("invKpis");
  if (!el) return;
  el.innerHTML = [
    kpiCell("Canetons", vals.caneton),
    kpiCell("Canardeaux", vals.canardeau),
    kpiCell("Canards", vals.canard),
    kpiCell("Reprod. mâles", vals.reproducteur_male, "alt"),
    kpiCell("Reprod. femelles", vals.reproducteur_femelle, "alt"),
    kpiCell("Total actif", totalActifCount, "yolk")
  ].join("");
  const totalEl = document.getElementById("kpiTotalCanards");
  const subEl = document.getElementById("kpiCanardsSub");
  if (totalEl) animateCountUp("kpiTotalCanards", totalActifCount);
  if (subEl) subEl.textContent = `${vals.reproducteur_male + vals.reproducteur_femelle} reproducteurs · ${vals.canard} canards · ${vals.canardeau} canardeaux · ${vals.caneton} canetons`;

  const dashEl = document.getElementById("dashInventaireBreakdown");
  if (dashEl) {
    const total = totalActifCount || 1;
    dashEl.innerHTML = ["rouge", "vert", "violet", "bleu"].map(c => `
      <div class="row">
        <div class="row-main"><span class="row-title">Bague ${BAGUE_LABELS[c]}</span></div>
        <div style="flex:1; margin:0 12px;" class="stat-bar-track"><div class="stat-bar-fill" style="width:${Math.min(100, (bagues[c] / total) * 100)}%; background:var(--pond-600)"></div></div>
        <div class="row-value">${bagues[c]}</div>
      </div>`).join("");
  }
}

function renderList() {
  const el = document.getElementById("invList");
  if (!el) return;
  let items = allDucks.filter(d => !estEnAttenteSuppression(d.id));
  if (filterType !== "all") items = items.filter(d => d.type === filterType);
  if (filterStatut !== "all") items = items.filter(d => d.statut === filterStatut);
  if (filterLot !== "all") items = items.filter(d => (d.lot || "") === filterLot);
  if (searchTerm) {
    items = items.filter(d => {
      const haystack = [
        d.numero_bague, d.cree_par, d.motif_sortie, d.notes, d.lot, TYPE_LABELS[d.type]
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(searchTerm);
    });
  }

  if (!items.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">🦆</div><p>Aucun enregistrement pour ce filtre.</p></div>`;
    return;
  }
  el.innerHTML = items.map(d => {
    const bagueColorVar = { rouge: "var(--clay-500)", vert: "var(--pond-600)", violet: "#8B5FBF", bleu: "#3D6FBF" }[d.bague_couleur] || "var(--pond-600)";
    // Un lot vendu affiche la date effective de vente plutôt que sa
    // date d'entrée d'origine, plus pertinente pour le suivi.
    const dateLabel = d.statut === "vendu" && d.date_sortie
      ? `Vente : ${formatDate(d.date_sortie)}`
      : `entrée ${formatDate(d.date_entree)}`;
    const checked = selectedIds.has(d.id) ? "checked" : "";
    return `
    <div class="row with-icon" data-id="${d.id}">
      ${selectionMode ? `<input type="checkbox" class="row-select-checkbox" data-id="${d.id}" ${checked}>` : ""}
      <div class="row-icon" style="color:${bagueColorVar}"><svg><use href="#${TYPE_ICONS[d.type] || 'ic-duck-canard'}"/></svg></div>
      <div class="row-main">
        <span class="row-title">${TYPE_LABELS[d.type] || d.type} ${d.quantite > 1 ? `× ${d.quantite}` : ""}${d.lot ? `<span class="lot-chip">🏷️ ${escapeHtml(d.lot)}</span>` : ""}</span>
        <span class="row-sub">${d.numero_bague ? "N° " + escapeHtml(d.numero_bague) + " · " : ""}${d.bague_couleur ? "Bague " + BAGUE_LABELS[d.bague_couleur] : "Sans bague"} · ${dateLabel}${d.cree_par ? " · par " + escapeHtml(d.cree_par) : ""}</span>
      </div>
      <span class="tag ${d.statut === 'actif' ? 'ok' : d.statut === 'mort' ? 'danger' : 'warn'}">${STATUT_LABELS[d.statut] || d.statut}</span>
    </div>
  `;
  }).join("");

  // En mode sélection, un clic sur la ligne (ou sur la case) bascule la
  // sélection au lieu d'ouvrir la fiche d'édition — pour ne pas ouvrir
  // un modal par erreur pendant qu'on constitue un lot.
  el.querySelectorAll(".row").forEach((rowEl, idx) => {
    rowEl.style.cursor = "pointer";
    if (selectionMode) {
      rowEl.addEventListener("click", (e) => {
        if (e.target.classList.contains("row-select-checkbox")) return; // la case gère déjà son propre clic
        toggleSelected(items[idx].id);
      });
      rowEl.querySelector(".row-select-checkbox")?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSelected(items[idx].id);
      });
    } else {
      rowEl.addEventListener("click", () => openEditModal(items[idx]));
    }
  });
}

// ---------------------------------------------------------------------
// Sélection multiple + regroupement en lot
// ---------------------------------------------------------------------
function toggleSelectionMode() {
  setSelectionMode(!selectionMode);
}

function setSelectionMode(on) {
  selectionMode = on;
  if (!on) selectedIds.clear();
  const btn = document.getElementById("invLotModeBtn");
  if (btn) btn.textContent = on ? "✕ Annuler la sélection" : "🏷️ Regrouper en lot";
  updateSelectionBar();
  renderList();
}

function toggleSelected(id) {
  if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  updateSelectionBar();
  // On ne redessine que la case concernée (pas toute la liste) pour ne
  // pas perdre la position de défilement pendant qu'on coche plusieurs
  // lignes d'affilée.
  const cb = document.querySelector(`.row-select-checkbox[data-id="${id}"]`);
  if (cb) cb.checked = selectedIds.has(id);
}

function updateSelectionBar() {
  const bar = document.getElementById("invSelectionBar");
  const countEl = document.getElementById("invSelectionCount");
  if (!bar || !countEl) return;
  bar.classList.toggle("hidden", !selectionMode || selectedIds.size === 0);
  countEl.textContent = `${selectedIds.size} sélectionné(s)`;
}

// Ouvre la boîte de dialogue d'assignation de lot pour les entrées
// actuellement sélectionnées. Propose les lots déjà existants (créés
// précédemment par n'importe qui) via une liste suggérée, pour éviter
// de créer deux lots au nom quasi identique par erreur de frappe.
function openAssignLotModal() {
  if (!selectedIds.size) { toast("Sélectionnez au moins un lot de canards"); return; }
  const lotsExistants = Array.from(new Set(allDucks.map(d => d.lot).filter(Boolean))).sort();
  const selectedItems = allDucks.filter(d => selectedIds.has(d.id));
  const lotCommun = selectedItems.every(d => (d.lot || "") === (selectedItems[0].lot || "")) ? (selectedItems[0].lot || "") : "";

  const body = `
    <p class="subtle">${selectedIds.size} enregistrement(s) sélectionné(s). Attribuez-leur un nom de lot commun (ex. "Abri A", "Éclosion 04-14 août") pour les retrouver d'un coup dans les filtres et la recherche.</p>
    <div class="field">
      <label>Nom du lot</label>
      <input type="text" id="fLotName" list="fLotSuggestions" value="${escapeHtml(lotCommun)}" placeholder="Ex. Abri A">
      <datalist id="fLotSuggestions">${lotsExistants.map(l => `<option value="${escapeHtml(l)}"></option>`).join("")}</datalist>
    </div>
    <button class="btn yolk" id="fLotSave">Assigner à ce lot</button>
    <div class="spacer-s"></div>
    <button class="btn secondary" id="fLotClear">Retirer l'étiquette de lot</button>
  `;
  openModal("Regrouper en lot", body, {
    onMount: () => {
      document.getElementById("fLotSave").addEventListener("click", async () => {
        const nom = document.getElementById("fLotName").value.trim();
        if (!nom) { toast("Indiquez un nom de lot"); return; }
        await appliquerLotSurSelection(nom);
      });
      document.getElementById("fLotClear").addEventListener("click", async () => {
        await appliquerLotSurSelection(null);
      });
    }
  });
}

async function appliquerLotSurSelection(nomLotOuNull) {
  try {
    const batch = writeBatch(db);
    selectedIds.forEach(id => {
      batch.update(doc(db, "ducks", id), {
        lot: nomLotOuNull,
        modifie_par: getUserName() || "Inconnu",
        modifie_le: serverTimestamp()
      });
    });
    await batch.commit();
    toast(nomLotOuNull ? `Lot "${nomLotOuNull}" appliqué à ${selectedIds.size} enregistrement(s) ✓` : `Étiquette de lot retirée ✓`);
    closeModal();
    setSelectionMode(false);
  } catch (e) { toast("Erreur : " + e.message); }
}

export function openAddDuckModal() {
  const body = `
    <div class="field">
      <label>Type</label>
      <select id="fDuckType">
        <option value="caneton">Caneton (0-3 sem.)</option>
        <option value="canardeau">Canardeau (4-8 sem.)</option>
        <option value="canard">Canard (8 sem. et +)</option>
        <option value="reproducteur_male">Reproducteur mâle</option>
        <option value="reproducteur_femelle">Reproductrice femelle</option>
      </select>
    </div>
    <div class="field-row">
      <div class="field"><label>Quantité (lot)</label><input type="number" id="fDuckQte" value="1" min="1"></div>
      <div class="field"><label>Date d'entrée</label><input type="date" id="fDuckDate" value="${todayInputValue()}"></div>
    </div>
    <div class="field"><label>Date de naissance exacte (optionnel)</label><input type="date" id="fDuckDateNaissance"></div>
    <p class="subtle" style="margin:-4px 0 8px;">Pour un caneton ou un canardeau, la date de naissance (si connue) est utilisée en priorité sur la date d'entrée pour calculer l'âge et déclencher la requalification automatique (0-3 sem. → caneton, 4-8 sem. → canardeau, 8 sem. et + → canard).</p>
    <div class="field-row">
      <div class="field">
        <label>Couleur de bague</label>
        <select id="fDuckBague">
          <option value="">Aucune</option>
          <option value="rouge">Rouge</option>
          <option value="vert">Verte</option>
          <option value="violet">Violette</option>
          <option value="bleu">Bleue</option>
        </select>
      </div>
      <div class="field"><label>N° de bague</label><input type="text" id="fDuckNum" placeholder="ex : R-014"></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="fDuckNotes" rows="2" placeholder="Origine, race, remarques…"></textarea></div>
    <button class="btn yolk" id="fDuckSave">Enregistrer</button>
  `;
  openModal("Ajouter au cheptel", body, {
    onMount: () => {
      document.getElementById("fDuckSave").addEventListener("click", async () => {
        const payload = {
          type: document.getElementById("fDuckType").value,
          quantite: Number(document.getElementById("fDuckQte").value) || 1,
          date_entree: new Date(document.getElementById("fDuckDate").value),
          date_naissance: document.getElementById("fDuckDateNaissance").value ? new Date(document.getElementById("fDuckDateNaissance").value) : null,
          bague_couleur: document.getElementById("fDuckBague").value || null,
          numero_bague: document.getElementById("fDuckNum").value.trim() || null,
          notes: document.getElementById("fDuckNotes").value.trim() || null,
          statut: "actif",
          date_sortie: null,
          motif_sortie: null,
          cree_par: getUserName() || "Inconnu",
          createdAt: serverTimestamp()
        };
        try {
          await addDoc(ducksCol, payload);
          toast("Ajouté à l'inventaire ✓");
          closeModal();
        } catch (e) {
          console.error(e);
          toast("Erreur : " + e.message);
        }
      });
    }
  });
}

function openEditModal(d) {
  const isActif = d.statut === "actif";
  const estJeune = d.type === "caneton" || d.type === "canardeau";
  const age = ageEnSemaines(dateReferenceAge(d));
  const prochainStade = d.type === "caneton" ? "canardeau" : "canard";
  const seuilProchain = d.type === "caneton" ? SEUIL_CANARDEAU_SEM : SEUIL_CANARD_SEM;
  const seuilDebut = d.type === "caneton" ? 0 : SEUIL_CANARDEAU_SEM;
  const semainesRestantes = (age !== null && estJeune) ? Math.max(0, Math.ceil(seuilProchain - age)) : null;
  const pctStade = (age !== null && estJeune) ? Math.max(0, Math.min(100, Math.round(((age - seuilDebut) / (seuilProchain - seuilDebut)) * 100))) : 0;
  const body = `
    <div class="row"><div class="row-main"><span class="row-title">Quantité actuelle</span></div><span class="row-value">${d.quantite || 1}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Statut</span></div><span class="tag ${d.statut === 'actif' ? 'ok' : d.statut === 'mort' ? 'danger' : 'warn'}">${STATUT_LABELS[d.statut] || d.statut}</span></div>
    ${!isActif && d.date_sortie ? `<div class="row"><div class="row-main"><span class="row-title">Date de sortie</span></div><span class="row-value">${formatDate(d.date_sortie)}</span></div>` : ""}
    ${!isActif && d.motif_sortie ? `<div class="row" style="flex-direction:column; align-items:flex-start; gap:2px;"><span class="row-title">Motif / note</span><p class="subtle" style="margin:0;">${escapeHtml(d.motif_sortie)}</p></div>` : ""}
    ${age !== null ? `<div class="row"><div class="row-main"><span class="row-title">Âge estimé</span></div><span class="row-value">${age < 1 ? Math.round(age * 7) + " j" : age.toFixed(1) + " sem."}</span></div>` : ""}
    ${d.requalifie_le ? `<div class="row"><div class="row-main"><span class="row-title">Requalifié le</span></div><span class="row-value">${formatDate(d.requalifie_le)}${d.requalifie_par ? " · " + escapeHtml(d.requalifie_par) : ""}</span></div>` : ""}

    ${isActif && estJeune && (d.quantite || 1) > 0 ? `
    <div class="spacer-m"></div>
    <div class="stage-progress">
      <div class="stage-progress-head">
        <span class="row-title">Progression vers ${TYPE_LABELS[prochainStade].toLowerCase()}</span>
        <span class="row-value">${semainesRestantes === 0 ? "Prêt" : `${semainesRestantes} sem. restantes`}</span>
      </div>
      <div class="stage-bar">
        <div class="stage-bar-fill" style="width:${pctStade}%;">
          <span class="stage-marker">${TYPE_ICONS_EMOJI[prochainStade] || "🦆"}</span>
        </div>
      </div>
      <div class="stage-caption">${semainesRestantes !== null ? (semainesRestantes > 0 ? `Passage automatique dans ~${semainesRestantes} semaine(s) selon l'âge, ou forcez-le dès maintenant ci-dessous.` : "Ce lot a atteint l'âge du prochain stade — il sera requalifié automatiquement au prochain rafraîchissement, ou forcez-le maintenant.") : "Basculement manuel avec traçabilité (date, par qui)."}</div>
    </div>
    <div class="spacer-s"></div>
    <div class="card" style="background:#FCEBD9; border:none;">
      <h3 style="font-size:14px; margin-bottom:8px;">Requalifier en ${TYPE_LABELS[prochainStade].toLowerCase()}</h3>
      <div class="field"><label>Quantité concernée</label><input type="number" id="fRequalQte" min="1" max="${d.quantite || 1}" value="${d.quantite || 1}"></div>
      <button class="btn yolk" id="fRequalSave">Requalifier maintenant</button>
    </div>
    ` : ""}

    ${isActif && (d.quantite || 1) > 0 ? `
    <div class="spacer-m"></div>
    <div class="card" style="background:var(--sage-100); border:none;">
      <h3 style="font-size:14px; margin-bottom:2px;">Retirer du cheptel</h3>
      <p class="subtle" style="margin:0 0 10px;">Vente, décès ou réforme d'une partie ou de la totalité de ce lot. Le reste actif n'est pas affecté.</p>
      <div class="field-row">
        <div class="field"><label>Quantité à retirer</label><input type="number" id="fWithdrawQte" min="1" max="${d.quantite || 1}" value="1"></div>
        <div class="field"><label>Motif</label>
          <select id="fWithdrawMotif">
            <option value="vendu">Vendu</option>
            <option value="mort">Décédé</option>
            <option value="reforme">Réformé</option>
          </select>
        </div>
      </div>
      <div class="field"><label>Date du retrait</label><input type="date" id="fWithdrawDate" value="${todayInputValue()}"></div>
      <div class="field"><label>Note (optionnel)</label><input type="text" id="fWithdrawNote" placeholder="ex : vendu au marché de Bingerville"></div>
      <button class="btn yolk" id="fWithdrawSave">Enregistrer le retrait</button>
    </div>
    ` : ""}

    ${isActif ? `
    <div class="spacer-m"></div>
    <div class="card" style="background:var(--sage-100); border:none;">
      <h3 style="font-size:14px; margin-bottom:8px;">Suivi pondéral</h3>
      <button class="btn secondary" id="fPeserBtn">⚖️ Peser un échantillon</button>
      <div class="spacer-s"></div>
      <div id="fPeseesHistorique"><p class="subtle">Chargement…</p></div>
    </div>
    ` : ""}

    <div class="spacer-m"></div>
    <h3 style="font-size:14px; margin-bottom:8px;">Corriger cet enregistrement</h3>
    <div class="field">
      <label>Type / stade</label>
      <select id="eDuckType">
        <option value="caneton" ${d.type === "caneton" ? "selected" : ""}>Caneton (0-3 sem.)</option>
        <option value="canardeau" ${d.type === "canardeau" ? "selected" : ""}>Canardeau (4-8 sem.)</option>
        <option value="canard" ${d.type === "canard" ? "selected" : ""}>Canard (8 sem. et +)</option>
        <option value="reproducteur_male" ${d.type === "reproducteur_male" ? "selected" : ""}>Reproducteur mâle</option>
        <option value="reproducteur_femelle" ${d.type === "reproducteur_femelle" ? "selected" : ""}>Reproductrice femelle</option>
      </select>
    </div>
    <div class="field"><label>Couleur de bague</label>
      <select id="eDuckBague">
        <option value="" ${!d.bague_couleur ? "selected" : ""}>Aucune</option>
        <option value="rouge" ${d.bague_couleur === "rouge" ? "selected" : ""}>Rouge</option>
        <option value="vert" ${d.bague_couleur === "vert" ? "selected" : ""}>Verte</option>
        <option value="violet" ${d.bague_couleur === "violet" ? "selected" : ""}>Violette</option>
        <option value="bleu" ${d.bague_couleur === "bleu" ? "selected" : ""}>Bleue</option>
      </select>
    </div>
    <div class="field"><label>Date de naissance exacte (optionnel — prioritaire sur la date d'entrée pour le calcul d'âge)</label><input type="date" id="eDuckDateNaissance" value="${d.date_naissance ? formatInputDate(d.date_naissance) : ""}"></div>
    <div class="field"><label>Lot (optionnel — ex. "Abri A")</label><input type="text" id="eDuckLot" list="eDuckLotSuggestions" value="${escapeHtml(d.lot || "")}" placeholder="Non affecté à un lot">
      <datalist id="eDuckLotSuggestions">${Array.from(new Set(allDucks.map(x => x.lot).filter(Boolean))).sort().map(l => `<option value="${escapeHtml(l)}"></option>`).join("")}</datalist>
    </div>
    <div class="field" style="display:flex; align-items:center; gap:8px; flex-direction:row;">
      <input type="checkbox" id="eDuckLock" style="width:auto;" ${d.verrouille_type ? "checked" : ""}>
      <label style="margin:0;">Verrouiller ce stade (bloque toute requalification automatique par âge)</label>
    </div>
    <div class="field">
      <label>Statut de l'ensemble du lot</label>
      <select id="eDuckStatut">
        <option value="actif" ${d.statut === "actif" ? "selected" : ""}>Actif</option>
        <option value="vendu" ${d.statut === "vendu" ? "selected" : ""}>Vendu</option>
        <option value="mort" ${d.statut === "mort" ? "selected" : ""}>Décédé</option>
        <option value="reforme" ${d.statut === "reforme" ? "selected" : ""}>Réformé</option>
      </select>
    </div>
    <div class="field"><label>Date de sortie (si vendu/décédé/réformé)</label><input type="date" id="eDuckDateSortie" value="${d.date_sortie ? formatInputDate(d.date_sortie) : todayInputValue()}"></div>
    <div class="field"><label>Corriger la quantité (erreur de saisie uniquement)</label><input type="number" id="eDuckQte" value="${d.quantite || 1}" min="1"></div>
    <div class="field"><label>Motif de sortie (si vendu/décédé)</label><input type="text" id="eDuckMotif" value="${escapeHtml(d.motif_sortie || "")}"></div>
    <div class="field"><label>Notes</label><textarea id="eDuckNotes" rows="2">${escapeHtml(d.notes || "")}</textarea></div>
    <button class="btn secondary" id="eDuckSave">Enregistrer la correction</button>
    <div class="spacer-s"></div>
    <button class="btn danger" id="eDuckDelete">Supprimer l'enregistrement</button>
  `;
  openModal(`${TYPE_LABELS[d.type] || d.type}`, body, {
    onMount: () => {
      const peserBtn = document.getElementById("fPeserBtn");
      if (peserBtn) peserBtn.addEventListener("click", () => openPeseeModal(d, () => { chargerEtAfficherPesees(d.id); refreshPeseesDashboard(); }));
      chargerEtAfficherPesees(d.id);

      const requalBtn = document.getElementById("fRequalSave");
      if (requalBtn) requalBtn.addEventListener("click", async () => {
        const qte = Number(document.getElementById("fRequalQte").value) || 0;
        const currentQte = Number(d.quantite) || 1;
        if (qte <= 0 || qte > currentQte) { toast(`Indiquez une quantité entre 1 et ${currentQte}`); return; }
        try {
          if (qte === currentQte) {
            await updateDoc(doc(db, "ducks", d.id), {
              type: prochainStade,
              requalifie_par: getUserName() || "Inconnu",
              requalifie_le: serverTimestamp()
            });
            if (prochainStade === "canardeau") await archiverPassageCanardeau(d, qte, getUserName() || "Inconnu");
          } else {
            await updateDoc(doc(db, "ducks", d.id), {
              quantite: currentQte - qte,
              modifie_par: getUserName() || "Inconnu",
              modifie_le: serverTimestamp()
            });
            await addDoc(ducksCol, {
              type: prochainStade,
              quantite: qte,
              date_entree: d.date_entree || new Date(),
              date_naissance: d.date_naissance || null,
              bague_couleur: d.bague_couleur || null,
              numero_bague: d.numero_bague || null,
              notes: null,
              statut: "actif",
              date_sortie: null,
              motif_sortie: null,
              issu_du_lot: d.id,
              requalifie_par: getUserName() || "Inconnu",
              requalifie_le: serverTimestamp(),
              cree_par: getUserName() || "Inconnu",
              createdAt: serverTimestamp()
            });
            if (prochainStade === "canardeau") await archiverPassageCanardeau(d, qte, getUserName() || "Inconnu");
          }
          toast(`${qte} sujet(s) requalifié(s) en ${TYPE_LABELS[prochainStade].toLowerCase()} ✓`);
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      const withdrawBtn = document.getElementById("fWithdrawSave");
      if (withdrawBtn) withdrawBtn.addEventListener("click", async () => {
        const qte = Number(document.getElementById("fWithdrawQte").value) || 0;
        const currentQte = Number(d.quantite) || 1;
        if (qte <= 0 || qte > currentQte) { toast(`Indiquez une quantité entre 1 et ${currentQte}`); return; }
        const motif = document.getElementById("fWithdrawMotif").value;
        const note = document.getElementById("fWithdrawNote").value.trim() || null;
        const dateRetrait = document.getElementById("fWithdrawDate").value ? new Date(document.getElementById("fWithdrawDate").value) : new Date();
        try {
          if (qte === currentQte) {
            // Le lot entier part : on met simplement à jour ce document
            await updateDoc(doc(db, "ducks", d.id), {
              statut: motif,
              date_sortie: dateRetrait,
              motif_sortie: note,
              modifie_par: getUserName() || "Inconnu",
              modifie_le: serverTimestamp()
            });
          } else {
            // Retrait partiel : on réduit le lot d'origine et on crée un
            // enregistrement séparé pour la partie sortie, pour garder une
            // trace complète sans jamais perdre le compte.
            await updateDoc(doc(db, "ducks", d.id), {
              quantite: currentQte - qte,
              modifie_par: getUserName() || "Inconnu",
              modifie_le: serverTimestamp()
            });
            await addDoc(ducksCol, {
              type: d.type,
              quantite: qte,
              date_entree: d.date_entree || new Date(),
              bague_couleur: d.bague_couleur || null,
              numero_bague: d.numero_bague || null,
              notes: null,
              statut: motif,
              date_sortie: dateRetrait,
              motif_sortie: note,
              issu_du_lot: d.id,
              cree_par: getUserName() || "Inconnu",
              createdAt: serverTimestamp()
            });
          }
          toast("Retrait enregistré ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      document.getElementById("eDuckSave").addEventListener("click", async () => {
        const statut = document.getElementById("eDuckStatut").value;
        const nouveauType = document.getElementById("eDuckType").value;
        const dateNaissanceVal = document.getElementById("eDuckDateNaissance").value;
        const nouvelleDateNaissance = dateNaissanceVal ? new Date(dateNaissanceVal) : null;
        try {
          const updatePayload = {
            type: nouveauType,
            statut,
            bague_couleur: document.getElementById("eDuckBague").value || null,
            date_naissance: nouvelleDateNaissance,
            lot: document.getElementById("eDuckLot").value.trim() || null,
            verrouille_type: document.getElementById("eDuckLock").checked,
            quantite: Number(document.getElementById("eDuckQte").value) || 1,
            motif_sortie: document.getElementById("eDuckMotif").value.trim() || null,
            notes: document.getElementById("eDuckNotes").value.trim() || null,
            date_sortie: statut !== "actif" && document.getElementById("eDuckDateSortie").value ? new Date(document.getElementById("eDuckDateSortie").value) : null,
            modifie_par: getUserName() || "Inconnu",
            modifie_le: serverTimestamp()
          };
          // ⚠️ CORRECTIF (août 2026) : la date d'entrée ("entrée [date]"
          // affichée dans la liste) ne suivait pas la date de naissance
          // exacte quand celle-ci était corrigée ici — les deux dates
          // pouvaient diverger après une correction. La date d'entrée
          // s'aligne désormais sur la date de naissance dès qu'elle est
          // renseignée, puisqu'un lot dont on connaît la naissance exacte
          // est par définition "entré" ce jour-là.
          if (nouvelleDateNaissance) {
            updatePayload.date_entree = nouvelleDateNaissance;
          }
          await updateDoc(doc(db, "ducks", d.id), updatePayload);

          // Répercute la correction de date sur les archives liées à ce
          // lot, pour qu'elles restent cohérentes avec le cheptel actif :
          // - le cycle de nid d'origine (date d'éclosion affichée dans
          //   Nids > Archives), si ce lot est issu d'une éclosion ;
          // - les entrées "caneton → canardeau" déjà archivées à partir
          //   de ce lot (Canards > Archive des canetons produits).
          if (nouvelleDateNaissance && d.issu_du_cycle_id) {
            try {
              await updateDoc(doc(db, "nest_cycles", d.issu_du_cycle_id), {
                date_fin: nouvelleDateNaissance,
                corrige_par: getUserName() || "Inconnu",
                corrige_le: serverTimestamp()
              });
            } catch (e) { console.error("Erreur mise à jour du cycle de nid lié :", e); }
          }
          if (nouvelleDateNaissance) {
            try {
              const liees = await getDocs(query(canetonsProductionCol, where("lot_origine_id", "==", d.id)));
              if (!liees.empty) {
                const batch = writeBatch(db);
                liees.docs.forEach(docSnap => batch.update(docSnap.ref, { date_naissance: nouvelleDateNaissance }));
                await batch.commit();
              }
            } catch (e) { console.error("Erreur mise à jour des archives de production liées :", e); }
          }

          // Si la correction fait passer le lot en "canardeau" et qu'il ne
          // l'était pas déjà, on archive ce passage — même logique que la
          // requalification automatique ou le bouton dédié, pour que
          // l'archive de production reste complète quelle que soit la
          // méthode utilisée.
          if (nouveauType === "canardeau" && (allDucks.find(x => x.id === d.id)?.type || d.type) !== "canardeau") {
            await archiverPassageCanardeau(d, Number(document.getElementById("eDuckQte").value) || 1, getUserName() || "Inconnu");
          }
          toast("Mis à jour ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
      document.getElementById("eDuckDelete").addEventListener("click", () => {
        closeModal();
        confirmerSuppression(d.id, "Enregistrement", () => deleteDoc(doc(db, "ducks", d.id)), renderList);
      });
    }
  });
}
