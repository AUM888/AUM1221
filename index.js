require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, Keypair } = require('@solana/web3.js');
const { getMint, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { checkNewTokens } = require('./Alert.function');

// Function to dynamically load Helper.function.js on each request
const loadHelperModule = () => {
  try {
    console.log('Dynamically loading Helper.function.js...');
    // Clear the module cache to ensure fresh import
    delete require.cache[require.resolve('./Helper.function')];
    const helperModule = require('./Helper.function');
    console.log('Successfully loaded Helper.function.js:', {
      extractTokenInfo: typeof helperModule.extractTokenInfo,
      checkAgainstFilters: typeof helperModule.checkAgainstFilters,
      formatTokenMessage: typeof helperModule.formatTokenMessage
    });
    return helperModule;
  } catch (error) {
    console.error('Failed to load Helper.function.js:', error);
    throw new Error('Module load error: Failed to load Helper.function.js');
  }
};

const app = express();
const PORT = process.env.PORT || 10000;
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID || '-1002511600127';
const webhookBaseUrl = process.env.WEBHOOK_URL?.replace(/\/$/, '');
const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, { commitment: 'confirmed' });

// Validate environment variables
if (!token || !webhookBaseUrl || !process.env.HELIUS_API_KEY || !process.env.PRIVATE_KEY) {
  console.error('Missing environment variables. Required: TELEGRAM_BOT_TOKEN, WEBHOOK_URL, HELIUS_API_KEY, PRIVATE_KEY');
  process.exit(1);
}

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
console.log('PUMP_FUN_PROGRAM defined:', PUMP_FUN_PROGRAM.toString());

const bot = new TelegramBot(token, { polling: false, request: { retryAfter: 21 } });

app.use(express.json());

// Set Telegram webhook
bot.setWebHook(`${webhookBaseUrl}/bot${token}`).then(info => {
  console.log('Webhook set successfully:', info);
}).catch(error => {
  console.error('Failed to set Telegram webhook:', error);
});

let filters = {
  liquidity: { min: 4000, max: 25000 },
  poolSupply: { min: 60, max: 95 },
  devHolding: { min: 2, max: 10 },
  launchPrice: { min: 0.0000000022, max: 0.0000000058 },
  mintAuthRevoked: false,
  freezeAuthRevoked: false
};
let lastTokenData = null;
let userStates = {};
let lastFailedToken = null;
let eventCounter = 0;
let lastReset = Date.now();

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/webhook', async (req, res) => {
  try {
    // Dynamically load Helper.function.js for this request
    const { extractTokenInfo, checkAgainstFilters, formatTokenMessage } = loadHelperModule();

    // Ensure functions are defined
    if (typeof extractTokenInfo !== 'function' || typeof checkAgainstFilters !== 'function' || typeof formatTokenMessage !== 'function') {
      console.error('One or more functions are not defined after loading Helper.function.js:', {
        extractTokenInfo: typeof extractTokenInfo,
        checkAgainstFilters: typeof checkAgainstFilters,
        formatTokenMessage: typeof formatTokenMessage
      });
      throw new Error('Token check error: Helper functions are not defined');
    }

    const now = Date.now();
    if (now - lastReset > 60000) {
      eventCounter = 0;
      lastReset = now;
    }

    if (eventCounter >= 5) {
      console.log('Rate limit exceeded, skipping webhook');
      return res.status(200).send('Rate limit exceeded');
    }

    eventCounter++;

    const events = req.body;
    console.log('Webhook received, events count:', events.length);

    if (!events || !Array.isArray(events) || events.length === 0) {
      console.log('No events in webhook');
      return res.status(400).send('No events received');
    }

    for (const event of events) {
      console.log('Processing event:', JSON.stringify(event, null, 2));

      if (event.type !== 'TOKEN_MINT') {
        console.log('Skipping non-TOKEN_MINT event:', event.type);
        continue;
      }

      const isPumpFunEvent = event.programId === PUMP_FUN_PROGRAM.toString() ||
                            event.accounts?.includes(PUMP_FUN_PROGRAM.toString());
      if (!isPumpFunEvent) {
        console.log('Skipping non-Pump.fun event:', event.programId);
        continue;
      }

      let tokenAddress = event.tokenMint ||
                        event.accountData?.flatMap(acc => acc.tokenBalanceChanges?.map(change => change.mint))
                          .filter(mint => mint && [44, 45].includes(mint.length))[0] ||
                        event.accounts?.[0];

      if (!tokenAddress || tokenAddress.length < 44 || tokenAddress.length > 45) {
        console.log('Invalid token address, skipping:', tokenAddress);
        continue;
      }

      try {
        const mint = await getMint(connection, new PublicKey(tokenAddress));
        if (mint.supply <= 1) {
          console.log('Skipping NFT-like token:', tokenAddress);
          continue;
        }
      } catch (error) {
        console.error('Error checking mint supply:', error);
        continue;
      }

      const tokenData = await extractTokenInfo(event);
      if (!tokenData) {
        console.log('No valid token data for:', tokenAddress);
        if (!lastFailedToken || lastFailedToken !== tokenAddress) {
          bot.sendMessage(chatId, `⚠️ Failed to fetch data for token: ${tokenAddress}`);
          lastFailedToken = tokenAddress;
          await delay(2000);
        }
        continue;
      }

      lastTokenData = tokenData;
      console.log('Token data:', tokenData);

      const bypassFilters = process.env.BYPASS_FILTERS === 'true';
      if (bypassFilters || checkAgainstFilters(tokenData, filters)) {
        console.log('Token passed filters, sending alert:', tokenData);
        const message = formatTokenMessage(tokenData);
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        if (process.env.AUTO_SNIPE === 'true') {
          await autoSnipeToken(tokenData.address);
        }
      } else {
        console.log('Token did not pass filters:', tokenAddress);
        bot.sendMessage(chatId, `ℹ️ Token ${tokenAddress} did not pass filters`);
        await delay(2000);
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error.message);
    return res.status(500).send('Internal Server Error');
  }
});

