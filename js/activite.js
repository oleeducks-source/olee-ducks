// =====================================================================
// ACTIVITÉ D'ÉLEVAGE — accueil
// - Bannière du jour : pontes et éclosions enregistrées aujourd'hui.
// - Récapitulatif hebdomadaire le lundi : lundi→dimanche précédents.
// - Courbe 30 jours : évolution des œufs et des canetons éclos.
// Lecture seule : aucune écriture Firestore.
// =====================================================================
import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const pontesCol = collection(db, "pontes_journalieres");
const eclosionsCol = collection(db, "eclosions_journalieres");
const cyclesCol = collection(db, "nest_cycles");
const MS_DAY = 86400000;
const DEDUP_WINDOW_MS = 15 * 60 * 1000;

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d) { const x = startOfDay(d); x.setDate(x.getDate()+1); return x; }
function ymd(d) { return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-'); }
function dateFromDoc(v) { if (!v) return null; const d = v?.toDate ? v.toDate() : new Date(v); return isNaN(d.getTime()) ? null : d; }
function formatNumber(n) { return Number(n || 0).toLocaleString('fr-FR'); }
function mondayStart(d) { const x = startOfDay(d); const day = x.getDay(); const delta = day === 0 ? -6 : 1 - day; x.setDate(x.getDate()+delta); return x; }

// Certains doublons historiques peuvent exister dans les journaux
// (avant la mise en place du verrou atomique, ou si deux personnes ont
// saisi la même chose à quelques minutes ou dizaines de minutes
// d'intervalle — le temps de s'en rendre compte). L'accueil ne doit pas
// recompter une même vague deux fois.
//
// ⚠️ CORRECTIF (septembre 2026) : la version précédente ne fusionnait
// deux lignes identiques (même cycle, même nid, même jour, même
// quantité) que si leurs horodatages "createdAt" étaient tous les deux
// présents ET distants de moins de 5 minutes. En pratique, un doublon
// n'est souvent repéré que bien plus tard dans la journée — ou l'une des
// deux lignes n'a pas de "createdAt" du tout (anciennes saisies) — et
// dans ces deux cas, le filtre ne fusionnait plus rien du tout : c'est
// ce qui a laissé passer les 56 canetons du 22 septembre au lieu de 38.
// Le regroupement se fait maintenant uniquement sur l'identité métier
// (cycle + nid + jour + quantité) : deux lignes qui partagent exactement
// ces quatre valeurs sont désormais TOUJOURS fusionnées en une seule,
// quel que soit l'écart de temps entre les deux saisies.
function journalKey(d, type) {
  const cycle = d.cycle_id || '';
  const nid = d.nid_numero ?? '';
  const date = dateFromDoc(d.date);
  const dateKey = date ? ymd(date) : '';
  const q = Number(d.quantite) || 0;
  return `${type}|${cycle}|${nid}|${dateKey}|${q}`;
}

function dedupeJournalDocs(docs, type) {
  const groups = new Map();
  for (const snap of docs) {
    const d = snap.data() || {};
    const date = dateFromDoc(d.date);
    const q = Number(d.quantite) || 0;
    // Pour les éclosions, une correction d'inventaire peut être négative
    // (ex. +11 puis -2 = 9 réellement constatés). On conserve donc les
    // mouvements signés pour permettre au tableau de bord de refléter le
    // total net. Les lignes sans quantité restent ignorées.
    if (!date || q === 0) continue;
    const key = journalKey(d, type);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ snap, data: d, createdAt: dateFromDoc(d.createdAt) });
  }

  const kept = [];
  for (const items of groups.values()) {
    // On ne fusionne que les écritures suffisamment proches pour être
    // considérées comme un doublon accidentel. Deux saisies identiques
    // confirmées comme distinctes à plus de 15 min d'intervalle restent
    // donc visibles dans les statistiques.
    items.sort((a,b) => (a.createdAt?.getTime?.() ?? 0) - (b.createdAt?.getTime?.() ?? 0));
    const clusters = [];
    for (const item of items) {
      const last = clusters[clusters.length - 1];
      const t = item.createdAt?.getTime?.();
      const lt = last?.[last.length - 1]?.createdAt?.getTime?.();
      if (last && t != null && lt != null && Math.abs(t - lt) < DEDUP_WINDOW_MS) last.push(item);
      else clusters.push([item]);
    }
    clusters.forEach(cluster => kept.push(cluster[0]));
  }
  return kept;
}

