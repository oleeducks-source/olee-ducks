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

try {
  enableIndexedDbPersistence(db);
} catch (e) {
  console.warn("Persistance hors-ligne non disponible sur cet onglet :", e.code);
}

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
