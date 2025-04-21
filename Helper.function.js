const { Connection, PublicKey } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');

const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY, { commitment: 'confirmed' });

async function extractTokenInfo(tx) {
  const tokenAddress = tx.tokenMint || tx.accounts?.[0] || tx.signature;
  if (!tokenAddress) return null;

  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      // Fetch metadata from Helius API
      const response = await fetch(
        `https://api.helius.xyz/v0/tokens/metadata?api-key=${process.env.HELIUS_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mintAccounts: [tokenAddress] })
        }
      );

      if (response.status === 429) {
        retryCount++;
        const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff: 2s, 4s, 8s
        console.log(`Rate limit hit for ${tokenAddress}, retrying after ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!response.ok) throw new Error(`Helius API error: ${response.status} - ${await response.text()}`);
      const data = await response.json();
      const metadata = data[0] || {};

      // Fetch additional data using Solana RPC
      const mintPublicKey = new PublicKey(tokenAddress);
      const mintInfo = await getMint(connection, mintPublicKey);
      const supply = mintInfo.supply.toNumber() / 10 ** mintInfo.decimals; // Total supply in tokens

      // Estimate liquidity and market cap (simplified, needs real pool data)
      // TODO: Replace with real pool data from Raydium or Orca for accurate liquidity/marketCap
      const liquidity = metadata.liquidity || (supply * 0.01); // Assuming 1% of supply as liquidity
      const marketCap = metadata.marketCap || (supply * 0.000005); // Using launch price as base

      console.log('Fetched token data:', { metadata, mintInfo, liquidity, marketCap }); // Debug log

      return {
        name: metadata.name || `Token_${tokenAddress.slice(0, 8)}`,
        address: tokenAddress,
        liquidity: liquidity || null,
        marketCap: marketCap || null,
        devHolding: metadata.devHolding || null,
        poolSupply: metadata.poolSupply || null,
        launchPrice: metadata.price || 0.000005,
        mintAuthRevoked: metadata.mintAuthorityRevoked || mintInfo.mintAuthority?.equals(PublicKey.default) || false,
        freezeAuthRevoked: metadata.freezeAuthorityRevoked || mintInfo.freezeAuthority?.equals(PublicKey.default) || false,
        mint: tokenAddress
      };
    } catch (error) {
      console.error('Error extracting token info for', tokenAddress, ':', error);
      if (retryCount === maxRetries - 1) {
        return null; // Return null after max retries
      }
      retryCount++;
    }
  }
  return null;
}

function checkAgainstFilters(token, filters) {
  if (!token || !token.liquidity || !token.devHolding || !token.poolSupply || !token.launchPrice) {
    return false; // Skip if any critical data is missing
  }
  return (
    token.liquidity >= filters.liquidity.min &&
    token.liquidity <= filters.liquidity.max &&
    token.devHolding >= filters.devHolding.min &&
    token.devHolding <= filters.devHolding.max &&
    token.poolSupply >= filters.poolSupply.min &&
    token.poolSupply <= filters.poolSupply.max &&
    token.launchPrice >= filters.launchPrice.min &&
    token.launchPrice <= filters.launchPrice.max &&
    (filters.mintAuthRevoked === false || token.mintAuthRevoked === true) &&
    (filters.freezeAuthRevoked === false || token.freezeAuthRevoked === true)
  );
}

function formatTokenMessage(token) {
  return `
🌟 *New Token Alert* 🌟
📛 *Token Name*: ${token.name || 'Unknown'}
📍 *Token Address*: \`${token.address || 'N/A'}\`
💰 *Market Cap*: $${token.marketCap?.toLocaleString() || 'N/A'}
💧 *Liquidity*: $${token.liquidity?.toLocaleString() || 'N/A'}
👨‍💻 *Dev Holding*: ${token.devHolding ? token.devHolding + '%' : 'N/A'}
🏊 *Pool Supply*: ${token.poolSupply ? token.poolSupply + '%' : 'N/A'}
🚀 *Launch Price*: ${token.launchPrice ? token.launchPrice.toFixed(10) + ' SOL' : 'N/A'}
🔒 *Mint Authority*: ${token.mintAuthRevoked ? '✅ Revoked' : '❌ Not Revoked'}
🧊 *Freeze Authority*: ${token.freezeAuthRevoked ? '✅ Revoked' : '❌ Not Revoked'}
📈 *DexScreener*: [View on DexScreener](https://dexscreener.com/solana/${token.address || ''})
  `;
}

module.exports = { extractTokenInfo, checkAgainstFilters, formatTokenMessage };
