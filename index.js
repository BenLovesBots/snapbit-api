// index.js

require('dotenv').config();
const express      = require('express');
const mongoose     = require('mongoose');
const crypto       = require('crypto');
const jwt          = require('jsonwebtoken');
const jwkToPem     = require('jwk-to-pem');
const cookieParser = require('cookie-parser');
const fetch        = require('node-fetch'); // v2.x

const app = express();
app.use(express.json());
app.use(cookieParser());

// ─── CONFIGURATION ─────────────────────────────────────────────────────────────
const {
  MONGO_URI,
  API_KEY,
  ROBLOX_CLIENT_ID,
  ROBLOX_CLIENT_SECRET
} = process.env;

const PORT         = process.env.PORT || 3000;
const REDIRECT_URI = 'https://snapbit-api.onrender.com/oauth/callback';

// ─── MONGOOSE SETUP ─────────────────────────────────────────────────────────────
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

// ─── LEAGUE CALCULATION ─────────────────────────────────────────────────────────
function calculateLeague(tokenCount) {
  if (tokenCount >= 50) return 'Diamond';
  if (tokenCount >= 30) return 'Sapphire';
  if (tokenCount >= 20) return 'Gold';
  if (tokenCount >= 10) return 'Silver';
  return 'Bronze';
}

// ─── COOKIE OPTIONS ──────────────────────────────────────────────────────────────
// Using SameSite=None and secure:true so Roblox’s cross-site redirect carries the cookie.
function cookieOptions() {
  return {
    httpOnly: true,
    secure:   true,
    sameSite: 'None',
    path:     '/'
  };
}

// ─── MIDDLEWARE: API-KEY CHECK ────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Skip API-key check for /health, /auth, /oauth/*
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

// ─── 1) Health-check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  return res.json({ status: 'ok' });
});

// ─── 2) /auth → REDIRECT TO ROBLOX AUTHORIZATION ─────────────────────────────────
app.get('/auth', (req, res) => {
  // Generate a random state and store it in a cookie
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, cookieOptions());

  // Construct Roblox’s /v1/authorize URL
  const authorizeUrl = new URL('https://apis.roblox.com/oauth/v1/authorize');
  authorizeUrl.searchParams.set('client_id',     ROBLOX_CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
  authorizeUrl.searchParams.set('scope',         'openid profile');
  authorizeUrl.searchParams.set('state',         state);

  return res.redirect(authorizeUrl.toString());
});

// ─── 3) /oauth/callback ──────────────────────────────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code, state: returnedState, error, error_description } = req.query;

  if (error) {
    const desc = decodeURIComponent(error_description || 'No description');
    return res.status(400).send(`Authorization failed: ${error} — ${desc}`);
  }

  const storedState = req.cookies.oauth_state;
  if (!returnedState || returnedState !== storedState) {
    return res.status(400).send(
      `Security check failed (state mismatch).<br>` +
      `Ensure you accessed via HTTPS and that cookies are enabled.`
    );
  }

  // Exchange authorization code for tokens
  let tokenData;
  try {
    const tokenUrl  = 'https://apis.roblox.com/oauth/v1/token';
    const basicAuth = Buffer.from(`${ROBLOX_CLIENT_ID}:${ROBLOX_CLIENT_SECRET}`)
                        .toString('base64');
    const params = new URLSearchParams({
      grant_type:   'authorization_code',
      code:         code,
      redirect_uri: REDIRECT_URI
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      console.error(`Token exchange failed. Status ${tokenResponse.status}: ${text}`);
      return res
        .status(tokenResponse.status)
        .send('Failed to exchange code for tokens (check server logs).');
    }

    tokenData = await tokenResponse.json();
  } catch (err) {
    console.error('Error during Roblox token exchange:', err);
    return res.status(500).send('Error during Roblox token exchange.');
  }

  // Call /v1/userinfo to get the user’s Roblox ID
  let userInfo;
  try {
    const userInfoUrl = 'https://apis.roblox.com/oauth/v1/userinfo';
    const userRes = await fetch(userInfoUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`
      }
    });
    if (!userRes.ok) {
      const text = await userRes.text();
      console.error('Failed to fetch userinfo. Status:', userRes.status, text);
      return res.status(500).send('Failed to fetch Roblox user info.');
    }
    userInfo = await userRes.json();
  } catch (err) {
    console.error('Error fetching userinfo:', err);
    return res.status(500).send('Error fetching Roblox user info.');
  }

  const robloxId = userInfo.sub;
  res.clearCookie('oauth_state', cookieOptions());

  return res.redirect(`https://snapbitportal.web.app/dashboard?userId=${robloxId}`);
});

// ─── 4) GET /tokens?userId=... ────────────────────────────────────────────────────
app.get('/tokens', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

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

// ─── 5) POST /tokens/add ─────────────────────────────────────────────────────────
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

// ─── 6) POST /tokens/register ────────────────────────────────────────────────────
app.post('/tokens/register', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  const record = await Token.findOneAndUpdate(
    { userId },
    { isRegistered: true },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return res.json({ userId: record.userId, isRegistered: record.isRegistered });
});

// ─── Start Server ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 SnapBit API listening on port ${PORT}`);
});
