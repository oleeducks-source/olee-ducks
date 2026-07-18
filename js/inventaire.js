// =====================================================================
// MODULE : INVENTAIRE DES CANARDS
// Collection Firestore "ducks" — chaque doc peut représenter un lot
// (ex: 12 canetons nés le même jour) ou un individu bagué.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot,
  serverTimestamp, orderBy, query
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName } from "./utils.js";

const ducksCol = collection(db, "ducks");
let allDucks = [];
let filterType = "all";
let filterStatut = "actif";

const TYPE_LABELS = {
  caneton: "Caneton",
  canard: "Canard",
  reproducteur_male: "Reproducteur mâle",
  reproducteur_femelle: "Reproductrice femelle"
};
const BAGUE_LABELS = { rouge: "Rouge", vert: "Vert", violet: "Violet", bleu: "Bleu" };
const STATUT_LABELS = { actif: "Actif", vendu: "Vendu", mort: "Décédé", reforme: "Réformé" };

export function initInventaire() {
  onSnapshot(query(ducksCol, orderBy("createdAt", "desc")), (snap) => {
    allDucks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderKpis();
    renderList();
  }, (err) => console.error("Erreur lecture inventaire :", err));

  document.querySelectorAll("#invFilterType button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#invFilterType button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filterType = btn.dataset.v;
      renderList();
    });
  });
  document.querySelectorAll("#invFilterStatut button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#invFilterStatut button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filterStatut = btn.dataset.v;
      renderList();
    });
  });
}

function activeDucks() {
  return allDucks.filter(d => d.statut === "actif");
}

function renderKpis() {
  const actifs = activeDucks();
  const sum = (t) => actifs.filter(d => d.type === t).reduce((a, d) => a + (Number(d.quantite) || 1), 0);
  const bagues = { rouge: 0, vert: 0, violet: 0, bleu: 0 };
  actifs.forEach(d => { if (d.bague_couleur && bagues[d.bague_couleur] !== undefined) bagues[d.bague_couleur] += (Number(d.quantite) || 1); });

  const el = document.getElementById("invKpis");
  if (!el) return;
  el.innerHTML = `
    <div class="kpi"><div class="kpi-label">Canetons</div><div class="kpi-value">${sum("caneton")}</div></div>
    <div class="kpi"><div class="kpi-label">Canards</div><div class="kpi-value">${sum("canard")}</div></div>
    <div class="kpi alt"><div class="kpi-label">Reprod. mâles</div><div class="kpi-value">${sum("reproducteur_male")}</div></div>
    <div class="kpi alt"><div class="kpi-label">Reprod. femelles</div><div class="kpi-value">${sum("reproducteur_femelle")}</div></div>
    <div class="kpi yolk"><div class="kpi-label">Total actif</div><div class="kpi-value">${actifs.reduce((a, d) => a + (Number(d.quantite) || 1), 0)}</div></div>
  `;
  const totalEl = document.getElementById("kpiTotalCanards");
  const subEl = document.getElementById("kpiCanardsSub");
  if (totalEl) totalEl.textContent = actifs.reduce((a, d) => a + (Number(d.quantite) || 1), 0);
  if (subEl) subEl.textContent = `${sum("reproducteur_male") + sum("reproducteur_femelle")} reproducteurs · ${sum("canard")} canards · ${sum("caneton")} canetons`;

  const dashEl = document.getElementById("dashInventaireBreakdown");
  if (dashEl) {
    const total = actifs.reduce((a, d) => a + (Number(d.quantite) || 1), 0) || 1;
    dashEl.innerHTML = ["rouge", "vert", "violet", "bleu"].map(c => `
      <div class="row">
        <div class="row-main"><span class="row-title">Bague ${BAGUE_LABELS[c]}</span></div>
        <div style="flex:1; margin:0 12px;" class="stat-bar-track"><div class="stat-bar-fill" style="width:${Math.min(100, (bagues[c] / total) * 100)}%; background:var(--pond-600)"></div></div>
        <div class="row-value">${bagues[c]}</div>
      </div>`).join("");
  }
}

