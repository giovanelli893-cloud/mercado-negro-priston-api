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
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

function normalizeUsername(u) {
  return String(u || "").trim();
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
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");

    if (username.length < 3 || username.length > 40) {
      return res.status(400).json({ error: "username_invalid" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "password_too_short" });
    }

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
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");

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

// -------------------- ads --------------------
// POST /ads  (precisa token)
app.post("/ads", authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};

    // Obrigatórios (batendo com sua tabela "ad")
    const required = [
      "image_filename",
      "item_title",
      "item_category",
      "character_category",
      "contact_type",
      "contact_handle",
    ];

    for (const k of required) {
      if (!b[k] || String(b[k]).trim() === "") {
        return res.status(400).json({ error: `missing_${k}` });
      }
    }

    const stats = b.stats && typeof b.stats === "object" ? b.stats : {};
    const observation = String(b.observation || "").trim();

    // pega username do dono
    const u = await pool.query("select username from app_user where id = $1 limit 1", [req.user.sub]);
    if (u.rowCount === 0) return res.status(401).json({ error: "invalid_user" });
    const ownerUsername = u.rows[0].username;

    // Mapeia stats (vem como json do app) -> colunas da tabela "ad"
    const paMin = stats.pa_min ?? null;
    const paMax = stats.pa_max ?? null;
    const criticoPct = stats.critico_pct ?? null;
    const bloqueioPct = stats.bloqueio_pct ?? null;
    const criticoAdicionalPct = stats.critico_adicional_pct ?? null;

    const ins = await pool.query(
      `insert into ad (
        owner_user_id, owner_username,
        image_filename, item_title,
        item_category, character_category,
        contact_type, contact_handle,
        observation,
        pa_min, pa_max,
        vel_arma, alcance, critico_pct, taxa_ataque, limite_pocoes, bloqueio_pct, bonus,
        regen_res, regen_hp, regen_mp,
        hp_adicional, taxa_defesa, absorcao, velocidade, mp_adicional,
        res_organica, res_fogo, res_gelo, res_raio, res_veneno,
        nivel_necessario, forca_necessaria, inteligencia_necessaria, talento_necessario, agilidade_necessaria,
        spec_atq_spd1, p_atq_adicional_lv, critico_adicional_pct, taxa_atq_ad_lv, def_adicional, abs_adicional, vel_adicional, spec_atq_spd2,
        regen_mp2, spec_alcance, spec_rng, bonus_magico, spec_regen_mp
      ) values (
        $1,$2,
        $3,$4,
        $5,$6,
        $7,$8,
        $9,
        $10,$11,
        $12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,
        $22,$23,$24,$25,$26,
        $27,$28,$29,$30,$31,
        $32,$33,$34,$35,$36,
        $37,$38,$39,$40,$41,$42,$43,$44,
        $45,$46,$47,$48,$49
      ) returning id, created_at`,
      [
        req.user.sub, ownerUsername,
        String(b.image_filename).trim(),
        String(b.item_title).trim(),
        String(b.item_category).trim(),
        String(b.character_category).trim(),
        String(b.contact_type).trim(),
        String(b.contact_handle).trim(),
        observation,

        paMin, paMax,

        stats.vel_arma ?? null,
        stats.alcance ?? null,
        criticoPct,
        stats.taxa_ataque ?? null,
        stats.limite_pocoes ?? null,
        bloqueioPct,
        stats.bonus ?? null,

        stats.regen_res ?? null,
        stats.regen_hp ?? null,
        stats.regen_mp ?? null,

        stats.hp_adicional ?? null,
        stats.taxa_defesa ?? null,
        stats.absorcao ?? null,
        stats.velocidade ?? null,
        stats.mp_adicional ?? null,

        stats.res_organica ?? null,
        stats.res_fogo ?? null,
        stats.res_gelo ?? null,
        stats.res_raio ?? null,
        stats.res_veneno ?? null,

        stats.nivel_necessario ?? null,
        stats.forca_necessaria ?? null,
        stats.inteligencia_necessaria ?? null,
        stats.talento_necessario ?? null,
        stats.agilidade_necessaria ?? null,

        stats.spec_atq_spd1 ?? null,
        stats.p_atq_adicional_lv ?? null,
        criticoAdicionalPct,
        stats.taxa_atq_ad_lv ?? null,
        stats.def_adicional ?? null,
        stats.abs_adicional ?? null,
        stats.vel_adicional ?? null,
        stats.spec_atq_spd2 ?? null,

        stats.regen_mp2 ?? null,
        stats.spec_alcance ?? null,
        stats.spec_rng ?? null,
        stats.bonus_magico ?? null,
        stats.spec_regen_mp ?? null,
      ]
    );

    return res.status(201).json({ id: ins.rows[0].id, created_at: ins.rows[0].created_at });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e.message || e) });
  }
});
// =========================
// ADS
// =========================

// POST /ads  (criar anúncio)
app.post("/ads", authMiddleware, async (req, res) => {
  try {
    const {
      item_title,
      image_filename,
      item_category,
      character_category,
      contact_type,
      contact_handle,
      observation,
      stats
    } = req.body;

    if (!item_title || !image_filename || !item_category || !character_category) {
      return res.status(400).json({ error: "dados obrigatórios faltando" });
    }

    const result = await pool.query(
      `insert into ad (
        owner_user_id,
        owner_username,
        image_filename,
        item_title,
        item_category,
        character_category,
        contact_type,
        contact_handle,
        observation,
        stats
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      returning id, created_at`,
      [
        req.user.sub,
        req.user.username,
        image_filename,
        item_title,
        item_category,
        character_category,
        contact_type,
        contact_handle,
        observation || "",
        stats || {}
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error("CREATE AD ERROR:", e);
    return res.status(500).json({ error: "erro ao criar anúncio" });
  }
});

app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
});
