// =====================================================================
// APP.JS — Point d'entrée. Initialise Firebase, la navigation (5
// destinations + panneau de tâches global + écran Notifications + menu
// compte), et délègue chaque domaine métier à son propre module.
// =====================================================================
import { auth, authReady, firebaseApp } from "./firebase-config.js";
import { getUserName, ensureUserProfile, promptChangeUserName, onAttentionChange, toast } from "./utils.js";
import { initInventaire, openAddDuckModal } from "./inventaire.js";
import { initNests } from "./nids.js";
import { initFinances, openAddFinanceModal } from "./finances.js";
import { initStocks, openAddStockItemModal } from "./stocks.js";
import { initComptabilite } from "./comptabilite.js";
import { initRapport, openRapportChoiceModal } from "./rapport.js";
import { initNotifications, renderNotificationsFeed, notificationsActives, toggleNotifications } from "./notifications.js";
import { initTaches, openAddTacheModal } from "./taches.js";
import { initSauvegarde, ouvrirSauvegardeModal } from "./sauvegarde.js";
import { initPesees } from "./pesees.js";

// Les 5 destinations primaires de la barre basse / de la sidebar (voir
// architecture UX, section D). Tâches (panneau global), Comptabilité
// (sous Finances) et Notifications sont gérées à part, hors de ce plan.
const PAGES = ["dashboard", "nids", "canards", "stocks", "finances"];
let currentPage = "dashboard";

