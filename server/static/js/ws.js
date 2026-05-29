import { state } from './state.js';
import { updateWSStatus } from './ui.js';

let reconnectAttempts = 0;

export function connectWS() {
  if (state.wsStream || state.wsEvents) return;
  
  const wsBase = state.apiBase.replace(/^http/, 'ws');

  // Stream
  state.wsStream = new WebSocket(wsBase + '/ws/stream');
  
  state.wsStream.onopen = () => {
    reconnectAttempts = 0;
    if (window.updateWSStatus) updateWSStatus('connected');
  };
  
  state.wsStream.onerror = () => {
    if (window.updateWSStatus) updateWSStatus('error');
  };
  
  state.wsStream.onclose = () => {
    if (window.updateWSStatus) updateWSStatus('disconnected');
    state.wsStream = null;
    scheduleReconnect();
  };
  
  state.wsStream.onmessage = (ev) => {
    if (state.isPaused) return;
    
    const d = JSON.parse(ev.data);
    
    // Asumsikan semua pesan dari /ws/stream adalah raw sample
    if (d.node_id !== undefined && d.signals) {
      state.sampleCount = (state.sampleCount || 0) + 1;
      
      // Update node presence
      if (!state.nodes.has(d.node_id)) {
        state.nodes.set(d.node_id, { node_id: d.node_id });
      }
      const node = state.nodes.get(d.node_id);
      node.last_seen_ms = Date.now();
      node.last_seen_ago_s = 0;
      
      // Send to UI
      if (window.updateNodeCard) {
        window.updateNodeCard(d.node_id, d);
      }
      
      // Update UI command bar counter if exists
      const wEl = document.getElementById('cmd-windows');
      if (wEl) wEl.textContent = state.sampleCount;
    }
  };

  // Events (Maintenance / Errors)
  state.wsEvents = new WebSocket(wsBase + '/ws/events');
  state.wsEvents.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'event') {
      state.eventCount++;
      if (window.appendEvent) window.appendEvent(d, true);
    }
  };
}

function scheduleReconnect() {
  closeWS();
  let delay = Math.pow(2, reconnectAttempts) * 1000;
  if (delay > 30000) delay = 30000;
  
  reconnectAttempts++;
  console.log(`WS disconnected. Reconnecting in ${delay/1000}s...`);
  
  setTimeout(() => {
    connectWS();
  }, delay);
}

export function closeWS() {
  if (state.wsStream) {
    state.wsStream.onclose = null;
    state.wsStream.close();
    state.wsStream = null;
  }
  if (state.wsEvents) {
    state.wsEvents.onclose = null;
    state.wsEvents.close();
    state.wsEvents = null;
  }
}
