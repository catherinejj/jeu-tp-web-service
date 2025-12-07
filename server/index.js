const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const { supabase } = require("../supabaseClient");
const jwt = require("jsonwebtoken");
const url = require("url");

const {
  GameStateManager,
  MAX_PLAYERS,
  ALLOWED_GRID_SIZES,
} = require("./gameState");

const { specs, swaggerUi } = require("../swagger");

const authRouter = require("./auth");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-key-change-me";

const PORT = process.env.PORT || 3000;

const app = express();
const publicPath = path.join(__dirname, "..", "public");

app.use(express.json());

app.use(express.static(publicPath));

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Check if API is alive
 *     responses:
 *       200:
 *         description: API is up
 */
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * @swagger
 * /api/profile:
 *   get:
 *     summary: Get current authenticated player profile
 *     description: >
 *       Returns the information contained in the JWT of the currently authenticated player.
 *       The JWT must be provided via the HTTP header `Authorization: Bearer <token>`.
 *     tags:
 *       - Auth
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Authenticated user profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Authenticated profile endpoint
 *                 user:
 *                   type: object
 *                   properties:
 *                     sub:
 *                       type: string
 *                       description: Supabase user id
 *                       example: "uuid-1234"
                         # tu peux mettre un vrai exemple si tu veux
 *                     username:
 *                       type: string
 *                       example: "Cathy"
 *                     role:
 *                       type: string
 *                       example: "player"
 *       401:
 *         description: Missing or invalid JWT
 */
app.get("/api/profile", authRouter.jwtAuth, (req, res) => {
  res.json({
    message: "Authenticated profile endpoint",
    user: req.user,
  });
});

app.use("/api/auth", authRouter);

app.use("/docs", swaggerUi.serve, swaggerUi.setup(specs));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const game = new GameStateManager();
const clients = new Map();

const stringify = (type, payload) => JSON.stringify({ type, payload });

const send = (ws, type, payload) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(stringify(type, payload));
  }
};

const broadcast = (type, payload) => {
  const message = stringify(type, payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

const broadcastGameState = () => {
  broadcast("GAME_STATE_UPDATE", game.getSnapshot());
  if (game.state.gameStatus === "Finished") {
    broadcast("GAME_OVER", { winnerPseudo: game.state.winner });
  }
};

const parseGridSize = (value) => {
  const parsed = parseInt(value, 10);
  return ALLOWED_GRID_SIZES.includes(parsed) ? parsed : null;
};

wss.on("connection", (ws, req) => {
  // Try to extract and verify JWT from WebSocket URL query (?token=...)
  let userFromToken = null;
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const token = parsedUrl.searchParams.get("token");
    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);
      userFromToken = {
        id: decoded.sub,
        name: decoded.username,
        role: decoded.role,
      };
    }
  } catch (err) {
    console.error("[WebSocket] Invalid or missing token:", err.message);
  }

  // We store the user (if any) in the client metadata
  clients.set(ws, { type: "spectator", user: userFromToken });

  send(ws, "GAME_STATE_UPDATE", game.getSnapshot());

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      send(ws, "ACTION_INVALID", { message: "Invalid JSON message." });
      return;
    }
    const { type, payload } = message;
    switch (type) {
      case "JOIN_GAME":
        handleJoin(ws, payload);
        break;
      case "REQUEST_ACTION":
        handleRequestAction(ws, payload);
        break;
      case "RESET_GAME":
        handleResetGame(ws);
        break;
      default:
        send(ws, "ACTION_INVALID", { message: "Unknown message type." });
    }
  });

  ws.on("close", () => {
    handleDisconnect(ws);
    clients.delete(ws);
  });
});

const handleJoin = (ws, payload = {}) => {
  const clientMeta = clients.get(ws) || {};

  if (clientMeta.type === "player") {
    send(ws, "ACTION_INVALID", { message: "Player already joined." });
    return;
  }

  if (
    game.state.players.length >= MAX_PLAYERS ||
    game.state.gameStatus !== "Lobby"
  ) {
    send(ws, "JOINED_AS_SPECTATOR", {
      message: "Game full or already started, you are a spectator.",
    });
    return;
  }

  // Pseudo = username from token if available, otherwise from payload
  const pseudo =
    clientMeta.user && clientMeta.user.name
      ? clientMeta.user.name
      : payload.pseudo;

  try {
    const player = game.addPlayer({
      pseudo,
      color: payload.couleur || payload.color,
      gridSizeOverride: parseGridSize(payload.gridSize),
      // optionnel : lier aussi l'id Supabase
      userId: clientMeta.user ? clientMeta.user.id : null,
    });

    clients.set(ws, {
      ...clientMeta,
      type: "player",
      playerId: player.id,
    });

    send(ws, "JOINED_AS_PLAYER", { playerId: player.id });
    broadcastGameState();
  } catch (error) {
    send(ws, "ACTION_INVALID", { message: error.message });
  }
};

const handleRequestAction = (ws, payload = {}) => {
  const clientMeta = clients.get(ws);
  if (!clientMeta || clientMeta.type !== "player") {
    send(ws, "ACTION_INVALID", { message: "Spectators are not allowed." });
    return;
  }
  const { playerId } = clientMeta;
  if (game.state.gameStatus !== "InProgress") {
    send(ws, "ACTION_INVALID", { message: "Game must be in progress." });
    return;
  }
  if (game.state.currentPlayerTurn !== playerId) {
    send(ws, "ACTION_INVALID", { message: "Not your turn." });
    return;
  }

  try {
    switch (payload.actionType) {
      case "MOVE":
        game.executeMove(playerId, payload.target);
        break;
      case "ATTACK":
        game.executeAttack(playerId, payload.target);
        break;
      case "PLACE_OBSTACLE":
        game.executePlaceObstacle(playerId, payload.target);
        break;
      default:
        throw new Error("Unknown action.");
    }
    broadcastGameState();
  } catch (error) {
    send(ws, "ACTION_INVALID", { message: error.message });
  }
};

const handleResetGame = (ws) => {
  if (game.state.gameStatus !== "Finished") {
    send(ws, "ACTION_INVALID", {
      message: "Game is not finished yet.",
    });
    return;
  }

  game.resetGame();

  clients.forEach((meta, clientWs) => {
    clients.set(clientWs, { type: "spectator" });
    send(clientWs, "GAME_RESET", {
      message: "New game available. Join the lobby.",
    });
  });

  broadcastGameState();
};

const handleDisconnect = (ws) => {
  const meta = clients.get(ws);
  if (!meta || meta.type !== "player") return;
  game.removePlayer(meta.playerId);
  broadcastGameState();
};

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Swagger docs available at http://localhost:${PORT}/docs`);
});