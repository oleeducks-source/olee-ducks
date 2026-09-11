// =====================================================================
// APP.JS — Point d'entrée. Initialise Firebase, la navigation entre les
// 5 pages, et délègue chaque domaine métier à son propre module.
// =====================================================================
import { auth, authReady, firebaseApp } from "./firebase-config.js";
import { getUserName, ensureUserProfile, promptChangeUserName } from "./utils.js";
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("Service worker non enregistré :", err));
  }
}

boot();
