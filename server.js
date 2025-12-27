
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

        //send data to front end
        io.emit('trade_update', {
            price,
            quantity,
            value: usdValue,
            timestamp: new Date().toISOString()
        });

        
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

binanceSocket.on('error', (err) => {
    console.error("❌ Connection Error:", err.message);
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});