const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- Serve frontend estático ---
app.use(express.static(path.join(__dirname, '../frontend/public')));

// --- Conexão PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// --- Inicializa tabelas ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS numbers (
      number INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'available'
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS purchase_numbers (
      purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      PRIMARY KEY (purchase_id, number)
    );
  `);
  console.log('✅ Tabelas verificadas/criadas');
}

// --- Auth middleware ---
function adminAuth(req, res, next) {
  const auth = req.headers['x-admin-auth'];
  if (auth === 'admin:485327') return next();
  return res.status(401).json({ error: 'Não autorizado' });
}

// ==========================================
// PUBLIC ROUTES
// ==========================================

// Get all numbers with their status
app.get('/api/numbers', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT number, status FROM numbers');
    const numbersMap = {};
    rows.forEach(r => { numbersMap[r.number] = r.status; });

    const result = {};
    for (let i = 1; i <= 1000; i++) {
      result[i] = numbersMap[i] || 'available';
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Reserve numbers (before payment)
app.post('/api/reserve', async (req, res) => {
  const { numbers, name, phone } = req.body;
  if (!numbers || !Array.isArray(numbers) || numbers.length === 0)
    return res.status(400).json({ error: 'Nenhum número informado' });
  if (!name || !phone)
    return res.status(400).json({ error: 'Nome e telefone são obrigatórios' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Trava as linhas para evitar race condition
    const { rows: unavailableRows } = await client.query(
      `SELECT number FROM numbers WHERE number = ANY($1) AND status != 'available'`,
      [numbers]
    );

    if (unavailableRows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Números indisponíveis: ${unavailableRows.map(r => r.number).join(', ')}`
      });
    }

    const reservationId = `RES-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const createdAt = new Date();
    const total = numbers.length * 2;

    await client.query(
      `INSERT INTO purchases (id, name, phone, status, total, created_at, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6)`,
      [reservationId, name, phone, total, createdAt, expiresAt]
    );

    for (const n of numbers) {
      await client.query(
        `INSERT INTO numbers (number, status) VALUES ($1, 'reserved')
         ON CONFLICT (number) DO UPDATE SET status = 'reserved'`,
        [n]
      );
      await client.query(
        `INSERT INTO purchase_numbers (purchase_id, number) VALUES ($1, $2)`,
        [reservationId, n]
      );
    }

    await client.query('COMMIT');
    res.json({ reservationId, total, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Erro ao reservar números' });
  } finally {
    client.release();
  }
});

// Confirm payment
app.post('/api/confirm/:reservationId', adminAuth, async (req, res) => {
  const { reservationId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT * FROM purchases WHERE id = $1', [reservationId]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reserva não encontrada' });
    }

    const confirmedAt = new Date();
    await client.query(
      `UPDATE purchases SET status = 'confirmed', confirmed_at = $1 WHERE id = $2`,
      [confirmedAt, reservationId]
    );

    const { rows: numRows } = await client.query(
      'SELECT number FROM purchase_numbers WHERE purchase_id = $1',
      [reservationId]
    );
    for (const { number } of numRows) {
      await client.query(`UPDATE numbers SET status = 'sold' WHERE number = $1`, [number]);
    }

    await client.query('COMMIT');

    const { rows: updated } = await client.query('SELECT * FROM purchases WHERE id = $1', [reservationId]);
    const nums = numRows.map(r => r.number);
    res.json({ success: true, purchase: { ...updated[0], numbers: nums } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Erro ao confirmar reserva' });
  } finally {
    client.release();
  }
});

// Expire old reservations manually
app.post('/api/cleanup', async (req, res) => {
  try {
    const cleaned = await cleanupExpired();
    res.json({ cleaned });
  } catch (err) {
    res.status(500).json({ error: 'Erro no cleanup' });
  }
});

// ==========================================
// ADMIN ROUTES
// ==========================================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === '485327') {
    res.json({ token: 'admin:485327', success: true });
  } else {
    res.status(401).json({ error: 'Credenciais inválidas' });
  }
});

app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  try {
    const { rows: soldRows } = await pool.query(`SELECT COUNT(*) as c FROM numbers WHERE status = 'sold'`);
    const { rows: reservedRows } = await pool.query(`SELECT COUNT(*) as c FROM numbers WHERE status = 'reserved'`);
    const sold = parseInt(soldRows[0].c);
    const reserved = parseInt(reservedRows[0].c);
    const available = 1000 - sold - reserved;
    const revenue = sold * 2;

    const { rows: purchases } = await pool.query('SELECT * FROM purchases ORDER BY created_at DESC');

    const purchasesWithNumbers = await Promise.all(purchases.map(async p => {
      const { rows: numRows } = await pool.query(
        'SELECT number FROM purchase_numbers WHERE purchase_id = $1', [p.id]
      );
      return {
        id: p.id, name: p.name, phone: p.phone, status: p.status,
        statusLabel: p.status === 'confirmed' ? 'Confirmado' : p.status === 'pending' ? 'Aguardando' : 'Expirado',
        total: p.total,
        numbers: numRows.map(r => r.number),
        createdAt: p.created_at,
        expiresAt: p.expires_at,
        confirmedAt: p.confirmed_at || null
      };
    }));

    res.json({ sold, reserved, available, revenue, purchases: purchasesWithNumbers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

app.delete('/api/admin/purchase/:id', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT * FROM purchases WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Não encontrado' });
    }

    const { rows: numRows } = await client.query(
      'SELECT number FROM purchase_numbers WHERE purchase_id = $1', [req.params.id]
    );
    for (const { number } of numRows) {
      await client.query(`UPDATE numbers SET status = 'available' WHERE number = $1`, [number]);
    }

    // ON DELETE CASCADE cuida de purchase_numbers automaticamente
    await client.query('DELETE FROM purchases WHERE id = $1', [req.params.id]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Erro ao deletar compra' });
  } finally {
    client.release();
  }
});

// ==========================================
// CLEANUP
// ==========================================

async function cleanupExpired() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: expired } = await client.query(
      `SELECT id FROM purchases WHERE status = 'pending' AND expires_at < NOW()`
    );

    for (const { id } of expired) {
      const { rows: numRows } = await client.query(
        'SELECT number FROM purchase_numbers WHERE purchase_id = $1', [id]
      );
      for (const { number } of numRows) {
        await client.query(
          `UPDATE numbers SET status = 'available' WHERE number = $1 AND status = 'reserved'`, [number]
        );
      }
      await client.query(`UPDATE purchases SET status = 'expired' WHERE id = $1`, [id]);
    }

    await client.query('COMMIT');
    return expired.length;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro no cleanup:', err);
    return 0;
  } finally {
    client.release();
  }
}

setInterval(cleanupExpired, 5 * 60 * 1000);

// --- Start ---
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Backend rodando na porta ${PORT}`));
}).catch(err => {
  console.error('❌ Falha ao conectar no banco:', err);
  process.exit(1);
});
