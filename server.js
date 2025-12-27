process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // For Dev only

// --- IMPORTS ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');

// --- APP & SERVER SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- CONFIGURATION ---
const THROTTLE_MS = 1000;
const MIN_VOLUME_THRESHOLD = 500;
let whaleThreshold = 500000; // Dynamic

// --- TRADING STATE ---
let tradeBuffer = [];
let tradeHistory = { timestamps: [], prices: [], volumes: [] };
let currentSymbol = 'btcusdt';
let binanceSocket = null;

// --- AUTH DATABASE (In-Memory) ---
const users = [];

// --- MIDDLEWARE ---
app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
    secret: 'finnovate-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// --- PASSPORT CONFIG ---
passport.use(new LocalStrategy((username, password, done) => {
    const user = users.find(u => u.username === username);
    if (!user) return done(null, false, { message: 'User not found' });
    
    bcrypt.compare(password, user.password, (err, isMatch) => {
        if (err) throw err;
        if (isMatch) return done(null, user);
        else return done(null, false, { message: 'Incorrect password' });
    });
}));

passport.use(new GoogleStrategy({
    clientID: "YOUR_GOOGLE_CLIENT_ID", // Replace with real keys if using Google
    clientSecret: "YOUR_GOOGLE_CLIENT_SECRET",
    callbackURL: "/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
    let user = users.find(u => u.googleId === profile.id);
    if (!user) {
        user = { 
            id: Date.now(), 
            googleId: profile.id, 
            username: profile.displayName,
            password: 'google-oauth-user' 
        };
        users.push(user);
    }
    return done(null, user);
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

app.get('/auth/google', passport.authenticate('google', { scope: ['profile'] }));
app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => res.redirect('/dashboard')
);

app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

// Serve static files (but hide index.html from root)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));


// --- CRYPTO LOGIC & WEBSOCKET ---

function updateTradeHistory(trade) {
    const now = Date.now();
    const sixtyMinutesAgo = now - (60 * 60 * 1000);

    tradeHistory.timestamps.push(now);
    tradeHistory.prices.push(trade.price);
    tradeHistory.volumes.push(trade.value);

    // Keep only last 60 mins
    while (tradeHistory.timestamps.length > 0 && tradeHistory.timestamps[0] < sixtyMinutesAgo) {
        tradeHistory.timestamps.shift();
        tradeHistory.prices.shift();
        tradeHistory.volumes.shift();
    }
}

function connectToBinance(symbol) {
    if (binanceSocket) {
        console.log(`Disconnecting from ${currentSymbol}...`);
        binanceSocket.terminate(); // Use terminate for cleaner close
        binanceSocket = null;
        // Reset history for the new coin
        tradeHistory = { timestamps: [], prices: [], volumes: [] };
        io.emit('history_update', tradeHistory); 
    }

    currentSymbol = symbol;
    const url = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
    console.log(`🔌 Connecting to Binance: ${symbol.toUpperCase()}`);
    
    binanceSocket = new WebSocket(url);

    binanceSocket.on('open', () => {
        console.log(`✅ Connected to ${symbol.toUpperCase()} stream.`);
    });

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

    binanceSocket.on('error', (err) => console.error("WebSocket Error:", err.message));
}

// Initial Connection
connectToBinance('btcusdt');

// --- CLIENT COMMUNICATION ---
setInterval(() => {
    if (tradeBuffer.length > 0) {
        const latestValidTrade = tradeBuffer[tradeBuffer.length - 1];
        io.emit('trade_update', {
            price: latestValidTrade.price,
            value: latestValidTrade.value,
            timestamp: latestValidTrade.timestamp,
            symbol: currentSymbol.toUpperCase()
        });
        io.emit('history_update', tradeHistory);
        tradeBuffer = [];
    }
}, THROTTLE_MS);

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    
    // Send current state immediately
    socket.emit('history_update', tradeHistory);
    socket.emit('threshold_update', whaleThreshold); 

    // Listen for symbol changes
    socket.on('change_symbol', (newSymbol) => {
        if (newSymbol && newSymbol !== currentSymbol) {
            connectToBinance(newSymbol);
        }
    });

    // Listen for threshold updates
    socket.on('threshold_update', (newVal) => {
        whaleThreshold = newVal;
        console.log(`Global Whale Threshold updated to: $${whaleThreshold}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 WhaleWatch Terminal: http://localhost:${PORT}`));