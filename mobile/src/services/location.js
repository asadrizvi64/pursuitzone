// ═══════════════════════════════════════════════════════════════
// LOCATION SERVICE
// GPS tracking + barometric altitude fusion + mock detection
// ═══════════════════════════════════════════════════════════════

import * as Location from 'expo-location';
import { Barometer } from 'expo-sensors';
import { Platform } from 'react-native';
import { getSocket } from './api';

// Sea-level pressure reference (updated at chase start from weather API)
let seaLevelPressure = 1013.25; // hPa

// Convert barometric pressure to altitude (hypsometric formula)
function pressureToAltitude(pressure, seaLevel = seaLevelPressure) {
  return 44330 * (1 - Math.pow(pressure / seaLevel, 0.1903));
}

class LocationService {
  constructor() {
    this.watchId = null;
    this.barometerSub = null;
    this.lastBaroAlt = null;
    this.lastGpsAlt = null;
    this.fusedAltitude = null;
    this.isTracking = false;
    this.chaseId = null;
    this.onLocationUpdate = null;
    this.trackingPoints = [];
  }

  /**
   * Request all necessary permissions.
   */
  async requestPermissions() {
    const { status: fg } = await Location.requestForegroundPermissionsAsync();
    if (fg !== 'granted') throw new Error('Foreground location permission required');

    // Request background for active chases
    if (Platform.OS !== 'web') {
      const { status: bg } = await Location.requestBackgroundPermissionsAsync();
      if (bg !== 'granted') {
        console.warn('[Location] Background permission denied — chase will pause if app backgrounded');
      }
    }

    return true;
  }

