// index.js

require('dotenv').config();
const express      = require('express');
const mongoose     = require('mongoose');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const fetch        = require('node-fetch');

const app = express();

// ─── MANUAL CORS MIDDLEWARE ───────────────────────────────────────────────────
// Allow your Firebase front-end to call these endpoints:
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  'https://snapbitportal.web.app');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// ───────────────────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(cookieParser());

const {
  MONGO_URI,
  API_KEY,
  ROBLOX_CLIENT_ID,
  ROBLOX_CLIENT_SECRET
} = process.env;

const PORT         = process.env.PORT || 3000;
const REDIRECT_URI = 'https://snapbit-api.onrender.com/oauth/callback';

mongoose.connect(MONGO_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

const tokenSchema = new mongoose.Schema({
  userId:       { type: String, unique: true, required: true },
  tokens:       { type: Number, default: 0 },
  league:       { type: String, default: 'Bronze' },
  isRegistered: { type: Boolean, default: false }
});
const Token = mongoose.model('Token', tokenSchema);

function calculateLeague(tokenCount) {
  if (tokenCount >= 50) return 'Diamond';
  if (tokenCount >= 30) return 'Sapphire';
  if (tokenCount >= 20) return 'Gold';
  if (tokenCount >= 10) return 'Silver';
  return 'Bronze';
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure:   true,
    sameSite: 'None',
    path:     '/'
  };
}

// Auth header check (skips health/auth routes)
app.use((req, res, next) => {
  if (
    req.path === '/health' ||
    req.path.startsWith('/auth') ||
    req.path.startsWith('/oauth/')
  ) {
    return next();
  }
  const auth = req.get('Authorization') || '';
  if (auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => {
  return res.json({ status: 'ok' });
});

app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, cookieOptions());

  const authorizeUrl = new URL('https://apis.roblox.com/oauth/v1/authorize');
  authorizeUrl.searchParams.set('client_id',     ROBLOX_CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
  authorizeUrl.searchParams.set('scope',         'openid profile');
  authorizeUrl.searchParams.set('state',         state);

  return res.redirect(authorizeUrl.toString());
});

app.get('/oauth/callback', async (req, res) => {
  const { code, state: returnedState, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/auth?error=${encodeURIComponent(error)}`);
  }

  const storedState = req.cookies.oauth_state;
  if (!returnedState || returnedState !== storedState) {
    return res.redirect(`/auth?error=state_mismatch`);
  }

  let tokenData;
  try {
    const tokenUrl  = 'https://apis.roblox.com/oauth/v1/token';
    const basicAuth = Buffer.from(
      `${ROBLOX_CLIENT_ID}:${ROBLOX_CLIENT_SECRET}`
    ).toString('base64');
    const params = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    });

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.error(`Token exchange failed ${tokenRes.status}:`, txt);
      return res.redirect(`/auth?error=token_exchange_failed`);
    }
    tokenData = await tokenRes.json();
  } catch (err) {
    console.error('Token exchange error:', err);
    return res.redirect(`/auth?error=token_exchange_error`);
  }

  let userInfo;
  try {
    const userRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) {
      const txt = await userRes.text();
      console.error(`Userinfo fetch failed ${userRes.status}:`, txt);
      return res.redirect(`/auth?error=userinfo_failed`);
    }
    userInfo = await userRes.json();
  } catch (err) {
    console.error('Userinfo error:', err);
    return res.redirect(`/auth?error=userinfo_error`);
  }

  const robloxId = userInfo.sub;
  res.clearCookie('oauth_state', cookieOptions());
  return res.redirect(`https://snapbitportal.web.app/dashboard?userId=${robloxId}`);
});

app.get('/tokens', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  let record = await Token.findOne({ userId });
  if (!record) {
    record = await Token.create({ userId, tokens: 0, league: 'Bronze', isRegistered: false });
  } else {
    const newLeague = calculateLeague(record.tokens);
    if (newLeague !== record.league) {
      record.league = newLeague;
      await record.save();
    }
  }

  return res.json({
    userId:       record.userId,
    tokens:       record.tokens,
    league:       record.league,
    isRegistered: record.isRegistered
  });
});

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
  const updatedLeague = calculateLeague(record.tokens);
  if (updatedLeague !== record.league) {
    record.league = updatedLeague;
    await record.save();
  }
  return res.json({
    userId:   record.userId,
    newTotal: record.tokens,
    league:   record.league
  });
});

app.post('/tokens/register', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const record = await Token.findOneAndUpdate(
    { userId },
    { isRegistered: true },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return res.json({ userId: record.userId, isRegistered: record.isRegistered });
});

app.listen(PORT, () => {
  console.log(`🚀 SnapBit API listening on port ${PORT}`);
});