app.post('/test-webhook', async (req, res) => {
  try {
    // Dynamically load Helper.function.js for this request
    const { extractTokenInfo, checkAgainstFilters, formatTokenMessage } = loadHelperModule();

    // Ensure functions are defined
    if (typeof extractTokenInfo !== 'function' || typeof checkAgainstFilters !== 'function' || typeof formatTokenMessage !== 'function') {
      console.error('One or more functions are not defined after loading Helper.function.js:', {
        extractTokenInfo: typeof extractTokenInfo,
        checkAgainstFilters: typeof checkAgainstFilters,
        formatTokenMessage: typeof formatTokenMessage
      });
      throw new Error('Token check error: Helper functions are not defined');
    }

    const mockEvent = {
      type: 'TOKEN_MINT',
      tokenMint: 'TEST_TOKEN_ADDRESS',
      programId: PUMP_FUN_PROGRAM.toString(),
      accounts: ['TEST_TOKEN_ADDRESS', PUMP_FUN_PROGRAM.toString()]
    };
    console.log('Received test webhook:', JSON.stringify(mockEvent, null, 2));
    bot.sendMessage(chatId, 'ℹ️ Received test webhook');

    const tokenData = await extractTokenInfo(mockEvent);
    if (tokenData) {
      const message = formatTokenMessage(tokenData);
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      console.log('Test alert sent:', tokenData);
      bot.sendMessage(chatId, '✅ Test webhook successful!');
    } else {
      bot.sendMessage(chatId, '⚠️ Test webhook failed: No token data');
    }

    return res.status(200).send('Test webhook processed');
  } catch (error) {
    console.error('Test webhook error:', error.message);
    bot.sendMessage(chatId, `❌ Test webhook error: ${error.message}`);
    return res.status(500).send('Test webhook failed');
  }
});

async function autoSnipeToken(tokenAddress) {
  try {
    const wallet = Keypair.fromSecretKey(Buffer.from(process.env.PRIVATE_KEY, 'base64'));
    const amountToBuy = 0.1;

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(tokenAddress),
        lamports: amountToBuy * 1e9
      })
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [wallet]);
    console.log(`Bought token ${tokenAddress} with signature ${signature}`);

    bot.sendMessage(chatId, `✅ Bought token ${tokenAddress} for ${amountToBuy} SOL! Signature: ${signature}`);
  } catch (error) {
    console.error('Error auto-sniping token:', error.message);
    bot.sendMessage(chatId, `❌ Failed to buy token ${tokenAddress}: ${error.message}`);
  }
}

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `👋 Welcome to @moongraphi_bot
💰 Trade  |  🔐 Wallet
⚙️ Filters  |  📊 Portfolio
❓ Help  |  🔄 Refresh`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💰 Trade', callback_data: 'trade' }, { text: '🔐 Wallet', callback_data: 'wallet' }],
        [{ text: '⚙️ Filters', callback_data: 'filters' }, { text: '📊 Portfolio', callback_data: 'portfolio' }],
        [{ text: '❓ Help', callback_data: 'help' }, { text: '🔄 Refresh', callback_data: 'refresh' }]
      ]
    }
  });
});

