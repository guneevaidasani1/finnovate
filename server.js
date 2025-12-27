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

// --- NOISE REDUCTION CONFIG ---
const THROTTLE_MS = 1000;            
const MIN_VOLUME_THRESHOLD = 500;   
const WHALE_THRESHOLD = 500000;      
// ------------------------------

let tradeBuffer = []; 
let tradeHistory = { 
    timestamps: [], 
    prices: [], 
    volumes: [] 
};

function updateTradeHistory(trade) {
    const now = Date.now();
    const sixtyMinutesAgo = now - (60 * 60 * 1000);

    tradeHistory.timestamps.push(now);
    tradeHistory.prices.push(trade.price);
    tradeHistory.volumes.push(trade.value);

    while (tradeHistory.timestamps.length > 0 && tradeHistory.timestamps[0] < sixtyMinutesAgo) {
        tradeHistory.timestamps.shift();
        tradeHistory.prices.shift();
        tradeHistory.volumes.shift();
    }
}

const binanceSocket = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade', {
    headers: {
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://www.binance.com'
    }
});

binanceSocket.on('message', (data) => {
    try {
        const trade = JSON.parse(data);
        
        // 1. FORCED NUMERIC CONVERSION
        const price = Number(trade.p);
        const quantity = Number(trade.q);
        const usdValue = price * quantity;

        // 2. THE HARD FILTER
        // We use >= 500. If it's 499.99, it hits 'return' and the rest of the code is IGNORED.
        if (usdValue < MIN_VOLUME_THRESHOLD) {
            return; 
        }

        // DEBUG: Uncomment the line below to see exactly what's passing through in your terminal
        // console.log(`Passed Filter: $${usdValue.toFixed(2)}`);

        const tradeData = {
            price,
            quantity,
            value: usdValue,
            timestamp: new Date().toISOString()
        };

        updateTradeHistory(tradeData);
        tradeBuffer.push(tradeData);

        if (usdValue >= WHALE_THRESHOLD) {
            const side = trade.m ? 'SELL' : 'BUY';
            io.emit('whale_alert', {
                message: `🚨 [${side}] WHALE ALERT: $${usdValue.toLocaleString()}`,
                value: usdValue,
                timestamp: tradeData.timestamp
            });
        }
    } catch (err) {
        console.error("❌ Error:", err.message);
    }
});

// --- THROTTLE ENGINE ---
setInterval(() => {
    if (tradeBuffer.length > 0) {
        // Grab the last trade that successfully passed the $500 filter
        const latestValidTrade = tradeBuffer[tradeBuffer.length - 1];
        
        // Calculate the sum of all trades in this 1-second window (all > $500)
        const batchVolume = tradeBuffer.reduce((sum, t) => sum + t.value, 0);
        
        io.emit('trade_update', {
            price: latestValidTrade.price,
            quantity: latestValidTrade.quantity,
            value: latestValidTrade.value, // This is your "Last Trade Volume"
            batchVolume: batchVolume,      // This is the total for the second
            timestamp: latestValidTrade.timestamp,
            isFiltered: true
        });

        io.emit('history_update', tradeHistory);
        tradeBuffer = [];
    }
}, THROTTLE_MS);

io.on('connection', (socket) => {
    socket.emit('history_update', tradeHistory);
});

server.listen(3000, () => console.log(`🚀 Filtered Server: http://localhost:3000`));