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
import { formatFCFA, formatFCFAPdf, formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName } from "./utils.js";

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

function formulationRowHtml(idx, prefill = null) {
  const nom = prefill ? escapeHtml(prefill.ingredient || "") : "";
  const pu = prefill ? Number(prefill.prix_unitaire) || 0 : 0;
  const qte = prefill ? Number(prefill.quantite_kg) || 0 : 0;
  return `
    <div class="row" style="border:none; padding:6px 0; align-items:flex-end; gap:6px;" data-row="${idx}">
      <div class="field" style="flex:2; margin-bottom:0;"><label style="font-size:11px;">${idx === 0 ? "Ingrédient" : ""}</label><input type="text" class="fLigneNom" placeholder="ex : Maïs concassé" value="${nom}"></div>
      <div class="field" style="flex:1; margin-bottom:0;"><label style="font-size:11px;">${idx === 0 ? "FCFA/kg" : ""}</label><input type="number" class="fLignePu" min="0" value="${pu}"></div>
      <div class="field" style="flex:1; margin-bottom:0;"><label style="font-size:11px;">${idx === 0 ? "Kg" : ""}</label><input type="number" class="fLigneQte" min="0" value="${qte}"></div>
      <button class="btn danger small fLigneDel" type="button" style="margin-bottom:1px;">✕</button>
    </div>
    <div class="row-sub fLigneInfo" style="padding:0 0 6px; text-align:right;">—</div>
  `;
}

function dateToInputValue(d) {
  const date = d?.toDate ? d.toDate() : new Date(d);
  const off = date.getTimezoneOffset();
  return new Date(date.getTime() - off * 60000).toISOString().slice(0, 10);
}

