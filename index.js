require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// Simple logger middleware
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`\n[${now}] ▶ ${req.method} ${req.path}`);
  if (req.method === 'GET')    console.log('   → Query:', req.query);
  if (req.method === 'POST')   console.log('   → Body :', req.body);
  next();
});

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

// 3) API-key middleware (skips /health)
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.get('Authorization') || '';
  console.log(`   → Authorization header: ${auth}`);
  if (auth !== `Bearer ${process.env.API_KEY}`) {
    console.warn(`❌ Unauthorized request to ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// 4) Health-check (no auth)
// Simple logger middleware
app.use((req, res, next) => {
  // Skip logging for the health endpoint
  if (req.path === '/health') return next();

  const now = new Date().toISOString();
  console.log(`\n[${now}] ▶ ${req.method} ${req.path}`);
  if (req.method === 'GET')    console.log('   → Query:', req.query);
  if (req.method === 'POST')   console.log('   → Body :', req.body);
  next();
});

// 5) GET /tokens?userId=123
app.get('/tokens', async (req, res) => {
  const { userId } = req.query;
  console.log(`   ↪ Fetching tokens for userId=${userId}`);
  if (!userId) {
    console.warn('   ⚠️ Missing userId');
    return res.status(400).json({ error: 'Missing userId' });
  }

  let record = await Token.findOne({ userId });
  if (!record) {
    console.log('   ↪ No record found–creating new one with 0 tokens');
    record = await Token.create({ userId, tokens: 0 });
  } else {
    console.log(`   ↪ Existing record: tokens=${record.tokens}`);
  }

  console.log(`   ✅ Responding with tokens=${record.tokens}`);
  res.json({ userId, tokens: record.tokens });
});

// 6) POST /tokens/add  { userId, amount }
app.post('/tokens/add', async (req, res) => {
  const { userId, amount } = req.body;
  console.log(`   ↪ Adding tokens: userId=${userId}, amount=${amount}`);
  if (!userId || typeof amount !== 'number') {
    console.warn('   ⚠️ Missing or invalid fields');
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  const record = await Token.findOneAndUpdate(
    { userId },
    { $inc: { tokens: amount } },
    { new: true, upsert: true }
  );
  console.log(`   ✅ New total for ${userId}: ${record.tokens}`);
  res.json({ userId, newTotal: record.tokens });
});

// 7) Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SnapBit API listening on http://localhost:${PORT}`);
});
