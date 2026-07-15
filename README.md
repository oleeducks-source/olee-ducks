# Olee Ducks — Application de gestion de ferme

Application web installable (PWA) pour gérer l'inventaire des canards, les nids,
les finances et les stocks. Fonctionne sur les téléphones des 2-3 utilisateurs,
chacun sur son propre réseau internet, avec synchronisation en temps réel via
Firebase (base de données **gratuite**). Aucun coût d'hébergement.

---

## 1. Créer le projet Firebase (gratuit, 5 minutes)

1. Allez sur **https://console.firebase.google.com** et connectez-vous avec un compte Google.
2. Cliquez sur **Ajouter un projet**, nommez-le par exemple `olee-ducks`, puis terminez la création (vous pouvez désactiver Google Analytics, non nécessaire).
3. Dans le tableau de bord du projet, cliquez sur l'icône **`</>`** (Ajouter une application Web).
4. Donnez un nom (ex : `Olee Ducks Web`), **ne cochez pas** "Firebase Hosting" pour l'instant, puis cliquez sur **Enregistrer l'application**.
5. Firebase affiche un bloc de code contenant `const firebaseConfig = { ... }`. **Copiez ces valeurs.**

## 2. Configurer l'application

1. Ouvrez le fichier `js/firebase-config.js`.
2. Remplacez les valeurs `REMPLACER_...` par celles copiées à l'étape précédente. Exemple :
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSyD...",
     authDomain: "olee-ducks.firebaseapp.com",
     projectId: "olee-ducks",
     storageBucket: "olee-ducks.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef"
   };
   ```
3. Enregistrez le fichier.

## 3. Activer Firestore (la base de données)

1. Dans la console Firebase, menu de gauche **Build > Firestore Database**.
2. Cliquez sur **Créer une base de données**.
3. Choisissez une région proche (ex : `europe-west1`), puis **mode production**.
4. Une fois créée, allez dans l'onglet **Règles**, supprimez le contenu existant et collez celui du fichier `firestore.rules` fourni dans ce projet. Cliquez sur **Publier**.

## 4. Activer l'authentification anonyme

1. Menu de gauche **Build > Authentication > Get started**.
2. Onglet **Sign-in method**, cliquez sur **Anonyme**, activez-le, **Enregistrer**.
   (Cela permet à l'appli de reconnaître les 3 utilisateurs sans écran de connexion, tout en protégeant les données contre les inconnus — voir `firestore.rules`.)

## 5. Mettre l'application en ligne (gratuit)

Deux méthodes possibles — choisissez celle qui vous convient :

### Option A — Firebase Hosting (recommandée)

Nécessite d'installer Node.js une seule fois sur un ordinateur (https://nodejs.org, version LTS).

```bash
npm install -g firebase-tools
firebase login
cd oleeducks-app
firebase init hosting
# Répondre : "Use an existing project" -> choisir olee-ducks
# "What do you want to use as your public directory?" -> répondre "."
# "Configure as a single-page app?" -> Oui
# "Set up automatic builds with GitHub?" -> Non
firebase deploy
```

Firebase vous donne une URL du type `https://olee-ducks.web.app` — c'est l'adresse à ouvrir sur les téléphones.

Pour toute mise à jour future du code, il suffit de relancer `firebase deploy` :
**cela ne touche jamais aux données déjà enregistrées dans Firestore**, seulement aux fichiers de l'application.

### Option B — GitHub Pages (sans Node.js)

1. Créez un compte gratuit sur https://github.com si besoin.
2. Créez un nouveau dépôt (repository), par exemple `olee-ducks-app`.
3. Glissez-déposez tous les fichiers de ce projet dans le dépôt (bouton "Add file > Upload files").
4. Allez dans **Settings > Pages**, section "Build and deployment", choisissez la branche `main` et le dossier `/ (root)`, sauvegardez.
5. GitHub donne une URL du type `https://votre-compte.github.io/olee-ducks-app/` après 1-2 minutes.

## 6. Installer l'appli sur chaque téléphone

1. Ouvrez l'URL obtenue à l'étape 5 dans le navigateur du téléphone (Chrome sur Android, Safari sur iPhone).
2. **Android (Chrome)** : menu ⋮ > "Ajouter à l'écran d'accueil" (ou une bannière d'installation apparaît automatiquement).
3. **iPhone (Safari)** : bouton de partage 📤 > "Sur l'écran d'accueil".
4. Une icône Olee Ducks apparaît sur l'écran d'accueil, comme une vraie application. Elle s'ouvre en plein écran, sans barre de navigateur.

Répétez cette étape sur les 2-3 téléphones : ils partagent tous la même base de données Firestore, donc toute modification faite par l'un apparaît en temps réel chez les autres.

## 7. Une remarque importante sur les index

La première fois que vous consultez l'onglet **Nids > Archives** ou **Statistiques**, il est possible qu'un message d'erreur apparaisse dans la console du navigateur du type *"The query requires an index"*, avec un lien. C'est normal la toute première fois : **cliquez sur ce lien**, il crée automatiquement (et gratuitement) l'index nécessaire dans Firestore en un clic. Un fichier `firestore.indexes.json` est aussi fourni si vous utilisez la méthode Firebase CLI (`firebase deploy --only firestore:indexes`).

## 8. Limites gratuites (largement suffisantes pour votre usage)

Le plan gratuit Firebase ("Spark") inclut, chaque jour : 50 000 lectures, 20 000 écritures, 20 000 suppressions, et 1 Go de stockage total. Une ferme avec 2-3 utilisateurs actifs en consommera une fraction infime. Aucune carte bancaire n'est requise pour ce plan.

## 9. Structure des données (pour référence)

| Collection | Contenu |
|---|---|
| `ducks` | Inventaire des canards (canetons, reproducteurs, bagues) |
| `nests` | État courant des 100 nids (libre / occupé) |
| `nest_cycles` | Historique complet de chaque cycle ponte → couvaison → éclosion (jamais supprimé, sert aux statistiques des nids les plus productifs) |
| `nest_cycles/{id}/suivi` | Relevés quotidiens de ponte par cycle |
| `finance_transactions` | Recettes et dépenses |
| `stock_items` | Articles d'aliments et produits vétérinaires |
| `stock_mouvements` | Entrées (achats) et sorties (usage) de stock |

Les modules **Finances** et **Stocks** sont indépendants : un achat de stock peut
créer une dépense liée (case à cocher), mais chaque module continue de
fonctionner normalement même sans cette liaison.

## 10. Mettre à jour l'application sans perdre de données

Les fichiers de l'application (HTML/CSS/JS) et les données (Firestore) sont
totalement séparés. Vous pouvez donc redéployer une nouvelle version du code
à tout moment (nouvelles fonctionnalités, corrections) sans jamais effacer ou
modifier l'inventaire, les nids, les finances ou les stocks déjà enregistrés.
