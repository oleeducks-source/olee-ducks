// =====================================================================
// CONFIGURATION FIREBASE — OLEE DUCKS
// =====================================================================
// 1. Créez un projet gratuit sur https://console.firebase.google.com
// 2. Ajoutez une "application Web" au projet
// 3. Copiez les valeurs fournies par Firebase ci-dessous (firebaseConfig)
// 4. Activez Firestore Database (mode production) et Authentication
//    (méthode "Email/Mot de passe" + éventuellement "Anonyme") dans la
//    console Firebase.
// Voir README.md pour le guide complet, étape par étape.
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// >>> REMPLACEZ CES VALEURS PAR CELLES DE VOTRE PROJET FIREBASE <<<
const firebaseConfig = {
  apiKey: "AIzaSyB9Rj7DNOncLmqpr9thR0HKG8D4sOl31Fc",
  authDomain: "olee-ducks-f6752.firebaseapp.com",
  projectId: "olee-ducks-f6752",
  storageBucket: "olee-ducks-f6752.firebasestorage.app",
  messagingSenderId: "943030289981",
  appId: "1:943030289981:web:0e9b1024a21f2ffd7c8c54"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);
export const auth = getAuth(firebaseApp);

// ---------------------------------------------------------------------
// Persistance hors-ligne Firestore
// ---------------------------------------------------------------------
// Les 2-3 téléphones continuent de fonctionner même en cas de coupure
// réseau, et se resynchronisent au retour du signal.
//
// ⚠️ Un seul onglet peut "posséder" la persistance IndexedDB à la fois.
// Si plusieurs onglets de l'app sont ouverts simultanément (par exemple
// pour tester avec deux comptes en parallèle), Firestore lève une
// exception "Failed to obtain exclusive access to the persistence layer"
// qui, si elle n'est pas capturée, interrompt le démarrage normal de
// l'application.
//
// Le try/catch synchrone de la version précédente ne servait à RIEN :
// enableIndexedDbPersistence() est une fonction asynchrone qui retourne
// une promesse. Quand elle échoue, elle rejette la promesse au lieu de
// lancer une exception — donc le catch ne s'exécutait jamais, et
// l'erreur remontait comme "unhandled promise rejection" en bloquant
// l'initialisation de l'app.
//
// On utilise ici .catch() pour capturer proprement l'erreur, sans
// jamais bloquer le démarrage.
// ---------------------------------------------------------------------
enableIndexedDbPersistence(db).catch((e) => {
  if (e.code === "failed-precondition") {
    // Plusieurs onglets ouverts : la persistance sera active dans un
    // seul onglet (le premier ouvert), les autres fonctionneront sans
    // cache hors-ligne. C'est totalement transparent pour l'utilisateur.
    console.warn(
      "Persistance hors-ligne désactivée pour cet onglet " +
      "(un autre onglet de l'app la possède déjà)."
    );
  } else if (e.code === "unimplemented") {
    console.warn("Ce navigateur ne supporte pas la persistance hors-ligne Firestore.");
  } else {
    console.warn("Persistance hors-ligne non disponible :", e.code || e.message);
  }
});

// ---------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------
// L'authentification anonyme reste disponible comme filet de sécurité
// pour les anciens utilisateurs qui n'auraient pas encore migré vers
// un compte email. Le nouveau système (voir auth.js) se base sur des
// comptes email/mot de passe avec des rôles (admin / user).
//
// On n'utilise plus l'auto-connexion anonyme : chaque utilisateur doit
// désormais passer par l'écran de connexion email. Ceci évite qu'un
// nouvel appareil tombant sur le lien de l'app puisse s'authentifier
// automatiquement sans profil valide.
// ---------------------------------------------------------------------
export const authReady = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    // Si un utilisateur est déjà connecté (session persistée), on résout.
    if (user) {
      resolve(user);
      return;
    }
    // Sinon, on résout immédiatement avec null : l'app affichera
    // l'écran de connexion (voir app.js / auth.js). On ne tente PLUS
    // de connexion anonyme automatique, car cela contournerait le
    // système de rôles.
    resolve(null);
  }, (err) => {
    console.error("Erreur d'authentification Firebase :", err);
    reject(err);
  });
});
