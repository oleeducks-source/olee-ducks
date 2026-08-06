// =====================================================================
// MODULE : SUIVI PONDÉRAL (POIDS) — PAR ÉCHANTILLONNAGE
// Permet de peser un échantillon d'un lot (pas besoin d'attraper tous
// les sujets) et compare le poids moyen obtenu à une courbe de
// référence du canard de Barbarie, pour repérer un retard ou une
// surcroissance possible.
//
// Références utilisées (littérature zootechnique canard de Barbarie /
// Cairina moschata) :
//  - Poids à l'éclosion : ~37-45 g (peu de différence mâle/femelle à ce stade)
//  - Gain moyen quotidien (GMQ) : ~42 g/jour, deux sexes confondus,
//    pendant la phase de croissance active (0-10 semaines)
//  - Dimorphisme sexuel marqué à partir de ~8 semaines : le mâle prend
//    nettement plus de poids que la femelle à partir de ce stade — au
//    -delà de 8 semaines, la courbe de référence "mixte" perd en
//    précision, ce qui est signalé à l'utilisateur.
//  - Poids à 12 semaines observés dans la littérature : de ~1,8-2,7 kg
//    (souches locales/traditionnelles, Afrique de l'Ouest) à ~4,5-4,9 kg
//    pour les mâles de souches sélectionnées "chair" à croissance
//    rapide — l'écart entre souches est important, d'où l'importance de
//    calibrer avec l'historique propre à la ferme dès qu'il existe.
//
// Ces repères sont indicatifs, pas une norme absolue : ils dépendent de
// la souche génétique, de l'alimentation et des conditions d'élevage.
// =====================================================================
import { db } from "./firebase-config.js";
import {
  collection, addDoc, doc, getDocs, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { formatDate, toast, openModal, closeModal, escapeHtml, todayInputValue, getUserName } from "./utils.js";

const peseesCol = collection(db, "pesees_journalieres");
const SEMAINE_MS = 7 * 24 * 60 * 60 * 1000;

// Courbe de référence (âge en semaines -> poids moyen en grammes),
// sexes confondus jusqu'à 8 semaines. Au-delà, la valeur reste indiquée
// à titre de repère mais le dimorphisme sexuel rend la comparaison
// moins fiable pour un lot mixte (voir avertissement dans le diagnostic).
const REFERENCE_POIDS_G = [
  { s: 0, g: 45 },
  { s: 1, g: 150 },
  { s: 2, g: 350 },
  { s: 3, g: 600 },
  { s: 4, g: 900 },
  { s: 5, g: 1150 },
  { s: 6, g: 1400 },
  { s: 7, g: 1650 },
  { s: 8, g: 1900 },
  { s: 10, g: 2300 },
  { s: 12, g: 2700 }
];

function poidsReferenceG(ageSemaines) {
  const s = Math.max(0, ageSemaines);
  if (s <= REFERENCE_POIDS_G[0].s) return REFERENCE_POIDS_G[0].g;
  for (let i = 1; i < REFERENCE_POIDS_G.length; i++) {
    if (s <= REFERENCE_POIDS_G[i].s) {
      const a = REFERENCE_POIDS_G[i - 1], b = REFERENCE_POIDS_G[i];
      const t = (s - a.s) / (b.s - a.s);
      return Math.round(a.g + (b.g - a.g) * t);
    }
  }
  // Au-delà du dernier point connu (12 sem.) : on prolonge avec le GMQ
  // moyen de référence (~42 g/j = ~294 g/semaine), à titre indicatif.
  const dernier = REFERENCE_POIDS_G[REFERENCE_POIDS_G.length - 1];
  return Math.round(dernier.g + (s - dernier.s) * 294);
}

const CONSEILS_RETARD = [
  "Vérifiez l'accès à l'eau propre — un manque d'eau réduit l'ingestion d'aliment plus vite qu'un manque de nourriture.",
  "Contrôlez la quantité réelle d'aliment distribué par sujet, et son état (pas de moisissure, stockage au sec).",
  "Vérifiez que l'espace aux mangeoires est suffisant — dans un lot nombreux, les plus faibles peuvent être évincés par les plus forts.",
  "Observez les fientes et le comportement : léthargie ou diarrhée peuvent indiquer une parasitose ou une infection à traiter.",
  "Vérifiez le confort thermique (trop chaud ou trop froid pour l'âge fatigue et ralentit la croissance).",
  "Si le retard touche tout le lot, isolez et pesez individuellement les 2-3 sujets les plus légers pour écarter un problème localisé (bec, patte, maladie)."
];
const CONSEILS_SURCROISSANCE = [
  "Vérifiez d'abord que l'échantillon n'était pas biaisé (sujets les plus gros attrapés en premier, plus faciles à saisir).",
  "Surveillez la locomotion : une prise de poids très rapide peut fatiguer les pattes avant qu'elles ne soient assez solides.",
  "Si l'alimentation est très énergétique, un léger ajustement peut suffire à ralentir sans nuire à la croissance globale.",
  "Une croissance au-dessus de la moyenne n'est pas un problème en soi si les sujets restent actifs et bien portants — à surveiller, pas forcément à corriger."
];

function diagnosticCroissance(poidsMoyenG, ageSemaines) {
  const ref = poidsReferenceG(ageSemaines);
  const ecart = ref > 0 ? (poidsMoyenG - ref) / ref : 0;
  let diag;
  if (ecart <= -0.20) diag = { cls: "danger", label: "⚠️ Retard de croissance possible", detail: `Environ ${Math.round(Math.abs(ecart) * 100)}% sous le repère de référence pour cet âge.`, conseils: CONSEILS_RETARD };
  else if (ecart >= 0.25) diag = { cls: "warn", label: "📈 Croissance au-dessus de la moyenne", detail: `Environ ${Math.round(ecart * 100)}% au-dessus du repère de référence pour cet âge.`, conseils: CONSEILS_SURCROISSANCE };
  else diag = { cls: "ok", label: "✓ Croissance dans la norme", detail: "Poids cohérent avec le repère de référence pour cet âge.", conseils: [] };
  diag.ref = ref;
  diag.ecartPct = Math.round(ecart * 100);
  diag.avertissementDimorphisme = ageSemaines >= 8;
  return diag;
}

function ageSemainesA(dateReference, dateCible) {
  if (!dateReference) return null;
  const ref = dateReference?.toDate ? dateReference.toDate() : new Date(dateReference);
  if (isNaN(ref.getTime())) return null;
  return Math.max(0, (dateCible.getTime() - ref.getTime()) / SEMAINE_MS);
}

// ---------------------------------------------------------------------
// Formulaire de pesée d'un échantillon
// ---------------------------------------------------------------------
export function openPeseeModal(lot, onSaved) {
  const tailleLot = Number(lot.quantite) || 1;
  const suggestionEchantillon = Math.max(3, Math.min(tailleLot, Math.ceil(tailleLot * 0.1)));
  const body = `
    <p class="subtle">Pas besoin de peser tout le lot — un échantillon représentatif suffit. Recommandation : au moins 5 à 10% du lot, avec un minimum de 3 à 5 sujets pris au hasard dans le groupe (pas seulement les plus gros ou les plus chétifs).</p>
    <div class="spacer-s"></div>
    <div class="field"><label>Date de la pesée</label><input type="date" id="fPeseeDate" value="${todayInputValue()}"></div>
    <div class="field-row">
      <div class="field"><label>Nombre de sujets pesés</label><input type="number" id="fPeseeTaille" min="1" max="${tailleLot}" value="${suggestionEchantillon}"></div>
      <div class="field"><label>Poids total de l'échantillon (g)</label><input type="number" id="fPeseeTotal" min="0" step="1" placeholder="ex : 3200"></div>
    </div>
    <button class="btn yolk" id="fPeseeSave">Enregistrer la pesée</button>
    <div id="fPeseeResultat"></div>
  `;
  openModal("Peser un échantillon", body, {
    onMount: () => {
      document.getElementById("fPeseeSave").addEventListener("click", async () => {
        const taille = Number(document.getElementById("fPeseeTaille").value) || 0;
        const total = Number(document.getElementById("fPeseeTotal").value) || 0;
        const dateVal = document.getElementById("fPeseeDate").value;
        if (taille <= 0 || total <= 0 || !dateVal) { toast("Renseignez la date, le nombre de sujets et le poids total"); return; }
        const datePesee = new Date(dateVal);
        const poidsMoyen = Math.round(total / taille);
        const dateRef = lot.date_naissance || lot.date_entree;
        const age = ageSemainesA(dateRef, datePesee);

        try {
          await addDoc(peseesCol, {
            duck_id: lot.id, type: lot.type, date: datePesee,
            taille_echantillon: taille, poids_total_g: total, poids_moyen_g: poidsMoyen,
            age_semaines: age !== null ? Math.round(age * 10) / 10 : null,
            cree_par: getUserName() || "Inconnu", createdAt: serverTimestamp()
          });

          const zone = document.getElementById("fPeseeResultat");
          if (age !== null) {
            const diag = diagnosticCroissance(poidsMoyen, age);
            zone.innerHTML = `
              <div class="spacer-m"></div>
              <div class="card" style="background:var(--sage-100); border:none;">
                <div class="row"><div class="row-main"><span class="row-title">Poids moyen mesuré</span></div><span class="row-value">${poidsMoyen} g</span></div>
                <div class="row"><div class="row-main"><span class="row-title">Repère de référence (${age.toFixed(1)} sem.)</span></div><span class="row-value">${diag.ref} g</span></div>
                <div class="row"><div class="row-main"><span class="row-title">Diagnostic</span></div><span class="tag ${diag.cls}">${diag.label}</span></div>
                <p class="subtle" style="margin:8px 0 0;">${diag.detail}${diag.avertissementDimorphisme ? " ⚠️ Au-delà de 8 semaines, le dimorphisme mâle/femelle rend ce repère moins précis pour un lot mixte." : ""}</p>
              </div>
              ${diag.conseils.length ? `
              <div class="spacer-s"></div>
              <div class="card" style="background:${diag.cls === 'danger' ? '#FCEAE6' : '#FCEBD9'}; border:none;">
                <h3 style="font-size:13.5px; margin-bottom:8px;">Pistes à vérifier</h3>
                <ul style="margin:0; padding-left:18px; display:flex; flex-direction:column; gap:6px;">
                  ${diag.conseils.map(c => `<li class="subtle" style="line-height:1.4;">${c}</li>`).join("")}
                </ul>
              </div>
              ` : ""}
            `;
          } else {
            zone.innerHTML = `<div class="spacer-m"></div><p class="subtle">Pesée enregistrée — âge non calculable (date de naissance/entrée manquante sur ce lot).</p>`;
          }
          toast("Pesée enregistrée ✓");
          if (onSaved) onSaved();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}

// ---------------------------------------------------------------------
// Historique des pesées d'un lot — à insérer dans la fiche du lot
// (inventaire.js). Purement lecture, aucune donnée n'est créée ici.
// ---------------------------------------------------------------------
export async function chargerHistoriquePesees(lotId) {
  // Tri effectué côté app plutôt que via Firestore orderBy : un filtre +
  // tri sur deux champs différents demande un index composite à créer
  // manuellement dans la console Firebase, ce qu'on évite ici (le nombre
  // de pesées par lot reste toujours faible, donc trier en mémoire est
  // largement suffisant et ne coûte rien en performance).
  const snap = await getDocs(query(peseesCol, where("duck_id", "==", lotId)));
  const pesees = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  pesees.sort((a, b) => {
    const da = a.date?.toDate ? a.date.toDate().getTime() : new Date(a.date).getTime();
    const db_ = b.date?.toDate ? b.date.toDate().getTime() : new Date(b.date).getTime();
    return db_ - da;
  });
  return pesees;
}

// ---------------------------------------------------------------------
// Résumé global (toutes les pesées, tous lots confondus) — pour le KPI
// du tableau de bord : ne garde que la pesée la plus récente de chaque
// lot, puis compte combien sont dans la norme / en retard / au-dessus.
// ---------------------------------------------------------------------
export async function resumeSuiviPonderal() {
  const snap = await getDocs(peseesCol);
  const tous = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!tous.length) return { total: 0, normal: 0, retard: 0, surcroissance: 0, derniereDate: null };

  const parLot = {};
  tous.forEach(p => {
    const ms = p.date?.toDate ? p.date.toDate().getTime() : new Date(p.date).getTime();
    if (!parLot[p.duck_id] || ms > parLot[p.duck_id]._ms) parLot[p.duck_id] = { ...p, _ms: ms };
  });

  const entries = Object.values(parLot);
  let normal = 0, retard = 0, surcroissance = 0, derniereDateMs = 0;
  entries.forEach(p => {
    derniereDateMs = Math.max(derniereDateMs, p._ms);
    if (p.age_semaines === null || p.age_semaines === undefined) { normal++; return; }
    const diag = diagnosticCroissance(p.poids_moyen_g, p.age_semaines);
    if (diag.cls === "danger") retard++;
    else if (diag.cls === "warn") surcroissance++;
    else normal++;
  });

  return { total: entries.length, normal, retard, surcroissance, derniereDate: derniereDateMs ? new Date(derniereDateMs) : null };
}

// ---------------------------------------------------------------------
// Initialisation unique (bouton de navigation) + premier chargement.
// ---------------------------------------------------------------------
export function initPesees() {
  document.getElementById("openPoidsBtn")?.addEventListener("click", () => {
    document.querySelector('.nav-item[data-page="inventaire"]')?.click();
  });
  refreshPeseesDashboard();
}

// Rafraîchit uniquement le contenu de la carte (appelable plusieurs
// fois, ex. après chaque nouvelle pesée, sans jamais dupliquer d'écouteur).
export async function refreshPeseesDashboard() {
  const zone = document.getElementById("dashPoidsResume");
  const voyant = document.getElementById("poidsVoyant");
  if (!zone) return;
  try {
    const r = await resumeSuiviPonderal();
    if (!r.total) {
      zone.innerHTML = `<p class="subtle">Aucune pesée enregistrée pour l'instant — pesez un échantillon depuis la fiche d'un lot.</p>`;
      if (voyant) voyant.classList.add("idle");
      return;
    }
    const alerte = r.retard + r.surcroissance;
    if (voyant) voyant.classList.toggle("idle", alerte === 0);
    zone.innerHTML = `
      <p class="subtle" style="margin-bottom:6px;">${r.total} lot(s) suivi(s) · dernière pesée ${formatDate(r.derniereDate)}</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <span class="tag ok">${r.normal} normal</span>
        ${r.retard ? `<span class="tag danger">${r.retard} en retard</span>` : ""}
        ${r.surcroissance ? `<span class="tag warn">${r.surcroissance} au-dessus</span>` : ""}
      </div>
    `;
  } catch (e) {
    zone.innerHTML = `<p class="subtle">Erreur de chargement : ${e.message}</p>`;
  }
}

export function rendreHistoriquePeseesHtml(pesees) {
  if (!pesees.length) return `<p class="subtle">Aucune pesée enregistrée pour ce lot.</p>`;
  return pesees.map(p => {
    const diag = p.age_semaines !== null && p.age_semaines !== undefined ? diagnosticCroissance(p.poids_moyen_g, p.age_semaines) : null;
    return `
    <div class="row">
      <div class="row-main">
        <span class="row-title">${p.poids_moyen_g} g / sujet</span>
        <span class="row-sub">${formatDate(p.date)} · échantillon de ${p.taille_echantillon}${p.age_semaines !== null && p.age_semaines !== undefined ? ` · ${p.age_semaines} sem.` : ""}${p.cree_par ? " · " + escapeHtml(p.cree_par) : ""}</span>
      </div>
      ${diag ? `<span class="tag ${diag.cls}">${diag.ecartPct >= 0 ? "+" : ""}${diag.ecartPct}%</span>` : ""}
    </div>`;
  }).join("");
}
