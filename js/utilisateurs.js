// =====================================================================
// MODULE : GESTION DES UTILISATEURS (interface admin)
// =====================================================================
// Réservé aux administrateurs. Permet de :
//   - Lister tous les utilisateurs de la ferme
//   - Créer un nouvel utilisateur (via l'API REST Firebase Auth)
//   - Changer son rôle (admin / user)
//   - Interrompre sa session à distance (session_active = false)
//   - Le bannir (statut = "banni") — toutes ses requêtes sont refusées
//   - Le débannir
//   - Supprimer son profil Firestore (le compte Firebase Auth reste, à
//     supprimer manuellement dans la console si vraiment nécessaire)
//
// ⚠️ La création de compte passe par l'API REST identitytoolkit, ce qui
// évite de déconnecter l'admin courant (contrairement à createUserWithEmailAndPassword
// du SDK client qui basculerait la session sur le nouveau compte).
// ⚠️ Cela expose la clé API dans le réseau, mais c'est le fonctionnement
// standard de Firebase : la clé API Firebase n'est PAS un secret (elle
// est publique par design, protégée par les règles Firestore).
// =====================================================================

import { db, firebaseApp } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { signInWithEmailAndPassword, signOut as fbSignOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  toast, openModal, closeModal, escapeHtml, formatDateTime, getUserName
} from "./utils.js";
import { getUid, estAdmin } from "./auth.js";

const usersCol = collection(db, "users");
let tousLesUtilisateurs = [];

// ---------------------------------------------------------------------
// Création d'un utilisateur via l'API REST Firebase Auth
// ---------------------------------------------------------------------
// L'endpoint accounts:signUp crée un compte email/mot de passe SANS
// toucher à la session courante. Le nouvel utilisateur reçoit un UID
// Firebase Auth qu'on réutilise comme ID de document dans "users".
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
    "OPERATION_NOT_ALLOWED": "La connexion par email n'est pas activée dans Firebase Console (Authentication > Sign-in method > Email/Mot de passe).",
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
// Initialisation : écoute temps réel de la collection users
// ---------------------------------------------------------------------
export function initUtilisateurs() {
  // Le rendu ne se fait que pour les admins : on évite aux users simples
  // de déclencher des lectures Firestore inutiles.
  onSnapshot(query(usersCol, orderBy("date_creation", "desc")), (snap) => {
    tousLesUtilisateurs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (estAdmin()) renderUtilisateursList();
    verifierSiUtilisateurCourantBanni();
  }, err => {
    // Un user simple n'a pas le droit de lister tous les users : on ignore
    // silencieusement l'erreur (les règles Firestore la refusent).
    if (err.code !== "permission-denied") console.error("Erreur lecture utilisateurs :", err);
  });

  document.getElementById("openUtilisateursBtn")?.addEventListener("click", () => {
    // Masque TOUTES les pages puis affiche uniquement Utilisateurs.
    // Sans ça, la page Utilisateurs s'ouvrait derrière le dashboard
    // resté visible, donnant l'impression que le bouton ne faisait rien.
    document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
    document.getElementById("page-utilisateurs").classList.remove("hidden");
    // Aucun onglet de la bottom-nav ne doit rester actif
    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    window.scrollTo(0, 0);
  });
  document.getElementById("backFromUtilisateursBtn")?.addEventListener("click", () => {
    document.getElementById("page-utilisateurs").classList.add("hidden");
    // Retour au dashboard en ré-affichant la bonne page selon le rôle
    const home = (typeof window.__oleeducks_home_page === "string")
      ? window.__oleeducks_home_page
      : "dashboard";
    document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
    document.getElementById(`${"page-"}${home}`)?.classList.remove("hidden");
    document.querySelectorAll(".nav-item").forEach(n => {
      n.classList.toggle("active", n.dataset.page === home);
    });
    window.scrollTo(0, 0);
  });
  document.getElementById("openAddUserBtn")?.addEventListener("click", openAddUserModal);
}

// Certains utilisateurs peuvent avoir été bannis/suspendus pendant leur
// session : on vérifie à chaque snapshot que ce n'est pas le cas de
// l'utilisateur courant, et on force la déconnexion si nécessaire.
function verifierSiUtilisateurCourantBanni() {
  const uid = getUid();
  if (!uid) return;
  const moi = tousLesUtilisateurs.find(u => u.id === uid);
  if (!moi) return;
  if (moi.statut === "banni" || moi.session_active === false) {
    // L'écouteur principal dans app.js gère la déconnexion forcée.
    // Ici on déclenche juste un événement custom que app.js peut écouter.
    window.dispatchEvent(new CustomEvent("oleeducks:force-logout", { detail: { raison: moi.statut === "banni" ? "banni" : "session_interrompue" } }));
  }
}

// ---------------------------------------------------------------------
// Rendu de la liste (admin uniquement)
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
    <p class="subtle">Un compte Firebase sera créé immédiatement avec l'email et le mot de passe ci-dessous. Transmettez ces identifiants à la personne concernée (WhatsApp, SMS…) — elle pourra se connecter dès maintenant.</p>
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
          // 1) Créer le compte Firebase Auth via l'API REST
          const uid = await creerCompteAuthREST(email, password);

          // 2) Créer le profil Firestore associé
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

          toast(`Utilisateur créé ✓ Transmettez : ${email} / ${password}`);
          closeModal();
          // Affiche les identifiants en grand pour faciliter la transmission
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
