// ═══════════════════════════════════════════════════════════════
// ZUSTAND STORE — Global app state
// ═══════════════════════════════════════════════════════════════

import { create } from 'zustand';

export const useStore = create((set, get) => ({
  // ── Auth ──
  user: null,
  isAuthenticated: false,
  setUser: (user) => set({ user, isAuthenticated: !!user }),
  logout: () => set({ user: null, isAuthenticated: false }),

  // ── Role ──
  currentRole: null, // 'wanted' | 'police'
  setRole: (role) => set({ currentRole: role }),

  // ── Location ──
  currentPosition: null,
  setPosition: (pos) => set({ currentPosition: pos }),

  // ── Active Chase ──
  activeChase: null,
  chasePhase: null,       // 'matchmaking' | 'countdown' | 'heat' | 'cooldown' | 'ended'
  timeRemaining: 0,
  currentRadius: 0,
  shrinkPhase: 0,

  setActiveChase: (chase) => set({
    activeChase: chase,
    chasePhase: chase?.status || 'matchmaking',
    currentRadius: chase?.current_radius_km || chase?.start_radius_km || 0,
    shrinkPhase: chase?.current_shrink_phase || 0,
  }),

  updateChaseState: (updates) => set((state) => ({
    ...updates,
    activeChase: state.activeChase ? { ...state.activeChase, ...updates } : null,
  })),

  setTimeRemaining: (t) => set({ timeRemaining: t }),
  setChasePhase: (phase) => set({ chasePhase: phase }),
  setCurrentRadius: (r) => set({ currentRadius: r }),
  setShrinkPhase: (p) => set({ shrinkPhase: p }),

  clearChase: () => set({
    activeChase: null, chasePhase: null, timeRemaining: 0,
    currentRadius: 0, shrinkPhase: 0, proximity: null,
  }),

  // ── Proximity (to target / nearest pursuit) ──
  proximity: null,        // { horizontal_m, vertical_m, speed, inTagRange }
  setProximity: (p) => set({ proximity: p }),

  // ── Anti-collusion checks ──
  integrityChecks: {
    startDistance: { value: 0, pass: false },
    approachSpeed: { value: 0, pass: false },
    sustainedPursuit: { value: 0, pass: false },
    altitudeMatch: { value: 0, pass: false },
    gpsIntegrity: { value: 0, pass: false },
  },
  tagEligible: false,

  updateIntegrity: (checks) => set({
    integrityChecks: checks,
    tagEligible: Object.values(checks).every(c => c.pass),
  }),

  // ── Geofence ──
  inZone: true,
  distanceFromEdge: 0,
  setGeofenceStatus: (inZone, distFromEdge) => set({ inZone, distanceFromEdge: distFromEdge }),

  // ── Notifications ──
  notifications: [],
  unreadCount: 0,

  addNotification: (notif) => set((state) => ({
    notifications: [notif, ...state.notifications].slice(0, 50),
    unreadCount: state.unreadCount + 1,
  })),

  dismissNotification: (id) => set((state) => ({
    notifications: state.notifications.filter(n => n.id !== id),
  })),

  clearNotifications: () => set({ notifications: [], unreadCount: 0 }),

  // ── Chase Results ──
  lastResult: null,
  setLastResult: (result) => set({ lastResult: result }),

  // ── Available Chases (for browse screen) ──
  availableChases: [],
  setAvailableChases: (chases) => set({ availableChases: chases }),

  // ── Chase Zones ──
  zones: [],
  setZones: (zones) => set({ zones }),

  // ── Economy ──
  currentPool: null,
  setCurrentPool: (pool) => set({ currentPool: pool }),
}));
