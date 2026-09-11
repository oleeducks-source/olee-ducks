// =====================================================================
// PILOTAGE — Olee Ducks
// Moteur de décision READ-ONLY : aucune écriture Firestore.
// Utilise uniquement les collections déjà existantes.
// =====================================================================
import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const DAY = 86400000;
const toDate = v => v?.toDate ? v.toDate() : new Date(v);
const validDate = v => { const d = toDate(v); return Number.isNaN(d.getTime()) ? null : d; };
const esc = s => String(s ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
const fcfa = n => `${Math.round(Number(n)||0).toLocaleString("fr-FR")} FCFA`;

let timer = null;
let busy = false;

export function initPilotage() {
  const btn = document.getElementById("refreshPilotageBtn");
  btn?.addEventListener("click", () => refreshPilotage(true));
  // Premier calcul après authentification/initialisation des modules.
  refreshPilotage(false);
  window.addEventListener("online", () => refreshPilotage(false));
}

export async function refreshPilotage(force = false) {
  if (busy) return;
  if (!force && timer && Date.now() - timer < 45000) return;
  busy = true;
  const status = document.getElementById("pilotageStatus");
  if (status) status.textContent = "Analyse en cours…";
  try {
    const [ducks, nests, cycles, stocks, tasks, tx, weights] = await Promise.all([
      read("ducks"), read("nests"), read("nest_cycles"), read("stock_items"),
      read("taches"), read("finance_transactions"), read("pesees_journalieres")
    ]);
    const model = analyse({ducks, nests, cycles, stocks, tasks, tx, weights});
    render(model);
    timer = Date.now();
  } catch (e) {
    console.error("Pilotage :", e);
    if (status) status.textContent = "Analyse indisponible — les modules habituels restent inchangés.";
  } finally { busy = false; }
}

async function read(name) {
  const snap = await getDocs(collection(db, name));
  return snap.docs.map(d => ({id:d.id, ...d.data()}));
}

function analyse({ducks,nests,cycles,stocks,tasks,tx,weights}) {
  const now = Date.now();
  const active = ducks.filter(d => d.statut === "actif");
  const total = active.reduce((s,d)=>s+(Number(d.quantite)||1),0);
  const stockAlerts = stocks.filter(i => Number(i.quantite_actuelle||0) <= Number(i.seuil_alerte||0));
  const openTasks = tasks.filter(t => t.statut === "a_faire");
  const overdueTasks = openTasks.filter(t => { const d=validDate(t.date_echeance); return d && d.getTime() < now- DAY; });
  const due48 = openTasks.filter(t => { const d=validDate(t.date_echeance); return d && d.getTime() >= now && d.getTime() <= now+2*DAY; });
  const activeCycles = cycles.filter(c => c.statut === "ponte" || c.statut === "couvaison");
  const hatchSoon = activeCycles.filter(c => c.statut === "couvaison" && c.date_debut_couvaison).map(c => {
    const d=validDate(c.date_debut_couvaison); if(!d)return null;
    const hatch=new Date(d.getTime()+36*DAY); return {...c,hatch,days:Math.ceil((hatch.getTime()-now)/DAY)};
  }).filter(Boolean).filter(c=>c.days<=5).sort((a,b)=>a.hatch-b.hatch);
  const negative = tx.filter(t=>t.type==="depense").reduce((s,t)=>s+(Number(t.montant)||0),0);
  const positive = tx.filter(t=>t.type==="recette").reduce((s,t)=>s+(Number(t.montant)||0),0);
  const recentCut = now-30*DAY;
  const r30=tx.filter(t=>{const d=validDate(t.date);return d&&d.getTime()>=recentCut&&t.type==="recette"}).reduce((s,t)=>s+(Number(t.montant)||0),0);
  const d30=tx.filter(t=>{const d=validDate(t.date);return d&&d.getTime()>=recentCut&&t.type==="depense"}).reduce((s,t)=>s+(Number(t.montant)||0),0);
  const latestWeight = [...weights].sort((a,b)=>(validDate(b.date)?.getTime()||0)-(validDate(a.date)?.getTime()||0))[0] || null;

  // Score transparent : il sert à prioriser, pas à prétendre mesurer la santé animale.
  let score=100;
  score -= Math.min(30, overdueTasks.length*10);
  score -= Math.min(20, stockAlerts.length*7);
  score -= Math.min(15, hatchSoon.length*5);
  if (total===0) score-=10;
  if (openTasks.length>8) score-=5;
  score=Math.max(0,Math.min(100,score));

  const actions=[];
  overdueTasks.slice(0,2).forEach(t=>actions.push({kind:"danger",icon:"⏰",title:t.titre,sub:"Tâche en retard",page:"taches"}));
  stockAlerts.slice(0,2).forEach(i=>actions.push({kind:"warn",icon:"🌾",title:i.nom,sub:`Stock ${i.quantite_actuelle} ${i.unite} — seuil ${i.seuil_alerte}`,page:"stocks"}));
  hatchSoon.slice(0,2).forEach(c=>actions.push({kind:"ok",icon:"🐣",title:`Nid ${c.nid_numero}`,sub:c.days<=0?"Éclosion attendue maintenant":`Éclosion prévue dans ${c.days} j`,page:"nids"}));
  if(!actions.length && due48.length) actions.push({kind:"ok",icon:"📋",title:due48[0].titre,sub:"Échéance dans les 48 h",page:"taches"});
  if(!actions.length) actions.push({kind:"ok",icon:"✓",title:"Aucune priorité critique",sub:"La ferme ne présente pas d’alerte majeure détectée.",page:null});

  return {total,active,stockAlerts,openTasks,overdueTasks,due48,activeCycles,hatchSoon,positive,negative,r30,d30,latestWeight,score,actions,nests};
}

function render(m) {
  const scoreEl=document.getElementById("pilotScore");
  if(scoreEl) scoreEl.textContent=`${m.score}/100`;
  const scoreSub=document.getElementById("pilotScoreSub");
  if(scoreSub) scoreSub.textContent=m.score>=85?"Situation maîtrisée":m.score>=65?"Quelques points à surveiller":"Attention requise";
  const actions=document.getElementById("pilotActions");
  if(actions) actions.innerHTML=m.actions.map(a=>`<button class="pilot-action ${a.kind}" data-page="${a.page||""}" ${a.page?"":"disabled"}><span class="pilot-action-icon">${a.icon}</span><span><b>${esc(a.title)}</b><small>${esc(a.sub)}</small></span><span class="pilot-arrow">${a.page?"→":""}</span></button>`).join("");
  actions?.querySelectorAll("button[data-page]").forEach(b=>b.addEventListener("click",()=>document.querySelector(`.nav-item[data-page="${b.dataset.page}"]`)?.click()));
  const facts=document.getElementById("pilotFacts");
  if(facts) facts.innerHTML=`
    <div><b>${m.total}</b><span>canards actifs</span></div>
    <div><b>${m.activeCycles.length}</b><span>cycles en cours</span></div>
    <div><b>${m.stockAlerts.length}</b><span>alertes stock</span></div>
    <div><b>${m.overdueTasks.length}</b><span>tâches en retard</span></div>`;
  const finance=document.getElementById("pilotFinance");
  if(finance) finance.innerHTML=`<div><span>30 derniers jours</span><b>${fcfa(m.r30-m.d30)}</b></div><div><span>Recettes</span><b>${fcfa(m.r30)}</b></div><div><span>Dépenses</span><b>${fcfa(m.d30)}</b></div>`;
  const weight=document.getElementById("pilotWeight");
  if(weight) weight.innerHTML=m.latestWeight?`Dernière pesée : <b>${Number(m.latestWeight.poids_moyen_g)||0} g</b> · ${esc(m.latestWeight.type||"lot")} · ${validDate(m.latestWeight.date)?.toLocaleDateString("fr-FR")||"date inconnue"}`:`Aucune pesée enregistrée. Ajoutez-en une depuis un lot pour activer ce suivi.`;
  const status=document.getElementById("pilotageStatus"); if(status) status.textContent=`Mis à jour à ${new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})} · lecture seule`;
}
