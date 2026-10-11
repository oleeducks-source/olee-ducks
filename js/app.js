// =====================================================================
// APP.JS — Point d'entrée. Initialise Firebase, la connexion email,
// la navigation entre les pages, et délègue chaque domaine métier à
// son propre module.
//
// NOUVEAU (rôles) :
// - Écran de connexion obligatoire (admin ou user)
// - Routage adapté au rôle : admin = tout, user = tâches uniquement
// - Déconnexion forcée si bannissement / interruption de session
// - Masquage automatique des éléments .admin-only pour les users
// =====================================================================
import { authReady, firebaseApp } from "./firebase-config.js";
import {
  initAuth, attendreAuth, signIn, signOut as authSignOut,
  resetPassword, getProfil, estAdmin, estUser,
  doitEtreDeconnecte, raisonDeconnexion, marquerSessionActive, onAuthChange
} from "./auth.js";
import { getUserName, openModal, closeModal, toast, escapeHtml } from "./utils.js";
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
import { initActiviteAccueil } from "./activite.js";
import { initUtilisateurs } from "./utilisateurs.js";

// ---------------------------------------------------------------------
// Pages accessibles selon le rôle
// ---------------------------------------------------------------------
const PAGES_ADMIN = ["dashboard", "canards", "nids", "finances", "stocks", "taches"];
const PAGES_USER  = ["taches"];  // un user simple ne voit QUE ses tâches
const TOUTES_PAGES = ["dashboard", "canards", "nids", "finances", "stocks", "taches", "compta", "utilisateurs"];

let currentPage = "dashboard";
let roleCourant = null; // "admin" | "user" | null
let modulesInit = false; // évite d'initialiser les modules métier plusieurs fois

// ---------------------------------------------------------------------
// Affichage / masquage des écrans principaux
// ---------------------------------------------------------------------
function afficherEcran(nom) {
  // nom : "login" | "loading" | "app" | "forceLogout"
  document.getElementById("loginScreen").classList.toggle("hidden", nom !== "login");
  document.getElementById("loadingScreen").classList.toggle("hidden", nom !== "loading");
  document.getElementById("app").classList.toggle("hidden", nom !== "app");
  document.getElementById("forceLogoutScreen").classList.toggle("hidden", nom !== "forceLogout");
}

function afficherErreurLogin(message) {
  const el = document.getElementById("loginError");
  if (!el) return;
  if (!message) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.innerHTML = `<span class="glyph">⚠️</span><span>${escapeHtml(message)}</span>`;
  el.classList.remove("hidden");
}

// ---------------------------------------------------------------------
// Navigation (adaptée au rôle)
// ---------------------------------------------------------------------
function pagesAutorisees() {
  if (roleCourant === "admin") return PAGES_ADMIN;
  if (roleCourant === "user") return PAGES_USER;
  return [];
}

function appliquerRestrictionsRole() {
  const autorisees = pagesAutorisees();
  const isAdmin = roleCourant === "admin";

  // Cache les onglets de la bottom-nav non autorisés
  document.querySelectorAll(".nav-item").forEach(btn => {
    const page = btn.dataset.page;
    btn.classList.toggle("hidden", !autorisees.includes(page));
  });

  // Cache tous les boutons marqués admin-only
  document.querySelectorAll(".admin-only").forEach(el => {
    el.classList.toggle("hidden", !isAdmin);
  });

  // Masque les pages HTML non autorisées
  TOUTES_PAGES.forEach(p => {
    const section = document.getElementById(`page-${p}`);
    if (!section) return;
    if (!autorisees.includes(p) && p !== "compta" && p !== "utilisateurs") {
      section.classList.add("hidden");
    }
  });
}

