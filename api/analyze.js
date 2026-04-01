/**
 * /api/analyze.js — Vercel Serverless Function
 * 
 * Flow:
 *   1. Fetch X user bio via X API v2 (Bearer Token)
 *   2. Extract wallet address (0x... or *.base.eth) from bio
 *   3. Fetch onchain data from Basescan API
 *   4. Generate curatorial narrative via Anthropic API
 *   5. Return structured report JSON
 *
 * Env vars required (set in Vercel Dashboard → Settings → Environment Variables):
 *   X_BEARER_TOKEN      — X API v2 Bearer Token
 *   BASESCAN_API_KEY    — Basescan API key (free tier)
 *   ANTHROPIC_API_KEY   — Anthropic API key
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'username is required' });
  }

  const clean = username.replace(/^@/, '').trim().toLowerCase();
  if (!clean) return res.status(400).json({ error: 'Invalid username' });

  try {
    // ── 1. Fetch X bio ──────────────────────────────────────────────────
    const xRes = await fetch(
      `https://api.twitter.com/2/users/by/username/${clean}?user.fields=description,name`,
      { headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } }
    );

    let bio = '';
    let displayName = clean;
    if (xRes.ok) {
      const xData = await xRes.json();
      bio         = xData?.data?.description || '';
      displayName = xData?.data?.name        || clean;
    }

    // ── 2. Extract wallet from bio ───────────────────────────────────────
    const wallet = extractWallet(bio);

    // ── 3. Fetch onchain data ────────────────────────────────────────────
    let txCount  = null;
    let nftCount = null;
    let ethBal   = null;

    if (wallet) {
      [txCount, nftCount, ethBal] = await Promise.all([
        fetchTxCount(wallet),
        fetchNftCount(wallet),
        fetchEthBalance(wallet),
      ]);
    }

    // ── 4. Compute score ─────────────────────────────────────────────────
    const { score, scoreLabel } = computeScore(txCount, nftCount, ethBal);

    // ── 5. Generate curatorial narrative ─────────────────────────────────
    const narrative = await generateNarrative({
      username: clean,
      displayName,
      bio,
      wallet,
      txCount,
      nftCount,
      ethBal,
      score,
      scoreLabel,
    });

    return res.status(200).json({
      wallet:     wallet || null,
      txCount,
      nftCount,
      ethBal,
      score,
      scoreLabel,
      narrative,
    });

  } catch (err) {
    console.error('[analyze]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractWallet(text) {
  if (!text) return null;
  // Match 0x address (42 chars)
  const hex = text.match(/0x[a-fA-F0-9]{40}/);
  if (hex) return hex[0];
  // Match *.base.eth or *.eth ENS
  const ens = text.match(/[a-zA-Z0-9-]+\.(?:base\.eth|eth)/i);
  if (ens) return ens[0];
  return null;
}

async function fetchTxCount(address) {
  try {
    const url = new URL('https://api.basescan.org/api');
    url.searchParams.set('module',     'account');
    url.searchParams.set('action',     'txlist');
    url.searchParams.set('address',    address);
    url.searchParams.set('startblock', '0');
    url.searchParams.set('endblock',   '99999999');
    url.searchParams.set('sort',       'asc');
    url.searchParams.set('apikey',     process.env.BASESCAN_API_KEY);

    const r = await fetch(url.toString());
    const d = await r.json();
    if (d.status === '1' && Array.isArray(d.result)) return d.result.length;
    return 0;
  } catch { return null; }
}

async function fetchNftCount(address) {
  try {
    const url = new URL('https://api.basescan.org/api');
    url.searchParams.set('module',  'account');
    url.searchParams.set('action',  'tokennfttx');
    url.searchParams.set('address', address);
    url.searchParams.set('sort',    'asc');
    url.searchParams.set('apikey',  process.env.BASESCAN_API_KEY);

    const r = await fetch(url.toString());
    const d = await r.json();
    if (d.status === '1' && Array.isArray(d.result)) return d.result.length;
    return 0;
  } catch { return null; }
}

async function fetchEthBalance(address) {
  try {
    const url = new URL('https://api.basescan.org/api');
    url.searchParams.set('module',  'account');
    url.searchParams.set('action',  'balance');
    url.searchParams.set('address', address);
    url.searchParams.set('tag',     'latest');
    url.searchParams.set('apikey',  process.env.BASESCAN_API_KEY);

    const r = await fetch(url.toString());
    const d = await r.json();
    if (d.status === '1') {
      const eth = parseFloat(d.result) / 1e18;
      return Math.round(eth * 1000) / 1000; // 3 decimals
    }
    return null;
  } catch { return null; }
}

function computeScore(txCount, nftCount, ethBal) {
  let score = 0;
  if (txCount  != null) score += Math.min(4, (txCount  / 100) * 4);
  if (nftCount != null) score += Math.min(3, (nftCount / 20)  * 3);
  if (ethBal   != null) score += Math.min(3, (ethBal   / 1)   * 3);

  score = Math.round(score * 10) / 10;

  let scoreLabel = 'Dormant';
  if (score >= 8)      scoreLabel = 'Active Collector';
  else if (score >= 6) scoreLabel = 'Engaged';
  else if (score >= 3) scoreLabel = 'Emerging';
  else if (score > 0)  scoreLabel = 'New Wallet';

  return { score, scoreLabel };
}

async function generateNarrative(data) {
  const {
    username, displayName, bio, wallet,
    txCount, nftCount, ethBal, score, scoreLabel,
  } = data;

  const walletLine = wallet
    ? `Wallet resolved: ${wallet}`
    : 'No wallet found in bio.';

  const prompt = `You are Arthouse — an AI generative art curation agent on Base L2. 
Your voice is literary, precise, and evocative. You write like a museum curator who also understands blockchain deeply.

Write a short curatorial analysis (3–4 sentences, max 80 words) about this collector based on their onchain data.
Do NOT mention scores or numbers directly — translate the data into narrative form.
Be specific, atmospheric, and insightful. Avoid generic phrases.

Subject: @${username} (${displayName})
Bio: "${bio || 'no bio'}"
${walletLine}
Transactions on Base: ${txCount ?? 'unknown'}
NFT interactions on Base: ${nftCount ?? 'unknown'}
ETH balance on Base: ${ethBal != null ? 'Ξ ' + ethBal : 'unknown'}
Collector tier: ${scoreLabel}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (!r.ok) throw new Error('Anthropic API error ' + r.status);
  const d = await r.json();
  return d?.content?.[0]?.text?.trim() || 'Analysis unavailable.';
}