  /**
   * Get current position (one-shot).
   */
  async getCurrentPosition() {
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.BestForNavigation,
    });

    return {
      lat: location.coords.latitude,
      lng: location.coords.longitude,
      altitude: location.coords.altitude,
      accuracy: location.coords.accuracy,
      speed: location.coords.speed ? location.coords.speed * 3.6 : 0, // m/s → km/h
      heading: location.coords.heading,
      timestamp: location.timestamp,
    };
  }

  /**
   * Start high-frequency GPS tracking for an active chase.
   * Streams to server via WebSocket + fuses barometric altitude.
   */
  async startChaseTracking(chaseId, callback) {
    this.chaseId = chaseId;
    this.isTracking = true;
    this.onLocationUpdate = callback;
    this.trackingPoints = [];

    // Start barometer for altitude fusion
    await this.startBarometer();

    // Start GPS watch — high accuracy, ~1 second updates
    this.watchId = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,        // 1 second
        distanceInterval: 1,       // 1 meter
        mayShowUserSettingsDialog: true,
      },
      (location) => this.handleLocationUpdate(location)
    );

    // Start background task for when app is minimized
    if (Platform.OS !== 'web') {
      await this.startBackgroundTracking();
    }

    console.log(`[Location] Chase tracking started for ${chaseId.slice(0, 8)}`);
  }

  /**
   * Handle each GPS update — fuse altitude, detect mocks, stream to server.
   */
  handleLocationUpdate(location) {
    const { latitude, longitude, altitude, accuracy, speed, heading } = location.coords;

    // Fuse GPS altitude with barometric altitude
    this.lastGpsAlt = altitude;
    this.fusedAltitude = this.fuseAltitude(altitude, this.lastBaroAlt);

    // Detect mock/spoofed location
    const isMock = this.detectMockLocation(location);

    const update = {
      chaseId: this.chaseId,
      lat: latitude,
      lng: longitude,
      altitude: this.fusedAltitude,
      accuracy: accuracy,
      speed: speed ? speed * 3.6 : 0, // km/h
      heading: heading,
      altitudeSource: this.lastBaroAlt ? 'fused' : 'gps',
      isMockLocation: isMock,
      timestamp: location.timestamp,
    };

    // Track for anti-collusion
    this.trackingPoints.push(update);
    if (this.trackingPoints.length > 300) {
      this.trackingPoints = this.trackingPoints.slice(-200);
    }

    // Stream to server via WebSocket
    const socket = getSocket();
    if (socket?.connected) {
      socket.emit('gps_update', update);
    }

    // Callback to UI
    if (this.onLocationUpdate) {
      this.onLocationUpdate(update);
    }
  }

  /**
   * Fuse GPS and barometric altitude for floor-level accuracy.
   * Barometric is more precise for relative altitude (±0.3m).
   * GPS is better for absolute altitude (±10-30m).
   * We use barometric for relative changes, GPS for baseline.
   */
  fuseAltitude(gpsAlt, baroAlt) {
    if (baroAlt === null) return gpsAlt || 0;
    if (gpsAlt === null) return baroAlt;

    // Weighted fusion: barometric gets 70% weight (more precise for floor detection)
    const BARO_WEIGHT = 0.7;
    const GPS_WEIGHT = 0.3;

    return (baroAlt * BARO_WEIGHT) + (gpsAlt * GPS_WEIGHT);
  }

  /**
   * Start barometric altitude sensor.
   */
  async startBarometer() {
    const available = await Barometer.isAvailableAsync();
    if (!available) {
      console.warn('[Location] Barometer not available — using GPS altitude only');
      return;
    }

    Barometer.setUpdateInterval(500); // 500ms updates

    this.barometerSub = Barometer.addListener(({ pressure }) => {
      this.lastBaroAlt = pressureToAltitude(pressure);
    });
  }

  /**
   * Detect mock/spoofed GPS locations.
   */
  detectMockLocation(location) {
    // Android provides isMocked flag
    if (location.mocked) return true;

    // Heuristic checks
    const checks = [];

    // Check 1: Impossible speed (>300 km/h for a car)
    if (location.coords.speed && location.coords.speed * 3.6 > 300) {
      checks.push('impossible_speed');
    }

    // Check 2: Perfect accuracy (real GPS has noise, usually >3m)
    if (location.coords.accuracy !== null && location.coords.accuracy < 1) {
      checks.push('too_accurate');
    }

    // Check 3: Altitude jumps (>50m in 1 second = impossible in a car)
    if (this.trackingPoints.length > 0) {
      const last = this.trackingPoints[this.trackingPoints.length - 1];
      const altDiff = Math.abs((location.coords.altitude || 0) - (last.altitude || 0));
      const timeDiff = (location.timestamp - (last.timestamp || 0)) / 1000;
      if (timeDiff > 0 && timeDiff < 3 && altDiff > 50) {
        checks.push('altitude_teleport');
      }
    }

    // Check 4: Position teleport (>500m in 1 second)
    if (this.trackingPoints.length > 0) {
      const last = this.trackingPoints[this.trackingPoints.length - 1];
      const dist = haversineDistance(
        last.lat, last.lng,
        location.coords.latitude, location.coords.longitude
      );
      const timeDiff = (location.timestamp - (last.timestamp || 0)) / 1000;
      if (timeDiff > 0 && timeDiff < 2 && dist > 500) {
        checks.push('position_teleport');
      }
    }

    return checks.length > 0;
  }

  /**
   * Stop chase tracking.
   */
  async stopChaseTracking() {
    if (this.watchId) {
      this.watchId.remove();
      this.watchId = null;
    }
    if (this.barometerSub) {
      this.barometerSub.remove();
      this.barometerSub = null;
    }
    this.isTracking = false;
    this.chaseId = null;
    this.trackingPoints = [];

    if (Platform.OS !== 'web') {
      await Location.stopLocationUpdatesAsync('chase-background-tracking').catch(() => {});
    }

    console.log('[Location] Chase tracking stopped');
  }

  /**
   * Start background location tracking (for when app is minimized).
   */
  async startBackgroundTracking() {
    const isRegistered = await Location.hasStartedLocationUpdatesAsync('chase-background-tracking').catch(() => false);
    if (isRegistered) return;

    await Location.startLocationUpdatesAsync('chase-background-tracking', {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 2000,
      distanceInterval: 5,
      deferredUpdatesInterval: 1000,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'PursuitZone — Chase Active',
        notificationBody: 'Tracking your position for the live chase.',
        notificationColor: '#f97316',
      },
    });
  }

  /**
   * Send idle location update (when not in a chase).
   * Called every 30-60 seconds for matchmaking proximity.
   */
  async sendIdleLocation() {
    try {
      const pos = await this.getCurrentPosition();
      const socket = getSocket();
      if (socket?.connected) {
        socket.emit('idle_location', {
          lat: pos.lat,
          lng: pos.lng,
          altitude: pos.altitude,
        });
      }
      return pos;
    } catch (err) {
      console.warn('[Location] Idle update failed:', err.message);
      return null;
    }
  }

  /**
   * Calculate distance from zone center (for geofence UI).
   */
  getDistanceFromCenter(currentLat, currentLng, centerLat, centerLng) {
    return haversineDistance(currentLat, currentLng, centerLat, centerLng);
  }

  /**
   * Check if position is within zone radius.
   */
  isInZone(lat, lng, centerLat, centerLng, radiusKm) {
    const dist = haversineDistance(lat, lng, centerLat, centerLng);
    return { inZone: dist <= radiusKm * 1000, distanceM: dist, radiusM: radiusKm * 1000 };
  }

  /**
   * Get movement stats for anti-collusion UI.
   */
  getMovementStats() {
    const pts = this.trackingPoints;
    if (pts.length < 2) return { avgSpeed: 0, totalPoints: pts.length, duration: 0 };

    const speeds = pts.map(p => p.speed).filter(Boolean);
    const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
    const duration = pts.length > 1 
      ? (pts[pts.length - 1].timestamp - pts[0].timestamp) / 1000 
      : 0;

    return {
      avgSpeed: Math.round(avgSpeed),
      totalPoints: pts.length,
      duration: Math.round(duration),
    };
  }
}

// ── Haversine distance (meters) ──
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Export singleton
export const locationService = new LocationService();
export { haversineDistance };
