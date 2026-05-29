import { state } from './state.js';
import { toast } from './ui.js';

export async function api(path) {
  try {
    const r = await fetch(state.apiBase + path);
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch(e) {
    console.error(`API Error: ${path}`, e);
    return null;
  }
}

export async function fetchStatus() {
  const d = await api('/api/status');
  if (!d) return null;
  
  // Populate state.nodes
  d.nodes.forEach(node => {
    state.nodes.set(node.node_id, node);
  });
  
  return d;
}

export async function fetchNodeHistory(nodeId) {
  const d = await api(`/api/nodes/${nodeId}/history`);
  return d;
}

export async function fetchNodeDetail(nodeId) {
  const d = await api(`/api/nodes/${nodeId}`);
  return d;
}

export async function fetchMetrics() {
  const d = await api('/api/metrics');
  return d;
}

export async function fetchDB() {
  const d = await api('/api/db');
  return d;
}

export async function fetchEvents(nodeId) {
  const d = await api(`/api/nodes/${nodeId}/events?n=30`);
  return d;
}
