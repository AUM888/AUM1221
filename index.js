require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Moralis = require('moralis').default;

// Import helper functions
const { extractTokenInfo, checkAgainstFilters, formatTokenMessage } = require('./Helper.function');

const app = express();
const PORT = process.env.PORT || 10000;
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID || '-1002511600127';
const webhookBaseUrl = process.env.WEBHOOK_URL?.replace(/\/$/, '');

// Validate environment variables
if (!token || !webhookBaseUrl || !process.env.MORALIS_API_KEY) {
  console.error('Missing environment variables. Required: TELEGRAM_BOT_TOKEN, WEBHOOK_URL, MORALIS_API_KEY');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false, request: { retryAfter: 21 } });

app.use(express.json());

// Initialize Moralis
const initializeMoralis = async () => {
  await Moralis.start({
    apiKey: process.env.MORALIS_API_KEY,
  });
  console.log('Moralis initialized');
};

// Set Telegram webhook
bot.setWebHook(`${webhookBaseUrl}/bot${token}`).then(info => {
  console.log('Webhook set successfully:', info);
}).catch(error => {
  console.error('Failed togot set Telegram webhook:', error);
});

// Filter definitions (same as before)
let filters = {
  liquidity: { min: 4000, max: 25000 },
  poolSupply: { min: 60, max: 95 },
  devHolding: { min: 2, max: 10 },
  launchPrice: { min: 0.0000000022, max: 0.0000000058 },
  mintAuthRevoked: true,
  freezeAuthRevoked: true
};
let lastTokenData = null;
let userStates = {};
let lastFailedToken = null;
let eventCounter = 0;
let lastReset = Date.now();

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get('/webhook-status', (req, res) => {
  res.status(200).json({
    status: 'active',
    webhookUrl: `${webhookBaseUrl}/webhook`,
    lastEvent: lastTokenData ? new Date(lastTokenData.timestamp).toISOString() : 'No events received',
    eventCounter: eventCounter
  });
});

// Moralis Webhook Endpoint
app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook endpoint hit');
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
    console.log('Webhook received, events:', JSON.stringify(events, null, 2));

    if (!events || !Array.isArray(events) || events.length === 0) {
      console.log('No events in webhook');
      return res.status(400).send('No events received');
    }

    for (const event of events) {
      console.log('Processing event:', JSON.stringify(event, null, 2));

      // Extract token data using helper function
      const tokenData = await extractTokenInfo(event);
      console.log('Extracted Token Data:', JSON.stringify(tokenData, null, 2));

      if (!tokenData) {
        console.log('No valid token data for:', event.tokenMint);
        if (!lastFailedToken || lastFailedToken !== event.tokenMint) {
          bot.sendMessage(chatId, `⚠️ Failed to fetch data for token: ${event.tokenMint}`).catch(err => {
            console.error('Failed to send Telegram message for failed token data:', err.message);
          });
          lastFailedToken = event.tokenMint;
          await delay(2000);
        }
        continue;
      }

      tokenData.timestamp = now;
      lastTokenData = tokenData;

      // Apply filters
      if (checkAgainstFilters(tokenData, filters)) {
        console.log('Token passed filters, sending alert:', tokenData);
        const message = formatTokenMessage(tokenData);
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(err => {
          console.error('Failed to send Telegram alert:', err.message, 'Message:', message);
        });
      } else {
        console.log('Token did not pass filters:', tokenData.address);
        bot.sendMessage(chatId, `ℹ️ Token ${tokenData.address} did not pass filters`).catch(err => {
          console.error('Failed to send Telegram message for filter fail:', err.message);
        });
        await delay(2000);
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error.message, 'Stack:', error.stack);
    bot.sendMessage(chatId, `❌ Webhook error: ${error.message}`).catch(err => {
      console.error('Failed to send Telegram webhook error message:', err.message);
    });
    return res.status(500).send('Internal Server Error');
  }
});