function setPage(page) {
  currentPage = page;
  PAGES.forEach(p => {
    document.getElementById(`page-${p}`).classList.toggle("hidden", p !== page);
  });
  document.getElementById("page-compta").classList.add("hidden");
  document.getElementById("page-notifications").classList.add("hidden");
  document.querySelectorAll(".nav-item, .sidebar-link[data-page]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });
  // Le "+" n'a aucun sens dans le suivi des nids (les nids se gèrent en
  // touchant directement une case de la grille) : on masque le bouton.
  document.getElementById("fabAdd").classList.toggle("hidden", page === "nids");
  document.getElementById("app").scrollTo?.(0, 0);
  window.scrollTo(0, 0);
}

function initNav() {
  document.querySelectorAll(".nav-item, .sidebar-link[data-page]").forEach(btn => {
    btn.addEventListener("click", () => setPage(btn.dataset.page));
  });
}

// ---------------------------------------------------------------------
// Écran Notifications — atteint depuis le clignotant de l'en-tête (mobile
// et desktop), pas depuis le plan de navigation principal. Le réglage
// d'activation (navigateur) vit ici, séparé de la simple consultation.
// ---------------------------------------------------------------------
function openNotificationsPage() {
  PAGES.forEach(p => document.getElementById(`page-${p}`).classList.add("hidden"));
  document.getElementById("page-compta").classList.add("hidden");
  document.getElementById("page-notifications").classList.remove("hidden");
  document.querySelectorAll(".nav-item, .sidebar-link[data-page]").forEach(btn => btn.classList.remove("active"));
  document.getElementById("fabAdd").classList.add("hidden");
  refreshNotifToggleBtn();
  renderNotificationsFeed();
  window.scrollTo(0, 0);
}

function refreshNotifToggleBtn() {
  const btn = document.getElementById("notifToggleBtn");
  if (!btn) return;
  const on = notificationsActives();
  btn.textContent = on ? "Désactiver" : "Activer";
  btn.classList.toggle("secondary", true);
}

function initNotifPage() {
  document.getElementById("notifBell")?.addEventListener("click", openNotificationsPage);
  document.getElementById("sidebarOpenNotifs")?.addEventListener("click", openNotificationsPage);
  document.getElementById("notifToggleBtn")?.addEventListener("click", async () => {
    await toggleNotifications();
    refreshNotifToggleBtn();
  });
}

// ---------------------------------------------------------------------
// Panneau de tâches — global, accessible depuis n'importe quel écran
// (bouton de l'en-tête / de la sidebar), au-dessus du contenu en cours
// plutôt que dans la barre basse (voir E6 de la direction design).
// ---------------------------------------------------------------------
function openTachesPanel() {
  document.getElementById("page-taches").classList.remove("hidden");
}
function closeTachesPanel() {
  document.getElementById("page-taches").classList.add("hidden");
}
function initTachesPanel() {
  document.getElementById("tasksBell")?.addEventListener("click", openTachesPanel);
  document.getElementById("sidebarOpenTaches")?.addEventListener("click", openTachesPanel);
  document.getElementById("tachesPanelClose")?.addEventListener("click", closeTachesPanel);
  document.getElementById("tachesPanelBackdrop")?.addEventListener("click", closeTachesPanel);
}

// ---------------------------------------------------------------------
// Menu compte — regroupe les réglages secondaires qui n'ont pas leur
// propre destination : changer de prénom, sauvegarde, rapports & exports,
// import de comptabilité (voir architecture UX, section D).
// ---------------------------------------------------------------------
function closeAccountMenu() {
  document.getElementById("accountMenuRoot").innerHTML = "";
}

function openAccountMenu(anchorEl) {
  const root = document.getElementById("accountMenuRoot");
  const rect = anchorEl.getBoundingClientRect();
  const onRight = rect.left > window.innerWidth / 2;
  const style = onRight
    ? `top:${Math.round(rect.bottom + 8)}px; right:${Math.round(window.innerWidth - rect.right)}px;`
    : `top:${Math.round(rect.bottom + 8)}px; left:${Math.round(rect.left)}px;`;
  root.innerHTML = `
    <div class="account-menu-backdrop" id="accountMenuBackdrop"></div>
    <div class="account-menu" style="${style}">
      <button class="account-menu-item" id="amChangeName"><svg><use href="#i-person"/></svg>Changer de prénom (${getUserName() || "…"})</button>
      <div class="account-menu-sep"></div>
      <button class="account-menu-item" id="amRapports"><svg><use href="#i-download"/></svg>Rapports &amp; exports</button>
      <button class="account-menu-item" id="amSauvegarde"><svg><use href="#ic-task-sauvegarde"/></svg>Sauvegarder les données</button>
      <a class="account-menu-item" href="import-comptabilite.html" target="_blank" rel="noopener"><svg><use href="#i-chev-right"/></svg>Importer une comptabilité</a>
    </div>
  `;
  document.getElementById("accountMenuBackdrop").addEventListener("click", closeAccountMenu);
  document.getElementById("amChangeName").addEventListener("click", () => { closeAccountMenu(); promptChangeUserName(); });
  document.getElementById("amRapports").addEventListener("click", () => { closeAccountMenu(); openRapportChoiceModal(); });
  document.getElementById("amSauvegarde").addEventListener("click", () => { closeAccountMenu(); ouvrirSauvegardeModal(); });
}

function initAccountMenu() {
  document.getElementById("userChip")?.addEventListener("click", (e) => openAccountMenu(e.currentTarget));
  document.getElementById("sidebarAccountBtn")?.addEventListener("click", (e) => openAccountMenu(e.currentTarget));
}

function initUserChip() {
  const label = document.getElementById("userChipLabel");
  const sidebarLabel = document.getElementById("sidebarAccountLabel");
  const name = getUserName() || "…";
  if (label) label.textContent = name;
  if (sidebarLabel) sidebarLabel.textContent = name;
}

// ---------------------------------------------------------------------
// Écran "Aujourd'hui" — verdict en une phrase + liste "À traiter",
// alimentés par le registre partagé (voir utils.js : setAttentionItems,
// appelé par stocks.js / taches.js / pesees.js à chaque mise à jour de
// leurs données respectives).
// ---------------------------------------------------------------------
function renderAttentionDashboard(items) {
  const headline = document.getElementById("dashVerdictHeadline");
  const list = document.getElementById("dashAttnList");
  if (!headline || !list) return;

  headline.textContent = items.length
    ? `${items.length} élément${items.length > 1 ? "s" : ""} demande${items.length > 1 ? "nt" : ""} votre attention`
    : "Tout est sous contrôle aujourd'hui";

  if (!items.length) {
    list.innerHTML = `<div class="attn-row" style="border-left-color:var(--success-fg);"><div class="row-main"><span class="attn-title">Rien à signaler</span><span class="attn-sub">Aucune alerte de stock, tâche urgente ou pesée en retard.</span></div></div>`;
    return;
  }
  list.innerHTML = items.map((it, i) => `
    <div class="attn-row ${it.severity}" data-i="${i}">
      <div class="row-main"><span class="attn-title">${it.title}</span><span class="attn-sub">${it.sub || ""}</span></div>
      <span class="attn-action">${it.action || "Voir"}</span>
    </div>
  `).join("");
  list.querySelectorAll(".attn-row[data-i]").forEach(el => {
    el.addEventListener("click", () => items[Number(el.dataset.i)].onClick?.());
  });
}

function initDashboardAttention() {
  onAttentionChange(renderAttentionDashboard);
}

// Raccourcis de navigation du tableau de bord ("Voir tout →" sur la
// carte Répartition). La rangée "Actions rapides" a été retirée du
// tableau de bord (choix déjà en place sur `main`, conservé ici) : les
// mêmes actions restent joignables via le bouton d'action (FAB) et la
// navigation normale.
function initDashboardShortcuts() {
  document.getElementById("openInventaireFromDashBtn")?.addEventListener("click", () => {
    document.querySelector('.nav-item[data-page="canards"], .sidebar-link[data-page="canards"]')?.click();
  });
}

function initFab() {
  document.getElementById("fabAdd").addEventListener("click", () => {
    switch (currentPage) {
      case "canards": openAddDuckModal(); break;
      case "finances": openAddFinanceModal(); break;
      case "stocks": openAddStockItemModal(); break;
      default:
        // Sur "Aujourd'hui", propose l'action la plus fréquente
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
  initDashboardShortcuts();
  initUserChip();
  initAccountMenu();
  initTachesPanel();
  initNotifPage();
  initDashboardAttention();
  initConnectionStatus();
  setPage("dashboard");

  const d = new Date();
  const dateLabel = document.getElementById("dashDate");
  if (dateLabel) dateLabel.textContent = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

  ensureUserProfile().then(() => { initUserChip(); });

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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("Service worker non enregistré :", err));
  }
}

boot();
