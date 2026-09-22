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
const MS_DAY = 86400000;

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d) { const x = startOfDay(d); x.setDate(x.getDate()+1); return x; }
function ymd(d) { return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-'); }
function dateFromDoc(v) { if (!v) return null; const d = v?.toDate ? v.toDate() : new Date(v); return isNaN(d.getTime()) ? null : d; }
function formatNumber(n) { return Number(n || 0).toLocaleString('fr-FR'); }
function mondayStart(d) { const x = startOfDay(d); const day = x.getDay(); const delta = day === 0 ? -6 : 1 - day; x.setDate(x.getDate()+delta); return x; }

// Certains doublons historiques peuvent exister dans les journaux
// (avant la mise en place du verrou atomique). L'accueil ne doit pas
// recompter une même vague deux fois. On déduplique donc les événements
// qui ont exactement le même contexte métier et ont été créés à quelques
// minutes d'intervalle. Les vraies vagues séparées dans le temps restent
// comptées.
const JOURNAL_DEDUP_MS = 5 * 60 * 1000;

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
    if (!date || q <= 0) continue;
    const key = journalKey(d, type);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ snap, data: d, createdAt: dateFromDoc(d.createdAt) });
  }

  const kept = [];
  for (const items of groups.values()) {
    items.sort((a, b) => {
      const ta = a.createdAt?.getTime?.() ?? Number.MAX_SAFE_INTEGER;
      const tb = b.createdAt?.getTime?.() ?? Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });
    let lastAccepted = null;
    for (const item of items) {
      const t = item.createdAt?.getTime?.();
      // Les anciennes lignes peuvent ne pas avoir createdAt : dans ce cas,
      // on ne les fusionne pas arbitrairement.
      if (lastAccepted !== null && Number.isFinite(t) && (t - lastAccepted) <= JOURNAL_DEDUP_MS) {
        continue;
      }
      kept.push(item);
      if (Number.isFinite(t)) lastAccepted = t;
    }
  }
  return kept;
}

function aggregate(docs, signMode = 'positive', type = 'generic') {
  const byDay = {};
  const rows = type === 'eclosion' ? dedupeJournalDocs(docs, type) :
               type === 'ponte' ? dedupeJournalDocs(docs, type) :
               docs.map(snap => ({ snap, data: snap.data() || {} }));
  for (const row of rows) {
    const d = row.data;
    const date = dateFromDoc(d.date);
    if (!date) continue;
    const key = ymd(date);
    const q = Number(d.quantite) || 0;
    if (signMode === 'positive' && q <= 0) continue;
    byDay[key] = (byDay[key] || 0) + q;
  }
  return byDay;
}

function sumJournal(docs, type) {
  return dedupeJournalDocs(docs, type).reduce((sum, row) => sum + (Number(row.data.quantite) || 0), 0);
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
  const W=520,H=190, padL=34,padR=12,padT=14,padB=28;
  const iw=W-padL-padR, ih=H-padT-padB;
  const x=i=>padL+(i/(points.length-1))*iw;
  const y=v=>padT+ih-(v/max)*ih;
  const poly=(key)=>points.map((p,i)=>`${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const area=(key)=>`M ${x(0)} ${padT+ih} L ${poly(key).replace(/ /g,' L ')} L ${x(points.length-1)} ${padT+ih} Z`;
  const grid=[0,.25,.5,.75,1].map(r=>{const yy=padT+ih-r*ih; const val=Math.round(max*r); return `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" class="chart-grid"/><text x="${padL-6}" y="${yy+4}" text-anchor="end" class="chart-label">${val}</text>`;}).join('');
  const labels=[0,7,14,21,29].map(i=>{const p=points[i]; return `<text x="${x(i)}" y="${H-8}" text-anchor="middle" class="chart-label">${p.d.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'})}</text>`;}).join('');
  const dots=(key, cls)=>points.map((p,i)=>p[key]>0?`<circle cx="${x(i)}" cy="${y(p[key])}" r="2.4" class="chart-dot ${cls}"/>`:'' ).join('');
  el.innerHTML=`<div class="chart-head"><div><span class="eyebrow">30 derniers jours</span><h3>Évolution ponte & éclosion</h3></div><div class="chart-legend"><span><i class="legend-dot eggs"></i>Œufs</span><span><i class="legend-dot hatch"></i>Canetons</span></div></div><div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution des œufs et canetons éclos sur 30 jours"><g>${grid}</g><path d="${area('eggs')}" class="chart-area eggs-area"/><path d="${area('hatch')}" class="chart-area hatch-area"/><polyline points="${poly('eggs')}" class="chart-line eggs-line"/><polyline points="${poly('hatch')}" class="chart-line hatch-line"/>${dots('eggs','eggs')}${dots('hatch','hatch')}${labels}</svg></div>`;
}

async function refreshTrend() {
  try {
    const start = startOfDay(new Date()); start.setDate(start.getDate()-29);
    const end = endOfDay(new Date());
    const [p,e] = await Promise.all([readRange(pontesCol,start,end),readRange(eclosionsCol,start,end)]);
    renderChart(aggregate(p,'net','ponte'),aggregate(e,'positive','eclosion'));
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

export function initActiviteAccueil() {
  refreshToday(); refreshWeeklyIfMonday(); refreshTrend();
  // Mise à jour immédiate après une nouvelle saisie, sans polling permanent.
  const todayStart=startOfDay(new Date()), todayEnd=endOfDay(new Date());
  try {
    onSnapshot(query(pontesCol,where('date','>=',todayStart),where('date','<',todayEnd)),()=>refreshToday(),e=>console.warn('Pontes accueil :',e));
    onSnapshot(query(eclosionsCol,where('date','>=',todayStart),where('date','<',todayEnd)),()=>refreshToday(),e=>console.warn('Éclosions accueil :',e));
  } catch(e) { console.warn('Abonnement activité accueil :',e); }
  // Le jour civil change sans que l'application soit forcément rechargée.
  // Ce petit rafraîchissement garantit que la bannière d'hier disparaît
  // après minuit et que le récapitulatif du lundi apparaît le bon jour.
  setInterval(() => { refreshToday(); refreshWeeklyIfMonday(); }, 60000);
  setInterval(refreshTrend, 10 * 60000);
}
