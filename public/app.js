const joinForm = document.getElementById("join-form");
const pseudoInput = document.getElementById("pseudo");
const colorInput = document.getElementById("color");
const gridSelect = document.getElementById("grid-size");
const actionButtons = document.querySelectorAll("#action-buttons button");
const playersListEl = document.getElementById("players-list");
const gridEl = document.getElementById("grid");
const logEl = document.getElementById("log");
const gameStatusEl = document.getElementById("game-status");
const turnStatusEl = document.getElementById("turn-status");
const winnerStatusEl = document.getElementById("winner-status");
const victoryModal = document.getElementById("victory-modal");
const victoryTitleEl = document.getElementById("victory-title");
const victoryMessageEl = document.getElementById("victory-message");
const resetGameBtn = document.getElementById("reset-game-btn");

let socket;
let playerId = null;
let selectedAction = null;
let latestState = null;
let victoryDisplayed = false;

const createPlayerIcon = () => {
  const wrapper = document.createElement("span");
  wrapper.className = "cell-icon player-icon";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-user";
  icon.setAttribute("aria-hidden", "true");
  wrapper.appendChild(icon);
  return wrapper;
};

const getWsUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const base = `${protocol}://${window.location.host}`;

  const token = localStorage.getItem("jwt_token"); // <-- relu ici

  if (token) {
    const params = new URLSearchParams({ token });
    return `${base}/?${params.toString()}`;
  }

  return base;
};

function connectSocket() {
  const wsUrl = getWsUrl();
  console.log("[connectSocket] tentative de connexion à", wsUrl);

  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    console.log("[connectSocket] WebSocket ouverte");
    showLog("Connecté au serveur de jeu ✅", "success");
  });

  socket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      routeMessage(data);
    } catch (err) {
      console.error("[connectSocket] Message invalide", err, event.data);
    }
  });

  socket.addEventListener("close", () => {
    console.log("[connectSocket] WebSocket fermée");
    showLog("Connexion au serveur fermée.", "error");
  });

  socket.addEventListener("error", (err) => {
    console.error("[connectSocket] Erreur WebSocket", err);
    showLog("Erreur WebSocket.", "error");
  });
}

const ensureAuthAndStart = async () => {
  const token = localStorage.getItem("jwt_token");
  const savedUsername = localStorage.getItem("player_username");

  console.log("[ensureAuthAndStart] token dans localStorage =", token);
  console.log("[ensureAuthAndStart] player_username =", savedUsername);

  // 1. Aucun token => on n’a rien à faire ici → login
  if (!token) {
    console.log("[ensureAuthAndStart] Pas de token → redirection login");
    window.location.href = "/login.html";
    return;
  }

  try {
    // 2. Vérifier le token auprès du back
    const res = await fetch("/api/auth/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    console.log("[ensureAuthAndStart] /api/auth/me status =", res.status);

    // 3. Si le back dit 401 => token invalide / révoqué → on nettoie + on renvoie au login
    if (res.status === 401) {
      console.log("[ensureAuthAndStart] 401 → token invalide/révoqué → nettoyage + login");
      localStorage.removeItem("jwt_token");
      localStorage.removeItem("player_username");
      localStorage.removeItem("jwt_expires_at");
      window.location.href = "/login.html";
      return;
    }

    // Autre erreur serveur (500, etc.) → on ne laisse pas jouer non plus
    if (!res.ok) {
      console.log("[ensureAuthAndStart] Erreur serveur /me → redirection login");
      window.location.href = "/login.html";
      return;
    }

    // 4. Token OK → on récupère l’utilisateur
    const data = await res.json();
    console.log("[ensureAuthAndStart] user reçu depuis /me =", data);
    const user = data.user || {};

    const displayName = user.username || savedUsername || "";

    if (pseudoInput && displayName) {
      pseudoInput.value = displayName;
      pseudoInput.readOnly = true;
      localStorage.setItem("player_username", displayName);
    }

    // 5. On peut enfin démarrer la WebSocket + le plateau
    connectSocket();
    renderGrid();
  } catch (err) {
    console.error("[ensureAuthAndStart] Auth check failed", err);
    // En cas de gros souci réseau, on renvoie aussi vers le login
    window.location.href = "/login.html";
  }
};

ensureAuthAndStart();

const routeMessage = ({ type, payload }) => {
  switch (type) {
    case "GAME_STATE_UPDATE":
      latestState = payload;
      renderState();
      break;
    case "ACTION_INVALID":
      showLog(payload?.message || "Action refusée.", "error");
      break;
    case "JOINED_AS_PLAYER":
      playerId = payload.playerId;
      disableJoinForm();
      showLog("Inscription confirmée. En attente des autres joueurs.");
      break;
    case "JOINED_AS_SPECTATOR":
      playerId = null;
      showLog(payload?.message || "Vous observez la partie.");
      break;
    case "GAME_OVER":
      if (payload?.winnerPseudo) {
        showLog(
          `Partie terminée. Gagnant : ${payload.winnerPseudo}`,
          "success"
        );
      } else {
        showLog("Partie terminée sans gagnant.", "error");
      }
      break;
    case "GAME_RESET":
      handleGameReset(payload);
      break;
    default:
      break;
  }
};

const disableJoinForm = () => {
  joinForm.querySelectorAll("input, select, button").forEach((el) => {
    el.disabled = true;
  });
};

const enableJoinForm = () => {
  joinForm.querySelectorAll("input, select, button").forEach((el) => {
    el.disabled = false;
  });
};

const sendMessage = (type, payload = {}) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showLog("Connexion WebSocket indisponible.", "error");
    return;
  }
  socket.send(JSON.stringify({ type, payload }));
};

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const pseudo = pseudoInput.value.trim();
  if (!pseudo) {
    showLog("Le pseudo est obligatoire.", "error");
    return;
  }
  sendMessage("JOIN_GAME", {
    pseudo,
    couleur: colorInput.value,
    gridSize: Number(gridSelect.value),
  });
});

actionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!playerId) {
      showLog("Seuls les joueurs peuvent effectuer des actions.", "error");
      return;
    }
    if (latestState?.gameStatus !== "InProgress") {
      showLog("La partie doit être en cours.", "error");
      return;
    }
    selectedAction = button.dataset.action;
    actionButtons.forEach((btn) =>
      btn.classList.toggle("active", btn === button)
    );
    showLog(`Action sélectionnée : ${button.textContent}. Cliquez une case.`);
  });
});

gridEl.addEventListener("click", (event) => {
  const cell = event.target.closest(".cell");
  if (!cell || !selectedAction) return;
  if (!playerId) {
    showLog("Vous êtes spectateur.", "error");
    return;
  }
  if (!latestState || latestState.currentPlayerTurn !== playerId) {
    showLog("Patiente jusqu'à ton tour.", "error");
    return;
  }
  const target = {
    x: Number(cell.dataset.x),
    y: Number(cell.dataset.y),
  };
  sendMessage("REQUEST_ACTION", {
    actionType: selectedAction,
    target,
  });
});

if (resetGameBtn) {
  resetGameBtn.addEventListener("click", () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showLog("Connexion WebSocket indisponible.", "error");
      return;
    }
    resetGameBtn.disabled = true;
    resetGameBtn.textContent = "Relance en cours...";
    sendMessage("RESET_GAME");
  });
}

const renderState = () => {
  if (!latestState) return;
  renderPlayers();
  renderStatus();
  renderGrid();
  maybeShowVictoryModal();
};

const renderPlayers = () => {
  playersListEl.innerHTML = "";
  latestState.players.forEach((player) => {
    const wrapper = document.createElement("div");
    wrapper.className = `player-item${
      player.status === "Defeated" ? " defeated" : ""
    }`;

    const info = document.createElement("div");
    info.className = "player-info";

    const colorDot = document.createElement("span");
    colorDot.className = "player-color";
    colorDot.style.backgroundColor = player.couleur;

    const name = document.createElement("span");
    name.textContent = player.pseudo;

    info.append(colorDot, name);

    if (
      latestState.gameStatus === "Finished" &&
      latestState.winnerId &&
      player.id === latestState.winnerId
    ) {
      const winnerIcon = document.createElement("span");
      winnerIcon.className = "winner-icon";
      winnerIcon.textContent = "🏆";
      winnerIcon.title = "Gagnant";
      info.appendChild(winnerIcon);
    }

    const stats = document.createElement("div");
    stats.className = "player-stats";

    const hpStat = document.createElement("span");
    hpStat.className = "stat hp";
    hpStat.textContent = `PV ${player.pdv}`;

    const shieldStat = document.createElement("span");
    shieldStat.className = "stat shield";
    const shieldIcon = document.createElement("span");
    shieldIcon.className = "icon-shield";
    shieldIcon.setAttribute("aria-hidden", "true");
    shieldStat.append(
      shieldIcon,
      document.createTextNode(player.obstaclesRestants)
    );

    stats.append(hpStat, shieldStat);

    if (
      player.id === latestState.currentPlayerTurn &&
      latestState.gameStatus === "InProgress"
    ) {
      const turnStat = document.createElement("span");
      turnStat.className = "stat turn";
      turnStat.textContent = "Tour";
      stats.appendChild(turnStat);
    }
    if (player.id === playerId) {
      name.textContent += " (toi)";
    }

    wrapper.append(info, stats);
    playersListEl.appendChild(wrapper);
  });
};

