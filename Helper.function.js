const Moralis = require('moralis').default;

const extractTokenInfo = async (event) => {
  try {
    console.log('extractTokenInfo called with event:', JSON.stringify(event, null, 2));

    const tokenAddress = event.tokenMint;
    console.log('Extracted token address:', tokenAddress);

    if (!tokenAddress || tokenAddress.length < 44 || tokenAddress.length > 45) {
      console.log('Invalid token address, returning null:', tokenAddress);
      return null;
    }

    // Fetch token metadata using Moralis Solana API
    let tokenData = { address: tokenAddress };
    try {
      const response = await Moralis.Solana.getTokenMetadata({
        address: tokenAddress,
        network: 'mainnet',
      });
      console.log('Moralis token metadata:', JSON.stringify(response, null, 2));

      tokenData.name = response.name || 'Unknown';
      tokenData.decimals = response.decimals || 9;
      tokenData.mintAuthRevoked = response.mintAuthority === null;
      tokenData.freezeAuthRevoked = response.freezeAuthority === null;
      tokenData.price = response.price || 0;
      tokenData.liquidity = response.liquidity?.usd || 0;
      tokenData.marketCap = response.marketCap || 0;
    } catch (error) {
      console.error('Error fetching Moralis token metadata:', error.message, 'Stack:', error.stack);
      tokenData.name = 'Unknown';
      tokenData.mintAuthRevoked = false;
      tokenData.freezeAuthRevoked = false;
      tokenData.price = 0;
      tokenData.liquidity = 0;
      tokenData.marketCap = 0;
    }

    // Fetch dev holding and pool supply
    try {
      const largestAccounts = await Moralis.Solana.getTokenLargestAccounts({ address: tokenAddress });
      const totalSupply = (await Moralis.Solana.getTokenSupply({ address: tokenAddress })).amount;
      console.log('Largest accounts:', JSON.stringify(largestAccounts, null, 2));
      console.log('Total supply:', totalSupply);
      const devHolding = largestAccounts[0]?.amount / totalSupply * 100 || 0;
      tokenData.devHolding = devHolding;
      tokenData.poolSupply = totalSupply > 0 ? (totalSupply - devHolding) / totalSupply * 100 : 0;
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
🧊 *Freeze Authority*: ${tokenData.freezeAuthRevoked ? '✅ Revoked' : '❌ Not Revoked'}`;

    console.log('Formatted message:', message);
    return message;
  } catch (error) {
    console.error('formatTokenMessage error:', error.message, 'Stack:', error.stack);
    return 'Error formatting token message';
  }
};

module.exports = { extractTokenInfo, checkAgainstFilters, formatTokenMessage };