function renderList() {
  const el = document.getElementById("invList");
  if (!el) return;
  let items = allDucks;
  if (filterType !== "all") items = items.filter(d => d.type === filterType);
  if (filterStatut !== "all") items = items.filter(d => d.statut === filterStatut);

  if (!items.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">🦆</div><p>Aucun enregistrement pour ce filtre.</p></div>`;
    return;
  }
  el.innerHTML = items.map(d => `
    <div class="row">
      <div class="row-main">
        <span class="row-title">${TYPE_LABELS[d.type] || d.type} ${d.quantite > 1 ? `× ${d.quantite}` : ""}</span>
        <span class="row-sub">${d.numero_bague ? "N° " + escapeHtml(d.numero_bague) + " · " : ""}${d.bague_couleur ? "Bague " + BAGUE_LABELS[d.bague_couleur] : "Sans bague"} · entrée ${formatDate(d.date_entree)}${d.cree_par ? " · par " + escapeHtml(d.cree_par) : ""}</span>
      </div>
      <span class="tag ${d.statut === 'actif' ? 'ok' : d.statut === 'mort' ? 'danger' : 'warn'}">${STATUT_LABELS[d.statut] || d.statut}</span>
    </div>
  `).join("");

  el.querySelectorAll(".row").forEach((rowEl, idx) => {
    rowEl.style.cursor = "pointer";
    rowEl.addEventListener("click", () => openEditModal(items[idx]));
  });
}

export function openAddDuckModal() {
  const body = `
    <div class="field">
      <label>Type</label>
      <select id="fDuckType">
        <option value="caneton">Caneton</option>
        <option value="canard">Canard</option>
        <option value="reproducteur_male">Reproducteur mâle</option>
        <option value="reproducteur_femelle">Reproductrice femelle</option>
      </select>
    </div>
    <div class="field-row">
      <div class="field"><label>Quantité (lot)</label><input type="number" id="fDuckQte" value="1" min="1"></div>
      <div class="field"><label>Date d'entrée</label><input type="date" id="fDuckDate" value="${todayInputValue()}"></div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Couleur de bague</label>
        <select id="fDuckBague">
          <option value="">Aucune</option>
          <option value="rouge">Rouge</option>
          <option value="vert">Vert</option>
          <option value="violet">Violet</option>
          <option value="bleu">Bleu</option>
        </select>
      </div>
      <div class="field"><label>N° de bague</label><input type="text" id="fDuckNum" placeholder="ex: R-014"></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="fDuckNotes" rows="2" placeholder="Origine, race, remarques…"></textarea></div>
    <button class="btn yolk" id="fDuckSave">Enregistrer</button>
  `;
  openModal("Ajouter au cheptel", body, {
    onMount: () => {
      document.getElementById("fDuckSave").addEventListener("click", async () => {
        const payload = {
          type: document.getElementById("fDuckType").value,
          quantite: Number(document.getElementById("fDuckQte").value) || 1,
          date_entree: new Date(document.getElementById("fDuckDate").value),
          bague_couleur: document.getElementById("fDuckBague").value || null,
          numero_bague: document.getElementById("fDuckNum").value.trim() || null,
          notes: document.getElementById("fDuckNotes").value.trim() || null,
          statut: "actif",
          date_sortie: null,
          motif_sortie: null,
          cree_par: getUserName() || "Inconnu",
          createdAt: serverTimestamp()
        };
        try {
          await addDoc(ducksCol, payload);
          toast("Ajouté à l'inventaire ✓");
          closeModal();
        } catch (e) {
          console.error(e);
          toast("Erreur : " + e.message);
        }
      });
    }
  });
}

