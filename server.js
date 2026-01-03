import express from "express";
import pkg from "pg";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const { Pool } = pkg;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DATABASE_URL) {
  console.error("FALTANDO: DATABASE_URL no ambiente");
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 40) {
  console.error("FALTANDO/FRACA: JWT_SECRET (use 40+ caracteres) no ambiente");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// -------------------- helpers --------------------
function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

// -------------------- health --------------------
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e.message || e) });
  }
});

// -------------------- auth --------------------
// POST /auth/register  { username, password }
app.post("/auth/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (username.length < 3 || username.length > 40) {
      return res.status(400).json({ error: "username_invalid" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "password_too_short" });
    }

    // garante username único
    const exists = await pool.query(
      "select 1 from app_user where username = $1 limit 1",
      [username]
    );
    if (exists.rowCount > 0) {
      return res.status(409).json({ error: "username_taken" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const ins = await pool.query(
      `insert into app_user (username, password_hash)
       values ($1, $2)
       returning id, username, created_at`,
      [username, passwordHash]
    );

    const user = ins.rows[0];
    const token = signToken(user);
    return res.status(201).json({ token, user });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e.message || e) });
  }
});

// POST /auth/login { username, password }
app.post("/auth/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const r = await pool.query(
      "select id, username, password_hash from app_user where username = $1 limit 1",
      [username]
    );
    if (r.rowCount === 0) return res.status(401).json({ error: "invalid_credentials" });

    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = signToken(user);
    return res.json({ token, user: { id: user.id, username: user.username } });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e.message || e) });
  }
});

// GET /me (precisa token)
app.get("/me", authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      "select id, username, created_at from app_user where id = $1 limit 1",
      [req.user.sub]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ user: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
});
