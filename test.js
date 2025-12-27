process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const WebSocket = require('ws');

// These headers are the "Gold Standard" to look like a real browser
const options = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Origin': 'https://www.binance.com',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    }
};

const binanceSocket = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade', options);

console.log("Finnovate Pipeline: Initializing...");

binanceSocket.on('open', () => {
    console.log("✅ SUCCESS: The pipeline is open!");
    console.log("Waiting for a Whale move ($500k+)...");
});

binanceSocket.on('message', (data) => {
    const trade = JSON.parse(data);
    const usdValue = parseFloat(trade.p) * parseFloat(trade.q);

    if (usdValue >= 500000) {
        console.log(`🚨 WHALE ALERT: $${usdValue.toLocaleString()}`);
    }
});

binanceSocket.on('error', (err) => {
    console.error("❌ Connection Error:", err.message);
    if (err.message.includes('403')) {
        console.log("👉 Tip: Your IP might be on a 5-minute timeout. Wait a bit then try again.");
    }
});