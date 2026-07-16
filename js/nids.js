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
import { formatDate, formatDateTime, toast, openModal, closeModal, todayInputValue, getUserName, escapeHtml } from "./utils.js";

const nestsCol = collection(db, "nests");
const cyclesCol = collection(db, "nest_cycles");
const pontesCol = collection(db, "pontes_journalieres");

let nestsMap = {};   // numero -> nest doc
let cyclesMap = {};  // cycle id -> cycle doc (cycles en cours, indexées par id)
let archivedCycles = []; // cycles terminées (eclos / echec)
let pontesLog = []; // tous les relevés de ponte datés (tous nids, tous cycles)
let currentNidsView = "grille";

const DUREE_INCUBATION_JOURS = 28; // incubation moyenne du canard

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
    cyclesMap = {};
    snap.docs.forEach(d => { cyclesMap[d.id] = { id: d.id, ...d.data() }; });
    renderGrids();
    renderEnCoursList();
    renderDashboardNestKpi();
  }, err => console.error("Erreur lecture cycles en cours :", err));

  onSnapshot(query(cyclesCol, where("statut", "in", ["eclos", "echec"]), orderBy("date_fin", "desc")), (snap) => {
    archivedCycles = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderArchives();
    renderStats();
  }, err => console.error("Erreur lecture archives :", err));

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

