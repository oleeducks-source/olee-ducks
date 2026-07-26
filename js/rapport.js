// =====================================================================
// MODULE : RAPPORT DE LA FERME
// Génère un PDF de synthèse à un instant donné, en lisant l'ensemble des
// collections Firestore existantes. Module 100% LECTURE SEULE : aucune
// écriture, aucune modification de données, quel que soit le mode choisi.
//
// Deux niveaux, volontairement différents :
//  - "simple"  : cheptel, production (nids), stocks (quantités
//                physiques). AUCUNE information financière — les
//                collections finance_transactions / accounts / exercises
//                / journal_ecritures ne sont même pas lues dans ce mode.
//  - "complet" : rapport exhaustif — tout le rapport simple, avec en
//                plus la valorisation des stocks, les formulations
//                détaillées (coûts inclus), les finances (recettes,
//                dépenses, répartition par catégorie) et la comptabilité
//                OHADA complète (balance, compte de résultat, bilan), le
//                tout illustré de graphiques.
// =====================================================================
import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatFCFAPdf, formatDate, toast, openModal, closeModal, getUserName } from "./utils.js";

export function initRapport() {
  const btn = document.getElementById("openRapportBtn");
  if (btn) btn.addEventListener("click", openRapportChoiceModal);
}

function openRapportChoiceModal() {
  openModal("Rapport de la ferme", `
    <p class="subtle">Un document PDF avec une lecture globale et chiffrée de l'état actuel de la ferme.</p>
    <div class="spacer-m"></div>
    <button class="btn yolk" id="btnRapportSimple" style="display:block; width:100%;">📋 Rapport simple</button>
    <p class="subtle" style="margin:6px 0 16px;">Cheptel, production (nids), stocks — sans finances et sans comptabilité.</p>
    <button class="btn secondary" id="btnRapportComplet" style="display:block; width:100%;">📚 Rapport complet</button>
    <p class="subtle" style="margin:6px 0 0;">Tout le rapport simple, plus finances, comptabilité OHADA, formulations détaillées et graphiques.</p>
  `, {
    onMount: () => {
      document.getElementById("btnRapportSimple").addEventListener("click", () => genererRapport("simple"));
      document.getElementById("btnRapportComplet").addEventListener("click", () => genererRapport("complet"));
    }
  });
}

async function genererRapport(mode) {
  closeModal();
  toast("Génération du rapport en cours…");
  try {
    const data = await collecterDonnees(mode);
    const agg = calculerAgregats(data, mode);
    const pdf = construirePdf(agg, mode);
    const dateStr = new Date().toISOString().slice(0, 10);
    pdf.save(`OleeDucks_Rapport_${mode === "simple" ? "Simple" : "Complet"}_${dateStr}.pdf`);
    toast("Rapport généré ✓");
  } catch (e) {
    console.error("Erreur génération rapport :", e);
    toast("Erreur : " + e.message);
  }
}

// ---------------------------------------------------------------------
// Collecte (lecture seule). En mode "simple", les collections
// financières/comptables ne sont même pas interrogées — c'est une
// garantie structurelle, pas juste un choix d'affichage.
// ---------------------------------------------------------------------
async function collecterDonnees(mode) {
  const [ducksSnap, nestsSnap, cyclesSnap, pontesSnap, itemsSnap, formsSnap] = await Promise.all([
    getDocs(collection(db, "ducks")),
    getDocs(collection(db, "nests")),
    getDocs(collection(db, "nest_cycles")),
    getDocs(collection(db, "pontes_journalieres")),
    getDocs(collection(db, "stock_items")),
    getDocs(collection(db, "formulations"))
  ]);
  const out = {
    ducks: ducksSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    nests: nestsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    cycles: cyclesSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    pontes: pontesSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    items: itemsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    forms: formsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    tx: [], compta: null
  };
  if (mode === "complet") {
    const [txSnap, accSnap, exSnap, jrSnap] = await Promise.all([
      getDocs(collection(db, "finance_transactions")),
      getDocs(collection(db, "accounts")),
      getDocs(collection(db, "exercises")),
      getDocs(collection(db, "journal_ecritures"))
    ]);
    out.tx = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    out.compta = {
      accounts: accSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      exercises: exSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      journal: jrSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    };
  }
  return out;
}

function toDateObj(v) { return v?.toDate ? v.toDate() : new Date(v); }

function calculerMoyenneParJour(events, dateField, valueField) {
  if (!events.length) return { total: 0, moyenne: 0, jours: 0 };
  const dates = events.map(e => toDateObj(e[dateField]).getTime()).filter(t => !isNaN(t));
  if (!dates.length) return { total: 0, moyenne: 0, jours: 0 };
  const min = Math.min(...dates), max = Math.max(...dates);
  const jours = Math.max(1, Math.round((max - min) / 86400000) + 1);
  const total = events.reduce((a, e) => a + (Number(e[valueField]) || 0), 0);
  return { total, moyenne: total / jours, jours };
}

