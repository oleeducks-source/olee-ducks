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

// Tableau de croissance du canard de Barbarie — poids moyen mixte/mâle
// en grammes, par âge, sur 3 niveaux de croissance (source : référence
// zootechnique fournie, recoupée avec la littérature disponible). C'est
// la table affichée in-app (voir ouvrirTableauCroissance) et utilisée
// pour tout le diagnostic.
const TABLE_CROISSANCE = [
  { s: 0, jour: "1 jour", satisfaisante: 52.5, moyenne: 50, mediocre: 45 },
  { s: 1, jour: "1 semaine", satisfaisante: 150, moyenne: 120, mediocre: 90 },
  { s: 2, jour: "2 semaines", satisfaisante: 350, moyenne: 280, mediocre: 200 },
  { s: 3, jour: "3 semaines", satisfaisante: 680, moyenne: 520, mediocre: 380 },
  { s: 4, jour: "4 semaines", satisfaisante: 1100, moyenne: 850, mediocre: 600 },
  { s: 5, jour: "5 semaines", satisfaisante: 1600, moyenne: 1250, mediocre: 900 },
  { s: 6, jour: "6 semaines", satisfaisante: 2200, moyenne: 1700, mediocre: 1200 },
  { s: 7, jour: "7 semaines", satisfaisante: 2800, moyenne: 2150, mediocre: 1550 },
  { s: 8, jour: "8 semaines", satisfaisante: 3300, moyenne: 2600, mediocre: 1900 },
  { s: 10, jour: "10 semaines", satisfaisante: 4100, moyenne: 3300, mediocre: 2400 },
  { s: 12, jour: "12 semaines", satisfaisante: 4700, moyenne: 3900, mediocre: 2900 }
];

function interpoler(champ, ageSemaines) {
  const s = Math.max(0, ageSemaines);
  if (s <= TABLE_CROISSANCE[0].s) return TABLE_CROISSANCE[0][champ];
  for (let i = 1; i < TABLE_CROISSANCE.length; i++) {
    if (s <= TABLE_CROISSANCE[i].s) {
      const a = TABLE_CROISSANCE[i - 1], b = TABLE_CROISSANCE[i];
      const t = (s - a.s) / (b.s - a.s);
      return Math.round(a[champ] + (b[champ] - a[champ]) * t);
    }
  }
  // Au-delà de 12 semaines (dernier point du tableau) : on prolonge
  // avec le gain hebdomadaire moyen observé sur les 2 derniers points.
  const avantDernier = TABLE_CROISSANCE[TABLE_CROISSANCE.length - 2];
  const dernier = TABLE_CROISSANCE[TABLE_CROISSANCE.length - 1];
  const gainHebdo = (dernier[champ] - avantDernier[champ]) / (dernier.s - avantDernier.s);
  return Math.round(dernier[champ] + (s - dernier.s) * gainHebdo);
}

function poidsReferenceG(ageSemaines) {
  return interpoler("satisfaisante", ageSemaines);
}

// ---------------------------------------------------------------------
// Taille d'échantillon recommandée, en fonction de la taille réelle du
// lot — plus le lot est petit, plus la part échantillonnée doit être
// grande pour rester représentative (principe zootechnique standard) :
//  - lot ≤ 20 sujets   : ~30%, minimum 5 (ou tout le lot si < 5)
//  - lot 21-100 sujets : ~15%, minimum 8
//  - lot > 100 sujets  : ~8%, plafonné à 25 (peser plus n'apporte plus
//    grand-chose de précision pour l'effort supplémentaire que ça demande)
// ---------------------------------------------------------------------
function tailleEchantillonRecommandee(tailleLot) {
  if (tailleLot <= 5) return tailleLot;
  if (tailleLot <= 20) return Math.max(5, Math.round(tailleLot * 0.3));
  if (tailleLot <= 100) return Math.max(8, Math.round(tailleLot * 0.15));
  return Math.min(25, Math.round(tailleLot * 0.08));
}

