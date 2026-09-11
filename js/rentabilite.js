// =======================================================================
// MOTEUR DE RENTABILITÉ — coût de revient réel et prix de vente conseillé
// =======================================================================
//
// Principe général (voir le détail dans chaque fonction) :
//   1. On ne suppose JAMAIS que tout le cheptel est vendable : les
//      reproducteurs sont traités comme des "outils de production" dont
//      le coût est imputé à ce qu'ils produisent (œufs → canetons).
//   2. Chaque montant calculé est étiqueté "reel" (donnée directement
//      enregistrée), "estime" (calculée à partir de paramètres faute de
//      donnée directe) ou "projete" (extrapolation, ex. courbe d'âge).
//      Rien n'est jamais présenté comme réel si ça ne l'est pas.
//   3. La mortalité est absorbée par les survivants vendables : un coût
//      engagé pour un animal mort n'est jamais retiré du calcul, il est
//      réparti sur les animaux restants de la même catégorie.
//   4. Ce module est 100% additif : nouvelle collection "config" (un
//      seul document "rentabilite"), aucune collection ni champ existant
//      n'est modifié ou supprimé. Les sorties de stock reçoivent en plus
//      un champ optionnel "cout_unitaire_estime" (voir stocks.js) pour
//      une historisation plus précise du prix au moment de la sortie —
//      les mouvements déjà enregistrés sans ce champ retombent sur le
//      coût unitaire moyen ACTUEL de l'article, étiqueté "estimé".
// =======================================================================

import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, onSnapshot, query, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatFCFA, formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName } from "./utils.js";

const ducksCol = collection(db, "ducks");
const finCol = collection(db, "finance_transactions");
const movCol = collection(db, "stock_mouvements");
const itemsCol = collection(db, "stock_items");
const pontesCol = collection(db, "pontes_journalieres");
const cyclesCol = collection(db, "nest_cycles");
const configRef = doc(db, "config", "rentabilite");

// ---------------------------------------------------------------------
// Seuils d'âge — IDENTIQUES à ceux utilisés par inventaire.js pour la
// requalification automatique, afin que la courbe de coût par âge et
// les catégories du moteur restent cohérentes avec le reste de l'app.
// ---------------------------------------------------------------------
const SEUIL_CANARDEAU_J = 28; // 4 semaines révolues
const SEUIL_CANARD_J = 56;    // 8 semaines révolues

const CATEGORIES_ANIMALES = ["caneton", "canardeau", "canard", "reproducteur_male", "reproducteur_femelle"];
const CAT_LABELS = {
  caneton: "Caneton", canardeau: "Canardeau", canard: "Canard / Canne",
  reproducteur_male: "Reproducteur mâle", reproducteur_femelle: "Reproductrice femelle"
};
const CAT_ICONS = {
  caneton: "ic-duck-caneton", canardeau: "ic-duck-canardeau", canard: "ic-duck-canard",
  reproducteur_male: "ic-duck-repro-m", reproducteur_femelle: "ic-duck-repro-f"
};
const CATS_INDIRECTES = ["eau", "electricite", "materiel", "transport", "salaire", "autre"];

const DEFAULT_CONFIG = {
  coefficient_male_adulte: 2,
  taux_marge_cible: 0.30,
  ration_g_jour: { caneton: 60, canardeau: 140, canard: 220, reproducteur_male: 400, reproducteur_femelle: 200 }
};

let config = { ...DEFAULT_CONFIG, ration_g_jour: { ...DEFAULT_CONFIG.ration_g_jour } };
let allDucksR = [];
let allFinanceR = [];
let allMovR = [];
let allItemsR = [];
let allPontesR = [];
let allCyclesR = [];
let periodeJours = 90; // 30 | 90 | 365 | "all"
let pretsChargees = { ducks: false, finance: false, mov: false, items: false, pontes: false, cycles: false };

function toDateObj(x) {
  if (!x) return null;
  const d = x?.toDate ? x.toDate() : new Date(x);
  return isNaN(d.getTime()) ? null : d;
}
function dansPeriode(x, start, end) {
  const d = toDateObj(x);
  return d && d >= start && d <= end;
}
function periodRange() {
  const end = new Date();
  if (periodeJours === "all") return { start: new Date(2015, 0, 1), end };
  return { start: new Date(end.getTime() - periodeJours * 86400000), end };
}

