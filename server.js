process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; 


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


const app = express();
const server = http.createServer(app);
const io = new Server(server);

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


const users = [];


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


// Whale analytics snapshot API (for future dashboards or external tools)
app.get('/api/whale-metrics', (req, res) => {
    const now = Date.now();
    const SIXTY_MIN_MS = 60 * 60 * 1000;
    whaleEvents = whaleEvents.filter((event) => event.timestamp >= now - SIXTY_MIN_MS);
    const metrics = buildWhaleMetrics(now);
    res.json(metrics);
});


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

function getWhaleWindowStats(now, windowMinutes) {
    const cutoff = now - windowMinutes * 60 * 1000;
    const windowEvents = whaleEvents.filter((event) => event.timestamp >= cutoff);

    if (windowEvents.length === 0) {
        return {
            windowMinutes,
            whaleCount: 0,
            totalVolume: 0,
            largestWhale: 0,
            buyVolume: 0,
            sellVolume: 0,
            netFlow: 0
        };
    }

    let totalVolume = 0;
    let largestWhale = 0;
    let buyVolume = 0;
    let sellVolume = 0;

    for (const event of windowEvents) {
        const value = event.value || 0;
        totalVolume += value;
        if (value > largestWhale) {
            largestWhale = value;
        }
        if (event.side === 'BUY') {
            buyVolume += value;
        } else if (event.side === 'SELL') {
            sellVolume += value;
        }
    }

    const netFlow = buyVolume - sellVolume;

    return {
        windowMinutes,
        whaleCount: windowEvents.length,
        totalVolume,
        largestWhale,
        buyVolume,
        sellVolume,
        netFlow
    };
}

function scoreWhaleWindow(stats) {
    const totalVolume = stats.totalVolume;
    const largestWhale = stats.largestWhale;
    const netFlow = stats.netFlow;

    let score = 0;

    // Contribution from total volume
    if (totalVolume > 10000000) {
        score += 40;
    } else if (totalVolume > 5000000) {
        score += 30;
    } else if (totalVolume > 2000000) {
        score += 20;
    } else if (totalVolume > 1000000) {
        score += 10;
    }

    // Contribution from the single largest whale
    if (largestWhale > 5000000) {
        score += 40;
    } else if (largestWhale > 2000000) {
        score += 25;
    } else if (largestWhale > 1000000) {
        score += 15;
    } else if (largestWhale > 500000) {
        score += 5;
    }

    // Directional imbalance (buy vs sell)
    const imbalance = Math.abs(netFlow);
    if (imbalance > 5000000) {
        score += 20;
    } else if (imbalance > 2000000) {
        score += 10;
    }

    if (score > 100) {
        score = 100;
    }

    let regime = 'Calm';
    if (score >= 75) {
        regime = 'Capitulation';
    } else if (score >= 50) {
        regime = 'Aggressive';
    } else if (score >= 25) {
        regime = 'Elevated';
    }

    return { score, regime };
}

function buildWhaleMetrics(now) {
    const stats5 = getWhaleWindowStats(now, 5);
    const score5 = scoreWhaleWindow(stats5);

    const stats15 = getWhaleWindowStats(now, 15);
    const score15 = scoreWhaleWindow(stats15);

    const stats60 = getWhaleWindowStats(now, 60);
    const score60 = scoreWhaleWindow(stats60);

    return {
        symbol: currentSymbol.toUpperCase(),
        generatedAt: new Date(now).toISOString(),
        windows: {
            m5: { ...stats5, ...score5 },
            m15: { ...stats15, ...score15 },
            m60: { ...stats60, ...score60 }
        }
    };
}

function updateWhaleAnalytics(now) {
    const SIXTY_MIN_MS = 60 * 60 * 1000;

    // Keep only the last 60 minutes of whale events
    whaleEvents = whaleEvents.filter((event) => event.timestamp >= now - SIXTY_MIN_MS);

    const metrics = buildWhaleMetrics(now);
    io.emit('whale_regime_update', metrics);

    // Detect short-term clusters (30s window, >= 3 whales, > $1.5M same-direction)
    const CLUSTER_WINDOW_MS = 30 * 1000;
    const MIN_CLUSTER_COUNT = 3;
    const MIN_CLUSTER_VOLUME = 1500000;

    const recentClusterEvents = whaleEvents.filter((event) => event.timestamp >= now - CLUSTER_WINDOW_MS);

    if (recentClusterEvents.length >= MIN_CLUSTER_COUNT) {
        let buyVolume = 0;
        let sellVolume = 0;
        let buyCount = 0;
        let sellCount = 0;

        for (const event of recentClusterEvents) {
            const value = event.value || 0;
            if (event.side === 'BUY') {
                buyVolume += value;
                buyCount += 1;
            } else if (event.side === 'SELL') {
                sellVolume += value;
                sellCount += 1;
            }
        }

        let dominantSide = null;
        let dominantCount = 0;
        let dominantVolume = 0;

        if (buyCount >= sellCount) {
            dominantSide = 'BUY';
            dominantCount = buyCount;
            dominantVolume = buyVolume;
        } else {
            dominantSide = 'SELL';
            dominantCount = sellCount;
            dominantVolume = sellVolume;
        }

        if (
            dominantCount >= MIN_CLUSTER_COUNT &&
            dominantVolume >= MIN_CLUSTER_VOLUME &&
            now - lastClusterAlertAt > CLUSTER_WINDOW_MS
        ) {
            lastClusterAlertAt = now;

            io.emit('whale_cluster_alert', {
                symbol: currentSymbol.toUpperCase(),
                side: dominantSide,
                count: dominantCount,
                totalVolume: dominantVolume,
                windowSeconds: CLUSTER_WINDOW_MS / 1000,
                generatedAt: new Date(now).toISOString()
            });
        }
    }

    // Liquidity drain alert (5m heavy net sell flow)
    const stats5 = metrics.windows.m5;
    const DRAIN_THRESHOLD = 5000000;

    if (
        stats5.netFlow < -DRAIN_THRESHOLD &&
        now - lastLiquidityDrainAlertAt > 5 * 60 * 1000
    ) {
        lastLiquidityDrainAlertAt = now;

        io.emit('liquidity_drain_alert', {
            symbol: currentSymbol.toUpperCase(),
            windowMinutes: 5,
            netFlow: stats5.netFlow,
            totalSellVolume: stats5.sellVolume,
            totalBuyVolume: stats5.buyVolume,
            generatedAt: new Date(now).toISOString()
        });
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

            const eventTimeMs = typeof trade.T === 'number' ? trade.T : Date.now();
            const side = trade.m === true ? 'SELL' : 'BUY'; // Binance: m=true => buyer is maker => sell-initiated trade

            const tradeData = {
                price,
                quantity,
                value: usdValue,
                side,
                timestamp: new Date(eventTimeMs).toISOString(),
                symbol: symbol.toUpperCase()
            };

            updateTradeHistory(tradeData);
            tradeBuffer.push(tradeData);

            if (usdValue >= whaleThreshold) {
                const whaleEvent = {
                    value: usdValue,
                    side,
                    timestamp: eventTimeMs,
                    symbol: tradeData.symbol
                };
                whaleEvents.push(whaleEvent);
                updateWhaleAnalytics(eventTimeMs);

                io.emit('whale_alert', {
                    value: usdValue,
                    side,
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
            side: latestValidTrade.side,
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