const CATS_RECETTE = { vente_canards: "Vente de canards", vente_oeufs: "Vente d'œufs", vente_canetons: "Vente de canetons", autre: "Autre recette" };
const CATS_DEPENSE = { salaire: "Salaire du fermier", eau: "Facture d'eau", electricite: "Facture d'électricité", materiel: "Achat de matériel", aliments: "Achat d'aliments", veterinaire: "Produits vétérinaires", achat_animaux: "Achat d'animaux", autre: "Autre dépense" };

// ---------------------------------------------------------------------
// Agrégats — même logique de calcul que les modules respectifs
// (inventaire.js, nids.js, stocks.js, finances.js, comptabilite.js),
// recalculée ici indépendamment à partir des données fraîchement lues.
// ---------------------------------------------------------------------
function calculerAgregats(data, mode) {
  // ---- Cheptel ----
  const actifs = data.ducks.filter(d => d.statut === "actif");
  const sumType = (t) => actifs.filter(d => d.type === t).reduce((a, d) => a + (Number(d.quantite) || 1), 0);
  const cheptel = {
    caneton: sumType("caneton"),
    canardeau: sumType("canardeau"),
    canard: sumType("canard"),
    reproducteur_male: sumType("reproducteur_male"),
    reproducteur_femelle: sumType("reproducteur_femelle")
  };
  cheptel.total = Object.values(cheptel).reduce((a, v) => a + v, 0);
  cheptel.lots = actifs;

  // ---- Production (nids) ----
  const cyclesActifs = data.cycles.filter(c => c.statut === "ponte" || c.statut === "couvaison");
  const archivedCycles = data.cycles.filter(c => c.statut === "eclos" || c.statut === "echec");
  const oeufsEnCours = cyclesActifs.reduce((a, c) => a + (Number(c.nombre_oeufs) || 0), 0);
  const ponteStats = calculerMoyenneParJour(data.pontes, "date", "quantite");
  const eclosionsReussies = archivedCycles.filter(c => c.statut === "eclos" && c.date_fin);
  const eclosionStats = calculerMoyenneParJour(eclosionsReussies, "date_fin", "nombre_eclos");
  const totalOeufsArchives = archivedCycles.reduce((a, c) => a + (Number(c.nombre_oeufs) || 0), 0);
  const totalEclosArchives = archivedCycles.reduce((a, c) => a + (Number(c.nombre_eclos) || 0), 0);
  const tauxEclosionGlobal = totalOeufsArchives ? Math.round((totalEclosArchives / totalOeufsArchives) * 100) : 0;
  const byNest = {};
  archivedCycles.forEach(c => {
    byNest[c.nid_numero] = byNest[c.nid_numero] || { oeufs: 0, eclos: 0, cycles: 0 };
    byNest[c.nid_numero].oeufs += Number(c.nombre_oeufs) || 0;
    byNest[c.nid_numero].eclos += Number(c.nombre_eclos) || 0;
    byNest[c.nid_numero].cycles += 1;
  });
  const topNests = Object.entries(byNest)
    .map(([n, s]) => ({ n, ...s, taux: s.oeufs ? s.eclos / s.oeufs : 0 }))
    .sort((a, b) => b.taux - a.taux || b.eclos - a.eclos)
    .slice(0, 5);
  const production = {
    nidsOccupes: cyclesActifs.length, nidsPonte: cyclesActifs.filter(c => c.statut === "ponte").length,
    nidsCouvaison: cyclesActifs.filter(c => c.statut === "couvaison").length,
    nidsLibres: 100 - cyclesActifs.length,
    oeufsEnCours, ponteStats, eclosionStats, totalOeufsArchives, totalEclosArchives,
    tauxEclosionGlobal, topNests, cyclesArchivesCount: archivedCycles.length
  };

  // ---- Stocks ----
  const alertesStock = data.items.filter(i => Number(i.quantite_actuelle) <= Number(i.seuil_alerte || 0));
  const itemsAvecPrevision = data.items.map(i => {
    let previsionJours = null;
    if (i.prevision_kg_jour) {
      const r = i.prevision_kg_jour;
      const consoParJourKg = (Number(r.caneton) || 0) * cheptel.caneton + (Number(r.canardeau) || 0) * cheptel.canardeau + (Number(r.adulte) || 0) * (cheptel.canard + cheptel.reproducteur_male + cheptel.reproducteur_femelle);
      if (consoParJourKg > 0) {
        const quantiteKg = i.unite === "kg" ? Number(i.quantite_actuelle) || 0 : (i.poids_unite_kg ? (Number(i.quantite_actuelle) || 0) * Number(i.poids_unite_kg) : null);
        if (quantiteKg !== null) previsionJours = Math.round(quantiteKg / consoParJourKg);
      }
    }
    return { ...i, previsionJours };
  });
  const valorisationStock = mode === "complet"
    ? data.items.reduce((a, i) => a + (Number(i.quantite_actuelle) || 0) * (Number(i.cout_unitaire_moyen) || 0), 0)
    : null;
  const stocks = { items: itemsAvecPrevision, alertesStock, forms: data.forms, valorisationStock };

  let finances = null, compta = null;
  if (mode === "complet") {
    // ---- Finances ----
    const recettesAll = data.tx.filter(t => t.type === "recette");
    const depensesAll = data.tx.filter(t => t.type === "depense");
    const totalRecettesAll = recettesAll.reduce((a, t) => a + (Number(t.montant) || 0), 0);
    const totalDepensesAll = depensesAll.reduce((a, t) => a + (Number(t.montant) || 0), 0);
    const cutoff30 = Date.now() - 30 * 86400000;
    const dans30j = (t) => toDateObj(t.date).getTime() >= cutoff30;
    const recettes30 = recettesAll.filter(dans30j).reduce((a, t) => a + (Number(t.montant) || 0), 0);
    const depenses30 = depensesAll.filter(dans30j).reduce((a, t) => a + (Number(t.montant) || 0), 0);
    const byCatDepense = {};
    depensesAll.forEach(t => { byCatDepense[t.categorie] = (byCatDepense[t.categorie] || 0) + (Number(t.montant) || 0); });
    const byCatRecette = {};
    recettesAll.forEach(t => { byCatRecette[t.categorie] = (byCatRecette[t.categorie] || 0) + (Number(t.montant) || 0); });
    finances = {
      totalRecettesAll, totalDepensesAll, balanceAll: totalRecettesAll - totalDepensesAll,
      recettes30, depenses30, balance30: recettes30 - depenses30,
      byCatDepense, byCatRecette
    };

    // ---- Comptabilité ----
    if (data.compta) {
      const { accounts, exercises, journal } = data.compta;
      const exercice = exercises.find(e => e.statut === "ouvert") || exercises.sort((a, b) => (b.annee || 0) - (a.annee || 0))[0] || null;
      const soldes = {};
      if (exercice) {
        journal.filter(e => e.exercice_id === exercice.id).forEach(e => {
          (e.lines || []).forEach(l => {
            soldes[l.compte] = soldes[l.compte] || { debit: 0, credit: 0 };
            soldes[l.compte].debit += Number(l.debit) || 0;
            soldes[l.compte].credit += Number(l.credit) || 0;
          });
        });
      }
      let totalProduits = 0, totalCharges = 0, totalActif = 0, totalPassif = 0;
      const comptesUtilises = Object.keys(soldes);
      const parClasse = {};
      comptesUtilises.forEach(num => {
        const acc = accounts.find(a => a.numero === num);
        if (!acc) return;
        const s = soldes[num];
        if (acc.classe === 7) totalProduits += (s.credit - s.debit);
        if (acc.classe === 6) totalCharges += (s.debit - s.credit);
        if (acc.nature === "actif") totalActif += (s.debit - s.credit);
        if (acc.nature === "passif") totalPassif += (s.credit - s.debit);
        const montantClasse = Math.abs(s.debit - s.credit);
        parClasse[acc.classe] = (parClasse[acc.classe] || 0) + montantClasse;
      });
      const resultatNet = totalProduits - totalCharges;
      totalPassif += resultatNet;
      compta = { exercice, accounts, soldes, comptesUtilises, totalProduits, totalCharges, resultatNet, totalActif, totalPassif, parClasse };
    }
  }

  return { cheptel, production, stocks, finances, compta, mode, genereLe: new Date(), genereApr: getUserName() || "Inconnu" };
}

