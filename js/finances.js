// =====================================================================
// MODULE : FINANCES
// Collection Firestore "finance_transactions".
// Indépendant de la collection "stock_mouvements" : un achat d'aliments
// crée éventuellement une dépense ici ET un mouvement de stock, mais les
// deux collections restent autonomes (voir stocks.js) pour ne jamais se
// bloquer mutuellement.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, addDoc, deleteDoc, doc, onSnapshot,
  serverTimestamp, orderBy, query
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatFCFA, formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName } from "./utils.js";

const finCol = collection(db, "finance_transactions");
let allTx = [];
let filterPeriode = "30";
let filterType = "all";

const CATS_RECETTE = { vente_canards: "Vente de canards", vente_oeufs: "Vente d'œufs", vente_canetons: "Vente de canetons", autre: "Autre recette" };
const CATS_DEPENSE = { salaire: "Salaire du fermier", eau: "Facture d'eau", electricite: "Facture d'électricité", materiel: "Achat de matériel", aliments: "Achat d'aliments", veterinaire: "Produits vétérinaires", autre: "Autre dépense" };

export function initFinances() {
  onSnapshot(query(finCol, orderBy("date", "desc")), (snap) => {
    allTx = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAll();
  }, err => console.error("Erreur lecture finances :", err));

  document.querySelectorAll("#finFilterPeriode button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#finFilterPeriode button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filterPeriode = btn.dataset.v;
      renderAll();
    });
  });
  document.querySelectorAll("#finFilterType button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#finFilterType button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filterType = btn.dataset.v;
      renderAll();
    });
  });
}

function filteredTx() {
  let items = allTx;
  if (filterPeriode !== "all") {
    const days = Number(filterPeriode);
    const cutoff = Date.now() - days * 86400000;
    items = items.filter(t => {
      const d = t.date?.toDate ? t.date.toDate() : new Date(t.date);
      return d.getTime() >= cutoff;
    });
  }
  if (filterType !== "all") items = items.filter(t => t.type === filterType);
  return items;
}

