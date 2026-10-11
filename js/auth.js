// =====================================================================
// MODULE : AUTHENTIFICATION & RÔLES — Olee Ducks
// =====================================================================
// Ce module remplace le système "prénom en localStorage" par une vraie
// authentification Firebase (email + mot de passe), avec deux rôles :
//
//   - "admin" : accès total à l'application (comme aujourd'hui)
//   - "user"  : accès limité aux tâches assignées
//
// Il expose :
//   - initAuth()        : à appeler une fois au démarrage de l'app
//   - signIn()          : connexion email + mot de passe
//   - signOut()         : déconnexion propre
//   - resetPassword()   : envoi d'un email de réinitialisation
//   - getProfil()       : profil Firestore de l'utilisateur courant
//   - estAdmin()        : booléen, rôle == "admin"
//   - estUser()         : booléen, rôle == "user"
//   - attendreAuth()    : attend que l'état d'auth soit déterminé
//
// ⚠️ IMPORTANT : ce module ne gère PAS l'affichage. C'est app.js qui
// décide quoi montrer selon l'état retourné. auth.js s'occupe uniquement
// de la logique : qui est connecté, quel est son rôle, est-il banni.
// =====================================================================

import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, getDoc, onSnapshot, updateDoc, serverTimestamp, setDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ---------------------------------------------------------------------
// État interne du module
// ---------------------------------------------------------------------
let profilCourant = null;           // objet { id, email, nom, role, statut, ... }
let uidCourant = null;              // UID Firebase Auth
let unsubscribeProfil = null;       // écoute temps réel du profil
let ecouteursEtat = [];             // callbacks à prévenir en cas de changement
let etatInitialDeterminne = false;  // devient true dès qu'on sait si quelqu'un est connecté ou non

// ---------------------------------------------------------------------
// Système d'écoute interne : app.js peut s'abonner pour être prévenu
// quand l'utilisateur change d'état (connecté / déconnecté / banni).
// ---------------------------------------------------------------------
function notifierChangement() {
  ecouteursEtat.forEach(cb => {
    try { cb({ user: auth.currentUser, profil: profilCourant }); }
    catch (e) { console.error("Erreur écouteur auth :", e); }
  });
}

export function onAuthChange(callback) {
  ecouteursEtat.push(callback);
  return () => { ecouteursEtat = ecouteursEtat.filter(cb => cb !== callback); };
}

// ---------------------------------------------------------------------
// Initialisation : écoute Firebase Auth + charge le profil Firestore
// dès qu'un utilisateur est connecté.
// ---------------------------------------------------------------------
export function initAuth() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      // Nettoyage de l'écoute précédente si elle existe
      if (unsubscribeProfil) { unsubscribeProfil(); unsubscribeProfil = null; }

      if (!user) {
        // Aucun utilisateur connecté
        uidCourant = null;
        profilCourant = null;
        etatInitialDeterminne = true;
        notifierChangement();
        resolve({ user: null, profil: null });
        return;
      }

      uidCourant = user.uid;

      // Charge le profil en temps réel : toute modification côté serveur
      // (bannissement, changement de rôle, interruption de session) est
      // reçue instantanément et déclenche une notification.
      const profilRef = doc(db, "users", user.uid);
      unsubscribeProfil = onSnapshot(profilRef, (snap) => {
        if (!snap.exists()) {
          // Cas rare : utilisateur Firebase Auth sans profil Firestore.
          // On considère qu'il n'a aucun droit.
          profilCourant = null;
        } else {
          profilCourant = { id: snap.id, ...snap.data() };
        }
        etatInitialDeterminne = true;
        notifierChangement();
        resolve({ user, profil: profilCourant });
      }, (err) => {
        console.error("Erreur lecture profil :", err);
        profilCourant = null;
        etatInitialDeterminne = true;
        notifierChangement();
        resolve({ user, profil: null });
      });
    });
  });
}

// ---------------------------------------------------------------------
// Attend que l'état d'authentification soit déterminé (utilisé par
// app.js au démarrage pour éviter un flash d'écran).
// ---------------------------------------------------------------------
export function attendreAuth() {
  return new Promise((resolve) => {
    if (etatInitialDeterminne) { resolve({ user: auth.currentUser, profil: profilCourant }); return; }
    const off = onAuthChange(() => {
      if (etatInitialDeterminne) { off(); resolve({ user: auth.currentUser, profil: profilCourant }); }
    });
  });
}

// ---------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------
export async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  // La résolution définitive (profil chargé ou non) arrive via onSnapshot
  // déclenché par onAuthStateChanged. On retourne juste l'utilisateur ici.
  return cred.user;
}

// ---------------------------------------------------------------------
// Déconnexion
// ---------------------------------------------------------------------
export async function signOut() {
  if (unsubscribeProfil) { unsubscribeProfil(); unsubscribeProfil = null; }
  profilCourant = null;
  uidCourant = null;
  await fbSignOut(auth);
}

// ---------------------------------------------------------------------
// Réinitialisation de mot de passe par email
// ---------------------------------------------------------------------
export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email.trim());
}

// ---------------------------------------------------------------------
// Vérification de session à distance : un admin peut "interrompre" la
// session d'un utilisateur en mettant session_active = false. Ce n'est
// PAS auth.js qui coupe la session (Firebase ne le permet pas sans
// Cloud Functions payantes). C'est app.js qui, sur notification de
// changement de profil, décide de déconnecter l'utilisateur.
//
// Fonction utilitaire pour que app.js sache si l'utilisateur doit être
// déconnecté de force.
// ---------------------------------------------------------------------
export function doitEtreDeconnecte() {
  if (!profilCourant) return false;
  if (profilCourant.statut === "banni") return true;
  if (profilCourant.session_active === false) return true;
  return false;
}

export function raisonDeconnexion() {
  if (!profilCourant) return null;
  if (profilCourant.statut === "banni") return "banni";
  if (profilCourant.session_active === false) return "session_interrompue";
  return null;
}

// ---------------------------------------------------------------------
// Accesseurs
// ---------------------------------------------------------------------
export function getProfil() { return profilCourant; }
export function getUid() { return uidCourant; }
export function getEmail() { return profilCourant?.email || auth.currentUser?.email || null; }
export function getNom() { return profilCourant?.nom || null; }
export function estAdmin() { return profilCourant?.role === "admin" && profilCourant?.statut === "actif"; }
export function estUser() { return profilCourant?.role === "user" && profilCourant?.statut === "actif"; }
export function estActif() {
  return !!profilCourant && profilCourant.statut === "actif" && profilCourant.session_active !== false;
}

// ---------------------------------------------------------------------
// Marque la session comme active (appelé après connexion réussie).
// Utile côté admin : la date de "dernière activité" se met à jour.
// ---------------------------------------------------------------------
export async function marquerSessionActive() {
  if (!uidCourant) return;
  try {
    await updateDoc(doc(db, "users", uidCourant), {
      session_active: true,
      derniere_connexion: serverTimestamp()
    });
  } catch (e) {
    console.warn("Impossible de marquer la session active :", e);
  }
}