function aggregate(docs, signMode = 'positive', type = 'generic') {
  const byDay = {};
  const rows = type === 'eclosion' ? dedupeJournalDocs(docs, type) :
               type === 'ponte' ? dedupeJournalDocs(docs, type).filter(r => (Number(r.data.quantite) || 0) > 0) :
               docs.map(snap => ({ snap, data: snap.data() || {} }));
  for (const row of rows) {
    const d = row.data;
    const date = dateFromDoc(d.date);
    if (!date) continue;
    const key = ymd(date);
    const q = Number(d.quantite) || 0;
    if (signMode === 'positive' && q <= 0) continue;
    if (signMode === 'net' && q === 0) continue;
    byDay[key] = (byDay[key] || 0) + q;
  }
  return byDay;
}

function sumJournal(docs, type) {
  const rows = dedupeJournalDocs(docs, type);
  return rows.reduce((sum, row) => sum + (Number(row.data.quantite) || 0), 0);
}

async function readRange(col, start, end) {
  const snap = await getDocs(query(col, where("date", ">=", start), where("date", "<", end)));
  return snap.docs;
}

function renderBanner({ eggs, hatchlings, weekly = false, weekLabel = '' }) {
  const el = document.getElementById(weekly ? 'dashWeeklyBanner' : 'dashActivityBanner');
  if (!el) return;
  if (!weekly && eggs <= 0 && hatchlings <= 0) { el.classList.add('hidden'); el.innerHTML=''; return; }
  if (weekly && eggs <= 0 && hatchlings <= 0) { el.classList.add('hidden'); el.innerHTML=''; return; }
  if (weekly) {
    el.classList.remove('hidden');
    el.className = 'activity-banner weekly';
    el.innerHTML = `<div class="activity-banner-icon">📊</div><div class="activity-banner-main"><div class="eyebrow">Récapitulatif de la semaine passée</div><h3>${weekLabel}</h3><div class="activity-stats"><span>🥚 <b>${formatNumber(eggs)}</b> œufs</span><span>🐣 <b>${formatNumber(hatchlings)}</b> canetons éclos</span></div></div>`;
    return;
  }
  el.classList.remove('hidden');
  el.className = 'activity-banner today';
  const parts = [];
  if (eggs > 0) parts.push(`<span>🥚 <b>${formatNumber(eggs)}</b> œuf(s) enregistré(s) aujourd'hui</span>`);
  if (hatchlings > 0) parts.push(`<span>🐣 <b>${formatNumber(hatchlings)}</b> caneton(s) éclos aujourd'hui</span>`);
  el.innerHTML = `<div class="activity-banner-icon">🌿</div><div class="activity-banner-main"><div class="eyebrow">Activité du jour</div><h3>La ferme vient d'enregistrer de nouvelles données</h3><div class="activity-stats">${parts.join('')}</div></div>`;
}

