// =====================================================================
// MODULE : GESTION DES UTILISATEURS (interface admin)
// =====================================================================
// Réservé aux administrateurs. Permet de :
//   - Lister tous les utilisateurs de la ferme
//   - Créer un nouvel utilisateur (via l'API REST Firebase Auth)
//   - Changer son rôle (admin / user)
//   - Interrompre sa session à distance (session_active = false)
//   - Le bannir / débannir
//   - Supprimer son profil Firestore
//
// ⚠️ CORRECTIF (V35) : la fonction verifierSiUtilisateurCourantBanni()
// déclenchait un force-logout en boucle sur l'utilisateur courant,
// provoquant la fermeture automatique de la page Utilisateurs juste
// après son ouverture. Cette vérification est désormais déléguée à
// app.js (voir doitEtreDeconnecte() dans auth.js), qui est le SEUL
// endroit légitime pour déconnecter un utilisateur.
// =====================================================================

import { db, firebaseApp } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, query
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  toast, openModal, closeModal, escapeHtml, formatDateTime, getUserName
} from "./utils.js";
import { getUid, estAdmin } from "./auth.js";

const usersCol = collection(db, "users");
let tousLesUtilisateurs = [];
let dejaInitialise = false;

// ---------------------------------------------------------------------
// Création d'un utilisateur via l'API REST Firebase Auth
// ---------------------------------------------------------------------
async function creerCompteAuthREST(email, password) {
  const apiKey = firebaseApp.options.apiKey;
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`;
  const reponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: false })
  });
  const data = await reponse.json();
  if (!reponse.ok) {
    const code = data?.error?.message || "ERREUR_INCONNUE";
    throw new Error(traduireErreurAuth(code));
  }
  return data.localId; // = UID Firebase Auth du nouvel utilisateur
}

function traduireErreurAuth(code) {
  const table = {
    "EMAIL_EXISTS": "Cet email est déjà utilisé par un autre compte.",
    "INVALID_EMAIL": "L'adresse email n'est pas valide.",
    "WEAK_PASSWORD": "Le mot de passe doit contenir au moins 6 caractères.",
    "OPERATION_NOT_ALLOWED": "La connexion par email n'est pas activée dans Firebase Console.",
    "TOO_MANY_ATTEMPTS_TRY_LATER": "Trop de tentatives. Réessayez dans quelques minutes."
  };
  return table[code] || `Erreur Firebase : ${code}`;
}

function genererMotDePasse() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let mdp = "";
  for (let i = 0; i < 10; i++) mdp += chars[Math.floor(Math.random() * chars.length)];
  return mdp;
}

// ---------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------
export function initUtilisateurs() {
  if (dejaInitialise) return;
  dejaInitialise = true;

  // Écoute temps réel de la collection users (admin seulement).
  // Le rendu n'est appliqué QUE si la page Utilisateurs est réellement
  // affichée : sans ça, un snapshot Firestore (par exemple déclenché
  // par une modification de tâche ou de finance) pouvait interrompre
  // la navigation en cours et faire disparaître la page.
  onSnapshot(query(usersCol), (snap) => {
    tousLesUtilisateurs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    tousLesUtilisateurs.sort((a, b) =>
      (b.date_creation?.toMillis?.() || 0) - (a.date_creation?.toMillis?.() || 0)
    );
    // Rafraîchit la liste UNIQUEMENT si la page Utilisateurs est visible
    if (estAdmin() && estPageUtilisateursVisible()) {
      renderUtilisateursList();
    }
  }, err => {
    console.error("Erreur lecture utilisateurs :", err);
    if (estAdmin() && estPageUtilisateursVisible()) {
      const el = document.getElementById("utilisateursList");
      if (el) {
        el.innerHTML = `<div class="state-banner error"><span class="glyph">⚠️</span><span>
          Erreur de chargement : ${err.code || err.message}.<br>
          <small>Si le message dit "permission-denied", publiez les nouvelles règles Firestore.</small>
        </span></div>`;
      }
    }
  });

  // Bouton d'ouverture de la page Utilisateurs (admin)
  document.getElementById("openUtilisateursBtn")?.addEventListener("click", () => {
    if (typeof window.__oleeducks_setPage === "function") {
      window.__oleeducks_setPage("utilisateurs");
      // Force un rendu immédiat au cas où aucun snapshot n'arrive
      renderUtilisateursList();
    }
  });

  // Bouton retour
  document.getElementById("backFromUtilisateursBtn")?.addEventListener("click", () => {
    const home = estAdmin() ? "dashboard" : "taches";
    if (typeof window.__oleeducks_setPage === "function") {
      window.__oleeducks_setPage(home);
    }
  });

  // Bouton ajouter un utilisateur
  document.getElementById("openAddUserBtn")?.addEventListener("click", openAddUserModal);
}

// Vérifie si la page Utilisateurs est actuellement affichée à l'écran.
// Sert de garde pour éviter de rafraîchir une page non visible — c'était
// la cause principale de la disparition du bouton Utilisateurs.
function estPageUtilisateursVisible() {
  const el = document.getElementById("page-utilisateurs");
  if (!el) return false;
  return !el.classList.contains("hidden");
}

// ⚠️ SUPPRIMÉ : la vérification "utilisateur courant banni" est gérée
// exclusivement par app.js via onAuthChange + doitEtreDeconnecte().
// La dupliquer ici provoquait une boucle de force-logout qui fermait
// la page Utilisateurs juste après son ouverture.

// ---------------------------------------------------------------------
// Rendu de la liste
// ---------------------------------------------------------------------
function renderUtilisateursList() {
  const el = document.getElementById("utilisateursList");
  if (!el) return;
  const uid = getUid();

  if (!tousLesUtilisateurs.length) {
    el.innerHTML = `<div class="empty-state"><div class="glyph">👥</div><p>Aucun utilisateur enregistré.</p></div>`;
    return;
  }

  el.innerHTML = tousLesUtilisateurs.map(u => {
    const estMoi = u.id === uid;
    const badgeRole = u.role === "admin"
      ? `<span class="tag ok">Admin</span>`
      : `<span class="tag">Utilisateur</span>`;
    const badgeStatut = u.statut === "banni"
      ? `<span class="tag danger">Banni</span>`
      : u.session_active === false
        ? `<span class="tag warn">Session interrompue</span>`
        : `<span class="tag ok">Actif</span>`;
    const derniereActivite = u.derniere_connexion
      ? `Dernière connexion : ${formatDateTime(u.derniere_connexion)}`
      : "Jamais connecté";
    return `
      <div class="row with-icon user-row" data-id="${u.id}">
        <div class="row-icon ${u.role === "admin" ? "dark" : ""}">
          <svg viewBox="0 0 40 40"><use href="#ic-cat-salaire"/></svg>
        </div>
        <div class="row-main">
          <span class="row-title">${escapeHtml(u.nom || "Sans nom")}${estMoi ? ' <span class="subtle">(vous)</span>' : ""}</span>
          <span class="row-sub">${escapeHtml(u.email || "")} · ${derniereActivite}</span>
          <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">${badgeRole} ${badgeStatut}</div>
        </div>
        <button class="btn secondary small userActionsBtn" data-id="${u.id}">Gérer →</button>
      </div>
    `;
  }).join("");

  el.querySelectorAll(".userActionsBtn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const u = tousLesUtilisateurs.find(x => x.id === btn.dataset.id);
      if (u) openUserActionsModal(u);
    });
  });
}

// ---------------------------------------------------------------------
// Modal : ajouter un utilisateur
// ---------------------------------------------------------------------
function openAddUserModal() {
  const mdpPropose = genererMotDePasse();
  const body = `
    <p class="subtle">Un compte Firebase sera créé immédiatement avec l'email et le mot de passe ci-dessous. Transmettez ces identifiants à la personne concernée — elle pourra se connecter dès maintenant.</p>
    <div class="spacer-s"></div>
    <div class="field"><label>Nom / Prénom</label><input type="text" id="fNewUserName" placeholder="ex : Aïcha"></div>
    <div class="field"><label>Email</label><input type="email" id="fNewUserEmail" placeholder="ex : aicha@olee.ci" autocomplete="off"></div>
    <div class="field"><label>Mot de passe provisoire</label>
      <div style="display:flex;gap:6px;">
        <input type="text" id="fNewUserPassword" value="${mdpPropose}" style="flex:1;font-family:var(--font-mono);">
        <button class="btn secondary small" id="fRegeneratePassword" type="button" style="width:auto;">↻</button>
      </div>
      <p class="subtle" style="margin:6px 0 0;">Notez ce mot de passe — il ne sera plus affiché après.</p>
    </div>
    <div class="field"><label>Rôle</label>
      <select id="fNewUserRole">
        <option value="user">Utilisateur simple (tâches uniquement)</option>
        <option value="admin">Administrateur (accès total)</option>
      </select>
    </div>
    <button class="btn yolk" id="fCreateUserBtn">Créer l'utilisateur</button>
  `;

  openModal("Ajouter un utilisateur", body, {
    onMount: () => {
      document.getElementById("fRegeneratePassword").addEventListener("click", () => {
        document.getElementById("fNewUserPassword").value = genererMotDePasse();
      });

      document.getElementById("fCreateUserBtn").addEventListener("click", async () => {
        const nom = document.getElementById("fNewUserName").value.trim();
        const email = document.getElementById("fNewUserEmail").value.trim();
        const password = document.getElementById("fNewUserPassword").value;
        const role = document.getElementById("fNewUserRole").value;

        if (!nom) { toast("Le nom est requis"); return; }
        if (!email || !email.includes("@")) { toast("Email invalide"); return; }
        if (!password || password.length < 6) { toast("Mot de passe : 6 caractères minimum"); return; }

        const btn = document.getElementById("fCreateUserBtn");
        btn.disabled = true;
        btn.textContent = "Création en cours…";

        try {
          const uid = await creerCompteAuthREST(email, password);
          await setDoc(doc(db, "users", uid), {
            email,
            nom,
            role,
            statut: "actif",
            session_active: true,
            date_creation: serverTimestamp(),
            cree_par: getUserName() || "Admin",
            cree_par_uid: getUid()
          });

          closeModal();
          openModal("Identifiants à transmettre", `
            <p class="subtle">Notez ou transmettez ces identifiants dès maintenant. Le mot de passe ne sera plus jamais affiché.</p>
            <div class="card" style="background:var(--sage-100);border:none;margin-top:10px;">
              <div class="row"><div class="row-main"><span class="row-title">Nom</span></div><span class="row-value">${escapeHtml(nom)}</span></div>
              <div class="row"><div class="row-main"><span class="row-title">Email</span></div><span class="row-value mono">${escapeHtml(email)}</span></div>
              <div class="row"><div class="row-main"><span class="row-title">Mot de passe</span></div><span class="row-value mono">${escapeHtml(password)}</span></div>
              <div class="row"><div class="row-main"><span class="row-title">Rôle</span></div><span class="row-value">${role === "admin" ? "Administrateur" : "Utilisateur simple"}</span></div>
            </div>
            <div class="spacer-m"></div>
            <button class="btn secondary" id="copyCredsBtn">📋 Copier les identifiants</button>
            <div class="spacer-s"></div>
            <button class="btn yolk" id="closeCredsBtn">J'ai noté ✓</button>
          `, {
            onMount: () => {
              document.getElementById("copyCredsBtn").addEventListener("click", () => {
                const texte = `Connexion Olee Ducks\nEmail : ${email}\nMot de passe : ${password}\nRôle : ${role === "admin" ? "Administrateur" : "Utilisateur"}\n\nOuvrez l'app, choisissez "${role === "admin" ? "Administrateur" : "Utilisateur"}" et connectez-vous.`;
                navigator.clipboard.writeText(texte).then(() => toast("Copié ✓")).catch(() => toast("Copie impossible — notez manuellement"));
              });
              document.getElementById("closeCredsBtn").addEventListener("click", closeModal);
            }
          });
        } catch (e) {
          console.error(e);
          toast(e.message);
          btn.disabled = false;
          btn.textContent = "Créer l'utilisateur";
        }
      });
    }
  });
}

