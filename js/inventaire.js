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
  canardeau: "Canardeau",
  canard: "Canard",
  reproducteur_male: "Reproducteur mâle",
  reproducteur_femelle: "Reproductrice femelle"
};
const TYPE_ICONS = {
  caneton: "ic-duck-caneton",
  canardeau: "ic-duck-canardeau",
  canard: "ic-duck-canard",
  reproducteur_male: "ic-duck-repro-m",
  reproducteur_femelle: "ic-duck-repro-f"
};
const BAGUE_LABELS = { rouge: "Rouge", vert: "Vert", violet: "Violet", bleu: "Bleu" };
const STATUT_LABELS = { actif: "Actif", vendu: "Vendu", mort: "Décédé", reforme: "Réformé" };

// ---------------------------------------------------------------------
// Cycle de vie et requalification automatique par âge.
// Catégorie 1 — Caneton      : 0 à 3 semaines révolues (0-20 jours)
// Catégorie 2 — Canardeau    : 4 à 8 semaines révolues (21-55 jours)
// Catégorie 3 — Canard adulte: 8 semaines et plus (56 jours et +)
// L'âge est calculé à partir de "date_entree" du lot. Seuls les lots
// actuellement "caneton" ou "canardeau" sont concernés par ce décompte
// automatique — un canard ou un reproducteur ne redescend jamais dans
// une catégorie plus jeune, et un lot ajouté directement comme
// reproducteur n'est jamais touché par cette logique.
// ---------------------------------------------------------------------
const SEMAINE_MS = 7 * 24 * 60 * 60 * 1000;
const SEUIL_CANARDEAU_SEM = 4; // dès la 4e semaine révolue
const SEUIL_CANARD_SEM = 8;    // dès la 8e semaine révolue

function ageEnSemaines(dateEntree) {
  const d = dateEntree?.toDate ? dateEntree.toDate() : new Date(dateEntree);
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / SEMAINE_MS;
}

function stadeAttendu(ageSemaines) {
  if (ageSemaines === null) return null;
  if (ageSemaines >= SEUIL_CANARD_SEM) return "canard";
  if (ageSemaines >= SEUIL_CANARDEAU_SEM) return "canardeau";
  return "caneton";
}

// Évite de renvoyer plusieurs écritures simultanées sur le même lot
// pendant qu'une requalification est déjà en cours d'enregistrement.
const requalificationEnCours = new Set();

// Parcourt les lots actifs "caneton"/"canardeau" et fait automatiquement
// avancer leur "type" quand l'âge calculé dépasse le seuil de la
// catégorie suivante. Purement additif : ne touche jamais aux lots déjà
// "canard" ou reproducteurs, ne supprime rien, trace l'auteur ("Système
// (auto)") et la date comme pour une requalification manuelle.
async function autoRequalifierParAge() {
  const candidats = allDucks.filter(d => d.statut === "actif" && (d.type === "caneton" || d.type === "canardeau"));
  for (const d of candidats) {
    if (requalificationEnCours.has(d.id)) continue;
    const age = ageEnSemaines(d.date_entree);
    const stade = stadeAttendu(age);
    if (!stade || stade === d.type) continue;
    // On ne saute jamais directement caneton -> canard automatiquement :
    // si le lot a été laissé sans passage par l'app pendant longtemps,
    // il transite d'abord par canardeau au prochain rafraîchissement,
    // puis vers canard ensuite — ceci reste cohérent avec l'historique.
    const prochainStade = d.type === "caneton" ? "canardeau" : "canard";
    requalificationEnCours.add(d.id);
    try {
      await updateDoc(doc(db, "ducks", d.id), {
        type: prochainStade,
        requalifie_par: "Système (auto)",
        requalifie_le: serverTimestamp()
      });
    } catch (e) {
      console.error("Erreur requalification automatique :", e);
    } finally {
      requalificationEnCours.delete(d.id);
    }
  }
}

