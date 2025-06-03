// index.js

require('dotenv').config();
const express      = require('express');
const mongoose     = require('mongoose');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const fetch        = require('node-fetch'); // v2.x
const app          = express();

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
// We must set SameSite=None & secure=true so that the cookie is sent back
// when Roblox (a third‐party domain) redirects to /oauth/callback.
function cookieOptions() {
  return {
    httpOnly: true,
    secure:   true,     // MUST be true because SameSite=None
    sameSite: 'None',   // allow cross-site redirect from Roblox
    path:     '/'
  };
}

// ─── MIDDLEWARE: API-KEY CHECK ────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Skip API‐key check for /health, /auth, /oauth/*
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

// ─── 2) /auth → REDIRECT TO ROBLOX AUTHORIZATION ENDPOINT ─────────────────────────
app.get('/auth', (req, res) => {
  // 1) Generate random state and set it as a secure, SameSite=None cookie
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, cookieOptions());

  // 2) Build the Roblox /v1/authorize URL
  const authorizeUrl = new URL('https://apis.roblox.com/oauth/v1/authorize');
  authorizeUrl.searchParams.set('client_id',     ROBLOX_CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
  authorizeUrl.searchParams.set('scope',         'openid profile');
  authorizeUrl.searchParams.set('state',         state);
  // (You could also send prompt=login or prompt=consent if desired.)

  // 3) Redirect the user’s browser to Roblox’s authorization page
  return res.redirect(authorizeUrl.toString());
});

// ─── 3) /oauth/callback → HANDLE ROBLOX REDIRECT, EXCHANGE CODE, CALL /userinfo ───
app.get('/oauth/callback', async (req, res) => {
  const { code, state: returnedState, error, error_description } = req.query;

  // 1) If user denied or Roblox returned an error
  if (error) {
    const desc = decodeURIComponent(error_description || 'No description');
    return res.status(400).send(`Authorization failed: ${error} — ${desc}`);
  }

  // 2) Verify that the state matches the cookie
  const storedState = req.cookies.oauth_state;
  if (!returnedState || returnedState !== storedState) {
    return res.status(400).send(
      `Security check failed (state mismatch).<br>` +
      `Ensure you accessed via HTTPS and that cookies are enabled.`
    );
  }

  // 3) Exchange the authorization code for tokens (access_token + refresh_token)
  // === inside /oauth/callback, replace your token‐exchange with the following ===
let tokenData;
try {
  const tokenUrl  = 'https://apis.roblox.com/oauth/v1/token';
  const basicAuth = Buffer.from(
    `${ROBLOX_CLIENT_ID}:${ROBLOX_CLIENT_SECRET}`
  ).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code:          code,
    redirect_uri:  REDIRECT_URI
    // Note: we are using Basic Auth, so we do NOT need to send client_id and client_secret again in the body.
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
    // Log status and response body for debugging:
    const text = await tokenResponse.text();
    console.error(`Token exchange failed. Status ${tokenResponse.status}: ${text}`);
    return res
      .status(tokenResponse.status)
      .send(`Failed to exchange code for tokens (see server logs).`);
  }

  tokenData = await tokenResponse.json();
} catch (err) {
  console.error('Error during Roblox token exchange:', err);
  return res.status(500).send('Error during Roblox token exchange.');
}

    // Perform the POST request
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return res.status(tokenResponse.status).send('Failed to exchange code for tokens.');
    }
    tokenData = await tokenResponse.json();
    // tokenData includes { access_token, refresh_token, token_type, expires_in, scope }
  } catch (err) {
    console.error('Error during token exchange:', err);
    return res.status(500).send('Error during Roblox token exchange.');
  }

  // 4) Call Roblox’s /v1/userinfo endpoint to get the user’s “sub” (Roblox ID)
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
      console.error('Failed to fetch userinfo:', await userRes.text());
      return res.status(500).send('Failed to fetch Roblox user info.');
    }
    userInfo = await userRes.json();
    // Example userInfo: { sub: "12345678", name: "ExampleUser", preferred_username: "ExampleUser", ... }
  } catch (err) {
    console.error('Error fetching userinfo:', err);
    return res.status(500).send('Error fetching Roblox user info.');
  }

  // 5) Now we have the Roblox user ID in userInfo.sub
  const robloxId = userInfo.sub;
  // (Optionally extract userInfo.preferred_username, userInfo.name, etc.)

  // 6) Clear the state cookie so it can’t be replayed
  res.clearCookie('oauth_state', cookieOptions());

  // 7) Redirect the player back to your front-end dashboard
  //    We pass along userId as a query param so the front-end can call /tokens
  return res.redirect(`https://snapbitportal.web.app/dashboard?userId=${robloxId}`);
});

// ─── 4) GET /tokens?userId=<…> ────────────────────────────────────────────────────
app.get('/tokens', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  let record = await Token.findOne({ userId });
  if (!record) {
    // First‐time user ⇒ create a new document
    record = await Token.create({
      userId,
      tokens: 0,
      league: 'Bronze',
      isRegistered: false
    });
  } else {
    // Update league if token count has changed since last time
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

// ─── 5) POST /tokens/add { userId, amount } ───────────────────────────────────────
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

  // Recalculate league
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

// ─── 6) POST /tokens/register { userId } ─────────────────────────────────────────
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

// ─── Start the server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 SnapBit API listening on port ${PORT}`);
});
