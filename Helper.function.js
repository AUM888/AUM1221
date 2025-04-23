const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const Moralis = require('@moralisweb3/common-sol-utils');

const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 0
});

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Initialize Moralis
Moralis.start({
  apiKey: process.env.MORALIS_API_KEY,
});

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

    // Fetch token metadata from Solana
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

    // Fetch market data from Moralis API with retry logic
    let retries = 3;
    let moralisDataFetched = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`Attempt ${attempt} to fetch Moralis data for`, tokenAddress);
        const response = await Moralis.SolApi.token.getTokenPrice({
          network: 'mainnet',
          address: tokenAddress,
        });
        console.log('Moralis Response for', tokenAddress, JSON.stringify(response.raw, null, 2));
        const tokenInfo = response.raw;
        if (tokenInfo && tokenInfo.usdPrice) {
          tokenData.name = tokenInfo.name || tokenData.name;
          tokenData.marketCap = parseFloat(tokenInfo.marketCap) || parseFloat(tokenInfo.usdPrice) * 1000000000 || 0; // Fallback: Assume 1B supply if marketCap not provided
          tokenData.liquidity = parseFloat(tokenInfo.liquidity) || 0; // Moralis may not provide liquidity, fallback to 0
          tokenData.price = parseFloat(tokenInfo.usdPrice) || 0;
          console.log('Moralis token info found:', JSON.stringify(tokenInfo, null, 2));
          moralisDataFetched = true;
          break;
        } else {
          console.log('No valid Moralis data found for:', tokenAddress, 'Response:', JSON.stringify(response.raw, null, 2));
          tokenData.marketCap = 0;
          tokenData.liquidity = 0;
          tokenData.price = 0;
        }
      } catch (error) {
        console.error('Error fetching Moralis data, attempt:', attempt, 'Retries left:', retries - attempt, 'Error:', error.message, 'Stack:', error.stack);
        tokenData.marketCap = 0;
        tokenData.liquidity = 0;
        tokenData.price = 0;
      }
      if (!moralisDataFetched && attempt < retries) {
        console.log(`Waiting 5 seconds before retrying Moralis for`, tokenAddress);
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5s delay between retries
      }
    }

    if (!moralisDataFetched) {
      console.log('Failed to fetch Moralis data after all retries for:', tokenAddress);
      const chatId = process.env.TELEGRAM_CHAT_ID || '-1002511600127';
      const bot = require('./index').bot; // Assuming bot is exported from index.js
      bot.sendMessage(chatId, `⚠️ Failed to fetch Moralis data for token: ${tokenAddress}`).catch(err => {
        console.error('Failed to send Telegram message for Moralis failure:', err.message);
      });
    }

    // Fetch dev holding and pool supply
    try {
      const largestAccounts = await connection.getTokenLargestAccounts(new PublicKey(tokenAddress));
      const totalSupply = (await connection.getTokenSupply(new PublicKey(tokenAddress))).value.uiAmount;
      console.log('Largest accounts:', JSON.stringify(largestAccounts, null, 2));
      console.log('Total supply:', totalSupply);
      const devHolding = largestAccounts.value[0]?.uiAmount / totalSupply * 100 || 0;
      tokenData.devHolding = devHolding;
      tokenData.poolSupply = totalSupply > 0 ? (100 - devHolding) : 0;
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
  if (!tokenData) return { passed: false, details: 'No token data' };

  const details = [];
  let passed = true;

  if (tokenData.liquidity < filters.liquidity.min || tokenData.liquidity > filters.liquidity.max) {
    details.push(`Liquidity: ${tokenData.liquidity} (Required: ${filters.liquidity.min}-${filters.liquidity.max})`);
    passed = false;
  }
  if (tokenData.poolSupply < filters.poolSupply.min || tokenData.poolSupply > filters.poolSupply.max) {
    details.push(`Pool Supply: ${tokenData.poolSupply}% (Required: ${filters.poolSupply.min}-${filters.poolSupply.max})`);
    passed = false;
  }
  if (tokenData.devHolding < filters.devHolding.min || tokenData.devHolding > filters.devHolding.max) {
    details.push(`Dev Holding: ${tokenData.devHolding}% (Required: ${filters.devHolding.min}-${filters.devHolding.max})`);
    passed = false;
  }
  if (tokenData.price < filters.launchPrice.min || tokenData.price > filters.launchPrice.max) {
    details.push(`Launch Price: ${tokenData.price} SOL (Required: ${filters.launchPrice.min}-${filters.launchPrice.max})`);
    passed = false;
  }
  if (tokenData.mintAuthRevoked !== filters.mintAuthRevoked) {
    details.push(`Mint Auth Revoked: ${tokenData.mintAuthRevoked ? 'Yes' : 'No'} (Required: ${filters.mintAuthRevoked ? 'Yes' : 'No'})`);
    passed = false;
  }
  if (tokenData.freezeAuthRevoked !== filters.freezeAuthRevoked) {
    details.push(`Freeze Auth Revoked: ${tokenData.freezeAuthRevoked ? 'Yes' : 'No'} (Required: ${filters.freezeAuthRevoked ? 'Yes' : 'No'})`);
    passed = false;
  }

  return { passed, details };
};

const formatTokenMessage = (tokenData) => {
  return `🌟 *New Token Alert* 🌟
📛 *Token Name*: ${tokenData.name}
📍 *Token Address*: \`${tokenData.address}\`
💰 *Market Cap*: $${tokenData.marketCap.toFixed(2)}
💧 *Liquidity*: $${tokenData.liquidity.toFixed(2)}
👨‍💻 *Dev Holding*: ${tokenData.devHolding.toFixed(2)}%
🏊 *Pool Supply*: ${tokenData.poolSupply.toFixed(2)}%
🚀 *Launch Price*: ${tokenData.price} SOL
🔒 *Mint Authority*: ${tokenData.mintAuthRevoked ? '✅ Revoked' : '❌ Not Revoked'}
🧊 *Freeze Authority*: ${tokenData.freezeAuthRevoked ? '✅ Revoked' : '❌ Not Revoked'}
📈 *DexScreener*: [View on DexScreener](https://dexscreener.com/solana/${tokenData.address})`;
};

module.exports = { extractTokenInfo, checkAgainstFilters, formatTokenMessage };
