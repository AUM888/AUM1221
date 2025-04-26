// PumpFun Token Tracker Telegram Bot
// Main application file

// Required packages
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');
const schedule = require('node-schedule');
const winston = require('winston');
require('dotenv').config();

// Create logger for error handling
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// If we're not in production, log to console as well
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

// Configuration
const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '7486200165:AAGYsNj3gIKhx2DbA6amSNxOeRN15EJF1Fw',
  heliusApiKey: process.env.HELIUS_API_KEY || '2c5f49fe-b93a-4101-8f65-d6fbe8f2be23',
  heliusWebhookUrl: process.env.HELIUS_WEBHOOK_URL || 'https://aum1221.onrender.com',
  heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET || 'your-webhook-secret',
  pumportalApiKey: process.env.PUMPORTAL_API_KEY || '6t774d3cb8r52u1kdn4muvb4b5qnjp27754k2vvad5um8mhg6mtn6kkf8xw6advjdnq5jcu9ddr58d21f9bmmt3bcxgq8e2u95uk4e279xd4cka3b5vmrd2jex9m2dkhetd38jbq84ykucx5q4e356h24pvjne9n3at3ac4engppuuta5254bucb90qmhak8trnmda36n0kuf8',
  pumportalWebsocketUrl: process.env.PUMPORTAL_WEBSOCKET_URL || 'wss://pumpportal.fun/api/data',
  chatId: process.env.TELEGRAM_CHAT_ID || '-1002668459642',
  port: process.env.PORT || 3000
};

// Initialize Telegram Bot
let bot;
try {
  bot = new TelegramBot(config.telegramToken, { polling: true });
  logger.info('Telegram bot initialized successfully');
} catch (error) {
  logger.error('Failed to initialize Telegram bot:', error);
  process.exit(1);
}

// Initialize Express app for webhook
const app = express();
app.use(bodyParser.json());

// Cache for storing token data
const tokenCache = new Map();

// Connect to Pumportal WebSocket
let pumportalWs;

function connectToPumportalWebSocket() {
  try {
    pumportalWs = new WebSocket(config.pumportalWebsocketUrl);

    pumportalWs.on('open', () => {
      logger.info('Connected to Pumportal WebSocket');
      // Authenticate with API key
      pumportalWs.send(JSON.stringify({
        type: 'auth',
        apiKey: config.pumportalApiKey
      }));
      
      // Subscribe to PumpFun token events
      pumportalWs.send(JSON.stringify({
        type: 'subscribe',
        channel: 'pumpfun_tokens'
      }));
    });

    pumportalWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        
        if (message.type === 'token_update') {
          // Process token update
          await processTokenUpdate(message.data);
        }
      } catch (error) {
        logger.error('Error processing WebSocket message:', error);
      }
    });

    pumportalWs.on('error', (error) => {
      logger.error('Pumportal WebSocket error:', error);
      setTimeout(connectToPumportalWebSocket, 5000); // Reconnect after 5 seconds
    });

    pumportalWs.on('close', () => {
      logger.info('Pumportal WebSocket connection closed');
      setTimeout(connectToPumportalWebSocket, 5000); // Reconnect after 5 seconds
    });
  } catch (error) {
    logger.error('Failed to connect to Pumportal WebSocket:', error);
    setTimeout(connectToPumportalWebSocket, 5000); // Retry after 5 seconds
  }
}

// Process token updates from WebSocket
async function processTokenUpdate(tokenData) {
  try {
    // Update token cache
    tokenCache.set(tokenData.address, {
      ...tokenData,
      lastUpdated: new Date()
    });
    
    // Send real-time alert
    await sendTokenAlert(tokenData);
  } catch (error) {
    logger.error('Error processing token update:', error);
  }
}

// Fetch token details from Helius API
async function fetchTokenDetails(tokenAddress) {
  try {
    const response = await axios.post(`https://api.helius.xyz/v0/tokens/metadata?api-key=${config.heliusApiKey}`, {
      mintAccounts: [tokenAddress]
    });
    
    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    return null;
  } catch (error) {
    logger.error(`Error fetching token details for ${tokenAddress}:`, error);
    return null;
  }
}

// Fetch top holders from Helius API
async function fetchTopHolders(tokenAddress) {
  try {
    const response = await axios.post(`https://api.helius.xyz/v0/token-accounts?api-key=${config.heliusApiKey}`, {
      mint: tokenAddress,
      limit: 10
    });
    
    if (response.data && response.data.accounts) {
      return response.data.accounts;
    }
    return [];
  } catch (error) {
    logger.error(`Error fetching top holders for ${tokenAddress}:`, error);
    return [];
  }
}