// ---------------------------------------------------------------------
// Chargement des données (lecture seule, écouteurs indépendants des
// autres modules pour ne rien risquer de casser ailleurs).
// ---------------------------------------------------------------------
export function initRentabilite() {
  getDoc(configRef).then(snap => {
    if (snap.exists()) config = { ...DEFAULT_CONFIG, ...snap.data(), ration_g_jour: { ...DEFAULT_CONFIG.ration_g_jour, ...(snap.data().ration_g_jour || {}) } };
    renderAll();
  }).catch(e => console.error("Erreur lecture config rentabilité :", e));

  onSnapshot(query(ducksCol), snap => { allDucksR = snap.docs.map(d => ({ id: d.id, ...d.data() })); pretsChargees.ducks = true; renderAll(); });
  onSnapshot(query(finCol), snap => { allFinanceR = snap.docs.map(d => ({ id: d.id, ...d.data() })); pretsChargees.finance = true; renderAll(); });
  onSnapshot(query(movCol), snap => { allMovR = snap.docs.map(d => ({ id: d.id, ...d.data() })); pretsChargees.mov = true; renderAll(); });
  onSnapshot(query(itemsCol), snap => { allItemsR = snap.docs.map(d => ({ id: d.id, ...d.data() })); pretsChargees.items = true; renderAll(); });
  onSnapshot(query(pontesCol), snap => { allPontesR = snap.docs.map(d => ({ id: d.id, ...d.data() })); pretsChargees.pontes = true; renderAll(); });
  onSnapshot(query(cyclesCol), snap => { allCyclesR = snap.docs.map(d => ({ id: d.id, ...d.data() })); pretsChargees.cycles = true; renderAll(); });

  document.getElementById("openRentabiliteBtn")?.addEventListener("click", () => {
    document.getElementById("page-finances").classList.add("hidden");
    document.getElementById("page-rentabilite").classList.remove("hidden");
    window.scrollTo(0, 0);
    renderAll();
  });
  document.getElementById("backFromRentabiliteBtn")?.addEventListener("click", () => {
    document.getElementById("page-rentabilite").classList.add("hidden");
    document.getElementById("page-finances").classList.remove("hidden");
    window.scrollTo(0, 0);
  });
  document.querySelectorAll("#rentaPeriode button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#rentaPeriode button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      periodeJours = btn.dataset.v === "all" ? "all" : Number(btn.dataset.v);
      renderAll();
    });
  });
  document.getElementById("rentaConfigBtn")?.addEventListener("click", openConfigModal);
  document.getElementById("rentaSimulateurBtn")?.addEventListener("click", openSimulateurModal);
}

// =======================================================================
// MOTEUR DE CALCUL — fonctions pures, chaque résultat expose ses
// composants pour permettre le détail "pourquoi ce chiffre ?".
// =======================================================================

// Prix moyen actuel des aliments en stock (seule donnée de prix
// disponible côté aliment — voir note sur cout_unitaire_estime plus haut).
function prixAlimentMoyenKg() {
  const aliments = allItemsR.filter(i => i.type === "aliment" && Number(i.cout_unitaire_moyen) > 0);
  if (!aliments.length) return { valeur: 0, type: "estime", note: "Aucun article aliment avec coût renseigné dans Stocks — coût aliment non calculable tant qu'un prix n'est pas saisi." };
  const moy = aliments.reduce((a, i) => a + Number(i.cout_unitaire_moyen), 0) / aliments.length;
  return { valeur: Math.round(moy), type: "reel", note: `Moyenne du coût unitaire actuel de ${aliments.length} article(s) aliment dans Stocks.` };
}

// Coût aliment réellement sorti du stock (motif "alimentation") sur la
// période — la donnée la plus fiable quand elle existe.
function coutAlimentReelPeriode(start, end) {
  const sorties = allMovR.filter(m => m.type_mouvement === "sortie" && m.motif === "alimentation" && dansPeriode(m.date, start, end));
  if (!sorties.length) return null;
  let total = 0;
  let precis = 0;
  sorties.forEach(m => {
    const item = allItemsR.find(i => i.id === m.item_id);
    const puEstime = Number(m.cout_unitaire_estime) || 0;
    const pu = puEstime || Number(item?.cout_unitaire_moyen) || 0;
    if (puEstime) precis++;
    total += (Number(m.quantite) || 0) * pu;
  });
  return {
    valeur: Math.round(total), type: precis === sorties.length ? "reel" : "estime",
    note: `${sorties.length} sortie(s) de stock "alimentation" sur la période${precis < sorties.length ? `, dont ${sorties.length - precis} valorisée(s) au coût moyen actuel faute de prix historisé` : ", valorisées au prix réel au moment de la sortie"}.`
  };
}

// Animaux-jours par catégorie sur la période — clé de répartition des
// charges indirectes ET base du calcul des rations théoriques.
function animalJoursParCategorie(start, end) {
  const res = {}; CATEGORIES_ANIMALES.forEach(c => res[c] = 0);
  allDucksR.forEach(d => {
    if (!CATEGORIES_ANIMALES.includes(d.type)) return;
    const entree = toDateObj(d.date_entree) || toDateObj(d.date_naissance);
    if (!entree) return;
    const sortie = d.statut !== "actif" && d.date_sortie ? toDateObj(d.date_sortie) : end;
    const debut = new Date(Math.max(entree.getTime(), start.getTime()));
    const fin = new Date(Math.min((sortie || end).getTime(), end.getTime()));
    const jours = Math.max(0, (fin - debut) / 86400000);
    res[d.type] += jours * (Number(d.quantite) || 1);
  });
  return res;
}

