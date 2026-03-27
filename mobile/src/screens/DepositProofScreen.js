import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView,
  StyleSheet, Alert, ActivityIndicator, Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { wallet } from '../services/api';

const PAYMENT_METHODS = [
  { id: 'jazzcash', name: 'JazzCash', color: '#e60000' },
  { id: 'easypaisa', name: 'EasyPaisa', color: '#4caf50' },
  { id: 'bank_transfer', name: 'Bank Transfer', color: '#2196f3' },
  { id: 'other', name: 'Other', color: '#888' },
];

const PRESET_AMOUNTS = [500, 1000, 2000, 5000, 10000]; // in cents ($5, $10, $20, $50, $100)

export default function DepositProofScreen({ navigation }) {
  const [method, setMethod] = useState(null);
  const [amount, setAmount] = useState('');
  const [amountCents, setAmountCents] = useState(0);
  const [senderAccount, setSenderAccount] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [screenshot, setScreenshot] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to upload payment proof.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      base64: true,
      allowsEditing: true,
    });

    if (!result.canceled && result.assets[0]) {
      setScreenshot(result.assets[0]);
    }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow camera access to take payment proof photo.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.7,
      base64: true,
      allowsEditing: true,
    });

    if (!result.canceled && result.assets[0]) {
      setScreenshot(result.assets[0]);
    }
  };

  const setPresetAmount = (cents) => {
    setAmountCents(cents);
    setAmount((cents / 100).toFixed(0));
  };

  const handleAmountChange = (text) => {
    setAmount(text);
    const num = parseFloat(text);
    setAmountCents(isNaN(num) ? 0 : Math.round(num * 100));
  };

  const submit = async () => {
    if (!method) return Alert.alert('Select payment method');
    if (amountCents < 100) return Alert.alert('Enter amount', 'Minimum deposit is $1.00');
    if (!screenshot?.base64) return Alert.alert('Upload screenshot', 'Take or select a screenshot of your payment proof.');

    setSubmitting(true);
    try {
      const { data } = await wallet.submitDepositProof({
        amount: amountCents,
        paymentMethod: method,
        senderAccount: senderAccount || undefined,
        referenceNumber: referenceNumber || undefined,
        screenshotBase64: screenshot.base64,
      });

      Alert.alert(
        'Proof Submitted',
        `Your deposit of $${(amountCents / 100).toFixed(2)} is pending admin approval. You'll be credited once verified.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (err) {
      Alert.alert('Error', err.response?.data?.error || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.back}>← BACK</Text>
      </TouchableOpacity>

      <Text style={styles.title}>DEPOSIT FUNDS</Text>
      <Text style={styles.subtitle}>
        Transfer money externally, then upload proof
      </Text>

      {/* Step 1: Payment Method */}
      <Text style={styles.stepLabel}>1. PAYMENT METHOD</Text>
      <View style={styles.methodRow}>
        {PAYMENT_METHODS.map((m) => (
          <TouchableOpacity
            key={m.id}
            style={[
              styles.methodCard,
              method === m.id && { borderColor: m.color, backgroundColor: m.color + '15' },
            ]}
            onPress={() => setMethod(m.id)}
          >
            <Text style={[styles.methodText, method === m.id && { color: m.color }]}>
              {m.name}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Step 2: Amount */}
      <Text style={styles.stepLabel}>2. AMOUNT TRANSFERRED</Text>
      <View style={styles.presetRow}>
        {PRESET_AMOUNTS.map((cents) => (
          <TouchableOpacity
            key={cents}
            style={[styles.presetBtn, amountCents === cents && styles.presetActive]}
            onPress={() => setPresetAmount(cents)}
          >
            <Text style={[styles.presetText, amountCents === cents && styles.presetTextActive]}>
              ${cents / 100}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.inputRow}>
        <Text style={styles.dollarSign}>$</Text>
        <TextInput
          style={styles.amountInput}
          value={amount}
          onChangeText={handleAmountChange}
          placeholder="Custom amount"
          placeholderTextColor="#444"
          keyboardType="numeric"
        />
      </View>

      {/* Step 3: Optional details */}
      <Text style={styles.stepLabel}>3. DETAILS (OPTIONAL)</Text>
      <TextInput
        style={styles.textInput}
        value={senderAccount}
        onChangeText={setSenderAccount}
        placeholder="Your account / phone number"
        placeholderTextColor="#444"
      />
      <TextInput
        style={styles.textInput}
        value={referenceNumber}
        onChangeText={setReferenceNumber}
        placeholder="Transaction reference / ID"
        placeholderTextColor="#444"
      />

      {/* Step 4: Screenshot */}
      <Text style={styles.stepLabel}>4. UPLOAD PROOF SCREENSHOT</Text>
      {screenshot ? (
        <View style={styles.screenshotContainer}>
          <Image source={{ uri: screenshot.uri }} style={styles.screenshotImage} />
          <TouchableOpacity style={styles.changeBtn} onPress={pickImage}>
            <Text style={styles.changeBtnText}>CHANGE</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.uploadRow}>
          <TouchableOpacity style={styles.uploadBtn} onPress={pickImage}>
            <Text style={styles.uploadIcon}>🖼</Text>
            <Text style={styles.uploadText}>Gallery</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.uploadBtn} onPress={takePhoto}>
            <Text style={styles.uploadIcon}>📷</Text>
            <Text style={styles.uploadText}>Camera</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Submit */}
      <TouchableOpacity
        style={[styles.submitBtn, submitting && styles.submitDisabled]}
        onPress={submit}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#080808" />
        ) : (
          <Text style={styles.submitText}>
            SUBMIT PROOF — ${amountCents > 0 ? (amountCents / 100).toFixed(2) : '0.00'}
          </Text>
        )}
      </TouchableOpacity>

      <Text style={styles.note}>
        Your balance will be credited after admin verifies the payment. This usually takes a few minutes.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#080808' },
  content: { paddingHorizontal: 20, paddingTop: 50, paddingBottom: 40 },
  back: { fontSize: 13, color: '#666', fontWeight: '600', marginBottom: 16 },
  title: { fontSize: 22, color: '#e5e5e5', fontWeight: '900', letterSpacing: 2 },
  subtitle: { fontSize: 13, color: '#666', marginTop: 4, marginBottom: 28 },

  stepLabel: {
    fontSize: 10, color: '#f97316', fontWeight: '700',
    letterSpacing: 3, marginBottom: 10, marginTop: 20,
  },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  methodCard: {
    paddingVertical: 10, paddingHorizontal: 16,
    borderWidth: 1, borderColor: '#222', backgroundColor: '#0a0a0a',
  },
  methodText: { fontSize: 13, color: '#888', fontWeight: '700' },

  presetRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  presetBtn: {
    paddingVertical: 8, paddingHorizontal: 14,
    borderWidth: 1, borderColor: '#222', backgroundColor: '#0a0a0a',
  },
  presetActive: { borderColor: '#4ade80', backgroundColor: '#4ade8015' },
  presetText: { fontSize: 13, color: '#888', fontWeight: '700' },
  presetTextActive: { color: '#4ade80' },

  inputRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  dollarSign: { fontSize: 20, color: '#4ade80', fontWeight: '800', marginRight: 6 },
  amountInput: {
    flex: 1, fontSize: 18, color: '#e5e5e5', fontWeight: '700',
    borderBottomWidth: 1, borderBottomColor: '#222', paddingVertical: 8,
  },

  textInput: {
    fontSize: 14, color: '#e5e5e5', borderBottomWidth: 1, borderBottomColor: '#222',
    paddingVertical: 10, marginBottom: 8,
  },

  uploadRow: { flexDirection: 'row', gap: 12 },
  uploadBtn: {
    flex: 1, padding: 24, borderWidth: 1, borderColor: '#222',
    borderStyle: 'dashed', alignItems: 'center', backgroundColor: '#0a0a0a',
  },
  uploadIcon: { fontSize: 28, marginBottom: 6 },
  uploadText: { fontSize: 12, color: '#888', fontWeight: '600' },

  screenshotContainer: { position: 'relative' },
  screenshotImage: {
    width: '100%', height: 250, resizeMode: 'contain',
    borderWidth: 1, borderColor: '#222',
  },
  changeBtn: {
    position: 'absolute', top: 8, right: 8,
    backgroundColor: '#080808cc', paddingHorizontal: 10, paddingVertical: 4,
  },
  changeBtnText: { color: '#f97316', fontSize: 11, fontWeight: '700' },

  submitBtn: {
    backgroundColor: '#4ade80', padding: 16, alignItems: 'center', marginTop: 28,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: '#080808', fontSize: 14, fontWeight: '900', letterSpacing: 2 },

  note: { fontSize: 11, color: '#444', textAlign: 'center', marginTop: 12 },
});
