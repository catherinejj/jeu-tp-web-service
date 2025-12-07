# Jeu de stratégie WebSocket

Prototype complet d’un jeu de stratégie tour par tour basé sur WebSocket. Le serveur Node.js gère l’état partagé, les validations et les tours ; le client HTML/CSS/JS affiche la grille et permet aux joueurs d’intéragir en temps réel.

## Prérequis

- Node.js 18+
- npm

## Installation & scripts

```bash
npm install        # installe les dépendances
npm run dev        # serveur avec reload via nodemon
npm start          # exécute le serveur en mode production
```

Le serveur HTTP et WebSocket écoute par défaut sur `http://localhost:3000` et sert les fichiers dans `public/`.

## Configuration

| Variable | Valeur par défaut | Description            |
| -------- | ----------------- | ---------------------- |
| `PORT`   | `3000`            | Port HTTP / WebSocket. |

## Structure

```
server/
  gameState.js   # règles métier et gestion de l’état
  index.js       # express + ws, diffusion de l’état
public/
  index.html     # interface, connexion, actions
  styles.css     # mise en page et grille
  app.js         # logique client (WebSocket, rendu, interactions)
```

## Rappels de règles implémentées

- 4 joueurs actifs maximum, positions de départ sur les coins.
- Actions possibles (une par tour) : déplacement (≤3 cases en ligne droite), attaque (portée 2, coûte 2 PDV au lanceur, touche la première entité), pose d’obstacle (adjacent, stock 3, 2 PDV chacun).
- Les spectateurs se connectent librement et reçoivent l’état sans pouvoir agir.
- La partie se termine lorsqu’il ne reste qu’un joueur `Active`; le vainqueur est diffusé via `GAME_OVER`.

## Tests manuels suggérés

1. **Lobby**

   - Ouvrir 4 onglets navigateur.
   - Dans chacun, saisir un pseudo/couleur différents.
   - Vérifier que la grille reste en attente tant que 4 joueurs ne sont pas inscrits.

2. **Déplacements**

   - Sur l’onglet du joueur actif, sélectionner “Se déplacer” puis cliquer une case valide (≤3 cases, ligne droite, chemin libre).
   - Confirmer la mise à jour sur tous les clients et la rotation du tour.

3. **Attaque & Obstacles**

   - Tester une attaque hors portée (doit renvoyer `ACTION_INVALID`).
   - Placer un obstacle adjacent, vérifier la décrémentation du stock et l’apparition sur la grille.
   - Attaquer un obstacle jusqu’à destruction (2 coups).

4. **Défaite / Victoire**

   - Réduire les PDV d’un joueur à 0 : son statut passe à `Defeated`, pion retiré, obstacles conservés.
   - Continuer jusqu’à ce qu’un seul joueur reste actif : `GAME_OVER` annonce le gagnant.

5. **Spectateurs**
   - Ouvrir un 5ᵉ onglet, cliquer “Rejoindre” alors que la partie est en cours : l’onglet doit basculer en mode spectateur et recevoir les mises à jour en lecture seule.

## Limitations connues

- Une fois la partie terminée, redémarrer le serveur (ou attendre que tous les joueurs se déconnectent) pour lancer une nouvelle session.
- Aucun système d’authentification ou de persistance n’est implémenté : chaque rechargement crée une nouvelle connexion.
