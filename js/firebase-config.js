import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
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

// ---------------------------------------------------------------------
// Cache persistant (IndexedDB) déclaré à l'initialisation de Firestore.
//
// Remplace enableIndexedDbPersistence(db), déprécié depuis Firebase 10 :
// cette fonction renvoyait une promesse, donc le try/catch synchrone qui
// l'entourait ne pouvait rien attraper. Un échec d'activation partait en
// rejet non géré et le mode hors ligne — argument central de l'app pour
// un usage en bâtiment sans réseau — était silencieusement absent.
//
// persistentMultipleTabManager autorise en plus plusieurs onglets
// simultanés, ce que l'ancienne API refusait (elle désactivait alors la
// persistance sur le deuxième onglet ouvert).
//
// persistanceHorsLigne indique à l'application si le cache est réellement
// actif : app.js s'en sert pour avertir l'utilisateur au lieu de laisser
// croire que la saisie hors réseau est protégée (fenêtre privée, stockage
// refusé, navigateur non compatible).
// ---------------------------------------------------------------------
export let persistanceHorsLigne = true;

let firestoreInstance;
try {
  firestoreInstance = initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (e) {
  console.warn("Cache persistant indisponible — repli sur le cache mémoire :", e?.code || e);
  persistanceHorsLigne = false;
  firestoreInstance = getFirestore(firebaseApp);
}

export const db = firestoreInstance;
export const auth = getAuth(firebaseApp);

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
