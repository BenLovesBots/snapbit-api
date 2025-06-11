// index.js

require('dotenv').config();
const express      = require('express');
const mongoose     = require('mongoose');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const fetch        = require('node-fetch');
const jwt          = require('jsonwebtoken');

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
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
  ROBLOX_CLIENT_SECRET,
  RAW_PRIVATE_KEY           // your PEM‐formatted private key in env
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

// enforce API_KEY (skip health & OAuth routes)
app.use((req, res, next) => {
  if (
    req.path === '/health' ||
    req.path.startsWith('/auth') ||
    req.path.startsWith('/oauth/')
  ) return next();
  const auth = req.get('Authorization') || '';
  if (auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// initial OAuth redirect
app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, cookieOptions());

  const authorizeUrl = new URL('https://apis.roblox.com/oauth/v1/authorize');
  authorizeUrl.searchParams.set('client_id',     ROBLOX_CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
  authorizeUrl.searchParams.set('scope',         'openid profile');
  authorizeUrl.searchParams.set('state',         state);

  res.redirect(authorizeUrl.toString());
});

// OAuth callback → sign JWT & redirect to front-end
app.get('/oauth/callback', async (req, res) => {
  const { code, state: returnedState, error } = req.query;

  // if user cancelled or error, send them to front-end with error flag
  if (error) {
    return res.redirect(`https://snapbitportal.web.app?error=${encodeURIComponent(error)}`);
  }

  const stored = req.cookies.oauth_state;
  if (!returnedState || returnedState !== stored) {
    return res.redirect(`https://snapbitportal.web.app?error=state_mismatch`);
  }

  // exchange code for tokens
  let tokenData;
  try {
    const basicAuth = Buffer.from(`${ROBLOX_CLIENT_ID}:${ROBLOX_CLIENT_SECRET}`).toString('base64');
    const params    = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
    });

    const tokenRes = await fetch('https://apis.roblox.com/oauth/v1/token', {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!tokenRes.ok) {
      return res.redirect(`https://snapbitportal.web.app?error=token_exchange_failed`);
    }
    tokenData = await tokenRes.json();
  } catch {
    return res.redirect(`https://snapbitportal.web.app?error=token_exchange_error`);
  }

  // fetch user info
  let userInfo;
  try {
    const userRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) {
      return res.redirect(`https://snapbitportal.web.app?error=userinfo_failed`);
    }
    userInfo = await userRes.json();
  } catch {
    return res.redirect(`https://snapbitportal.web.app?error=userinfo_error`);
  }

  // clear state cookie
  res.clearCookie('oauth_state', cookieOptions());

  // sign a short‐lived JWT with the Roblox ID & names
  const payload = {
    sub:         userInfo.sub,
    name:        userInfo.preferred_username || userInfo.nickname || userInfo.sub,
    displayName: userInfo.name || userInfo.sub,
    iat:         Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now()/1000) + 60
  };
  const privateKey = RAW_PRIVATE_KEY.replace(/\\n/g, '\n');
  const signedJwt  = jwt.sign(payload, privateKey, { algorithm: 'RS256' });

  // redirect with the token param instead of userId
  res.redirect(`https://snapbitportal.web.app/dashboard?token=${encodeURIComponent(signedJwt)}`);
});

// token lookup endpoint
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

  res.json({
    userId:       record.userId,
    tokens:       record.tokens,
    league:       record.league,
    isRegistered: record.isRegistered
  });
});

// add tokens
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

  res.json({
    userId:   record.userId,
    newTotal: record.tokens,
    league:   record.league
  });
});

// mark registered
app.post('/tokens/register', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const record = await Token.findOneAndUpdate(
    { userId },
    { isRegistered: true },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ userId: record.userId, isRegistered: record.isRegistered });
});

app.listen(PORT, () => {
  console.log(`🚀 SnapBit API listening on port ${PORT}`);
});