// =====================================================================
// CONSTRUCTION DU PDF
// =====================================================================
const C = {
  pond950: [14, 46, 44], pond800: [18, 63, 60], pond600: [29, 90, 84],
  yolk500: [232, 169, 58], yolk600: [207, 142, 35],
  sage100: [234, 240, 230], ink900: [19, 35, 32], inkMuted: [107, 122, 117],
  line: [216, 226, 217], clay: [193, 84, 58], white: [255, 255, 255]
};
const CHART_PALETTE = [C.pond600, C.yolk500, C.clay, [122, 90, 191], [61, 111, 191], [90, 150, 120]];
const PAGE_W = 210, PAGE_H = 297, MARGIN_X = 14;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const RIGHT = MARGIN_X + CONTENT_W;

function construirePdf(agg, mode) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF();
  const st = { pdf, y: 0 };

  couvertures(st, agg, mode);

  pdf.addPage(); st.y = 22;
  sectionTitre(st, "Cheptel", "Répartition et effectifs actuels");
  sectionCheptel(st, agg);

  pdf.addPage(); st.y = 22;
  sectionTitre(st, "Production — Nids", "Suivi de ponte et d'éclosion");
  sectionProduction(st, agg);

  pdf.addPage(); st.y = 22;
  sectionTitre(st, "Stocks", "Aliments et produits vétérinaires");
  sectionStocks(st, agg);

  if (mode === "complet") {
    if (agg.stocks.forms.length) {
      pdf.addPage(); st.y = 22;
      sectionTitre(st, "Formulations alimentaires", "Détail des recettes d'aliments enregistrées");
      sectionFormulations(st, agg);
    }
    pdf.addPage(); st.y = 22;
    sectionTitre(st, "Finances", "Recettes et dépenses");
    sectionFinances(st, agg);

    pdf.addPage(); st.y = 22;
    sectionTitre(st, "Comptabilité OHADA", "Balance, compte de résultat, bilan");
    sectionComptabilite(st, agg);

    pdf.addPage(); st.y = 22;
    sectionTitre(st, "Détail du cheptel", "Liste des lots actifs");
    sectionDetailCheptel(st, agg);
  }

  paginer(pdf);
  return pdf;
}

