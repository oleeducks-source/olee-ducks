// =====================================================================
// MODULE : COMPTABILITÉ OHADA (SYSCOHADA révisé)
// - "accounts" : plan de comptes (numéro, libellé, classe 1-7, nature)
// - "exercises" : exercices comptables (un par année, statut ouvert/clôturé)
// - "journal_ecritures" : écritures validées, en partie double (tableau
//   "lines"). Une correction ne modifie JAMAIS une écriture existante :
//   elle crée une écriture de CONTRE-PASSATION (inverse) qui l'annule,
//   pour garder une trace complète (règle professionnelle de base).
// - "finance_transactions" (existante) : reste "brouillon" tant qu'elle
//   n'a pas été transformée en écriture.
//
// Validation 100% côté application (pas de Cloud Functions, reste
// gratuit) : équilibre Débit=Crédit, comptes existants, exercice ouvert.
// Chaque écriture est rattachée à l'exercice correspondant à LA DATE
// RÉELLE de la transaction (pas à un exercice "par défaut").
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, doc, addDoc, updateDoc, setDoc, getDoc, getDocs, onSnapshot,
  serverTimestamp, query, where, orderBy, increment, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatFCFA, formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName } from "./utils.js";

const accountsCol = collection(db, "accounts");
const exercisesCol = collection(db, "exercises");
const journalCol = collection(db, "journal_ecritures");
const finCol = collection(db, "finance_transactions");

let allAccounts = [];
let allExercises = [];
let selectedExerciceId = null; // exercice affiché dans l'onglet États financiers
let allJournal = [];
let allBrouillons = [];
let currentComptaView = "brouillons";

// ---------------------------------------------------------------------
// Plan de comptes par défaut (point de départ raisonnable pour une
// ferme — à ajuster avec un comptable OHADA agréé avant tout usage
// officiel : ce module ne remplace pas un avis professionnel).
// ---------------------------------------------------------------------
const DEFAULT_ACCOUNTS = [
  { numero: "101", libelle: "Capital", classe: 1, nature: "passif" },
  { numero: "211", libelle: "Immobilisations (bâtiments, matériel durable)", classe: 2, nature: "actif" },
  { numero: "311", libelle: "Stocks d'aliments et vétérinaire", classe: 3, nature: "actif" },
  { numero: "355", libelle: "Stock de canards (cheptel)", classe: 3, nature: "actif" },
  { numero: "401", libelle: "Fournisseurs", classe: 4, nature: "passif" },
  { numero: "411", libelle: "Clients", classe: 4, nature: "actif" },
  { numero: "421", libelle: "Personnel — salaires dus", classe: 4, nature: "passif" },
  { numero: "521", libelle: "Banque", classe: 5, nature: "actif" },
  { numero: "571", libelle: "Caisse", classe: 5, nature: "actif" },
  { numero: "601", libelle: "Achats d'aliments", classe: 6, nature: "charge" },
  { numero: "602", libelle: "Achats de matériel / consommables", classe: 6, nature: "charge" },
  { numero: "604", libelle: "Achats de produits vétérinaires", classe: 6, nature: "charge" },
  { numero: "605", libelle: "Achats d'animaux (canetons/reproducteurs)", classe: 6, nature: "charge" },
  { numero: "606", libelle: "Eau", classe: 6, nature: "charge" },
  { numero: "607", libelle: "Électricité", classe: 6, nature: "charge" },
  { numero: "661", libelle: "Charges de personnel (salaires)", classe: 6, nature: "charge" },
  { numero: "701", libelle: "Ventes de canards", classe: 7, nature: "produit" },
  { numero: "702", libelle: "Ventes d'œufs", classe: 7, nature: "produit" },
  { numero: "703", libelle: "Ventes de canetons", classe: 7, nature: "produit" }
];

// Correspondance automatique catégorie de transaction -> comptes suggérés
const MAPPING_COMPTABLE = {
  vente_canards: { debit: "571", credit: "701" },
  vente_oeufs: { debit: "571", credit: "702" },
  vente_canetons: { debit: "571", credit: "703" },
  aliments: { debit: "601", credit: "571" },
  materiel: { debit: "602", credit: "571" },
  veterinaire: { debit: "604", credit: "571" },
  achat_animaux: { debit: "605", credit: "571" },
  eau: { debit: "606", credit: "571" },
  electricite: { debit: "607", credit: "571" },
  salaire: { debit: "661", credit: "571" },
  autre: { debit: null, credit: null }
};

const CATS_LABELS = {
  vente_canards: "Vente de canards", vente_oeufs: "Vente d'œufs", vente_canetons: "Vente de canetons", autre: "Autre recette",
  salaire: "Salaire du fermier", eau: "Facture d'eau", electricite: "Facture d'électricité",
  materiel: "Achat de matériel", aliments: "Achat d'aliments", veterinaire: "Produits vétérinaires",
  achat_animaux: "Achat d'animaux"
};

