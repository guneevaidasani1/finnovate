const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.static('public'));

let tradeHistory = { timestamps: [], prices: [], volumes: [] };
let whaleCount = 0;
let totalVolume = 0;

// Generate mock trade data
const generateMockTrade = () => {
  const basePrice = 45000 + Math.random() * 5000; // $45k-$50k
  const price = basePrice + (Math.random() - 0.5) * 100; // ±$50
  const quantity = 0.001 + Math.random() * 10; // 0.001-10 BTC
  const value = price * quantity;
  
  return {
    price: parseFloat(price.toFixed(2)),
    quantity: parseFloat(quantity.toFixed(6)),
    value: parseFloat(value.toFixed(2)),
    timestamp: new Date().toISOString()
  };
};

// Start mock data stream
setInterval(() => {
  const trade = generateMockTrade();
  
  // 5% chance of a whale trade
  const isWhale = Math.random() < 0.05;
  if (isWhale) {
    trade.value = 500000 + Math.random() * 1000000; // $500k-$1.5M
    trade.quantity = trade.value / trade.price;
    whaleCount++;
    
    const whaleAlert = {
      symbol: 'BTC/USDT',
      price: trade.price,
      quantity: trade.quantity,
      value: trade.value,
      timestamp: trade.timestamp,
      whaleCount,
      message: `🚨 WHALE ALERT: $${trade.value.toLocaleString()} BTC trade (Mock Data)`
    };
    
    console.log('🐋 Mock whale detected:', whaleAlert.message);
    io.emit('whale_alert', whaleAlert);
  }
  
  // Add to history
  tradeHistory.timestamps.push(trade.timestamp);
  tradeHistory.prices.push(trade.price);
  tradeHistory.volumes.push(trade.value);
  
  // Keep only last 60 minutes
  if (tradeHistory.timestamps.length > 360) { // 6 hours at 1 trade/10 seconds
    tradeHistory.timestamps.shift();
    tradeHistory.prices.shift();
    tradeHistory.volumes.shift();
  }
  
  // Calculate total volume
  totalVolume = tradeHistory.volumes.reduce((sum, vol) => sum + vol, 0);
  
  // Send updates
  io.emit('trade_update', {
    ...trade,
    isWhale,
    whaleCount,
    totalVolume
  });
  
  io.emit('history_update', tradeHistory);
  
}, 1000); // 1 trade per second

// API endpoints
app.get('/api/bitcoin-info', (req, res) => {
  res.json({
    name: 'Bitcoin',
    symbol: 'BTC',
    logo: 'https://cryptologos.cc/logos/bitcoin-btc-logo.png',
    description: 'Bitcoin is a decentralized digital currency. (Using mock data)'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    tradeHistoryCount: tradeHistory.timestamps.length,
    whaleCount: whaleCount,
    totalVolume: totalVolume,
    dataSource: 'Mock Data Generator'
  });
});

io.on('connection', (socket) => {
  console.log('👤 New client connected:', socket.id);
  socket.emit('history_update', tradeHistory);
  socket.emit('initial_data', { whaleCount, totalVolume, dataSource: 'Mock Data' });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Mock data server running on port ${PORT}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
});