function setPage(page) {
  // Sécurité : refuse une page non autorisée pour le rôle courant
  if (!pagesAutorisees().includes(page) && page !== "compta" && page !== "utilisateurs") {
    page = pagesAutorisees()[0] || "dashboard";
  }
  // Blocage absolu : user ne peut pas aller sur compta/utilisateurs
  if (roleCourant !== "admin" && (page === "compta" || page === "utilisateurs")) {
    page = "taches";
  }

  currentPage = page;
  TOUTES_PAGES.forEach(p => {
    const section = document.getElementById(`page-${p}`);
    if (section) section.classList.add("hidden");
  });
  const section = document.getElementById(`page-${page}`);
  if (section) section.classList.remove("hidden");

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });

  // Le "+" n'a aucun sens dans Nids (les nids se gèrent en touchant la grille)
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

// ---------------------------------------------------------------------
// Chip utilisateur (nom en haut à droite)
// ---------------------------------------------------------------------
function initUserChip() {
  const chip = document.getElementById("userChip");
  if (!chip) return;
  chip.addEventListener("click", () => {
    const profil = getProfil();
    if (!profil) return;
    openModal("Mon compte", `
      <div class="row"><div class="row-main"><span class="row-title">Nom</span></div><span class="row-value">${escapeHtml(profil.nom || "—")}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Email</span></div><span class="row-value mono">${escapeHtml(profil.email || "—")}</span></div>
      <div class="row"><div class="row-main"><span class="row-title">Rôle</span></div><span class="row-value">${profil.role === "admin" ? "Administrateur" : "Utilisateur simple"}</span></div>
      <div class="spacer-m"></div>
      <button class="btn danger" id="logoutBtn">Se déconnecter</button>
    `, {
      onMount: () => {
        document.getElementById("logoutBtn").addEventListener("click", async () => {
          if (!confirm("Se déconnecter de l'application ?")) return;
          closeModal();
          await authSignOut();
        });
      }
    });
  });
}

function mettreAJourChip() {
  const label = document.getElementById("userChipLabel");
  if (!label) return;
  const profil = getProfil();
  label.textContent = profil?.nom || profil?.email || "…";
}

// ---------------------------------------------------------------------
// Actions rapides (dashboard)
// ---------------------------------------------------------------------
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
        if (roleCourant === "admin") openAddFinanceModal();
        else openAddTacheModal(); // un user simple ne peut créer que des tâches
    }
  });
}