// Coût santé (vétérinaire) + charges indirectes réellement engagées sur
// la période, directement depuis Finances + sorties de stock "traitement".
function chargesPeriode(start, end) {
  const depensesVet = allFinanceR.filter(t => t.type === "depense" && t.categorie === "veterinaire" && dansPeriode(t.date, start, end)).reduce((a, t) => a + (Number(t.montant) || 0), 0);
  const sortiesTraitement = allMovR.filter(m => m.type_mouvement === "sortie" && m.motif === "traitement" && dansPeriode(m.date, start, end));
  const coutTraitement = sortiesTraitement.reduce((a, m) => {
    const item = allItemsR.find(i => i.id === m.item_id);
    const pu = Number(m.cout_unitaire_estime) || Number(item?.cout_unitaire_moyen) || 0;
    return a + (Number(m.quantite) || 0) * pu;
  }, 0);
  const sante = depensesVet + coutTraitement;
  const indirect = allFinanceR.filter(t => t.type === "depense" && CATS_INDIRECTES.includes(t.categorie) && dansPeriode(t.date, start, end)).reduce((a, t) => a + (Number(t.montant) || 0), 0);
  return { sante, indirect };
}

// Taux de mortalité observé (toutes périodes confondues, pour une
// meilleure stabilité statistique) : morts / (morts + actifs + vendus).
function tauxMortalite(typeKey) {
  const lots = allDucksR.filter(d => d.type === typeKey);
  const q = (arr) => arr.reduce((a, d) => a + (Number(d.quantite) || 1), 0);
  const morts = q(lots.filter(d => d.statut === "mort"));
  const total = q(lots);
  return total > 0 ? morts / total : 0;
}

// Âge moyen (en jours) des lots actifs d'une catégorie — sert de point
// de référence pour "quel est le coût AUJOURD'HUI d'un animal de cette
// catégorie". À défaut de lot actif, on retombe sur un âge représentatif
// du milieu de la tranche (indiqué comme "projeté").
function ageMoyenJours(typeKey, fallbackJours) {
  const lots = allDucksR.filter(d => d.type === typeKey && d.statut === "actif");
  const ref = (d) => toDateObj(d.date_naissance) || toDateObj(d.date_entree);
  const valides = lots.filter(d => ref(d));
  if (!valides.length) return { valeur: fallbackJours, type: "projete" };
  let sommeJours = 0, sommeQte = 0;
  valides.forEach(d => {
    const j = (Date.now() - ref(d).getTime()) / 86400000;
    const q = Number(d.quantite) || 1;
    sommeJours += j * q; sommeQte += q;
  });
  return { valeur: Math.round(sommeJours / sommeQte), type: "reel" };
}

// Coût alimentaire cumulé depuis la naissance jusqu'à ageJours, en
// tenant compte du changement de ration à chaque stade (caneton →
// canardeau → canard), au prix aliment moyen actuel.
function coutAlimentaireCumule(ageJours, prixKg) {
  const r = config.ration_g_jour;
  let total = 0;
  const jCaneton = Math.min(ageJours, SEUIL_CANARDEAU_J);
  total += jCaneton * (r.caneton / 1000) * prixKg;
  if (ageJours > SEUIL_CANARDEAU_J) {
    const jCanardeau = Math.min(ageJours, SEUIL_CANARD_J) - SEUIL_CANARDEAU_J;
    total += jCanardeau * (r.canardeau / 1000) * prixKg;
  }
  if (ageJours > SEUIL_CANARD_J) {
    const jCanard = ageJours - SEUIL_CANARD_J;
    total += jCanard * (r.canard / 1000) * prixKg;
  }
  return total;
}

// Taux d'éclosion moyen observé sur les cycles de nids archivés — sert à
// imputer le coût de l'œuf au coût du caneton (tous les œufs ne donnent
// pas un caneton commercialisable).
function tauxEclosionMoyen() {
  const archives = allCyclesR.filter(c => c.statut === "eclos" || c.statut === "echec");
  const totalOeufs = archives.reduce((a, c) => a + (Number(c.nombre_oeufs) || 0), 0);
  const totalEclos = archives.reduce((a, c) => a + (Number(c.nombre_eclos) || 0), 0);
  return totalOeufs > 0 ? { valeur: totalEclos / totalOeufs, type: "reel", n: archives.length } : { valeur: 0.75, type: "estime", n: 0 };
}

