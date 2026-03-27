// ═══════════════════════════════════════════════════════════════
// API SERVICE — HTTP + WebSocket client
// ═══════════════════════════════════════════════════════════════

import axios from 'axios';
import { io } from 'socket.io-client';
import * as SecureStore from 'expo-secure-store';

const API_URL = process.env.EXPO_PUBLIC_API_URL
  || (__DEV__ ? 'http://10.0.5.213:4000' : 'https://api.pursuitzone.io');

// ── HTTP Client ─────────────────────────────────
const http = axios.create({ baseURL: `${API_URL}/api`, timeout: 15000 });

// Attach auth token to every request
http.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('auth_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── WebSocket ───────────────────────────────────
let socket = null;

export const connectSocket = async () => {
  const token = await SecureStore.getItemAsync('auth_token');
  if (!token) throw new Error('Not authenticated');

  socket = io(API_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });

  socket.on('connect', () => console.log('[Socket] Connected:', socket.id));
  socket.on('disconnect', (reason) => console.log('[Socket] Disconnected:', reason));
  socket.on('connect_error', (err) => console.error('[Socket] Error:', err.message));

  return socket;
};

export const getSocket = () => socket;

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

// ── Auth ────────────────────────────────────────
export const auth = {
  sendOTP: (phone) => http.post('/auth/send-otp', { phone }),
  verifyOTP: (phone, code) => http.post('/auth/verify-otp', { phone, code }),
  register: (data) => http.post('/auth/register', data),
  getMe: () => http.get('/users/me'),
  
  async saveToken(token) {
    await SecureStore.setItemAsync('auth_token', token);
  },
  async getToken() {
    return SecureStore.getItemAsync('auth_token');
  },
  async clearToken() {
    await SecureStore.deleteItemAsync('auth_token');
    disconnectSocket();
  },
};

// ── Chases ──────────────────────────────────────
export const chases = {
  getActive: (lat, lng, radiusKm = 50) => 
    http.get('/chases/active', { params: { lat, lng, radiusKm } }),
  
  getById: (id) => http.get(`/chases/${id}`),
  
  create: (wantedLevel, zoneId) => 
    http.post('/chases', { wantedLevel, zoneId }),
  
  join: (chaseId) => http.post(`/chases/${chaseId}/join`),
  
  getZones: () => http.get('/chases/zones/list'),
  
  getEconomy: (chaseId) => http.get(`/chases/${chaseId}/economy`),
};

// ── User ────────────────────────────────────────
export const user = {
  updateLocation: (lat, lng, altitude) => 
    http.put('/users/me/location', { lat, lng, altitude }),
  
  updateFCMToken: (token) => 
    http.put('/users/me/fcm-token', { token }),
  
  getTransactions: () => http.get('/users/me/transactions'),
  
  getProfile: () => http.get('/users/me'),
};

// ── Notifications ───────────────────────────────
export const notifications = {
  getUnread: () => http.get('/notifications/unread'),
  markRead: (id) => http.post(`/notifications/${id}/read`),
  markActedOn: (id) => http.post(`/notifications/${id}/acted`),
};

// ── Matchmaking ─────────────────────────────────
export const matchmaking = {
  getNearby: (lat, lng) => 
    http.get('/matchmaking/nearby', { params: { lat, lng } }),
};

// ── Wallet / Payments ───────────────────────────
export const wallet = {
  getBalance: () => http.get('/wallet/balance'),
  submitDepositProof: (data) => http.post('/wallet/deposit-proof', data),
  getDeposits: () => http.get('/wallet/deposits'),
  requestWithdrawal: (amount, method) => http.post('/wallet/withdraw', { amount, method }),
  // Admin
  getPendingDeposits: () => http.get('/wallet/admin/pending'),
  reviewDeposit: (id, decision, note) => http.post(`/wallet/admin/review/${id}`, { decision, note }),
};

export default { auth, chases, user, notifications, matchmaking, wallet };
