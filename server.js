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

// --- INSTITUTIONAL CONFIGURATION ---
const THROTTLE_MS = 1000;            
const MIN_VOLUME_THRESHOLD = 500;   // Ignore retail noise below $500
const WHALE_THRESHOLD = 500000;      // Professional threshold for alerts
// ----------------------------------

let tradeBuffer = []; 
let tradeHistory = { 
    timestamps: [], 
    prices: [], 
    volumes: [] 
};

/**
 * Maintains a rolling 60-minute window of market data
 */
function updateTradeHistory(trade) {
    const now = Date.now();
    const sixtyMinutesAgo = now - (60 * 60 * 1000);

    tradeHistory.timestamps.push(now);
    tradeHistory.prices.push(trade.price);
    tradeHistory.volumes.push(trade.value);

    // Evict data older than 60 minutes to maintain chart precision
    while (tradeHistory.timestamps.length > 0 && tradeHistory.timestamps[0] < sixtyMinutesAgo) {
        tradeHistory.timestamps.shift();
        tradeHistory.prices.shift();
        tradeHistory.volumes.shift();
    }
}

// Connect to Binance Institutional Feed
const binanceSocket = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade', {
    headers: {
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://www.binance.com'
    }
});

binanceSocket.on('message', (data) => {
    try {
        const trade = JSON.parse(data);
        
        const price = Number(trade.p);
        const quantity = Number(trade.q);
        const usdValue = price * quantity;

        // Apply strict filtering to maintain a "clean" UI
        if (usdValue < MIN_VOLUME_THRESHOLD) {
            return; 
        }

        const tradeData = {
            price,
            quantity,
            value: usdValue,
            timestamp: new Date().toISOString()
        };

        updateTradeHistory(tradeData);
        tradeBuffer.push(tradeData);

        // Emit high-value Whale Alerts
        if (usdValue >= WHALE_THRESHOLD) {
            const side = trade.m ? 'SELL' : 'BUY';
            io.emit('whale_alert', {
                side: side,
                value: usdValue,
                timestamp: tradeData.timestamp
            });
        }
    } catch (err) {
        console.error("Stream Error:", err.message);
    }
});

// --- DATA PRECISION ENGINE ---
// Batches incoming trades into 1-second updates to ensure UI fluidity
setInterval(() => {
    if (tradeBuffer.length > 0) {
        const latestValidTrade = tradeBuffer[tradeBuffer.length - 1];
        const batchVolume = tradeBuffer.reduce((sum, t) => sum + t.value, 0);
        
        io.emit('trade_update', {
            price: latestValidTrade.price,
            quantity: latestValidTrade.quantity,
            value: latestValidTrade.value,
            batchVolume: batchVolume,
            timestamp: latestValidTrade.timestamp
        });

        io.emit('history_update', tradeHistory);
        tradeBuffer = [];
    }
}, THROTTLE_MS);

io.on('connection', (socket) => {
    console.log('Client connected to institutional feed');
    // Immediately sync the new client with the last 60 minutes of history
    socket.emit('history_update', tradeHistory);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 WhaleWatch Intelligence Server: http://localhost:${PORT}`));