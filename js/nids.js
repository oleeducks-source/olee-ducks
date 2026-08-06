// =====================================================================
// MODULE : GESTION DES NIDS
// - Collection "nests" (100 docs "1".."100") : état courant du nid.
// - Collection "nest_cycles" : un document par cycle d'occupation
//   (ponte -> couvaison -> éclosion). Quand un cycle se termine, le nid
//   redevient libre mais le cycle N'EST JAMAIS SUPPRIMÉ : il reste comme
//   archive consultable dans les statistiques (nids les plus productifs).
// - Collection "pontes_journalieres" : un doc par mouvement d'œufs daté
//   (ajout initial, relevé du jour, correction négative). Sert de base
//   au calcul de la moyenne de ponte par jour, tolérant les jours sans
//   relevé (voir calculerMoyenneParJour).
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc, getDocs, onSnapshot,
  serverTimestamp, query, where, orderBy, increment, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatDate, formatDateTime, toast, openModal, closeModal, todayInputValue, getUserName, escapeHtml, animateCountUp } from "./utils.js";

const nestsCol = collection(db, "nests");
const cyclesCol = collection(db, "nest_cycles");
const pontesCol = collection(db, "pontes_journalieres");
const eclosionsCol = collection(db, "eclosions_journalieres");
const ducksCol = collection(db, "ducks");

let nestsMap = {};   // numero -> nest doc
let cyclesMap = {};  // cycle id -> cycle doc (cycles en cours, indexées par id)
let archivedCycles = []; // cycles terminées (eclos / echec)
let pontesLog = []; // tous les relevés de ponte datés (tous nids, tous cycles)
let currentNidsView = "grille";

const DUREE_INCUBATION_JOURS = 36; // canard de Barbarie (muscovy) — 35 à 37 jours, 36 en moyenne

let premierChargementCycles = true;

export function initNests() {
  ensureNestsExist().catch((e) => {
    console.error("Impossible d'initialiser les 100 nids :", e);
    toast("Erreur d'initialisation des nids : " + (e.code || e.message));
  });

  onSnapshot(nestsCol, (snap) => {
    nestsMap = {};
    snap.docs.forEach(d => { nestsMap[d.id] = { id: d.id, ...d.data() }; });
    renderGrids();
    renderDashboardNestKpi();
  }, err => console.error("Erreur lecture nids :", err));

  onSnapshot(query(cyclesCol, where("statut", "in", ["ponte", "couvaison"])), (snap) => {
    const nouveauCyclesMap = {};
    snap.docs.forEach(d => { nouveauCyclesMap[d.id] = { id: d.id, ...d.data() }; });

    // Détecte toute variation du nombre d'œufs (ce téléphone ou un autre)
    // pour déclencher l'animation "+N" au coin du nid concerné — sauf au
    // tout premier chargement de la page, pour ne pas tout animer d'un
    // coup à l'ouverture de l'app.
    if (!premierChargementCycles) {
      Object.values(nouveauCyclesMap).forEach(c => {
        const avant = cyclesMap[c.id];
        const avantQte = avant ? Number(avant.nombre_oeufs) || 0 : 0;
        const apresQte = Number(c.nombre_oeufs) || 0;
        const delta = apresQte - avantQte;
        if (delta !== 0) animerGainOeufs(c.nid_numero, delta);
      });
    }
    premierChargementCycles = false;

    cyclesMap = nouveauCyclesMap;
    renderGrids();
    renderEnCoursList();
    renderDashboardNestKpi();
  }, err => console.error("Erreur lecture cycles en cours :", err));

  onSnapshot(query(cyclesCol, where("statut", "in", ["eclos", "echec"]), orderBy("date_fin", "desc")), (snap) => {
    archivedCycles = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderArchives();
    renderStats();
  }, err => {
    console.error("Erreur lecture archives :", err);
    const el = document.getElementById("nidsArchivesList");
    if (el) el.innerHTML = `<div class="empty-state"><div class="glyph">⚠️</div><p>Erreur de chargement des archives : ${err.code || err.message}.<br>Si le message mentionne un "index", ouvrez la console (F12), un lien pour le créer automatiquement doit y apparaître.</p></div>`;
    toast("Erreur de chargement des archives (voir console)");
  });

  onSnapshot(query(pontesCol, orderBy("date", "asc")), (snap) => {
    pontesLog = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderStats();
  }, err => console.error("Erreur lecture journal de pontes :", err));

  document.querySelectorAll("#nidsView button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#nidsView button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentNidsView = btn.dataset.v;
      showNidsView();
    });
  });
}

