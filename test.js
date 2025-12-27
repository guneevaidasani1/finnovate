// Keep this to bypass certificate issues
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const WebSocket = require('ws');

// These headers fully mimic a Chrome browser request
const options = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.binance.com' // This is the missing piece!
    }
};

const binanceSocket = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade', options);

console.log("Finnovate Pipeline: Initializing...");

binanceSocket.on('open', () => {
    console.log("✅ SUCCESS: Connected to Binance!");
    console.log("Monitoring live trades for Whales ($500k+)...");
});

binanceSocket.on('message', (data) => {
    const trade = JSON.parse(data);
    const price = parseFloat(trade.p);
    const quantity = parseFloat(trade.q);
    const usdValue = price * quantity;

    if (usdValue >= 500000) {
        const side = trade.m ? 'SELL' : 'BUY';
        console.log(`\n🚨 [${side}] WHALE ALERT: $${usdValue.toLocaleString(undefined, {maximumFractionDigits: 0})}`);
    }
});

binanceSocket.on('error', (err) => {
    console.error("❌ Connection Error:", err.message);
});