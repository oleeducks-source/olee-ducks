// =====================================================================
// MODULE : STOCKS (aliments & produits vétérinaires)
// Collections "stock_items" et "stock_mouvements".
// Ce module ne dépend JAMAIS du module Finances pour fonctionner : les
// niveaux de stock, alertes et statistiques de durée d'utilisation sont
// calculés uniquement à partir des mouvements de stock. L'écriture
// éventuelle d'une dépense liée dans "finance_transactions" est une
// option indépendante (case à cocher), jamais une exigence.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot,
  serverTimestamp, orderBy, query, increment
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatFCFA, formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName } from "./utils.js";

const itemsCol = collection(db, "stock_items");
const movCol = collection(db, "stock_mouvements");
const formulationsCol = collection(db, "formulations");

let allItems = [];
let allMovements = [];
let allFormulations = [];
let filterType = "all";
let currentStocksView = "articles";

export function initStocks() {
  onSnapshot(query(itemsCol, orderBy("nom")), (snap) => {
    allItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  }, err => console.error("Erreur lecture stocks :", err));

  onSnapshot(query(movCol, orderBy("date", "desc")), (snap) => {
    allMovements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  }, err => console.error("Erreur lecture mouvements :", err));

  onSnapshot(query(formulationsCol, orderBy("date", "desc")), (snap) => {
    allFormulations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFormulationsList();
  }, err => console.error("Erreur lecture formulations :", err));

  document.querySelectorAll("#stockFilterType button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#stockFilterType button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filterType = btn.dataset.v;
      renderList();
    });
  });

  document.querySelectorAll("#stocksView button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#stocksView button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentStocksView = btn.dataset.v;
      document.getElementById("stocksArticlesWrap").classList.toggle("hidden", currentStocksView !== "articles");
      document.getElementById("stocksFormulationsWrap").classList.toggle("hidden", currentStocksView !== "formulations");
    });
  });

  document.getElementById("openFormulationBtn")?.addEventListener("click", openFormulationModal);
}

// Consommation moyenne / jour sur les sorties des 30 derniers jours -> estimation d'autonomie
function estimateDaysLeft(item) {
  const cutoff = Date.now() - 30 * 86400000;
  const sorties = allMovements.filter(m => m.item_id === item.id && m.type_mouvement === "sortie" && toMs(m.date) >= cutoff);
  const totalSorti = sorties.reduce((a, m) => a + Number(m.quantite || 0), 0);
  if (totalSorti <= 0) return null;
  const avgPerDay = totalSorti / 30;
  if (avgPerDay <= 0) return null;
  return Math.round((Number(item.quantite_actuelle) || 0) / avgPerDay);
}

function toMs(d) { return d?.toDate ? d.toDate().getTime() : new Date(d).getTime(); }

