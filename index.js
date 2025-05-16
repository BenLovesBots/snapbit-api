require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// 1) Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// 2) Define the Token model
const tokenSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  tokens: { type: Number, default: 0 },
});
const Token = mongoose.model('Token', tokenSchema);

// 3) API-key middleware (skip health-check)
app.use((req, res, next) => {
  if (req.path === '/health') return next();    // allow unauthenticated pings
  const auth = req.get('Authorization') || '';
  if (auth !== `Bearer ${process.env.API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});
// 4) Health-check (no auth)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 5) GET /tokens?userId=123
app.get('/tokens', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  let record = await Token.findOne({ userId });
  if (!record) {
    record = await Token.create({ userId, tokens: 0 });
  }
  res.json({ userId, tokens: record.tokens });
});

// 6) POST /tokens/add  { userId, amount }
app.post('/tokens/add', async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || typeof amount !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  const record = await Token.findOneAndUpdate(
    { userId },
    { $inc: { tokens: amount } },
    { new: true, upsert: true }
  );
  res.json({ userId, newTotal: record.tokens });
});

// 7) Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SnapBit API listening on http://localhost:${PORT}`);
});