// ---------------------------------------------------------------------
// Page de couverture
// ---------------------------------------------------------------------
function couvertures(st, agg, mode) {
  const { pdf } = st;
  pdf.setFillColor(...C.pond950);
  pdf.rect(0, 0, PAGE_W, PAGE_H, "F");

  pdf.setTextColor(...C.yolk500);
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(11);
  pdf.text("OLEE DUCKS", MARGIN_X, 40);

  pdf.setTextColor(...C.white);
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(28);
  pdf.text("Rapport de la ferme", MARGIN_X, 58);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(15);
  pdf.setTextColor(...C.yolk500);
  pdf.text(mode === "simple" ? "Édition simple" : "Édition complète", MARGIN_X, 68);

  pdf.setDrawColor(...C.pond600);
  pdf.setLineWidth(0.5);
  pdf.line(MARGIN_X, 78, RIGHT, 78);

  pdf.setTextColor(200, 216, 210);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(10);
  pdf.text(`Généré le ${agg.genereLe.toLocaleDateString("fr-FR")} à ${agg.genereLe.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`, MARGIN_X, 88);
  pdf.text(`Par ${agg.genereApr}`, MARGIN_X, 95);

  // Bandeau de chiffres clés — le rapport complet inclut un indicateur
  // financier ; le rapport simple reste strictement opérationnel.
  const chiffres = mode === "complet" ? [
    { label: "Canards actifs", valeur: String(agg.cheptel.total) },
    { label: "Nids occupés", valeur: `${agg.production.nidsOccupes}/100` },
    { label: "Taux d'éclosion", valeur: `${agg.production.tauxEclosionGlobal}%` },
    { label: "Balance (30 j)", valeur: formatFCFAPdf(agg.finances.balance30) }
  ] : [
    { label: "Canards actifs", valeur: String(agg.cheptel.total) },
    { label: "Nids occupés", valeur: `${agg.production.nidsOccupes}/100` },
    { label: "Taux d'éclosion", valeur: `${agg.production.tauxEclosionGlobal}%` },
    { label: "Alertes stock", valeur: String(agg.stocks.alertesStock.length) }
  ];
  let cardY = 115;
  const cardH = 30, gap = 6;
  const cardW = (CONTENT_W - gap * 3) / 4;
  chiffres.forEach((c, i) => {
    const x = MARGIN_X + i * (cardW + gap);
    pdf.setFillColor(...C.pond800);
    pdf.roundedRect(x, cardY, cardW, cardH, 3, 3, "F");
    pdf.setTextColor(160, 190, 184);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5);
    const labelLines = pdf.splitTextToSize(c.label.toUpperCase(), cardW - 6);
    pdf.text(labelLines, x + 4, cardY + 8);
    pdf.setTextColor(...C.white);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(12.5);
    pdf.text(c.valeur, x + 4, cardY + 22);
  });

  pdf.setTextColor(140, 160, 155);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.5);
  const contenu = mode === "simple"
    ? "Ce rapport couvre : cheptel, production (nids), stocks. Aucune information financière."
    : "Ce rapport couvre : cheptel (détaillé), production (nids), stocks (valorisés), formulations, finances et comptabilité OHADA.";
  pdf.text(contenu, MARGIN_X, PAGE_H - 18, { maxWidth: CONTENT_W });
}

// ---------------------------------------------------------------------
// Helpers de mise en page réutilisés par toutes les sections
// ---------------------------------------------------------------------
function ensureSpace(st, needed) {
  if (st.y + needed > PAGE_H - 20) {
    st.pdf.addPage();
    st.y = 22;
  }
}

function sectionTitre(st, titre, sousTitre) {
  const { pdf } = st;
  pdf.setTextColor(...C.pond950);
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(17);
  pdf.text(titre, MARGIN_X, st.y);
  if (sousTitre) {
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(9.5);
    pdf.setTextColor(...C.inkMuted);
    pdf.text(sousTitre, MARGIN_X, st.y + 6);
  }
  pdf.setDrawColor(...C.yolk500); pdf.setLineWidth(1);
  pdf.line(MARGIN_X, st.y + 10, MARGIN_X + 28, st.y + 10);
  st.y += 18;
}

function sousTitreSection(st, texte) {
  ensureSpace(st, 12);
  const { pdf } = st;
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(11.5); pdf.setTextColor(...C.pond800);
  pdf.text(texte, MARGIN_X, st.y);
  st.y += 7;
}