function renderGrids() {
  ["miniNestGrid", "fullNestGrid"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    let html = "";
    for (let n = 1; n <= 100; n++) {
      const c = cycleForNest(n);
      const cls = c ? (c.statut === "couvaison" ? "couvaison" : "occupe") : "";
      html += `<div class="nest-cell ${cls}" data-n="${n}">${n}</div>`;
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
  if (elV) elV.textContent = totalOeufs;
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
    <div class="row">
      <div class="row-main">
        <span class="row-title">Nid n° ${c.nid_numero}</span>
        <span class="row-sub">${c.nombre_oeufs || 0} œuf(s) · depuis ${formatDate(c.date_debut)}${c.cree_par ? " · par " + escapeHtml(c.cree_par) : ""}</span>
      </div>
      <span class="tag ${c.statut === 'couvaison' ? 'warn' : 'ok'}">${c.statut === "couvaison" ? "Couvaison" : "Ponte"}</span>
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
    return `
    <div class="row">
      <div class="row-main">
        <span class="row-title">Nid n° ${c.nid_numero} — ${formatDate(c.date_fin)}</span>
        <span class="row-sub">${c.nombre_oeufs || 0} œufs → ${c.nombre_eclos || 0} éclos${c.archive_par ? " · par " + escapeHtml(c.archive_par) : ""}</span>
      </div>
      <span class="tag ${c.statut === 'eclos' ? 'ok' : 'danger'}">${taux}%</span>
    </div>`;
  }).join("");
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
      <div class="row">
        <div class="row-main"><span class="row-title">#${i + 1} — Nid n° ${r.n}</span><span class="row-sub">${r.cycles} cycle(s) · ${r.eclos}/${r.oeufs} œufs éclos</span></div>
        <span class="row-value pos">${Math.round(r.taux * 100)}%</span>
      </div>`).join("");
  }

  const totalOeufs = archivedCycles.reduce((a, c) => a + (Number(c.nombre_oeufs) || 0), 0);
  const totalEclos = archivedCycles.reduce((a, c) => a + (Number(c.nombre_eclos) || 0), 0);
  const taux = totalOeufs ? Math.round((totalEclos / totalOeufs) * 100) : 0;
  const kpiT = document.getElementById("kpiTauxEclosion");
  if (kpiT) kpiT.textContent = taux + "%";
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
      <div class="field"><label>Œufs pondus aujourd'hui</label><input type="number" id="fOeufs" value="1" min="1"></div>
      <button class="btn yolk" id="fStart">Démarrer la ponte</button>
    `, {
      onMount: () => {
        document.getElementById("fStart").addEventListener("click", async () => {
          const initialQte = Number(document.getElementById("fOeufs").value) || 0;
          try {
            const cRef = await addDoc(cyclesCol, {
              nid_numero: n,
              statut: "ponte",
              date_debut: new Date(),
              nombre_oeufs: initialQte,
              date_debut_couvaison: null,
              date_fin: null,
              nombre_eclos: null,
              cree_par: getUserName() || "Inconnu",
              createdAt: serverTimestamp()
            });
            await updateDoc(doc(db, "nests", String(n)), { statut_actuel: "occupe", cycle_actuel_id: cRef.id });
            await addDoc(pontesCol, {
              nid_numero: n, cycle_id: cRef.id, date: new Date(),
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

  openModal(`Nid n° ${n}`, `
    <div class="row"><div class="row-main"><span class="row-title">Statut</span></div><span class="tag ${cycle.statut === 'couvaison' ? 'warn' : 'ok'}">${cycle.statut === 'couvaison' ? 'Couvaison' : 'Ponte en cours'}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Œufs enregistrés</span></div><span class="row-value">${cycle.nombre_oeufs || 0}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Début du cycle</span></div><span class="row-value">${formatDate(cycle.date_debut)}</span></div>
    ${cycle.cree_par ? `<div class="row"><div class="row-main"><span class="row-title">Démarré par</span></div><span class="row-value">${escapeHtml(cycle.cree_par)}</span></div>` : ""}
    ${cycle.statut === "couvaison" ? `<div class="row"><div class="row-main"><span class="row-title">Couvaison depuis</span></div><span class="row-value">${joursDepuisCouvaison} j / ${DUREE_INCUBATION_JOURS} j</span></div>` : ""}
    <div class="spacer-m"></div>

    ${cycle.statut === "ponte" ? `
    <div class="field-row">
      <div class="field"><label>Ajouter des œufs (relevé du jour)</label><input type="number" id="fAddOeufs" value="1" min="1"></div>
      <div class="field"><label>Retirer des œufs (correction)</label><input type="number" id="fRemoveOeufs" value="1" min="1" max="${cycle.nombre_oeufs || 0}"></div>
    </div>
    <div class="field-row">
      <button class="btn secondary" id="fAddBtn">Enregistrer la ponte du jour</button>
      <button class="btn secondary" id="fRemoveBtn">Retirer (erreur de saisie)</button>
    </div>
    <div class="spacer-s"></div>
    <button class="btn yolk" id="fToCouvaison">Démarrer la couvaison</button>
    ` : `
    <div class="field"><label>Nombre de canetons éclos</label><input type="number" id="fEclos" value="0" min="0"></div>
    <button class="btn yolk" id="fFinish">Enregistrer l'éclosion (archive le cycle)</button>
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
        try {
          const cRef = doc(db, "nest_cycles", cycle.id);
          await updateDoc(cRef, { nombre_oeufs: increment(q) });
          await addDoc(pontesCol, {
            nid_numero: n, cycle_id: cycle.id, date: new Date(),
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

      const finish = document.getElementById("fFinish");
      if (finish) finish.addEventListener("click", async () => {
        const eclos = Number(document.getElementById("fEclos").value) || 0;
        await archiveCycle(n, cycle, "eclos", eclos);
      });
      const echec = document.getElementById("fEchec");
      if (echec) echec.addEventListener("click", async () => {
        if (!confirm("Confirmer l'échec de la couvaison pour ce nid ?")) return;
        await archiveCycle(n, cycle, "echec", 0);
      });
    }
  });
}

async function archiveCycle(n, cycle, statut, nombreEclos) {
  try {
    await updateDoc(doc(db, "nest_cycles", cycle.id), {
      statut, nombre_eclos: nombreEclos, date_fin: new Date(), archive_par: getUserName() || "Inconnu"
    });
    await updateDoc(doc(db, "nests", String(n)), { statut_actuel: "libre", cycle_actuel_id: null });
    toast(statut === "eclos" ? `Éclosion enregistrée — nid ${n} archivé ✓` : `Échec enregistré — nid ${n} archivé`);
    closeModal();
  } catch (e) { toast("Erreur : " + e.message); }
}
