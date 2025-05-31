require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// -------------------------------------------------------------------
// 1) Logger middleware (skips /health)
// -------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const now = new Date().toISOString();
  console.log(`\n[${now}] ▶ ${req.method} ${req.path}`);
  if (req.method === 'GET')  console.log('   → Query:', req.query);
  if (req.method === 'POST') console.log('   → Body :',  req.body);
  next();
});

// -------------------------------------------------------------------
// 2) Connect to MongoDB
// -------------------------------------------------------------------
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true,
})
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// -------------------------------------------------------------------
// 3) Define the Token model (with isRegistered + league fields)
// -------------------------------------------------------------------
const tokenSchema = new mongoose.Schema({
  userId:       { type: String, unique: true, required: true },
  tokens:       { type: Number, default: 0 },
  isRegistered: { type: Boolean, default: false },
  league:       { type: String, default: 'Bronze' },
});
const Token = mongoose.model('Token', tokenSchema);

// -------------------------------------------------------------------
// 4) API‐key middleware (skips /health)
// -------------------------------------------------------------------
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

// -------------------------------------------------------------------
// 5) Health‐check route
// -------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// -------------------------------------------------------------------
// Helper: assign league based on token count
//  Silver: ≥10, Gold: ≥20, then higher leagues at growing thresholds
// -------------------------------------------------------------------
function determineLeague(tokenCount) {
  if (tokenCount >= 2000) return 'Diamond';
  if (tokenCount >= 1000) return 'Obsidian';
  if (tokenCount >= 500)  return 'Ruby';
  if (tokenCount >= 200)  return 'Emerald';
  if (tokenCount >= 100)  return 'Sapphire';
  if (tokenCount >= 50)   return 'Platinum';
  if (tokenCount >= 20)   return 'Gold';
  if (tokenCount >= 10)   return 'Silver';
  return 'Bronze';
}

// -------------------------------------------------------------------
// 6) GET /tokens?userId=XYZ
//    - If no record exists, create one at 0 tokens, isRegistered=false, league=Bronze.
//    - Always return { userId, tokens, isRegistered, league }.
// -------------------------------------------------------------------
app.get('/tokens', async (req, res) => {
  const { userId } = req.query;
  console.log(`   ↪ Fetching tokens for userId=${userId}`);
  if (!userId) {
    console.warn('   ⚠️ Missing userId');
    return res.status(400).json({ error: 'Missing userId' });
  }

  let record = await Token.findOne({ userId });
  if (!record) {
    console.log('   ↪ No record found—creating new record with 0 tokens');
    record = await Token.create({
      userId,
      tokens: 0,
      isRegistered: false,
      league: 'Bronze'
    });
  } else {
    console.log(`   ↪ Existing record: tokens=${record.tokens}, league=${record.league}`);
  }

  return res.json({
    userId:       record.userId,
    tokens:       record.tokens,
    isRegistered: record.isRegistered,
    league:       record.league
  });
});

// -------------------------------------------------------------------
// 7) POST /tokens/add  { userId, amount }
//    - Increments tokens; sets isRegistered=true on first award;
//      recalculates league based on new total.
// -------------------------------------------------------------------
app.post('/tokens/add', async (req, res) => {
  const { userId, amount } = req.body;
  console.log(`   ↪ Adding tokens: userId=${userId}, amount=${amount}`);
  if (!userId || typeof amount !== 'number') {
    console.warn('   ⚠️ Missing or invalid fields');
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  let record = await Token.findOne({ userId });
  if (!record) {
    console.log('   ↪ No record on /tokens/add—creating base record with amount=0 first');
    record = await Token.create({
      userId,
      tokens: 0,
      isRegistered: false,
      league: 'Bronze'
    });
  }

  // If this is their first time actually getting tokens via /tokens/add,
  // mark them as registered now (if not already).
  if (!record.isRegistered) {
    record.isRegistered = true;
  }

  // Increment token count
  record.tokens += amount;
  // Recompute league
  record.league = determineLeague(record.tokens);
  await record.save();

  console.log(`   ✅ New total for ${userId}: ${record.tokens} (league=${record.league})`);
  return res.json({ userId, newTotal: record.tokens, league: record.league });
});

// -------------------------------------------------------------------
// 8) Start the server
// -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SnapBit API listening on http://localhost:${PORT}`);
});