const renderStatus = () => {
  if (!latestState) return;
  gameStatusEl.textContent = `Statut : ${latestState.gameStatus}`;
  const currentPlayer = latestState.players.find(
    (player) => player.id === latestState.currentPlayerTurn
  );
  if (currentPlayer && latestState.gameStatus === "InProgress") {
    turnStatusEl.textContent = `Tour de ${currentPlayer.pseudo}`;
  } else {
    turnStatusEl.textContent = "";
  }

  winnerStatusEl.textContent = latestState.winner
    ? `Gagnant : ${latestState.winner} 🏆`
    : "";
};

const renderGrid = () => {
  gridEl.innerHTML = "";
  if (!latestState) return;
  gridEl.style.setProperty("--grid-size", latestState.gridSize);

  const playersMap = new Map();
  latestState.players.forEach((player) => {
    if (player.position) {
      playersMap.set(`${player.position.x}-${player.position.y}`, player);
    }
  });

  const obstacleMap = new Map();
  latestState.obstacles.forEach((obstacle) => {
    obstacleMap.set(`${obstacle.position.x}-${obstacle.position.y}`, obstacle);
  });

  for (let y = 0; y < latestState.gridSize; y += 1) {
    for (let x = 0; x < latestState.gridSize; x += 1) {
      const key = `${x}-${y}`;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.x = x;
      cell.dataset.y = y;

      if (playersMap.has(key)) {
        const occupant = playersMap.get(key);
        cell.classList.add("player");
        cell.style.backgroundColor = occupant.couleur;
        const icon = createPlayerIcon();

        const label = document.createElement("span");
        label.className = "cell-label";
        label.textContent = "";

        cell.append(icon, label);
        if (occupant.id === latestState.currentPlayerTurn) {
          cell.classList.add("current");
        }
        if (occupant.status === "Defeated") {
          cell.classList.add("blocked");
        }
      } else if (obstacleMap.has(key)) {
        const obstacle = obstacleMap.get(key);
        cell.classList.add("obstacle");
        const icon = document.createElement("span");
        icon.className = "cell-icon obstacle-icon";
        icon.textContent = "🛡";

        const hpLabel = document.createElement("span");
        hpLabel.className = "cell-label obstacle-hp";
        hpLabel.textContent = `${obstacle.pdv} PV`;

        cell.append(icon, hpLabel);
        cell.title = `Obstacle (${obstacle.pdv} PDV)`;
      }

      gridEl.appendChild(cell);
    }
  }
};

const maybeShowVictoryModal = () => {
  if (!victoryModal || !latestState) return;
  if (latestState.gameStatus === "Finished" && !victoryDisplayed) {
    showVictoryModal();
  } else if (victoryDisplayed && latestState.gameStatus !== "Finished") {
    hideVictoryModal();
  }
};

const showVictoryModal = () => {
  if (!victoryModal || !latestState) return;
  const hasWinner = Boolean(latestState.winner);
  if (victoryTitleEl) {
    victoryTitleEl.textContent = hasWinner
      ? `${latestState.winner} remporte la partie !`
      : "Match nul";
  }
  if (victoryMessageEl) {
    victoryMessageEl.textContent = hasWinner
      ? "Bravo ! Relancez une partie pour continuer."
      : "Aucun vainqueur. Cliquez sur le bouton pour relancer.";
  }
  victoryModal.classList.add("visible");
  victoryModal.setAttribute("aria-hidden", "false");
  victoryDisplayed = true;
  if (resetGameBtn) {
    resetGameBtn.disabled = false;
    resetGameBtn.textContent = "Nouvelle partie";
  }
};

const hideVictoryModal = () => {
  if (!victoryModal) return;
  victoryModal.classList.remove("visible");
  victoryModal.setAttribute("aria-hidden", "true");
  victoryDisplayed = false;
};

const handleGameReset = (payload = {}) => {
  playerId = null;
  selectedAction = null;
  actionButtons.forEach((btn) => btn.classList.remove("active"));
  enableJoinForm();
  hideVictoryModal();
  if (resetGameBtn) {
    resetGameBtn.disabled = false;
    resetGameBtn.textContent = "Nouvelle partie";
  }
  showLog(payload.message || "Nouvelle partie disponible.", "success");
};

const showLog = (message, level = "info") => {
  if (!message) return;
  logEl.textContent = message;
  logEl.dataset.level = level;
};

/*connectSocket();
renderGrid();*/
