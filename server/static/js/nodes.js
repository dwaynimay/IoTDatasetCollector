import { state, SIG_COLORS, SIG_UNITS } from './state.js';
import { fetchNodeHistory } from './api.js';

const imuCharts   = new Map(); // nodeId -> echarts instance (IMU waveform)
const ppgCharts   = new Map(); // nodeId -> echarts instance (PPG waveform)
const dataBuffers = new Map(); // nodeId -> signalName -> array of last 200 points

const BUFFER_SIZE = 200;

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

export function renderNodeList() {
  const container = document.getElementById('nodesContainer');
  if (!container) return;

  if (state.nodes.size === 0) {
    container.innerHTML = `
      <div class="no-data" style="height: 200px; display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; grid-column: 1/-1;">
        <div class="no-data-icon" style="font-size: 48px; margin-bottom: 16px;">📡</div>
        <div style="font-size: 16px; color: var(--text2);">Menunggu koneksi node...</div>
      </div>
    `;
    return;
  }

  // Remove loading / no-data
  const noDataEl = container.querySelector('.no-data');
  if (noDataEl) {
    container.innerHTML = '';
  }
  
  Array.from(state.nodes.values()).sort((a,b) => a.node_id - b.node_id).forEach(node => {
    let shell = document.getElementById(`node-card-shell-${node.node_id}`);
    
    // If card shell doesn't exist, create it
    if (!shell) {
      shell = document.createElement('div');
      shell.className = 'node-card-shell';
      shell.id = `node-card-shell-${node.node_id}`;
      shell.onclick = () => selectNode(node.node_id);
      container.appendChild(shell);
    }
    
    if (state.selectedNode === node.node_id) {
      shell.classList.add('active');
    } else {
      shell.classList.remove('active');
    }
    
    const now = Date.now();
    const uptimeSec = state.server_start_time_offset ? Math.floor((now - state.server_start_time_offset) / 1000) : null;
    const uptimeStr = uptimeSec !== null ? formatDuration(uptimeSec) : '--';

    shell.innerHTML = `
      <div class="node-card" id="node-card-${node.node_id}">
        <div class="card-header">
          <span class="node-name">Node ${node.node_id}</span>
          <span class="node-status-badge disconnected" id="status-${node.node_id}">
            <span class="status-dot"></span>
            <span class="status-text">Disconnected</span>
          </span>
        </div>
        <div class="card-meta">
          <div class="meta-item">
            <span class="meta-icon">
              <svg class="icon-svg mini" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </span>
            <span class="meta-label">Uptime:</span>
            <span class="meta-value" id="uptime-${node.node_id}">${uptimeStr}</span>
          </div>
          <div class="meta-item">
            <span class="meta-icon">
              <svg class="icon-svg mini" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
            </span>
            <span class="meta-label">Samples:</span>
            <span class="meta-value" id="win-${node.node_id}">${node.total_samples || 0}</span>
          </div>
        </div>
        <div class="card-imu-header">IMU Signals (Raw Stream)</div>
        <div class="card-imu" id="imu-chart-${node.node_id}" style="height: 250px;"></div>
        <div class="card-imu-header">PPG Signals (Raw Stream)</div>
        <div class="card-imu" id="ppg-chart-${node.node_id}" style="height: 200px;"></div>
      </div>
    `;
    
    // Setup charts and fetch history
    setTimeout(async () => {
      // FIX 3: Init buffer + fetch history ONLY once per node.
      // On re-render (e.g. a second node appears), we skip the fetch so
      // existing live data in the buffer is preserved — preventing zoom-out flash.
      if (!dataBuffers.has(node.node_id)) {
        dataBuffers.set(node.node_id, {
          ax: Array(BUFFER_SIZE).fill(null), ay: Array(BUFFER_SIZE).fill(null), az: Array(BUFFER_SIZE).fill(null),
          gx: Array(BUFFER_SIZE).fill(null), gy: Array(BUFFER_SIZE).fill(null), gz: Array(BUFFER_SIZE).fill(null),
          ir: Array(BUFFER_SIZE).fill(null), red: Array(BUFFER_SIZE).fill(null)
        });

        // Fetch history only for newly seen nodes
        try {
          const history = await fetchNodeHistory(node.node_id);
          if (history) {
            const buffers = dataBuffers.get(node.node_id);
            for (const [sig, values] of Object.entries(history)) {
              if (buffers[sig]) {
                // Copy values to the end of the buffer
                const len = Math.min(values.length, BUFFER_SIZE);
                for (let i = 0; i < len; i++) {
                  buffers[sig][BUFFER_SIZE - len + i] = values[i];
                }
              }
            }
          }
        } catch (err) {
          console.error("Failed to fetch history:", err);
        }
      }

      // Always re-init chart instances (DOM may have been rebuilt by renderNodeList)
      initIMUChart(node.node_id);
      initPPGChart(node.node_id);
    }, 10);
  });

  // Run immediate connection check
  updateConnectionStatuses();
}


