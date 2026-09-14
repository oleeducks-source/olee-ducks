// =====================================================================
// APP.JS — Point d'entrée. Initialise Firebase, la navigation entre les
// 5 pages, et délègue chaque domaine métier à son propre module.
// =====================================================================
import { auth, authReady, firebaseApp } from "./firebase-config.js";
import { getUserName, ensureUserProfile, promptChangeUserName, openModal } from "./utils.js";
import { initInventaire, openAddDuckModal } from "./inventaire.js";
import { initNests } from "./nids.js";
import { initFinances, openAddFinanceModal } from "./finances.js";
import { initStocks, openAddStockItemModal } from "./stocks.js";
import { initComptabilite } from "./comptabilite.js";
import { initRapport } from "./rapport.js";
import { initNotifications } from "./notifications.js";
import { initTaches, openAddTacheModal } from "./taches.js";
import { initSauvegarde } from "./sauvegarde.js";
import { initPesees } from "./pesees.js";
import { initValorisation } from "./valorisation.js";

const PAGES = ["dashboard", "canards", "nids", "finances", "stocks", "taches"];
let currentPage = "dashboard";

function setPage(page) {
  currentPage = page;
  PAGES.forEach(p => {
    document.getElementById(`page-${p}`).classList.toggle("hidden", p !== page);
  });
  document.getElementById("page-compta").classList.add("hidden");
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });
  // Le "+" n'a aucun sens dans le suivi des nids (les nids se gèrent en
  // touchant directement une case de la grille) : on masque le bouton.
  document.getElementById("fabAdd").classList.toggle("hidden", page === "nids");
  if (page === "dashboard") {
    const d = new Date();
    document.getElementById("dashDate").textContent =
      "Bonjour — " + d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  }
  window.scrollTo(0, 0);
}

function initNav() {
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => setPage(btn.dataset.page));
  });
}

function initUserChip() {
  const label = document.getElementById("userChipLabel");
  label.textContent = getUserName() || "…";
  document.getElementById("userChip").addEventListener("click", promptChangeUserName);
}

// Actions rapides du tableau de bord : chacune réutilise soit une modale
// déjà exportée par son module métier, soit le bouton de navigation
// existant (même convention que openPoidsBtn / openTachesBtn ci-dessus
// dans pesees.js / taches.js). Aucune logique métier n'est dupliquée ici.
// Menu KPI — résumé en un coup d'œil de tous les indicateurs déjà
// calculés et affichés sur le tableau de bord (finances, cheptel, nids,
// stocks). Ne relit rien dans Firestore : se contente de lire les
// valeurs déjà rendues à l'écran par chaque module métier, pour rester
// toujours cohérent avec ce que l'utilisateur voit déjà.
function txt(id) { return document.getElementById(id)?.textContent?.trim() || "—"; }
function openKpiSummaryModal() {
  openModal("Résumé KPI", `
    <div class="section-title" style="margin:0 0 8px;"><div><span class="eyebrow">Finances</span><h2 style="font-size:15px;">Trésorerie</h2></div></div>
    <div class="card">
      <div class="row"><div class="row-main"><span class="row-title">Balance commerciale</span></div><span class="row-value">${txt("kpiBalance")}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Recettes</span></div><span class="row-value pos">${txt("kpiRecettes")}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Dépenses</span></div><span class="row-value neg">${txt("kpiDepenses")}</span></div>
    </div>

    <div class="section-title" style="margin:20px 0 8px;"><div><span class="eyebrow">Élevage</span><h2 style="font-size:15px;">Cheptel &amp; nids</h2></div></div>
    <div class="card">
      <div class="row"><div class="row-main"><span class="row-title">Canards au total</span></div><span class="row-value">${txt("kpiTotalCanards")}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Œufs dans les nids</span></div><span class="row-value">${txt("kpiOeufsNids")}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Taux d'éclosion moyen</span></div><span class="row-value">${txt("kpiTauxEclosion")}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Nids libres / ponte / couvaison</span></div><span class="row-value">${txt("nestCountLibre")} / ${txt("nestCountPonte")} / ${txt("nestCountCouvaison")}</span></div>
    </div>

    <div class="section-title" style="margin:20px 0 8px;"><div><span class="eyebrow">Organisation</span><h2 style="font-size:15px;">Stocks &amp; tâches</h2></div></div>
    <div class="card">
      <div class="row"><div class="row-main"><span class="row-title">Alertes stock</span></div><span class="row-value">${txt("kpiAlertesStock")}</span></div>
    </div>
    <p class="subtle" style="margin-top:10px;">Ce résumé reflète les mêmes chiffres que le tableau de bord, à l'instant où vous l'ouvrez.</p>
  `);
}