function renderAll() {
  const items = filteredTx();
  const recettes = items.filter(t => t.type === "recette").reduce((a, t) => a + Number(t.montant || 0), 0);
  const depenses = items.filter(t => t.type === "depense").reduce((a, t) => a + Number(t.montant || 0), 0);
  const balance = recettes - depenses;

  setText("finBalance", formatFCFA(balance));
  document.getElementById("finBalance")?.classList.toggle("negative", balance < 0);
  setText("finRecettes", formatFCFA(recettes));
  setText("finDepenses", formatFCFA(depenses));

  // Dashboard (toujours en vision globale, indépendante des filtres de la page Finances)
  const allRecettes = allTx.filter(t => t.type === "recette").reduce((a, t) => a + Number(t.montant || 0), 0);
  const allDepenses = allTx.filter(t => t.type === "depense").reduce((a, t) => a + Number(t.montant || 0), 0);
  const allBalance = allRecettes - allDepenses;
  setText("kpiBalance", formatFCFA(allBalance));
  document.getElementById("kpiBalance")?.classList.toggle("negative", allBalance < 0);
  setText("kpiRecettes", formatFCFA(allRecettes));
  setText("kpiDepenses", formatFCFA(allDepenses));

  const listEl = document.getElementById("finList");
  if (listEl) {
    if (!items.length) {
      listEl.innerHTML = `<div class="empty-state"><div class="glyph">💰</div><p>Aucune transaction sur cette période.</p></div>`;
    } else {
      listEl.innerHTML = items.map(t => `
        <div class="row">
          <div class="row-main">
            <span class="row-title">${(t.type === "recette" ? CATS_RECETTE : CATS_DEPENSE)[t.categorie] || t.categorie}</span>
            <span class="row-sub">${formatDate(t.date)}${t.description ? " · " + escapeHtml(t.description) : ""}${t.cree_par ? " · par " + escapeHtml(t.cree_par) : ""}</span>
          </div>
          <span class="row-value ${t.type === "recette" ? "pos" : "neg"}">${t.type === "recette" ? "+" : "−"}${formatFCFA(t.montant)}</span>
        </div>
      `).join("");
      listEl.querySelectorAll(".row").forEach((rowEl, idx) => {
        rowEl.style.cursor = "pointer";
        rowEl.addEventListener("click", () => openTxDetail(items[idx]));
      });
    }
  }

  const activityEl = document.getElementById("dashRecentActivity");
  if (activityEl) {
    const recent = allTx.slice(0, 4);
    activityEl.innerHTML = recent.length ? recent.map(t => `
      <div class="row">
        <div class="row-main"><span class="row-title">${(t.type === "recette" ? CATS_RECETTE : CATS_DEPENSE)[t.categorie] || t.categorie}</span><span class="row-sub">${formatDate(t.date)}</span></div>
        <span class="row-value ${t.type === "recette" ? "pos" : "neg"}">${t.type === "recette" ? "+" : "−"}${formatFCFA(t.montant)}</span>
      </div>`).join("") : `<div class="empty-state"><div class="glyph">📋</div><p>Aucune activité récente.</p></div>`;
  }
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

export function openAddFinanceModal(defaultType = "recette") {
  const body = `
    <div class="segmented" id="fTxType">
      <button data-v="recette" class="${defaultType === 'recette' ? 'active' : ''}">Recette</button>
      <button data-v="depense" class="${defaultType === 'depense' ? 'active' : ''}">Dépense</button>
    </div>
    <div class="spacer-m"></div>
    <div class="field">
      <label>Catégorie</label>
      <select id="fTxCat"></select>
    </div>
    <div class="field-row">
      <div class="field"><label>Montant (FCFA)</label><input type="number" id="fTxMontant" min="0" placeholder="0"></div>
      <div class="field"><label>Date</label><input type="date" id="fTxDate" value="${todayInputValue()}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Quantité (optionnel)</label><input type="number" id="fTxQte" min="0" placeholder="—"></div>
      <div class="field"><label>Prix unitaire (optionnel)</label><input type="number" id="fTxPu" min="0" placeholder="—"></div>
    </div>
    <div class="field"><label>Description</label><input type="text" id="fTxDesc" placeholder="Détails, acheteur/fournisseur…"></div>
    <button class="btn yolk" id="fTxSave">Enregistrer</button>
  `;
  openModal("Nouvelle transaction", body, {
    onMount: () => {
      let currentType = defaultType;
      const catSel = document.getElementById("fTxCat");
      const fillCats = () => {
        const cats = currentType === "recette" ? CATS_RECETTE : CATS_DEPENSE;
        catSel.innerHTML = Object.entries(cats).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
      };
      fillCats();
      document.querySelectorAll("#fTxType button").forEach(btn => {
        btn.addEventListener("click", () => {
          document.querySelectorAll("#fTxType button").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          currentType = btn.dataset.v;
          fillCats();
        });
      });

      const qteEl = document.getElementById("fTxQte");
      const puEl = document.getElementById("fTxPu");
      const montantEl = document.getElementById("fTxMontant");
      const recalc = () => {
        const q = Number(qteEl.value), pu = Number(puEl.value);
        if (q > 0 && pu > 0) montantEl.value = q * pu;
      };
      qteEl.addEventListener("input", recalc);
      puEl.addEventListener("input", recalc);

      document.getElementById("fTxSave").addEventListener("click", async () => {
        const montant = Number(montantEl.value);
        if (!montant || montant <= 0) { toast("Indiquez un montant valide"); return; }
        try {
          await addDoc(finCol, {
            type: currentType,
            categorie: catSel.value,
            montant,
            date: new Date(document.getElementById("fTxDate").value),
            quantite: Number(qteEl.value) || null,
            prix_unitaire: Number(puEl.value) || null,
            description: document.getElementById("fTxDesc").value.trim() || null,
            cree_par: getUserName() || "Inconnu",
            createdAt: serverTimestamp()
          });
          toast("Transaction enregistrée ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

function openTxDetail(t) {
  const cats = t.type === "recette" ? CATS_RECETTE : CATS_DEPENSE;
  openModal(cats[t.categorie] || t.categorie, `
    <div class="row"><div class="row-main"><span class="row-title">Montant</span></div><span class="row-value ${t.type === 'recette' ? 'pos' : 'neg'}">${formatFCFA(t.montant)}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Date</span></div><span class="row-value">${formatDate(t.date)}</span></div>
    ${t.cree_par ? `<div class="row"><div class="row-main"><span class="row-title">Enregistré par</span></div><span class="row-value">${escapeHtml(t.cree_par)}</span></div>` : ""}
    ${t.quantite ? `<div class="row"><div class="row-main"><span class="row-title">Quantité</span></div><span class="row-value">${t.quantite}</span></div>` : ""}
    ${t.prix_unitaire ? `<div class="row"><div class="row-main"><span class="row-title">Prix unitaire</span></div><span class="row-value">${formatFCFA(t.prix_unitaire)}</span></div>` : ""}
    ${t.description ? `<p class="subtle" style="margin-top:10px;">${escapeHtml(t.description)}</p>` : ""}
    <div class="spacer-m"></div>
    <button class="btn danger" id="fTxDelete">Supprimer cette transaction</button>
  `, {
    onMount: () => {
      document.getElementById("fTxDelete").addEventListener("click", async () => {
        if (!confirm("Supprimer définitivement cette transaction ?")) return;
        try {
          await deleteDoc(doc(db, "finance_transactions", t.id));
          toast("Transaction supprimée");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}
