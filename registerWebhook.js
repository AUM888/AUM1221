const Moralis = require('moralis').default;
require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const registerWebhook = async () => {
  try {
    // Initialize Moralis
    await Moralis.start({
      apiKey: process.env.MORALIS_API_KEY,
    });

    // Set Telegram webhook
    console.log('Setting Telegram webhook with URL:', `${WEBHOOK_URL}/bot${BOT_TOKEN}`);
    const telegramResponse = await Moralis.Core.request({
      method: 'GET',
      url: `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      params: { url: `${WEBHOOK_URL}/bot${BOT_TOKEN}` },
    });
    console.log('Telegram webhook response:', telegramResponse);

    // Register Moralis Streams webhook
    console.log('Registering Moralis Streams webhook with URL:', `${WEBHOOK_URL}/webhook`);
    const streamConfig = {
      chains: ['solana'],
      webhookUrl: `${WEBHOOK_URL}/webhook`,
      description: 'Token Alerts',
      tag: 'token_mint',
      filters: [
        // Add your filters here (converted to Moralis format)
        // Note: Moralis Streams filters are limited, so some filters will be applied in checkAgainstFilters
        { field: 'mintAuthRevoked', value: true },
        { field: 'freezeAuthRevoked', value: true },
      ],
      includeNativeTxs: true,
      events: ['TOKEN_MINT'],
    };

    const moralisResponse = await Moralis.Streams.add(streamConfig);
    console.log('Moralis Streams webhook response:', moralisResponse);

  } catch (error) {
    console.error('Failed to register webhook:', error.message, 'Stack:', error.stack);
  }
};

registerWebhook();