// Coût de l'œuf : coût de maintien des reproducteurs (aliment + santé +
// charges indirectes, au prorata de leurs animaux-jours) ÷ nombre
// d'œufs réellement pondus sur la période.
function calculerCoutOeuf(start, end) {
  const aj = animalJoursParCategorie(start, end);
  const totalAj = Object.values(aj).reduce((a, b) => a + b, 0) || 1;
  const prix = prixAlimentMoyenKg();
  const { sante, indirect } = chargesPeriode(start, end);
  const ajRepro = aj.reproducteur_male + aj.reproducteur_femelle;

  const alimentMale = aj.reproducteur_male * (config.ration_g_jour.reproducteur_male / 1000) * prix.valeur;
  const alimentFemelle = aj.reproducteur_femelle * (config.ration_g_jour.reproducteur_femelle / 1000) * prix.valeur;
  const santeRepro = sante * (ajRepro / totalAj);
  const indirectRepro = indirect * (ajRepro / totalAj);
  const totalRepro = alimentMale + alimentFemelle + santeRepro + indirectRepro;

  const oeufsPeriode = allPontesR.filter(p => dansPeriode(p.date, start, end) && Number(p.quantite) > 0).reduce((a, p) => a + Number(p.quantite), 0);
  const coutUnitaire = oeufsPeriode > 0 ? totalRepro / oeufsPeriode : null;

  return {
    coutUnitaire, oeufsPeriode, totalRepro,
    composants: [
      { label: "Aliment reproducteurs mâles", valeur: Math.round(alimentMale), type: prix.type },
      { label: "Aliment reproductrices femelles", valeur: Math.round(alimentFemelle), type: prix.type },
      { label: "Santé (part reproducteurs)", valeur: Math.round(santeRepro), type: "reel" },
      { label: "Charges indirectes (part reproducteurs)", valeur: Math.round(indirectRepro), type: "reel" },
      { label: "Œufs pondus sur la période", valeur: oeufsPeriode, type: "reel", unite: "" }
    ]
  };
}

// Coût unitaire d'une catégorie animale (caneton/canardeau/canard/
// reproducteurs), corrigé de la mortalité observée, avec le détail des
// composants pour la transparence exigée.
function calculerCoutCategorie(typeKey, start, end) {
  const prix = prixAlimentMoyenKg();
  const { sante, indirect } = chargesPeriode(start, end);
  const aj = animalJoursParCategorie(start, end);
  const totalAj = Object.values(aj).reduce((a, b) => a + b, 0) || 1;
  const santeParTeteJour = sante / totalAj;
  const indirectParTeteJour = indirect / totalAj;

  const isRepro = typeKey === "reproducteur_male" || typeKey === "reproducteur_femelle";
  const mortalite = tauxMortalite(typeKey);
  const ratioMortalite = 1 / Math.max(0.05, 1 - mortalite); // plancher pour éviter une division explosive si mortalité ≈ 100%

  if (isRepro) {
    // Pour un reproducteur, la question n'est pas "combien depuis sa
    // naissance" mais "combien coûte son maintien" (section 8).
    const rationKgJour = config.ration_g_jour[typeKey] / 1000;
    const coutJour = rationKgJour * prix.valeur + santeParTeteJour + indirectParTeteJour;
    return {
      coutJournalier: Math.round(coutJour), coutMensuel: Math.round(coutJour * 30),
      composants: [
        { label: "Aliment / jour", valeur: Math.round(rationKgJour * prix.valeur), type: prix.type },
        { label: "Santé / jour (réparti)", valeur: Math.round(santeParTeteJour), type: "reel" },
        { label: "Charges indirectes / jour (réparti)", valeur: Math.round(indirectParTeteJour), type: "reel" }
      ]
    };
  }

  const fallbackAge = typeKey === "caneton" ? 14 : typeKey === "canardeau" ? 42 : 75;
  const age = ageMoyenJours(typeKey, fallbackAge);
  const coutAlimentaire = coutAlimentaireCumule(age.valeur, prix.valeur);
  const coutSanteIndirectCumule = (santeParTeteJour + indirectParTeteJour) * age.valeur;

  let coutOeufImpute = 0;
  let composantOeuf = null;
  if (typeKey === "caneton") {
    const oeuf = calculerCoutOeuf(start, end);
    const eclosion = tauxEclosionMoyen();
    if (oeuf.coutUnitaire !== null) {
      coutOeufImpute = oeuf.coutUnitaire / Math.max(0.05, eclosion.valeur);
      composantOeuf = { label: `Œuf imputé (÷ taux d'éclosion ${(eclosion.valeur * 100).toFixed(0)}%)`, valeur: Math.round(coutOeufImpute), type: eclosion.type };
    }
  }

  const sousTotal = coutAlimentaire + coutSanteIndirectCumule + coutOeufImpute;
  const coutFinal = sousTotal * ratioMortalite;

  const composants = [
    { label: `Aliment cumulé (${age.valeur} j, ${age.type === "reel" ? "âge moyen actuel" : "âge de référence"})`, valeur: Math.round(coutAlimentaire), type: prix.type === "reel" && age.type === "reel" ? "reel" : "estime" },
    { label: "Santé + charges indirectes cumulées", valeur: Math.round(coutSanteIndirectCumule), type: "estime" }
  ];
  if (composantOeuf) composants.unshift(composantOeuf);
  composants.push({ label: `Correction mortalité (${(mortalite * 100).toFixed(1)}% observée)`, valeur: Math.round(coutFinal - sousTotal), type: "reel" });

  return { coutUnitaire: Math.round(coutFinal), ageJours: age.valeur, ageType: age.type, mortalite, composants };
}

