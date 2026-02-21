require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();

app.use(cors());
app.use(express.json());

// ─── Servir imágenes subidas ─────────────────────────────────────
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ─── Conexión DB ──────────────────────────────────────────────────
const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "fotovega",
  password: process.env.DB_PASSWORD || "postgres123",
  port: process.env.DB_PORT || 5432,
});

// ─── Multer (subida de imágenes) ──────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// ─── Middleware auth ──────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "fotovega_secret_dev";

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Sin token" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}

// ══════════════════════════════════════════════════════════════════
// RUTAS PÚBLICAS
// ══════════════════════════════════════════════════════════════════

// Health check
app.get("/", (req, res) => {
  res.json({ message: "Backend Fotovega funcionando 🚀" });
});

// ─── Contacto ────────────────────────────────────────────────────
app.post("/api/contacto", async (req, res) => {
  const { nombre, email, mensaje } = req.body;
  try {
    await pool.query(
      "INSERT INTO contacts (name, email, message) VALUES ($1, $2, $3)",
      [nombre, email, mensaje]
    );
    res.json({ ok: true, message: "Mensaje enviado ✅" });
  } catch (err) {
    res.status(500).json({ error: "Error al guardar contacto" });
  }
});

// ─── Eventos públicos ─────────────────────────────────────────────
app.get("/api/eventos", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM eventos WHERE activo = true ORDER BY fecha DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/eventos/:id", async (req, res) => {
  try {
    const evento = await pool.query(
      "SELECT * FROM eventos WHERE id = $1 AND activo = true",
      [req.params.id]
    );
    if (evento.rows.length === 0)
      return res.status(404).json({ error: "Evento no encontrado" });

    const fotos = await pool.query(
      "SELECT * FROM fotos WHERE evento_id = $1 AND activo = true ORDER BY created_at ASC",
      [req.params.id]
    );

    res.json({ evento: evento.rows[0], fotos: fotos.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Fotos individuales ───────────────────────────────────────────
app.get("/api/fotos/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT f.*, e.nombre as evento_nombre FROM fotos f JOIN eventos e ON f.evento_id = e.id WHERE f.id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Foto no encontrada" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// CARRITO Y ÓRDENES
// ══════════════════════════════════════════════════════════════════

// Crear orden (checkout)
app.post("/api/ordenes", async (req, res) => {
  const { email, nombre, items } = req.body;
  // items = [{ foto_id, precio }, ...]

  if (!items || items.length === 0)
    return res.status(400).json({ error: "Carrito vacío" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const total = items.reduce((sum, item) => sum + parseFloat(item.precio), 0);

    const ordenResult = await client.query(
      "INSERT INTO ordenes (email_comprador, nombre_comprador, total, estado) VALUES ($1, $2, $3, 'pendiente') RETURNING *",
      [email, nombre, total]
    );
    const orden = ordenResult.rows[0];

    for (const item of items) {
      await client.query(
        "INSERT INTO orden_items (orden_id, foto_id, precio_unitario) VALUES ($1, $2, $3)",
        [orden.id, item.foto_id, item.precio]
      );
    }

    await client.query("COMMIT");

    // ── MODO TEST: simular pago aprobado directamente ──────────────
    // Cuando integres MercadoPago real, acá va el preference_id
    res.json({
      ok: true,
      orden_id: orden.id,
      total,
      // En test simulamos que el pago se aprueba solo
      checkout_url: `http://localhost:5173/orden-confirmada/${orden.id}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Confirmar pago (modo test: lo marcamos como pagado)
app.post("/api/ordenes/:id/confirmar", async (req, res) => {
  try {
    await pool.query(
      "UPDATE ordenes SET estado = 'pagado' WHERE id = $1",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener orden con sus fotos (para la página de descarga)
app.get("/api/ordenes/:id", async (req, res) => {
  try {
    const orden = await pool.query(
      "SELECT * FROM ordenes WHERE id = $1",
      [req.params.id]
    );
    if (orden.rows.length === 0)
      return res.status(404).json({ error: "Orden no encontrada" });

    const items = await pool.query(
      `SELECT oi.*, f.url, f.url_alta, f.descripcion, e.nombre as evento_nombre
       FROM orden_items oi
       JOIN fotos f ON oi.foto_id = f.id
       JOIN eventos e ON f.evento_id = e.id
       WHERE oi.orden_id = $1`,
      [req.params.id]
    );

    res.json({ orden: orden.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Login
// ══════════════════════════════════════════════════════════════════

app.post("/api/admin/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query(
      "SELECT * FROM admins WHERE email = $1",
      [email]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: "Credenciales inválidas" });

    const admin = result.rows[0];
    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match)
      return res.status(401).json({ error: "Credenciales inválidas" });

    const token = jwt.sign({ id: admin.id, email: admin.email }, JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({ ok: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registrar primer admin (solo usar una vez, luego comentar o borrar)
app.post("/api/admin/setup", async (req, res) => {
  const { email, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO admins (email, password_hash) VALUES ($1, $2) RETURNING id, email",
      [email, hash]
    );
    res.json({ ok: true, admin: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ADMIN — Gestión de eventos y fotos (protegidas con JWT)
// ══════════════════════════════════════════════════════════════════

// Ver todos los eventos (incluyendo inactivos)
app.get("/api/admin/eventos", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT e.*, COUNT(f.id) as cantidad_fotos FROM eventos e LEFT JOIN fotos f ON f.evento_id = e.id GROUP BY e.id ORDER BY e.created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear evento
app.post("/api/admin/eventos", authMiddleware, upload.single("imagen"), async (req, res) => {
  const { nombre, descripcion, fecha, lugar } = req.body;
  const imagen_portada = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    const result = await pool.query(
      "INSERT INTO eventos (nombre, descripcion, fecha, lugar, imagen_portada) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [nombre, descripcion, fecha, lugar, imagen_portada]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar evento
app.put("/api/admin/eventos/:id", authMiddleware, upload.single("imagen"), async (req, res) => {
  const { nombre, descripcion, fecha, lugar, activo } = req.body;
  try {
    let query, params;
    if (req.file) {
      const imagen_portada = `/uploads/${req.file.filename}`;
      query = "UPDATE eventos SET nombre=$1, descripcion=$2, fecha=$3, lugar=$4, imagen_portada=$5, activo=$6 WHERE id=$7 RETURNING *";
      params = [nombre, descripcion, fecha, lugar, imagen_portada, activo, req.params.id];
    } else {
      query = "UPDATE eventos SET nombre=$1, descripcion=$2, fecha=$3, lugar=$4, activo=$5 WHERE id=$6 RETURNING *";
      params = [nombre, descripcion, fecha, lugar, activo, req.params.id];
    }
    const result = await pool.query(query, params);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar evento
app.delete("/api/admin/eventos/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM eventos WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Fotos del admin ──────────────────────────────────────────────

// Subir foto a un evento
app.post("/api/admin/fotos", authMiddleware, upload.single("foto"), async (req, res) => {
  const { evento_id, precio, descripcion } = req.body;
  if (!req.file) return res.status(400).json({ error: "No se recibió imagen" });

  const url = `/uploads/${req.file.filename}`;
  try {
    const result = await pool.query(
      "INSERT INTO fotos (evento_id, url, url_alta, precio, descripcion) VALUES ($1, $2, $2, $3, $4) RETURNING *",
      [evento_id, url, precio || 2000, descripcion]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ver fotos de un evento (admin)
app.get("/api/admin/eventos/:id/fotos", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM fotos WHERE evento_id = $1 ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar foto
app.delete("/api/admin/fotos/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM fotos WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ver todas las órdenes (admin)
app.get("/api/admin/ordenes", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM ordenes ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ver los formularios

app.get("/api/admin/contactos", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM contacts ORDER BY created_at DESC"
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
// ══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Servidor Fotovega corriendo en puerto ${PORT} 🚀`);
});