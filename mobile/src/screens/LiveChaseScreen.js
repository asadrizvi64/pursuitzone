import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { useStore } from '../store';
import { useChaseSocket } from '../hooks/useChaseSocket';
import { locationService } from '../services/location';
import ChaseMap from '../components/map/ChaseMap';

export default function LiveChaseScreen({ navigation, route }) {
  const { chaseId, role } = route.params;
  const store = useStore();
  const {
    activeChase, chasePhase, timeRemaining, currentRadius,
    shrinkPhase, proximity, inZone, integrityChecks, tagEligible,
    currentPosition, setPosition, setGeofenceStatus,
  } = store;

  const { attemptTag, surrender, makeDecision } = useChaseSocket(chaseId, role);
  const [targetPositions, setTargetPositions] = useState([]);

  // Start GPS tracking
  useEffect(() => {
    locationService.startChaseTracking(chaseId, (update) => {
      setPosition({
        lat: update.lat,
        lng: update.lng,
        altitude: update.altitude,
        speed: update.speed,
        heading: update.heading,
      });

      // Client-side geofence check
      if (activeChase) {
        const check = locationService.isInZone(
          update.lat, update.lng,
          activeChase.zone_center_lat, activeChase.zone_center_lng,
          currentRadius
        );
        setGeofenceStatus(check.inZone, check.distanceM);
      }
    });

    return () => { locationService.stopChaseTracking(); };
  }, [chaseId]);

  // Countdown timer
  useEffect(() => {
    if (timeRemaining <= 0) return;
    const interval = setInterval(() => {
      store.setTimeRemaining(Math.max(0, store.timeRemaining - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [timeRemaining > 0]);

  // Navigate to results when chase ends
  useEffect(() => {
    if (chasePhase === 'ended' || chasePhase === 'disqualified') {
      setTimeout(() => navigation.replace('Results'), 1500);
    }
  }, [chasePhase]);

  const formatTime = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const onTag = () => {
    if (!tagEligible) {
      return Alert.alert('TAG BLOCKED', 'Anti-collusion checks not passed. Pursue genuinely.');
    }
    attemptTag();
  };

  const phaseColor = chasePhase === 'heat' ? '#ef4444'
    : chasePhase === 'cooldown' ? '#f97316'
    : chasePhase === 'matchmaking' ? '#3b82f6' : '#4ade80';

  return (
    <View style={styles.container}>
      {/* Map */}
      <ChaseMap
        chaseData={activeChase}
        currentPosition={currentPosition}
        targetPositions={targetPositions}
        role={role}
        currentRadius={currentRadius}
        minRadius={activeChase?.min_radius_km}
        startRadius={activeChase?.start_radius_km}
        shrinkPhase={shrinkPhase}
        totalPhases={activeChase?.shrink_phases}
        inZone={inZone}
        chaseActive={chasePhase === 'heat'}
      />

      {/* Top HUD */}
      <View style={styles.hud}>
        <View style={[styles.phaseBadge, { borderColor: phaseColor + '55' }]}>
          <Text style={[styles.phaseText, { color: phaseColor }]}>
            {(chasePhase || 'WAITING').toUpperCase()}
          </Text>
        </View>
        {timeRemaining > 0 && (
          <Text style={styles.timer}>{formatTime(timeRemaining)}</Text>
        )}
        <Text style={styles.roleTag}>
          {role === 'wanted' ? '🏎️ WANTED' : '🚔 POLICE'}
        </Text>
      </View>

      {/* Bottom action bar */}
      <View style={styles.actionBar}>
        {role === 'police' && chasePhase === 'heat' && (
          <TouchableOpacity
            style={[styles.tagBtn, !tagEligible && styles.tagBtnDisabled]}
            onPress={onTag}
          >
            <Text style={styles.tagBtnText}>TAG</Text>
            <Text style={styles.tagBtnSub}>
              {tagEligible ? 'READY' : 'NOT ELIGIBLE'}
            </Text>
          </TouchableOpacity>
        )}

        {role === 'wanted' && chasePhase === 'heat' && (
          <TouchableOpacity style={styles.surrenderBtn} onPress={surrender}>
            <Text style={styles.surrenderText}>SURRENDER</Text>
          </TouchableOpacity>
        )}

        {role === 'wanted' && chasePhase === 'decision' && (
          <View style={styles.decisionRow}>
            <TouchableOpacity
              style={styles.escalateBtn}
              onPress={() => makeDecision('escalate')}
            >
              <Text style={styles.escalateText}>ESCALATE ★</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.collectBtn}
              onPress={() => makeDecision('collect')}
            >
              <Text style={styles.collectText}>COLLECT 💰</Text>
            </TouchableOpacity>
          </View>
        )}

        {chasePhase === 'matchmaking' && (
          <View style={styles.waitingBar}>
            <Text style={styles.waitingText}>WAITING FOR POLICE...</Text>
            <Text style={styles.waitingSub}>
              {activeChase?.current_police_count || 0}/{activeChase?.min_police_required || 1} required
            </Text>
          </View>
        )}
      </View>

      {/* Proximity indicator */}
      {proximity && chasePhase === 'heat' && (
        <View style={styles.proximityBar}>
          <Text style={styles.proximityLabel}>PROXIMITY</Text>
          <Text style={styles.proximityValue}>
            {Math.round(proximity.horizontal_m || 0)}m
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#080808' },
  hud: {
    position: 'absolute', top: 50, left: 16, right: 16,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  phaseBadge: {
    paddingHorizontal: 10, paddingVertical: 5,
    backgroundColor: 'rgba(10, 10, 10, 0.9)', borderWidth: 1,
  },
  phaseText: { fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  timer: {
    fontSize: 28, fontWeight: '900', color: '#e5e5e5',
    fontVariant: ['tabular-nums'],
  },
  roleTag: {
    fontSize: 11, color: '#888', fontWeight: '700',
    backgroundColor: 'rgba(10, 10, 10, 0.9)',
    paddingHorizontal: 8, paddingVertical: 4,
  },
  actionBar: {
    position: 'absolute', bottom: 30, left: 16, right: 16,
  },
  tagBtn: {
    backgroundColor: '#ef4444', padding: 20, alignItems: 'center',
  },
  tagBtnDisabled: { backgroundColor: '#333' },
  tagBtnText: { color: '#fff', fontSize: 24, fontWeight: '900', letterSpacing: 6 },
  tagBtnSub: { color: '#ffffff88', fontSize: 10, letterSpacing: 2, marginTop: 4 },
  surrenderBtn: {
    borderWidth: 1, borderColor: '#ef444444', padding: 16, alignItems: 'center',
  },
  surrenderText: { color: '#ef4444', fontSize: 13, fontWeight: '800', letterSpacing: 3 },
  decisionRow: { flexDirection: 'row', gap: 12 },
  escalateBtn: {
    flex: 1, backgroundColor: '#ef4444', padding: 18, alignItems: 'center',
  },
  escalateText: { color: '#fff', fontWeight: '900', fontSize: 14, letterSpacing: 2 },
  collectBtn: {
    flex: 1, backgroundColor: '#4ade80', padding: 18, alignItems: 'center',
  },
  collectText: { color: '#080808', fontWeight: '900', fontSize: 14, letterSpacing: 2 },
  waitingBar: {
    backgroundColor: 'rgba(10, 10, 10, 0.9)', padding: 18,
    borderWidth: 1, borderColor: '#3b82f633', alignItems: 'center',
  },
  waitingText: { color: '#3b82f6', fontSize: 13, fontWeight: '800', letterSpacing: 3 },
  waitingSub: { color: '#555', fontSize: 11, marginTop: 4 },
  proximityBar: {
    position: 'absolute', right: 16, top: '45%',
    backgroundColor: 'rgba(10, 10, 10, 0.9)', padding: 10,
    borderWidth: 1, borderColor: '#f9731633', alignItems: 'center',
  },
  proximityLabel: { fontSize: 8, color: '#f97316', letterSpacing: 2, fontWeight: '700' },
  proximityValue: { fontSize: 20, color: '#e5e5e5', fontWeight: '900', marginTop: 2 },
});