function effectifVendable(typeKey) {
  const lots = allDucksR.filter(d => d.type === typeKey && d.statut !== "mort");
  return lots.reduce((a, d) => a + (Number(d.quantite) || 1), 0);
}

function prixConseille(coutUnitaire) {
  const marge = config.taux_marge_cible;
  return {
    prixMin: Math.round(coutUnitaire),
    prixConseille: Math.round(coutUnitaire * (1 + marge)),
    margeFcfa: Math.round(coutUnitaire * marge),
    margePct: Math.round(marge * 1000) / 10
  };
}

// =======================================================================
// AFFICHAGE
// =======================================================================
function renderAll() {
  if (!document.getElementById("page-rentabilite")) return;
  if (!Object.values(pretsChargees).every(Boolean)) return; // attend que toutes les sources soient chargées au moins une fois
  const { start, end } = periodRange();
  renderVueGlobale(start, end);
  renderCategories(start, end);
  renderCourbeAge();
}

function badgeType(type) {
  const map = { reel: ["Réel", "ok"], estime: ["Estimé", "warn"], projete: ["Projeté", "warn"] };
  const [label, cls] = map[type] || ["—", "warn"];
  return `<span class="tag ${cls}" style="font-size:9.5px;">${label}</span>`;
}

function renderVueGlobale(start, end) {
  const el = document.getElementById("rentaGlobalKpis");
  if (!el) return;
  const prix = prixAlimentMoyenKg();
  const alimentReel = coutAlimentReelPeriode(start, end);
  const { sante, indirect } = chargesPeriode(start, end);
  const aj = animalJoursParCategorie(start, end);
  const totalAj = Object.values(aj).reduce((a, b) => a + b, 0);

  let coutAliment;
  if (alimentReel) {
    coutAliment = alimentReel;
  } else {
    const estime = Object.entries(aj).reduce((a, [k, v]) => a + v * (config.ration_g_jour[k] / 1000) * prix.valeur, 0);
    coutAliment = { valeur: Math.round(estime), type: "estime", note: "Aucune sortie de stock \"alimentation\" trouvée sur la période : projection à partir des rations paramétrées et de l'effectif présent." };
  }

  const recettes = allFinanceR.filter(t => t.type === "recette" && dansPeriode(t.date, start, end)).reduce((a, t) => a + (Number(t.montant) || 0), 0);
  const coutTotal = coutAliment.valeur + sante + indirect;
  const margeBrute = recettes - coutTotal;
  const mortaliteGlobale = CATEGORIES_ANIMALES.reduce((acc, k) => {
    const lots = allDucksR.filter(d => d.type === k);
    const q = (arr) => arr.reduce((a, d) => a + (Number(d.quantite) || 1), 0);
    acc.morts += q(lots.filter(d => d.statut === "mort")); acc.total += q(lots);
    return acc;
  }, { morts: 0, total: 0 });

  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Coût production ${badgeType(coutTotal ? (alimentReel ? "reel" : "estime") : "estime")}</div><div class="kpi-value">${formatFCFA(coutTotal)}</div></div>
      <div class="kpi yolk"><div class="kpi-label">Chiffre d'affaires</div><div class="kpi-value">${formatFCFA(recettes)}</div></div>
      <div class="kpi ${margeBrute >= 0 ? 'alt' : ''}"><div class="kpi-label">Marge brute</div><div class="kpi-value">${formatFCFA(margeBrute)}</div></div>
      <div class="kpi"><div class="kpi-label">Mortalité (tout le cheptel)</div><div class="kpi-value">${mortaliteGlobale.total ? ((mortaliteGlobale.morts / mortaliteGlobale.total) * 100).toFixed(1) : "0"}%</div></div>
    </div>
    <div class="spacer-m"></div>
    <div class="card">
      <div class="row"><div class="row-main"><span class="row-title">Coût aliment</span><span class="row-sub">${coutAliment.note || ""}</span></div><span class="row-value">${formatFCFA(coutAliment.valeur)} ${badgeType(coutAliment.type)}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Santé / vétérinaire</span></div><span class="row-value">${formatFCFA(sante)} ${badgeType("reel")}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Charges indirectes</span><span class="row-sub">Eau, électricité, matériel, transport, salaire, autres</span></div><span class="row-value">${formatFCFA(indirect)} ${badgeType("reel")}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Animaux-jours sur la période</span><span class="row-sub">Clé de répartition des charges indirectes</span></div><span class="row-value">${Math.round(totalAj)}</span></div>
    </div>
  `;
}

function renderCategories(start, end) {
  const el = document.getElementById("rentaCategories");
  if (!el) return;
  const rows = [];
  const explainRegistry = [];
  const registerExplain = (titre, composants) => {
    explainRegistry.push({ titre, composants });
    return explainRegistry.length - 1;
  };

  ["caneton", "canardeau", "canard"].forEach(k => {
    const r = calculerCoutCategorie(k, start, end);
    const prix = prixConseille(r.coutUnitaire);
    const idx = registerExplain(CAT_LABELS[k], r.composants);
    rows.push(carteCategorie(k, r.coutUnitaire, prix, r, idx, null, effectifVendable(k)));
  });

  // Canard mâle / canne femelle : projection via le coefficient sexe
  // configuré, appliqué à la ration "canard" standard — l'app ne suit
  // pas encore individuellement le sexe des lots adultes non
  // reproducteurs, ce chiffre est donc théorique (projeté).
  const rCanard = calculerCoutCategorie("canard", start, end);
  const baseCout = rCanard.coutUnitaire;
  const coefM = config.coefficient_male_adulte;
  const moyDiviseur = (1 + coefM) / 2;
  const coutFemelleCanard = Math.round(baseCout / moyDiviseur);
  const coutMaleCanard = Math.round(coutFemelleCanard * coefM);

  const idxFemelle = registerExplain("Canne (projeté)", [
    { label: "Base : coût canard toutes rations confondues", valeur: baseCout, type: "estime" },
    { label: "Ration canne = ration canard standard (coefficient 1)", valeur: coutFemelleCanard, type: "projete" }
  ]);
  rows.push(carteCategorie("canard_femelle_est", coutFemelleCanard, prixConseille(coutFemelleCanard), { ageJours: rCanard.ageJours, ageType: "projete" }, idxFemelle, "Canne (projeté)"));

  const idxMale = registerExplain("Canard mâle (projeté)", [
    { label: "Base : coût canne (coefficient 1)", valeur: coutFemelleCanard, type: "projete" },
    { label: `× coefficient mâle adulte (${coefM})`, valeur: coutMaleCanard, type: "projete" }
  ]);
  rows.push(carteCategorie("canard_male_est", coutMaleCanard, prixConseille(coutMaleCanard), { ageJours: rCanard.ageJours, ageType: "projete" }, idxMale, "Canard mâle (projeté)"));

  ["reproducteur_male", "reproducteur_femelle"].forEach(k => {
    const r = calculerCoutCategorie(k, start, end);
    const idx = registerExplain(CAT_LABELS[k], r.composants);
    rows.push(carteReproducteur(k, r, idx));
  });

  const oeuf = calculerCoutOeuf(start, end);
  const prixOeuf = oeuf.coutUnitaire !== null ? prixConseille(oeuf.coutUnitaire) : null;
  const idxOeuf = registerExplain("Œuf", oeuf.composants);
  rows.push(`
    <div class="card">
      <div class="row" style="cursor:pointer;" data-explain-idx="${idxOeuf}">
        <div class="row-icon"><svg><use href="#ic-nest-ponte"/></svg></div>
        <div class="row-main">
          <span class="row-title">Œuf</span>
          <span class="row-sub">${oeuf.oeufsPeriode} œuf(s) sur la période ${badgeType("reel")}</span>
        </div>
        <span class="row-value">${oeuf.coutUnitaire !== null ? formatFCFA(Math.round(oeuf.coutUnitaire)) : "—"}</span>
      </div>
      ${prixOeuf ? `<div class="row"><div class="row-main"><span class="row-title">Prix conseillé</span><span class="row-sub">Marge ${prixOeuf.margePct}%</span></div><span class="row-value pos">${formatFCFA(prixOeuf.prixConseille)}</span></div>` : `<p class="subtle" style="margin:8px 2px 0;">Aucune ponte enregistrée sur la période — coût non calculable.</p>`}
    </div>
  `);

  el.innerHTML = rows.join("");
  el.querySelectorAll("[data-explain-idx]").forEach(rowEl => {
    const entry = explainRegistry[Number(rowEl.dataset.explainIdx)];
    if (entry) rowEl.addEventListener("click", () => explainModal(entry.titre, entry.composants));
  });
}

function carteCategorie(key, coutUnitaire, prix, r, explainIdx, labelOverride, effectif) {
  const label = labelOverride || CAT_LABELS[key] || key;
  const icon = CAT_ICONS[key] || CAT_ICONS.canard;
  return `
    <div class="card">
      <div class="row" style="cursor:pointer;" data-explain-idx="${explainIdx}">
        <div class="row-icon"><svg><use href="#${icon}"/></svg></div>
        <div class="row-main">
          <span class="row-title">${label}</span>
          <span class="row-sub">Âge de référence ${r.ageJours ? r.ageJours + " j" : "—"} ${badgeType(r.ageType || "estime")} · mortalité ${r.mortalite !== undefined ? (r.mortalite * 100).toFixed(1) + "%" : "—"}${effectif !== undefined ? ` · effectif vendable ${effectif}` : ""}</span>
        </div>
        <span class="row-value">${formatFCFA(coutUnitaire)}</span>
      </div>
      <div class="row"><div class="row-main"><span class="row-title">Prix conseillé</span><span class="row-sub">Minimum ${formatFCFA(prix.prixMin)} · marge ${prix.margePct}%</span></div><span class="row-value pos">${formatFCFA(prix.prixConseille)}</span></div>
    </div>
  `;
}

function carteReproducteur(key, r, explainIdx) {
  return `
    <div class="card">
      <div class="row" style="cursor:pointer;" data-explain-idx="${explainIdx}">
        <div class="row-icon"><svg><use href="#${CAT_ICONS[key]}"/></svg></div>
        <div class="row-main">
          <span class="row-title">${CAT_LABELS[key]}</span>
          <span class="row-sub">Effectif vendable : sans objet (reproducteur) · coût de maintien</span>
        </div>
        <span class="row-value">${formatFCFA(r.coutJournalier)} / j</span>
      </div>
      <div class="row"><div class="row-main"><span class="row-title">Coût mensuel de maintien</span></div><span class="row-value">${formatFCFA(r.coutMensuel)}</span></div>
    </div>
  `;
}

function explainModal(titre, composants) {
  const body = `
    <p class="subtle" style="margin-bottom:12px;">Détail du calcul — chaque ligne est étiquetée selon sa fiabilité.</p>
    ${composants.map(c => `
      <div class="row"><div class="row-main"><span class="row-title">${c.label}</span></div><span class="row-value">${typeof c.valeur === "number" && c.unite !== "" ? formatFCFA(c.valeur) : c.valeur} ${badgeType(c.type)}</span></div>
    `).join("")}
  `;
  openModal(`Détail — ${titre}`, body, { onMount: () => {} });
}

function renderCourbeAge() {
  const el = document.getElementById("rentaCourbeAge");
  if (!el) return;
  const prix = prixAlimentMoyenKg();
  const paliers = [15, 30, 45, 60, 75, 90];
  el.innerHTML = `
    <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
      <tr><th style="text-align:left; padding:6px 4px; color:var(--ink-600);">Âge</th><th style="text-align:right; padding:6px 4px; color:var(--ink-600);">Aliment cumulé</th><th style="text-align:right; padding:6px 4px; color:var(--ink-600);">Prix conseillé</th></tr>
      ${paliers.map(j => {
        const c = coutAlimentaireCumule(j, prix.valeur);
        const p = prixConseille(c);
        return `<tr style="border-top:1px solid var(--line);"><td style="padding:7px 4px;">${j} j</td><td style="padding:7px 4px; text-align:right;">${formatFCFA(Math.round(c))}</td><td style="padding:7px 4px; text-align:right; color:var(--pond-600); font-weight:700;">${formatFCFA(p.prixConseille)}</td></tr>`;
      }).join("")}
    </table>
    <p class="subtle" style="margin-top:8px;">${badgeType("projete")} Coût alimentaire seul (hors santé/charges indirectes/mortalité), au prix aliment moyen actuel — sert à repérer le meilleur moment économique pour vendre.</p>
  `;
}

// =======================================================================
// CONFIGURATION (paramètres modifiables sans toucher au code)
// =======================================================================
function openConfigModal() {
  const body = `
    <p class="subtle" style="margin-bottom:14px;">Ces paramètres pilotent tous les calculs du moteur de rentabilité. Modifiez-les si votre réalité de terrain diffère.</p>
    <div class="field"><label>Coefficient mâle adulte (× ration femelle)</label><input type="number" id="cfgCoefMale" min="1" step="0.1" value="${config.coefficient_male_adulte}"></div>
    <div class="field"><label>Marge cible (%)</label><input type="number" id="cfgMarge" min="0" step="1" value="${Math.round(config.taux_marge_cible * 100)}"></div>
    <p class="subtle" style="margin:14px 0 6px;"><b>Rations journalières (g/jour)</b></p>
    <div class="field-row">
      <div class="field"><label>Caneton</label><input type="number" id="cfgRationCaneton" min="0" value="${config.ration_g_jour.caneton}"></div>
      <div class="field"><label>Canardeau</label><input type="number" id="cfgRationCanardeau" min="0" value="${config.ration_g_jour.canardeau}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Canard / canne</label><input type="number" id="cfgRationCanard" min="0" value="${config.ration_g_jour.canard}"></div>
      <div class="field"><label>Reprod. femelle</label><input type="number" id="cfgRationReproF" min="0" value="${config.ration_g_jour.reproducteur_femelle}"></div>
    </div>
    <div class="field"><label>Reprod. mâle</label><input type="number" id="cfgRationReproM" min="0" value="${config.ration_g_jour.reproducteur_male}"></div>
    <button class="btn yolk" id="cfgSave">Enregistrer les paramètres</button>
  `;
  openModal("Paramètres du moteur de rentabilité", body, {
    onMount: () => {
      document.getElementById("cfgSave").addEventListener("click", async () => {
        const nouveauConfig = {
          coefficient_male_adulte: Number(document.getElementById("cfgCoefMale").value) || 2,
          taux_marge_cible: (Number(document.getElementById("cfgMarge").value) || 30) / 100,
          ration_g_jour: {
            caneton: Number(document.getElementById("cfgRationCaneton").value) || 0,
            canardeau: Number(document.getElementById("cfgRationCanardeau").value) || 0,
            canard: Number(document.getElementById("cfgRationCanard").value) || 0,
            reproducteur_femelle: Number(document.getElementById("cfgRationReproF").value) || 0,
            reproducteur_male: Number(document.getElementById("cfgRationReproM").value) || 0
          },
          modifie_par: getUserName() || "Inconnu",
          modifie_le: serverTimestamp()
        };
        try {
          await setDoc(configRef, nouveauConfig, { merge: true });
          config = { ...config, ...nouveauConfig };
          toast("Paramètres enregistrés ✓");
          closeModal();
          renderAll();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

// =======================================================================
// SIMULATEUR — recalcule à la volée, AUCUNE écriture Firestore.
// =======================================================================
function openSimulateurModal() {
  const { start, end } = periodRange();
  const body = `
    <p class="subtle" style="margin-bottom:14px;">Testez un scénario sans toucher à vos données réelles.</p>
    <div class="field"><label>Variation du prix de l'aliment (%)</label><input type="number" id="simAliment" value="0" step="1"></div>
    <div class="field"><label>Mortalité cible pour le caneton (%)</label><input type="number" id="simMortalite" value="${(tauxMortalite('caneton') * 100).toFixed(1)}" step="0.5"></div>
    <div class="field"><label>Prix de vente envisagé pour un canard (FCFA)</label><input type="number" id="simPrixCanard" value="0" step="100"></div>
    <button class="btn yolk" id="simRun">Simuler</button>
    <div class="spacer-m"></div>
    <div id="simResult"></div>
  `;
  openModal("Simulateur de rentabilité", body, {
    onMount: () => {
      document.getElementById("simRun").addEventListener("click", () => {
        const deltaAliment = 1 + (Number(document.getElementById("simAliment").value) || 0) / 100;
        const mortaliteSim = (Number(document.getElementById("simMortalite").value) || 0) / 100;

        const prixBase = prixAlimentMoyenKg();
        const prixSimule = Math.round(prixBase.valeur * deltaAliment);
        const ageCaneton = ageMoyenJours("caneton", 14).valeur;
        const coutAlimBase = coutAlimentaireCumule(ageCaneton, prixBase.valeur);
        const coutAlimSim = coutAlimentaireCumule(ageCaneton, prixSimule);
        const ratioMortBase = 1 / Math.max(0.05, 1 - tauxMortalite("caneton"));
        const ratioMortSim = 1 / Math.max(0.05, 1 - mortaliteSim);

        const rCanard = calculerCoutCategorie("canard", start, end);
        const prixCanardSim = Number(document.getElementById("simPrixCanard").value) || 0;
        const margeCanardSim = prixCanardSim ? prixCanardSim - rCanard.coutUnitaire : null;

        document.getElementById("simResult").innerHTML = `
          <div class="card">
            <div class="row"><div class="row-main"><span class="row-title">Coût aliment caneton (avant → après)</span></div><span class="row-value">${formatFCFA(Math.round(coutAlimBase))} → ${formatFCFA(Math.round(coutAlimSim))}</span></div>
            <div class="row"><div class="row-main"><span class="row-title">Impact mortalité sur le coût final</span><span class="row-sub">Coefficient de correction ${ratioMortBase.toFixed(2)} → ${ratioMortSim.toFixed(2)}</span></div><span class="row-value">${formatFCFA(Math.round(coutAlimSim * ratioMortSim - coutAlimBase * ratioMortBase))}</span></div>
            ${prixCanardSim ? `<div class="row"><div class="row-main"><span class="row-title">Marge estimée par canard à ${formatFCFA(prixCanardSim)}</span><span class="row-sub">Coût de revient actuel : ${formatFCFA(rCanard.coutUnitaire)}</span></div><span class="row-value ${margeCanardSim >= 0 ? 'pos' : 'neg'}">${formatFCFA(margeCanardSim)}</span></div>` : ""}
          </div>
          <p class="subtle" style="margin-top:8px;">Simulation uniquement — rien n'a été enregistré.</p>
        `;
      });
    }
  });
}