// ---------------------------------------------------------------------
// Validation d'une écriture (partie double) — sans Cloud Functions.
// ---------------------------------------------------------------------
export function validerEcriture(lines, exerciceStatut, comptesExistants) {
  const erreurs = [];
  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  if (Math.round(totalDebit * 100) !== Math.round(totalCredit * 100)) {
    erreurs.push(`Débit (${totalDebit}) ≠ Crédit (${totalCredit}) — l'écriture n'est pas équilibrée.`);
  }
  lines.forEach(l => {
    if (!l.compte || !comptesExistants.has(l.compte)) {
      erreurs.push(`Le compte "${l.compte || "(vide)"}" n'existe pas dans le plan de comptes.`);
    }
    const d = Number(l.debit) || 0, c = Number(l.credit) || 0;
    if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
      erreurs.push("Chaque ligne doit avoir soit un débit, soit un crédit — pas les deux, pas aucun.");
    }
  });
  if (exerciceStatut !== "ouvert") {
    erreurs.push("L'exercice comptable est clôturé, aucune nouvelle écriture n'est autorisée.");
  }
  return erreurs;
}

function exerciceForYear(year) {
  return allExercises.find(e => e.annee === year) || null;
}
function exerciceForDate(dateVal) {
  const d = dateVal?.toDate ? dateVal.toDate() : new Date(dateVal);
  return exerciceForYear(d.getFullYear());
}

export function initComptabilite() {
  ensureDefaultAccounts().catch(e => console.error("Erreur init plan de comptes :", e));

  onSnapshot(query(accountsCol, orderBy("numero")), snap => {
    allAccounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderComptesList();
    renderBrouillonsList();
  }, err => console.error("Erreur lecture plan de comptes :", err));

  onSnapshot(query(exercisesCol, orderBy("annee", "desc")), snap => {
    allExercises = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!selectedExerciceId || !allExercises.some(e => e.id === selectedExerciceId)) {
      const ouvert = allExercises.find(e => e.statut === "ouvert");
      selectedExerciceId = (ouvert || allExercises[0] || {}).id || null;
    }
    renderExercicesCard();
    renderEtatsFinanciers();
  }, err => console.error("Erreur lecture exercices :", err));

  onSnapshot(query(journalCol, orderBy("date", "desc")), snap => {
    allJournal = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderJournalList();
    renderEtatsFinanciers();
  }, err => console.error("Erreur lecture journal :", err));

  onSnapshot(query(finCol, orderBy("date", "desc")), snap => {
    allBrouillons = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(t => t.statut_comptable !== "valide");
    ensureExercisesExist(snap.docs.map(d => d.data().date)).catch(e => console.error("Erreur init exercices :", e));
    renderBrouillonsList();
    renderNettoyageCard();
  }, err => console.error("Erreur lecture transactions :", err));

  document.getElementById("openComptaBtn").addEventListener("click", () => {
    document.getElementById("page-finances").classList.add("hidden");
    document.getElementById("page-compta").classList.remove("hidden");
    window.scrollTo(0, 0);
  });
  document.getElementById("backToFinancesBtn").addEventListener("click", () => {
    document.getElementById("page-compta").classList.add("hidden");
    document.getElementById("page-finances").classList.remove("hidden");
    window.scrollTo(0, 0);
  });

  document.querySelectorAll("#comptaView button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#comptaView button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentComptaView = btn.dataset.v;
      showComptaView();
    });
  });

  document.getElementById("fCompteSave").addEventListener("click", async () => {
    const numero = document.getElementById("fCompteNum").value.trim();
    const libelle = document.getElementById("fCompteLibelle").value.trim();
    if (!numero || !libelle) { toast("Numéro et libellé requis"); return; }
    try {
      await addDoc(accountsCol, {
        numero, libelle,
        classe: Number(document.getElementById("fCompteClasse").value),
        nature: document.getElementById("fCompteNature").value,
        actif: true, createdAt: serverTimestamp()
      });
      toast("Compte ajouté ✓");
      document.getElementById("fCompteNum").value = "";
      document.getElementById("fCompteLibelle").value = "";
    } catch (e) { toast("Erreur : " + e.message); }
  });

  document.getElementById("exportFecBtn")?.addEventListener("click", exporterFEC);
  document.getElementById("exportExcelBtn")?.addEventListener("click", exporterExcel);
  document.getElementById("shareEtatsBtn")?.addEventListener("click", partagerEtatsPDF);
  document.getElementById("exerciceSelector")?.addEventListener("change", (e) => selectExercice(e.target.value));
}