// Rest of your bot logic (callback_query, message handling) remains unchanged
bot.on('callback_query', (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = msg.chat.id;

  bot.answerCallbackQuery(callbackQuery.id);

  switch (data) {
    case 'trade':
      bot.sendMessage(chatId, '💰 Trade Menu\n🚀 Buy  |  📉 Sell', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Buy', callback_data: 'buy' }, { text: '📉 Sell', callback_data: 'sell' }],
            [{ text: '⬅️ Back', callback_data: 'back' }]
          ]
        }
      });
      break;

    case 'wallet':
      bot.sendMessage(chatId, '🔐 Wallet Menu\n💳 Your wallet: Not connected yet.\n🔗 Connect Wallet', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔗 Connect Wallet', callback_data: 'connect_wallet' }],
            [{ text: '⬅️ Back', callback_data: 'back' }]
          ]
        }
      });
      break;

    case 'filters':
      bot.sendMessage(chatId, `⚙️ Filters Menu\nCurrent Filters:\nLiquidity: ${filters.liquidity.min}-${filters.liquidity.max}\nPool Supply: ${filters.poolSupply.min}-${filters.poolSupply.max}%\nDev Holding: ${filters.devHolding.min}-${filters.devHolding.max}%\nLaunch Price: ${filters.launchPrice.min}-${filters.launchPrice.max} SOL\nMint Auth Revoked: ${filters.mintAuthRevoked ? 'Yes' : 'No'}\nFreeze Auth Revoked: ${filters.freezeAuthRevoked ? 'Yes' : 'No'}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ Edit Liquidity', callback_data: 'edit_liquidity' }],
            [{ text: '✏️ Edit Pool Supply', callback_data: 'edit_poolsupply' }],
            [{ text: '✏️ Edit Dev Holding', callback_data: 'edit_devholding' }],
            [{ text: '✏️ Edit Launch Price', callback_data: 'edit_launchprice' }],
            [{ text: '✏️ Edit Mint Auth', callback_data: 'edit_mintauth' }],
            [{ text: '✏️ Edit Freeze Auth', callback_data: 'edit_freezeauth' }],
            [{ text: '⬅️ Back', callback_data: 'back' }]
          ]
        }
      });
      break;

    case 'portfolio':
      bot.sendMessage(chatId, '📊 Portfolio Menu\nYour portfolio is empty.\n💰 Start trading to build your portfolio!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'back' }]
          ]
        }
      });
      break;

    case 'help':
      bot.sendMessage(chatId, '❓ Help Menu\nThis bot helps you snipe meme coins on Pump.fun!\nCommands:\n/start - Start the bot\nFor support, contact @YourSupportUsername', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'back' }]
          ]
        }
      });
      break;

    case 'refresh':
      bot.sendMessage(chatId, `🔄 Refreshing latest token data...\nLast Token: ${lastTokenData?.address || 'N/A'}`);
      break;

    case 'back':
      bot.editMessageText(`👋 Welcome to @moongraphi_bot\n💰 Trade  |  🔐 Wallet\n⚙️ Filters  |  📊 Portfolio\n❓ Help  |  🔄 Refresh`, {
        chat_id: chatId,
        message_id: msg.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '💰 Trade', callback_data: 'trade' }, { text: '🔐 Wallet', callback_data: 'wallet' }],
            [{ text: '⚙️ Filters', callback_data: 'filters' }, { text: '📊 Portfolio', callback_data: 'portfolio' }],
            [{ text: '❓ Help', callback_data: 'help' }, { text: '🔄 Refresh', callback_data: 'refresh' }]
          ]
        }
      });
      break;

    case 'edit_liquidity':
      userStates[chatId] = { editing: 'liquidity' };
      bot.sendMessage(chatId, '✏️ Edit Liquidity\nPlease send the new range (e.g., "4000-25000" or "4000 25000")', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'filters' }]
          ]
        }
      });
      break;

    case 'edit_poolsupply':
      userStates[chatId] = { editing: 'poolsupply' };
      bot.sendMessage(chatId, '✏️ Edit Pool Supply\nPlease send the new range (e.g., "60-95" or "60 95")', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'filters' }]
          ]
        }
      });
      break;

    case 'edit_devholding':
      userStates[chatId] = { editing: 'devholding' };
      bot.sendMessage(chatId, '✏️ Edit Dev Holding\nPlease send the new range (e.g., "2-10" or "2 10")', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'filters' }]
          ]
        }
      });
      break;

    case 'edit_launchprice':
      userStates[chatId] = { editing: 'launchprice' };
      bot.sendMessage(chatId, '✏️ Edit Launch Price\nPlease send the new range (e.g., "0.0000000022-0.0000000058" or "0.0000000022 0.0000000058")', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'filters' }]
          ]
        }
      });
      break;

    case 'edit_mintauth':
      userStates[chatId] = { editing: 'mintauth' };
      bot.sendMessage(chatId, '✏️ Edit Mint Auth Revoked\nSend "Yes" or "No"', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'filters' }]
          ]
        }
      });
      break;

    case 'edit_freezeauth':
      userStates[chatId] = { editing: 'freezeauth' };
      bot.sendMessage(chatId, '✏️ Edit Freeze Auth Revoked\nSend "Yes" or "No"', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'filters' }]
          ]
        }
      });
      break;

    default:
      bot.sendMessage(chatId, 'Unknown command. Please use the buttons');
  }
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text.startsWith('/')) return;

  if (!userStates[chatId] || !userStates[chatId].editing) return;

  const editingField = userStates[chatId].editing;

  try {
    if (editingField === 'liquidity' || editingField === 'poolsupply' || editingField === 'devholding' || editingField === 'launchprice') {
      let [min, max] = [];
      if (text.includes('-')) {
        [min, max] = text.split('-').map(val => parseFloat(val.trim()));
      } else {
        [min, max] = text.split(/\s+/).map(val => parseFloat(val.trim()));
      }

      if (isNaN(min) || isNaN(max) || min > max) {
        bot.sendMessage(chatId, 'Invalid range. Please send a valid range (e.g., "4000-25000" or "4000 25000").');
        return;
      }

      if (editingField === 'liquidity') {
        filters.liquidity.min = min;
        filters.liquidity.max = max;
      } else if (editingField === 'poolsupply') {
        filters.poolSupply.min = min;
        filters.poolSupply.max = max;
      } else if (editingField === 'devholding') {
        filters.devHolding.min = min;
        filters.devHolding.max = max;
      } else if (editingField === 'launchprice') {
        filters.launchPrice.min = min;
        filters.launchPrice.max = max;
      }

      bot.sendMessage(chatId, `✅ ${editingField.charAt(0).toUpperCase() + editingField.slice(1)} updated to ${min}-${max}!`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Filters', callback_data: 'filters' }]
          ]
        }
      });
    } else if (editingField === 'mintauth' || editingField === 'freezeauth') {
      const value = text.trim().toLowerCase();
      if (value !== 'yes' && value !== 'no') {
        bot.sendMessage(chatId, 'Invalid input. Please send "Yes" or "No".');
        return;
      }

      const boolValue = value === 'yes';
      if (editingField === 'mintauth') {
        filters.mintAuthRevoked = boolValue;
      } else if (editingField === 'freezeauth') {
        filters.freezeAuthRevoked = boolValue;
      }

      bot.sendMessage(chatId, `✅ ${editingField.charAt(0).toUpperCase() + editingField.slice(1)} updated to ${value === 'yes' ? 'Yes' : 'No'}!`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Filters', callback_data: 'filters' }]
          ]
        }
      });
    }

    delete userStates[chatId];
  } catch (error) {
    bot.sendMessage(chatId, 'Error processing your input. Please try again.');
  }
});

// Updated setInterval with error handling
setInterval(async () => {
  try {
    console.log('Running periodic checkNewTokens...');
    const { checkAgainstFilters } = loadHelperModule();
    if (typeof checkAgainstFilters !== 'function') {
      console.error('checkAgainstFilters is not a function in setInterval:', { checkAgainstFilters: typeof checkAgainstFilters });
      throw new Error('Token check error: checkAgainstFilters is not defined');
    }
    await checkNewTokens(bot, chatId, PUMP_FUN_PROGRAM, filters, checkAgainstFilters);
    console.log('checkNewTokens executed successfully');
  } catch (error) {
    console.error('Error in setInterval checkNewTokens:', error.message);
    bot.sendMessage(chatId, `❌ Error in periodic token check: ${error.message}`);
  }
}, 300000); // 5 minutes

app.get('/', (req, res) => res.send('Bot running!'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const heliusWebhookUrl = webhookBaseUrl.endsWith('/webhook') ? webhookBaseUrl : `${webhookBaseUrl}/webhook`;
  console.log('Helius Webhook URL:', heliusWebhookUrl);
  console.log('Starting Helius webhook and periodic monitoring...');
  bot.sendMessage(chatId, '🚀 Bot started! Waiting for Pump.fun token alerts...');
});
