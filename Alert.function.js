const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 0
});

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const checkNewTokens = async (bot, chatId, pumpFunProgram, filters, checkAgainstFilters) => {
  try {
    console.log('checkNewTokens started, PumpFunProgram:', pumpFunProgram.toString());

    const transactions = await connection.getSignaturesForAddress(pumpFunProgram, { limit: 20 });
    console.log('Transactions fetched:', transactions.length, 'Details:', JSON.stringify(transactions, null, 2));

    for (const tx of transactions) {
      console.log('Processing transaction:', tx.signature);
      let txDetails;
      try {
        txDetails = await connection.getParsedTransaction(tx.signature, { 
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });
      } catch (error) {
        if (error.message.includes('Transaction version')) {
          console.log('Skipping transaction due to unsupported version:', tx.signature);
          continue;
        }
        console.error('Error fetching transaction details:', error.message, 'Stack:', error.stack);
        continue;
      }

      console.log('Transaction details:', JSON.stringify(txDetails, null, 2));

      if (!txDetails || txDetails.meta?.err) {
        console.log('Skipping invalid or failed transaction:', tx.signature);
        continue;
      }

      let tokenMint;
      // Find TOKEN_MINT instruction
      const mintInstruction = txDetails.transaction.message.instructions.find(
        inst => inst.programId.toString() === TOKEN_PROGRAM.toString()
      );

      if (mintInstruction) {
        console.log('TOKEN_MINT instruction found:', JSON.stringify(mintInstruction, null, 2));
        // Token mint instruction typically has mint as the first account
        if (mintInstruction.accounts && mintInstruction.accounts.length > 0) {
          tokenMint = mintInstruction.accounts[0].toString();
        }
      }

      // Fallback to postTokenBalances if no TOKEN_MINT instruction
      if (!tokenMint && txDetails.meta?.postTokenBalances) {
        const mintBalance = txDetails.meta.postTokenBalances.find(
          balance => balance.mint && [44, 45].includes(balance.mint.length)
        );
        if (mintBalance) {
          tokenMint = mintBalance.mint;
        }
      }

      console.log('Token mint extracted:', tokenMint);

      if (!tokenMint || tokenMint.length < 44 || tokenMint.length > 45) {
        console.log('Invalid token mint, skipping:', tokenMint);
        continue;
      }

      // Validate token mint
      try {
        const accountInfo = await connection.getParsedAccountInfo(new PublicKey(tokenMint));
        console.log('Account info for mint:', tokenMint, JSON.stringify(accountInfo, null, 2));
        if (!accountInfo.value || accountInfo.value.owner.toString() !== TOKEN_PROGRAM.toString()) {
          console.log('Address is not a TOKEN mint account, skipping:', tokenMint);
          continue;
        }
      } catch (error) {
        console.error('Error validating token mint:', tokenMint, 'Error:', error.message, 'Stack:', error.stack);
        continue;
      }

      const event = {
        type: 'TOKEN_MINT',
        tokenMint,
        programId: pumpFunProgram.toString(),
        accounts: txDetails.transaction.message.accountKeys.map(key => key.pubkey.toString()),
        signature: tx.signature
      };

      const { extractTokenInfo, formatTokenMessage } = require('./Helper.function');
      const tokenData = await extractTokenInfo(event);
      console.log('Token data from checkNewTokens:', JSON.stringify(tokenData, null, 2));

      if (!tokenData) {
        console.log('No valid token data for:', tokenMint);
        bot.sendMessage(chatId, `⚠️ Failed to fetch data for token: ${tokenMint}`).catch(err => {
          console.error('Failed to send Telegram message for failed token data:', err.message);
        });
        continue;
      }

      const bypassFilters = process.env.BYPASS_FILTERS === 'true'; // FIXED: Removed || true
      console.log('Bypass Filters in checkNewTokens:', bypassFilters); // ADDED LOG
      console.log('Token Data Before Filter Check:', JSON.stringify(tokenData, null, 2)); // ADDED LOG
      console.log('Filter Check Result in checkNewTokens:', checkAgainstFilters(tokenData, filters)); // ADDED LOG

      if (bypassFilters || checkAgainstFilters(tokenData, filters)) {
        console.log('Token passed filters in checkNewTokens:', JSON.stringify(tokenData, null, 2));
        const message = formatTokenMessage(tokenData);
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(err => {
          console.error('Failed to send Telegram alert from checkNewTokens:', err.message, 'Message:', message);
        });
      } else {
        console.log('Token did not pass filters in checkNewTokens:', tokenMint, 'Token data:', JSON.stringify(tokenData, null, 2));
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