function renderChart(eggMap, hatchMap, days = 30) {
  const el = document.getElementById('activityTrendChart');
  if (!el) return;
  const end = startOfDay(new Date());
  const points = [];
  for (let i=days-1;i>=0;i--) { const d=new Date(end); d.setDate(d.getDate()-i); const k=ymd(d); points.push({d,k,eggs:eggMap[k]||0,hatch:hatchMap[k]||0}); }
  const max = Math.max(1, ...points.flatMap(p => [p.eggs,p.hatch]));
  const W=520,H=190, padL=38,padR=12,padT=14,padB=28;
  const iw=W-padL-padR, ih=H-padT-padB;
  const x=i=>padL+(i/(points.length-1))*iw;
  const y=v=>padT+ih-(v/max)*ih;
  const poly=(key)=>points.map((p,i)=>`${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const area=(key)=>`M ${x(0)} ${padT+ih} L ${poly(key).replace(/ /g,' L ')} L ${x(points.length-1)} ${padT+ih} Z`;
  const grid=[0,.25,.5,.75,1].map(r=>{const yy=padT+ih-r*ih; const val=Math.round(max*r); return `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" class="chart-grid"/><text x="${padL-6}" y="${yy+4}" text-anchor="end" class="chart-label">${val}</text>`;}).join('');
  const labels=[0,7,14,21,29].map(i=>{const p=points[i]; return `<text x="${x(i)}" y="${H-8}" text-anchor="middle" class="chart-label">${p.d.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'})}</text>`;}).join('');
  const dots=(key, cls)=>points.map((p,i)=>`<circle cx="${x(i)}" cy="${y(p[key])}" r="${p[key]>0?3:1.8}" class="chart-dot ${cls}" data-index="${i}" data-series="${key}" tabindex="0"/>`).join('');
  const hits=points.map((p,i)=>`<rect x="${Math.max(padL,x(i)-7)}" y="${padT}" width="14" height="${ih}" class="chart-hit" data-index="${i}" tabindex="0"/>`).join('');
  el.innerHTML=`<div class="chart-head"><div><span class="eyebrow">30 derniers jours</span><h3>Évolution ponte & éclosion</h3></div><div class="chart-legend"><span><i class="legend-dot eggs"></i>Œufs</span><span><i class="legend-dot hatch"></i>Canetons</span></div></div><div class="chart-interactive"><div class="chart-tooltip" id="activityChartTooltip" hidden></div><div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution des œufs et canetons éclos sur 30 jours"><g>${grid}</g><path d="${area('eggs')}" class="chart-area eggs-area"/><path d="${area('hatch')}" class="chart-area hatch-area"/><polyline points="${poly('eggs')}" class="chart-line eggs-line"/><polyline points="${poly('hatch')}" class="chart-line hatch-line"/><g class="chart-hit-layer">${hits}</g>${dots('eggs','eggs')}${dots('hatch','hatch')}${labels}</svg></div></div>`;

  const tooltip = el.querySelector('#activityChartTooltip');
  const showPoint = (i, anchor) => {
    const p = points[i]; if (!p || !tooltip) return;
    tooltip.innerHTML = `<strong>${p.d.toLocaleDateString('fr-FR',{weekday:'short',day:'2-digit',month:'long'})}</strong><span>🥚 ${formatNumber(p.eggs)} œuf${p.eggs>1?'s':''}</span><span>🐣 ${formatNumber(p.hatch)} caneton${p.hatch>1?'s':''}</span>`;
    tooltip.hidden = false;
    const wrap = el.querySelector('.chart-interactive').getBoundingClientRect();
    const svgRect = anchor?.getBoundingClientRect?.() || wrap;
    const left = Math.min(Math.max(8, svgRect.left - wrap.left + 10), Math.max(8, wrap.width - 170));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = '8px';
  };
  const hidePoint = () => { if (tooltip) tooltip.hidden = true; };
  el.querySelectorAll('.chart-hit,.chart-dot').forEach(node => {
    const i = Number(node.dataset.index);
    node.addEventListener('click', e => { e.stopPropagation(); showPoint(i, node); });
    node.addEventListener('keydown', e => { if (e.key==='Enter' || e.key===' ') { e.preventDefault(); showPoint(i,node); } });
  });
  el.querySelector('.chart-interactive')?.addEventListener('click', e => { if (!e.target.closest('.chart-hit,.chart-dot')) hidePoint(); });
}

async function refreshTrend() {
  try {
    const start = startOfDay(new Date()); start.setDate(start.getDate()-29);
    const end = endOfDay(new Date());
    const [p,e] = await Promise.all([readRange(pontesCol,start,end),readRange(eclosionsCol,start,end)]);
    renderChart(aggregate(p,'positive','ponte'),aggregate(e,'net','eclosion'));
  } catch(err) { console.error('Courbe activité :',err); }
}

async function refreshToday() {
  try {
    const start=startOfDay(new Date()), end=endOfDay(new Date());
    const [p,e]=await Promise.all([readRange(pontesCol,start,end),readRange(eclosionsCol,start,end)]);
    const eggs=sumJournal(p,'ponte');
    const hatch=sumJournal(e,'eclosion');
    renderBanner({eggs,hatchlings:hatch});
  } catch(err) { console.error('Bannière activité :',err); }
}

async function refreshWeeklyIfMonday() {
  const today=startOfDay(new Date());
  if (today.getDay() !== 1) return;
  const end=new Date(today); const start=new Date(today); start.setDate(start.getDate()-7);
  try {
    const [p,e]=await Promise.all([readRange(pontesCol,start,end),readRange(eclosionsCol,start,end)]);
    const eggs=sumJournal(p,'ponte');
    const hatch=sumJournal(e,'eclosion');
    const endLabel=new Date(today); endLabel.setDate(endLabel.getDate()-1);
    const label=`${start.toLocaleDateString('fr-FR',{day:'2-digit',month:'short'})} → ${endLabel.toLocaleDateString('fr-FR',{day:'2-digit',month:'short',year:'numeric'})}`;
    renderBanner({eggs,hatchlings:hatch,weekly:true,weekLabel:label});
  } catch(err) { console.error('Récapitulatif hebdomadaire :',err); }
}

// ---------------------------------------------------------------------
// Rappels de mirage — jour 7 (1ère sélection, œufs clairs) et jour 17
// (contrôle de croissance) après le début de la couvaison. Le rappel
// reste actif jusqu'à ce que le contrôle soit marqué effectué dans la fiche
// du nid ; la bannière est donc un vrai aide-mémoire opérationnel.
// depuis "date_debut_couvaison" (même champ que celui affiché dans
// Nids > le détail du nid).
// ---------------------------------------------------------------------
const MIRAGE_JOURS = [
  { jour: 7, key: "mirage_7", label: "1er mirage — retirer les œufs clairs" },
  { jour: 17, key: "mirage_17", label: "2e mirage — contrôler le développement" }
];

function joursDepuisDebutCouvaison(dateDebut) {
  const d = dateFromDoc(dateDebut);
  if (!d) return null;
  return Math.round((startOfDay(new Date()) - startOfDay(d)) / MS_DAY);
}

function renderMirageBanner(rappels) {
  const el = document.getElementById('dashMirageBanner');
  if (!el) return;
  if (!rappels.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }

  el.classList.remove('hidden');
  el.className = 'activity-banner mirage';

  const sorted = rappels.slice().sort((a, b) => a.nid - b.nid || a.jour - b.jour);
  const countLabel = `${sorted.length} nid${sorted.length > 1 ? 's' : ''} à vérifier`;
  const collapsedKey = 'oleeducks.mirageBanner.collapsed';
  let collapsed = localStorage.getItem(collapsedKey);
  // Par défaut, la bannière est compacte : l'accueil ne doit pas être envahi
  // lorsqu'un grand nombre de nids arrivent simultanément à J7/J17.
  if (collapsed === null) collapsed = 'true';

  const items = sorted.map(r => `
    <div class="mirage-reminder-row">
      <span class="mirage-reminder-main">🔦 Nid n° ${r.nid} — J${r.jour}</span>
      <span class="mirage-reminder-detail">${r.retard ? `En retard de ${r.retard} j · ` : ''}${r.label}</span>
    </div>`).join('');

  el.innerHTML = `
    <div class="activity-banner-icon">🔦</div>
    <div class="activity-banner-main mirage-banner-main">
      <div class="mirage-banner-head">
        <div>
          <div class="eyebrow">À mirer aujourd'hui</div>
          <h3>${countLabel}</h3>
        </div>
        <button type="button" class="btn secondary small mirage-toggle"
          aria-expanded="${collapsed !== 'true'}" aria-controls="mirageReminderList">
          ${collapsed === 'true' ? 'Afficher' : 'Réduire'}
        </button>
      </div>
      <div id="mirageReminderList" class="mirage-reminder-list${collapsed === 'true' ? ' is-collapsed' : ''}">
        ${items}
      </div>
    </div>`;

  const toggle = el.querySelector('.mirage-toggle');
  const list = el.querySelector('#mirageReminderList');
  if (toggle && list) {
    toggle.addEventListener('click', () => {
      const isCollapsed = list.classList.toggle('is-collapsed');
      localStorage.setItem(collapsedKey, String(isCollapsed));
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.textContent = isCollapsed ? 'Afficher' : 'Réduire';
    });
  }
}

async function refreshMirageReminders() {
  try {
    const snap = await getDocs(query(cyclesCol, where('statut', '==', 'couvaison')));
    const rappels = [];
    snap.docs.forEach(docSnap => {
      const c = docSnap.data() || {};
      const jours = joursDepuisDebutCouvaison(c.date_debut_couvaison);
      if (jours === null) return;
      MIRAGE_JOURS.forEach(palier => {
        const state = c[palier.key] || null;
        if (state?.effectue) return;
        if (jours >= palier.jour) {
          rappels.push({ nid: c.nid_numero, jour: palier.jour, label: palier.label, retard: jours > palier.jour ? jours - palier.jour : 0 });
        }
      });
    });
    renderMirageBanner(rappels);
  } catch (err) { console.error('Rappels de mirage :', err); }
}

export function initActiviteAccueil() {
  refreshToday(); refreshWeeklyIfMonday(); refreshTrend(); refreshMirageReminders();
  // Mise à jour immédiate après une nouvelle saisie, sans polling permanent.
  const todayStart=startOfDay(new Date()), todayEnd=endOfDay(new Date());
  try {
    onSnapshot(query(pontesCol,where('date','>=',todayStart),where('date','<',todayEnd)),()=>refreshToday(),e=>console.warn('Pontes accueil :',e));
    onSnapshot(query(eclosionsCol,where('date','>=',todayStart),where('date','<',todayEnd)),()=>refreshToday(),e=>console.warn('Éclosions accueil :',e));
    onSnapshot(query(cyclesCol,where('statut','==','couvaison')),()=>refreshMirageReminders(),e=>console.warn('Rappels de mirage :',e));
  } catch(e) { console.warn('Abonnement activité accueil :',e); }
  // Le jour civil change sans que l'application soit forcément rechargée.
  // Ce petit rafraîchissement garantit que la bannière d'hier disparaît
  // après minuit et que le récapitulatif du lundi apparaît le bon jour.
  setInterval(() => { refreshToday(); refreshWeeklyIfMonday(); refreshMirageReminders(); }, 60000);
  setInterval(refreshTrend, 10 * 60000);
}