function showNidsView() {
  document.getElementById("nidsGrilleWrap").classList.toggle("hidden", currentNidsView !== "grille");
  document.getElementById("nidsEnCoursWrap").classList.toggle("hidden", currentNidsView !== "encours");
  document.getElementById("nidsStatsWrap").classList.toggle("hidden", currentNidsView !== "stats");
  document.getElementById("nidsArchivesWrap").classList.toggle("hidden", currentNidsView !== "archives");
}

// Crée les 100 nids une seule fois (idempotent : ne recrée pas s'ils existent déjà)
async function ensureNestsExist() {
  const first = await getDoc(doc(db, "nests", "1"));
  if (first.exists()) return;
  const batch = writeBatch(db);
  for (let n = 1; n <= 100; n++) {
    batch.set(doc(db, "nests", String(n)), {
      numero: n, statut_actuel: "libre", cycle_actuel_id: null
    }, { merge: true });
  }
  await batch.commit();
  toast("100 nids initialisés ✓");
}

function cycleForNest(n) {
  return Object.values(cyclesMap).find(c => c.nid_numero === n);
}

// Anime un petit badge "+N" (ou "-N") avec une icône d'œuf dans le coin
// supérieur droit du nid concerné, sur toutes les grilles visibles
// (mini-grille du tableau de bord + grille complète de la page Nids).
// Purement visuel, ne lit ni n'écrit aucune donnée.
function animerGainOeufs(n, delta) {
  if (!delta) return;
  document.querySelectorAll(`.nest-cell[data-n="${n}"]`).forEach(cell => {
    const badge = document.createElement("div");
    badge.className = "egg-pop" + (delta < 0 ? " neg" : "");
    badge.innerHTML = `<svg viewBox="0 0 40 40"><use href="#ic-nest-ponte"/></svg><span>${delta > 0 ? "+" : ""}${delta}</span>`;
    cell.appendChild(badge);
    requestAnimationFrame(() => badge.classList.add("play"));
    setTimeout(() => badge.remove(), 1500);
  });
}