// ── IMU Chart ─────────────────────────────────────────────────────────────────

export function initIMUChart(nodeId) {
  const el = document.getElementById(`imu-chart-${nodeId}`);
  if (!el || typeof echarts === 'undefined') return;

  if (imuCharts.has(nodeId)) {
    imuCharts.get(nodeId).dispose();
  }

  const chart = echarts.init(el);
  const xData = Array.from({ length: BUFFER_SIZE }, (_, i) => i);

  chart.setOption({
    backgroundColor: 'rgba(0,0,0,0.015)',
    graphic: [{
      type: 'text',
      id: 'nodata',
      left: 'center', top: 'middle',
      style: { text: 'Menunggu data stream...', font: '11px var(--mono)', fill: '#cbd5e1' },
      z: 100
    }],
    grid: { top: 14, bottom: 20, left: 44, right: 44 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.98)',
      borderColor: '#e2e8f0',
      borderWidth: 1,
      textStyle: { color: '#0f172a', fontSize: 10, fontFamily: 'var(--mono)' },
      shadowBlur: 10,
      formatter(params) {
        let s = `<div style="font-size:10px;color:#64748b;margin-bottom:4px">Sample ${params[0].axisValue}</div>`;
        params.forEach(p => {
          if (p.value != null) {
            const unit = SIG_UNITS[p.seriesName] || '';
            s += `<div style="display:flex;justify-content:space-between;gap:12px">`
              + `<span style="color:${p.color}">${p.seriesName}</span>`
              + `<span style="font-family:var(--mono)">${Number(p.value).toFixed(3)} <span style="color:#94a3b8;font-size:9px">${unit}</span></span></div>`;
          }
        });
        return s;
      }
    },
    legend: {
      top: 0, right: 0,
      textStyle: { fontSize: 9, fontFamily: 'var(--mono)', color: '#64748b' },
      itemWidth: 10, itemHeight: 3,
      data: [
        { name: 'ax', icon: 'rect' }, { name: 'ay', icon: 'rect' }, { name: 'az', icon: 'rect' },
        { name: 'gx', icon: 'rect' }, { name: 'gy', icon: 'rect' }, { name: 'gz', icon: 'rect' }
      ],
      formatter: name => `${name} (${SIG_UNITS[name] || ''})`
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: xData,
      axisLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } },
      axisLabel: { show: false },
      splitLine: { show: true, lineStyle: { color: 'rgba(0,0,0,0.03)', type: 'dashed' } }
    },
    yAxis: [
      {
        type: 'value', name: 'm/s²', nameTextStyle: { fontSize: 8, color: '#94a3b8' },
        position: 'left',
        // FIX 2: Soft 10% padding — prevents Y axis from snapping to extremes
        // when history range differs from live data range (zoom-out/zoom-in artifact)
        min: value => { const r = value.max - value.min || 1; return value.min - r * 0.1; },
        max: value => { const r = value.max - value.min || 1; return value.max + r * 0.1; },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        axisLabel: { fontSize: 8, fontFamily: 'var(--mono)', color: '#94a3b8',
          formatter: v => Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(1) }
      },
      {
        type: 'value', name: '°/s', nameTextStyle: { fontSize: 8, color: '#94a3b8' },
        position: 'right',
        min: value => { const r = value.max - value.min || 1; return value.min - r * 0.1; },
        max: value => { const r = value.max - value.min || 1; return value.max + r * 0.1; },
        splitLine: { show: false },
        axisLabel: { fontSize: 8, fontFamily: 'var(--mono)', color: '#94a3b8',
          formatter: v => Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(1) }
      }
    ],
    series: [
      { name: 'ax', type: 'line', smooth: false, symbol: 'none', yAxisIndex: 0,
        lineStyle: { color: SIG_COLORS.ax, width: 1.2 }, data: Array(BUFFER_SIZE).fill(null) },
      { name: 'ay', type: 'line', smooth: false, symbol: 'none', yAxisIndex: 0,
        lineStyle: { color: SIG_COLORS.ay, width: 1.2 }, data: Array(BUFFER_SIZE).fill(null) },
      { name: 'az', type: 'line', smooth: false, symbol: 'none', yAxisIndex: 0,
        lineStyle: { color: SIG_COLORS.az, width: 1.2 }, data: Array(BUFFER_SIZE).fill(null) },
      { name: 'gx', type: 'line', smooth: false, symbol: 'none', yAxisIndex: 1,
        lineStyle: { color: SIG_COLORS.gx, width: 1.2, type: 'dashed' }, data: Array(BUFFER_SIZE).fill(null) },
      { name: 'gy', type: 'line', smooth: false, symbol: 'none', yAxisIndex: 1,
        lineStyle: { color: SIG_COLORS.gy, width: 1.2, type: 'dashed' }, data: Array(BUFFER_SIZE).fill(null) },
      { name: 'gz', type: 'line', smooth: false, symbol: 'none', yAxisIndex: 1,
        lineStyle: { color: SIG_COLORS.gz, width: 1.2, type: 'dashed' }, data: Array(BUFFER_SIZE).fill(null) },
    ],
    animation: false
  });

  imuCharts.set(nodeId, chart);
  window.addEventListener('resize', () => chart && chart.resize());
}

