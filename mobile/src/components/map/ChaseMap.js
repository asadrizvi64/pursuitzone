// ═══════════════════════════════════════════════════════════════
// LIVE CHASE MAP — react-native-maps with geofence visualization
// Real streets, shrinking zone circle, player markers, proximity
// ═══════════════════════════════════════════════════════════════

import React, { useRef, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import MapView, { Marker, Circle, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { useStore } from '../../store';

// Dark map style for that NFS/Most Wanted vibe
const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#0a0a0a' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0a0a' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#333333' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1a1a1a' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#111111' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#222222' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1a1a1a' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#181818' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#050505' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#111111' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#0d0d0d' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#1a1a1a' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#0c0c0c' }] },
];

export default function ChaseMap({ 
  chaseData,
  currentPosition,
  targetPositions = [],  // Other vehicles (police sees blurred wanted, wanted sees police)
  role,
  currentRadius,
  minRadius,
  startRadius,
  shrinkPhase,
  totalPhases,
  inZone,
  chaseActive,
}) {
  const mapRef = useRef(null);
  
  const center = useMemo(() => ({
    latitude: chaseData?.zone_center_lat || chaseData?.city?.lat || 33.7104,
    longitude: chaseData?.zone_center_lng || chaseData?.city?.lng || 73.0561,
  }), [chaseData]);

  const region = useMemo(() => ({
    ...center,
    latitudeDelta: (currentRadius || 5) * 0.025,
    longitudeDelta: (currentRadius || 5) * 0.025,
  }), [center, currentRadius]);

  // Animate to show both player and zone when position changes significantly
  useEffect(() => {
    if (mapRef.current && currentPosition) {
      mapRef.current.animateToRegion({
        latitude: currentPosition.lat,
        longitude: currentPosition.lng,
        latitudeDelta: Math.max(0.01, (currentRadius || 5) * 0.015),
        longitudeDelta: Math.max(0.01, (currentRadius || 5) * 0.015),
      }, 500);
    }
  }, [currentPosition?.lat, currentPosition?.lng]);

  // Generate shrink phase circles for preview
  const shrinkCircles = useMemo(() => {
    if (!startRadius || !minRadius || !totalPhases) return [];
    const step = (startRadius - minRadius) / Math.max(1, totalPhases - 1);
    return Array.from({ length: totalPhases }, (_, i) => ({
      radius: (startRadius - step * i) * 1000, // km → meters
      phase: i,
    }));
  }, [startRadius, minRadius, totalPhases]);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={region}
        customMapStyle={DARK_MAP_STYLE}
        showsUserLocation={false} // We render custom marker
        showsMyLocationButton={false}
        showsCompass={false}
        showsScale={false}
        showsTraffic={false}
        showsBuildings={false}
        showsIndoors={false}
        showsPointsOfInterest={false}
        rotateEnabled={true}
        pitchEnabled={false}
        mapPadding={{ top: 0, right: 0, bottom: 0, left: 0 }}
      >
        {/* ── GEOFENCE: Minimum zone (final shrink, ghost ring) ── */}
        {minRadius > 0 && (
          <Circle
            center={center}
            radius={minRadius * 1000}
            strokeColor="rgba(239, 68, 68, 0.15)"
            strokeWidth={1}
            fillColor="transparent"
            lineDashPattern={[5, 10]}
          />
        )}

        {/* ── GEOFENCE: Next shrink preview ── */}
        {shrinkPhase < totalPhases - 1 && shrinkCircles[shrinkPhase + 1] && (
          <Circle
            center={center}
            radius={shrinkCircles[shrinkPhase + 1].radius}
            strokeColor="rgba(249, 115, 22, 0.2)"
            strokeWidth={1}
            fillColor="transparent"
            lineDashPattern={[8, 6]}
          />
        )}

        {/* ── GEOFENCE: Current active zone boundary ── */}
        <Circle
          center={center}
          radius={(currentRadius || startRadius || 5) * 1000}
          strokeColor={inZone ? 'rgba(249, 115, 22, 0.6)' : 'rgba(239, 68, 68, 0.8)'}
          strokeWidth={2}
          fillColor={inZone ? 'rgba(249, 115, 22, 0.03)' : 'rgba(239, 68, 68, 0.05)'}
          lineDashPattern={[10, 5]}
        />

        {/* ── DANGER ZONE: Red tint outside current boundary ── */}
        <Circle
          center={center}
          radius={(currentRadius || startRadius || 5) * 1000 * 1.5}
          strokeColor="transparent"
          strokeWidth={0}
          fillColor="rgba(239, 68, 68, 0.02)"
        />

        {/* ── PLAYER MARKER ── */}
        {currentPosition && (
          <Marker
            coordinate={{
              latitude: currentPosition.lat,
              longitude: currentPosition.lng,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={styles.playerMarkerContainer}>
              {/* Pulse ring */}
              <View style={[
                styles.pulseRing,
                { borderColor: role === 'wanted' ? '#ef4444' : '#3b82f6' },
              ]} />
              {/* Core dot */}
              <View style={[
                styles.playerDot,
                { backgroundColor: role === 'wanted' ? '#ef4444' : '#3b82f6' },
              ]}>
                <Text style={styles.playerDotText}>
                  {role === 'wanted' ? '🏎️' : '🚔'}
                </Text>
              </View>
              {/* Speed indicator */}
              {currentPosition.speed > 0 && (
                <View style={styles.speedBadge}>
                  <Text style={styles.speedText}>
                    {Math.round(currentPosition.speed)}
                  </Text>
                </View>
              )}
            </View>
          </Marker>
        )}

        {/* ── TARGET / OTHER VEHICLE MARKERS ── */}
        {targetPositions.map((target, idx) => (
          <Marker
            key={target.userId || idx}
            coordinate={{
              latitude: target.lat,
              longitude: target.lng,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={styles.targetMarkerContainer}>
              <View style={[
                styles.targetDot,
                { 
                  backgroundColor: role === 'wanted' ? '#3b82f6' : '#ef4444',
                  opacity: target.blurred ? 0.5 : 0.8,
                },
              ]}>
                <Text style={styles.targetDotText}>
                  {role === 'wanted' ? '🚔' : '🎯'}
                </Text>
              </View>
              {target.blurred && (
                <View style={[styles.blurRing, { borderColor: role === 'wanted' ? '#3b82f640' : '#ef444440' }]} />
              )}
            </View>
          </Marker>
        ))}

        {/* ── ZONE CENTER MARKER ── */}
        <Marker coordinate={center} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
          <View style={styles.centerMarker}>
            <View style={styles.centerCrosshair} />
          </View>
        </Marker>
      </MapView>

      {/* ── MAP OVERLAYS ── */}
      {/* Top-left: Zone info */}
      <View style={styles.zoneInfoOverlay}>
        <View style={[styles.badge, { borderColor: '#f9731633' }]}>
          <Text style={[styles.badgeText, { color: '#f97316' }]}>
            ZONE {(shrinkPhase || 0) + 1}/{totalPhases || 1}
          </Text>
        </View>
        <View style={[styles.badge, { borderColor: '#f9731633' }]}>
          <Text style={[styles.badgeText, { color: '#f97316' }]}>
            ◎ {(currentRadius || 0).toFixed(1)} KM
          </Text>
        </View>
      </View>

      {/* Top-right: Live indicator */}
      {chaseActive && (
        <View style={styles.liveIndicator}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
      )}

      {/* Bottom: Geofence status bar */}
      <View style={[
        styles.geofenceBar,
        { 
          backgroundColor: inZone ? 'rgba(74, 222, 128, 0.08)' : 'rgba(239, 68, 68, 0.15)',
          borderColor: inZone ? '#4ade8033' : '#ef444455',
        },
      ]}>
        <View style={[styles.geofenceDot, { backgroundColor: inZone ? '#4ade80' : '#ef4444' }]} />
        <Text style={[styles.geofenceText, { color: inZone ? '#4ade80' : '#ef4444' }]}>
          {inZone ? 'INSIDE ZONE' : '⚠ LEAVING ZONE — RETURN IMMEDIATELY'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, position: 'relative' },
  map: { flex: 1 },

  // Player marker
  playerMarkerContainer: { alignItems: 'center', justifyContent: 'center', width: 60, height: 60 },
  pulseRing: {
    position: 'absolute', width: 50, height: 50, borderRadius: 25,
    borderWidth: 2, opacity: 0.4,
  },
  playerDot: {
    width: 32, height: 32, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5, shadowRadius: 4, elevation: 5,
  },
  playerDotText: { fontSize: 16 },
  speedBadge: {
    position: 'absolute', bottom: -2, right: 0,
    backgroundColor: '#0a0a0a', borderWidth: 1, borderColor: '#333',
    paddingHorizontal: 4, paddingVertical: 1,
  },
  speedText: { fontSize: 8, color: '#f97316', fontWeight: '800', fontFamily: 'monospace' },

  // Target markers
  targetMarkerContainer: { alignItems: 'center', justifyContent: 'center', width: 40, height: 40 },
  targetDot: {
    width: 24, height: 24, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center',
  },
  targetDotText: { fontSize: 12 },
  blurRing: {
    position: 'absolute', width: 36, height: 36, borderRadius: 18,
    borderWidth: 2, borderStyle: 'dashed',
  },

  // Center marker
  centerMarker: { width: 20, height: 20, justifyContent: 'center', alignItems: 'center' },
  centerCrosshair: {
    width: 10, height: 10, borderRadius: 5,
    borderWidth: 1, borderColor: '#f9731644',
  },

  // Overlays
  zoneInfoOverlay: {
    position: 'absolute', top: 10, left: 10,
    flexDirection: 'row', gap: 4,
  },
  badge: {
    paddingHorizontal: 6, paddingVertical: 2,
    backgroundColor: 'rgba(10, 10, 10, 0.8)',
    borderWidth: 1,
  },
  badgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },

  liveIndicator: {
    position: 'absolute', top: 10, right: 10,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(10, 10, 10, 0.8)',
    paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1, borderColor: '#ef444433',
  },
  liveDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: '#ef4444',
  },
  liveText: { fontSize: 9, fontWeight: '700', color: '#ef4444', letterSpacing: 2 },

  geofenceBar: {
    position: 'absolute', bottom: 10, left: 10, right: 10,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1,
  },
  geofenceDot: { width: 6, height: 6, borderRadius: 3 },
  geofenceText: { fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },
});