function showComptaView() {
  document.getElementById("comptaBrouillonsWrap").classList.toggle("hidden", currentComptaView !== "brouillons");
  document.getElementById("comptaComptesWrap").classList.toggle("hidden", currentComptaView !== "comptes");
  document.getElementById("comptaJournalWrap").classList.toggle("hidden", currentComptaView !== "journal");
  document.getElementById("comptaEtatsWrap").classList.toggle("hidden", currentComptaView !== "etats");
}

// ---------------------------------------------------------------------
// Initialisation idempotente : plan de comptes + un exercice par année
// où il existe déjà des transactions (pour ne perdre aucune donnée
// historique importée), plus l'année en cours.
// ---------------------------------------------------------------------
async function ensureDefaultAccounts() {
  const snap = await getDocs(query(accountsCol));
  if (!snap.empty) return;
  const batch = writeBatch(db);
  DEFAULT_ACCOUNTS.forEach(a => {
    batch.set(doc(collection(db, "accounts")), { ...a, actif: true, createdAt: new Date() });
  });
  await batch.commit();
}

let exercisesEnsured = new Set();
async function ensureExercisesExist(transactionDates) {
  const years = new Set([new Date().getFullYear()]);
  transactionDates.forEach(dt => {
    if (!dt) return;
    const d = dt.toDate ? dt.toDate() : new Date(dt);
    if (!isNaN(d.getTime())) years.add(d.getFullYear());
  });
  const missing = [...years].filter(y => !exercisesEnsured.has(y) && !allExercises.some(e => e.annee === y));
  if (!missing.length) return;
  const batch = writeBatch(db);
  missing.forEach(year => {
    batch.set(doc(db, "exercises", String(year)), {
      annee: year,
      date_debut: new Date(year, 0, 1),
      date_fin: new Date(year, 11, 31),
      statut: "ouvert",
      nb_ecritures: 0,
      createdAt: new Date()
    }, { merge: true });
    exercisesEnsured.add(year);
  });
  await batch.commit();
}

// ---------------------------------------------------------------------
// Rendu : liste des exercices comptables
// ---------------------------------------------------------------------
function renderExercicesCard() {
  const el = document.getElementById("exerciceCard");
  if (!el) return;
  if (!allExercises.length) {
    el.innerHTML = `<p class="subtle">Initialisation des exercices…</p>`;
    return;
  }
  el.innerHTML = allExercises.map(ex => `
    <div class="row">
      <div class="row-main"><span class="row-title">Exercice ${ex.annee}</span><span class="row-sub">${formatDate(ex.date_debut)} → ${formatDate(ex.date_fin)}</span></div>
      <span class="tag ${ex.statut === 'ouvert' ? 'ok' : 'danger'}">${ex.statut === 'ouvert' ? 'Ouvert' : 'Clôturé'}</span>
    </div>
    ${ex.statut === "ouvert" ? `<button class="btn danger small closeExerciceBtn" data-id="${ex.id}" style="margin:6px 0 10px;">Clôturer ${ex.annee}</button>` : ""}
  `).join("");
  el.querySelectorAll(".closeExerciceBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const ex = allExercises.find(e => e.id === btn.dataset.id);
      if (!ex) return;
      if (!confirm(`Clôturer l'exercice ${ex.annee} ? Plus aucune écriture ne pourra y être ajoutée. L'exercice ${ex.annee + 1} sera ouvert automatiquement s'il n'existe pas déjà.`)) return;
      try {
        await updateDoc(doc(db, "exercises", ex.id), {
          statut: "cloture", cloture_par: getUserName() || "Inconnu", cloture_le: serverTimestamp()
        });
        const nextYear = ex.annee + 1;
        if (!allExercises.some(e => e.annee === nextYear)) {
          await setDoc(doc(db, "exercises", String(nextYear)), {
            annee: nextYear,
            date_debut: new Date(nextYear, 0, 1),
            date_fin: new Date(nextYear, 11, 31),
            statut: "ouvert", nb_ecritures: 0, createdAt: new Date()
          });
        }
        toast(`Exercice ${ex.annee} clôturé ✓`);
      } catch (e) { toast("Erreur : " + e.message); }
    });
  });
}

// ---------------------------------------------------------------------
// Rendu : plan de comptes
// ---------------------------------------------------------------------
function renderComptesList() {
  const el = document.getElementById("comptesList");
  if (!el) return;
  if (!allAccounts.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">📒</div><p>Aucun compte pour le moment.</p></div>`;
    return;
  }
  el.innerHTML = allAccounts.map(a => `
    <div class="row">
      <div class="row-main"><span class="row-title mono">${a.numero} — ${escapeHtml(a.libelle)}</span><span class="row-sub">Classe ${a.classe} · ${a.nature}</span></div>
    </div>
  `).join("");
}