// ── PPG Chart ─────────────────────────────────────────────────────────────────

export function initPPGChart(nodeId) {
  const el = document.getElementById(`ppg-chart-${nodeId}`);
  if (!el || typeof echarts === 'undefined') return;

  if (ppgCharts.has(nodeId)) {
    ppgCharts.get(nodeId).dispose();
  }

  const chart = echarts.init(el);
  const xData = Array.from({ length: BUFFER_SIZE }, (_, i) => i);

  chart.setOption({
    backgroundColor: 'rgba(0,0,0,0.015)',
    graphic: [{
      type: 'text',
      id: 'nodata',
      left: 'center', top: 'middle',
      style: { text: 'Menunggu data stream...', font: '11px var(--mono)', fill: '#cbd5e1' },
      z: 100
    }],
    grid: { top: 14, bottom: 20, left: 54, right: 24 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.98)',
      borderColor: '#e2e8f0',
      borderWidth: 1,
      textStyle: { color: '#0f172a', fontSize: 10, fontFamily: 'var(--mono)' },
      shadowBlur: 10,
      formatter(params) {
        let s = `<div style="font-size:10px;color:#64748b;margin-bottom:4px">Sample ${params[0].axisValue}</div>`;
        params.forEach(p => {
          if (p.value != null) {
            const unit = SIG_UNITS[p.seriesName] || '';
            s += `<div style="display:flex;justify-content:space-between;gap:12px">`
              + `<span style="color:${p.color}">${p.seriesName}</span>`
              + `<span style="font-family:var(--mono)">${Number(p.value).toFixed(0)} <span style="color:#94a3b8;font-size:9px">${unit}</span></span></div>`;
          }
        });
        return s;
      }
    },
    legend: {
      top: 0, right: 0,
      textStyle: { fontSize: 9, fontFamily: 'var(--mono)', color: '#64748b' },
      itemWidth: 10, itemHeight: 3,
      data: [
        { name: 'ir', icon: 'rect' }, { name: 'red', icon: 'rect' }
      ],
      formatter: name => `${name} (${SIG_UNITS[name] || ''})`
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: xData,
      axisLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } },
      axisLabel: { show: false },
      splitLine: { show: true, lineStyle: { color: 'rgba(0,0,0,0.03)', type: 'dashed' } }
    },
    yAxis: [
      {
        type: 'value', name: 'ADC', nameTextStyle: { fontSize: 8, color: '#94a3b8' },
        position: 'left',
        // FIX 2: Soft 10% padding instead of raw scale:true.
        // scale:true caused violent Y jumps when PPG baseline changed between history and live data.
        min: value => { const r = value.max - value.min || 1000; return value.min - r * 0.1; },
        max: value => { const r = value.max - value.min || 1000; return value.max + r * 0.1; },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        axisLabel: { fontSize: 8, fontFamily: 'var(--mono)', color: '#94a3b8',
          formatter: v => Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0) }
      }
    ],
    series: [
      { name: 'ir', type: 'line', smooth: false, symbol: 'none', yAxisIndex: 0,
        lineStyle: { color: SIG_COLORS.ir || '#E91E63', width: 1.2 }, data: Array(BUFFER_SIZE).fill(null) },
      { name: 'red', type: 'line', smooth: false, symbol: 'none', yAxisIndex: 0,
        lineStyle: { color: '#F44336', width: 1.2 }, data: Array(BUFFER_SIZE).fill(null) },
    ],
    animation: false
  });

  ppgCharts.set(nodeId, chart);
  window.addEventListener('resize', () => chart && chart.resize());
}

