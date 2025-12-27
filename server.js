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

// --- CONFIGURATION ---
const THROTTLE_MS = 1000;            
const MIN_VOLUME_THRESHOLD = 500;   
const WHALE_THRESHOLD = 500000;      
// --------------------

let tradeBuffer = []; 
let tradeHistory = { timestamps: [], prices: [], volumes: [] };

function updateTradeHistory(trade) {
    const now = Date.now();
    const sixtyMinutesAgo = now - (60 * 60 * 1000); // 60 Minute Window

    tradeHistory.timestamps.push(now);
    tradeHistory.prices.push(trade.price);
    tradeHistory.volumes.push(trade.value);

    // Prune data older than 60 minutes
    while (tradeHistory.timestamps.length > 0 && tradeHistory.timestamps[0] < sixtyMinutesAgo) {
        tradeHistory.timestamps.shift();
        tradeHistory.prices.shift();
        tradeHistory.volumes.shift();
    }
}

const binanceSocket = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');

binanceSocket.on('message', (data) => {
    try {
        const trade = JSON.parse(data);
        const price = Number(trade.p);
        const quantity = Number(trade.q);
        const usdValue = price * quantity;

        if (usdValue < MIN_VOLUME_THRESHOLD) return; 

        const tradeData = {
            price,
            quantity,
            value: usdValue,
            timestamp: new Date().toISOString()
        };

        updateTradeHistory(tradeData);
        tradeBuffer.push(tradeData);

        if (usdValue >= WHALE_THRESHOLD) {
            io.emit('whale_alert', {
                value: usdValue,
                timestamp: tradeData.timestamp
            });
        }
    } catch (err) {
        console.error("Stream Error:", err.message);
    }
});

setInterval(() => {
    if (tradeBuffer.length > 0) {
        const latestValidTrade = tradeBuffer[tradeBuffer.length - 1];
        io.emit('trade_update', {
            price: latestValidTrade.price,
            value: latestValidTrade.value,
            timestamp: latestValidTrade.timestamp
        });
        io.emit('history_update', tradeHistory);
        tradeBuffer = [];
    }
}, THROTTLE_MS);

io.on('connection', (socket) => {
    socket.emit('history_update', tradeHistory);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 WhaleWatch Intelligence Server: http://localhost:${PORT}`));