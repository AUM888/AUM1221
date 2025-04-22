const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const cheerio = require('cheerio');

const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 0
});

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const extractTokenInfo = async (event) => {
  try {
    console.log('extractTokenInfo called with event:', JSON.stringify(event, null, 2));

    const tokenAddress = event.tokenMint;
    console.log('Extracted token address:', tokenAddress);

    if (!tokenAddress || tokenAddress.length < 44 || tokenAddress.length > 45) {
      console.log('Invalid token address, returning null:', tokenAddress);
      return null;
    }

    console.log('Validating token address:', tokenAddress);

    // Validate token address is a mint account
    let accountInfo;
    try {
      accountInfo = await connection.getParsedAccountInfo(new PublicKey(tokenAddress));
      console.log('Account info for token:', tokenAddress, JSON.stringify(accountInfo, null, 2));
      if (!accountInfo.value || accountInfo.value.owner.toString() !== TOKEN_PROGRAM.toString()) {
        console.log('Address is not a TOKEN mint account, returning null:', tokenAddress);
        return null;
      }
    } catch (error) {
      console.error('Error validating token address:', tokenAddress, 'Error:', error.message, 'Stack:', error.stack);
      return null;
    }

    console.log('Fetching token data for address:', tokenAddress);

    // Fetch token metadata
    let tokenData = { address: tokenAddress };
    try {
      const mint = await connection.getParsedAccountInfo(new PublicKey(tokenAddress));
      console.log('Mint data fetched:', JSON.stringify(mint, null, 2));
      if (!mint.value || !mint.value.data.parsed) {
        console.log('No valid mint data found for:', tokenAddress);
        return null;
      }
      tokenData.name = mint.value.data.parsed.info?.name || 'Unknown';
      tokenData.decimals = mint.value.data.parsed.info.decimals || 9;
      tokenData.mintAuthRevoked = !mint.value.data.parsed.info.mintAuthority;
      tokenData.freezeAuthRevoked = !mint.value.data.parsed.info.freezeAuthority;
    } catch (error) {
      console.error('Error fetching mint data:', error.message, 'Stack:', error.stack);
      tokenData.name = 'Unknown';
      tokenData.mintAuthRevoked = false;
      tokenData.freezeAuthRevoked = false;
    }

    // Fetch market data from DexScreener with retry
    let dexResponse;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        dexResponse = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        console.log('DexScreener response (attempt', attempt, '):', JSON.stringify(dexResponse.data, null, 2));
        if (dexResponse.data.pairs) {
          break;
        }
        console.log('No pairs found on attempt', attempt, 'for:', tokenAddress, 'Retrying after delay...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (error) {
        console.error('Error fetching DexScreener data (attempt', attempt, '):', error.message, 'Stack:', error.stack);
        if (attempt === 3) {
          console.log('Max retries reached for DexScreener, proceeding to Pump.fun:', tokenAddress);
          dexResponse = { data: { pairs: null } };
        } else {
          console.log('Retrying DexScreener after delay...');
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    // Try Pump.fun if DexScreener fails
    let pumpResponse;
    if (!dexResponse.data.pairs) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          pumpResponse = await axios.get(`https://api-v2.pump.fun/tokens/${tokenAddress}`, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          console.log('Pump.fun API response (attempt', attempt, '):', JSON.stringify(pumpResponse.data, null, 2));
          if (pumpResponse.data) {
            break;
          }
          console.log('No data from Pump.fun API on attempt', attempt, 'for:', tokenAddress, 'Retrying after delay...');
          await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
          console.error('Error fetching Pump.fun API data (attempt', attempt, '):', error.message, 'Stack:', error.stack);
          if (attempt === 3) {
            console.log('Max retries reached for Pump.fun API, trying web scraping:', tokenAddress);
            try {
              const webResponse = await axios.get(`https://pump.fun/${tokenAddress}`, {
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
              });
              const $ = cheerio.load(webResponse.data);
              const name = $('meta[property="og:title"]').attr('content')?.replace(' | pump.fun', '') || 'Unknown';
              const marketCapText = $('div:contains("Market cap")').text().match(/Market cap: \$([\d,.]+)/)?.[1]?.replace(/,/g, '') || '0';
              const marketCap = parseFloat(marketCapText) || 0;
              pumpResponse = {
                data: {
                  name,
                  market_cap: marketCap,
                  liquidity: marketCap ? marketCap * 0.1 : 1000
                }
              };
              console.log('Pump.fun web scrape successful:', JSON.stringify(pumpResponse.data, null, 2));
            } catch (scrapeError) {
              console.error('Error scraping Pump.fun:', scrapeError.message, 'Stack:', scrapeError.stack);
              pumpResponse = { data: null };
            }
          } else {
            console.log('Retrying Pump.fun API after delay...');
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      }
    }

    try {
      if (dexResponse.data.pairs) {
        const pair = dexResponse.data.pairs[0];
        tokenData.name = pair.baseToken?.name || tokenData.name;
        tokenData.marketCap = pair.fdv || 0;
        tokenData.liquidity = pair.liquidity?.usd || 0;
        tokenData.price = pair.priceUsd || 0;
      } else if (pumpResponse.data) {
        tokenData.name = pumpResponse.data.name || tokenData.name;
        tokenData.marketCap = pumpResponse.data.market_cap || 0;
        tokenData.liquidity = pumpResponse.data.liquidity || (tokenData.marketCap ? tokenData.marketCap * 0.1 : 1000);
        tokenData.price = pumpResponse.data.price || 0;
      } else {
        console.log('No DexScreener or Pump.fun data for:', tokenAddress);
        tokenData.marketCap = 0;
        tokenData.liquidity = 1000;
        tokenData.price = 0;
      }
    } catch (error) {
      console.error('Error processing market data:', error.message, 'Stack:', error.stack);
      tokenData.marketCap = 0;
      tokenData.liquidity = 1000;
      tokenData.price = 0;
    }

    // Fetch dev holding and pool supply
    try {
      const largestAccounts = await connection.getTokenLargestAccounts(new PublicKey(tokenAddress));
      const totalSupply = (await connection.getTokenSupply(new PublicKey(tokenAddress))).value.uiAmount;
      console.log('Largest accounts:', JSON.stringify(largestAccounts, null, 2));
      console.log('Total supply:', totalSupply);
      const devHolding = largestAccounts.value[0]?.uiAmount && totalSupply > 0 ? (largestAccounts.value[0].uiAmount / totalSupply * 100) : 0;
      tokenData.devHolding = devHolding;
      tokenData.poolSupply = totalSupply > 0 ? (totalSupply - (largestAccounts.value[0]?.uiAmount || 0)) / totalSupply * 100 : 0;
    } catch (error) {
      console.error('Error fetching token supply or accounts:', error.message, 'Stack:', error.stack);
      tokenData.devHolding = 0;
      tokenData.poolSupply = 0;
    }

    console.log('Final token data:', JSON.stringify(tokenData, null, 2));
    return tokenData;
  } catch (error) {
    console.error('extractTokenInfo error:', error.message, 'Stack:', error.stack);
    return null;
  }
};

const checkAgainstFilters = (tokenData, filters) => {
  try {
    console.log('Checking token data against filters:', JSON.stringify(tokenData, null, 2), 'Filters:', JSON.stringify(filters, null, 2));
    if (!tokenData) {
      console.log('No token data, failing filters');
      return false;
    }
    const checks = [
      { field: 'liquidity', value: tokenData.liquidity || 0, min: filters.liquidity.min, max: filters.liquidity.max },
      { field: 'poolSupply', value: tokenData.poolSupply || 0, min: filters.poolSupply.min, max: filters.poolSupply.max },
      { field: 'devHolding', value: tokenData.devHolding || 0, min: filters.devHolding.min, max: filters.devHolding.max },
      { field: 'launchPrice', value: tokenData.price || 0, min: filters.launchPrice.min, max: filters.launchPrice.max },
      { field: 'mintAuthRevoked', value: tokenData.mintAuthRevoked, expected: filters.mintAuthRevoked },
      { field: 'freezeAuthRevoked', value: tokenData.freezeAuthRevoked, expected: filters.freezeAuthRevoked }
    ];

    for (const check of checks) {
      if (check.field === 'mintAuthRevoked' || check.field === 'freezeAuthRevoked') {
        if (check.value !== check.expected) {
          console.log(`Filter failed: ${check.field}, Expected: ${check.expected}, Got: ${check.value}`);
          return false;
        }
      } else {
        if (check.value < check.min || check.value > check.max) {
          console.log(`Filter failed: ${check.field}, Value: ${check.value}, Min: ${check.min}, Max: ${check.max}`);
          return false;
        }
      }
    }

    console.log('Token passed all filters');
    return true;
  } catch (error) {
    console.error('checkAgainstFilters error:', error.message, 'Stack:', error.stack);
    return false;
  }
};

const formatTokenMessage = (tokenData) => {
  try {
    console.log('Formatting token message for:', JSON.stringify(tokenData, null, 2));
    if (!tokenData || !tokenData.address) {
      console.log('Invalid token data, returning error message');
      return 'Error formatting token message: Invalid token data';
    }
    const message = `🌟 *New Token Alert* 🌟
📛 *Token Name*: ${tokenData.name || 'Unknown'}
📍 *Token Address*: \`${tokenData.address || 'N/A'}\`
💰 *Market Cap*: $${tokenData.marketCap ? tokenData.marketCap.toLocaleString() : 'N/A'}
💧 *Liquidity*: $${tokenData.liquidity ? tokenData.liquidity.toLocaleString() : 'N/A'}
👨‍💻 *Dev Holding*: ${tokenData.devHolding ? tokenData.devHolding.toFixed(2) : 'N/A'}%
🏊 *Pool Supply*: ${tokenData.poolSupply ? tokenData.poolSupply.toFixed(2) : 'N/A'}%
🚀 *Launch Price*: ${tokenData.price ? tokenData.price : 'N/A'} SOL
🔒 *Mint Authority*: ${tokenData.mintAuthRevoked ? '✅ Revoked' : '❌ Not Revoked'}
🧊 *Freeze Authority*: ${tokenData.freezeAuthRevoked ? '✅ Revoked' : '❌ Not Revoked'}
📈 *Pump.fun*: [View on Pump.fun](https://pump.fun/${tokenData.address || ''})
📊 *DexScreener*: [View on DexScreener](https://dexscreener.com/solana/${tokenData.address || ''})`;

    console.log('Formatted message:', message);
    return message;
  } catch (error) {
    console.error('formatTokenMessage error:', error.message, 'Stack:', error.stack);
    return 'Error formatting token message';
  }
};

module.exports = { extractTokenInfo, checkAgainstFilters, formatTokenMessage };
