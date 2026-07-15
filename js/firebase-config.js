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
  apiKey: "AIzaSyDdAY-PREUAooxQI2X8lPhPIc_v8kBqVNc",
  authDomain: "olee-ducks-app.firebaseapp.com",
  projectId: "olee-ducks-app",
  storageBucket: "olee-ducks-app.firebasestorage.app",
  messagingSenderId: "677951903814",
  appId: "1:677951903814:web:a7e86660e97755efda9247"
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
