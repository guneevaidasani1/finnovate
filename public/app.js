// app.js overhaul with Time-Series Precision
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
const overlay = document.getElementById('overlay');

function initializeCharts() {
    // UPDATED: commonOptions now enables the X-axis for Time display
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
                display: true, // Set to true to show Time
                grid: { display: false },
                ticks: { 
                    color: '#A1A1AA', 
                    font: { size: 9 },
                    maxTicksLimit: 8, // Prevents overlapping timestamps
                    autoSkip: true
                }
            },
            y: {
                display: true,
                grid: { color: '#F1F1EF', drawBorder: false },
                ticks: { 
                    color: '#A1A1AA', 
                    font: { size: 10 },
                    // Forces precise decimal formatting for Price
                    callback: function(value) {
                        return value >= 1000 ? '$' + value.toLocaleString() : value;
                    }
                }
            }
        },
        elements: {
            line: { tension: 0.1, borderWidth: 1.5 }, // Reduced tension for Swiss precision
            point: { radius: 0, hoverRadius: 4 }
        },
        interaction: {
            intersect: false,
            mode: 'index',
        }
    };

    // Chart 1: Price Trajectory (X: Time, Y: Price)
    priceChart = new Chart(document.getElementById('priceChart').getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: '#1A1A1A', backgroundColor: 'transparent' }] },
        options: commonOptions
    });

    // Chart 2: Volume Flow (X: Time, Y: Trade Volume)
    volumeChart = new Chart(document.getElementById('volumeChart').getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: '#1A1A1A', backgroundColor: 'rgba(26,26,26,0.02)', fill: true }] },
        options: commonOptions
    });
}

function updateCharts(timestamps, prices, volumes) {
    // Map timestamps to high-precision strings for the X-axis
    const labels = timestamps.map(ts => {
        const date = new Date(ts);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    });

    // Update Price Dataset
    priceChart.data.labels = labels;
    priceChart.data.datasets[0].data = prices;
    priceChart.update('none'); // 'none' prevents lag during rapid updates

    // Update Volume Dataset
    volumeChart.data.labels = labels;
    volumeChart.data.datasets[0].data = volumes;
    volumeChart.update('none');
}

function showWhaleAlert(alert) {
    whaleAlerts.unshift(alert);
    whaleCountEl.textContent = whaleAlerts.length;
    
    updateAlertsList();

    document.getElementById('whaleAmount').textContent = `$${(alert.value / 1000000).toFixed(2)}M`;
    document.getElementById('whaleTime').textContent = new Date(alert.timestamp).toLocaleTimeString();
    
    whaleModal.classList.remove('hidden');
    overlay.classList.remove('hidden');
    
    setTimeout(closeWhaleModal, 5000);
}

function closeWhaleModal() {
    whaleModal.classList.add('hidden');
    overlay.classList.add('hidden');
}

function updateAlertsList() {
    alertsListEl.innerHTML = '';
    const recent = whaleAlerts.slice(0, 5);

    if (recent.length === 0) {
        alertsListEl.innerHTML = `<div class="p-8 text-center text-zinc-300 text-sm">No large movements detected.</div>`;
        return;
    }

    recent.forEach(alert => {
        const div = document.createElement('div');
        div.className = "flex items-center justify-between p-6 hover:bg-zinc-50 transition-colors";
        div.innerHTML = `
            <div class="flex items-center gap-4">
                <div class="w-1 h-1 bg-black rounded-full"></div>
                <div>
                    <p class="text-sm font-medium">Liquidity Event</p>
                    <p class="text-[10px] text-zinc-400 uppercase tracking-tighter">${new Date(alert.timestamp).toLocaleTimeString()}</p>
                </div>
            </div>
            <div class="text-sm font-light">$${alert.value.toLocaleString()}</div>
        `;
        alertsListEl.appendChild(div);
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
    totalVolumeEl.textContent = `$${(total / 1000000).toFixed(2)}M`;
});

window.onload = () => {
    initializeCharts();
    overlay.addEventListener('click', closeWhaleModal);
};