// ---------------------------------------------------------------------
// Statut de connexion (dot vert/orange)
// ---------------------------------------------------------------------
let firebaseOk = false;
function initConnectionStatus() {
  const dot = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  const update = () => {
    if (!firebaseOk) return;
    const online = navigator.onLine;
    dot.classList.toggle("offline", !online);
    label.textContent = online ? "Synchronisé" : "Hors ligne";
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

// ---------------------------------------------------------------------
// Erreurs de configuration Firebase (inchangé)
// ---------------------------------------------------------------------
function showConfigError(err) {
  const banner = document.getElementById("errorBanner");
  if (!banner) return;
  const dot = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  if (dot) dot.classList.add("offline");
  if (label) label.textContent = "Non connecté";
  let hint = "Vérifiez la configuration Firebase.";
  const code = err?.code || "";
  if (code.includes("invalid-api-key") || code.includes("api-key")) {
    hint = "La clé API dans js/firebase-config.js semble incorrecte.";
  } else if (code.includes("admin-restricted-operation") || code.includes("operation-not-allowed")) {
    hint = "L'authentification Email/Mot de passe n'est pas activée dans la console Firebase.";
  } else if (code.includes("permission-denied")) {
    hint = "Les règles Firestore bloquent l'accès. Vérifiez qu'elles ont bien été publiées.";
  } else if (code.includes("project-not-found")) {
    hint = "Le projectId dans js/firebase-config.js ne correspond à aucun projet existant.";
  }
  banner.innerHTML = `⚠️ Connexion à la base de données impossible.<br>${hint}<br><span style="opacity:.75">Détail : ${escapeHtml(code || err?.message || "inconnu")}</span>`;
  banner.classList.remove("hidden");
}

// ---------------------------------------------------------------------
// Déconnexion forcée (bannissement / session interrompue)
// ---------------------------------------------------------------------
function declencherDeconnexionForcee(raison) {
  const titre = document.getElementById("forceLogoutTitle");
  const message = document.getElementById("forceLogoutMessage");
  if (raison === "banni") {
    if (titre) titre.textContent = "Accès banni";
    if (message) message.textContent = "Un administrateur a banni votre accès à l'application. Contactez-le pour rétablir votre compte.";
  } else {
    if (titre) titre.textContent = "Session interrompue";
    if (message) message.textContent = "Un administrateur a mis fin à votre session. Reconnectez-vous avec vos identifiants pour continuer.";
  }
  afficherEcran("forceLogout");
}

// ---------------------------------------------------------------------
// Écouteur de bannissement (via module utilisateurs.js)
// ---------------------------------------------------------------------
window.addEventListener("oleeducks:force-logout", async (e) => {
  const raison = e.detail?.raison || "session_interrompue";
  try { await authSignOut(); } catch (_) {}
  declencherDeconnexionForcee(raison);
});

// ---------------------------------------------------------------------
// Écran de connexion : bascule admin/user + soumission
// ---------------------------------------------------------------------
function initLoginScreen() {
  let roleChoisi = "admin";

  document.querySelectorAll("#loginRoleSwitch button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#loginRoleSwitch button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      roleChoisi = btn.dataset.role;
      const hint = document.getElementById("loginRoleHint");
      if (hint) {
        hint.textContent = roleChoisi === "admin"
          ? "Connectez-vous avec vos identifiants administrateur."
          : "Connectez-vous avec les identifiants fournis par votre administrateur.";
      }
      afficherErreurLogin(null);
    });
  });

  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    afficherErreurLogin(null);
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const btn = document.getElementById("loginSubmitBtn");
    if (!email || !password) { afficherErreurLogin("Email et mot de passe requis."); return; }

    btn.disabled = true;
    btn.textContent = "Connexion…";
    try {
      await signIn(email, password);
      // La suite est gérée par onAuthChange (voir boot())
    } catch (err) {
      console.error(err);
      const code = err?.code || "";
      let msg = "Connexion impossible.";
      if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
        msg = "Email ou mot de passe incorrect.";
      } else if (code.includes("too-many-requests")) {
        msg = "Trop de tentatives. Réessayez dans quelques minutes.";
      } else if (code.includes("network-request-failed")) {
        msg = "Pas de connexion internet. Vérifiez votre réseau.";
      } else if (err?.message) {
        msg = err.message;
      }
      afficherErreurLogin(msg);
      btn.disabled = false;
      btn.textContent = "Se connecter";
    }
  });

  document.getElementById("forgotPasswordBtn").addEventListener("click", async () => {
    const email = document.getElementById("loginEmail").value.trim();
    if (!email) { afficherErreurLogin("Saisissez d'abord votre email, puis cliquez de nouveau."); return; }
    try {
      await resetPassword(email);
      afficherErreurLogin(null);
      openModal("Email envoyé", `
        <p class="subtle">Un email de réinitialisation a été envoyé à <b>${escapeHtml(email)}</b>.</p>
        <p class="subtle">Vérifiez votre boîte de réception (et vos spams). Cliquez sur le lien pour choisir un nouveau mot de passe.</p>
        <div class="spacer-m"></div>
        <button class="btn yolk" id="closeResetBtn">Compris</button>
      `, {
        onMount: () => {
          document.getElementById("closeResetBtn").addEventListener("click", closeModal);
        }
      });
    } catch (err) {
      afficherErreurLogin("Envoi impossible : vérifiez l'adresse email.");
    }
  });

  document.getElementById("forceLogoutOkBtn").addEventListener("click", () => {
    afficherEcran("login");
  });
}