function openEditModal(d) {
  const isActif = d.statut === "actif";
  const isCaneton = d.type === "caneton";
  const body = `
    <div class="row"><div class="row-main"><span class="row-title">Quantité actuelle</span></div><span class="row-value">${d.quantite || 1}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Statut</span></div><span class="tag ${d.statut === 'actif' ? 'ok' : d.statut === 'mort' ? 'danger' : 'warn'}">${STATUT_LABELS[d.statut] || d.statut}</span></div>

    ${isActif && isCaneton && (d.quantite || 1) > 0 ? `
    <div class="spacer-m"></div>
    <div class="card" style="background:#FCEBD9; border:none;">
      <h3 style="font-size:14px; margin-bottom:2px;">Requalifier en canard</h3>
      <p class="subtle" style="margin:0 0 10px;">Les canetons devenus adultes basculent dans le lot des canards, avec traçabilité (date, par qui).</p>
      <div class="field"><label>Quantité devenue adulte</label><input type="number" id="fRequalQte" min="1" max="${d.quantite || 1}" value="${d.quantite || 1}"></div>
      <button class="btn yolk" id="fRequalSave">Requalifier</button>
    </div>
    ` : ""}

    ${isActif && (d.quantite || 1) > 0 ? `
    <div class="spacer-m"></div>
    <div class="card" style="background:var(--sage-100); border:none;">
      <h3 style="font-size:14px; margin-bottom:2px;">Retirer du cheptel</h3>
      <p class="subtle" style="margin:0 0 10px;">Vente, décès ou réforme d'une partie ou de la totalité de ce lot. Le reste actif n'est pas affecté.</p>
      <div class="field-row">
        <div class="field"><label>Quantité à retirer</label><input type="number" id="fWithdrawQte" min="1" max="${d.quantite || 1}" value="1"></div>
        <div class="field"><label>Motif</label>
          <select id="fWithdrawMotif">
            <option value="vendu">Vendu</option>
            <option value="mort">Décédé</option>
            <option value="reforme">Réformé</option>
          </select>
        </div>
      </div>
      <div class="field"><label>Note (optionnel)</label><input type="text" id="fWithdrawNote" placeholder="ex : vendu au marché de Bingerville"></div>
      <button class="btn yolk" id="fWithdrawSave">Enregistrer le retrait</button>
    </div>
    ` : ""}

    <div class="spacer-m"></div>
    <h3 style="font-size:14px; margin-bottom:8px;">Corriger cet enregistrement</h3>
    <div class="field">
      <label>Statut de l'ensemble du lot</label>
      <select id="eDuckStatut">
        <option value="actif" ${d.statut === "actif" ? "selected" : ""}>Actif</option>
        <option value="vendu" ${d.statut === "vendu" ? "selected" : ""}>Vendu</option>
        <option value="mort" ${d.statut === "mort" ? "selected" : ""}>Décédé</option>
        <option value="reforme" ${d.statut === "reforme" ? "selected" : ""}>Réformé</option>
      </select>
    </div>
    <div class="field"><label>Corriger la quantité (erreur de saisie uniquement)</label><input type="number" id="eDuckQte" value="${d.quantite || 1}" min="1"></div>
    <div class="field"><label>Motif de sortie (si vendu/décédé)</label><input type="text" id="eDuckMotif" value="${escapeHtml(d.motif_sortie || "")}"></div>
    <div class="field"><label>Notes</label><textarea id="eDuckNotes" rows="2">${escapeHtml(d.notes || "")}</textarea></div>
    <button class="btn secondary" id="eDuckSave">Enregistrer la correction</button>
    <div class="spacer-s"></div>
    <button class="btn danger" id="eDuckDelete">Supprimer l'enregistrement</button>
  `;
  openModal(`${TYPE_LABELS[d.type] || d.type}`, body, {
    onMount: () => {
      const requalBtn = document.getElementById("fRequalSave");
      if (requalBtn) requalBtn.addEventListener("click", async () => {
        const qte = Number(document.getElementById("fRequalQte").value) || 0;
        const currentQte = Number(d.quantite) || 1;
        if (qte <= 0 || qte > currentQte) { toast(`Indiquez une quantité entre 1 et ${currentQte}`); return; }
        try {
          if (qte === currentQte) {
            await updateDoc(doc(db, "ducks", d.id), {
              type: "canard",
              requalifie_par: getUserName() || "Inconnu",
              requalifie_le: serverTimestamp()
            });
          } else {
            await updateDoc(doc(db, "ducks", d.id), {
              quantite: currentQte - qte,
              modifie_par: getUserName() || "Inconnu",
              modifie_le: serverTimestamp()
            });
            await addDoc(ducksCol, {
              type: "canard",
              quantite: qte,
              date_entree: d.date_entree || new Date(),
              bague_couleur: d.bague_couleur || null,
              numero_bague: d.numero_bague || null,
              notes: null,
              statut: "actif",
              date_sortie: null,
              motif_sortie: null,
              issu_du_lot: d.id,
              requalifie_par: getUserName() || "Inconnu",
              requalifie_le: serverTimestamp(),
              cree_par: getUserName() || "Inconnu",
              createdAt: serverTimestamp()
            });
          }
          toast(`${qte} caneton(s) requalifié(s) en canard ✓`);
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      const withdrawBtn = document.getElementById("fWithdrawSave");
      if (withdrawBtn) withdrawBtn.addEventListener("click", async () => {
        const qte = Number(document.getElementById("fWithdrawQte").value) || 0;
        const currentQte = Number(d.quantite) || 1;
        if (qte <= 0 || qte > currentQte) { toast(`Indiquez une quantité entre 1 et ${currentQte}`); return; }
        const motif = document.getElementById("fWithdrawMotif").value;
        const note = document.getElementById("fWithdrawNote").value.trim() || null;
        try {
          if (qte === currentQte) {
            // Le lot entier part : on met simplement à jour ce document
            await updateDoc(doc(db, "ducks", d.id), {
              statut: motif,
              date_sortie: new Date(),
              motif_sortie: note,
              modifie_par: getUserName() || "Inconnu",
              modifie_le: serverTimestamp()
            });
          } else {
            // Retrait partiel : on réduit le lot d'origine et on crée un
            // enregistrement séparé pour la partie sortie, pour garder une
            // trace complète sans jamais perdre le compte.
            await updateDoc(doc(db, "ducks", d.id), {
              quantite: currentQte - qte,
              modifie_par: getUserName() || "Inconnu",
              modifie_le: serverTimestamp()
            });
            await addDoc(ducksCol, {
              type: d.type,
              quantite: qte,
              date_entree: d.date_entree || new Date(),
              bague_couleur: d.bague_couleur || null,
              numero_bague: d.numero_bague || null,
              notes: null,
              statut: motif,
              date_sortie: new Date(),
              motif_sortie: note,
              issu_du_lot: d.id,
              cree_par: getUserName() || "Inconnu",
              createdAt: serverTimestamp()
            });
          }
          toast("Retrait enregistré ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      document.getElementById("eDuckSave").addEventListener("click", async () => {
        const statut = document.getElementById("eDuckStatut").value;
        try {
          await updateDoc(doc(db, "ducks", d.id), {
            statut,
            quantite: Number(document.getElementById("eDuckQte").value) || 1,
            motif_sortie: document.getElementById("eDuckMotif").value.trim() || null,
            notes: document.getElementById("eDuckNotes").value.trim() || null,
            date_sortie: statut !== "actif" ? new Date() : null,
            modifie_par: getUserName() || "Inconnu",
            modifie_le: serverTimestamp()
          });
          toast("Mis à jour ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
      document.getElementById("eDuckDelete").addEventListener("click", async () => {
        if (!confirm("Supprimer définitivement cet enregistrement ?")) return;
        try {
          await deleteDoc(doc(db, "ducks", d.id));
          toast("Supprimé");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}