function renderList() {
  let items = allItems;
  if (filterType !== "all") items = items.filter(i => i.type === filterType);

  const alerts = allItems.filter(i => Number(i.quantite_actuelle) <= Number(i.seuil_alerte || 0));
  const alertsEl = document.getElementById("stockAlertsCard");
  if (alertsEl) {
    alertsEl.innerHTML = `
      <h3 style="font-size:14px; margin-bottom:8px;">Alertes de réapprovisionnement</h3>
      ${alerts.length ? alerts.map(i => `
        <div class="row"><div class="row-main"><span class="row-title">${escapeHtml(i.nom)}</span><span class="row-sub">Seuil ${i.seuil_alerte} ${i.unite}</span></div><span class="tag danger">${i.quantite_actuelle} ${i.unite}</span></div>
      `).join("") : `<p class="subtle">Aucun article sous le seuil d'alerte. ✓</p>`}
    `;
  }
  setText("kpiAlertesStock", alerts.length);

  const listEl = document.getElementById("stockList");
  if (!listEl) return;
  if (!items.length) {
    listEl.innerHTML = `<div class="empty-state"><div class="glyph">🌾</div><p>Aucun article. Ajoutez un aliment ou un produit vétérinaire.</p></div>`;
    return;
  }
  listEl.innerHTML = items.map(i => {
    const daysLeft = estimateDaysLeft(i);
    const low = Number(i.quantite_actuelle) <= Number(i.seuil_alerte || 0);
    return `
    <div class="row">
      <div class="row-main">
        <span class="row-title">${escapeHtml(i.nom)}</span>
        <span class="row-sub">${i.type === "aliment" ? "Aliment" : "Vétérinaire"} · ${formatFCFA(i.cout_unitaire_moyen)} / ${i.unite}${daysLeft !== null ? ` · ~${daysLeft} j restants` : ""}${i.cree_par ? " · ajouté par " + escapeHtml(i.cree_par) : ""}</span>
      </div>
      <span class="tag ${low ? "danger" : "ok"}">${i.quantite_actuelle} ${i.unite}</span>
    </div>`;
  }).join("");
  listEl.querySelectorAll(".row").forEach((rowEl, idx) => {
    rowEl.style.cursor = "pointer";
    rowEl.addEventListener("click", () => openItemDetail(items[idx]));
  });
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

export function openAddStockItemModal() {
  const body = `
    <div class="field">
      <label>Type</label>
      <select id="fItType"><option value="aliment">Aliment</option><option value="veterinaire">Produit vétérinaire</option></select>
    </div>
    <div class="field"><label>Nom</label><input type="text" id="fItNom" placeholder="ex : Aliment ponte 21%"></div>
    <div class="field-row">
      <div class="field"><label>Unité</label>
        <select id="fItUnite"><option value="kg">kg</option><option value="sac">sac</option><option value="litre">litre</option><option value="unite">unité</option></select>
      </div>
      <div class="field"><label>Quantité initiale</label><input type="number" id="fItQte" min="0" value="0"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Seuil d'alerte</label><input type="number" id="fItSeuil" min="0" value="0"></div>
      <div class="field"><label>Coût unitaire (FCFA)</label><input type="number" id="fItCout" min="0" value="0"></div>
    </div>
    <div class="field"><label>Date de péremption (optionnel)</label><input type="date" id="fItPeremption"></div>
    <button class="btn yolk" id="fItSave">Créer l'article</button>
  `;
  openModal("Nouvel article de stock", body, {
    onMount: () => {
      document.getElementById("fItSave").addEventListener("click", async () => {
        const nom = document.getElementById("fItNom").value.trim();
        if (!nom) { toast("Le nom est requis"); return; }
        try {
          await addDoc(itemsCol, {
            nom, type: document.getElementById("fItType").value,
            unite: document.getElementById("fItUnite").value,
            quantite_actuelle: Number(document.getElementById("fItQte").value) || 0,
            seuil_alerte: Number(document.getElementById("fItSeuil").value) || 0,
            cout_unitaire_moyen: Number(document.getElementById("fItCout").value) || 0,
            date_peremption: document.getElementById("fItPeremption").value ? new Date(document.getElementById("fItPeremption").value) : null,
            cree_par: getUserName() || "Inconnu",
            createdAt: serverTimestamp()
          });
          toast("Article créé ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

function openItemDetail(item) {
  const daysLeft = estimateDaysLeft(item);
  const history = allMovements.filter(m => m.item_id === item.id).slice(0, 8);
  openModal(item.nom, `
    <div class="row"><div class="row-main"><span class="row-title">Quantité actuelle</span></div><span class="row-value">${item.quantite_actuelle} ${item.unite}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Coût unitaire moyen</span></div><span class="row-value">${formatFCFA(item.cout_unitaire_moyen)}</span></div>
    ${item.date_peremption ? `<div class="row"><div class="row-main"><span class="row-title">Péremption</span></div><span class="row-value">${formatDate(item.date_peremption)}</span></div>` : ""}
    ${daysLeft !== null ? `<div class="row"><div class="row-main"><span class="row-title">Autonomie estimée</span></div><span class="row-value">${daysLeft} jours</span></div>` : ""}
    <div class="spacer-m"></div>
    <div class="field-row">
      <button class="btn secondary small" id="fMovEntree" style="flex:1;">+ Entrée (achat)</button>
      <button class="btn secondary small" id="fMovSortie" style="flex:1;">− Sortie (usage)</button>
    </div>
    <div class="spacer-m"></div>
    <h3 style="font-size:13.5px; margin-bottom:6px;">Historique récent</h3>
    <div>${history.length ? history.map(m => `
      <div class="row"><div class="row-main"><span class="row-title">${m.type_mouvement === "entree" ? "Entrée" : "Sortie"} · ${m.motif || ""}</span><span class="row-sub">${formatDate(m.date)}${m.cree_par ? " · par " + escapeHtml(m.cree_par) : ""}</span></div><span class="row-value ${m.type_mouvement === "entree" ? "pos" : "neg"}">${m.type_mouvement === "entree" ? "+" : "−"}${m.quantite} ${item.unite}</span></div>
    `).join("") : `<p class="subtle">Aucun mouvement enregistré.</p>`}</div>
  `, {
    onMount: () => {
      document.getElementById("fMovEntree").addEventListener("click", () => openMovementModal(item, "entree"));
      document.getElementById("fMovSortie").addEventListener("click", () => openMovementModal(item, "sortie"));
    }
  });
}

function openMovementModal(item, type) {
  const isEntree = type === "entree";
  openModal(isEntree ? "Entrée de stock (achat)" : "Sortie de stock (usage)", `
    <div class="field"><label>Quantité (${item.unite})</label><input type="number" id="fMovQte" min="0" value="1"></div>
    <div class="field"><label>Date</label><input type="date" id="fMovDate" value="${todayInputValue()}"></div>
    ${isEntree ? `<div class="field"><label>Coût total (FCFA)</label><input type="number" id="fMovCout" min="0" value="0"></div>` : `
    <div class="field"><label>Motif</label>
      <select id="fMovMotif"><option value="alimentation">Alimentation</option><option value="traitement">Traitement vétérinaire</option><option value="perte">Perte / péremption</option></select>
    </div>`}
    ${isEntree ? `<div class="field" style="display:flex; align-items:center; gap:8px; flex-direction:row;"><input type="checkbox" id="fMovLinkFinance" style="width:auto;" checked><label style="margin:0;">Enregistrer aussi la dépense correspondante dans Finances</label></div>` : ""}
    <button class="btn yolk" id="fMovSave">Enregistrer le mouvement</button>
  `, {
    onMount: () => {
      document.getElementById("fMovSave").addEventListener("click", async () => {
        const qte = Number(document.getElementById("fMovQte").value) || 0;
        if (qte <= 0) { toast("Quantité invalide"); return; }
        const dateVal = new Date(document.getElementById("fMovDate").value);
        try {
          const movPayload = {
            item_id: item.id, type_mouvement: type, quantite: qte, date: dateVal,
            motif: isEntree ? "achat" : document.getElementById("fMovMotif").value,
            cout_total: isEntree ? (Number(document.getElementById("fMovCout").value) || 0) : null,
            lien_finance_id: null,
            cree_par: getUserName() || "Inconnu",
            createdAt: serverTimestamp()
          };

          if (isEntree && document.getElementById("fMovLinkFinance").checked) {
            const financeRef = await addDoc(collection(db, "finance_transactions"), {
              type: "depense",
              categorie: item.type === "aliment" ? "aliments" : "veterinaire",
              montant: movPayload.cout_total,
              date: dateVal,
              quantite: qte,
              prix_unitaire: qte ? Math.round(movPayload.cout_total / qte) : 0,
              description: `Achat stock : ${item.nom}`,
              cree_par: getUserName() || "Inconnu",
              createdAt: serverTimestamp()
            });
            movPayload.lien_finance_id = financeRef.id;
          }

          await addDoc(movCol, movPayload);
          await updateDoc(doc(db, "stock_items", item.id), {
            quantite_actuelle: increment(isEntree ? qte : -qte),
            ...(isEntree && movPayload.cout_total ? { cout_unitaire_moyen: Math.round(movPayload.cout_total / qte) } : {})
          });

          toast("Mouvement enregistré ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

// =====================================================================
// FORMULATIONS ALIMENTAIRES
// Calculateur de formule (ingrédients, quantités, prix, % du mélange)
// avec prix de revient au kg calculé automatiquement. Optionnellement,
// une formulation enregistrée peut aussi créer une dépense liée et/ou
// approvisionner un article de stock correspondant — toujours en case
// à cocher, jamais obligatoire (même principe que les mouvements de
// stock classiques).
// =====================================================================

function renderFormulationsList() {
  const el = document.getElementById("formulationsList");
  if (!el) return;
  if (!allFormulations.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">🧪</div><p>Aucune formulation enregistrée pour le moment.</p></div>`;
    return;
  }
  el.innerHTML = allFormulations.map(f => `
    <div class="row">
      <div class="row-main">
        <span class="row-title">${escapeHtml(f.nom)}</span>
        <span class="row-sub">${formatDate(f.date)} · ${(f.total_kg || 0).toFixed(1)} kg · ${(f.lignes || []).length} ingrédient(s)${f.cree_par ? " · par " + escapeHtml(f.cree_par) : ""}</span>
      </div>
      <span class="row-value">${formatFCFA(f.prix_revient_kg)} /kg</span>
    </div>
  `).join("");
  el.querySelectorAll(".row").forEach((rowEl, idx) => {
    rowEl.style.cursor = "pointer";
    rowEl.addEventListener("click", () => openFormulationDetail(allFormulations[idx]));
  });
}

