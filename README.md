# PumpFun Token Tracker Bot

A Telegram bot that tracks PumpFun tokens on the Solana blockchain in real-time. The bot provides detailed information about tokens including name, address, market cap, liquidity, dev holdings, top holders, price, and supply.

## Features

- Real-time tracking of PumpFun tokens using Pumportal WebSocket
- 30-minute scheduled alerts for top 10 tokens
- Detailed token information including market cap, liquidity, price, and more
- Links to Rugcheck for token verification
- Interactive buttons for refreshing data and viewing charts
- Error handling and logging for reliability

## Setup and Installation

### Prerequisites

- Node.js 16 or higher
- A Telegram Bot Token (obtain from [@BotFather](https://t.me/BotFather))
- Helius API Key and Webhook Secret
- Pumportal API Key and WebSocket URL

### Installation

1. Clone this repository:
   ```
   git clone https://github.com/yourusername/pumpfun-token-tracker-bot.git
   cd pumpfun-token-tracker-bot
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file based on the `.env.example`:
   ```
   cp .env.example .env
   ```

4. Fill in your API keys and other configuration in the `.env` file.

### Running the Bot

1. Start the bot locally:
   ```
   npm start
   ```

2. For development with auto-restart:
   ```
   npm run dev
   ```

## Deployment on Render

1. Create a new Web Service on [Render](https://render.com).

2. Connect your GitHub repository.

3. Use the following settings:
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`

4. Add all the environment variables from your `.env` file.

5. Deploy your application.

6. Set up webhook on Helius to point to your Render URL + `/webhook` path.

## Bot Commands

- `/start` - Start the bot and see welcome message
- `/status` - Check the bot's current status
- `/help` - Display available commands

## Monitoring and Maintenance

- Check the logs on Render's dashboard for any errors
- The bot automatically reconnects to WebSocket if the connection is lost
- Error logs are stored in `error.log` file

## License

[ISC License](LICENSE)
