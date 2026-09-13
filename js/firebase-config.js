// =====================================================================
// CONFIGURATION FIREBASE — OLEE DUCKS
// =====================================================================
// 1. Créez un projet gratuit sur https://console.firebase.google.com
// 2. Ajoutez une "application Web" au projet
// 3. Copiez les valeurs fournies par Firebase ci-dessous (firebaseConfig)
// 4. Activez Firestore Database (mode production) et Authentication
//    (méthode "Anonyme") dans la console Firebase.
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

// Persistance hors-ligne : les 2-3 téléphones continuent de fonctionner
// même en cas de coupure réseau, et se resynchronisent au retour du signal.
try {
  enableIndexedDbPersistence(db);
} catch (e) {
  console.warn("Persistance hors-ligne non disponible sur cet onglet :", e.code);
}

// Connexion anonyme automatique : pas d'écran de login pour les 3 utilisateurs,
// mais Firestore exige quand même un utilisateur authentifié (voir règles de
// sécurité dans le README) — cela empêche des inconnus d'écrire des données
// s'ils tombent sur le lien de l'application.
export const authReady = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      resolve(user);
    } else {
      signInAnonymously(auth).catch((err) => {
        console.error("Erreur de connexion anonyme Firebase :", err);
        reject(err);
      });
    }
  }, (err) => {
    console.error("Erreur d'authentification Firebase :", err);
    reject(err);
  });
});
