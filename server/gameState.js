const { randomUUID } = require("crypto");

const MAX_PLAYERS = 4;
const PLAYER_HP = 10;
const OBSTACLE_HP = 2;
const OBSTACLE_STOCK = 3;
const ATTACK_COST = 0;
const ATTACK_DAMAGE = 2;
const MOVE_RANGE = 3;
const ATTACK_RANGE = 2;
const ALLOWED_GRID_SIZES = [9];

const toInt = (value) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

class GameStateManager {
  constructor(initialGridSize = ALLOWED_GRID_SIZES[0]) {
    this.state = this.createInitialState(initialGridSize);
  }

  createInitialState(gridSize) {
    return {
      gameStatus: "Lobby",
      gridSize,
      players: [],
      obstacles: [],
      currentPlayerTurn: null,
      winner: null,
      winnerId: null,
    };
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  setGridSizeIfLobby(size) {
    if (
      this.state.gameStatus !== "Lobby" ||
      this.state.players.length > 0 ||
      !ALLOWED_GRID_SIZES.includes(size)
    ) {
      return;
    }
    this.state.gridSize = size;
  }

  addPlayer({ pseudo, color, gridSizeOverride, userId }) {
    if (this.state.players.length >= MAX_PLAYERS) {
      throw new Error("Le lobby est complet.");
    }
    if (!pseudo || typeof pseudo !== "string" || pseudo.trim().length === 0) {
      throw new Error("Pseudo invalide.");
    }
    const normalizedColor = this.normalizeColor(color);
    if (!normalizedColor) {
      throw new Error("Couleur invalide.");
    }

    if (gridSizeOverride) {
      this.setGridSizeIfLobby(gridSizeOverride);
    }

    const startingPosition =
      this.getStartingPositions()[this.state.players.length];
    const player = {
      id: randomUUID(),
      userId: userId || null,
      pseudo: pseudo.trim(),
      couleur: normalizedColor,
      pdv: PLAYER_HP,
      position: startingPosition,
      obstaclesRestants: OBSTACLE_STOCK,
      status: "Active",
    };

    this.state.players.push(player);

    if (this.state.players.length === MAX_PLAYERS) {
      this.state.gameStatus = "InProgress";
      this.state.currentPlayerTurn = this.state.players[0].id;
    }

    return player;
  }

  removePlayer(playerId) {
    const index = this.state.players.findIndex((p) => p.id === playerId);
    if (index === -1) return;
    const [player] = this.state.players.splice(index, 1);

    if (this.state.players.length === 0) {
      this.state = this.createInitialState(this.state.gridSize);
      return;
    }

    if (player.status === "Active" && this.state.gameStatus === "InProgress") {
      // Treat as defeated and advance turn.
      this.markPlayerDefeated(player.id);
      this.advanceTurn();
      this.checkVictory();
    } else if (this.state.gameStatus === "Lobby") {
      // Shift starting positions for remaining players.
      this.state.players.forEach((p, idx) => {
        p.position = this.getStartingPositions()[idx];
      });
    }
  }

  executeMove(playerId, target) {
    const player = this.requireActivePlayer(playerId);
    this.ensureTargetValid(target);
    if (!this.isStraightLine(player.position, target)) {
      throw new Error("Le déplacement doit être en ligne droite.");
    }
    const distance = this.distance(player.position, target);
    if (distance === 0 || distance > MOVE_RANGE) {
      throw new Error("La distance maximale est de 3 cases.");
    }
    if (!this.isPathClear(player.position, target)) {
      throw new Error("Trajet bloqué par un joueur ou un obstacle.");
    }
    player.position = target;
    this.cleanupAfterAction();
    this.advanceTurn();
  }

  executeAttack(playerId, target) {
    // player qui joue
    const player = this.requireActivePlayer(playerId);
    // verifie qu'on est bien dans la grille
    this.ensureTargetValid(target);
    // on vérifie qu'on est bien en ligne
    if (!this.isStraightLine(player.position, target)) {
      throw new Error("Attaque en ligne droite uniquement.");
    }
    // on vérifie que la portée est la bonne
    const distance = this.distance(player.position, target);
    if (distance === 0 || distance > ATTACK_RANGE) {
      throw new Error("La portée maximale est de 2 cases.");
    }

    const entityHit = this.findFirstEntity(player.position, target);
    if (!entityHit) {
      throw new Error("Aucune cible dans cette direction.");
    }

    const explicitTarget =
      this.getPlayerAt(target) || this.getObstacleAt(target);
    if (explicitTarget && entityHit.entity.id !== explicitTarget.id) {
      throw new Error("Une entité bloque votre attaque.");
    }

    player.pdv -= ATTACK_COST;
    if (player.pdv <= 0) {
      this.markPlayerDefeated(player.id);
    }

    if (entityHit.type === "player") {
      entityHit.entity.pdv -= ATTACK_DAMAGE;

      if (entityHit.entity.pdv <= 0) {
        this.markPlayerDefeated(entityHit.entity.id);
      }
    } else {
      entityHit.entity.pdv -= ATTACK_DAMAGE;
      if (entityHit.entity.pdv <= 0) {
        this.state.obstacles = this.state.obstacles.filter(
          (o) => o.id !== entityHit.entity.id
        );
      }
    }

    this.cleanupAfterAction();
    this.advanceTurn();
  }

  executePlaceObstacle(playerId, target) {
    const player = this.requireActivePlayer(playerId);
    this.ensureTargetValid(target);
    if (player.obstaclesRestants <= 0) {
      throw new Error("Plus d'obstacles disponibles.");
    }
    if (!this.isAdjacent(player.position, target)) {
      throw new Error("La case doit être adjacente.");
    }
    if (this.isOccupied(target)) {
      throw new Error("Case déjà occupée.");
    }
    this.state.obstacles.push({
      id: randomUUID(),
      position: target,
      pdv: OBSTACLE_HP,
      ownerId: player.id,
    });
    player.obstaclesRestants -= 1;
    this.cleanupAfterAction();
    this.advanceTurn();
  }

  requireActivePlayer(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error("Joueur introuvable.");
    }
    if (player.status !== "Active") {
      throw new Error("Joueur déjà éliminé.");
    }
    return player;
  }