// ---------------------------------------------------------------------
// Rendu : transactions à valider (brouillons)
// ---------------------------------------------------------------------
function renderBrouillonsList() {
  const el = document.getElementById("brouillonsList");
  if (!el) return;
  if (!allBrouillons.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">✅</div><p>Tout est validé comptablement.</p></div>`;
    return;
  }
  el.innerHTML = allBrouillons.map(t => `
    <div class="row">
      <div class="row-main"><span class="row-title">${CATS_LABELS[t.categorie] || t.categorie}</span><span class="row-sub">${formatDate(t.date)}${t.description ? " · " + escapeHtml(t.description) : ""}</span></div>
      <span class="row-value ${t.type === 'recette' ? 'pos' : 'neg'}">${formatFCFA(t.montant)}</span>
    </div>
  `).join("");
  el.querySelectorAll(".row").forEach((rowEl, idx) => {
    rowEl.style.cursor = "pointer";
    rowEl.addEventListener("click", () => openValidationModal(allBrouillons[idx]));
  });
}

function openValidationModal(t) {
  const suggestion = MAPPING_COMPTABLE[t.categorie] || { debit: null, credit: null };
  const options = allAccounts.map(a => `<option value="${a.numero}">${a.numero} — ${a.libelle}</option>`).join("");
  const exercice = exerciceForDate(t.date);
  openModal("Valider l'écriture", `
    <div class="row"><div class="row-main"><span class="row-title">${CATS_LABELS[t.categorie] || t.categorie}</span><span class="row-sub">${formatDate(t.date)}${exercice ? " · Exercice " + exercice.annee : ""}</span></div><span class="row-value ${t.type === 'recette' ? 'pos' : 'neg'}">${formatFCFA(t.montant)}</span></div>
    ${!exercice ? `<p class="subtle" style="color:var(--clay-500)">Aucun exercice comptable ne couvre cette date. Rechargez la page.</p>` : ""}
    <div class="spacer-m"></div>
    <div class="field"><label>Compte à débiter</label><select id="fCompteDebit"><option value="">— Choisir —</option>${options}</select></div>
    <div class="field"><label>Compte à créditer</label><select id="fCompteCredit"><option value="">— Choisir —</option>${options}</select></div>
    <div class="field"><label>Libellé de l'écriture</label><input type="text" id="fEcritureLibelle" value="${escapeHtml((CATS_LABELS[t.categorie] || t.categorie) + (t.description ? " — " + t.description : ""))}"></div>
    <button class="btn yolk" id="fValiderBtn">Valider l'écriture</button>
    <p class="subtle" id="fValidErrors" style="color:var(--clay-500); margin-top:8px;"></p>
  `, {
    onMount: () => {
      if (suggestion.debit) document.getElementById("fCompteDebit").value = suggestion.debit;
      if (suggestion.credit) document.getElementById("fCompteCredit").value = suggestion.credit;

      document.getElementById("fValiderBtn").addEventListener("click", async () => {
        const ex = exerciceForDate(t.date);
        if (!ex) { toast("Aucun exercice comptable pour cette date"); return; }
        const compteDebit = document.getElementById("fCompteDebit").value;
        const compteCredit = document.getElementById("fCompteCredit").value;
        const libelle = document.getElementById("fEcritureLibelle").value.trim();
        const montant = Number(t.montant) || 0;
        const lines = [
          { compte: compteDebit, libelle, debit: montant, credit: 0 },
          { compte: compteCredit, libelle, debit: 0, credit: montant }
        ];
        const comptesExistants = new Set(allAccounts.map(a => a.numero));
        const erreurs = validerEcriture(lines, ex.statut, comptesExistants);
        if (erreurs.length) {
          document.getElementById("fValidErrors").textContent = erreurs.join(" ");
          return;
        }
        try {
          const numeroPiece = `EC-${ex.annee}-${String((ex.nb_ecritures || 0) + 1).padStart(4, "0")}`;
          const ecritureRef = await addDoc(journalCol, {
            numero_piece: numeroPiece,
            date: t.date,
            libelle,
            exercice_id: ex.id,
            lines,
            source_transaction_id: t.id,
            annulee: false,
            valide_par: getUserName() || "Inconnu",
            valide_le: serverTimestamp(),
            createdAt: serverTimestamp()
          });
          await updateDoc(doc(db, "exercises", ex.id), { nb_ecritures: increment(1) });
          await updateDoc(doc(db, "finance_transactions", t.id), {
            statut_comptable: "valide", ecriture_id: ecritureRef.id
          });
          toast(`Écriture ${numeroPiece} validée ✓`);
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

// ---------------------------------------------------------------------
// Correction d'une écriture par CONTRE-PASSATION (jamais d'édition
// directe d'une écriture postée — traçabilité intégrale conservée).
// ---------------------------------------------------------------------
export async function reverserEcriture(ecritureId) {
  const ecriture = allJournal.find(e => e.id === ecritureId);
  if (!ecriture) throw new Error("Écriture introuvable");
  if (ecriture.annulee) throw new Error("Cette écriture est déjà annulée");
  if (ecriture.contre_passation_de) throw new Error("Une écriture de contre-passation ne peut pas être annulée elle-même");

  const ex = allExercises.find(e => e.id === ecriture.exercice_id);
  if (!ex || ex.statut !== "ouvert") {
    throw new Error(`L'exercice ${ex ? ex.annee : ""} est clôturé — correction impossible.`);
  }

  const lignesInversees = (ecriture.lines || []).map(l => ({
    compte: l.compte, libelle: "ANNULATION — " + (l.libelle || ecriture.libelle),
    debit: Number(l.credit) || 0, credit: Number(l.debit) || 0
  }));
  const numeroPiece = `EC-${ex.annee}-${String((ex.nb_ecritures || 0) + 1).padStart(4, "0")}`;

  const reversalRef = await addDoc(journalCol, {
    numero_piece: numeroPiece,
    date: new Date(),
    libelle: "ANNULATION — " + ecriture.libelle,
    exercice_id: ecriture.exercice_id,
    lines: lignesInversees,
    source_transaction_id: ecriture.source_transaction_id,
    contre_passation_de: ecriture.id,
    annulee: false,
    valide_par: getUserName() || "Inconnu",
    valide_le: serverTimestamp(),
    createdAt: serverTimestamp()
  });
  await updateDoc(doc(db, "exercises", ex.id), { nb_ecritures: increment(1) });
  await updateDoc(doc(db, "journal_ecritures", ecriture.id), { annulee: true, annulee_par_ecriture_id: reversalRef.id });

  if (ecriture.source_transaction_id) {
    await updateDoc(doc(db, "finance_transactions", ecriture.source_transaction_id), {
      statut_comptable: "brouillon", ecriture_id: null
    });
  }
  return reversalRef.id;
}

// ---------------------------------------------------------------------
// Nettoyage des paires annulée/correction issues du bug historique de
// rattachement d'exercice (corrigé) — supprime uniquement les paires
// dont la transaction source a depuis été revalidée proprement ailleurs
// (donc ces paires ne servent plus à rien, juste du bruit visuel).
// ---------------------------------------------------------------------
function pairesNettoyables() {
  const paires = [];
  allJournal.forEach(e => {
    if (!e.contre_passation_de) return; // e = écriture de correction
    const original = allJournal.find(o => o.id === e.contre_passation_de);
    if (!original) return;
    let transactionRevalideeAilleurs = true;
    if (e.source_transaction_id) {
      const tx = allBrouillons.find(b => b.id === e.source_transaction_id);
      // Si la transaction est encore en brouillon (pas revalidée), on ne
      // touche pas à la paire : elle reste l'unique trace de l'historique.
      if (tx) transactionRevalideeAilleurs = false;
    }
    paires.push({ original, correction: e, transactionRevalideeAilleurs });
  });
  return paires;
}

function renderNettoyageCard() {
  const el = document.getElementById("nettoyageCard");
  if (!el) return;
  const paires = pairesNettoyables();
  const nettoyables = paires.filter(p => p.transactionRevalideeAilleurs);
  if (!paires.length) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <h3 style="font-size:14px; margin-bottom:6px;">🧹 Nettoyage</h3>
    <p class="subtle" style="margin:0 0 10px;">
      ${paires.length} paire(s) "annulée / correction" détectée(s), dont <strong>${nettoyables.length}</strong> déjà revalidée(s) proprement ailleurs — elles ne servent plus qu'à encombrer le journal.
    </p>
    ${nettoyables.length ? `<button class="btn danger small" id="nettoyerBtn">Supprimer définitivement ces ${nettoyables.length} paire(s)</button>` : `<p class="subtle">Aucune paire nettoyable pour l'instant (les autres sont encore la seule trace d'une transaction non revalidée).</p>`}
  `;
  const btn = document.getElementById("nettoyerBtn");
  if (btn) btn.addEventListener("click", async () => {
    if (!confirm(`Supprimer définitivement ${nettoyables.length} paire(s) d'écritures "annulée/correction" ? Cette action est irréversible. Les transactions elles-mêmes ne sont pas touchées — seules ces écritures devenues inutiles disparaissent du journal.`)) return;
    try {
      const batch = writeBatch(db);
      nettoyables.forEach(p => {
        batch.delete(doc(db, "journal_ecritures", p.original.id));
        batch.delete(doc(db, "journal_ecritures", p.correction.id));
      });
      await batch.commit();
      toast(`${nettoyables.length} paire(s) supprimée(s) ✓`);
    } catch (e) { toast("Erreur : " + e.message); }
  });
}

// ---------------------------------------------------------------------
// Rendu : journal des écritures
// ---------------------------------------------------------------------
function renderJournalList() {
  renderNettoyageCard();
  const el = document.getElementById("journalList");
  if (!el) return;
  if (!allJournal.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">📖</div><p>Aucune écriture validée pour le moment.</p></div>`;
    return;
  }
  el.innerHTML = allJournal.map(e => `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div class="row" style="border:none; padding-bottom:4px;">
        <div class="row-main"><span class="row-title mono">${e.numero_piece}${e.annulee ? ' <span class="tag danger">ANNULÉE</span>' : ""}${e.contre_passation_de ? ' <span class="tag warn">Correction</span>' : ""}</span><span class="row-sub">${escapeHtml(e.libelle)} · ${formatDate(e.date)}${e.valide_par ? " · par " + escapeHtml(e.valide_par) : ""}</span></div>
        ${(!e.annulee && !e.contre_passation_de) ? `<button class="btn secondary small correctBtn" data-id="${e.id}">↺ Corriger</button>` : ""}
      </div>
      ${(e.lines || []).map(l => `
        <div class="row" style="border:none; padding:2px 0 2px 14px;">
          <span class="row-sub mono">${l.compte}</span>
          <span class="row-value ${l.debit ? '' : 'pos'}">${l.debit ? "Débit " + formatFCFA(l.debit) : "Crédit " + formatFCFA(l.credit)}</span>
        </div>
      `).join("")}
    </div>
  `).join("");
  el.querySelectorAll(".correctBtn").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("Corriger cette écriture ? Une écriture d'annulation sera créée (rien n'est supprimé), et la transaction d'origine repassera en 'À valider' pour être ressaisie correctement.")) return;
      try {
        await reverserEcriture(btn.dataset.id);
        toast("Écriture annulée — transaction renvoyée dans 'À valider' ✓");
      } catch (e) { toast("Erreur : " + e.message); }
    });
  });
}

