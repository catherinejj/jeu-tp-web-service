// server/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { supabase } = require("../supabaseClient");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-key-change-me";
const JWT_EXPIRES_IN = "4h";

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Authenticate a player and return a JWT
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *             required:
 *               - username
 *               - password
 *     responses:
 *       200:
 *         description: Valid credentials, JWT returned
 *       401:
 *         description: Invalid credentials
 */
router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "username and password are required" });
  }

  // 1. Récupérer l'utilisateur
  const { data: user, error: fetchError } = await supabase
    .from("users")
    .select("id, name, password, role")
    .eq("name", username)
    .single();

  if (fetchError || !user) {
    console.error("[auth/login] Supabase fetch error:", fetchError);
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // 2. Vérifier le mot de passe
  const isValidPassword = await bcrypt.compare(password, user.password);
  if (!isValidPassword) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // 3. Générer le JWT
  const payload = {
    sub: user.id,
    username: user.name,
    role: user.role || "player",
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  // 4. Calculer la date d’expiration
  const decoded = jwt.decode(token);
  let expiresAt = null;
  if (decoded && decoded.exp) {
    expiresAt = new Date(decoded.exp * 1000).toISOString();
  }

  console.log("[auth/login] token generated for", user.name, "exp:", expiresAt);

  // 5. Mettre à jour la table users
  const { error: updateError } = await supabase
    .from("users")
    .update({
      jwt_token: token,
      jwt_expires_at: expiresAt,
    })
    .eq("id", user.id);

  if (updateError) {
    console.error("[auth/login] Failed to store JWT:", updateError);
    // on ne casse pas le login, mais on le voit dans la console
  } else {
    console.log("[auth/login] JWT stored for user id =", user.id);
  }

  return res.status(200).json({
    token,
    user: {
      id: user.id,
      username: user.name,
      role: user.role || "player",
      expiresAt,
    },
  });
});

/// ---------- JWT middleware ----------

/**
 * JWT auth middleware using Authorization: Bearer <token>
 * + vérification dans la table users (token toujours présent ?).
 */
const jwtAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.split(" ")[1];

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // Vérifier que ce token est toujours celui stocké en BDD
  const { data: user, error } = await supabase
    .from("users")
    .select("id, name, role, jwt_expires_at")
    .eq("id", decoded.sub)
    .eq("jwt_token", token)
    .single();

  if (error || !user) {
    // Si la ligne n'existe plus ou le jwt_token ne correspond pas → token révoqué
    return res.status(401).json({ error: "Token revoked or not found" });
  }

  req.user = {
    id: user.id,
    username: user.name,
    role: user.role || "player",
    expiresAt: user.jwt_expires_at,
  };

  return next();
};

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current authenticated player information
 *     tags:
 *       - Auth
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Authenticated user data
 *       401:
 *         description: Missing or invalid token
 */
router.get("/me", jwtAuth, (req, res) => {
  return res.status(200).json({ user: req.user });
});

// middleware sur le router
router.jwtAuth = jwtAuth;

module.exports = router;