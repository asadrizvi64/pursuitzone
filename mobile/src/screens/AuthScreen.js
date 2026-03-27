import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { auth } from '../services/api';
import { connectSocket } from '../services/api';
import { useStore } from '../store';

export default function AuthScreen() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone'); // 'phone' | 'otp'
  const [loading, setLoading] = useState(false);
  const { setUser } = useStore();

  const sendOTP = async () => {
    if (!phone || phone.length < 10) return Alert.alert('Error', 'Enter a valid phone number');
    setLoading(true);
    try {
      await auth.sendOTP(phone);
      setStep('otp');
    } catch (err) {
      Alert.alert('Error', err.response?.data?.error || 'Failed to send OTP');
    }
    setLoading(false);
  };

  const verifyOTP = async () => {
    if (!code || code.length !== 6) return Alert.alert('Error', 'Enter the 6-digit code');
    setLoading(true);
    try {
      const { data } = await auth.verifyOTP(phone, code);
      await auth.saveToken(data.token);
      setUser(data.user);
      try { await connectSocket(); } catch (e) { /* non-fatal */ }
    } catch (err) {
      Alert.alert('Error', err.response?.data?.error || 'Invalid OTP');
    }
    setLoading(false);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.logo}>PURSUIT ZONE</Text>
      <Text style={styles.heading}>
        {step === 'phone' ? 'ENTER YOUR NUMBER' : 'VERIFY CODE'}
      </Text>
      <Text style={styles.desc}>
        {step === 'phone'
          ? 'We\'ll send a 6-digit code to verify your identity.'
          : `Code sent to ${phone}. Check your messages.`}
      </Text>

      {step === 'phone' ? (
        <TextInput
          style={styles.input}
          placeholder="+1 (555) 000-0000"
          placeholderTextColor="#444"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoFocus
        />
      ) : (
        <TextInput
          style={[styles.input, styles.codeInput]}
          placeholder="000000"
          placeholderTextColor="#444"
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          maxLength={6}
          autoFocus
        />
      )}

      <TouchableOpacity
        style={[styles.btn, loading && styles.btnDisabled]}
        onPress={step === 'phone' ? sendOTP : verifyOTP}
        disabled={loading}
      >
        <Text style={styles.btnText}>
          {loading ? 'PLEASE WAIT...' : step === 'phone' ? 'SEND CODE' : 'VERIFY & ENTER'}
        </Text>
      </TouchableOpacity>

      {step === 'otp' && (
        <TouchableOpacity onPress={() => setStep('phone')} style={styles.backBtn}>
          <Text style={styles.backText}>Change number</Text>
        </TouchableOpacity>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#080808',
    justifyContent: 'center', paddingHorizontal: 32,
  },
  logo: {
    fontSize: 14, color: '#f97316', letterSpacing: 6,
    fontWeight: '800', marginBottom: 40,
  },
  heading: {
    fontSize: 22, color: '#e5e5e5', fontWeight: '800',
    letterSpacing: 2, marginBottom: 8,
  },
  desc: { fontSize: 13, color: '#666', marginBottom: 28, lineHeight: 20 },
  input: {
    backgroundColor: '#111', borderWidth: 1, borderColor: '#222',
    color: '#e5e5e5', fontSize: 18, padding: 16,
    fontWeight: '600', letterSpacing: 1,
  },
  codeInput: { fontSize: 28, letterSpacing: 12, textAlign: 'center' },
  btn: {
    backgroundColor: '#f97316', padding: 16, marginTop: 20,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#080808', fontWeight: '800', fontSize: 14, letterSpacing: 2 },
  backBtn: { marginTop: 16, alignItems: 'center' },
  backText: { color: '#666', fontSize: 13 },
});
