// ═══════════════════════════════════════════════════════════════
// useChaseSocket — Hook for real-time chase event handling
// ═══════════════════════════════════════════════════════════════

import { useEffect, useRef, useCallback } from 'react';
import { getSocket } from '../services/api';
import { useStore } from '../store';
import { pushService } from '../services/pushNotifications';
import * as Haptics from 'expo-haptics';

export function useChaseSocket(chaseId, role) {
  const socketRef = useRef(null);
  const store = useStore();

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !chaseId) return;
    socketRef.current = socket;

    // Join chase room
    socket.emit('join_chase', { chaseId, role });

    // ── Target/pursuit position updates ──
    socket.on('target_position', (data) => {
      // Police receives blurred wanted position
      store.setProximity(prev => ({ ...prev, targetLat: data.lat, targetLng: data.lng, targetAlt: data.altitude }));
    });

    socket.on('pursuit_position', (data) => {
      // Wanted receives police positions
      // Store handled externally for multi-marker support
    });

    socket.on('team_position', (data) => {
      // Police sees other police (team awareness)
    });

    // ── Zone shrink ──
    socket.on('zone_shrink', (data) => {
      store.setCurrentRadius(data.newRadiusKm);
      store.setShrinkPhase(data.phase);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      pushService.showLocalNotification({
        title: `⚠️ ZONE SHRINKING — Phase ${data.phase}/${data.totalPhases}`,
        body: `Zone reduced to ${data.newRadiusKm.toFixed(1)}km. Stay inside!`,
        data: { type: 'zone_shrinking', urgency: 'high' },
        channelId: 'chase_events',
      });
    });

    // ── Geofence warnings ──
    socket.on('geofence_warning', (data) => {
      store.setGeofenceStatus(false, data.distanceFromEdge);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    });

    // ── Phase changes ──
    socket.on('phase_change', (data) => {
      store.setChasePhase(data.phase);
      if (data.phase === 'cooldown') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    });

    // ── Chase events ──
    socket.on('chase_started', (data) => {
      store.setChasePhase('heat');
      store.setTimeRemaining(data.heatDurationSec);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    });

    socket.on('chase_ended', (data) => {
      store.setChasePhase('ended');
      store.setLastResult({
        outcome: data.outcome,
        taggerId: data.taggerId,
        pool: data.pool,
      });
      Haptics.notificationAsync(
        data.outcome === 'caught' && role === 'police'
          ? Haptics.NotificationFeedbackType.Success
          : data.outcome === 'escaped' && role === 'wanted'
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Error
      );
    });

    socket.on('chase_voided', (data) => {
      store.setChasePhase('ended');
      store.setLastResult({ outcome: 'voided', reason: data.reason });
    });

    socket.on('chase_escalated', (data) => {
      store.updateChaseState({
        wanted_level: data.newLevel,
        max_police: data.newMaxPolice,
      });
      store.setChasePhase('heat');
      store.setTimeRemaining(data.newHeatDuration);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    });

    socket.on('cooldown_expired', () => {
      // Waiting for wanted decision — show UI
      store.setChasePhase('decision');
    });

    socket.on('police_disqualified', (data) => {
      store.updateChaseState({ current_police_count: data.remainingPolice });
    });

    socket.on('disqualified', (data) => {
      store.setChasePhase('disqualified');
      store.setLastResult({ outcome: 'disqualified', reason: data.reason });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    });

    // ── Tag result ──
    socket.on('tag_result', (data) => {
      if (data.valid) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    });

    socket.on('tag_failed', (data) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    });

    // ── Notifications ──
    socket.on('notification', (data) => {
      store.addNotification(data);
    });

    // Cleanup
    return () => {
      socket.off('target_position');
      socket.off('pursuit_position');
      socket.off('team_position');
      socket.off('zone_shrink');
      socket.off('geofence_warning');
      socket.off('phase_change');
      socket.off('chase_started');
      socket.off('chase_ended');
      socket.off('chase_voided');
      socket.off('chase_escalated');
      socket.off('cooldown_expired');
      socket.off('police_disqualified');
      socket.off('disqualified');
      socket.off('tag_result');
      socket.off('tag_failed');
      socket.off('notification');
    };
  }, [chaseId, role]);

  // ── Actions ──
  const attemptTag = useCallback(() => {
    socketRef.current?.emit('tag_attempt', { chaseId });
  }, [chaseId]);

  const requestReinforcement = useCallback(() => {
    socketRef.current?.emit('request_reinforcement', { chaseId });
  }, [chaseId]);

  const makeDecision = useCallback((decision) => {
    socketRef.current?.emit('wanted_decision', { chaseId, decision });
  }, [chaseId]);

  const surrender = useCallback(() => {
    socketRef.current?.emit('surrender', { chaseId });
  }, [chaseId]);

  return { attemptTag, requestReinforcement, makeDecision, surrender };
}
