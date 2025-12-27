// Global variables
let priceChart = null;
let volumeChart = null;
let whaleAlerts = [];
let lastTrade = null;
let whaleCount = 0;
let totalVolume = 0;

// Initialize Socket.io connection
const socket = io('http://localhost:3000');

// DOM elements
const currentPriceEl = document.getElementById('currentPrice');
const lastVolumeEl = document.getElementById('lastVolume');
const whaleCountEl = document.getElementById('whaleCount');
const totalVolumeEl = document.getElementById('totalVolume');
const alertsListEl = document.getElementById('alertsList');
const lastUpdateEl = document.getElementById('lastUpdate');
const whaleModal = document.getElementById('whaleModal');
const overlay = document.getElementById('overlay');
const connectionStatusEl = document.getElementById('connectionStatus');

// Fetch Bitcoin info from CoinGecko on page load
async function fetchBitcoinInfo() {
    try {
        const response = await fetch('/api/bitcoin-info');
        const data = await response.json();
        
        // Set Bitcoin logo
        const logoEl = document.getElementById('bitcoinLogo');
        logoEl.src = data.logo;
        logoEl.alt = `${data.name} logo`;
        
        // Update header with Bitcoin info
        const titleEl = document.querySelector('.title h1');
        titleEl.textContent = `🐋 ${data.name} Whale Alert`;
        
        const subtitleEl = document.querySelector('.title p');
        subtitleEl.textContent = `Real-time monitoring of ${data.symbol}/USDT trades`;
        
    } catch (error) {
        console.error('Error fetching Bitcoin info:', error);
    }
}

// Initialize charts
function initializeCharts() {
    const priceCtx = document.getElementById('priceChart').getContext('2d');
    const volumeCtx = document.getElementById('volumeChart').getContext('2d');
    
    // Price Chart
    priceChart = new Chart(priceCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'BTC/USDT Price',
                data: [],
                borderColor: '#f7931a',
                backgroundColor: 'rgba(247, 147, 26, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: {
                        color: '#fff'
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#aaa',
                        maxTicksLimit: 10
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                y: {
                    ticks: {
                        color: '#aaa'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
    
    // Volume Chart
    volumeChart = new Chart(volumeCtx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'Trade Volume (USD)',
                data: [],
                backgroundColor: 'rgba(255, 59, 59, 0.6)',
                borderColor: 'rgba(255, 59, 59, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: {
                        color: '#fff'
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#aaa',
                        maxTicksLimit: 10
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                y: {
                    ticks: {
                        color: '#aaa',
                        callback: function(value) {
                            return '$' + (value / 1000).toFixed(1) + 'K';
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
}

// Update charts with new data
function updateCharts(timestamps, prices, volumes) {
    // Update price chart
    priceChart.data.labels = timestamps.map(ts => {
        const date = new Date(ts);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    priceChart.data.datasets[0].data = prices;
    priceChart.update('none');
    
    // Update volume chart
    volumeChart.data.labels = priceChart.data.labels;
    volumeChart.data.datasets[0].data = volumes;
    volumeChart.update('none');
}

// Show whale alert modal
function showWhaleAlert(alert) {
    whaleCount++;
    whaleAlerts.unshift(alert);
    
    // Update whale count
    whaleCountEl.textContent = whaleCount;
    
    // Update alerts list
    updateAlertsList();
    
    // Show modal
    document.getElementById('whaleAmount').textContent = 
        `Amount: $${alert.value.toLocaleString()}`;
    document.getElementById('whaleTime').textContent = 
        `Time: ${new Date(alert.timestamp).toLocaleTimeString()}`;
    
    whaleModal.style.display = 'block';
    overlay.style.display = 'block';
    
    // Auto-hide modal after 10 seconds
    setTimeout(() => {
        closeWhaleModal();
    }, 10000);
}

// Close whale modal
function closeWhaleModal() {
    whaleModal.style.display = 'none';
    overlay.style.display = 'none';
}

// Update alerts list
function updateAlertsList() {
    alertsListEl.innerHTML = '';
    
    if (whaleAlerts.length === 0) {
        alertsListEl.innerHTML = `
            <div class="alert-item">
                <div class="time">No whale alerts yet</div>
                <div class="message">Waiting for large trades...</div>
            </div>
        `;
        return;
    }
    
    // Show only last 10 alerts
    const recentAlerts = whaleAlerts.slice(0, 10);
    
    recentAlerts.forEach(alert => {
        const alertEl = document.createElement('div');
        alertEl.className = 'alert-item';
        alertEl.innerHTML = `
            <div class="time">${new Date(alert.timestamp).toLocaleString()}</div>
            <div class="message">${alert.message}</div>
        `;
        alertsListEl.appendChild(alertEl);
    });
}

// Update statistics
function updateStats(trade) {
    if (!trade) return;
    
    // Update current price
    currentPriceEl.textContent = `$${trade.price.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
    
    // Update last volume
    lastVolumeEl.textContent = `$${trade.value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    })}`;
    
    // Update last update time
    lastUpdateEl.textContent = new Date().toLocaleTimeString();
}

// Socket.io event handlers
socket.on('connect', () => {
    console.log('Connected to server');
    connectionStatusEl.textContent = 'Connected to Binance';
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    connectionStatusEl.textContent = 'Disconnected - Reconnecting...';
});

socket.on('trade_update', (trade) => {
    lastTrade = trade;
    updateStats(trade);
});

socket.on('whale_alert', (alert) => {
    showWhaleAlert(alert);
});

socket.on('history_update', (history) => {
    updateCharts(history.timestamps, history.prices, history.volumes);
    
    // Calculate total volume for last hour
    totalVolume = history.volumes.reduce((sum, volume) => sum + volume, 0);
    if(totalVolume/1000 > 1000){
        totalVolumeEl.textContent = `$${(totalVolume / 1000000).toFixed(2)}M`;
    }
    else{
        totalVolumeEl.textContent = `$${(totalVolume / 1000).toFixed(2)}K`;
    }
});

// Initialize everything when page loads
window.onload = function() {
    fetchBitcoinInfo();
    initializeCharts();
    
    // Set up close modal handlers
    overlay.addEventListener('click', closeWhaleModal);
    
    console.log('Dashboard initialized');
};