function initQuickActions() {
  document.getElementById("qaAddRecette")?.addEventListener("click", () => openAddFinanceModal("recette"));
  document.getElementById("qaAddDepense")?.addEventListener("click", () => openAddFinanceModal("depense"));
  document.getElementById("qaAddTache")?.addEventListener("click", () => openAddTacheModal());
  document.getElementById("qaAddPesee")?.addEventListener("click", () => {
    document.querySelector('.nav-item[data-page="canards"]')?.click();
  });
  document.getElementById("openStocksFromWatchBtn")?.addEventListener("click", () => {
    document.querySelector('.nav-item[data-page="stocks"]')?.click();
  });
  document.getElementById("openInventaireFromDashBtn")?.addEventListener("click", () => {
    document.querySelector('.nav-item[data-page="canards"]')?.click();
  });
  document.getElementById("openKpiSummaryBtn")?.addEventListener("click", openKpiSummaryModal);
}

function initFab() {
  document.getElementById("fabAdd").addEventListener("click", () => {
    switch (currentPage) {
      case "canards": openAddDuckModal(); break;
      case "finances": openAddFinanceModal(); break;
      case "stocks": openAddStockItemModal(); break;
      case "taches": openAddTacheModal(); break;
      default:
        // Sur le tableau de bord, propose l'action la plus fréquente
        openAddFinanceModal();
    }
  });
}

let firebaseOk = false;

function initConnectionStatus() {
  const dot = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  const update = () => {
    if (!firebaseOk) return; // ne pas écraser un message d'erreur Firebase affiché par ailleurs
    const online = navigator.onLine;
    dot.classList.toggle("offline", !online);
    label.textContent = online ? "Synchronisé" : "Hors ligne — en attente";
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

function showConfigError(err) {
  const banner = document.getElementById("errorBanner");
  const dot = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  dot.classList.add("offline");
  label.textContent = "Non connecté";

  let hint = "Vérifiez la configuration Firebase.";
  const code = err?.code || "";
  if (code.includes("invalid-api-key") || code.includes("api-key")) {
    hint = "La clé API dans js/firebase-config.js semble incorrecte ou n'a pas été remplacée (valeur REMPLACER_... encore présente).";
  } else if (code.includes("admin-restricted-operation") || code.includes("operation-not-allowed")) {
    hint = "L'authentification Anonyme n'est probablement pas activée : Console Firebase > Authentication > Sign-in method > Anonyme.";
  } else if (code.includes("permission-denied")) {
    hint = "Les règles Firestore bloquent l'écriture : vérifiez qu'elles ont bien été publiées (onglet Règles) avec le contenu du fichier firestore.rules.";
  } else if (code.includes("project-not-found") || code.includes("invalid-argument")) {
    hint = "Le projectId ou l'un des identifiants dans js/firebase-config.js ne correspond à aucun projet Firebase existant.";
  }
  banner.innerHTML = `⚠️ Connexion à la base de données impossible.<br>${hint}<br><span style="opacity:.75">Détail technique : ${code || err?.message || "inconnu"}</span><br><span style="opacity:.75">Config chargée — projectId: ${firebaseApp?.options?.projectId || "?"} · apiKey: ${maskKey(firebaseApp?.options?.apiKey)}</span>`;
  banner.classList.remove("hidden");
}

function maskKey(k) {
  if (!k) return "absente";
  if (k.startsWith("REMPLACER")) return "REMPLACER_... (jamais configurée)";
  if (k.length < 10) return k;
  return `${k.slice(0, 6)}…${k.slice(-4)} (${k.length} caractères)`;
}

async function boot() {
  initNav();
  initFab();
  initQuickActions();
  initUserChip();
  initConnectionStatus();
  setPage("dashboard");

  ensureUserProfile().then(() => {
    document.getElementById("userChipLabel").textContent = getUserName();
  });

  try {
    await authReady;
    firebaseOk = true;
    document.getElementById("syncLabel").textContent = "Synchronisé";
  } catch (e) {
    showConfigError(e);
  }

  initInventaire();
  initNests();
  initFinances();
  initStocks();
  initComptabilite();
  initRapport();
  initNotifications();
  initTaches();
  initSauvegarde();
  initPesees();
  initValorisation();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("Service worker non enregistré :", err));
  }
}

boot();