// ---------------------------------------------------------------------
// Initialisation des modules métier (une seule fois, après connexion admin)
// ---------------------------------------------------------------------
function initialiserModulesAdmin() {
  if (modulesInit) return;
  modulesInit = true;
  try {
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
    initActiviteAccueil();
  } catch (e) {
    console.error("Erreur initialisation modules admin :", e);
  }
}

// Pour un user simple : on n'initialise QUE le module tâches.
let modulesUserInit = false;
function initialiserModulesUser() {
  if (modulesUserInit) return;
  modulesUserInit = true;
  try {
    initTaches(); // le module taches gère lui-même le filtrage par role
  } catch (e) {
    console.error("Erreur initialisation modules user :", e);
  }
}

// ---------------------------------------------------------------------
// Décision après chaque changement d'état d'authentification
// ---------------------------------------------------------------------
async function gererEtatAuth({ user, profil }) {
    // Expose le profil courant à utils.js (getUserName) et aux autres modules.
  // Mis à jour à chaque changement d'état d'authentification.
  window.__oleeducks_profil_courant = profil || null;
  
  // Cas 1 : personne connecté → écran de connexion
  if (!user) {
    roleCourant = null;
    afficherEcran("login");
    // Reset du bouton pour permettre une nouvelle tentative
    const btn = document.getElementById("loginSubmitBtn");
    if (btn) { btn.disabled = false; btn.textContent = "Se connecter"; }
    return;
  }

  // Cas 2 : utilisateur connecté mais profil introuvable → refus
  if (!profil) {
    afficherErreurLogin("Votre compte n'a pas de profil associé. Contactez un administrateur.");
    try { await authSignOut(); } catch (_) {}
    return;
  }

  // Cas 3 : banni ou session interrompue → déconnexion forcée
  if (doitEtreDeconnecte()) {
    const raison = raisonDeconnexion();
    try { await authSignOut(); } catch (_) {}
    declencherDeconnexionForcee(raison);
    return;
  }

  // Cas 4 : profil invalide (ni admin ni user)
  if (!estAdmin() && !estUser()) {
    afficherErreurLogin("Rôle non reconnu. Contactez un administrateur.");
    try { await authSignOut(); } catch (_) {}
    return;
  }

  // Cas 5 : connexion valide
  roleCourant = estAdmin() ? "admin" : "user";

  // Marque la session comme active (utile pour le suivi admin)
  try { await marquerSessionActive(); } catch (_) {}

  // Affiche l'app
  afficherEcran("app");
  mettreAJourChip();
  appliquerRestrictionsRole();
  initUserChip();

  if (roleCourant === "admin") {
    initialiserModulesAdmin();
    // Sur le dashboard par défaut
    setPage("dashboard");
  } else {
    initialiserModulesUser();
    // Un user simple arrive directement sur ses tâches
    setPage("taches");
  }
}

// ---------------------------------------------------------------------
// Démarrage général
// ---------------------------------------------------------------------
async function boot() {
  // Affiche l'écran de chargement pendant qu'on détermine l'état d'auth
  afficherEcran("loading");

  initLoginScreen();
  initNav();
  initFab();
  initQuickActions();
  initConnectionStatus();
  initUtilisateurs(); // le module s'auto-protège (ne fait rien pour un user)

  // On attend que Firebase soit prêt (config OK)
  try {
    await authReady;
    firebaseOk = true;
    const label = document.getElementById("syncLabel");
    if (label) label.textContent = "Synchronisé";
  } catch (e) {
    showConfigError(e);
    afficherEcran("login");
    return;
  }

  // Écoute les changements d'état d'authentification en continu.
  // C'est CE mécanisme qui gère :
  //   - la 1ère connexion
  //   - la déconnexion volontaire
  //   - le bannissement / l'interruption de session à distance
  onAuthChange((etat) => {
    gererEtatAuth(etat);
  });

  // Démarre le module auth (écoute Firebase Auth + charge le profil)
  await initAuth();

  // Service worker PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("Service worker :", err));
  }
}

boot();