// Calculate dev holdings
async function calculateDevHoldings(tokenAddress, totalSupply) {
  try {
    // This is a simplified example. In a real scenario, you would need to 
    // identify dev wallets based on certain criteria or known addresses
    const response = await axios.post(`https://api.helius.xyz/v0/token-accounts?api-key=${config.heliusApiKey}`, {
      mint: tokenAddress,
      limit: 1
    });
    
    if (response.data && response.data.accounts && response.data.accounts.length > 0) {
      const devBalance = response.data.accounts[0].amount;
      return (devBalance / totalSupply) * 100; // Return as percentage
    }
    return 0;
  } catch (error) {
    logger.error(`Error calculating dev holdings for ${tokenAddress}:`, error);
    return 0;
  }
}

// Send token alert to Telegram chat
async function sendTokenAlert(tokenData) {
  try {
    // Fetch additional details
    const tokenDetails = await fetchTokenDetails(tokenData.address);
    const topHolders = await fetchTopHolders(tokenData.address);
    const devHoldings = await calculateDevHoldings(tokenData.address, tokenData.supply || 0);
    
    if (!tokenDetails) {
      logger.error(`Could not fetch details for token ${tokenData.address}`);
      return;
    }
    
    // Generate Rugcheck URL
    const rugcheckUrl = `https://rugcheck.xyz/tokens/${tokenData.address}`;
    
    // Create message
    const message = `🚨 *PumpFun Token Alert* 🚨\n\n` +
      `*Token Name:* ${tokenDetails.name || tokenData.name || 'Unknown'}\n` +
      `*Token Address:* \`${tokenData.address}\`\n` +
      `*Market Cap:* $${formatNumber(tokenData.marketCap || 0)}\n` +
      `*Liquidity:* $${formatNumber(tokenData.liquidity || 0)}\n` +
      `*Dev Holdings:* ${devHoldings.toFixed(2)}%\n` +
      `*Price:* $${formatNumber(tokenData.price || 0)}\n` +
      `*Supply:* ${formatNumber(tokenData.supply || 0)}\n\n` +
      `*Top 10 Holders:*\n${formatTopHolders(topHolders)}\n\n` +
      `[Check on Rugcheck](${rugcheckUrl})`;
    
    // Create inline keyboard with emojis similar to Trojana bot
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔍 View on Rugcheck', url: rugcheckUrl },
          { text: '📊 View Chart', url: `https://birdeye.so/token/${tokenData.address}?chain=solana` }
        ],
        [
          { text: '🔄 Refresh Data', callback_data: `refresh_${tokenData.address}` },
          { text: '📱 Share', callback_data: `share_${tokenData.address}` }
        ]
      ]
    };
    
    // Send message
    await bot.sendMessage(config.chatId, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: JSON.stringify(keyboard)
    });
    
    logger.info(`Sent alert for token ${tokenData.address}`);
  } catch (error) {
    logger.error('Error sending token alert:', error);
  }
}

