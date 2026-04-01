/**
 * /api/check-token.js — Vercel Serverless Function
 *
 * Checks if a wallet holds minimum $10 worth of Arthouse token on Base (Howdy).
 * Uses Basescan token balance API + token price from Howdy/DEX.
 *
 * Env vars required:
 *   BASESCAN_API_KEY  — Basescan API key (free tier)
 *
 * Contract: 0xb93a3f20a11095b8858b560262cbc25fe3591789 (Base mainnet)
 * Minimum: $10 USD equivalent in Arthouse token
 */

const HOWDY_CONTRACT = '0xb93a3f20a11095b8858b560262cbc25fe3591789';
const MIN_USD = 10; // $10 minimum

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { wallet } = req.body || {};
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'Valid wallet address required' });
  }

  try {
    // 1. Get token balance
    const balUrl = new URL('https://api.basescan.org/api');
    balUrl.searchParams.set('module',          'account');
    balUrl.searchParams.set('action',          'tokenbalance');
    balUrl.searchParams.set('contractaddress', HOWDY_CONTRACT);
    balUrl.searchParams.set('address',         wallet);
    balUrl.searchParams.set('tag',             'latest');
    balUrl.searchParams.set('apikey',          process.env.BASESCAN_API_KEY);

    const balRes = await fetch(balUrl.toString());
    const balData = await balRes.json();

    if (balData.status !== '1') {
      return res.status(200).json({ hasToken: false, balance: '0', usdValue: 0 });
    }

    const rawBalance = BigInt(balData.result || '0');
    if (rawBalance === BigInt(0)) {
      return res.status(200).json({ hasToken: false, balance: '0', usdValue: 0 });
    }

    // 2. Get token info (decimals + price) from Basescan token info
    const infoUrl = new URL('https://api.basescan.org/api');
    infoUrl.searchParams.set('module',          'token');
    infoUrl.searchParams.set('action',          'tokeninfo');
    infoUrl.searchParams.set('contractaddress', HOWDY_CONTRACT);
    infoUrl.searchParams.set('apikey',          process.env.BASESCAN_API_KEY);

    let decimals = 18; // default
    let tokenPriceUSD = 0;

    try {
      const infoRes = await fetch(infoUrl.toString());
      const infoData = await infoRes.json();
      if (infoData.status === '1' && infoData.result?.[0]) {
        decimals      = parseInt(infoData.result[0].divisor || 18);
        tokenPriceUSD = parseFloat(infoData.result[0].tokenPriceUSD || 0);
      }
    } catch (_) {}

    // 3. Calculate USD value
    const humanBalance = Number(rawBalance) / Math.pow(10, decimals);
    const usdValue     = tokenPriceUSD > 0 ? humanBalance * tokenPriceUSD : null;

    // If price unavailable, allow access (fail open — better UX)
    const hasToken = usdValue === null ? true : usdValue >= MIN_USD;

    return res.status(200).json({
      hasToken,
      balance:  humanBalance.toFixed(4),
      usdValue: usdValue ? usdValue.toFixed(2) : null,
      minUSD:   MIN_USD,
    });

  } catch (err) {
    console.error('[check-token]', err);
    // Fail open on error
    return res.status(200).json({ hasToken: true, error: err.message });
  }
}
