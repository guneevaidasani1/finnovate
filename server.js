process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; 

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
require('dotenv').config(); // Load environment variables

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- CONFIGURATION ---
const THROTTLE_MS = 1000;
const MIN_VOLUME_THRESHOLD = 500;
let whaleThreshold = 500000; 

let tradeBuffer = [];
let tradeHistory = { timestamps: [], prices: [], volumes: [] };
let currentSymbol = 'btcusdt';
let binanceSocket = null;
let whaleEvents = [];
let lastClusterAlertAt = 0;
let lastLiquidityDrainAlertAt = 0;

// In-Memory User Store
const users = [];

app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key', // Use .env for safety
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// --- PASSPORT CONFIG (Local Only) ---
passport.use(new LocalStrategy((username, password, done) => {
    const user = users.find(u => u.username === username);
    if (!user) return done(null, false, { message: 'User not found' });
    
    bcrypt.compare(password, user.password, (err, isMatch) => {
        if (err) throw err;
        if (isMatch) return done(null, user);
        else return done(null, false, { message: 'Incorrect password' });
    });
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    const user = users.find(u => u.id === id);
    done(null, user);
});

// --- AUTH ROUTES ---
app.get('/', (req, res) => {
    if (req.isAuthenticated()) {
        res.redirect('/dashboard');
    } else {
        res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
    }
});

app.get('/dashboard', (req, res) => {
    if (req.isAuthenticated()) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.redirect('/');
    }
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if(users.find(u => u.username === username)) {
        return res.send('User already exists. <a href="/">Go back</a>');
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    users.push({ id: Date.now(), username, password: hashedPassword });
    console.log(`✅ New User Registered: ${username}`);
    res.redirect('/'); 
});

app.post('/login', passport.authenticate('local', {
    successRedirect: '/dashboard',
    failureRedirect: '/'
}));

app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// --- WHALE ANALYTICS LOGIC ---
app.get('/api/whale-metrics', (req, res) => {
    const now = Date.now();
    const SIXTY_MIN_MS = 60 * 60 * 1000;
    whaleEvents = whaleEvents.filter((event) => event.timestamp >= now - SIXTY_MIN_MS);
    const metrics = buildWhaleMetrics(now);
    res.json(metrics);
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

function buildWhaleMetrics(now) {
    const stats5 = getWhaleWindowStats(now, 5);
    const stats15 = getWhaleWindowStats(now, 15);
    const stats60 = getWhaleWindowStats(now, 60);
    return {
        symbol: currentSymbol.toUpperCase(),
        generatedAt: new Date(now).toISOString(),
        windows: {
            m5: { ...stats5, ...scoreWhaleWindow(stats5) },
            m15: { ...stats15, ...scoreWhaleWindow(stats15) },
            m60: { ...stats60, ...scoreWhaleWindow(stats60) }
        }
    };
}

function getWhaleWindowStats(now, windowMinutes) {
    const cutoff = now - windowMinutes * 60 * 1000;
    const windowEvents = whaleEvents.filter((event) => event.timestamp >= cutoff);
    let totalVolume = 0, largestWhale = 0, buyVolume = 0, sellVolume = 0;
    for (const event of windowEvents) {
        const value = event.value || 0;
        totalVolume += value;
        if (value > largestWhale) largestWhale = value;
        if (event.side === 'BUY') buyVolume += value;
        else if (event.side === 'SELL') sellVolume += value;
    }
    return {
        windowMinutes, whaleCount: windowEvents.length, totalVolume, largestWhale,
        buyVolume, sellVolume, netFlow: buyVolume - sellVolume
    };
}

function scoreWhaleWindow(stats) {
    let score = 0;
    if (stats.totalVolume > 10000000) score += 40;
    if (stats.largestWhale > 5000000) score += 40;
    const imbalance = Math.abs(stats.netFlow);
    if (imbalance > 5000000) score += 20;
    if (score > 100) score = 100;
    let regime = 'Calm';
    if (score >= 75) regime = 'Capitulation';
    else if (score >= 50) regime = 'Aggressive';
    else if (score >= 25) regime = 'Elevated';
    return { score, regime };
}

function updateWhaleAnalytics(now) {
    const SIXTY_MIN_MS = 60 * 60 * 1000;
    whaleEvents = whaleEvents.filter((event) => event.timestamp >= now - SIXTY_MIN_MS);
    const metrics = buildWhaleMetrics(now);
    io.emit('whale_regime_update', metrics);

    const CLUSTER_WINDOW_MS = 30 * 1000;
    const MIN_CLUSTER_COUNT = 3;
    const MIN_CLUSTER_VOLUME = 1500000;
    const recentClusterEvents = whaleEvents.filter((event) => event.timestamp >= now - CLUSTER_WINDOW_MS);

    if (recentClusterEvents.length >= MIN_CLUSTER_COUNT) {
        let buyVolume = 0, sellVolume = 0, buyCount = 0, sellCount = 0;
        for (const event of recentClusterEvents) {
            const value = event.value || 0;
            if (event.side === 'BUY') { buyVolume += value; buyCount++; }
            else if (event.side === 'SELL') { sellVolume += value; sellCount++; }
        }
        let dominantSide = buyCount >= sellCount ? 'BUY' : 'SELL';
        let dominantCount = buyCount >= sellCount ? buyCount : sellCount;
        let dominantVolume = buyCount >= sellCount ? buyVolume : sellVolume;

        if (dominantCount >= MIN_CLUSTER_COUNT && dominantVolume >= MIN_CLUSTER_VOLUME && now - lastClusterAlertAt > CLUSTER_WINDOW_MS) {
            lastClusterAlertAt = now;
            io.emit('whale_cluster_alert', {
                symbol: currentSymbol.toUpperCase(), side: dominantSide, count: dominantCount,
                totalVolume: dominantVolume, windowSeconds: CLUSTER_WINDOW_MS / 1000, generatedAt: new Date(now).toISOString()
            });
        }
    }
}

// --- BINANCE CONNECTION ---
function connectToBinance(symbol) {
    if (binanceSocket) {
        binanceSocket.terminate();
        binanceSocket = null;
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
            const eventTimeMs = trade.T || Date.now();
            const side = trade.m === true ? 'SELL' : 'BUY';
            const tradeData = { price, quantity, value: usdValue, side, timestamp: new Date(eventTimeMs).toISOString(), symbol: symbol.toUpperCase() };
            updateTradeHistory(tradeData);
            tradeBuffer.push(tradeData);
            if (usdValue >= whaleThreshold) {
                whaleEvents.push({ value: usdValue, side, timestamp: eventTimeMs, symbol: tradeData.symbol });
                updateWhaleAnalytics(eventTimeMs);
                io.emit('whale_alert', { value: usdValue, side, timestamp: tradeData.timestamp, symbol: tradeData.symbol });
            }
        } catch (err) { console.error("Stream Error:", err.message); }
    });
}

connectToBinance('btcusdt');

setInterval(() => {
    if (tradeBuffer.length > 0) {
        const latestValidTrade = tradeBuffer[tradeBuffer.length - 1];
        io.emit('trade_update', latestValidTrade);
        io.emit('history_update', tradeHistory);
        tradeBuffer = [];
    }
}, THROTTLE_MS);

io.on('connection', (socket) => {
    socket.emit('history_update', tradeHistory);
    socket.emit('threshold_update', whaleThreshold); 
    socket.on('change_symbol', (newSymbol) => { if (newSymbol && newSymbol !== currentSymbol) connectToBinance(newSymbol); });
    socket.on('threshold_update', (newVal) => { whaleThreshold = newVal; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Terminal: http://localhost:${PORT}`));