// ---------------------------------------------------------------------
// États financiers : Balance, Compte de Résultat, Bilan, Tableau de bord
// ---------------------------------------------------------------------
function currentSoldes() {
  const entriesExercice = allJournal.filter(e => e.exercice_id === selectedExerciceId);
  const soldes = {};
  entriesExercice.forEach(e => {
    (e.lines || []).forEach(l => {
      soldes[l.compte] = soldes[l.compte] || { debit: 0, credit: 0 };
      soldes[l.compte].debit += Number(l.debit) || 0;
      soldes[l.compte].credit += Number(l.credit) || 0;
    });
  });
  return soldes;
}

function renderEtatsFinanciers() {
  const balanceEl = document.getElementById("balanceList");
  const resultatEl = document.getElementById("resultatList");
  const bilanEl = document.getElementById("bilanList");
  const selectorEl = document.getElementById("exerciceSelector");
  const dashboardEl = document.getElementById("tableauBordCompta");
  if (!balanceEl) return;

  if (selectorEl) {
    selectorEl.innerHTML = allExercises.map(ex => `<option value="${ex.id}" ${ex.id === selectedExerciceId ? "selected" : ""}>Exercice ${ex.annee} (${ex.statut === "ouvert" ? "ouvert" : "clôturé"})</option>`).join("");
  }

  if (!selectedExerciceId) {
    balanceEl.innerHTML = `<p class="subtle">Aucun exercice disponible.</p>`;
    return;
  }
  const exercice = allExercises.find(e => e.id === selectedExerciceId);
  const soldes = currentSoldes();
  const comptesUtilises = Object.keys(soldes);

  if (!comptesUtilises.length) {
    balanceEl.innerHTML = `<p class="subtle">Aucune écriture validée sur cet exercice.</p>`;
  } else {
    balanceEl.innerHTML = comptesUtilises.sort().map(num => {
      const acc = allAccounts.find(a => a.numero === num);
      const s = soldes[num];
      const solde = s.debit - s.credit;
      return `
        <div class="row">
          <div class="row-main"><span class="row-title mono">${num} — ${acc ? escapeHtml(acc.libelle) : "?"}</span><span class="row-sub">Débit ${formatFCFA(s.debit)} · Crédit ${formatFCFA(s.credit)}</span></div>
          <span class="row-value ${solde >= 0 ? 'pos' : 'neg'}">${formatFCFA(Math.abs(solde))} ${solde >= 0 ? "Débiteur" : "Créditeur"}</span>
        </div>`;
    }).join("");
  }

  let totalProduits = 0, totalCharges = 0;
  const chargesParCompte = [];
  comptesUtilises.forEach(num => {
    const acc = allAccounts.find(a => a.numero === num);
    if (!acc) return;
    const s = soldes[num];
    if (acc.classe === 7) totalProduits += (s.credit - s.debit);
    if (acc.classe === 6) {
      const montant = s.debit - s.credit;
      totalCharges += montant;
      chargesParCompte.push({ libelle: acc.libelle, montant });
    }
  });
  const resultatNet = totalProduits - totalCharges;
  resultatEl.innerHTML = `
    <div class="row"><div class="row-main"><span class="row-title">Total produits (classe 7)</span></div><span class="row-value pos">${formatFCFA(totalProduits)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Total charges (classe 6)</span></div><span class="row-value neg">${formatFCFA(totalCharges)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Résultat net</span></div><span class="row-value ${resultatNet >= 0 ? 'pos' : 'neg'}">${formatFCFA(resultatNet)}</span></div>
  `;

  let totalActif = 0, totalPassif = 0;
  comptesUtilises.forEach(num => {
    const acc = allAccounts.find(a => a.numero === num);
    if (!acc) return;
    const s = soldes[num];
    if (acc.nature === "actif") totalActif += (s.debit - s.credit);
    if (acc.nature === "passif") totalPassif += (s.credit - s.debit);
  });
  totalPassif += resultatNet;
  const equilibre = Math.round(totalActif * 100) === Math.round(totalPassif * 100);
  bilanEl.innerHTML = `
    <div class="row"><div class="row-main"><span class="row-title">Total ACTIF</span></div><span class="row-value">${formatFCFA(totalActif)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Total PASSIF (dont résultat net)</span></div><span class="row-value">${formatFCFA(totalPassif)}</span></div>
    <div class="spacer-s"></div>
    <span class="tag ${equilibre ? 'ok' : 'danger'}">${equilibre ? "Bilan équilibré ✓" : "⚠️ Déséquilibre — vérifiez vos écritures"}</span>
  `;

  // --- Tableau de bord (ratios) ---
  if (dashboardEl) {
    const ratioCharges = totalProduits ? Math.round((totalCharges / totalProduits) * 100) : 0;
    const margeNette = totalProduits ? Math.round((resultatNet / totalProduits) * 100) : 0;
    const topCharges = chargesParCompte.sort((a, b) => b.montant - a.montant).slice(0, 3);
    dashboardEl.innerHTML = `
      <div class="row"><div class="row-main"><span class="row-title">Charges / Produits</span></div><span class="row-value">${ratioCharges}%</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Marge nette</span></div><span class="row-value ${margeNette >= 0 ? 'pos' : 'neg'}">${margeNette}%</span></div>
      ${topCharges.length ? `<div class="spacer-s"></div><p class="subtle" style="margin-bottom:6px;">Principaux postes de charges :</p>` + topCharges.map(c => `
        <div class="row"><div class="row-main"><span class="row-title">${escapeHtml(c.libelle)}</span></div><span class="row-value neg">${formatFCFA(c.montant)}</span></div>
      `).join("") : ""}
    `;
  }

  window.__oleeducksEtatsCache = { exercice, soldes, totalProduits, totalCharges, resultatNet, totalActif, totalPassif, comptesUtilises, allAccounts };
}