const CONSEILS_MEDIOCRE = [
  "Croissance nettement sous la référence — intervention rapide recommandée.",
  "Vérifiez en priorité l'accès à l'eau propre — un manque d'eau réduit l'ingestion d'aliment plus vite qu'un manque de nourriture.",
  "Contrôlez la quantité réelle d'aliment distribué par sujet, et son état (pas de moisissure, stockage au sec).",
  "Vérifiez que l'espace aux mangeoires est suffisant — dans un lot nombreux, les plus faibles peuvent être évincés par les plus forts.",
  "Observez les fientes et le comportement : léthargie ou diarrhée peuvent indiquer une parasitose ou une infection à traiter en priorité.",
  "Vérifiez le confort thermique (trop chaud ou trop froid pour l'âge fatigue et ralentit la croissance).",
  "Isolez et pesez individuellement les 2-3 sujets les plus légers pour écarter un problème localisé (bec, patte, maladie)."
];
const CONSEILS_MOYENNE = [
  "Croissance en dessous de l'objectif mais pas critique — à surveiller de près lors du prochain relevé.",
  "Contrôlez que la ration quotidienne suit bien l'augmentation des besoins avec l'âge (voir le suivi de stock/formulation).",
  "Vérifiez qu'il n'y a pas de compétition alimentaire entre sujets de tailles différentes dans le même lot."
];
const CONSEILS_SURCROISSANCE = [
  "Vérifiez d'abord que l'échantillon n'était pas biaisé (sujets les plus gros attrapés en premier, plus faciles à saisir).",
  "Surveillez la locomotion : une prise de poids très rapide peut fatiguer les pattes avant qu'elles ne soient assez solides.",
  "Si l'alimentation est très énergétique, un léger ajustement peut suffire à ralentir sans nuire à la croissance globale.",
  "Une croissance au-dessus de la moyenne n'est pas un problème en soi si les sujets restent actifs et bien portants — à surveiller, pas forcément à corriger."
];