let formRowCounter = 0;

function formulationRowHtml(idx) {
  return `
    <div class="row" style="border:none; padding:6px 0; align-items:flex-end; gap:6px;" data-row="${idx}">
      <div class="field" style="flex:2; margin-bottom:0;"><label style="font-size:11px;">${idx === 0 ? "Ingrédient" : ""}</label><input type="text" class="fLigneNom" placeholder="ex : Maïs concassé"></div>
      <div class="field" style="flex:1; margin-bottom:0;"><label style="font-size:11px;">${idx === 0 ? "FCFA/kg" : ""}</label><input type="number" class="fLignePu" min="0" value="0"></div>
      <div class="field" style="flex:1; margin-bottom:0;"><label style="font-size:11px;">${idx === 0 ? "Kg" : ""}</label><input type="number" class="fLigneQte" min="0" value="0"></div>
      <button class="btn danger small fLigneDel" type="button" style="margin-bottom:1px;">✕</button>
    </div>
    <div class="row-sub fLigneInfo" style="padding:0 0 6px; text-align:right;">—</div>
  `;
}

function openFormulationModal() {
  formRowCounter = 0;
  const body = `
    <div class="field"><label>Nom de la formulation</label><input type="text" id="fFormNom" placeholder="ex : Formule Croissance"></div>
    <div class="field"><label>Date</label><input type="date" id="fFormDate" value="${todayInputValue()}"></div>
    <div class="spacer-s"></div>
    <div id="fFormLignes"></div>
    <button class="btn secondary small" id="fFormAddLigne" type="button">+ Ajouter un ingrédient</button>
    <div class="spacer-m"></div>
    <div class="field"><label>Main d'œuvre (fabrication/mélange, FCFA)</label><input type="number" id="fFormMainOeuvre" min="0" value="0"></div>
    <div class="spacer-m"></div>
    <div class="card" style="background:var(--sage-100); border:none;">
      <div class="row"><div class="row-main"><span class="row-title">Total matières premières</span></div><span class="row-value" id="fFormTotalMatieres">0 FCFA</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Total kg</span></div><span class="row-value" id="fFormTotalKg">0 kg</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Total général</span></div><span class="row-value" id="fFormTotalGeneral">0 FCFA</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Prix de revient / kg</span></div><span class="row-value pos" id="fFormPrixKg">0 FCFA</span></div>
    </div>
    <div class="spacer-m"></div>
    <div class="field" style="display:flex; align-items:center; gap:8px; flex-direction:row;"><input type="checkbox" id="fFormLinkFinance" style="width:auto;" checked><label style="margin:0;">Enregistrer aussi la dépense correspondante dans Finances</label></div>
    <div class="field" style="display:flex; align-items:center; gap:8px; flex-direction:row;"><input type="checkbox" id="fFormLinkStock" style="width:auto;" checked><label style="margin:0;">Ajouter la quantité produite au stock d'aliments</label></div>
    <button class="btn yolk" id="fFormSave">Enregistrer la formulation</button>
  `;
  openModal("Nouvelle formulation", body, {
    onMount: () => {
      const lignesEl = document.getElementById("fFormLignes");
      const addRow = () => {
        const idx = formRowCounter++;
        const div = document.createElement("div");
        div.innerHTML = formulationRowHtml(idx);
        while (div.firstChild) lignesEl.appendChild(div.firstChild);
        recalcFormulation();
      };
      lignesEl.addEventListener("click", (e) => {
        if (e.target.classList.contains("fLigneDel")) {
          const row = e.target.closest("[data-row]");
          const info = row.nextElementSibling;
          row.remove();
          if (info && info.classList.contains("fLigneInfo")) info.remove();
          recalcFormulation();
        }
      });
      lignesEl.addEventListener("input", recalcFormulation);
      document.getElementById("fFormMainOeuvre").addEventListener("input", recalcFormulation);
      document.getElementById("fFormAddLigne").addEventListener("click", addRow);
      addRow(); addRow(); addRow();

      document.getElementById("fFormSave").addEventListener("click", async () => {
        const nom = document.getElementById("fFormNom").value.trim();
        if (!nom) { toast("Indiquez un nom pour cette formulation"); return; }
        const { lignes, totalMatieres, totalKg } = collectFormulationLignes();
        if (!lignes.length) { toast("Ajoutez au moins un ingrédient"); return; }
        const mainOeuvre = Number(document.getElementById("fFormMainOeuvre").value) || 0;
        const totalGeneral = totalMatieres + mainOeuvre;
        const prixRevientKg = totalKg ? totalGeneral / totalKg : 0;
        const dateVal = new Date(document.getElementById("fFormDate").value);

        try {
          await addDoc(formulationsCol, {
            nom, date: dateVal, lignes, main_oeuvre: mainOeuvre,
            total_matieres: totalMatieres, total_kg: totalKg,
            total_general: totalGeneral, prix_revient_kg: prixRevientKg,
            cree_par: getUserName() || "Inconnu", createdAt: serverTimestamp()
          });

          if (document.getElementById("fFormLinkFinance").checked) {
            await addDoc(collection(db, "finance_transactions"), {
              type: "depense", categorie: "aliments", montant: Math.round(totalGeneral),
              date: dateVal, description: `Formulation : ${nom} (${totalKg.toFixed(1)} kg)`,
              cree_par: getUserName() || "Inconnu", createdAt: serverTimestamp()
            });
          }

          if (document.getElementById("fFormLinkStock").checked) {
            const existing = allItems.find(i => i.nom.toLowerCase() === nom.toLowerCase());
            if (existing) {
              await addDoc(movCol, {
                item_id: existing.id, type_mouvement: "entree", quantite: totalKg, date: dateVal,
                motif: "formulation", cout_total: totalGeneral,
                cree_par: getUserName() || "Inconnu", createdAt: serverTimestamp()
              });
              await updateDoc(doc(db, "stock_items", existing.id), {
                quantite_actuelle: increment(totalKg),
                cout_unitaire_moyen: Math.round(prixRevientKg)
              });
            } else {
              const newItemRef = await addDoc(itemsCol, {
                nom, type: "aliment", unite: "kg", quantite_actuelle: totalKg,
                seuil_alerte: 0, cout_unitaire_moyen: Math.round(prixRevientKg),
                cree_par: getUserName() || "Inconnu", createdAt: serverTimestamp()
              });
              await addDoc(movCol, {
                item_id: newItemRef.id, type_mouvement: "entree", quantite: totalKg, date: dateVal,
                motif: "formulation", cout_total: totalGeneral,
                cree_par: getUserName() || "Inconnu", createdAt: serverTimestamp()
              });
            }
          }

          toast("Formulation enregistrée ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

function collectFormulationLignes() {
  const rows = document.querySelectorAll("#fFormLignes [data-row]");
  let totalMatieres = 0, totalKg = 0;
  const lignes = [];
  rows.forEach(row => {
    const nom = row.querySelector(".fLigneNom").value.trim();
    const pu = Number(row.querySelector(".fLignePu").value) || 0;
    const qte = Number(row.querySelector(".fLigneQte").value) || 0;
    if (!nom || qte <= 0) return;
    const cout = pu * qte;
    totalMatieres += cout;
    totalKg += qte;
    lignes.push({ ingredient: nom, prix_unitaire: pu, quantite_kg: qte, cout_total: cout });
  });
  return { lignes, totalMatieres, totalKg };
}

function recalcFormulation() {
  const { lignes, totalMatieres, totalKg } = collectFormulationLignes();
  document.querySelectorAll("#fFormLignes [data-row]").forEach((row, i) => {
    const pu = Number(row.querySelector(".fLignePu").value) || 0;
    const qte = Number(row.querySelector(".fLigneQte").value) || 0;
    const cout = pu * qte;
    const pct = totalKg ? (qte / totalKg) * 100 : 0;
    const info = row.nextElementSibling;
    if (info && info.classList.contains("fLigneInfo")) {
      info.textContent = qte > 0 ? `${formatFCFA(cout)} · ${pct.toFixed(1)}% du mélange` : "—";
    }
  });
  const mainOeuvre = Number(document.getElementById("fFormMainOeuvre")?.value) || 0;
  const totalGeneral = totalMatieres + mainOeuvre;
  const prixRevientKg = totalKg ? totalGeneral / totalKg : 0;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set("fFormTotalMatieres", formatFCFA(totalMatieres));
  set("fFormTotalKg", totalKg.toFixed(1) + " kg");
  set("fFormTotalGeneral", formatFCFA(totalGeneral));
  set("fFormPrixKg", formatFCFA(Math.round(prixRevientKg)));
}

function openFormulationDetail(f) {
  const body = `
    <div class="row"><div class="row-main"><span class="row-title">Date</span></div><span class="row-value">${formatDate(f.date)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Total kg</span></div><span class="row-value">${(f.total_kg || 0).toFixed(1)} kg</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Main d'œuvre</span></div><span class="row-value">${formatFCFA(f.main_oeuvre)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Total général</span></div><span class="row-value">${formatFCFA(f.total_general)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Prix de revient / kg</span></div><span class="row-value pos">${formatFCFA(Math.round(f.prix_revient_kg))}</span></div>
    <div class="spacer-m"></div>
    <h3 style="font-size:13.5px; margin-bottom:6px;">Ingrédients</h3>
    ${(f.lignes || []).map(l => `
      <div class="row">
        <div class="row-main"><span class="row-title">${escapeHtml(l.ingredient)}</span><span class="row-sub">${l.quantite_kg} kg × ${formatFCFA(l.prix_unitaire)}</span></div>
        <span class="row-value">${formatFCFA(l.cout_total)}</span>
      </div>
    `).join("")}
    <div class="spacer-m"></div>
    <button class="btn secondary" id="fFormPdf">📤 Exporter en PDF</button>
    <div class="spacer-s"></div>
    <button class="btn danger" id="fFormDelete">Supprimer cette formulation</button>
  `;
  openModal(f.nom, body, {
    onMount: () => {
      document.getElementById("fFormPdf").addEventListener("click", () => exporterFormulationPDF(f));
      document.getElementById("fFormDelete").addEventListener("click", async () => {
        if (!confirm("Supprimer définitivement cette formulation ?")) return;
        try {
          await deleteDoc(doc(db, "formulations", f.id));
          toast("Formulation supprimée");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

function exporterFormulationPDF(f) {
  if (typeof window.jspdf === "undefined") { toast("Bibliothèque PDF non chargée — vérifiez votre connexion"); return; }
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF();
  let y = 18;
  pdf.setFontSize(16); pdf.text("FACTURE DE FORMULATION ALIMENTAIRE", 14, y); y += 6;
  pdf.setFontSize(11); pdf.text(f.nom, 14, y); y += 10;
  pdf.setFontSize(10);
  pdf.text(`Date : ${formatDate(f.date)}`, 14, y);
  pdf.text(`Client : Olee Ferme`, 110, y); y += 10;

  pdf.setFontSize(9);
  pdf.text("Ingrédient", 14, y); pdf.text("PU", 90, y); pdf.text("Qté (kg)", 115, y); pdf.text("%", 145, y); pdf.text("Total", 165, y);
  y += 3; pdf.line(14, y, 196, y); y += 5;
  const totalKg = f.total_kg || 1;
  (f.lignes || []).forEach(l => {
    if (y > 270) { pdf.addPage(); y = 18; }
    const pct = (l.quantite_kg / totalKg) * 100;
    pdf.text(String(l.ingredient).slice(0, 30), 14, y);
    pdf.text(formatFCFA(l.prix_unitaire), 90, y);
    pdf.text(String(l.quantite_kg), 115, y);
    pdf.text(pct.toFixed(1) + "%", 145, y);
    pdf.text(formatFCFA(l.cout_total), 165, y);
    y += 6;
  });
  y += 4; pdf.line(14, y, 196, y); y += 8;
  pdf.setFontSize(10);
  pdf.text(`Total matières premières : ${formatFCFA(f.total_matieres)}`, 14, y); y += 6;
  pdf.text(`Main d'œuvre : ${formatFCFA(f.main_oeuvre)}`, 14, y); y += 6;
  pdf.setFontSize(12);
  pdf.text(`TOTAL GÉNÉRAL À PAYER : ${formatFCFA(f.total_general)}`, 14, y); y += 8;
  pdf.setFontSize(10);
  pdf.text(`Prix de revient moyen au kg : ${formatFCFA(Math.round(f.prix_revient_kg))} / kg`, 14, y);

  const fileName = `Formulation_${f.nom.replace(/\s+/g, "_")}.pdf`;
  pdf.save(fileName);
  toast("PDF généré ✓");
}
