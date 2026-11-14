// Shared integer-only calculation module (micro-USDT = 1e-6, santim = 1e-2 ETB).
// Zero floating-point arithmetic is used anywhere in this module.

export const MICRO_PER_USDT = 1000000;
export const SANTIM_PER_ETB = 100;

const MICRO_PER_USDT_BIG = 1000000n;
const CENT_USDT_IN_MICRO = 10000n; // 0.01 USDT = 10,000 micro-USDT

function parseDecimalToScaledInt(input, scaleDigits, label) {
  if (typeof input === 'bigint') {
    if (input < 0n) throw new Error(`${label} must be non-negative`);
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`${label} must be a valid non-negative number`);
    }
    input = String(input);
  }
  if (typeof input !== 'string') {
    throw new Error(`${label} must be a string, number, or integer`);
  }
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`${label} has invalid decimal format`);
  }
  const parts = trimmed.split('.');
  const wholeStr = parts[0];
  const fracStr = parts[1] || '';
  if (fracStr.length > scaleDigits) {
    throw new Error(`${label} cannot have more than ${scaleDigits} decimal places`);
  }
  const paddedFrac = fracStr.padEnd(scaleDigits, '0');
  return BigInt(wholeStr + paddedFrac);
}

export function parseUsdtToMicro(input) {
  return parseDecimalToScaledInt(input, 6, 'USDT amount');
}

export function parseEtbToSantim(input) {
  return parseDecimalToScaledInt(input, 2, 'ETB amount');
}

function formatScaledInt(valueBigInt, scaleDigits, minDecimals) {
  const v = typeof valueBigInt === 'bigint' ? valueBigInt : BigInt(valueBigInt);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  const str = abs.toString().padStart(scaleDigits + 1, '0');
  const intPart = str.slice(0, str.length - scaleDigits);
  let fracPart = str.slice(str.length - scaleDigits);

  if (typeof minDecimals === 'number' && minDecimals >= 0 && minDecimals < scaleDigits) {
    const trimmedFrac = fracPart.replace(/0+$/, '');
    fracPart = trimmedFrac.length < minDecimals ? trimmedFrac.padEnd(minDecimals, '0') : trimmedFrac;
  }
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

export function formatMicroUsdt(micro, minDecimals = 2) {
  return formatScaledInt(micro, 6, minDecimals);
}

export function formatSantim(santim) {
  return formatScaledInt(santim, 2, 2);
}

function roundHalfUpDiv(numerator, denominator) {
  if (denominator <= 0n) throw new Error('Denominator must be positive');
  if (numerator < 0n) throw new Error('Numerator must be non-negative');
  return (numerator + denominator / 2n) / denominator;
}

export function calculateCommissionMicro(grossMicro, commissionPercent) {
  const gross = typeof grossMicro === 'bigint' ? grossMicro : BigInt(grossMicro);
  if (gross < 0n) throw new Error('grossMicro must be non-negative');
  const pctNum = Number(commissionPercent);
  if (!Number.isInteger(pctNum) || pctNum < 0 || pctNum > 100) {
    throw new Error('commissionPercent must be an integer between 0 and 100');
  }
  // fee = round_half_up(gross * commissionPercent / 100) to 2 decimals (0.01 USDT = 10,000 micro-USDT)
  const divisor = 100n * CENT_USDT_IN_MICRO; // 1,000,000n
  const feeCents = roundHalfUpDiv(gross * BigInt(pctNum), divisor);
  return feeCents * CENT_USDT_IN_MICRO;
}

export function calculateEtbTotalSantim(grossMicro, priceSantim) {
  const gross = typeof grossMicro === 'bigint' ? grossMicro : BigInt(grossMicro);
  const price = typeof priceSantim === 'bigint' ? priceSantim : BigInt(priceSantim);
  if (gross < 0n || price < 0n) throw new Error('Amounts must be non-negative');
  return roundHalfUpDiv(gross * price, MICRO_PER_USDT_BIG);
}

export function calculateOrder(params) {
  if (!params) throw new Error('Parameters required');
  const grossMicro =
    params.grossMicro !== undefined ? BigInt(params.grossMicro) : parseUsdtToMicro(params.usdtInput);
  const priceSantim =
    params.priceSantim !== undefined ? BigInt(params.priceSantim) : parseEtbToSantim(params.priceEtbInput);
  const commissionPercent = params.commissionPercent !== undefined ? Number(params.commissionPercent) : 3;

  if (grossMicro <= 0n) throw new Error('USDT amount must be greater than 0');
  if (priceSantim <= 0n) throw new Error('Price must be greater than 0');

  let feeMicro = calculateCommissionMicro(grossMicro, commissionPercent);
  if (feeMicro > grossMicro) {
    feeMicro = grossMicro;
  }
  const netMicro = grossMicro - feeMicro;
  const etbTotalSantim = calculateEtbTotalSantim(grossMicro, priceSantim);

  return {
    grossMicro: Number(grossMicro),
    feeMicro: Number(feeMicro),
    netMicro: Number(netMicro),
    priceSantim: Number(priceSantim),
    etbTotalSantim: Number(etbTotalSantim),
    commissionPercent,
    grossMicroStr: grossMicro.toString(),
    feeMicroStr: feeMicro.toString(),
    netMicroStr: netMicro.toString(),
    priceSantimStr: priceSantim.toString(),
    etbTotalSantimStr: etbTotalSantim.toString(),
    grossUsdt: formatMicroUsdt(grossMicro, 2),
    feeUsdt: formatMicroUsdt(feeMicro, 2),
    netUsdt: formatMicroUsdt(netMicro, 2),
    priceEtb: formatSantim(priceSantim),
    etbTotal: formatSantim(etbTotalSantim),
  };
}

export function isPriceWithinGuard(priceSantimInput, referenceSantimInput, maxDeviationPercent = 10) {
  const price = typeof priceSantimInput === 'bigint' ? priceSantimInput : BigInt(priceSantimInput);
  const ref = typeof referenceSantimInput === 'bigint' ? referenceSantimInput : BigInt(referenceSantimInput);
  const dev = typeof maxDeviationPercent === 'number' ? maxDeviationPercent : 10;
  if (price <= 0n || ref <= 0n) return false;
  const minAllowedScaled = ref * BigInt(100 - dev);
  const maxAllowedScaled = ref * BigInt(100 + dev);
  const priceScaled = price * 100n;
  return priceScaled >= minAllowedScaled && priceScaled <= maxAllowedScaled;
}

export function getPriceGuardBounds(referenceSantimInput, maxDeviationPercent = 10) {
  const ref = typeof referenceSantimInput === 'bigint' ? referenceSantimInput : BigInt(referenceSantimInput);
  const dev = typeof maxDeviationPercent === 'number' ? maxDeviationPercent : 10;
  const minSantim = (ref * BigInt(100 - dev) + 99n) / 100n;
  const maxSantim = (ref * BigInt(100 + dev)) / 100n;
  return {
    minSantim: Number(minSantim),
    maxSantim: Number(maxSantim),
    minEtb: formatSantim(minSantim),
    maxEtb: formatSantim(maxSantim),
  };
}

const P2PCalc = {
  MICRO_PER_USDT,
  SANTIM_PER_ETB,
  parseUsdtToMicro,
  parseEtbToSantim,
  formatMicroUsdt,
  formatSantim,
  calculateCommissionMicro,
  calculateEtbTotalSantim,
  calculateOrder,
  isPriceWithinGuard,
  getPriceGuardBounds,
};

if (typeof globalThis !== 'undefined') {
  globalThis.P2PCalc = P2PCalc;
}

export default P2PCalc;