// ---------------------------------------------------------------------
// Diagnostic : classe le poids mesuré par rapport aux 3 bandes du
// tableau de croissance pour l'âge donné, indique l'écart en grammes
// (pas seulement en %), le poids à atteindre pour une croissance
// satisfaisante, et des pistes correctives concrètes.
// ---------------------------------------------------------------------
function diagnosticCroissance(poidsMoyenG, ageSemaines) {
  const satisfaisante = interpoler("satisfaisante", ageSemaines);
  const moyenne = interpoler("moyenne", ageSemaines);
  const mediocre = interpoler("mediocre", ageSemaines);

  let diag;
  if (poidsMoyenG >= satisfaisante * 0.97) {
    diag = { cls: "ok", niveau: "satisfaisante", label: "✓ Croissance satisfaisante", conseils: [] };
  } else if (poidsMoyenG >= moyenne) {
    const manque = satisfaisante - poidsMoyenG;
    diag = { cls: "warn", niveau: "moyenne", label: "◐ Croissance moyenne", detailManque: manque, conseils: CONSEILS_MOYENNE };
  } else if (poidsMoyenG >= mediocre * 0.85) {
    const manque = satisfaisante - poidsMoyenG;
    diag = { cls: "danger", niveau: "mediocre", label: "⚠️ Croissance médiocre", detailManque: manque, conseils: CONSEILS_MEDIOCRE };
  } else {
    const manque = satisfaisante - poidsMoyenG;
    diag = { cls: "danger", niveau: "critique", label: "🔴 Retard de croissance sévère", detailManque: manque, conseils: CONSEILS_MEDIOCRE };
  }
  if (poidsMoyenG > satisfaisante * 1.25) {
    diag = { cls: "warn", niveau: "surcroissance", label: "📈 Croissance au-dessus de la moyenne", detailManque: null, conseils: CONSEILS_SURCROISSANCE };
  }

  diag.satisfaisante = satisfaisante;
  diag.moyenne = moyenne;
  diag.mediocre = mediocre;
  diag.ref = satisfaisante;
  diag.ecartPct = satisfaisante ? Math.round(((poidsMoyenG - satisfaisante) / satisfaisante) * 100) : 0;
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
  const suggestionEchantillon = tailleEchantillonRecommandee(tailleLot);
  const body = `
    <p class="subtle">Pas besoin de peser tout le lot. Pour ${tailleLot} sujet(s), l'échantillon recommandé pour rester représentatif est de <b>${suggestionEchantillon} sujet(s)</b>, pris au hasard dans le groupe (pas seulement les plus gros ou les plus chétifs).</p>
    <button class="btn secondary small" id="fVoirTableauBtn" style="margin:4px 0 10px;">📊 Voir le tableau de croissance complet</button>
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
      document.getElementById("fVoirTableauBtn").addEventListener("click", ouvrirTableauCroissance);
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
                <div class="row"><div class="row-main"><span class="row-title">Poids cible (${age.toFixed(1)} sem., croissance satisfaisante)</span></div><span class="row-value">${diag.satisfaisante} g</span></div>
                <div class="row"><div class="row-main"><span class="row-title">Diagnostic</span></div><span class="tag ${diag.cls}">${diag.label}</span></div>
                ${diag.detailManque !== null && diag.detailManque !== undefined && diag.detailManque > 0 ? `<p class="subtle" style="margin:8px 0 0;">Il manque environ <b>${Math.round(diag.detailManque)} g</b> par sujet en moyenne pour atteindre une croissance satisfaisante (${diag.satisfaisante} g) à cet âge.</p>` : ""}
                ${diag.avertissementDimorphisme ? `<p class="subtle" style="margin:6px 0 0;">⚠️ Au-delà de 8 semaines, le dimorphisme mâle/femelle rend ce repère moins précis pour un lot mixte.</p>` : ""}
              </div>
              ${diag.conseils.length ? `
              <div class="spacer-s"></div>
              <div class="card" style="background:${diag.cls === 'danger' ? '#FCEAE6' : '#FCEBD9'}; border:none;">
                <h3 style="font-size:13.5px; margin-bottom:8px;">Correctifs à apporter</h3>
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
// Tableau de croissance consultable dans l'app (lecture seule).
// ---------------------------------------------------------------------
export function ouvrirTableauCroissance() {
  const body = `
    <p class="subtle">Poids moyen du canard de Barbarie (sexes mixtes/mâles) selon l'âge, sur 3 niveaux de croissance. Ce tableau sert de référence à tous les diagnostics de pesée de l'application.</p>
    <div class="spacer-s"></div>
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
        <thead>
          <tr style="background:var(--pond-950); color:var(--white);">
            <th style="padding:8px 6px; text-align:left;">Âge</th>
            <th style="padding:8px 6px; text-align:right;">Satisfaisante</th>
            <th style="padding:8px 6px; text-align:right;">Moyenne</th>
            <th style="padding:8px 6px; text-align:right;">Médiocre</th>
          </tr>
        </thead>
        <tbody>
          ${TABLE_CROISSANCE.map((r, i) => `
            <tr style="background:${i % 2 === 1 ? 'var(--sage-100)' : 'transparent'};">
              <td style="padding:7px 6px; font-weight:600;">${r.jour}</td>
              <td style="padding:7px 6px; text-align:right; font-family:var(--font-mono);">${r.satisfaisante} g</td>
              <td style="padding:7px 6px; text-align:right; font-family:var(--font-mono);">${r.moyenne} g</td>
              <td style="padding:7px 6px; text-align:right; font-family:var(--font-mono);">${r.mediocre} g</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="spacer-s"></div>
    <p class="subtle">⚠️ Au-delà de 8 semaines, le dimorphisme mâle/femelle du canard de Barbarie devient marqué — ce repère "mixte" perd en précision pour un lot non sexé. Ces chiffres restent indicatifs : la souche génétique, l'alimentation et les conditions d'élevage font varier les performances réelles.</p>
  `;
  openModal("Tableau de croissance — Canard de Barbarie", body, { onMount: () => {} });
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
    document.querySelector('.nav-item[data-page="elevage"]')?.click();
  });
  document.getElementById("voirTableauCroissanceBtn")?.addEventListener("click", ouvrirTableauCroissance);
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
