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
  if (error) return res.redirect(`/auth?error=${encodeURIComponent(error)}`);

  const storedState = req.cookies.oauth_state;
  if (!returnedState || returnedState !== storedState) {
    return res.redirect(`/auth?error=state_mismatch`);
  }

  // 1) Exchange code for access_token
  let tokenData;
  try {
    const tokenRes = await fetch('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(
          `${ROBLOX_CLIENT_ID}:${ROBLOX_CLIENT_SECRET}`
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }).toString()
    });
    if (!tokenRes.ok) throw new Error(`Token status ${tokenRes.status}`);
    tokenData = await tokenRes.json();
  } catch (err) {
    console.error('Token exchange error:', err);
    return res.redirect(`/auth?error=token_exchange_failed`);
  }

  // 2) Fetch Roblox userinfo (get sub & displayName)
  let userInfo;
  try {
    const userRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) throw new Error(`Userinfo status ${userRes.status}`);
    userInfo = await userRes.json();
  } catch (err) {
    console.error('Userinfo fetch error:', err);
    return res.redirect(`/auth?error=userinfo_failed`);
  }

  const robloxId     = userInfo.sub;
  const displayName  = userInfo.name;

  // 3) Upsert record & mark registered (optional)
  try {
    await Token.findOneAndUpdate(
      { userId: robloxId },
      {
        $set: {
          displayName,
          isRegistered: true
        }
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.warn('Upsert error:', err);
  }

  // 4) Sign our own JWT with sub & displayName
  const privateKey = RAW_PRIVATE_KEY.replace(/\\n/g,'\n');
  const signedJWT  = jwt.sign(
    { sub: robloxId, displayName },
    privateKey,
    { algorithm: 'RS256', expiresIn: '1m' }
  );

  // 5) Clear state cookie & redirect with token
  res.clearCookie('oauth_state', {
    httpOnly: true,
    secure:   true,
    sameSite: 'None',
    path:     '/'
  });

  return res.redirect(
    `https://snapbitportal.web.app/dashboard?token=${encodeURIComponent(signedJWT)}`
  );
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
