const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.static('public'));

// Store trade data
const tradeHistory = {
  timestamps: [],
  prices: [],
  volumes: []
};

let whaleCount = 0;
let totalVolume = 0;
let isConnected = false;

// **OPTION 1: Use REST API instead of WebSocket (Most Reliable)**
const startRestApiPolling = () => {
  console.log('📡 Starting Binance REST API polling...');
  
  const pollBinance = async () => {
    try {
      const response = await axios.get(
        'https://api.binance.com/api/v3/trades?symbol=BTCUSDT&limit=10',
        { timeout: 5000 }
      );
      
      const trades = response.data;
      
      trades.forEach(trade => {
        const price = parseFloat(trade.price);
        const quantity = parseFloat(trade.qty);
        const value = price * quantity;
        const timestamp = new Date(trade.time).toISOString();
        
        // Add to history
        tradeHistory.timestamps.push(timestamp);
        tradeHistory.prices.push(price);
        tradeHistory.volumes.push(value);
        
        // Keep only last 60 minutes (assuming 1 trade per second)
        if (tradeHistory.timestamps.length > 3600) {
          tradeHistory.timestamps.shift();
          tradeHistory.prices.shift();
          tradeHistory.volumes.shift();
        }
        
        // Calculate total volume
        totalVolume = tradeHistory.volumes.reduce((sum, vol) => sum + vol, 0);
        
        // Check for whale trades
        if (value > 500000) {
          whaleCount++;
          const whaleAlert = {
            symbol: 'BTC/USDT',
            price,
            quantity,
            value,
            timestamp,
            whaleCount,
            message: `🚨 WHALE ALERT: $${value.toLocaleString()} BTC trade`
          };
          
          console.log('🐋 Whale detected:', whaleAlert.message);
          io.emit('whale_alert', whaleAlert);
        }
        
        // Send update to all connected clients
        io.emit('trade_update', {
          price,
          quantity,
          value,
          timestamp,
          isWhale: value > 500000,
          whaleCount,
          totalVolume
        });
      });
      
      // Send history update
      io.emit('history_update', tradeHistory);
      
    } catch (error) {
      console.error('❌ Binance API error:', error.message);
    }
  };
  
  // Poll every 2 seconds
  setInterval(pollBinance, 2000);
  
  // Initial poll
  pollBinance();
};

// **OPTION 2: Try WebSocket with better error handling**
const tryWebSocket = () => {
  console.log('🔗 Trying WebSocket connection...');
  
  // Try without SSL verification
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  
  const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected!');
    isConnected = true;
    io.emit('connection_status', { status: 'connected', message: 'Connected to Binance' });
  });
  
  ws.on('message', (data) => {
    try {
      const trade = JSON.parse(data);
      const price = parseFloat(trade.p);
      const quantity = parseFloat(trade.q);
      const value = price * quantity;
      const timestamp = new Date().toISOString();
      
      // Process trade data (same as above)
      tradeHistory.timestamps.push(timestamp);
      tradeHistory.prices.push(price);
      tradeHistory.volumes.push(value);
      
      if (tradeHistory.timestamps.length > 3600) {
        tradeHistory.timestamps.shift();
        tradeHistory.prices.shift();
        tradeHistory.volumes.shift();
      }
      
      totalVolume = tradeHistory.volumes.reduce((sum, vol) => sum + vol, 0);
      
      if (value > 500000) {
        whaleCount++;
        const whaleAlert = {
          symbol: 'BTC/USDT',
          price,
          quantity,
          value,
          timestamp,
          whaleCount,
          message: `🚨 WHALE ALERT: $${value.toLocaleString()} BTC trade`
        };
        
        console.log('🐋 Whale detected:', whaleAlert.message);
        io.emit('whale_alert', whaleAlert);
      }
      
      io.emit('trade_update', {
        price,
        quantity,
        value,
        timestamp,
        isWhale: value > 500000,
        whaleCount,
        totalVolume
      });
      
      io.emit('history_update', tradeHistory);
      
    } catch (error) {
      console.error('❌ Error processing trade:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket closed. Switching to REST API polling...');
    isConnected = false;
    io.emit('connection_status', { 
      status: 'disconnected', 
      message: 'Using REST API polling' 
    });
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
    isConnected = false;
  });
  
  // If WebSocket doesn't connect within 5 seconds, use REST API
  setTimeout(() => {
    if (!isConnected) {
      console.log('⏱️ WebSocket timeout. Starting REST API polling...');
      startRestApiPolling();
    }
  }, 5000);
};

// API endpoints
app.get('/api/bitcoin-info', async (req, res) => {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/coins/bitcoin',
      { timeout: 5000 }
    );
    
    const data = response.data;
    res.json({
      name: data.name,
      symbol: data.symbol.toUpperCase(),
      logo: data.image?.small || 'https://cryptologos.cc/logos/bitcoin-btc-logo.png',
      description: 'Bitcoin is a decentralized digital currency.'
    });
  } catch (error) {
    console.error('Error fetching Bitcoin info:', error.message);
    res.json({
      name: 'Bitcoin',
      symbol: 'BTC',
      logo: 'https://cryptologos.cc/logos/bitcoin-btc-logo.png',
      description: 'Bitcoin is a decentralized digital currency.'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    tradeHistoryCount: tradeHistory.timestamps.length,
    whaleCount: whaleCount,
    totalVolume: totalVolume,
    connection: isConnected ? 'WebSocket' : 'REST API'
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('👤 Client connected:', socket.id);
  
  // Send current data to new client
  socket.emit('history_update', tradeHistory);
  socket.emit('initial_data', {
    whaleCount,
    totalVolume,
    connection: isConnected ? 'WebSocket' : 'REST API'
  });
  
  socket.on('disconnect', () => {
    console.log('👋 Client disconnected:', socket.id);
  });
});

// Start data collection
tryWebSocket();

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log('🔌 Trying to connect to Binance...');
});