// Rangée de mini-cartes chiffrées (KPI)
function kpiRow(st, items) {
  ensureSpace(st, 24);
  const { pdf } = st;
  const gap = 5;
  const w = (CONTENT_W - gap * (items.length - 1)) / items.length;
  const h = 20;
  items.forEach((it, i) => {
    const x = MARGIN_X + i * (w + gap);
    pdf.setFillColor(...C.sage100);
    pdf.roundedRect(x, st.y, w, h, 2, 2, "F");
    pdf.setTextColor(...C.inkMuted);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(6.8);
    pdf.text(it.label.toUpperCase(), x + 3, st.y + 6, { maxWidth: w - 6 });
    pdf.setTextColor(...(it.color || C.pond950));
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(12);
    pdf.text(String(it.valeur), x + 3, st.y + 15.5);
  });
  st.y += h + 10;
}

// Tableau générique avec en-tête sombre et lignes alternées
function table(st, headers, rows, colRatios, aligns) {
  const { pdf } = st;
  const colW = colRatios.map(r => r * CONTENT_W);
  const colX = [MARGIN_X];
  for (let i = 1; i < colW.length; i++) colX.push(colX[i - 1] + colW[i - 1]);

  const drawHeader = () => {
    ensureSpace(st, 12);
    pdf.setFillColor(...C.pond950);
    pdf.rect(MARGIN_X, st.y, CONTENT_W, 8, "F");
    pdf.setTextColor(...C.white);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(7.8);
    headers.forEach((h, i) => {
      const align = aligns[i] || "left";
      const tx = align === "right" ? colX[i] + colW[i] - 2 : colX[i] + 2;
      pdf.text(h.toUpperCase(), tx, st.y + 5.5, { align });
    });
    st.y += 8;
  };
  drawHeader();

  pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.3);
  rows.forEach((row, i) => {
    if (st.y > PAGE_H - 18) { st.pdf.addPage(); st.y = 22; drawHeader(); pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.3); }
    if (i % 2 === 1) { pdf.setFillColor(...C.sage100); pdf.rect(MARGIN_X, st.y, CONTENT_W, 7, "F"); }
    pdf.setTextColor(...C.ink900);
    row.forEach((cell, ci) => {
      const align = aligns[ci] || "left";
      const tx = align === "right" ? colX[ci] + colW[ci] - 2 : colX[ci] + 2;
      pdf.text(String(cell), tx, st.y + 5, { align, maxWidth: colW[ci] - 4 });
    });
    st.y += 7;
  });
  st.y += 6;
}

function ligneTotal(st, label, valeur, positif = true) {
  ensureSpace(st, 12);
  const { pdf } = st;
  pdf.setFillColor(...C.pond950);
  pdf.rect(MARGIN_X, st.y, CONTENT_W, 10, "F");
  pdf.setTextColor(...C.white);
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(10);
  pdf.text(label.toUpperCase(), MARGIN_X + 3, st.y + 6.8);
  pdf.setTextColor(...(positif ? C.yolk500 : [242, 169, 160]));
  pdf.text(String(valeur), RIGHT - 3, st.y + 6.8, { align: "right" });
  st.y += 16;
}

function texteVide(st, message) {
  ensureSpace(st, 12);
  const { pdf } = st;
  pdf.setFont("helvetica", "italic"); pdf.setFontSize(9); pdf.setTextColor(...C.inkMuted);
  pdf.text(message, MARGIN_X, st.y);
  st.y += 10;
}

// ---------------------------------------------------------------------
// Graphique 1 — barres horizontales (répartitions, classements)
// items: [{ label, value, color? }] — dessine dans la largeur disponible
// ---------------------------------------------------------------------
function barChart(st, items, opts = {}) {
  const validItems = items.filter(it => it.value > 0);
  if (!validItems.length) { texteVide(st, "Pas encore de données pour ce graphique."); return; }
  const maxVal = Math.max(...validItems.map(it => it.value));
  const barH = 8, gap = 4;
  const labelW = opts.labelW || 46;
  const valueW = 22;
  const barAreaW = CONTENT_W - labelW - valueW;
  const totalH = validItems.length * (barH + gap);
  ensureSpace(st, totalH + 6);
  const { pdf } = st;
  validItems.forEach((it, i) => {
    const y = st.y + i * (barH + gap);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor(...C.ink900);
    pdf.text(String(it.label), MARGIN_X, y + barH / 2 + 1.5, { maxWidth: labelW - 4 });
    pdf.setFillColor(...C.sage100);
    pdf.rect(MARGIN_X + labelW, y, barAreaW, barH, "F");
    const w = Math.max(2, (it.value / maxVal) * barAreaW);
    pdf.setFillColor(...(it.color || CHART_PALETTE[i % CHART_PALETTE.length]));
    pdf.rect(MARGIN_X + labelW, y, w, barH, "F");
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(8); pdf.setTextColor(...C.pond950);
    pdf.text(opts.formatValue ? opts.formatValue(it.value) : String(it.value), MARGIN_X + labelW + barAreaW + 2, y + barH / 2 + 1.5);
  });
  st.y += totalH + 8;
}