export function selectExercice(id) {
  selectedExerciceId = id;
  renderEtatsFinanciers();
}

// ---------------------------------------------------------------------
// Export FEC (Fichier des Écritures Comptables) — format standard
// pour audit / administration fiscale.
// ---------------------------------------------------------------------
function exporterFEC() {
  const entries = allJournal.filter(e => e.exercice_id === selectedExerciceId);
  if (!entries.length) { toast("Aucune écriture à exporter sur cet exercice"); return; }
  const header = ["JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib", "PieceRef", "PieceDate", "EcritureLib", "Debit", "Credit", "ValidDate"];
  const lines = [header.join("\t")];
  entries.forEach(e => {
    const dateStr = (e.date?.toDate ? e.date.toDate() : new Date(e.date)).toISOString().slice(0, 10).replace(/-/g, "");
    (e.lines || []).forEach(l => {
      const acc = allAccounts.find(a => a.numero === l.compte);
      lines.push([
        "OD", "Opérations diverses", e.numero_piece, dateStr, l.compte,
        acc ? acc.libelle.replace(/\t/g, " ") : "", e.numero_piece, dateStr,
        (e.libelle || "").replace(/\t/g, " "), (l.debit || 0).toFixed(2), (l.credit || 0).toFixed(2), dateStr
      ].join("\t"));
    });
  });
  downloadBlob(lines.join("\n"), `FEC_OleeDucks_${new Date().getFullYear()}.txt`, "text/plain;charset=utf-8");
  toast("Export FEC généré ✓");
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------
// Export Excel (Balance + Grand Livre) via SheetJS (chargé en CDN)
// ---------------------------------------------------------------------
function exporterExcel() {
  if (typeof XLSX === "undefined") { toast("Bibliothèque Excel non chargée — vérifiez votre connexion"); return; }
  const cache = window.__oleeducksEtatsCache;
  if (!cache) { toast("Aucune donnée à exporter"); return; }

  const balanceRows = [["Compte", "Libellé", "Débit", "Crédit", "Solde", "Sens"]];
  cache.comptesUtilises.sort().forEach(num => {
    const acc = cache.allAccounts.find(a => a.numero === num);
    const s = cache.soldes[num];
    const solde = s.debit - s.credit;
    balanceRows.push([num, acc ? acc.libelle : "?", s.debit, s.credit, Math.abs(solde), solde >= 0 ? "Débiteur" : "Créditeur"]);
  });

  const grandLivreRows = [["Pièce", "Date", "Compte", "Libellé", "Débit", "Crédit"]];
  allJournal.filter(e => e.exercice_id === selectedExerciceId).forEach(e => {
    const dateStr = formatDate(e.date);
    (e.lines || []).forEach(l => {
      grandLivreRows.push([e.numero_piece, dateStr, l.compte, e.libelle, l.debit || 0, l.credit || 0]);
    });
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(balanceRows), "Balance");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grandLivreRows), "Grand Livre");
  XLSX.writeFile(wb, `Comptabilite_OleeDucks_${cache.exercice ? cache.exercice.annee : ""}.xlsx`);
  toast("Export Excel généré ✓");
}