  ensureTargetValid(target) {
    if (
      !target ||
      typeof target.x !== "number" ||
      typeof target.y !== "number" ||
      target.x < 0 ||
      target.x >= this.state.gridSize ||
      target.y < 0 ||
      target.y >= this.state.gridSize
    ) {
      throw new Error("Case hors limites.");
    }
  }

  isOccupied(position) {
    return Boolean(this.getPlayerAt(position) || this.getObstacleAt(position));
  }

  getPlayerAt(position) {
    return this.state.players.find(
      (p) =>
        p.status === "Active" &&
        p.position.x === position.x &&
        p.position.y === position.y
    );
  }

  getObstacleAt(position) {
    return this.state.obstacles.find(
      (o) => o.position.x === position.x && o.position.y === position.y
    );
  }

  isStraightLine(a, b) {
    return a.x === b.x || a.y === b.y;
  }

  distance(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  isPathClear(start, target) {
    const dx = Math.sign(target.x - start.x);
    const dy = Math.sign(target.y - start.y);
    let x = start.x + dx;
    let y = start.y + dy;
    while (x !== target.x || y !== target.y) {
      if (this.isOccupied({ x, y })) {
        return false;
      }
      x += dx;
      y += dy;
    }
    if (this.isOccupied(target)) {
      return false;
    }
    return true;
  }
  // trouve la première entité dans la direction de l'attaque
  findFirstEntity(start, target) {
    const dx = Math.sign(target.x - start.x);
    const dy = Math.sign(target.y - start.y);
    let x = start.x + dx;
    let y = start.y + dy;
    // on parcourt la grille jusqu'à trouver la première entité dans la direction de l'attaque
    while (
      x >= 0 &&
      y >= 0 &&
      x < this.state.gridSize &&
      y < this.state.gridSize &&
      Math.abs(x - start.x) + Math.abs(y - start.y) <= ATTACK_RANGE
    ) {
      // on vérifie si la case est occupée par un joueur ou un obstacle
      const pos = { x, y };
      const player = this.getPlayerAt(pos);
      if (player) {
        return { type: "player", entity: player };
      }

      const obstacle = this.getObstacleAt(pos);
      if (obstacle) {
        return { type: "obstacle", entity: obstacle };
      }
      // on a trouvé l'entité dans la direction de l'attaque
      if (x === target.x && y === target.y) {
        break;
      }
      // on avance dans la direction de l'attaque
      x += dx;
      y += dy;
    }
    // on n'a pas trouvé d'entité dans la direction de l'attaque
    return null;
  }

  isAdjacent(a, b) {
    return (
      Math.abs(a.x - b.x) <= 1 &&
      Math.abs(a.y - b.y) <= 1 &&
      !(a.x === b.x && a.y === b.y)
    );
  }

  getStartingPositions() {
    const size = this.state.gridSize - 1;
    return [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: 0, y: size },
      { x: size, y: size },
    ];
  }

  markPlayerDefeated(playerId) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player || player.status === "Defeated") return;
    player.status = "Defeated";
    player.position = null;
  }

  cleanupAfterAction() {
    this.state.obstacles = this.state.obstacles.filter((o) => o.pdv > 0);
    this.state.players.forEach((player) => {
      if (player.pdv <= 0) {
        this.markPlayerDefeated(player.id);
      }
    });
    this.checkVictory();
  }

  advanceTurn() {
    if (this.state.gameStatus !== "InProgress") return;
    const activePlayers = this.state.players.filter(
      (p) => p.status === "Active"
    );
    if (activePlayers.length <= 1) {
      this.checkVictory();
      return;
    }
    const currentIndex = this.state.players.findIndex(
      (player) => player.id === this.state.currentPlayerTurn
    );
    let nextIndex = currentIndex;
    for (let i = 0; i < this.state.players.length; i += 1) {
      nextIndex = (nextIndex + 1) % this.state.players.length;
      if (this.state.players[nextIndex].status === "Active") {
        this.state.currentPlayerTurn = this.state.players[nextIndex].id;
        return;
      }
    }
    this.state.currentPlayerTurn = null;
  }

  checkVictory() {
    const active = this.state.players.filter((p) => p.status === "Active");
    if (active.length === 1 && this.state.gameStatus === "InProgress") {
      this.state.gameStatus = "Finished";
      this.state.winner = active[0].pseudo;
      this.state.winnerId = active[0].id;
    } else if (active.length === 0 && this.state.gameStatus === "InProgress") {
      this.state.gameStatus = "Finished";
      this.state.winner = null;
      this.state.winnerId = null;
    }
  }

  resetGame(gridSize = this.state.gridSize || ALLOWED_GRID_SIZES[0]) {
    this.state = this.createInitialState(gridSize);
  }

  normalizeColor(color) {
    if (typeof color !== "string") return null;
    const trimmed = color.trim();
    return /^#([0-9a-fA-F]{6})$/.test(trimmed) ? trimmed.toUpperCase() : null;
  }
}

module.exports = {
  GameStateManager,
  MAX_PLAYERS,
  ALLOWED_GRID_SIZES,
};