// ---------------------------------------------------------------------
// Graphique 2 — anneau (donut) simple, dessiné par polygones (jsPDF n'a
// pas de primitive "camembert" native). segments: [{label, value, color}]
// ---------------------------------------------------------------------
function donutChart(st, segments, centerLabel) {
  const validSegments = segments.filter(s => s.value > 0);
  const total = validSegments.reduce((a, s) => a + s.value, 0);
  const rowH = 22 + Math.max(0, validSegments.length - 3) * 6;
  ensureSpace(st, rowH + 6);
  const { pdf } = st;
  const cx = MARGIN_X + 26, cy = st.y + 24, rOuter = 20, rInner = 11;

  if (!total) {
    texteVide(st, "Pas encore de données pour ce graphique.");
    return;
  }

  let angleStart = -90; // départ en haut, sens horaire
  validSegments.forEach((s, i) => {
    const angleSweep = (s.value / total) * 360;
    const color = s.color || CHART_PALETTE[i % CHART_PALETTE.length];
    pdf.setFillColor(...color);
    const steps = Math.max(2, Math.ceil(angleSweep / 4));
    const pts = [];
    for (let k = 0; k <= steps; k++) {
      const a = (angleStart + (angleSweep * k) / steps) * Math.PI / 180;
      pts.push([cx + Math.cos(a) * rOuter, cy + Math.sin(a) * rOuter]);
    }
    for (let k = steps; k >= 0; k--) {
      const a = (angleStart + (angleSweep * k) / steps) * Math.PI / 180;
      pts.push([cx + Math.cos(a) * rInner, cy + Math.sin(a) * rInner]);
    }
    const lineSegs = pts.slice(1).map((p, idx) => [p[0] - pts[idx][0], p[1] - pts[idx][1]]);
    pdf.lines(lineSegs, pts[0][0], pts[0][1], [1, 1], "F", true);
    angleStart += angleSweep;
  });

  if (centerLabel) {
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.setTextColor(...C.pond950);
    pdf.text(String(centerLabel), cx, cy + 2, { align: "center" });
  }

  // Légende à droite de l'anneau
  const legendX = MARGIN_X + 60;
  validSegments.forEach((s, i) => {
    const ly = st.y + 6 + i * 6;
    const color = s.color || CHART_PALETTE[i % CHART_PALETTE.length];
    pdf.setFillColor(...color);
    pdf.rect(legendX, ly - 3, 4, 4, "F");
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor(...C.ink900);
    const pct = Math.round((s.value / total) * 100);
    pdf.text(`${s.label} — ${s.value} (${pct}%)`, legendX + 6, ly);
  });

  st.y += rowH + 8;
}

// ---------------------------------------------------------------------
// Section : Cheptel
// ---------------------------------------------------------------------
function sectionCheptel(st, agg) {
  const c = agg.cheptel;
  kpiRow(st, [
    { label: "Canetons (0-3 sem.)", valeur: c.caneton },
    { label: "Canardeaux (4-8 sem.)", valeur: c.canardeau },
    { label: "Canards adultes", valeur: c.canard },
    { label: "Reproducteurs M/F", valeur: `${c.reproducteur_male}/${c.reproducteur_femelle}` }
  ]);
  sousTitreSection(st, "Répartition du cheptel");
  barChart(st, [
    { label: "Canetons", value: c.caneton },
    { label: "Canardeaux", value: c.canardeau },
    { label: "Canards adultes", value: c.canard },
    { label: "Reprod. mâles", value: c.reproducteur_male },
    { label: "Reprod. femelles", value: c.reproducteur_femelle }
  ]);
  ligneTotal(st, "Total du cheptel actif", `${c.total} sujets`);
}

// ---------------------------------------------------------------------
// Section : Production (nids)
// ---------------------------------------------------------------------
function sectionProduction(st, agg) {
  const p = agg.production;
  kpiRow(st, [
    { label: "Nids occupés", valeur: `${p.nidsOccupes}/100` },
    { label: "En ponte", valeur: p.nidsPonte },
    { label: "En couvaison", valeur: p.nidsCouvaison },
    { label: "Œufs en cours", valeur: p.oeufsEnCours }
  ]);

  sousTitreSection(st, "Occupation des 100 nids");
  donutChart(st, [
    { label: "En ponte", value: p.nidsPonte, color: C.yolk500 },
    { label: "En couvaison", value: p.nidsCouvaison, color: C.pond600 },
    { label: "Libres", value: p.nidsLibres, color: C.line }
  ], `${p.nidsOccupes}/100`);

  sousTitreSection(st, "Moyennes quotidiennes");
  table(st,
    ["Indicateur", "Période couverte", "Moyenne / jour"],
    [
      ["Ponte moyenne", `${p.ponteStats.jours} jour(s)`, `${p.ponteStats.moyenne.toFixed(1)} œuf(s)`],
      ["Canetons éclos", `${p.eclosionStats.jours} jour(s)`, `${p.eclosionStats.moyenne.toFixed(1)} caneton(s)`]
    ],
    [0.45, 0.3, 0.25], ["left", "left", "right"]
  );

  sousTitreSection(st, `Éclosion globale — ${p.cyclesArchivesCount} cycle(s) archivé(s)`);
  table(st,
    ["Œufs couvés (cumulé)", "Canetons éclos (cumulé)", "Taux global"],
    [[p.totalOeufsArchives, p.totalEclosArchives, p.tauxEclosionGlobal + "%"]],
    [0.4, 0.4, 0.2], ["left", "left", "right"]
  );

  if (p.topNests.length) {
    sousTitreSection(st, "Nids les plus productifs — taux d'éclosion");
    barChart(st, p.topNests.map(n => ({ label: `Nid n° ${n.n}`, value: Math.round(n.taux * 100), color: C.pond600 })), { formatValue: v => v + "%" });
    table(st,
      ["Nid", "Cycles", "Œufs → Éclos", "Taux"],
      p.topNests.map(n => [`N° ${n.n}`, n.cycles, `${n.eclos} / ${n.oeufs}`, Math.round(n.taux * 100) + "%"]),
      [0.25, 0.2, 0.35, 0.2], ["left", "right", "right", "right"]
    );
  }
}