// ---------------------------------------------------------------------
// Modal : actions sur un utilisateur
// ---------------------------------------------------------------------
function openUserActionsModal(u) {
  const estMoi = u.id === getUid();
  const estBanni = u.statut === "banni";
  const sessionCoupee = u.session_active === false;

  const body = `
    <div class="row"><div class="row-main"><span class="row-title">Email</span></div><span class="row-value mono">${escapeHtml(u.email || "—")}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Rôle actuel</span></div><span class="row-value">${u.role === "admin" ? "Administrateur" : "Utilisateur simple"}</span></div>
    <div class="row"><div class="row-main"><span class="row-title">Statut</span></div><span class="row-value">${estBanni ? "Banni" : (sessionCoupee ? "Session interrompue" : "Actif")}</span></div>
    ${u.cree_par ? `<div class="row"><div class="row-main"><span class="row-title">Créé par</span></div><span class="row-value">${escapeHtml(u.cree_par)}</span></div>` : ""}
    <div class="spacer-m"></div>

    ${estMoi ? `<div class="state-banner warn"><span class="glyph">⚠️</span><span>Vous ne pouvez pas modifier votre propre compte (rôle, bannissement, session) pour éviter de vous bloquer vous-même.</span></div>` : `

      <button class="btn secondary" id="uToggleRoleBtn">${u.role === "admin" ? "⬇ Passer en utilisateur simple" : "⬆ Passer en administrateur"}</button>
      <div class="spacer-s"></div>

      ${sessionCoupee
        ? `<button class="btn yolk" id="uReactiverSessionBtn">▶ Réactiver sa session</button>`
        : `<button class="btn secondary" id="uInterrompreSessionBtn">⏸ Interrompre sa session (le déconnecte immédiatement)</button>`}
      <div class="spacer-s"></div>

      ${estBanni
        ? `<button class="btn yolk" id="uDebannirBtn">✓ Débannir cet utilisateur</button>`
        : `<button class="btn danger" id="uBannirBtn">🚫 Bannir cet utilisateur</button>`}
      <div class="spacer-s"></div>

      <button class="btn danger" id="uSupprimerBtn" style="background:var(--danger-bg);color:var(--danger-fg);">🗑 Supprimer le profil (irréversible)</button>
    `}
  `;

  openModal(u.nom || "Utilisateur", body, {
    onMount: () => {
      document.getElementById("uToggleRoleBtn")?.addEventListener("click", async () => {
        const nouveauRole = u.role === "admin" ? "user" : "admin";
        if (!confirm(`Passer ${u.nom} en ${nouveauRole === "admin" ? "administrateur" : "utilisateur simple"} ?`)) return;
        try {
          await updateDoc(doc(db, "users", u.id), { role: nouveauRole, modifie_par: getUserName(), modifie_le: serverTimestamp() });
          toast("Rôle mis à jour ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      document.getElementById("uInterrompreSessionBtn")?.addEventListener("click", async () => {
        if (!confirm(`Interrompre la session de ${u.nom} ? Il sera déconnecté immédiatement sur tous ses appareils.`)) return;
        try {
          await updateDoc(doc(db, "users", u.id), { session_active: false, modifie_par: getUserName(), modifie_le: serverTimestamp() });
          toast("Session interrompue ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      document.getElementById("uReactiverSessionBtn")?.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "users", u.id), { session_active: true, modifie_par: getUserName(), modifie_le: serverTimestamp() });
          toast("Session réactivée ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      document.getElementById("uBannirBtn")?.addEventListener("click", async () => {
        if (!confirm(`Bannir ${u.nom} ? Il sera déconnecté et ne pourra plus se reconnecter tant que vous ne le débannissez pas.`)) return;
        try {
          await updateDoc(doc(db, "users", u.id), { statut: "banni", session_active: false, banni_par: getUserName(), banni_le: serverTimestamp() });
          toast("Utilisateur banni ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      document.getElementById("uDebannirBtn")?.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "users", u.id), { statut: "actif", session_active: true, modifie_par: getUserName(), modifie_le: serverTimestamp() });
          toast("Utilisateur débanni ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });

      document.getElementById("uSupprimerBtn")?.addEventListener("click", async () => {
        if (!confirm(`Supprimer DÉFINITIVEMENT le profil de ${u.nom} ?\n\nSon compte Firebase Auth restera (à supprimer manuellement dans la console si besoin), mais il ne pourra plus rien faire dans l'app.`)) return;
        if (!confirm("Confirmez une seconde fois : cette action est irréversible depuis l'app.")) return;
        try {
          await deleteDoc(doc(db, "users", u.id));
          toast("Profil supprimé ✓");
          closeModal();
        } catch (e) { toast("Erreur : " + e.message); }
      });
    }
  });
}
