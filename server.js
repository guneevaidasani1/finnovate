process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));


let tradeHistory = { 
    timestamps: [], 
    prices: [], 
    volumes: [] 
};

//data older than 60 mins is washed
function updateTradeHistory(trade) {
    const now = Date.now();
    const sixtyMinutesAgo = now - (60 * 60 * 1000);

    // new data is added
    tradeHistory.timestamps.push(now);
    tradeHistory.prices.push(trade.price);
    tradeHistory.volumes.push(trade.value);

    // old data is fitlered
    while (tradeHistory.timestamps.length > 0 && tradeHistory.timestamps[0] < sixtyMinutesAgo) {
        tradeHistory.timestamps.shift();
        tradeHistory.prices.shift();
        tradeHistory.volumes.shift();
    }

    
    io.emit('history_update', tradeHistory);
}
// -----------------------------

app.get('/api/bitcoin-info', (req, res) => {
    res.json({
        name: 'Bitcoin',
        symbol: 'BTC',
        logo: 'https://cryptologos.cc/logos/bitcoin-btc-logo.png'
    });
});


const options = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.binance.com'
    }
};

const binanceSocket = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade', options);

console.log("Finnovate Pipeline: Initializing...");

binanceSocket.on('open', () => {
    console.log("✅ SUCCESS: Connected to Binance!");
    console.log("Monitoring live trades for Whales ($500k+)...");
});

binanceSocket.on('message', (data) => {
    try {
        const trade = JSON.parse(data);
        const price = parseFloat(trade.p);
        const quantity = parseFloat(trade.q);
        const usdValue = price * quantity;

        const tradeData = {
            price,
            quantity,
            value: usdValue,
            timestamp: new Date().toISOString()
        };

        // update history and total volume logic
        updateTradeHistory(tradeData);

        // send data to front end
        io.emit('trade_update', tradeData);

        if (usdValue >= 500000) {
            const side = trade.m ? 'SELL' : 'BUY';
            const alertMsg = `🚨 [${side}] WHALE ALERT: $${usdValue.toLocaleString(undefined, {maximumFractionDigits: 0})}`;
            console.log(`\n${alertMsg}`);
            
            io.emit('whale_alert', {
                message: alertMsg,
                value: usdValue,
                timestamp: new Date().toISOString()
            });
        }
    } catch (err) {
        console.error("❌ Error parsing trade data:", err.message);
    }
});

// 
io.on('connection', (socket) => {
    socket.emit('history_update', tradeHistory);
});

binanceSocket.on('error', (err) => {
    console.error("❌ Connection Error:", err.message);
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});