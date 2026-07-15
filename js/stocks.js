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

let allItems = [];
let allMovements = [];
let filterType = "all";

export function initStocks() {
  onSnapshot(query(itemsCol, orderBy("nom")), (snap) => {
    allItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  }, err => console.error("Erreur lecture stocks :", err));

  onSnapshot(query(movCol, orderBy("date", "desc")), (snap) => {
    allMovements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  }, err => console.error("Erreur lecture mouvements :", err));

  document.querySelectorAll("#stockFilterType button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#stockFilterType button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filterType = btn.dataset.v;
      renderList();
    });
  });
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
