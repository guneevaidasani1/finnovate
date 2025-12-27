let priceChart = null;
let volumeChart = null;
let whaleAlerts = [];
const socket = io('http://localhost:3000');

// DOM Elements
const currentPriceEl = document.getElementById('currentPrice');
const lastVolumeEl = document.getElementById('lastVolume');
const whaleCountEl = document.getElementById('whaleCount');
const totalVolumeEl = document.getElementById('totalVolume');
const alertsListEl = document.getElementById('alertsList');
const lastUpdateEl = document.getElementById('lastUpdate');
const whaleModal = document.getElementById('whaleModal');
const whaleRegimeEl = document.getElementById('whaleRegime');
const whaleHeatmapEl = document.getElementById('whaleHeatmap');

// Slider Elements
const whaleSlider = document.getElementById('whaleSlider');
const thresholdDisplay = document.getElementById('thresholdDisplay');
const ledgerThreshold = document.getElementById('ledgerThreshold');

async function fetchCoinLogo(coinId = 'bitcoin') {
    try {
        const response = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}`);
        const data = await response.json();
        const logoImg = document.getElementById('coinLogo');
        const fallback = document.getElementById('logoFallback');
        
        if (data.image && data.image.small) {
            logoImg.src = data.image.small;
            logoImg.classList.remove('hidden');
            fallback.classList.add('hidden');
        }
    } catch (err) {
        console.error("CoinGecko API error:", err);
    }
}

function initializeCharts() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { 
            legend: { display: false },
            tooltip: {
                backgroundColor: '#1A1A1A',
                titleFont: { size: 10 },
                bodyFont: { size: 12 },
                displayColors: false,
                padding: 10
            }
        },
        scales: {
            x: { 
                display: true,
                grid: { display: false },
                ticks: { color: '#A1A1AA', font: { size: 9 }, maxTicksLimit: 12, autoSkip: true }
            },
            y: {
                display: true,
                grid: { color: '#F1F1EF', drawBorder: false },
                ticks: { 
                    color: '#A1A1AA', 
                    font: { size: 10 },
                    callback: (value) => value >= 1000 ? '$' + value.toLocaleString() : value
                }
            }
        },
        elements: {
            line: { tension: 0.15, borderWidth: 2 },
            point: { radius: 0, hoverRadius: 5 }
        },
        interaction: { intersect: false, mode: 'index' }
    };

    priceChart = new Chart(document.getElementById('priceChart').getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: '#1A1A1A', backgroundColor: 'transparent' }] },
        options: commonOptions
    });

    volumeChart = new Chart(document.getElementById('volumeChart').getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: '#1A1A1A', backgroundColor: 'rgba(26,26,26,0.02)', fill: true }] },
        options: commonOptions
    });
}

function updateCharts(timestamps, prices, volumes) {
    const labels = timestamps.map(ts => {
        const date = new Date(ts);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    });

    priceChart.data.labels = labels;
    priceChart.data.datasets[0].data = prices;
    priceChart.update('none');

    volumeChart.data.labels = labels;
    volumeChart.data.datasets[0].data = volumes;
    volumeChart.update('none');
}

function applyThreshold(val) {
    const formatted = `$${val.toLocaleString()}`;
    if (thresholdDisplay) thresholdDisplay.textContent = formatted;
    if (ledgerThreshold) {
        ledgerThreshold.textContent = `Institutional Threshold: > ${formatted} USD`;
    }
    if (whaleSlider) whaleSlider.value = val;
}

whaleSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    applyThreshold(val);
    localStorage.setItem('whaleThreshold', val);
    socket.emit('threshold_update', val);
});

// NEW: Updated Whale Alert Logic for Toast
function showWhaleAlert(alert) {
    whaleAlerts.unshift(alert);
    if (whaleCountEl) whaleCountEl.textContent = whaleAlerts.length;
    updateAlertsList();
    updateWhaleRegime();
    updateWhaleHeatmap();

    const value = alert.value;
    const amountLabel = value / 1000000 >= 1 
        ? `$${(value / 1000000).toFixed(2)}M` 
        : `$${(value / 1000).toFixed(2)}K`;

    document.getElementById('whaleAmount').textContent = amountLabel;
    document.getElementById('whaleTime').textContent = new Date(alert.timestamp).toLocaleTimeString();
    
    // Trigger slide-in by adding 'active' class
    whaleModal.classList.add('active');
    
    // Auto-dismiss after 10 seconds
    setTimeout(closeWhaleModal, 10000);
}

// NEW: Close toast logic
function closeWhaleModal() {
    whaleModal.classList.remove('active');
}

function updateAlertsList() {
    alertsListEl.innerHTML = '';
    const recent = whaleAlerts.slice(0, 8);

    if (recent.length === 0) {
        alertsListEl.innerHTML = `<div class="p-8 text-center text-zinc-300 text-sm">Monitoring live flow...</div>`;
        return;
    }

    recent.forEach(alert => {
        const div = document.createElement('div');
        div.className = "flex items-center justify-between p-6 hover:bg-zinc-50 transition-colors";
        div.innerHTML = `
            <div class="flex items-center gap-4">
                <div class="w-1.5 h-1.5 bg-black rounded-full"></div>
                <div>
                    <p class="text-sm font-medium">Block Liquidity Event</p>
                    <p class="text-[10px] text-zinc-400 uppercase tracking-tighter">${new Date(alert.timestamp).toLocaleTimeString()}</p>
                </div>
            </div>
            <div class="text-sm font-mono">$${alert.value.toLocaleString()}</div>
        `;
        alertsListEl.appendChild(div);
    });
}

function getRecentWhales(minutes = 15) {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return whaleAlerts.filter(alert => {
        try {
            const ts = new Date(alert.timestamp).getTime();
            return !isNaN(ts) && ts >= cutoff;
        } catch (e) {
            return false;
        }
    });
}

function updateWhaleRegime() {
    if (!whaleRegimeEl) return;

    const recent = getRecentWhales(15);
    if (recent.length === 0) {
        whaleRegimeEl.textContent = 'Regime: Waiting for flow';
        return;
    }

    const totalVolume = recent.reduce((sum, a) => sum + (a.value || 0), 0);
    const largest = recent.reduce((max, a) => a.value > max ? a.value : max, 0);

    let label = 'Calm';
    if (totalVolume > 5000000 || largest > 2000000) {
        label = 'Aggressive';
    } else if (totalVolume > 1500000 || largest > 750000) {
        label = 'Elevated';
    }

    whaleRegimeEl.textContent = `Regime: ${label} (${recent.length} whales / 15m)`;
}

function updateWhaleHeatmap() {
    if (!whaleHeatmapEl) return;

    const recent = getRecentWhales(15);
    whaleHeatmapEl.innerHTML = '';

    if (recent.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'w-full flex items-center justify-center text-[11px] text-zinc-300';
        empty.textContent = 'Awaiting first whales...';
        whaleHeatmapEl.appendChild(empty);
        return;
    }

    const values = recent.map(a => a.value || 0);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);

    recent.forEach(alert => {
        const value = alert.value || 0;
        const block = document.createElement('div');
        block.className = 'h-full rounded-sm';

        const normalized = maxVal === minVal ? 1 : (value - minVal) / (maxVal - minVal);
        const lightness = 80 - normalized * 35; // 80% -> 45%
        block.style.backgroundColor = `hsl(0, 85%, ${lightness}%)`;
        block.style.flexGrow = String(0.5 + Math.sqrt(value) / 500);

        block.title = `$${value.toLocaleString()} @ ${new Date(alert.timestamp).toLocaleTimeString()}`;
        whaleHeatmapEl.appendChild(block);
    });
}

function updateStats(trade) {
    currentPriceEl.textContent = trade.price.toLocaleString(undefined, { minimumFractionDigits: 2 });
    lastVolumeEl.textContent = `$${Math.round(trade.value).toLocaleString()}`;
    lastUpdateEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

socket.on('trade_update', (trade) => updateStats(trade));
socket.on('whale_alert', (alert) => showWhaleAlert(alert));
socket.on('history_update', (history) => {
    updateCharts(history.timestamps, history.prices, history.volumes);
    const total = history.volumes.reduce((a, b) => a + b, 0);
    totalVolumeEl.textContent = total / 1000000 >= 1 
        ? `$${(total / 1000000).toFixed(2)}M` 
        : `$${(total / 1000).toFixed(2)}K`;
});

document.getElementById('coinSelector').addEventListener('change', (e) => {
    const symbol = e.target.value;
    const geckoId = e.target.options[e.target.selectedIndex].dataset.gecko;
    socket.emit('change_symbol', symbol);
    fetchCoinLogo(geckoId);
    priceChart.data.labels = [];
    priceChart.data.datasets[0].data = [];
    volumeChart.data.labels = [];
    volumeChart.data.datasets[0].data = [];
    whaleAlerts = [];
    updateAlertsList();
    updateWhaleRegime();
    updateWhaleHeatmap();
});

window.onload = () => {
    fetchCoinLogo();
    initializeCharts();
    const savedThreshold = localStorage.getItem('whaleThreshold');
    if (savedThreshold) {
        const val = parseInt(savedThreshold);
        applyThreshold(val);
        socket.emit('threshold_update', val);
    }
    updateWhaleRegime();
    updateWhaleHeatmap();
};
