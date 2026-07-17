// =====================================================================
// MODULE : COMPTABILITÉ OHADA (SYSCOHADA révisé)
// - "accounts" : plan de comptes (numéro, libellé, classe 1-7, nature)
// - "exercises" : exercices comptables (statut ouvert/clôturé)
// - "journal_ecritures" : écritures validées, en partie double, chacune
//   avec un tableau "lines" (compte, débit, crédit). Seule cette
//   collection sert de base aux états financiers — jamais les brouillons.
// - "finance_transactions" (existante) : chaque saisie y reste un
//   "brouillon" tant qu'elle n'a pas été transformée en écriture ici.
//   Rien de ce module ne modifie la façon dont l'équipe saisit une
//   recette ou une dépense au quotidien.
//
// Validation 100% côté application (pas de Cloud Functions, reste
// gratuit) : équilibre Débit=Crédit, comptes existants, exercice ouvert.
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
let currentExercise = null;
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

export function initComptabilite() {
  ensureDefaultAccounts().catch(e => console.error("Erreur init plan de comptes :", e));
  ensureCurrentExercise().catch(e => console.error("Erreur init exercice :", e));

  onSnapshot(query(accountsCol, orderBy("numero")), snap => {
    allAccounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderComptesList();
    renderBrouillonsList();
  }, err => console.error("Erreur lecture plan de comptes :", err));

  onSnapshot(query(exercisesCol, orderBy("annee", "desc")), snap => {
    allExercises = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    currentExercise = allExercises.find(e => e.statut === "ouvert") || allExercises[0] || null;
    renderExerciceCard();
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
    renderBrouillonsList();
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
}

function showComptaView() {
  document.getElementById("comptaBrouillonsWrap").classList.toggle("hidden", currentComptaView !== "brouillons");
  document.getElementById("comptaComptesWrap").classList.toggle("hidden", currentComptaView !== "comptes");
  document.getElementById("comptaJournalWrap").classList.toggle("hidden", currentComptaView !== "journal");
  document.getElementById("comptaEtatsWrap").classList.toggle("hidden", currentComptaView !== "etats");
}

// ---------------------------------------------------------------------
// Initialisation idempotente (plan de comptes par défaut + exercice)
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

async function ensureCurrentExercise() {
  const snap = await getDocs(query(exercisesCol));
  if (!snap.empty) return;
  const year = new Date().getFullYear();
  await setDoc(doc(db, "exercises", String(year)), {
    annee: year,
    date_debut: new Date(year, 0, 1),
    date_fin: new Date(year, 11, 31),
    statut: "ouvert",
    nb_ecritures: 0,
    createdAt: new Date()
  });
}

// ---------------------------------------------------------------------
// Rendu : carte exercice en cours
// ---------------------------------------------------------------------
function renderExerciceCard() {
  const el = document.getElementById("exerciceCard");
  if (!el || !currentExercise) return;
  el.innerHTML = `
    <div class="row">
      <div class="row-main"><span class="row-title">Exercice ${currentExercise.annee}</span><span class="row-sub">${formatDate(currentExercise.date_debut)} → ${formatDate(currentExercise.date_fin)}</span></div>
      <span class="tag ${currentExercise.statut === 'ouvert' ? 'ok' : 'danger'}">${currentExercise.statut === 'ouvert' ? 'Ouvert' : 'Clôturé'}</span>
    </div>
    ${currentExercise.statut === "ouvert" ? `<button class="btn danger small" id="closeExerciceBtn" style="margin-top:8px;">Clôturer cet exercice</button>` : ""}
  `;
  const closeBtn = document.getElementById("closeExerciceBtn");
  if (closeBtn) closeBtn.addEventListener("click", async () => {
    if (!confirm(`Clôturer l'exercice ${currentExercise.annee} ? Plus aucune écriture ne pourra y être ajoutée. Un nouvel exercice ${currentExercise.annee + 1} sera créé automatiquement.`)) return;
    try {
      await updateDoc(doc(db, "exercises", currentExercise.id), {
        statut: "cloture", cloture_par: getUserName() || "Inconnu", cloture_le: serverTimestamp()
      });
      const nextYear = currentExercise.annee + 1;
      await setDoc(doc(db, "exercises", String(nextYear)), {
        annee: nextYear,
        date_debut: new Date(nextYear, 0, 1),
        date_fin: new Date(nextYear, 11, 31),
        statut: "ouvert", nb_ecritures: 0, createdAt: new Date()
      });
      toast(`Exercice ${currentExercise.annee} clôturé, ${nextYear} ouvert ✓`);
    } catch (e) { toast("Erreur : " + e.message); }
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
  openModal("Valider l'écriture", `
    <div class="row"><div class="row-main"><span class="row-title">${CATS_LABELS[t.categorie] || t.categorie}</span><span class="row-sub">${formatDate(t.date)}</span></div><span class="row-value ${t.type === 'recette' ? 'pos' : 'neg'}">${formatFCFA(t.montant)}</span></div>
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
        if (!currentExercise) { toast("Aucun exercice comptable disponible"); return; }
        const compteDebit = document.getElementById("fCompteDebit").value;
        const compteCredit = document.getElementById("fCompteCredit").value;
        const libelle = document.getElementById("fEcritureLibelle").value.trim();
        const montant = Number(t.montant) || 0;
        const lines = [
          { compte: compteDebit, libelle, debit: montant, credit: 0 },
          { compte: compteCredit, libelle, debit: 0, credit: montant }
        ];
        const comptesExistants = new Set(allAccounts.map(a => a.numero));
        const erreurs = validerEcriture(lines, currentExercise.statut, comptesExistants);
        if (erreurs.length) {
          document.getElementById("fValidErrors").textContent = erreurs.join(" ");
          return;
        }
        try {
          const numeroPiece = `EC-${currentExercise.annee}-${String((currentExercise.nb_ecritures || 0) + 1).padStart(4, "0")}`;
          const ecritureRef = await addDoc(journalCol, {
            numero_piece: numeroPiece,
            date: t.date,
            libelle,
            exercice_id: currentExercise.id,
            lines,
            source_transaction_id: t.id,
            valide_par: getUserName() || "Inconnu",
            valide_le: serverTimestamp(),
            createdAt: serverTimestamp()
          });
          await updateDoc(doc(db, "exercises", currentExercise.id), { nb_ecritures: increment(1) });
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
// Rendu : journal des écritures validées
// ---------------------------------------------------------------------
function renderJournalList() {
  const el = document.getElementById("journalList");
  if (!el) return;
  if (!allJournal.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">📖</div><p>Aucune écriture validée pour le moment.</p></div>`;
    return;
  }
  el.innerHTML = allJournal.map(e => `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div class="row" style="border:none; padding-bottom:4px;">
        <div class="row-main"><span class="row-title mono">${e.numero_piece}</span><span class="row-sub">${escapeHtml(e.libelle)} · ${formatDate(e.date)}${e.valide_par ? " · par " + escapeHtml(e.valide_par) : ""}</span></div>
      </div>
      ${(e.lines || []).map(l => `
        <div class="row" style="border:none; padding:2px 0 2px 14px;">
          <span class="row-sub mono">${l.compte}</span>
          <span class="row-value ${l.debit ? '' : 'pos'}">${l.debit ? "Débit " + formatFCFA(l.debit) : "Crédit " + formatFCFA(l.credit)}</span>
        </div>
      `).join("")}
    </div>
  `).join("");
}

// ---------------------------------------------------------------------
// États financiers : Balance, Compte de Résultat, Bilan
// ---------------------------------------------------------------------
function renderEtatsFinanciers() {
  const balanceEl = document.getElementById("balanceList");
  const resultatEl = document.getElementById("resultatList");
  const bilanEl = document.getElementById("bilanList");
  if (!balanceEl || !currentExercise) return;

  const entriesExercice = allJournal.filter(e => e.exercice_id === currentExercise.id);
  const soldes = {}; // numero -> { debit, credit }
  entriesExercice.forEach(e => {
    (e.lines || []).forEach(l => {
      soldes[l.compte] = soldes[l.compte] || { debit: 0, credit: 0 };
      soldes[l.compte].debit += Number(l.debit) || 0;
      soldes[l.compte].credit += Number(l.credit) || 0;
    });
  });

  // --- Balance ---
  const comptesUtilises = Object.keys(soldes);
  if (!comptesUtilises.length) {
    balanceEl.innerHTML = `<p class="subtle">Aucune écriture validée sur l'exercice ${currentExercise.annee}.</p>`;
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

  // --- Compte de résultat (classe 7 - classe 6) ---
  let totalProduits = 0, totalCharges = 0;
  comptesUtilises.forEach(num => {
    const acc = allAccounts.find(a => a.numero === num);
    if (!acc) return;
    const s = soldes[num];
    if (acc.classe === 7) totalProduits += (s.credit - s.debit);
    if (acc.classe === 6) totalCharges += (s.debit - s.credit);
  });
  const resultatNet = totalProduits - totalCharges;
  resultatEl.innerHTML = `
    <div class="row"><div class="row-main"><span class="row-title">Total produits (classe 7)</span></div><span class="row-value pos">${formatFCFA(totalProduits)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Total charges (classe 6)</span></div><span class="row-value neg">${formatFCFA(totalCharges)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Résultat net</span></div><span class="row-value ${resultatNet >= 0 ? 'pos' : 'neg'}">${formatFCFA(resultatNet)}</span></div>
  `;

  // --- Bilan (Actif / Passif) ---
  let totalActif = 0, totalPassif = 0;
  comptesUtilises.forEach(num => {
    const acc = allAccounts.find(a => a.numero === num);
    if (!acc) return;
    const s = soldes[num];
    if (acc.nature === "actif") totalActif += (s.debit - s.credit);
    if (acc.nature === "passif") totalPassif += (s.credit - s.debit);
  });
  totalPassif += resultatNet; // le résultat net vient augmenter/diminuer les capitaux propres
  const equilibre = Math.round(totalActif * 100) === Math.round(totalPassif * 100);
  bilanEl.innerHTML = `
    <div class="row"><div class="row-main"><span class="row-title">Total ACTIF</span></div><span class="row-value">${formatFCFA(totalActif)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Total PASSIF (dont résultat net)</span></div><span class="row-value">${formatFCFA(totalPassif)}</span></div>
    <div class="spacer-s"></div>
    <span class="tag ${equilibre ? 'ok' : 'danger'}">${equilibre ? "Bilan équilibré ✓" : "⚠️ Déséquilibre — vérifiez vos écritures"}</span>
  `;
}
