# Correctifs issus de l'audit — Olee Ducks

Fichiers à copier tels quels à la racine du dépôt `oleeducks-source/olee-ducks`
(branche `main`), en conservant l'arborescence. Base de départ : le dépôt lu le
10 septembre 2026.

Je n'ai pas d'accès en écriture au dépôt : ce dossier est un jeu de fichiers
prêts à être poussés, pas un commit.

## Fichiers nouveaux

| Fichier | Rôle |
|---|---|
| `firestore.rules` | Règles de sécurité, absentes du dépôt alors que le README demandait de les publier. Authentification obligatoire, liste blanche des collections réellement utilisées, refus de tout le reste. À déployer : `firebase deploy --only firestore:rules`. |
| `js/restauration.js` | Écran de restauration : relit le JSON de sauvegarde, le résume avant écriture, exige la saisie de `RESTAURER`, écrit par lots de 400 avec barre d'avancement. Ne supprime jamais rien (écriture en `merge` à l'identifiant d'origine). Chargé à la demande. |

## Fichiers modifiés

**`firebase.json`** — contenait un bloc JavaScript `const firebaseConfig = {…}`
au lieu d'une configuration Hosting : `firebase deploy` ne pouvait pas
fonctionner. Remplacé par la vraie configuration (`public: "."`, réécriture SPA,
`no-cache` sur `sw.js`, `index.html` et `manifest.json`) et le rattachement des
règles et index Firestore.

**`js/firebase-config.js`** — `enableIndexedDbPersistence()`, déprécié depuis
Firebase 10, renvoie une promesse : le `try/catch` synchrone qui l'entourait
n'attrapait rien et un échec partait en rejet non géré. Remplacé par
`initializeFirestore` + `persistentLocalCache` avec
`persistentMultipleTabManager` (plusieurs onglets désormais acceptés). Un
indicateur `persistanceHorsLigne` est exporté.

**`js/app.js`** — affiche un bandeau d'avertissement sur le tableau de bord
quand le cache hors ligne n'a pas pu s'activer, au lieu de laisser croire que la
saisie sans réseau est protégée. Utilise la classe `.state-banner.warn` qui
existait déjà dans la feuille de style sans être employée.

**`js/sauvegarde.js`** — trois collections écrites par l'application étaient
absentes de l'export : `eclosions_journalieres`, `pesees_journalieres` et
`app_meta`. Ajoutées, ainsi que la sous-collection `nest_cycles/{id}/suivi`
qu'un `getDocs` de collection ne rapporte jamais. Le format d'export passe en
version 2 et déclare la liste des collections sauvegardées. Le bouton 💾 ouvre
désormais une feuille qui rappelle la date et l'auteur de la dernière sauvegarde
(lus dans `app_meta/sauvegarde`) et propose les deux sens : télécharger, ou
restaurer.

**`js/utils.js`** — `escapeHtml` n'échappait ni l'apostrophe simple ni l'accent
grave, alors que plusieurs valeurs sont injectées dans des attributs délimités
par des apostrophes.

**`index.html`** — `maximum-scale=1` retiré de la balise viewport : le zoom
redevient possible.

**`css/style.css`** — zones tactiles portées à 44 px sur la cloche, le bouton de
sauvegarde, l'œil et la croix de fermeture (cercle visible de 38 px et zone
étendue par un `::after` transparent) ; chip utilisateur à 38 px de hauteur.

**`sw.js`** — version du cache portée à `v19`, ajout de `js/restauration.js`,
`icons/icon.svg`, `icons/icon-512-maskable.png` et `import-comptabilite.html`,
qui manquaient à la liste du shell.

## À faire après le déploiement

1. Publier les règles, puis vérifier depuis un navigateur déconnecté qu'une
   lecture directe de la base est bien refusée.
2. Faire un export, puis tester la restauration sur le projet Firebase — ou
   mieux, sur un second projet gratuit servant de bac à sable.
3. Vérifier que le mode hors ligne fonctionne toujours après le changement de
   cache (couper le réseau, ouvrir l'app, saisir une transaction, rétablir).

## Points de l'audit volontairement laissés de côté

Ils touchent à trop de fichiers pour être livrés sans être testés sur la vraie
base, et méritent d'être décidés avant d'être codés :

- **Borner les douze écoutes temps réel** (fenêtre glissante par date) et
  **charger les modules à la demande** : c'est le gros du gain de performance,
  mais cela réécrit l'initialisation de chaque module.
- **Sortir les reçus base64 du document de transaction.**
- **Ne charger jsPDF et XLSX qu'au moment d'un export**, en les hébergeant avec
  l'app pour qu'ils marchent hors ligne.
- **Grille des nids** : les cases tombent à 26 px sur un écran de 360 px. Une
  vue à 5 colonnes sur petit écran règlerait le problème, mais elle casse la
  correspondance visuelle avec les 10 rangées du bâtiment. À trancher ensemble.
- **Comptes nommés et rôles**, incréments atomiques, journal des modifications.