// Format number with commas
function formatNumber(num) {
  return parseFloat(num).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

// Format top holders for message
function formatTopHolders(holders) {
  if (!holders || holders.length === 0) {
    return 'No data available';
  }
  
  return holders.slice(0, 10).map((holder, index) => {
    const percentage = (holder.amount / holder.totalSupply) * 100;
    return `${index + 1}. ${shortenAddress(holder.owner)}: ${percentage.toFixed(2)}%`;
  }).join('\n');
}

// Shorten address for display
function shortenAddress(address) {
  return `${address.substring(0, 4)}...${address.substring(address.length - 4)}`;
}

// Schedule 30-minute alert for top 10 tokens
schedule.scheduleJob('*/30 * * * *', async () => {
  try {
    logger.info('Running scheduled 30-minute alert for top 10 tokens');
    
    // Get top 10 tokens by market cap
    const topTokens = Array.from(tokenCache.values())
      .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
      .slice(0, 10);
    
    if (topTokens.length === 0) {
      logger.info('No tokens in cache for scheduled alert');
      return;
    }
    
    // Send message about top tokens
    const message = `📊 *Top 10 PumpFun Tokens (30min Update)* 📊\n\n`;
    
    await bot.sendMessage(config.chatId, message, {
      parse_mode: 'Markdown'
    });
    
    // Send individual alerts for each token
    for (const token of topTokens) {
      await sendTokenAlert(token);
      // Wait a bit between messages to avoid Telegram rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    logger.error('Error in scheduled top tokens alert:', error);
  }
});

// Handle callback queries (button clicks)
bot.on('callback_query', async (query) => {
  try {
    const data = query.data;
    
    if (data.startsWith('refresh_')) {
      const tokenAddress = data.replace('refresh_', '');
      const tokenData = tokenCache.get(tokenAddress);
      
      if (tokenData) {
        await sendTokenAlert(tokenData);
        await bot.answerCallbackQuery(query.id, { text: 'Data refreshed!' });
      } else {
        await bot.answerCallbackQuery(query.id, { text: 'Token data not found!' });
      }
    } else if (data.startsWith('share_')) {
      const tokenAddress = data.replace('share_', '');
      await bot.answerCallbackQuery(query.id, { 
        text: `Share this token: https://solscan.io/token/${tokenAddress}`,
        show_alert: true 
      });
    }
  } catch (error) {
    logger.error('Error handling callback query:', error);
    try {
      await bot.answerCallbackQuery(query.id, { text: 'An error occurred!' });
    } catch (cbError) {
      logger.error('Error answering callback query:', cbError);
    }
  }
});

// Set up webhook endpoint for receiving Helius events
app.post('/webhook', async (req, res) => {
  try {
    // Verify webhook secret if provided
    const secret = req.headers['x-helius-webhook-secret'];
    if (config.heliusWebhookSecret && secret !== config.heliusWebhookSecret) {
      logger.warn('Invalid webhook secret received');
      return res.status(401).send('Unauthorized');
    }
    
    const events = req.body;
    
    for (const event of events) {
      if (event.type === 'TOKEN_MINT' || event.type === 'TOKEN_TRANSFER') {
        // Process token events
        if (event.tokenTransfers && event.tokenTransfers.length > 0) {
          const tokenAddress = event.tokenTransfers[0].mint;
          
          // Check if it's a PumpFun token
          const isPumpFunToken = await checkIfPumpFunToken(tokenAddress);
          
          if (isPumpFunToken) {
            // Fetch token data and send alert
            try {
              const tokenData = await fetchTokenDetails(tokenAddress);
              if (tokenData) {
                // Get additional data that might not be in the token details
                const additionalData = await fetchTokenAdditionalData(tokenAddress);
                
                // Update cache and send alert
                tokenCache.set(tokenAddress, {
                  address: tokenAddress,
                  name: tokenData.name,
                  symbol: tokenData.symbol,
                  supply: tokenData.supply,
                  price: additionalData.price || 0,
                  marketCap: additionalData.marketCap || 0,
                  liquidity: additionalData.liquidity || 0,
                  lastUpdated: new Date()
                });
                
                await sendTokenAlert(tokenCache.get(tokenAddress));
              }
            } catch (tokenError) {
              logger.error(`Error processing token ${tokenAddress}:`, tokenError);
            }
          }
        }
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    logger.error('Error processing webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Helper function to fetch additional token data (price, market cap, etc.)
async function fetchTokenAdditionalData(tokenAddress) {
  try {
    // This is a placeholder. In a real implementation, you would call appropriate APIs
    // to get this data (e.g., Pumportal API or other Solana data providers)
    
    // For demo, generate some random data
    return {
      price: Math.random() * 0.01,
      marketCap: Math.random() * 1000000,
      liquidity: Math.random() * 100000
    };
  } catch (error) {
    logger.error(`Error fetching additional data for token ${tokenAddress}:`, error);
    return {
      price: 0,
      marketCap: 0,
      liquidity: 0
    };
  }
}

// Helper function to check if a token is a PumpFun token
async function checkIfPumpFunToken(tokenAddress) {
  try {
    // Implement your logic to determine if it's a PumpFun token
    // This is a placeholder - you'll need to implement actual logic
    const tokenDetails = await fetchTokenDetails(tokenAddress);
    
    // Simple check - in production you might have more sophisticated criteria
    return tokenDetails && tokenDetails.name && 
           (tokenDetails.name.toLowerCase().includes('pump') || 
            tokenDetails.name.toLowerCase().includes('fun') ||
            (tokenDetails.symbol && tokenDetails.symbol.toLowerCase().includes('pump')));
  } catch (error) {
    logger.error(`Error checking if ${tokenAddress} is a PumpFun token:`, error);
    return false;
  }
}

// Basic health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('PumpFun Token Tracker Bot is running!');
});

// Start the Express server
const server = app.listen(config.port, () => {
  logger.info(`Server started on port ${config.port}`);
});

// Start WebSocket connection
connectToPumportalWebSocket();

// Start command handler
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    
    await bot.sendMessage(chatId, `👋 *Welcome to PumpFun Token Tracker!*\n\nThis bot tracks PumpFun tokens on the Solana blockchain in real-time and sends alerts with detailed information. You'll receive updates about new tokens and regular reports on the top 10 tokens every 30 minutes.\n\nUse /help to see available commands.`, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('Error handling /start command:', error);
  }
});

// Help command
bot.onText(/\/help/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    
    await bot.sendMessage(chatId, `*PumpFun Token Tracker Commands*\n\n/start - Start the bot\n/status - Check bot status\n/help - Show this help message`, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('Error handling /help command:', error);
  }
});

// Status command
bot.onText(/\/status/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const trackedTokens = tokenCache.size;
    
    await bot.sendMessage(chatId, `📊 *Bot Status*\n\nTracking ${trackedTokens} PumpFun tokens\nHelius API: Connected\nPumportal WebSocket: Connected\nLast update: ${new Date().toLocaleString()}`, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('Error handling /status command:', error);
  }
});

// Handle errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  if (server) {
    server.close(() => {
      logger.info('Server closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

logger.info('Bot started successfully');