// ---------------------------------------------------------------------
// Section : Stocks
// ---------------------------------------------------------------------
function sectionStocks(st, agg) {
  const s = agg.stocks;
  const kpis = [
    { label: "Articles suivis", valeur: s.items.length },
    { label: "Alertes seuil bas", valeur: s.alertesStock.length, color: s.alertesStock.length ? C.clay : C.pond950 }
  ];
  if (s.valorisationStock !== null) kpis.push({ label: "Valorisation totale", valeur: formatFCFAPdf(s.valorisationStock) });
  kpiRow(st, kpis);

  if (s.items.length) {
    sousTitreSection(st, "Niveau de stock par article");
    barChart(st, s.items.map(i => ({ label: i.nom, value: Number(i.quantite_actuelle) || 0, color: Number(i.quantite_actuelle) <= Number(i.seuil_alerte || 0) ? C.clay : C.pond600 })), { formatValue: (v, idx) => v });

    sousTitreSection(st, "État des articles");
    const headers = s.valorisationStock !== null
      ? ["Article", "Type", "Quantité", "Autonomie prév.", "Valeur"]
      : ["Article", "Type", "Quantité", "Autonomie prévisionnelle"];
    const ratios = s.valorisationStock !== null ? [0.3, 0.18, 0.18, 0.16, 0.18] : [0.36, 0.2, 0.22, 0.22];
    const aligns = s.valorisationStock !== null ? ["left", "left", "right", "right", "right"] : ["left", "left", "right", "right"];
    table(st, headers, s.items.map(i => {
      const row = [i.nom, i.type === "aliment" ? "Aliment" : "Vétérinaire", `${i.quantite_actuelle} ${i.unite}`, i.previsionJours !== null ? `${i.previsionJours} j` : "—"];
      if (s.valorisationStock !== null) row.push(formatFCFAPdf((Number(i.quantite_actuelle) || 0) * (Number(i.cout_unitaire_moyen) || 0)));
      return row;
    }), ratios, aligns);
  } else {
    texteVide(st, "Aucun article de stock enregistré.");
  }

  if (s.alertesStock.length) {
    sousTitreSection(st, "⚠ Articles sous le seuil d'alerte");
    table(st,
      ["Article", "Quantité actuelle", "Seuil"],
      s.alertesStock.map(i => [i.nom, `${i.quantite_actuelle} ${i.unite}`, `${i.seuil_alerte} ${i.unite}`]),
      [0.5, 0.25, 0.25], ["left", "right", "right"]
    );
  }
}

// ---------------------------------------------------------------------
// Section : Formulations (mode complet)
// ---------------------------------------------------------------------
function sectionFormulations(st, agg) {
  const forms = agg.stocks.forms;
  table(st,
    ["Formulation", "Date", "Total kg", "Prix de revient/kg", "Coût total"],
    forms.map(f => [f.nom, formatDate(f.date), `${(f.total_kg || 0).toFixed(1)} kg`, formatFCFAPdf(Math.round(f.prix_revient_kg || 0)), formatFCFAPdf(f.total_general || 0)]),
    [0.28, 0.18, 0.16, 0.2, 0.18], ["left", "left", "right", "right", "right"]
  );
  if (forms.length) {
    sousTitreSection(st, "Prix de revient au kg par formulation");
    barChart(st, forms.map(f => ({ label: f.nom, value: Math.round(f.prix_revient_kg || 0), color: C.yolk600 })), { formatValue: v => formatFCFAPdf(v) });
  }
}