// ---------------------------------------------------------------------
// Partage / impression des états financiers en PDF (jsPDF, via CDN)
// ---------------------------------------------------------------------
async function partagerEtatsPDF() {
  if (typeof window.jspdf === "undefined") { toast("Bibliothèque PDF non chargée — vérifiez votre connexion"); return; }
  const cache = window.__oleeducksEtatsCache;
  if (!cache) { toast("Aucune donnée à partager"); return; }

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF();
  let y = 18;
  pdf.setFontSize(16); pdf.text("Olee Ducks — États financiers", 14, y); y += 8;
  pdf.setFontSize(10); pdf.text(`Exercice ${cache.exercice ? cache.exercice.annee : ""} — généré le ${new Date().toLocaleDateString("fr-FR")}`, 14, y); y += 10;

  pdf.setFontSize(13); pdf.text("Compte de résultat", 14, y); y += 7;
  pdf.setFontSize(10);
  pdf.text(`Total produits : ${formatFCFA(cache.totalProduits)}`, 14, y); y += 6;
  pdf.text(`Total charges : ${formatFCFA(cache.totalCharges)}`, 14, y); y += 6;
  pdf.text(`Résultat net : ${formatFCFA(cache.resultatNet)}`, 14, y); y += 10;

  pdf.setFontSize(13); pdf.text("Bilan", 14, y); y += 7;
  pdf.setFontSize(10);
  pdf.text(`Total Actif : ${formatFCFA(cache.totalActif)}`, 14, y); y += 6;
  pdf.text(`Total Passif (dont résultat) : ${formatFCFA(cache.totalPassif)}`, 14, y); y += 10;

  pdf.setFontSize(13); pdf.text("Balance des comptes", 14, y); y += 7;
  pdf.setFontSize(9);
  cache.comptesUtilises.sort().forEach(num => {
    if (y > 280) { pdf.addPage(); y = 18; }
    const acc = cache.allAccounts.find(a => a.numero === num);
    const s = cache.soldes[num];
    const solde = s.debit - s.credit;
    pdf.text(`${num} — ${acc ? acc.libelle : "?"} : ${formatFCFA(Math.abs(solde))} (${solde >= 0 ? "Débiteur" : "Créditeur"})`, 14, y);
    y += 5.5;
  });

  const fileName = `Etats_financiers_OleeDucks_${cache.exercice ? cache.exercice.annee : ""}.pdf`;
  const blob = pdf.output("blob");

  if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([blob], fileName, { type: "application/pdf" })] })) {
    try {
      await navigator.share({ files: [new File([blob], fileName, { type: "application/pdf" })], title: "États financiers Olee Ducks" });
      return;
    } catch (e) { /* l'utilisateur a peut-être annulé, on retombe sur le téléchargement */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("PDF téléchargé ✓");
}
