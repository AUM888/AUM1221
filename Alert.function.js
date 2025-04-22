const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 0 // Added to support version 0 transactions
});

const checkNewTokens = async (bot, chatId, pumpFunProgram, filters, checkAgainstFilters) => {
  try {
    console.log('checkNewTokens started, PumpFunProgram:', pumpFunProgram.toString());

    const transactions = await connection.getSignaturesForAddress(pumpFunProgram, { limit: 10 });
    console.log('Transactions fetched:', transactions.length, 'Details:', JSON.stringify(transactions, null, 2));

    for (const tx of transactions) {
      console.log('Processing transaction:', tx.signature);
      let txDetails;
      try {
        txDetails = await connection.getParsedTransaction(tx.signature, { 
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0 // Explicitly set for this call
        });
      } catch (error) {
        if (error.message.includes('Transaction version')) {
          console.log('Skipping transaction due to unsupported version:', tx.signature);
          continue;
        }
        throw error;
      }

      console.log('Transaction details:', JSON.stringify(txDetails, null, 2));

      if (!txDetails || txDetails.meta?.err) {
        console.log('Skipping invalid or failed transaction:', tx.signature);
        continue;
      }

      const tokenMint = txDetails.transaction.message.accountKeys.find(key => key.signer)?.pubkey;
      if (!tokenMint) {
        console.log('No token mint found in transaction:', tx.signature);
        continue;
      }

      console.log('Token mint found:', tokenMint);

      const event = {
        type: 'CREATE',
        tokenMint,
        programId: pumpFunProgram.toString(),
        accounts: txDetails.transaction.message.accountKeys.map(key => key.pubkey)
      };

      const { extractTokenInfo } = require('./Helper.function');
      const tokenData = await extractTokenInfo(event);
      console.log('Token data from checkNewTokens:', tokenData);

      if (!tokenData) {
        console.log('No valid token data for:', tokenMint);
        bot.sendMessage(chatId, `⚠️ Failed to fetch data for token: ${tokenMint}`).catch(err => {
          console.error('Failed to send Telegram message for failed token data:', err.message);
        });
        continue;
      }

      if (checkAgainstFilters(tokenData, filters)) {
        console.log('Token passed filters in checkNewTokens:', tokenData);
        const { formatTokenMessage } = require('./Helper.function');
        const message = formatTokenMessage(tokenData);
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(err => {
          console.error('Failed to send Telegram alert from checkNewTokens:', err.message, 'Message:', message);
        });
      } else {
        console.log('Token did not pass filters in checkNewTokens:', tokenMint, 'Token data:', tokenData);
        bot.sendMessage(chatId, `ℹ️ Token ${tokenMint} did not pass filters`).catch(err => {
          console.error('Failed to send Telegram message for filter fail:', err.message);
        });
      }
    }
  } catch (error) {
    console.error('checkNewTokens error:', error.message, 'Stack:', error.stack);
    bot.sendMessage(chatId, `❌ Error checking new tokens: ${error.message}`).catch(err => {
      console.error('Failed to send Telegram error message:', err.message);
    });
  }
};

module.exports = { checkNewTokens };
