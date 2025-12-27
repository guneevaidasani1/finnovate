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
let whaleThreshold = 500000; // Changed to 'let' to allow dynamic updates
// --------------------

let tradeBuffer = []; 
let tradeHistory = { timestamps: [], prices: [], volumes: [] };

// Add a variable to track the current socket
let currentSymbol = 'btcusdt';
let binanceSocket = null;

function connectToBinance(symbol) {
    if (binanceSocket) {
        binanceSocket.close();
        // Clear history when switching coins
        tradeHistory = { timestamps: [], prices: [], volumes: [] };
    }

    currentSymbol = symbol;
    const url = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
    binanceSocket = new WebSocket(url);

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
                timestamp: new Date().toISOString(),
                symbol: symbol.toUpperCase()
            };

            updateTradeHistory(tradeData);
            tradeBuffer.push(tradeData);

            if (usdValue >= whaleThreshold) {
                io.emit('whale_alert', {
                    value: usdValue,
                    timestamp: tradeData.timestamp,
                    symbol: tradeData.symbol
                });
            }
        } catch (err) {
            console.error("Stream Error:", err.message);
        }
    });

    console.log(`Subscribed to: ${symbol}`);
}

// Initialize with BTC
connectToBinance('btcusdt');

io.on('connection', (socket) => {
    socket.emit('history_update', tradeHistory);
    
    // Listen for symbol changes from user
    socket.on('change_symbol', (newSymbol) => {
        connectToBinance(newSymbol);
    });
});

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

        // Uses the dynamic threshold from the slider
        if (usdValue >= whaleThreshold) {
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
    console.log(`Client connected: ${socket.id}`);
    socket.emit('history_update', tradeHistory);

    // Listen for threshold updates from the frontend slider
    socket.on('threshold_update', (newVal) => {
        whaleThreshold = newVal;
        console.log(`Global Whale Threshold updated to: $${whaleThreshold}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 WhaleWatch Intelligence Server: http://localhost:${PORT}`));