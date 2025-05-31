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
});

// 2) Define the Token model (with isRegistered + league fields)
const tokenSchema = new mongoose.Schema({
  userId:       { type: String, unique: true, required: true },
  tokens:       { type: Number, default: 0 },
  isRegistered: { type: Boolean, default: false },
  league:       { type: String, default: 'Bronze' },
});
const Token = mongoose.model('Token', tokenSchema);

// 3) API‐key middleware (skips /health)
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.get('Authorization') || '';
  if (auth !== `Bearer ${process.env.API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// 4) Health‐check route
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Helper: assign league based on token count
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

// 5) GET /tokens?userId=XYZ
//    - Create a new record with 0 tokens if none exists
app.get('/tokens', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  let record = await Token.findOne({ userId });
  if (!record) {
    record = await Token.create({
      userId,
      tokens: 0,
      isRegistered: false,
      league: 'Bronze'
    });
  }

  return res.json({
    userId:       record.userId,
    tokens:       record.tokens,
    isRegistered: record.isRegistered,
    league:       record.league
  });
});

// 6) POST /tokens/add  { userId, amount }
//    - Increment tokens, set isRegistered=true if first award, update league
app.post('/tokens/add', async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || typeof amount !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  let record = await Token.findOne({ userId });
  if (!record) {
    record = await Token.create({
      userId,
      tokens: 0,
      isRegistered: false,
      league: 'Bronze'
    });
  }

  if (!record.isRegistered) {
    record.isRegistered = true;
  }

  record.tokens += amount;
  record.league = determineLeague(record.tokens);
  await record.save();

  return res.json({ userId, newTotal: record.tokens, league: record.league });
});

// 7) Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT);