// mode: "new" (par défaut), "edit" (modifie le document existant, ne
// touche jamais aux dépenses/mouvements de stock déjà créés lors de
// l'enregistrement initial) ou "duplicate" (préremplit un nouveau
// formulaire à partir d'une formulation existante, sans écraser celle-ci).
function openFormulationModal(existing = null, mode = "new") {
  formRowCounter = 0;
  const isEdit = mode === "edit";
  const isDuplicate = mode === "duplicate";
  const titre = isEdit ? "Modifier la formulation" : isDuplicate ? "Dupliquer la formulation" : "Nouvelle formulation";
  const nomDefaut = isDuplicate ? `${existing.nom} (copie)` : (existing ? existing.nom : "");
  const dateDefaut = existing && isEdit ? dateToInputValue(existing.date) : todayInputValue();
  const mainOeuvreDefaut = existing ? Number(existing.main_oeuvre) || 0 : 0;

  const optionsHtml = isEdit ? `
    <div class="card" style="background:var(--sage-100); border:none;">
      <p class="subtle" style="margin:0;">ℹ️ Modifier une formulation ne recrée pas la dépense ni le mouvement de stock déjà enregistrés lors de sa création initiale.</p>
    </div>
  ` : `
    <div class="field" style="display:flex; align-items:center; gap:8px; flex-direction:row;"><input type="checkbox" id="fFormLinkFinance" style="width:auto;" checked><label style="margin:0;">Enregistrer aussi la dépense correspondante dans Finances</label></div>
    <div class="field" style="display:flex; align-items:center; gap:8px; flex-direction:row;"><input type="checkbox" id="fFormLinkStock" style="width:auto;" checked><label style="margin:0;">Ajouter la quantité produite au stock d'aliments</label></div>
  `;

  const body = `
    <div class="field"><label>Nom de la formulation</label><input type="text" id="fFormNom" placeholder="ex : Formule Croissance" value="${escapeHtml(nomDefaut)}"></div>
    <div class="field"><label>Date</label><input type="date" id="fFormDate" value="${dateDefaut}"></div>
    <div class="spacer-s"></div>
    <div id="fFormLignes"></div>
    <button class="btn secondary small" id="fFormAddLigne" type="button">+ Ajouter un ingrédient</button>
    <div class="spacer-m"></div>
    <div class="field"><label>Main d'œuvre (fabrication/mélange, FCFA)</label><input type="number" id="fFormMainOeuvre" min="0" value="${mainOeuvreDefaut}"></div>
    <div class="spacer-m"></div>
    <div class="card" style="background:var(--sage-100); border:none;">
      <div class="row"><div class="row-main"><span class="row-title">Total matières premières</span></div><span class="row-value" id="fFormTotalMatieres">0 FCFA</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Total kg</span></div><span class="row-value" id="fFormTotalKg">0 kg</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Total général</span></div><span class="row-value" id="fFormTotalGeneral">0 FCFA</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Prix de revient / kg</span></div><span class="row-value pos" id="fFormPrixKg">0 FCFA</span></div>
    </div>
    <div class="spacer-m"></div>
    ${optionsHtml}
    <button class="btn yolk" id="fFormSave">${isEdit ? "Enregistrer les modifications" : "Enregistrer la formulation"}</button>
  `;
  openModal(titre, body, {
    onMount: () => {
      const lignesEl = document.getElementById("fFormLignes");
      const addRow = (prefill = null) => {
        const idx = formRowCounter++;
        const div = document.createElement("div");
        div.innerHTML = formulationRowHtml(idx, prefill);
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
      document.getElementById("fFormAddLigne").addEventListener("click", () => addRow());

      if (existing && (existing.lignes || []).length) {
        existing.lignes.forEach(l => addRow(l));
      } else {
        addRow(); addRow(); addRow();
      }
      recalcFormulation();

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
          if (isEdit) {
            await updateDoc(doc(db, "formulations", existing.id), {
              nom, date: dateVal, lignes, main_oeuvre: mainOeuvre,
              total_matieres: totalMatieres, total_kg: totalKg,
              total_general: totalGeneral, prix_revient_kg: prixRevientKg,
              modifie_par: getUserName() || "Inconnu", modifie_le: serverTimestamp()
            });
            toast("Formulation modifiée ✓");
            closeModal();
            return;
          }

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
            const existingItem = allItems.find(i => i.nom.toLowerCase() === nom.toLowerCase());
            if (existingItem) {
              await addDoc(movCol, {
                item_id: existingItem.id, type_mouvement: "entree", quantite: totalKg, date: dateVal,
                motif: "formulation", cout_total: totalGeneral,
                cree_par: getUserName() || "Inconnu", createdAt: serverTimestamp()
              });
              await updateDoc(doc(db, "stock_items", existingItem.id), {
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
  const totalKg = f.total_kg || 0;
  const body = `
    <div class="row"><div class="row-main"><span class="row-title">Date</span></div><span class="row-value">${formatDate(f.date)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Total kg</span></div><span class="row-value">${totalKg.toFixed(1)} kg</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Main d'œuvre</span></div><span class="row-value">${formatFCFA(f.main_oeuvre)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Total général</span></div><span class="row-value">${formatFCFA(f.total_general)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Prix de revient / kg</span></div><span class="row-value pos">${formatFCFA(Math.round(f.prix_revient_kg))}</span></div>
    <div class="spacer-m"></div>
    <h3 style="font-size:13.5px; margin-bottom:6px;">Ingrédients</h3>
    ${(f.lignes || []).map(l => {
      const pct = totalKg ? (Number(l.quantite_kg) / totalKg) * 100 : 0;
      return `
      <div class="row">
        <div class="row-main"><span class="row-title">${escapeHtml(l.ingredient)}</span><span class="row-sub">${l.quantite_kg} kg × ${formatFCFA(l.prix_unitaire)} · ${pct.toFixed(1)}% du mélange</span></div>
        <span class="row-value">${formatFCFA(l.cout_total)}</span>
      </div>`;
    }).join("")}
    <div class="row" style="border-top:2px solid var(--line); margin-top:2px; padding-top:12px;">
      <div class="row-main"><span class="row-title">Total (${totalKg.toFixed(1)} kg · 100%)</span></div>
      <span class="row-value" style="font-weight:700;">${formatFCFA(f.total_matieres)}</span>
    </div>
    <div class="spacer-m"></div>
    <button class="btn secondary" id="fFormPdf">📤 Exporter en PDF</button>
    <div class="spacer-s"></div>
    <button class="btn secondary" id="fFormEdit">✏️ Modifier</button>
    <div class="spacer-s"></div>
    <button class="btn secondary" id="fFormDuplicate">📄 Dupliquer</button>
    <div class="spacer-s"></div>
    <button class="btn danger" id="fFormDelete">Supprimer cette formulation</button>
  `;
  openModal(f.nom, body, {
    onMount: () => {
      document.getElementById("fFormPdf").addEventListener("click", () => exporterFormulationPDF(f));
      document.getElementById("fFormEdit").addEventListener("click", () => openFormulationModal(f, "edit"));
      document.getElementById("fFormDuplicate").addEventListener("click", () => openFormulationModal(f, "duplicate"));
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

  // Palette identique à celle de l'application (voir css/style.css)
  const pond950 = [14, 46, 44];
  const yolk500 = [232, 169, 58];
  const sage100 = [234, 240, 230];
  const ink900 = [19, 35, 32];
  const inkMuted = [107, 122, 117];
  const line = [216, 226, 217];

  const fcfa = formatFCFAPdf;
  const pageW = 210, marginX = 14;
  const contentW = pageW - marginX * 2;
  const rightEdge = marginX + contentW;
  const totalKg = f.total_kg || 1;

  // Colonnes du tableau (bords droits de chaque colonne numérique)
  const colIng = marginX + 2;
  const colPuEnd = marginX + 112;
  const colQteEnd = marginX + 138;
  const colPctEnd = marginX + 160;

  // ---------- En-tête ----------
  pdf.setFillColor(...pond950);
  pdf.rect(0, 0, pageW, 34, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8.5);
  pdf.text("OLEE DUCKS", marginX, 11);
  pdf.setFontSize(17);
  pdf.text("Facture de formulation alimentaire", marginX, 21);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(11);
  pdf.text(f.nom, marginX, 29);

  // ---------- Bloc informations ----------
  let y = 44;
  pdf.setFontSize(9.5);
  const labelX1 = marginX, valX1 = marginX + 26;
  const labelX2 = marginX + contentW / 2, valX2 = labelX2 + 26;

  pdf.setFont("helvetica", "bold"); pdf.setTextColor(...inkMuted); pdf.text("DATE", labelX1, y);
  pdf.setFont("helvetica", "normal"); pdf.setTextColor(...ink900); pdf.text(formatDate(f.date), valX1, y);
  pdf.setFont("helvetica", "bold"); pdf.setTextColor(...inkMuted); pdf.text("CLIENT", labelX2, y);
  pdf.setFont("helvetica", "normal"); pdf.setTextColor(...ink900); pdf.text("Olee Ferme", valX2, y);
  y += 7;
  pdf.setFont("helvetica", "bold"); pdf.setTextColor(...inkMuted); pdf.text("RÉFÉRENCE", labelX1, y);
  pdf.setFont("helvetica", "normal"); pdf.setTextColor(...ink900); pdf.text(f.nom, valX1, y);
  pdf.setFont("helvetica", "bold"); pdf.setTextColor(...inkMuted); pdf.text("POIDS TOTAL", labelX2, y);
  pdf.setFont("helvetica", "normal"); pdf.setTextColor(...ink900); pdf.text(`${totalKg.toFixed(1)} kg`, valX2, y);
  y += 9;
  pdf.setDrawColor(...line);
  pdf.line(marginX, y, rightEdge, y);
  y += 8;

  // ---------- Tableau des ingrédients ----------
  const rowH = 8;
  const drawTableHeader = () => {
    pdf.setFillColor(...pond950);
    pdf.rect(marginX, y, contentW, 9, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(8.5);
    pdf.text("INGRÉDIENT", colIng, y + 6);
    pdf.text("PU/KG", colPuEnd, y + 6, { align: "right" });
    pdf.text("QTÉ (KG)", colQteEnd, y + 6, { align: "right" });
    pdf.text("PART", colPctEnd, y + 6, { align: "right" });
    pdf.text("TOTAL", rightEdge - 2, y + 6, { align: "right" });
    y += 9;
  };
  drawTableHeader();

  pdf.setFont("helvetica", "normal"); pdf.setFontSize(9);
  (f.lignes || []).forEach((l, i) => {
    if (y > 262) { pdf.addPage(); y = 18; drawTableHeader(); pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); }
    if (i % 2 === 1) { pdf.setFillColor(...sage100); pdf.rect(marginX, y, contentW, rowH, "F"); }
    const pct = (Number(l.quantite_kg) / totalKg) * 100;
    pdf.setTextColor(...ink900);
    pdf.text(String(l.ingredient).slice(0, 32), colIng, y + 5.5);
    pdf.text(fcfa(l.prix_unitaire), colPuEnd, y + 5.5, { align: "right" });
    pdf.text(String(l.quantite_kg), colQteEnd, y + 5.5, { align: "right" });
    pdf.text(pct.toFixed(1) + "%", colPctEnd, y + 5.5, { align: "right" });
    pdf.text(fcfa(l.cout_total), rightEdge - 2, y + 5.5, { align: "right" });
    y += rowH;
  });

  // Ligne total matières premières (mise en avant)
  pdf.setFillColor(...sage100);
  pdf.rect(marginX, y, contentW, rowH + 1, "F");
  pdf.setDrawColor(...pond950);
  pdf.setLineWidth(0.4);
  pdf.line(marginX, y, rightEdge, y);
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(9); pdf.setTextColor(...pond950);
  pdf.text("TOTAL MATIÈRES PREMIÈRES", colIng, y + 6);
  pdf.text(`${totalKg.toFixed(1)} kg`, colQteEnd, y + 6, { align: "right" });
  pdf.text("100%", colPctEnd, y + 6, { align: "right" });
  pdf.text(fcfa(f.total_matieres), rightEdge - 2, y + 6, { align: "right" });
  y += rowH + 14;

  if (y > 250) { pdf.addPage(); y = 20; }

  // ---------- Récapitulatif des coûts ----------
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(...ink900);
  pdf.text("Total matières premières", marginX, y);
  pdf.text(fcfa(f.total_matieres), rightEdge - 2, y, { align: "right" });
  y += 7;
  pdf.text("Main d'œuvre (fabrication & mélange)", marginX, y);
  pdf.text(fcfa(f.main_oeuvre), rightEdge - 2, y, { align: "right" });
  y += 9;

  // Bandeau total général
  pdf.setFillColor(...pond950);
  pdf.rect(marginX, y, contentW, 13, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(11.5);
  pdf.text("TOTAL GÉNÉRAL À PAYER", marginX + 4, y + 8.5);
  pdf.text(fcfa(f.total_general), rightEdge - 4, y + 8.5, { align: "right" });
  y += 13 + 6;

  // Bandeau prix de revient (accent doré)
  pdf.setFillColor(...yolk500);
  pdf.rect(marginX, y, contentW, 12, "F");
  pdf.setTextColor(...pond950);
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(10.5);
  pdf.text("PRIX DE REVIENT MOYEN AU KILO", marginX + 4, y + 8);
  pdf.text(`${fcfa(Math.round(f.prix_revient_kg))} / kg`, rightEdge - 4, y + 8, { align: "right" });
  y += 22;

  // ---------- Pied de page ----------
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor(...inkMuted);
  const genereLe = `Généré par Olee Ducks le ${new Date().toLocaleDateString("fr-FR")}${f.cree_par ? " · Enregistré par " + f.cree_par : ""}`;
  pdf.text(genereLe, marginX, 287);

  const fileName = `Formulation_${f.nom.replace(/\s+/g, "_")}.pdf`;
  pdf.save(fileName);
  toast("PDF généré ✓");
}