export function initInventaire() {
  onSnapshot(query(ducksCol, orderBy("createdAt", "desc")), (snap) => {
    allDucks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderKpis();
    renderList();
    autoRequalifierParAge(); // déclenche les écritures nécessaires ; le prochain snapshot rafraîchira l'affichage
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

// Utilisé par stocks.js pour la prévision de consommation basée sur le
// cheptel réel (lecture seule — ne modifie rien ici).
export function getActiveDuckCounts() {
  const actifs = activeDucks();
  const sum = (t) => actifs.filter(d => d.type === t).reduce((a, d) => a + (Number(d.quantite) || 1), 0);
  return {
    caneton: sum("caneton"),
    canardeau: sum("canardeau"),
    canard: sum("canard"),
    reproducteur_male: sum("reproducteur_male"),
    reproducteur_femelle: sum("reproducteur_femelle")
  };
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
    <div class="kpi"><div class="kpi-label">Canardeaux</div><div class="kpi-value">${sum("canardeau")}</div></div>
    <div class="kpi"><div class="kpi-label">Canards</div><div class="kpi-value">${sum("canard")}</div></div>
    <div class="kpi alt"><div class="kpi-label">Reprod. mâles</div><div class="kpi-value">${sum("reproducteur_male")}</div></div>
    <div class="kpi alt"><div class="kpi-label">Reprod. femelles</div><div class="kpi-value">${sum("reproducteur_femelle")}</div></div>
    <div class="kpi yolk"><div class="kpi-label">Total actif</div><div class="kpi-value">${actifs.reduce((a, d) => a + (Number(d.quantite) || 1), 0)}</div></div>
  `;
  const totalEl = document.getElementById("kpiTotalCanards");
  const subEl = document.getElementById("kpiCanardsSub");
  if (totalEl) totalEl.textContent = actifs.reduce((a, d) => a + (Number(d.quantite) || 1), 0);
  if (subEl) subEl.textContent = `${sum("reproducteur_male") + sum("reproducteur_femelle")} reproducteurs · ${sum("canard")} canards · ${sum("canardeau")} canardeaux · ${sum("caneton")} canetons`;

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
  el.innerHTML = items.map(d => {
    const bagueColorVar = { rouge: "var(--clay-500)", vert: "var(--pond-600)", violet: "#8B5FBF", bleu: "#3D6FBF" }[d.bague_couleur] || "var(--pond-600)";
    return `
    <div class="row with-icon">
      <div class="row-icon" style="color:${bagueColorVar}"><svg><use href="#${TYPE_ICONS[d.type] || 'ic-duck-canard'}"/></svg></div>
      <div class="row-main">
        <span class="row-title">${TYPE_LABELS[d.type] || d.type} ${d.quantite > 1 ? `× ${d.quantite}` : ""}</span>
        <span class="row-sub">${d.numero_bague ? "N° " + escapeHtml(d.numero_bague) + " · " : ""}${d.bague_couleur ? "Bague " + BAGUE_LABELS[d.bague_couleur] : "Sans bague"} · entrée ${formatDate(d.date_entree)}${d.cree_par ? " · par " + escapeHtml(d.cree_par) : ""}</span>
      </div>
      <span class="tag ${d.statut === 'actif' ? 'ok' : d.statut === 'mort' ? 'danger' : 'warn'}">${STATUT_LABELS[d.statut] || d.statut}</span>
    </div>
  `;
  }).join("");

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
        <option value="caneton">Caneton (0-3 sem.)</option>
        <option value="canardeau">Canardeau (4-8 sem.)</option>
        <option value="canard">Canard (8 sem. et +)</option>
        <option value="reproducteur_male">Reproducteur mâle</option>
        <option value="reproducteur_femelle">Reproductrice femelle</option>
      </select>
    </div>
    <div class="field-row">
      <div class="field"><label>Quantité (lot)</label><input type="number" id="fDuckQte" value="1" min="1"></div>
      <div class="field"><label>Date d'entrée</label><input type="date" id="fDuckDate" value="${todayInputValue()}"></div>
    </div>
    <p class="subtle" style="margin:-4px 0 8px;">Pour un caneton ou un canardeau, cette date sert de référence pour la requalification automatique par âge (0-3 sem. → caneton, 4-8 sem. → canardeau, 8 sem. et + → canard).</p>
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
  const estJeune = d.type === "caneton" || d.type === "canardeau";
  const age = ageEnSemaines(d.date_entree);
  const prochainStade = d.type === "caneton" ? "canardeau" : "canard";
  const seuilProchain = d.type === "caneton" ? SEUIL_CANARDEAU_SEM : SEUIL_CANARD_SEM;
  const semainesRestantes = (age !== null && estJeune) ? Math.max(0, Math.ceil(seuilProchain - age)) : null;
  const body = `
    <div class="row"><div class="row-main"><span class="row-title">Quantité actuelle</span></div><span class="row-value">${d.quantite || 1}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Statut</span></div><span class="tag ${d.statut === 'actif' ? 'ok' : d.statut === 'mort' ? 'danger' : 'warn'}">${STATUT_LABELS[d.statut] || d.statut}</span></div>
    ${age !== null ? `<div class="row"><div class="row-main"><span class="row-title">Âge estimé</span></div><span class="row-value">${age < 1 ? Math.round(age * 7) + " j" : age.toFixed(1) + " sem."}</span></div>` : ""}

    ${isActif && estJeune && (d.quantite || 1) > 0 ? `
    <div class="spacer-m"></div>
    <div class="card" style="background:#FCEBD9; border:none;">
      <h3 style="font-size:14px; margin-bottom:2px;">Requalifier en ${TYPE_LABELS[prochainStade].toLowerCase()}</h3>
      <p class="subtle" style="margin:0 0 10px;">${semainesRestantes !== null ? (semainesRestantes > 0 ? `Passage automatique dans ~${semainesRestantes} semaine(s) selon l'âge, ou forcez-le dès maintenant ci-dessous.` : "Ce lot a atteint l'âge du prochain stade — il sera requalifié automatiquement au prochain rafraîchissement, ou forcez-le maintenant.") : "Basculement manuel avec traçabilité (date, par qui)."}</p>
      <div class="field"><label>Quantité concernée</label><input type="number" id="fRequalQte" min="1" max="${d.quantite || 1}" value="${d.quantite || 1}"></div>
      <button class="btn yolk" id="fRequalSave">Requalifier maintenant</button>
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
              type: prochainStade,
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
              type: prochainStade,
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
          toast(`${qte} sujet(s) requalifié(s) en ${TYPE_LABELS[prochainStade].toLowerCase()} ✓`);
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