// ---------------------------------------------------------------------
// Section : Finances (mode complet)
// ---------------------------------------------------------------------
function sectionFinances(st, agg) {
  const f = agg.finances;
  sousTitreSection(st, "Cumul depuis le début");
  kpiRow(st, [
    { label: "Total recettes", valeur: formatFCFAPdf(f.totalRecettesAll), color: C.pond600 },
    { label: "Total dépenses", valeur: formatFCFAPdf(f.totalDepensesAll), color: C.clay },
    { label: "Balance cumulée", valeur: formatFCFAPdf(f.balanceAll), color: f.balanceAll >= 0 ? C.pond600 : C.clay }
  ]);

  sousTitreSection(st, "Recettes vs Dépenses (30 derniers jours)");
  barChart(st, [
    { label: "Recettes (30 j)", value: f.recettes30, color: C.pond600 },
    { label: "Dépenses (30 j)", value: f.depenses30, color: C.clay }
  ], { formatValue: v => formatFCFAPdf(v) });

  const catRows = Object.entries(f.byCatDepense).sort((a, b) => b[1] - a[1]);
  if (catRows.length) {
    sousTitreSection(st, "Répartition des dépenses par catégorie (cumul)");
    donutChart(st, catRows.map(([cat, montant]) => ({ label: CATS_DEPENSE[cat] || cat, value: montant })));
    table(st, ["Catégorie", "Montant"], catRows.map(([cat, montant]) => [CATS_DEPENSE[cat] || cat, formatFCFAPdf(montant)]), [0.7, 0.3], ["left", "right"]);
  }
  const recRows = Object.entries(f.byCatRecette).sort((a, b) => b[1] - a[1]);
  if (recRows.length) {
    sousTitreSection(st, "Répartition des recettes par catégorie (cumul)");
    donutChart(st, recRows.map(([cat, montant]) => ({ label: CATS_RECETTE[cat] || cat, value: montant })));
    table(st, ["Catégorie", "Montant"], recRows.map(([cat, montant]) => [CATS_RECETTE[cat] || cat, formatFCFAPdf(montant)]), [0.7, 0.3], ["left", "right"]);
  }
}

// ---------------------------------------------------------------------
// Section : Comptabilité OHADA (mode complet)
// ---------------------------------------------------------------------
function sectionComptabilite(st, agg) {
  const c = agg.compta;
  if (!c || !c.exercice) {
    texteVide(st, "Aucun exercice comptable ouvert — section non disponible.");
    return;
  }
  sousTitreSection(st, `Exercice ${c.exercice.annee}`);
  kpiRow(st, [
    { label: "Total produits", valeur: formatFCFAPdf(c.totalProduits), color: C.pond600 },
    { label: "Total charges", valeur: formatFCFAPdf(c.totalCharges), color: C.clay },
    { label: "Résultat net", valeur: formatFCFAPdf(c.resultatNet), color: c.resultatNet >= 0 ? C.pond600 : C.clay }
  ]);

  sousTitreSection(st, "Produits vs Charges");
  barChart(st, [
    { label: "Produits", value: c.totalProduits, color: C.pond600 },
    { label: "Charges", value: c.totalCharges, color: C.clay }
  ], { formatValue: v => formatFCFAPdf(v) });

  sousTitreSection(st, "Bilan");
  kpiRow(st, [
    { label: "Total ACTIF", valeur: formatFCFAPdf(c.totalActif) },
    { label: "Total PASSIF (dont résultat)", valeur: formatFCFAPdf(c.totalPassif) }
  ]);

  if (c.comptesUtilises.length) {
    sousTitreSection(st, "Balance des comptes");
    table(st,
      ["N°", "Libellé", "Débit", "Crédit", "Solde"],
      c.comptesUtilises.sort().map(num => {
        const acc = c.accounts.find(a => a.numero === num);
        const s = c.soldes[num];
        const solde = s.debit - s.credit;
        return [num, acc ? acc.libelle.slice(0, 30) : "?", formatFCFAPdf(s.debit), formatFCFAPdf(s.credit), (solde >= 0 ? "D " : "C ") + formatFCFAPdf(Math.abs(solde))];
      }),
      [0.1, 0.36, 0.18, 0.18, 0.18], ["left", "left", "right", "right", "right"]
    );
  }
}

// ---------------------------------------------------------------------
// Section : Détail du cheptel (mode complet) — liste des lots actifs
// ---------------------------------------------------------------------
function sectionDetailCheptel(st, agg) {
  const TYPE_LABELS = { caneton: "Caneton", canardeau: "Canardeau", canard: "Canard", reproducteur_male: "Repro. mâle", reproducteur_femelle: "Repro. femelle" };
  const lots = agg.cheptel.lots;
  if (!lots.length) { texteVide(st, "Aucun lot actif."); return; }
  table(st,
    ["Type", "Quantité", "Bague", "Date d'entrée"],
    lots.map(d => [TYPE_LABELS[d.type] || d.type, d.quantite || 1, d.bague_couleur ? d.bague_couleur : "—", formatDate(d.date_entree)]),
    [0.3, 0.2, 0.25, 0.25], ["left", "right", "left", "right"]
  );
}

// ---------------------------------------------------------------------
// Pagination — numéro de page + mention en pied de chaque page (sauf la
// couverture, qui a son propre pied de page dédié).
// ---------------------------------------------------------------------
function paginer(pdf) {
  const total = pdf.internal.getNumberOfPages();
  for (let i = 2; i <= total; i++) {
    pdf.setPage(i);
    pdf.setDrawColor(...C.line); pdf.setLineWidth(0.3);
    pdf.line(MARGIN_X, PAGE_H - 14, RIGHT, PAGE_H - 14);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5); pdf.setTextColor(...C.inkMuted);
    pdf.text("Olee Ducks — Rapport interne", MARGIN_X, PAGE_H - 9);
    pdf.text(`Page ${i - 1} / ${total - 1}`, RIGHT, PAGE_H - 9, { align: "right" });
  }
}