// Test Webhook Endpoint
app.post('/test-webhook', async (req, res) => {
  try {
    const mockEvent = {
      type: 'TOKEN_MINT',
      tokenMint: 'TEST_TOKEN_ADDRESS',
    };
    console.log('Received test webhook:', JSON.stringify(mockEvent, null, 2));
    bot.sendMessage(chatId, 'ℹ️ Received test webhook').catch(err => {
      console.error('Failed to send Telegram test webhook message:', err.message);
    });

    const tokenData = await extractTokenInfo(mockEvent);
    console.log('Test token data:', JSON.stringify(tokenData, null, 2));

    if (tokenData) {
      const message = formatTokenMessage(tokenData);
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(err => {
        console.error('Failed to send Telegram test alert:', err.message);
      });
      bot.sendMessage(chatId, '✅ Test webhook successful!').catch(err => {
        console.error('Failed to send Telegram test success message:', err.message);
      });
    } else {
      bot.sendMessage(chatId, '⚠️ Test webhook failed: No token data').catch(err => {
        console.error('Failed to send Telegram test failure message:', err.message);
      });
    }

    return res.status(200).send('Test webhook processed');
  } catch (error) {
    console.error('Test webhook error:', error.message, 'Stack:', error.stack);
    bot.sendMessage(chatId, `❌ Test webhook error: ${error.message}`).catch(err => {
      console.error('Failed to send Telegram test error message:', err.message);
    });
    return res.status(500).send('Test webhook failed');
  }
});

// Telegram Bot Commands (unchanged)
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
  }).catch(err => {
    console.error('Failed to send Telegram /start message:', err.message);
  });
});

// Rest of bot logic (callback_query, message handling) - unchanged
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
      }).catch(err => {
        console.error('Failed to send Telegram trade menu:', err.message);
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
      }).catch(err => {
        console.error('Failed to send Telegram wallet menu:', err.message);
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
      }).catch(err => {
        console.error('Failed to send Telegram filters menu:', err.message);
      });
      break;

    case 'portfolio':
      bot.sendMessage(chatId, '📊 Portfolio Menu\nYour portfolio is empty.\n💰 Start trading to build your portfolio!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'back' }]
          ]
        }
      }).catch(err => {
        console.error('Failed to send Telegram portfolio menu:', err.message);
      });
      break;

    case 'help':
      bot.sendMessage(chatId, '❓ Help Menu\nThis bot helps you snipe meme coins on Pump.fun!\nCommands:\n/start - Start the bot\nFor support, contact @YourSupportUsername', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'back' }]
          ]
        }
      }).catch(err => {
        console.error('Failed to send Telegram help menu:', err.message);
      });
      break;

    case 'refresh':
      bot.sendMessage(chatId, `🔄 Refreshing latest token data...\nLast Token: ${lastTokenData?.address || 'N/A'}`).catch(err => {
        console.error('Failed to send Telegram refresh message:', err.message);
      });
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
      }).catch(err => {
        console.error('Failed to send Telegram back menu:', err.message);
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
      }).catch(err => {
        console.error('Failed to send Telegram edit liquidity message:', err.message);
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
      }).catch(err => {
        console.error('Failed to send Telegram edit pool supply message:', err.message);
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
      }).catch(err => {
        console.error('Failed to send Telegram edit dev holding message:', err.message);
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
      }).catch(err => {
        console.error('Failed to send Telegram edit launch price message:', err.message);
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
      }).catch(err => {
        console.error('Failed to send Telegram edit mint auth message:', err.message);
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
      }).catch(err => {
        console.error('Failed to send Telegram edit freeze auth message:', err.message);
      });
      break;

    default:
      bot.sendMessage(chatId, 'Unknown command. Please use the buttons').catch(err => {
        console.error('Failed to send Telegram unknown command message:', err.message);
      });
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
        bot.sendMessage(chatId, 'Invalid range. Please send a valid range (e.g., "4000-25000" or "4000 25000").').catch(err => {
          console.error('Failed to send Telegram invalid range message:', err.message);
        });
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
      }).catch(err => {
        console.error('Failed to send Telegram filter update message:', err.message);
      });
    } else if (editingField === 'mintauth' || editingField === 'freezeauth') {
      const value = text.trim().toLowerCase();
      if (value !== 'yes' && value !== 'no') {
        bot.sendMessage(chatId, 'Invalid input. Please send "Yes" or "No".').catch(err => {
          console.error('Failed to send Telegram invalid input message:', err.message);
        });
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
      }).catch(err => {
        console.error('Failed to send Telegram auth update message:', err.message);
      });
    }

    delete userStates[chatId];
  } catch (error) {
    bot.sendMessage(chatId, 'Error processing your input. Please try again.').catch(err => {
      console.error('Failed to send Telegram input error message:', err.message);
    });
  }
});

app.get('/', (req, res) => res.send('Bot running!'));

app.listen(PORT, async () => {
  await initializeMoralis();
  console.log(`Server running on port ${PORT}`);
  bot.sendMessage(chatId, '🚀 Bot started! Waiting for token alerts...').catch(err => {
    console.error('Failed to send Telegram bot start message:', err.message);
  });
});
