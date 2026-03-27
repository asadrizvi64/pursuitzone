import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useStore } from '../store';

export default function RoleSelectScreen({ navigation }) {
  const { user, setRole } = useStore();

  const selectRole = (role) => {
    setRole(role);
    if (role === 'wanted') {
      navigation.navigate('ChaseSetup');
    } else {
      navigation.navigate('BrowseChases');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.welcome}>
        {user?.display_name || 'RUNNER'}
      </Text>
      <Text style={styles.heading}>CHOOSE YOUR ROLE</Text>

      <TouchableOpacity
        style={[styles.card, styles.wantedCard]}
        onPress={() => selectRole('wanted')}
        activeOpacity={0.8}
      >
        <Text style={styles.cardEmoji}>🏎️</Text>
        <Text style={styles.cardTitle}>WANTED</Text>
        <Text style={styles.cardDesc}>
          Go rogue. Pay a fee, evade police in a shrinking zone, and collect the bounty if you escape.
        </Text>
        <View style={styles.cardStats}>
          <Text style={styles.statText}>Escapes: {user?.wanted_escapes || 0}</Text>
          <Text style={styles.statText}>Busts: {user?.wanted_busts || 0}</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.card, styles.policeCard]}
        onPress={() => selectRole('police')}
        activeOpacity={0.8}
      >
        <Text style={styles.cardEmoji}>🚔</Text>
        <Text style={styles.cardTitle}>POLICE</Text>
        <Text style={styles.cardDesc}>
          Join the pursuit. Buy a ticket, coordinate with your unit, tag the wanted, split the pool.
        </Text>
        <View style={styles.cardStats}>
          <Text style={styles.statText}>Captures: {user?.police_captures || 0}</Text>
          <Text style={styles.statText}>Misses: {user?.police_misses || 0}</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.walletBtn}
        onPress={() => navigation.navigate('Wallet')}
      >
        <Text style={styles.walletText}>WALLET</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#080808',
    paddingHorizontal: 20, paddingTop: 60,
  },
  welcome: {
    fontSize: 11, color: '#666', letterSpacing: 4, fontWeight: '600',
  },
  heading: {
    fontSize: 26, color: '#e5e5e5', fontWeight: '900',
    letterSpacing: 3, marginTop: 4, marginBottom: 30,
  },
  card: {
    padding: 24, borderWidth: 1, marginBottom: 16,
  },
  wantedCard: {
    borderColor: '#ef444433', backgroundColor: '#ef44440a',
  },
  policeCard: {
    borderColor: '#3b82f633', backgroundColor: '#3b82f60a',
  },
  cardEmoji: { fontSize: 32, marginBottom: 12 },
  cardTitle: {
    fontSize: 20, fontWeight: '900', color: '#e5e5e5',
    letterSpacing: 4, marginBottom: 8,
  },
  cardDesc: { fontSize: 13, color: '#888', lineHeight: 20 },
  cardStats: {
    flexDirection: 'row', gap: 16, marginTop: 16,
    borderTopWidth: 1, borderTopColor: '#1a1a1a', paddingTop: 12,
  },
  statText: {
    fontSize: 11, color: '#555', fontWeight: '600', letterSpacing: 1,
  },
  walletBtn: {
    marginTop: 8, alignItems: 'center', padding: 16,
    borderWidth: 1, borderColor: '#1a1a1a',
  },
  walletText: {
    fontSize: 13, color: '#f97316', fontWeight: '700', letterSpacing: 3,
  },
});