setInterval(() => {
  for (const [nodeId, chart] of imuCharts.entries()) {
    const buffers = dataBuffers.get(nodeId);
    if (!buffers) continue;
    
    chart.setOption({
      graphic: [{ id: 'nodata', style: { text: '' } }],
      series: [
        { name: 'ax', data: buffers.ax.slice() },
        { name: 'ay', data: buffers.ay.slice() },
        { name: 'az', data: buffers.az.slice() },
        { name: 'gx', data: buffers.gx.slice() },
        { name: 'gy', data: buffers.gy.slice() },
        { name: 'gz', data: buffers.gz.slice() },
      ]
    });
  }

  for (const [nodeId, chart] of ppgCharts.entries()) {
    const buffers = dataBuffers.get(nodeId);
    if (!buffers) continue;
    
    chart.setOption({
      graphic: [{ id: 'nodata', style: { text: '' } }],
      series: [
        { name: 'ir', data: buffers.ir.slice() },
        { name: 'red', data: buffers.red.slice() },
      ]
    });
  }
}, 66);

const pendingUpdates = new Map();

export function updateNodeCard(nodeId, data) {
  if (!document.getElementById(`node-card-shell-${nodeId}`)) {
    if (!state.nodes.has(nodeId)) {
      state.nodes.set(nodeId, {
        node_id: nodeId,
        last_seen_ms: Date.now(),
        last_seen_ago_s: 0,
        total_samples: 0
      });
    }
    renderNodeList();
    // FIX 1: Do NOT return early — fall through so the current window's
    // signal data is still pushed into the buffer below. Previously this
    // return caused the first data window of a new node to be silently dropped.
  }
  
  const node = state.nodes.get(nodeId);
  if (node) {
    node.last_seen_ms = Date.now();
    node.last_seen_ago_s = 0;
    node.total_samples++;
  }

  // Set badge immediately to connected
  const badge = document.getElementById(`status-${nodeId}`);
  if (badge && badge.className.includes('disconnected')) {
    badge.className = 'node-status-badge connected';
    badge.querySelector('.status-text').textContent = 'Connected';
  }
  
  // Throttle DOM text updates to 10Hz
  const now = Date.now();
  if (!pendingUpdates.has(nodeId) || now - pendingUpdates.get(nodeId) > 100) {
    const winEl = document.getElementById(`win-${nodeId}`);
    if (winEl) winEl.textContent = node.total_samples;
    pendingUpdates.set(nodeId, now);
  }

  // Update IMU and PPG waveform buffer ONLY (chart rendering is handled by global setInterval)
  if (data.signals && Object.keys(data.signals).length > 0) {
    if (!imuCharts.has(nodeId)) initIMUChart(nodeId);
    if (!ppgCharts.has(nodeId)) initPPGChart(nodeId);
    
    const buffers = dataBuffers.get(nodeId);
    if (buffers) {
      const keys = ['ax', 'ay', 'az', 'gx', 'gy', 'gz', 'ir', 'red'];
      keys.forEach(k => {
        if (data.signals[k] !== undefined) {
          buffers[k].push(data.signals[k]);
          buffers[k].shift();
        }
      });
    }
  }
}

window.updateNodeCard = updateNodeCard;

export function selectNode(nodeId) {
  state.selectedNode = nodeId;
  document.querySelectorAll('.node-card-shell').forEach(el => el.classList.remove('active'));
  const shell = document.getElementById(`node-card-shell-${nodeId}`);
  if (shell) shell.classList.add('active');
}

// Periodic connection status checker
export function updateConnectionStatuses() {
  const now = Date.now();
  
  // Calculate uptime
  const uptimeSec = state.server_start_time_offset ? Math.floor((now - state.server_start_time_offset) / 1000) : null;
  const uptimeStr = uptimeSec !== null ? formatDuration(uptimeSec) : '--';

  Array.from(state.nodes.values()).forEach(node => {
    const lastSeen = node.last_seen_ms || (now - ((node.last_seen_ago_s || 0) * 1000));
    const diffSec = Math.floor((now - lastSeen) / 1000);
    const isConnected = diffSec < 5;
    
    const badge = document.getElementById(`status-${node.node_id}`);
    if (badge) {
      if (isConnected) {
        badge.className = 'node-status-badge connected';
        badge.querySelector('.status-text').textContent = 'Connected';
      } else {
        badge.className = 'node-status-badge disconnected';
        badge.querySelector('.status-text').textContent = 'Disconnected';
      }
    }

    // Update card-level uptime
    const uptimeEl = document.getElementById(`uptime-${node.node_id}`);
    if (uptimeEl) {
      uptimeEl.textContent = uptimeStr;
    }
  });
}

// Check connection status every 1 second
setInterval(updateConnectionStatuses, 1000);