function renderGrids() {
  ["miniNestGrid", "fullNestGrid"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    let html = "";
    for (let n = 1; n <= 100; n++) {
      const c = cycleForNest(n);
      const cls = c ? (c.statut === "couvaison" ? "couvaison" : "ponte") : "";
      const icon = c ? (c.statut === "couvaison" ? "ic-nest-couvaison" : "ic-nest-ponte") : "ic-nest-libre";
      html += `<div class="nest-cell ${cls}" data-n="${n}"><svg><use href="#${icon}"/></svg><span class="nest-num">${n}</span></div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll(".nest-cell").forEach(cell => {
      cell.addEventListener("click", () => openNestModal(Number(cell.dataset.n)));
    });
  });
  const occ = Object.keys(cyclesMap).length;
  const qc = document.getElementById("nestsQuickCount");
  if (qc) qc.textContent = `${occ}/100 occupés`;
}

function renderDashboardNestKpi() {
  const totalOeufs = Object.values(cyclesMap).reduce((a, c) => a + (Number(c.nombre_oeufs) || 0), 0);
  const occ = Object.keys(cyclesMap).length;
  const elV = document.getElementById("kpiOeufsNids");
  const elS = document.getElementById("kpiNidsOccupesSub");
  if (elV) animateCountUp("kpiOeufsNids", totalOeufs);
  if (elS) elS.textContent = `${occ} nids occupés sur 100`;
}

function renderEnCoursList() {
  const el = document.getElementById("nidsEnCoursList");
  if (!el) return;
  const list = Object.values(cyclesMap).sort((a, b) => a.nid_numero - b.nid_numero);
  if (!list.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">🪺</div><p>Aucun nid occupé actuellement.</p></div>`;
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="row with-icon">
      <div class="row-icon ${c.statut === 'couvaison' ? 'warn' : 'pos'}"><svg><use href="#${c.statut === 'couvaison' ? 'ic-nest-couvaison' : 'ic-nest-ponte'}"/></svg></div>
      <div class="row-main">
        <span class="row-title">Nid n° ${c.nid_numero}</span>
        <span class="row-sub">${c.nombre_oeufs || 0} œuf(s) · depuis ${formatDate(c.date_debut)}${c.cree_par ? " · par " + escapeHtml(c.cree_par) : ""}${c.nombre_eclos ? ` · 🐣 ${c.nombre_eclos} déjà éclos` : ""}</span>
      </div>
      <span class="tag ${c.statut === 'couvaison' ? (c.nombre_eclos ? 'ok' : 'warn') : 'ok'}">${c.statut === "couvaison" ? (c.nombre_eclos ? "Éclosion en cours" : "Couvaison") : "Ponte"}</span>
    </div>
  `).join("");
  el.querySelectorAll(".row").forEach((rowEl, idx) => {
    rowEl.style.cursor = "pointer";
    rowEl.addEventListener("click", () => openNestModal(list[idx].nid_numero));
  });
}

function renderArchives() {
  const el = document.getElementById("nidsArchivesList");
  if (!el) return;
  if (!archivedCycles.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">📦</div><p>Aucun cycle archivé pour le moment.</p></div>`;
    return;
  }
  el.innerHTML = archivedCycles.map(c => {
    const taux = c.nombre_oeufs ? Math.round((c.nombre_eclos || 0) / c.nombre_oeufs * 100) : 0;
    const succes = c.statut === "eclos";
    return `
    <div class="row with-icon archive-row" data-id="${c.id}" style="cursor:pointer;">
      <div class="row-icon ${succes ? 'pos' : 'neg'}"><svg><use href="#${succes ? 'ic-nest-eclos' : 'ic-nest-echec'}"/></svg></div>
      <div class="row-main">
        <span class="row-title">Nid n° ${c.nid_numero} — ${formatDate(c.date_fin)}</span>
        <span class="row-sub">${c.nombre_oeufs || 0} œufs → ${c.nombre_eclos || 0} éclos${c.archive_par ? " · par " + escapeHtml(c.archive_par) : ""}</span>
      </div>
      <span class="tag ${succes ? 'ok' : 'danger'}">${taux}%</span>
    </div>`;
  }).join("");
  el.querySelectorAll(".archive-row").forEach(rowEl => {
    rowEl.addEventListener("click", () => {
      const c = archivedCycles.find(x => x.id === rowEl.dataset.id);
      if (c) openArchiveDetailModal(c);
    });
  });
}

// Correction d'un cycle déjà archivé (nombre d'œufs/éclos erroné à la
// saisie) + rattrapage manuel pour les cycles archivés AVANT le
// correctif du lien nids → inventaire (voir archiveCycle) : le bouton
// "Ajouter au cheptel" n'apparaît que si ce n'est pas déjà fait, pour ne
// jamais créer de doublon.
// Fiche d'un cycle archivé — STRICTEMENT EN LECTURE SEULE. Une archive
// ne se corrige jamais après coup (même logique que la comptabilité
// OHADA du module : une écriture validée ne se modifie pas, elle se
// contre-passe si une erreur est découverte). Le nombre d'œufs et
// d'éclosions saisi au moment de l'archivage reste la trace fidèle de
// ce qui a été constaté ce jour-là.
//
// Le seul rattrapage possible ici concerne les cycles archivés AVANT la
// mise en place du lien automatique avec l'inventaire (voir
// archiveCycle) : on vérifie — sans jamais écrire quoi que ce soit sur
// le cycle archivé lui-même — si un lot de canetons issu de ce cycle
// existe déjà dans l'inventaire (recherche par issu_du_cycle_id), pour
// proposer l'ajout uniquement s'il manque réellement.
async function openArchiveDetailModal(c) {
  const taux = c.nombre_oeufs ? Math.round((c.nombre_eclos || 0) / c.nombre_oeufs * 100) : 0;
  const body = `
    <div class="row"><div class="row-main"><span class="row-title">Date d'archivage</span></div><span class="row-value">${formatDate(c.date_fin)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Œufs constatés</span></div><span class="row-value">${c.nombre_oeufs || 0}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Canetons éclos</span></div><span class="row-value">${c.nombre_eclos || 0}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Taux d'éclosion</span></div><span class="row-value">${taux}%</span></div>
    ${c.archive_par ? `<div class="row"><div class="row-main"><span class="row-title">Archivé par</span></div><span class="row-value">${escapeHtml(c.archive_par)}</span></div>` : ""}
    <div class="spacer-s"></div>
    <p class="subtle">🔒 Cette archive est en lecture seule — un cycle une fois clôturé ne se modifie plus, pour garantir la fiabilité de l'historique.</p>
    <div id="fArchInventaireZone"></div>
  `;
  openModal(`Nid n° ${c.nid_numero}`, body, {
    onMount: async () => {
      if (c.statut !== "eclos" || !(c.nombre_eclos > 0)) return;
      const zone = document.getElementById("fArchInventaireZone");
      // Détecte un ajout déjà fait — soit via le lien automatique
      // (issu_du_cycle_id), soit un ajout manuel antérieur à cette
      // fonctionnalité (même date d'entrée que l'archivage + même
      // quantité que le nombre de canetons éclos ce jour-là).
      const canetonsSnap = await getDocs(query(ducksCol, where("type", "==", "caneton")));
      const dateFinCycle = c.date_fin?.toDate ? c.date_fin.toDate() : new Date(c.date_fin);
      const dejaAjoute = canetonsSnap.docs.some(docSnap => {
        const dd = docSnap.data();
        if (dd.issu_du_cycle_id === c.id) return true;
        if (!dd.date_entree || Number(dd.quantite) !== Number(c.nombre_eclos)) return false;
        const de = dd.date_entree?.toDate ? dd.date_entree.toDate() : new Date(dd.date_entree);
        return de.getFullYear() === dateFinCycle.getFullYear() && de.getMonth() === dateFinCycle.getMonth() && de.getDate() === dateFinCycle.getDate();
      });
      zone.innerHTML = `
        <div class="spacer-m"></div>
        <div class="card" style="background:${dejaAjoute ? 'var(--sage-100)' : '#FCEBD9'}; border:none;">
          <h3 style="font-size:14px; margin-bottom:4px;">Inventaire des canards</h3>
          ${dejaAjoute
            ? `<p class="subtle" style="margin:0;">✓ Ces canetons figurent déjà dans l'inventaire.</p>`
            : `<p class="subtle" style="margin:0 0 10px;">Ce cycle a été archivé avant la mise en place du lien automatique avec l'inventaire — les canetons nés ici n'y figurent pas encore.</p>
               <button class="btn yolk" id="fArchAddInventaire">🐥 Ajouter ${c.nombre_eclos} caneton(s) au cheptel</button>`}
        </div>
      `;
      const addBtn = document.getElementById("fArchAddInventaire");
      if (addBtn) addBtn.addEventListener("click", async () => {
        try {
          await addDoc(ducksCol, {
            type: "caneton", quantite: Number(c.nombre_eclos) || 0,
            date_entree: c.date_fin || new Date(), date_naissance: c.date_fin || new Date(),
            bague_couleur: null, numero_bague: null,
            notes: `Éclosion nid n° ${c.nid_numero} (rattrapage manuel)`,
            statut: "actif", date_sortie: null, motif_sortie: null,
            issu_du_nid: c.nid_numero, issu_du_cycle_id: c.id,
            cree_par: getUserName() || "Inconnu", createdAt: serverTimestamp()
          });
          toast(`${c.nombre_eclos} caneton(s) ajoutés à l'inventaire ✓`);
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

function toDateObj(d) {
  return d?.toDate ? d.toDate() : new Date(d);
}

function dayKey(d) {
  const date = toDateObj(d);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// Calcule une moyenne par jour calendaire entre le premier et le dernier
// événement (inclus), en comptant les jours sans événement comme des jours
// à zéro — donc les périodes sans relevé font bien baisser la moyenne,
// comme demandé.
function calculerMoyenneParJour(events, dateField, valueField) {
  if (!events.length) return { total: 0, moyenne: 0, jours: 0 };
  const dates = events.map(e => toDateObj(e[dateField]).getTime());
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  const jours = Math.max(1, Math.round((max - min) / 86400000) + 1);
  const total = events.reduce((a, e) => a + (Number(e[valueField]) || 0), 0);
  return { total, moyenne: total / jours, jours };
}

function renderDailyAverages() {
  const el = document.getElementById("dailyAverageStats");
  if (!el) return;

  const ponte = calculerMoyenneParJour(pontesLog, "date", "quantite");
  const eclosions = archivedCycles.filter(c => c.statut === "eclos" && c.date_fin);
  const canetons = calculerMoyenneParJour(eclosions, "date_fin", "nombre_eclos");

  el.innerHTML = `
    <div class="row">
      <div class="row-main"><span class="row-title">Ponte moyenne / jour</span><span class="row-sub">${ponte.jours} jour(s) couverts, du premier au dernier relevé</span></div>
      <span class="row-value">${ponte.moyenne.toFixed(1)} œuf(s)</span>
    </div>
    <div class="row">
      <div class="row-main"><span class="row-title">Canetons éclos / jour</span><span class="row-sub">${canetons.jours} jour(s) couverts, entre la 1ère et la dernière éclosion</span></div>
      <span class="row-value">${canetons.moyenne.toFixed(1)} caneton(s)</span>
    </div>
  `;
}

function renderStats() {
  renderDailyAverages();
  const topEl = document.getElementById("topNestsList");
  const globalEl = document.getElementById("globalHatchStats");
  if (!topEl || !globalEl) return;

  const byNest = {};
  archivedCycles.forEach(c => {
    byNest[c.nid_numero] = byNest[c.nid_numero] || { oeufs: 0, eclos: 0, cycles: 0 };
    byNest[c.nid_numero].oeufs += Number(c.nombre_oeufs) || 0;
    byNest[c.nid_numero].eclos += Number(c.nombre_eclos) || 0;
    byNest[c.nid_numero].cycles += 1;
  });
  const ranked = Object.entries(byNest)
    .map(([n, s]) => ({ n, ...s, taux: s.oeufs ? s.eclos / s.oeufs : 0 }))
    .sort((a, b) => b.taux - a.taux || b.eclos - a.eclos)
    .slice(0, 10);

  if (!ranked.length) {
    topEl.innerHTML = `<p class="subtle">Pas encore assez de cycles archivés pour établir un classement.</p>`;
  } else {
    topEl.innerHTML = ranked.map((r, i) => `
      <div class="row with-icon">
        <div class="row-icon pos"><svg><use href="#ic-nest-eclos"/></svg></div>
        <div class="row-main"><span class="row-title">#${i + 1} — Nid n° ${r.n}</span><span class="row-sub">${r.cycles} cycle(s) · ${r.eclos}/${r.oeufs} œufs éclos</span></div>
        <span class="row-value pos">${Math.round(r.taux * 100)}%</span>
      </div>`).join("");
  }

  const totalOeufs = archivedCycles.reduce((a, c) => a + (Number(c.nombre_oeufs) || 0), 0);
  const totalEclos = archivedCycles.reduce((a, c) => a + (Number(c.nombre_eclos) || 0), 0);
  const taux = totalOeufs ? Math.round((totalEclos / totalOeufs) * 100) : 0;
  const kpiT = document.getElementById("kpiTauxEclosion");
  if (kpiT) animateCountUp("kpiTauxEclosion", taux, { suffix: "%" });
  globalEl.innerHTML = `
    <div class="row"><div class="row-main"><span class="row-title">Œufs couvés (archivés)</span></div><span class="row-value">${totalOeufs}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Canetons éclos</span></div><span class="row-value pos">${totalEclos}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Taux d'éclosion global</span></div><span class="row-value">${taux}%</span></div>
  `;
}

// ---------------------------------------------------------------------
// Modal de détail / actions sur un nid
// ---------------------------------------------------------------------
function openNestModal(n) {
  const cycle = cycleForNest(n);

  if (!cycle) {
    openModal(`Nid n° ${n}`, `
      <p class="subtle">Ce nid est libre. Démarrez un nouveau cycle de ponte.</p>
      <div class="spacer-s"></div>
      <div class="field"><label>Date de début de ponte</label><input type="date" id="fPonteDate" value="${todayInputValue()}"></div>
      <div class="field"><label>Œufs pondus à ce jour</label><input type="number" id="fOeufs" value="1" min="1"></div>
      <button class="btn yolk" id="fStart">Démarrer la ponte</button>
    `, {
      onMount: () => {
        document.getElementById("fStart").addEventListener("click", async () => {
          const initialQte = Number(document.getElementById("fOeufs").value) || 0;
          const dateDebut = new Date(document.getElementById("fPonteDate").value);
          try {
            const cRef = await addDoc(cyclesCol, {
              nid_numero: n,
              statut: "ponte",
              date_debut: dateDebut,
              nombre_oeufs: initialQte,
              date_debut_couvaison: null,
              date_fin: null,
              nombre_eclos: null,
              cree_par: getUserName() || "Inconnu",
              createdAt: serverTimestamp()
            });
            await updateDoc(doc(db, "nests", String(n)), { statut_actuel: "occupe", cycle_actuel_id: cRef.id });
            await addDoc(pontesCol, {
              nid_numero: n, cycle_id: cRef.id, date: dateDebut,
              quantite: initialQte, motif: "ponte_initiale",
              par: getUserName() || "Inconnu", createdAt: serverTimestamp()
            });
            toast(`Ponte démarrée — nid ${n} ✓`);
            closeModal();
          } catch (e) { toast("Erreur : " + e.message); }
        });
      }
    });
    return;
  }

  const joursDepuisCouvaison = cycle.date_debut_couvaison ? Math.round((Date.now() - (cycle.date_debut_couvaison.toDate?.() || new Date(cycle.date_debut_couvaison))) / 86400000) : null;

  const pctCouvaison = joursDepuisCouvaison !== null ? Math.max(0, Math.min(100, Math.round((joursDepuisCouvaison / DUREE_INCUBATION_JOURS) * 100))) : 0;
  const joursRestants = joursDepuisCouvaison !== null ? Math.max(0, DUREE_INCUBATION_JOURS - joursDepuisCouvaison) : null;

  openModal(`Nid n° ${n}`, `
    <div class="row"><div class="row-main"><span class="row-title">Statut</span></div><span class="tag ${cycle.statut === 'couvaison' ? (cycle.nombre_eclos ? 'ok' : 'warn') : 'ok'}">${cycle.statut === 'couvaison' ? (cycle.nombre_eclos ? 'Éclosion en cours' : 'Couvaison') : 'Ponte en cours'}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Œufs enregistrés</span></div><span class="row-value">${cycle.nombre_oeufs || 0}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Début du cycle</span></div><span class="row-value">${formatDate(cycle.date_debut)}</span></div>
    ${cycle.cree_par ? `<div class="row"><div class="row-main"><span class="row-title">Démarré par</span></div><span class="row-value">${escapeHtml(cycle.cree_par)}</span></div>` : ""}
    ${cycle.statut === "couvaison" ? `
    <div class="spacer-s"></div>
    <div class="incubation-progress">
      <div class="incubation-progress-head">
        <span class="row-title">Couvaison (canard de Barbarie — ${DUREE_INCUBATION_JOURS} j)</span>
        <span class="row-value">${joursDepuisCouvaison} / ${DUREE_INCUBATION_JOURS} j</span>
      </div>
      <div class="incubation-bar">
        <div class="incubation-bar-fill" style="width:${pctCouvaison}%;">
          <span class="incubation-egg">🥚</span>
        </div>
      </div>
      <div class="incubation-caption">${joursRestants > 0 ? `⏳ Éclosion estimée dans ~${joursRestants} jour(s)` : "🐣 Éclosion imminente — vérifiez le nid !"}</div>
    </div>
    ` : ""}
    <div class="spacer-m"></div>

    <div class="field-row">
      <div class="field"><label>Date du relevé</label><input type="date" id="fAddDate" value="${todayInputValue()}"></div>
      <div class="field"><label>Ajouter des œufs</label><input type="number" id="fAddOeufs" value="1" min="1"></div>
    </div>
    <div class="field"><label>Retirer des œufs (correction, même pendant la couvaison)</label><input type="number" id="fRemoveOeufs" value="1" min="1" max="${cycle.nombre_oeufs || 0}"></div>
    <div class="field-row">
      <button class="btn secondary" id="fAddBtn">Enregistrer un ajout</button>
      <button class="btn secondary" id="fRemoveBtn">Retirer (erreur de saisie)</button>
    </div>
    <div class="spacer-s"></div>

    ${cycle.statut === "ponte" ? `
    <button class="btn yolk" id="fToCouvaison">Démarrer la couvaison</button>
    ` : `
    ${cycle.nombre_eclos ? `<p class="subtle" style="margin-bottom:8px;">Déjà enregistré pour ce cycle : <b>${cycle.nombre_eclos}</b> caneton(s) éclos.</p>` : ""}
    <div class="field"><label>Canetons éclos à ce relevé</label><input type="number" id="fEclos" value="0" min="0"></div>
    <p class="subtle" style="margin:-4px 0 10px;">Une couvée de canard de Barbarie éclot souvent en plusieurs vagues, étalées sur plusieurs jours. Enregistrez chaque relevé au fur et à mesure — le nid ne sera archivé que lorsque vous cliquerez sur "Archiver".</p>
    <div class="field-row">
      <button class="btn secondary" id="fEclosAddBtn">🐣 Enregistrer (sans archiver)</button>
    </div>
    <div class="spacer-s"></div>
    <button class="btn yolk" id="fFinish">🏁 Archiver ce nid (cycle terminé)</button>
    <div class="spacer-s"></div>
    <button class="btn danger" id="fEchec">Déclarer un échec de couvaison</button>
    `}
    <div class="spacer-m"></div>
    <button class="btn danger" id="fResetNest">↺ Réinitialiser ce nid (mauvais nid sélectionné)</button>
  `, {
    onMount: () => {
      const addBtn = document.getElementById("fAddBtn");
      if (addBtn) addBtn.addEventListener("click", async () => {
        const q = Number(document.getElementById("fAddOeufs").value) || 0;
        const dateReleve = new Date(document.getElementById("fAddDate").value);
        try {
          const cRef = doc(db, "nest_cycles", cycle.id);
          await updateDoc(cRef, { nombre_oeufs: increment(q) });
          await addDoc(pontesCol, {
            nid_numero: n, cycle_id: cycle.id, date: dateReleve,
            quantite: q, motif: "releve_quotidien",
            par: getUserName() || "Inconnu", createdAt: serverTimestamp()
          });
          toast("Relevé du jour enregistré ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      const removeBtn = document.getElementById("fRemoveBtn");
      if (removeBtn) removeBtn.addEventListener("click", async () => {
        const q = Number(document.getElementById("fRemoveOeufs").value) || 0;
        const current = Number(cycle.nombre_oeufs) || 0;
        if (q <= 0 || q > current) { toast(`Indiquez une quantité entre 1 et ${current}`); return; }
        try {
          const cRef = doc(db, "nest_cycles", cycle.id);
          await updateDoc(cRef, { nombre_oeufs: increment(-q) });
          await addDoc(pontesCol, {
            nid_numero: n, cycle_id: cycle.id, date: new Date(),
            quantite: -q, motif: "correction",
            par: getUserName() || "Inconnu", createdAt: serverTimestamp()
          });
          toast("Correction enregistrée ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      const resetBtn = document.getElementById("fResetNest");
      if (resetBtn) resetBtn.addEventListener("click", async () => {
        if (!confirm(`Réinitialiser le nid ${n} ? Cette action annule le cycle en cours (erreur de saisie) et libère le nid. Utilisez plutôt "Échec de couvaison" s'il s'agit d'un vrai événement à conserver dans les statistiques.`)) return;
        try {
          const snap = await getDocs(query(pontesCol, where("cycle_id", "==", cycle.id)));
          const batch = writeBatch(db);
          snap.docs.forEach(d => batch.delete(d.ref));
          batch.delete(doc(db, "nest_cycles", cycle.id));
          batch.set(doc(db, "nests", String(n)), { numero: n, statut_actuel: "libre", cycle_actuel_id: null });
          await batch.commit();
          toast(`Nid ${n} réinitialisé ✓`);
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      const toCouv = document.getElementById("fToCouvaison");
      if (toCouv) toCouv.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "nest_cycles", cycle.id), { statut: "couvaison", date_debut_couvaison: new Date(), modifie_par: getUserName() || "Inconnu" });
          toast(`Couvaison démarrée — nid ${n} ✓`);
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      // Enregistre une vague d'éclosion SANS archiver le nid — le cycle
      // reste actif ("couvaison") pour permettre d'autres relevés les
      // jours suivants, jusqu'à l'archivage explicite.
      const eclosAddBtn = document.getElementById("fEclosAddBtn");
      if (eclosAddBtn) eclosAddBtn.addEventListener("click", async () => {
        const q = Number(document.getElementById("fEclos").value) || 0;
        if (q <= 0) { toast("Indiquez un nombre de canetons éclos supérieur à 0"); return; }
        try {
          await updateDoc(doc(db, "nest_cycles", cycle.id), { nombre_eclos: increment(q) });
          await addDoc(eclosionsCol, {
            nid_numero: n, cycle_id: cycle.id, date: new Date(),
            quantite: q, par: getUserName() || "Inconnu", createdAt: serverTimestamp()
          });
          toast(`${q} éclosion(s) enregistrée(s) — nid ${n} toujours actif ✓`);
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      const finish = document.getElementById("fFinish");
      if (finish) finish.addEventListener("click", async () => {
        const eclosSupp = Number(document.getElementById("fEclos").value) || 0;
        await archiveCycle(n, cycle, "eclos", eclosSupp);
      });
      const echec = document.getElementById("fEchec");
      if (echec) echec.addEventListener("click", async () => {
        if (!confirm("Confirmer l'échec de la couvaison pour ce nid ?")) return;
        await archiveCycle(n, cycle, "echec", 0);
      });
    }
  });
}

// Archive définitivement le cycle. `eclosSupplementaires` est ajouté au
// total déjà accumulé via les relevés successifs (fEclosAddBtn) — permet
// d'enregistrer une dernière vague d'éclosion en même temps que
// l'archivage, en un seul geste.
//
// ⚠️ CORRECTIF (août 2026) : jusqu'ici, l'archivage d'un cycle "éclos" ne
// créait AUCUN enregistrement dans l'inventaire des canards — les
// canetons nés n'apparaissaient nulle part dans le décompte du cheptel.
// Un lot de canetons est maintenant automatiquement créé dans
// l'inventaire à l'archivage, avec le nid d'origine tracé.
async function archiveCycle(n, cycle, statut, eclosSupplementaires) {
  try {
    const totalEclos = (Number(cycle.nombre_eclos) || 0) + (Number(eclosSupplementaires) || 0);
    if (eclosSupplementaires > 0) {
      await addDoc(eclosionsCol, {
        nid_numero: n, cycle_id: cycle.id, date: new Date(),
        quantite: eclosSupplementaires, par: getUserName() || "Inconnu", createdAt: serverTimestamp()
      });
    }
    const dateFin = new Date();
    await updateDoc(doc(db, "nest_cycles", cycle.id), {
      statut, nombre_eclos: totalEclos, date_fin: dateFin, archive_par: getUserName() || "Inconnu"
    });
    await updateDoc(doc(db, "nests", String(n)), { statut_actuel: "libre", cycle_actuel_id: null });

    if (statut === "eclos" && totalEclos > 0) {
      await addDoc(ducksCol, {
        type: "caneton", quantite: totalEclos,
        date_entree: dateFin, date_naissance: dateFin,
        bague_couleur: null, numero_bague: null,
        notes: `Éclosion nid n° ${n}`,
        statut: "actif", date_sortie: null, motif_sortie: null,
        issu_du_nid: n, issu_du_cycle_id: cycle.id,
        cree_par: getUserName() || "Inconnu", createdAt: serverTimestamp()
      });
    }

    toast(statut === "eclos" ? `Nid ${n} archivé — ${totalEclos} caneton(s) ajoutés à l'inventaire ✓` : `Échec enregistré — nid ${n} archivé`);
    closeModal();
  } catch (e) { toast("Erreur : " + e.message); }
}
