import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useStore } from '../store';

export default function ResultsScreen({ navigation }) {
  const { lastResult, currentRole, clearChase, user } = useStore();

  const outcome = lastResult?.outcome || 'unknown';
  const isWin =
    (outcome === 'escaped' && currentRole === 'wanted') ||
    (outcome === 'caught' && currentRole === 'police');

  const pool = lastResult?.pool || {};

  const goHome = () => {
    clearChase();
    navigation.replace('RoleSelect');
  };

  return (
    <View style={styles.container}>
      {/* Outcome header */}
      <Text style={styles.outcomeEmoji}>
        {outcome === 'escaped' ? '🏎️💨' : outcome === 'caught' ? '🚔🔒' :
         outcome === 'voided' ? '⚠️' : outcome === 'surrendered' ? '🏳️' : '❓'}
      </Text>
      <Text style={[styles.outcomeText, { color: isWin ? '#4ade80' : '#ef4444' }]}>
        {outcome === 'escaped' && currentRole === 'wanted' ? 'YOU ESCAPED!'
          : outcome === 'escaped' && currentRole === 'police' ? 'TARGET ESCAPED'
          : outcome === 'caught' && currentRole === 'police' ? 'TARGET CAUGHT!'
          : outcome === 'caught' && currentRole === 'wanted' ? 'YOU GOT BUSTED'
          : outcome === 'voided' ? 'CHASE VOIDED'
          : outcome === 'surrendered' ? 'SURRENDERED'
          : outcome === 'disqualified' ? 'DISQUALIFIED'
          : outcome.toUpperCase()}
      </Text>

      {lastResult?.reason && (
        <Text style={styles.reason}>{lastResult.reason}</Text>
      )}

      {/* Earnings breakdown */}
      <View style={styles.earningsCard}>
        <Text style={styles.earningsTitle}>CHASE SETTLEMENT</Text>

        {pool.totalPool > 0 && (
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Total Pool</Text>
            <Text style={styles.rowValue}>${(pool.totalPool / 100).toFixed(2)}</Text>
          </View>
        )}
        {pool.platformFee > 0 && (
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Platform Fee (15%)</Text>
            <Text style={[styles.rowValue, { color: '#ef4444' }]}>
              -${(pool.platformFee / 100).toFixed(2)}
            </Text>
          </View>
        )}

        <View style={styles.divider} />

        <View style={styles.row}>
          <Text style={[styles.rowLabel, { color: '#e5e5e5', fontWeight: '800' }]}>
            YOUR EARNINGS
          </Text>
          <Text style={[styles.rowValue, { color: '#4ade80', fontSize: 22 }]}>
            ${((pool.yourEarnings || 0) / 100).toFixed(2)}
          </Text>
        </View>
      </View>

      {/* Stats */}
      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{pool.duration || '--'}s</Text>
          <Text style={styles.statLabel}>DURATION</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{pool.trackingPoints || '--'}</Text>
          <Text style={styles.statLabel}>GPS POINTS</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{pool.policeCount || '--'}</Text>
          <Text style={styles.statLabel}>POLICE</Text>
        </View>
      </View>

      {/* Actions */}
      <TouchableOpacity style={styles.homeBtn} onPress={goHome}>
        <Text style={styles.homeBtnText}>BACK TO BASE</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.replayBtn}
        onPress={() => {
          clearChase();
          navigation.replace(currentRole === 'wanted' ? 'ChaseSetup' : 'BrowseChases');
        }}
      >
        <Text style={styles.replayText}>PLAY AGAIN</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#080808',
    paddingHorizontal: 24, justifyContent: 'center', alignItems: 'center',
  },
  outcomeEmoji: { fontSize: 56, marginBottom: 16 },
  outcomeText: {
    fontSize: 28, fontWeight: '900', letterSpacing: 4, marginBottom: 8,
  },
  reason: { fontSize: 13, color: '#666', marginBottom: 28 },
  earningsCard: {
    width: '100%', padding: 20,
    borderWidth: 1, borderColor: '#1a1a1a', backgroundColor: '#0a0a0a',
    marginTop: 20, marginBottom: 24,
  },
  earningsTitle: {
    fontSize: 11, color: '#666', fontWeight: '700',
    letterSpacing: 3, marginBottom: 16,
  },
  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 10,
  },
  rowLabel: { fontSize: 13, color: '#888' },
  rowValue: { fontSize: 15, color: '#e5e5e5', fontWeight: '700' },
  divider: {
    height: 1, backgroundColor: '#1a1a1a', marginVertical: 10,
  },
  statsRow: {
    flexDirection: 'row', gap: 20, marginBottom: 32,
  },
  stat: { alignItems: 'center' },
  statValue: { fontSize: 18, color: '#e5e5e5', fontWeight: '800' },
  statLabel: { fontSize: 9, color: '#555', letterSpacing: 2, marginTop: 4 },
  homeBtn: {
    width: '100%', backgroundColor: '#f97316',
    padding: 16, alignItems: 'center',
  },
  homeBtnText: {
    color: '#080808', fontWeight: '900', fontSize: 14, letterSpacing: 3,
  },
  replayBtn: {
    width: '100%', padding: 16, alignItems: 'center',
    marginTop: 10, borderWidth: 1, borderColor: '#222',
  },
  replayText: { color: '#888', fontWeight: '700', fontSize: 13, letterSpacing: 2 },
});
